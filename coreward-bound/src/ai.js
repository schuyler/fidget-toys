// @ts-check
// The CPU civ. It looks at the game the way a player would (hex
// potentials only where it has been, rival stacks only as a size band),
// and acts only through the same actions a player sends. It never changes
// the game itself. Its own RNG adds a little variety; the game's RNG is
// never touched here.

import { createRng } from './rng.js';
import {
  preview, stackAt, enemyAt, besieged, bandGuess, buildOptions, researchCost, safeRange, level, isNucleus,
  techType, VOID, EDGE, ARM, REACH, FOCUS, INDUSTRY, FORCE,
} from './sim.js';
import { hexDist, ring, within } from './hex.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Action} Action */
/** @typedef {import('./sim.js').Stack} Stack */

/**
 * @param {number} civ
 * @param {number} seed
 * @param {{ level?: 'easy' | 'hard' }} [opts]
 */
export function createAI(civ, seed, opts = {}) {
  const rng = createRng(seed);
  const hard = (opts.level ?? 'hard') === 'hard';
  let turn = -1;
  /** settlements a chaining stack has already passed through this turn */
  let chained = new Set();
  let actions = 0;

  /** @param {Game} game @returns {Action} */
  function next(game) {
    if (game.turn !== turn) { turn = game.turn; chained = new Set(); actions = 0; }
    if (game.winner >= 0 || game.current !== civ || ++actions > 80) return { kind: 'end' };
    return settle(game) ?? study(game) ?? move(game) ?? economy(game) ?? { kind: 'end' };
  }

  // ------------------------------------------------------------ looking around

  /** Rival fleets that could reach a hex next turn (as the CPU guesses them). @param {Game} game @param {number} cell */
  function threat(game, cell) {
    const reach = safeRange(game, 1 - civ) + 1;
    let t = 0;
    for (const s of game.stacks) if (s.owner !== civ && hexDist(game.grid, s.cell, cell) <= reach) t += bandGuess(s.fleets);
    return t;
  }

  /**
   * Rough odds of winning a fight to the finish, by playing it out a few
   * times with the CPU's own dice (never the game's).
   * @param {number} a @param {number} fa @param {number} d @param {number} fd
   */
  function winChance(a, fa, d, fd) {
    let wins = 0;
    const trials = 24;
    for (let t = 0; t < trials; t++) {
      let x = a, y = d;
      while (x > 0 && y > 0) {
        const hx = Math.max(1, Math.floor(((x + fa) * (1 + rng.int(6))) / 10));
        const hy = Math.max(1, Math.floor(((y + fd) * (1 + rng.int(6))) / 10));
        x -= hy; y -= hx;
      }
      if (x > 0) wins++;
    }
    return wins / trials;
  }

  /** Fleets to leave behind in a hex. @param {Game} game @param {number} cell */
  function keep(game, cell) {
    if (game.owner[cell] !== civ) return 0;
    const t = threat(game, cell);
    if (t === 0) return 0;
    const home = cell === game.civs[civ].home;
    return Math.min(8, t + (home ? 1 : 0));
  }

  /** What a hex is likely worth, from what this civ knows. @param {Game} game @param {number} cell */
  function worth(game, cell) {
    if (game.civs[civ].known[cell]) return game.potential[cell];
    const t = game.terrain[cell];
    return t === ARM ? 4 : t === EDGE ? 2 : t === VOID ? 0.5 : 0;
  }

  /** Is a hex worth a look? Arms are; the void mostly isn't. @param {Game} game @param {number} cell */
  function exploreValue(game, cell) {
    if (game.civs[civ].known[cell]) return 0;
    const t = game.terrain[cell];
    return t === ARM ? 3 : t === EDGE ? 1.5 : 0;
  }

  /** How close to the nucleus this civ's network reaches. @param {Game} game */
  function frontier(game) {
    let best = 99;
    for (let i = 0; i < game.grid.N; i++) if (game.owner[i] === civ) best = Math.min(best, ring(game.grid, i));
    return best;
  }

  /** Is there a settlement of ours within safe range of a hex (a way home from it)? @param {Game} game @param {number} cell */
  function wayHome(game, cell) {
    const r = safeRange(game, civ);
    for (const i of within(game.grid, cell, r)) if (game.owner[i] === civ && !besieged(game, i)) return true;
    return false;
  }

  /** Our own settlements near a hex. @param {Game} game @param {number} cell @param {number} r */
  function ownNear(game, cell, r) {
    let n = 0;
    for (const i of within(game.grid, cell, r)) if (game.owner[i] === civ) n++;
    return n;
  }

  /**
   * The value of landing n fleets (carrying some relics) in a hex.
   * @param {Game} game @param {number} cell @param {number} n @param {number} relics @param {number} depth
   */
  function landValue(game, cell, n, relics, depth) {
    const g = game.grid;
    const fa = level(game, civ, FORCE);
    let v = 0;
    const foe = enemyAt(game, civ, cell);
    const enemyTown = game.owner[cell] >= 0 && game.owner[cell] !== civ;
    if (relics > 0) {
      if (game.owner[cell] === civ && !foe) return 200 * relics + (game.civs[civ].relics + relics >= game.params.relicsToWin ? 1000 : 0);
      v -= 5; // anywhere else is just a waypoint
    }
    if (foe) {
      const est = bandGuess(foe.fleets);
      const fd = level(game, foe.owner, FORCE) + (game.owner[cell] === foe.owner ? 1 : 0);
      const p = winChance(n, fa, est, fd);
      const stakes = foe.relics || game.relicAt[cell] ? 120 + 60 * game.civs[foe.owner].relics : 0;
      const gain = 6 * est + stakes + (game.owner[cell] === foe.owner ? 20 : 0);
      const ev = p * gain - (1 - p) * 8 * n;
      if (ev <= 0 || p < (hard ? 0.35 : 0.5)) return -40;
      v += ev;
      if (p < 0.9) return v; // a fight first; the rest is a bonus we may not get
    }
    if (game.relicAt[cell] && game.owner[cell] !== civ) {
      // a relic: only worth grabbing with a way home from the nucleus
      // and it has to be held through the rival's turn before it can be picked up
      if (!isNucleus(game, cell) || wayHome(game, cell)) v += Math.max(10, (hard ? 90 : 45) + 40 * game.civs[civ].relics - 8 * threat(game, cell) + 6 * n);
    }
    if (enemyTown) {
      const need = game.value[cell] + 4 - n - fa;
      const p = Math.min(6, Math.max(0, 7 - need)) / 6;
      const last = game.owner.filter((o) => o === game.owner[cell]).length === 1;
      v += (20 + 8 * game.value[cell]) * (0.4 + 0.6 * p) + (last ? 200 : 0);
      if (cell === game.civs[1 - civ].home) v += 15;
    } else if (game.owner[cell] === civ) {
      // reinforce a threatened settlement
      const t = threat(game, cell);
      const here = stackAt(game, civ, cell)?.fleets ?? 0;
      if (t > here) v += Math.min(n, t - here + 1) * 6 + (cell === game.civs[civ].home ? 10 : 0);
      // or pass through it, chaining onward
      if (depth > 0 && !chained.has(cell)) v = Math.max(v, 0.85 * bestFrom(game, cell, n, relics, depth - 1));
    } else if (!isNucleus(game, cell)) {
      // somewhere to settle (or a stepping stone towards the core)
      const known = game.civs[civ].known[cell];
      const w = worth(game, cell);
      const crowd = ownNear(game, cell, 1);
      const nearer = Math.max(0, frontier(game) - ring(g, cell));
      if (n >= game.params.foundCost) v += (3 * w + 4 * nearer) * (crowd ? 0.4 : 1);
      if (!known) v += exploreValue(game, cell);
      if (ownNear(game, cell, safeRange(game, civ)) === 0) v -= 4; // out on a limb
    }
    return v;
  }

  /**
   * The best single jump's value from a hex (for chaining).
   * @param {Game} game @param {number} from @param {number} n @param {number} relics @param {number} depth
   */
  function bestFrom(game, from, n, relics, depth) {
    let best = 0;
    for (const to of within(game.grid, from, safeRange(game, civ))) {
      if (to === from || game.owner[to] === civ && depth <= 0) continue;
      best = Math.max(best, landValue(game, to, n, relics, depth));
    }
    return best;
  }

  /**
   * Score a jump using its preview.
   * @param {Game} game @param {import('./sim.js').Preview} pv @param {number} relics
   */
  function scoreJump(game, pv, relics) {
    const hit = pv.hits / 6;
    const lose = pv.loseChance / 36;
    const v = landValue(game, pv.to, pv.n, relics, 1);
    let lossCost = 0;
    if (pv.outcomes.length) {
      let fleetsLost = 0;
      for (const o of pv.outcomes) fleetsLost += o.lost ? pv.n : o.losses;
      lossCost = (fleetsLost / pv.outcomes.length) * (1 - hit) * 4;
    }
    return hit * v + (1 - hit) * Math.min(v, 0) * 0.5 - lose * (8 * pv.n + 150 * relics) - lossCost - (hard ? 0 : rng.int(20));
  }

  // ------------------------------------------------------------ moving

  /** @param {Game} game @returns {Action | null} */
  function move(game) {
    const g = game.grid;
    if (!hard && rng.int(5) === 0) return null; // Easy loses interest and leaves the rest of its fleets for next turn
    /** @type {{a: Action, s: number} | null} */ let best = null;
    for (const st of game.stacks) {
      if (st.owner !== civ || st.ready <= 0) continue;
      const k = st.relics ? 0 : keep(game, st.cell);
      const avail = Math.min(st.ready, st.fleets - k);
      if (avail <= 0) continue;
      const fromOwn = game.owner[st.cell] === civ;
      const reach = safeRange(game, civ) + (fromOwn && hard ? 2 : 0);
      // send everyone available, or a pair to settle, or a single scout
      const sizes = [...new Set([avail, Math.min(avail, game.params.foundCost), 1])];
      for (const to of within(g, st.cell, reach)) {
        if (to === st.cell) continue;
        if (game.owner[to] === civ && chained.has(to)) continue;
        for (const n of sizes) {
          const pv = preview(game, st.cell, to, n);
          if ('error' in pv) continue;
          let s = scoreJump(game, pv, st.relics);
          if (n < avail) s -= 1; // prefer moving together
          if (!best || s > best.s) best = { a: { kind: 'jump', from: st.cell, to, n }, s };
        }
      }
    }
    if (!best || best.s <= stayValue(game, best.a) + 2) return null;
    const a = /** @type {Action & {kind: 'jump'}} */ (best.a);
    if (game.owner[a.to] === civ) { chained.add(a.to); chained.add(a.from); }
    return a;
  }

  /** What the stack would be doing if it didn't jump. @param {Game} game @param {Action} a */
  function stayValue(game, a) {
    if (a.kind !== 'jump') return 0;
    const here = a.from;
    let v = 2;
    if (game.owner[here] >= 0 && game.owner[here] !== civ) v += 25; // keep up the siege
    if (game.relicAt[here]) v += 150; // dig in for the relic
    const opts = buildOptions(game, here);
    if (!opts.found && game.civs[civ].known[here] && game.potential[here] >= 2) v += 3 * game.potential[here];
    return v;
  }

  // ------------------------------------------------------------ building

  /** Found settlements where stacks stand on decent hexes, or on stepping stones coreward. @param {Game} game @returns {Action | null} */
  function settle(game) {
    const g = game.grid;
    const mine = game.stacks.filter((s) => s.owner === civ);
    const front = frontier(game);
    for (const s of mine) {
      if (game.owner[s.cell] >= 0 || s.idle < game.params.foundCost) continue;
      const opts = buildOptions(game, s.cell);
      if (opts.found) continue;
      const pot = game.potential[s.cell];
      const stepping = ring(g, s.cell) < front && ownNear(game, s.cell, 1) === 0;
      if (pot >= 2 || stepping || s.relics) return { kind: 'found', cell: s.cell };
    }
    return null;
  }

  /** Research when there are fleets to spare at a settlement. @param {Game} game @returns {Action | null} */
  function study(game) {
    const civObj = game.civs[civ];
    const mine = game.stacks.filter((s) => s.owner === civ);
    const wantTechs = Math.floor(game.turn / (hard ? 8 : 14)) + 1;
    if (civObj.techs.length < wantTechs) {
      for (const s of mine) {
        if (game.owner[s.cell] !== civ) continue;
        const opts = buildOptions(game, s.cell);
        const spare = Math.min(s.idle, s.fleets - keep(game, s.cell));
        let pick = -1, bestRank = -1;
        civObj.offer.forEach((t, i) => {
          if (opts.research[i] || researchCost(game, civ, t) > spare) return;
          const rank = techRank(game, t);
          if (rank > bestRank) { bestRank = rank; pick = i; }
        });
        if (pick >= 0) return { kind: 'research', cell: s.cell, pick };
      }
    }
    return null;
  }

  /** @param {Game} game @returns {Action | null} */
  function economy(game) {
    const g = game.grid;
    const mine = game.stacks.filter((s) => s.owner === civ);
    const army = mine.reduce((t, s) => t + s.fleets, 0);

    // build fleets, threatened settlements and the front line first
    /** @type {number[]} */ const towns = [];
    for (let i = 0; i < g.N; i++) if (game.owner[i] === civ && !buildOptions(game, i).build) towns.push(i);
    if (towns.length) {
      towns.sort((a, b) => threat(game, b) - threat(game, a) || ring(g, a) - ring(g, b));
      return { kind: 'build', cell: towns[0] };
    }
    // grow settlements with fleets that are standing there, keeping some army
    const minArmy = 2 + Math.floor(game.turn / 6);
    if (army > minArmy) {
      let bestCell = -1, bestPot = -1;
      for (const s of mine) {
        if (game.owner[s.cell] !== civ || buildOptions(game, s.cell).grow) continue;
        if (s.fleets - 1 < keep(game, s.cell)) continue;
        const room = game.potential[s.cell] - game.value[s.cell];
        if (room > bestPot) { bestPot = room; bestCell = s.cell; }
      }
      if (bestCell >= 0) return { kind: 'grow', cell: bestCell };
    }
    return null;
  }

  /** How much the CPU wants a tech. @param {Game} game @param {number} t */
  function techRank(game, t) {
    const type = techType(t);
    const have = level(game, civ, type);
    const base = type === REACH ? 6 : type === FOCUS ? 5 : type === INDUSTRY ? 4 : 4;
    const rivalForce = level(game, 1 - civ, FORCE);
    return base - have + (type === FORCE ? rivalForce : 0) + rng.int(2);
  }

  return { next, civ };
}
