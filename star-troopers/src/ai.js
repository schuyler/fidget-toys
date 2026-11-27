// @ts-check
// The CPU player. Plays under the same rules as a person: it sees the board
// (including enemy shock) but never the other side's orders.
//
// Each turn it gives every trooper a goal (a victory hex to take, or one to
// guard), lists candidate orders (where to end up, and how to split the
// remaining points between shooting, dodging and overwatch), scores each
// one against a guess at what the enemy will do, and then picks at random
// among the best few. Picking at random keeps it from being baited: a CPU
// that always makes the single best reply to its prediction is easy to
// read. It uses its own seeded RNG, so games stay reproducible.

import { createRng } from './rng.js';
import { hexDist, reflect } from './hex.js';
import {
  living, usable, spendable, enterCost, los, defenceOf, baseShock, occupant, held, ROCK, COVER, idle,
} from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Trooper} Trooper */
/** @typedef {import('./sim.js').Order} Order */

/** How far from its hex a supporting trooper wants to be, at most. */
const SUPPORT_RANGE = 4;

/**
 * @param {number} side
 * @param {number} seed
 * @param {{level?: 'easy'|'hard', onDecide?: (info: {trooper: Trooper, goal: number, chosen: any, cands: any[], threatAt: Map<number, number>}) => void}} [opts]
 *   onDecide is a debugging hook: it sees every candidate and the pick.
 */
export function createAI(side, seed, opts = {}) {
  const rng = createRng(seed);
  const level = opts.level ?? 'hard';
  /** Assault attacker: the two victory hexes it means to take, chosen once. */
  let focus = /** @type {number[]|null} */ (null);

  /**
   * Orders for this side's living troopers, indexed by trooper id.
   * @param {Game} game
   * @returns {(Order|null)[]}
   */
  function plan(game) {
    const p = game.params;
    const g = game.grid;
    const mine = living(game, side);
    const foes = living(game, 1 - side);
    /** @type {(Order|null)[]} */
    const orders = game.troopers.map(() => null);
    if (!mine.length || !foes.length) return orders;

    // Line-of-sight cache for this turn.
    /** @type {Map<number, boolean>} */
    const losCache = new Map();
    /** @param {number} a @param {number} b */
    const see = (a, b) => {
      const k = a < b ? a * g.N + b : b * g.N + a;
      let v = losCache.get(k);
      if (v === undefined) { v = los(game, a, b); losCache.set(k, v); }
      return v;
    };

    const { goals, takers } = assignGoals(game, mine);
    /** @type {Map<number, Int32Array>} */
    const goalDist = new Map();
    for (const cell of new Set(goals.values())) goalDist.set(cell, costField(game, cell));

    const reserved = new Set();               // end cells already claimed by friends
    /** @type {{start: number, path: number[]}[]} */
    const friendPlans = [];                   // moves already planned this turn
    const allocated = foes.map(() => 0);      // shock we expect friends to deal each foe
    const urgency = 1 + (2 * game.turn) / p.turnLimit;

    for (const t of mine) {
      const budget = spendable(game, t);
      const field = reach(game, t, budget);
      const goal = /** @type {number} */ (goals.get(t.id));
      const gd = /** @type {Int32Array} */ (goalDist.get(goal));

      // Candidate end cells: where it stands, the goal and the cells round
      // it, the cells that make the most progress, and the best cover in
      // reach with a view of the enemy.
      /** @type {number[]} */
      const reachable = [];
      // Walk cells in an order that's the same for both sides once the map
      // is mirrored, so ties never favour one side.
      for (let k = 0; k < g.N; k++) {
        const c = side === 0 ? k : reflect(g, k);
        if (field.cost[c] <= budget && (c === t.cell || !reserved.has(c))) reachable.push(c);
      }
      const ends = new Set([t.cell]);
      reachable.slice().sort((a, b) => gd[a] - gd[b] || field.cost[a] - field.cost[b]).slice(0, 5).forEach((c) => ends.add(c));
      reachable.filter((c) => hexDist(g, c, goal) <= 1).forEach((c) => ends.add(c));
      reachable
        .filter((c) => COVER[game.terrain[c]] > 0 && foes.some((f) => see(c, f.cell)))
        .sort((a, b) => COVER[game.terrain[b]] - COVER[game.terrain[a]] || gd[a] - gd[b])
        .slice(0, 4).forEach((c) => ends.add(c));
      // The safest places to be next turn, and cover on the way to the goal.
      /** @type {Map<number, number>} */
      const threatAt = new Map();
      for (const c of reachable) threatAt.set(c, threatNextTurn(game, t, c, foes, see));
      reachable.slice()
        .sort((a, b) => /** @type {number} */ (threatAt.get(a)) - /** @type {number} */ (threatAt.get(b)) || gd[a] - gd[b])
        .slice(0, 4).forEach((c) => ends.add(c));
      reachable.filter((c) => COVER[game.terrain[c]] > 0)
        .sort((a, b) => gd[a] - gd[b]).slice(0, 3).forEach((c) => ends.add(c));
      // Support positions: near the goal, with a view of it, as safe as possible.
      const taker = takers.has(t.id);
      if (!taker) {
        reachable.filter((c) => hexDist(g, c, goal) <= SUPPORT_RANGE && see(c, goal))
          .sort((a, b) => /** @type {number} */ (threatAt.get(a)) - /** @type {number} */ (threatAt.get(b)) || gd[a] - gd[b])
          .slice(0, 4).forEach((c) => ends.add(c));
      }

      // Who can it shoot from where it stands? (Fire happens before moving.)
      const targets = foes.filter((f) => see(t.cell, f.cell));

      /** @type {{order: Order, score: number, target: number, dealt: number, end: number}[]} */
      const cands = [];
      for (const end of ends) {
        const path = field.path(end);
        // Two friends stepping into one cell, or swapping, both get blocked.
        if (friendPlans.some((f) => clash(t.cell, path, f.start, f.path))) continue;
        const left = budget - field.cost[end];
        const splits = splitsFor(left, targets.length > 0, p.maxShot);
        for (const sp of splits) {
          let bestTarget = -1, dealt = 0, killBonus = 0;
          if (sp.fire > 0) {
            for (const f of targets) {
              const d = expectedShock(game, t, f, sp.fire);
              const fi = foes.indexOf(f);
              const remaining = usable(f) - allocated[fi];
              const useful = Math.min(d, Math.max(0, remaining));
              const kb = d >= remaining && remaining > 0 ? 4 + f.pool / 3 : 0;
              if (useful + kb > dealt + killBonus) { bestTarget = f.id; dealt = useful; killBonus = kb; }
            }
            if (bestTarget < 0) continue;
          }
          const order = { path, target: bestTarget, fire: bestTarget >= 0 ? sp.fire : 0, dodge: sp.dodge, overwatch: sp.overwatch };
          const score = scoreOrder(game, t, order, end, goal, gd, foes, see, urgency, /** @type {number} */ (threatAt.get(end)), taker)
            + dealt + killBonus;
          cands.push({ order, score, target: bestTarget, dealt, end });
        }
      }

      cands.sort((a, b) => b.score - a.score);
      const pick = choose(cands, level, rng);
      opts.onDecide?.({ trooper: t, goal, chosen: pick, cands, threatAt });
      if (!pick) { orders[t.id] = idle(); continue; }
      orders[t.id] = pick.order;
      friendPlans.push({ start: t.cell, path: pick.order.path });
      const endCell = pick.order.path.length ? pick.order.path[pick.order.path.length - 1] : t.cell;
      reserved.add(endCell);
      if (pick.target >= 0) {
        const fi = foes.findIndex((f) => f.id === pick.target);
        allocated[fi] += pick.dealt;
      }
    }
    return orders;
  }

  /**
   * Gives each trooper a victory hex to head for or guard.
   * @param {Game} game @param {Trooper[]} mine
   * @returns {{goals: Map<number, number>, takers: Set<number>}} goal cell per
   *   trooper id, and which troopers go for the hex itself
   */
  function assignGoals(game, mine) {
    const p = game.params;
    const g = game.grid;
    let hexes = game.victory.map((v) => v.cell);
    if (p.scenario === 'assault' && p.attacker === side) {
      if (!focus) {
        const skip = rng.int(hexes.length);
        focus = hexes.filter((_, i) => i !== skip);
      }
      // Once a focus hex is ours, keep it covered but push for the rest.
      const ours = game.victory.filter((v) => v.owner === side).map((v) => v.cell);
      if (held(game, side) >= 1) {
        const others = hexes.filter((h) => !ours.includes(h));
        hexes = [...ours, ...others];
      } else {
        hexes = focus;
      }
    }
    // Greedy: spread troopers across hexes, nearest first, with a cap per hex.
    const cap = Math.ceil(mine.length / hexes.length);
    const load = new Map(hexes.map((h) => [h, 0]));
    /** @type {Map<number, number>} */
    const goals = new Map();
    const pairs = [];
    for (const t of mine) for (const h of hexes) pairs.push({ t, h, d: hexDist(g, t.cell, h) });
    pairs.sort((a, b) => a.d - b.d || a.t.id - b.t.id || a.h - b.h);
    for (const { t, h } of pairs) {
      if (goals.has(t.id) || /** @type {number} */ (load.get(h)) >= cap) continue;
      goals.set(t.id, h);
      load.set(h, /** @type {number} */ (load.get(h)) + 1);
    }
    for (const t of mine) if (!goals.has(t.id)) goals.set(t.id, hexes[0]);
    // The nearest trooper to each hex takes it; the rest support it.
    const takers = new Set();
    const taken = new Set();
    for (const { t, h } of pairs) {
      if (goals.get(t.id) !== h || taken.has(h)) continue;
      takers.add(t.id);
      taken.add(h);
    }
    return { goals, takers };
  }

  return { side, plan };
}

/**
 * Where a trooper is after step k of its path (k = -1 is the start).
 * @param {number} start @param {number[]} path @param {number} k
 */
function posAt(start, path, k) {
  if (k < 0 || !path.length) return start;
  return path[Math.min(k, path.length - 1)];
}

/**
 * Would these two friends' moves block each other: the same cell after the
 * same step (including one walking into where the other has stopped), or a
 * swap?
 * @param {number} aStart @param {number[]} aPath @param {number} bStart @param {number[]} bPath
 */
function clash(aStart, aPath, bStart, bPath) {
  const steps = Math.max(aPath.length, bPath.length);
  for (let k = 0; k < steps; k++) {
    const a = posAt(aStart, aPath, k), b = posAt(bStart, bPath, k);
    if (a === b) return true;
    const a0 = posAt(aStart, aPath, k - 1), b0 = posAt(bStart, bPath, k - 1);
    if (a === b0 && b === a0 && a !== a0) return true;
  }
  return false;
}

/**
 * Ways to split leftover points between fire, dodge and overwatch.
 * @param {number} left @param {boolean} canFire @param {number} maxShot
 */
function splitsFor(left, canFire, maxShot) {
  /** @type {{fire: number, dodge: number, overwatch: number}[]} */
  const out = [{ fire: 0, dodge: left, overwatch: 0 }];
  if (left <= 0) return out;
  const cap = maxShot > 0 ? maxShot : left;
  if (canFire) {
    for (const f of new Set([Math.ceil(left / 3), Math.ceil(left / 2), Math.ceil((2 * left) / 3), left])) {
      const fire = Math.min(f, cap);
      if (fire > 0) out.push({ fire, dodge: left - fire, overwatch: 0 });
    }
  }
  const ow = Math.ceil(left / 2);
  out.push({ fire: 0, dodge: left - ow, overwatch: ow });
  return out;
}

/**
 * Expected shock from a shot, guessing the target dodges with about a third
 * of its points and stays put.
 * @param {Game} game @param {Trooper} t @param {Trooper} f @param {number} points
 */
function expectedShock(game, t, f, points) {
  const guess = { path: [], target: -1, fire: 0, dodge: Math.floor(usable(f) / 3), overwatch: 0 };
  const s = baseShock(game.params, points * t.aim, defenceOf(game, f, t.cell, guess));
  return Math.max(0, s);
}

/**
 * A guess at the points a foe puts into one shot: half what it has, within
 * the shot cap.
 * @param {Game} game @param {Trooper} f
 */
function guessShot(game, f) {
  const half = Math.ceil(usable(f) / 2);
  return game.params.maxShot > 0 ? Math.min(half, game.params.maxShot) : half;
}

/**
 * How badly a trooper could be hurt next turn if it ends this turn at
 * `cell`: every foe that can see the cell takes the biggest shot it's
 * allowed, split among the troopers it can see, against cover and range
 * only. It's deliberately pessimistic (no dodge): a gentler guess makes
 * most cells look perfectly safe, and then cover and distance stop
 * mattering. Cover, distance and staying out of sight all fall out of
 * this one number.
 * @param {Game} game @param {Trooper} t @param {number} cell @param {Trooper[]} foes
 * @param {(a: number, b: number) => boolean} see
 */
function threatNextTurn(game, t, cell, foes, see) {
  const p = game.params;
  const friends = living(game, t.side);
  let threat = 0;
  for (const f of foes) {
    if (!see(f.cell, cell)) continue;
    const defence = COVER[game.terrain[cell]] * p.coverScale
      + Math.floor(hexDist(game.grid, f.cell, cell) / p.rangeStep)
      + (t.dugIn ? 1 : 0);
    const all = p.maxShot > 0 ? Math.min(usable(f), p.maxShot) : usable(f);
    const s = baseShock(p, all * f.aim, defence);
    if (s > 0) threat += s / Math.max(1, friends.filter((m) => m.id === t.id || see(f.cell, m.cell)).length);
  }
  return threat;
}

/**
 * Everything about an order except the damage it deals.
 * @param {Game} game @param {Trooper} t @param {Order} order @param {number} end
 * @param {number} goal @param {Int32Array} gd @param {Trooper[]} foes
 * @param {(a: number, b: number) => boolean} see @param {number} urgency
 * @param {number} threat  expected shock next turn at the end cell
 * @param {boolean} taker  going for the hex itself, rather than supporting
 */
function scoreOrder(game, t, order, end, goal, gd, foes, see, urgency, threat, taker) {
  const p = game.params;
  const g = game.grid;
  let score = 0;
  // How much it matters to stay alive: more the more hurt it already is.
  const hurt = t.shock / t.pool;
  const care = 1 + 2 * hurt;

  // Fire coming in this turn, at where it starts (fire happens before
  // anyone moves), softened by dodging and by how far it plans to move.
  let incoming = 0;
  for (const f of foes) {
    if (!see(f.cell, t.cell)) continue;
    const s = baseShock(p, guessShot(game, f) * f.aim, defenceOf(game, t, f.cell, order));
    if (s > 0) incoming += s / Math.max(1, living(game, t.side).filter((m) => see(f.cell, m.cell)).length);
  }
  score -= incoming * 1.1 * care;
  if (t.shock + incoming >= t.pool) score -= 6;

  // Overwatch risk along the way, and the fire it will draw next turn
  // where it ends up.
  for (const c of order.path) {
    for (const f of foes) if (hexDist(g, c, f.cell) <= p.overwatchRange && see(c, f.cell)) score -= 0.15;
  }
  score -= threat * 0.4 * care;
  if (t.shock + threat >= t.pool) score -= 4;

  // Progress towards the goal hex. A badly hurt trooper cares less about
  // the objective and more about living to recover.
  const drive = urgency * (1 - 0.6 * hurt);
  const dg = hexDist(g, end, goal);
  if (taker) {
    score += (gd[t.cell] - gd[end]) * 0.9 * drive;
    if (dg === 0) score += 3 * drive;
    else if (dg === 1) score += 1.2 * drive;
  } else {
    // Supporters close in until they can cover the hex, then hold back:
    // one trooper on a hex takes it, and the rest do better shooting at
    // anyone who comes for it from somewhere safe.
    if (hexDist(g, t.cell, goal) > SUPPORT_RANGE) score += (gd[t.cell] - gd[end]) * 0.5 * drive;
    score -= Math.max(0, dg - SUPPORT_RANGE) * 0.6 * drive;
    if (dg <= SUPPORT_RANGE && see(end, goal)) score += 1.2 * drive;
  }
  // Standing next to our own hex stops the enemy taking it.
  for (const v of game.victory) {
    if (hexDist(g, end, v.cell) <= 1 && v.owner === t.side) score += 0.8;
  }

  // Overwatch is worth something if enemies could walk into view.
  if (order.overwatch > 0) {
    const near = foes.filter((f) => hexDist(g, end, f.cell) <= p.overwatchRange + 3).length;
    score += near > 0 ? Math.max(0, (order.overwatch * t.aim - 3) / p.damageDivisor) * 0.5 : -1;
  }

  // A little credit for dodge points, so leftovers aren't thrown away.
  score += order.dodge * 0.05;
  return score;
}

/**
 * Picks among the best candidates at random. Hard keeps to the top three,
 * weighted 3:2:1; easy picks from the top six evenly.
 * @template T
 * @param {T[]} cands sorted best first
 * @param {'easy'|'hard'} level
 * @param {import('./rng.js').Rng} rng
 * @returns {T|undefined}
 */
function choose(cands, level, rng) {
  if (!cands.length) return undefined;
  if (level === 'easy') return cands[rng.int(Math.min(6, cands.length))];
  const top = cands.slice(0, 3);
  const weights = [3, 2, 1].slice(0, top.length);
  let roll = rng.int(weights.reduce((a, b) => a + b, 0));
  for (let i = 0; i < top.length; i++) {
    roll -= weights[i];
    if (roll < 0) return top[i];
  }
  return top[0];
}

/**
 * Cheapest paths from a trooper, within its budget, not entering cells that
 * other troopers stand in at the start of the turn.
 * @param {Game} game @param {Trooper} t @param {number} budget
 */
function reach(game, t, budget) {
  const g = game.grid;
  const cost = new Int32Array(g.N).fill(0x3fffffff);
  const prev = new Int32Array(g.N).fill(-1);
  cost[t.cell] = 0;
  // Costs are 1 or 2, so a small bucket queue is plenty.
  const buckets = Array.from({ length: budget + 3 }, () => /** @type {number[]} */ ([]));
  buckets[0].push(t.cell);
  for (let b = 0; b <= budget; b++) {
    for (let i = 0; i < buckets[b].length; i++) {
      const c = buckets[b][i];
      if (cost[c] !== b) continue;
      for (let k = 0; k < 6; k++) {
        // Mirrored direction order for the top side (NE<->SE, NW<->SW), so
        // equal-cost paths come out as mirror images of each other.
        const d = t.side === 0 ? k : (6 - k) % 6;
        const n = g.nbr[c * 6 + d];
        if (n < 0 || game.terrain[n] === ROCK) continue;
        const o = occupant(game, n);
        if (o && o.id !== t.id) continue;
        const nc = b + enterCost(game, c, n);
        if (nc <= budget && nc < cost[n]) { cost[n] = nc; prev[n] = c; buckets[nc].push(n); }
      }
    }
  }
  return {
    cost,
    /** @param {number} end */
    path(end) {
      const out = [];
      for (let c = end; c !== t.cell; c = prev[c]) out.push(c);
      return out.reverse();
    },
  };
}

/**
 * Movement cost from every cell to `goal`, ignoring troopers.
 * @param {Game} game @param {number} goal
 */
function costField(game, goal) {
  const g = game.grid;
  const dist = new Int32Array(g.N).fill(0x3fffff);
  dist[goal] = 0;
  const buckets = [[goal]];
  for (let b = 0; b < buckets.length; b++) {
    for (const c of buckets[b] ?? []) {
      if (dist[c] !== b) continue;
      for (let d = 0; d < 6; d++) {
        const n = g.nbr[c * 6 + d];
        if (n < 0 || game.terrain[n] === ROCK) continue;
        // cost of stepping from n into c, since troopers walk towards the goal
        const nc = b + enterCost(game, n, c);
        if (nc < dist[n]) {
          dist[n] = nc;
          (buckets[nc] ??= []).push(n);
        }
      }
    }
  }
  return dist;
}

