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
  living, usable, spendable, enterCost, blastCells, meanBlastShock, landChance, dodgeValue, BLAST, los, defenceOf, meanFireShock, occupant, held, ROCK, coverValue, isCover, idle,
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
        .filter((c) => isCover(game, c) && foes.some((f) => see(c, f.cell)))
        .sort((a, b) => coverValue(game, b) - coverValue(game, a) || gd[a] - gd[b])
        .slice(0, 4).forEach((c) => ends.add(c));
      // The safest places to be next turn, and cover on the way to the goal.
      /** @type {Map<number, number>} */
      const threatAt = new Map();
      const friendEnds = new Set(friendPlans.map((f) => (f.path.length ? f.path[f.path.length - 1] : f.start)));
      for (const c of reachable) threatAt.set(c, threatNextTurn(game, t, c, foes, see, friendEnds));
      reachable.slice()
        .sort((a, b) => /** @type {number} */ (threatAt.get(a)) - /** @type {number} */ (threatAt.get(b)) || gd[a] - gd[b])
        .slice(0, 4).forEach((c) => ends.add(c));
      reachable.filter((c) => isCover(game, c))
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

      // The best bomb it could launch from here, if any is worth it.
      const bomb = p.launched ? planLaunch(game, t, budget, foes, friendPlans, allocated) : null;

      /** @type {{order: Order, score: number, target: number, dealt: number, end: number, bomb: boolean}[]} */
      const cands = [];
      for (const end of ends) {
        const path = field.path(end);
        // Two friends stepping into one cell, or swapping, both get blocked.
        if (friendPlans.some((f) => clash(t.cell, path, f.start, f.path))) continue;
        const left = budget - field.cost[end];
        const splits = splitsFor(left, targets.length > 0, p.maxShot);
        // A bomb, if there's one worth launching and it won't land on us.
        if (bomb && left >= bomb.points && !bomb.reach.has(end)) {
          splits.push({ fire: 0, dodge: left - bomb.points, overwatch: 0, launch: bomb.points });
        }
        // In the first of two stages, points not spent now are there to
        // dodge with in the second: offer versions that hold some back.
        if (p.stages === 2 && game.stage === 1) {
          for (const sp of splits.slice()) {
            if (sp.dodge > 0) splits.push({ ...sp, dodge: Math.floor(sp.dodge / 2), reserve: sp.dodge - Math.floor(sp.dodge / 2) });
            if (sp.dodge > 1) splits.push({ ...sp, dodge: 0, reserve: sp.dodge });
          }
        }
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
          const launching = (sp.launch ?? 0) > 0 && bomb !== null;
          const order = { path, target: bestTarget, fire: bestTarget >= 0 ? sp.fire : 0, dodge: sp.dodge, overwatch: sp.overwatch,
            launch: launching ? sp.launch : 0, launchAt: launching && bomb ? bomb.cell : -1 };
          let score = scoreOrder(game, t, order, end, goal, gd, foes, see, urgency, /** @type {number} */ (threatAt.get(end)), taker)
            + dealt + killBonus + (launching && bomb ? bomb.value : 0);
          // Points held back for the second stage are worth the fire they
          // could dodge there: each one takes Aim off every shot at it, up
          // to the danger it will actually be in.
          if (sp.reserve) {
            const watchers = foes.filter((f) => see(f.cell, end)).length;
            const saved = Math.min(/** @type {number} */ (threatAt.get(end)), (sp.reserve * t.aim * watchers) / p.damageDivisor);
            score += saved * 0.4 * (1 + (2 * t.shock) / t.pool);
          }
          cands.push({ order, score, target: bestTarget, dealt, end, bomb: launching });
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
      if (pick.bomb && bomb) for (const { fi, amount } of bomb.alloc) allocated[fi] += amount;
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
 * The most promising guided bomb a trooper could launch this stage: aimed
 * at an enemy's cell, with enough points to land if it can afford them.
 * It's worth the shock it should do to enemies, weighted by how likely
 * they are to still be there after moving (bombs go off after movement),
 * less anything it would do to friends.
 * @param {Game} game @param {Trooper} t @param {number} budget
 * @param {Trooper[]} foes @param {{start: number, path: number[]}[]} friendPlans
 * @param {number[]} allocated  shock friends already expect to deal each foe
 * @returns {{cell: number, points: number, value: number, reach: Set<number>, alloc: {fi: number, amount: number}[]}|null}
 */
function planLaunch(game, t, budget, foes, friendPlans, allocated) {
  const p = game.params;
  if (budget < p.minLaunch) return null;
  // Where friends will be: their planned end cells, or where they stand.
  const friendEnds = new Set(friendPlans.map((f) => (f.path.length ? f.path[f.path.length - 1] : f.start)));
  for (const m of living(game, t.side)) if (m.id !== t.id && !friendPlans.some((f) => f.start === m.cell)) friendEnds.add(m.cell);
  const hexes = new Set(game.victory.map((v) => v.cell));
  let best = null;
  for (const target of foes) {
    const reach = blastCells(game, target.cell);
    let value = 0, cm = 0;
    /** @type {{fi: number, amount: number}[]} */
    const alloc = [];
    for (const { cell, dist } of reach) {
      const shock = meanBlastShock(game, BLAST[dist], cell);
      if (friendEnds.has(cell)) value -= 1.5 * shock;
      const f = foes.find((x) => x.cell === cell);
      if (!f) continue;
      cm += dodgeValue(game, f, Math.floor(spendable(game, f) / 3));
      const fi = foes.indexOf(f);
      const remaining = Math.max(0, usable(f) - allocated[fi]);
      const stay = hexes.has(cell) ? 0.85 : 0.5;
      const useful = Math.min(shock, remaining);
      value += stay * (useful + (shock >= remaining && remaining > 0 ? 4 + f.pool / 3 : 0));
      alloc.push({ fi, amount: stay * useful });
    }
    if (value <= 0) continue;
    // Fewest points that should land it; otherwise everything it has.
    const rangeRating = Math.ceil(hexDist(game.grid, t.cell, target.cell) / 5);
    let points = budget;
    for (let k = p.minLaunch; k <= budget; k++) {
      if (t.aim * k - (rangeRating + cm) >= 0) { points = k; break; }
    }
    const sd = t.aim * points - (rangeRating + cm);
    const land = landChance(sd);
    const total = value * land;
    if (total > 0.5 && (!best || total > best.value)) {
      best = { cell: target.cell, points, value: total, reach: new Set(reach.map((r) => r.cell)), alloc: alloc.map((a) => ({ ...a, amount: a.amount * land })) };
    }
  }
  return best;
}

/**
 * Ways to split leftover points between fire, dodge and overwatch.
 * @param {number} left @param {boolean} canFire @param {number} maxShot
 */
function splitsFor(left, canFire, maxShot) {
  /** @type {{fire: number, dodge: number, overwatch: number, reserve?: number, launch?: number}[]} */
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
  const guess = { path: [], target: -1, fire: 0, dodge: Math.floor(spendable(game, f) / 3), overwatch: 0 };
  const s = meanFireShock(game.params, points * t.aim, defenceOf(game, f, t.cell, guess));
  return Math.max(0, s);
}

/**
 * A guess at the points a foe puts into one shot: half what it has, within
 * the shot cap.
 * @param {Game} game @param {Trooper} f
 */
function guessShot(game, f) {
  return Math.ceil(biggestShot(game, f) / 2);
}

/**
 * The most points a foe could put into one shot this stage: what it can
 * spend, within the shot cap if there is one.
 * @param {Game} game @param {Trooper} f
 */
function biggestShot(game, f) {
  const room = spendable(game, f);
  return game.params.maxShot > 0 ? Math.min(room, game.params.maxShot) : room;
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
 * @param {Set<number>} friendEnds  where friends planned so far will end up
 */
function threatNextTurn(game, t, cell, foes, see, friendEnds) {
  const p = game.params;
  const friends = living(game, t.side);
  let threat = 0;
  for (const f of foes) {
    if (!see(f.cell, cell)) continue;
    const defence = coverValue(game, cell)
      + Math.floor(hexDist(game.grid, f.cell, cell) / p.rangeStep)
      + (t.dugIn ? 1 : 0);
    // Next stage it could have up to a full stage's worth again.
    const next = p.stages === 2 ? Math.min(usable(f), p.stageCap) : usable(f);
    const all = p.maxShot > 0 ? Math.min(next, p.maxShot) : next;
    const s = meanFireShock(p, all * f.aim, defence);
    if (s > 0) threat += s / Math.max(1, friends.filter((m) => m.id === t.id || see(f.cell, m.cell)).length);
  }
  // Bombs need no line of sight. The more enemies that could launch one,
  // the likelier one lands here, and the harder it hits the less cover
  // there is. Ending up near friends is risky too: one bomb, several hits.
  if (p.launched) {
    const launchers = foes.filter((f) => usable(f) >= p.minLaunch).length;
    if (launchers > 0) {
      threat += meanBlastShock(game, BLAST[0], cell) * Math.min(1, 0.25 * launchers);
      for (const e of friendEnds) {
        const d = hexDist(game.grid, e, cell);
        if (d <= 2) threat += meanBlastShock(game, BLAST[d], cell) * 0.15;
      }
    }
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
    const s = meanFireShock(p, guessShot(game, f) * f.aim, defenceOf(game, t, f.cell, order));
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

