// @ts-check
// A simple CPU opponent. It only ever moves its target, like a human, and it
// drags the target there at a limited speed rather than teleporting it.
// Deliberately uses its own RNG so it never disturbs the game's RNG stream.

import { hexDist, dirToward } from './hex.js';
import { createRng } from './rng.js';

/** @typedef {import('./sim.js').Game} Game */

/**
 * @param {number} player
 * @param {number} seed
 * @param {{ thinkEvery?: number, caution?: number, noise?: number, dragSpeed?: number }} [opts]
 *   caution: extra reluctance (in cells of distance) to attack spawns the enemy owns
 *   dragSpeed: cells per tick the marker moves toward where the CPU wants it (Infinity = jump)
 */
export function createAI(player, seed, opts = {}) {
  const rng = createRng(seed ^ 0x9e3779b9);
  const thinkEvery = opts.thinkEvery ?? 6;
  const caution = opts.caution ?? 0;
  const noise = opts.noise ?? 6;
  let goal = -1;        // spawn id we're going after
  let goalSince = 0;
  let lastMeter = 0;
  const dragSpeed = opts.dragSpeed ?? Infinity;
  let aim = -1;         // cell the CPU wants its marker on
  let travel = 0;       // fractional cells of drag owed

  /**
   * Call once per tick. Decides where it wants its marker, then drags the
   * marker toward that cell at dragSpeed.
   * @param {Game} game @returns {number|null} new target cell, or null for no change
   */
  function think(game) {
    const want = decide(game);
    if (want !== null) aim = want;
    const at = game.targets[player];
    if (aim < 0 || aim === at) { travel = 0; return null; }
    if (!Number.isFinite(dragSpeed)) return aim;
    travel += dragSpeed;
    let cell = at;
    while (travel >= 1 && cell !== aim) {
      const next = game.grid.nbr[cell * 6 + dirToward(game.grid, cell, aim)];
      if (next < 0) break;
      cell = next;
      travel -= 1;
    }
    if (cell === aim) travel = 0;
    return cell === at ? null : cell;
  }

  /** @param {Game} game @returns {number|null} the cell it now wants, or null for no change */
  function decide(game) {
    if (game.tick % thinkEvery !== 0) return null;
    const { grid } = game;
    const enemy = 1 - player;
    const mine = game.dots.filter((d) => d.player === player);
    if (!mine.length) return null;

    // Army centre: the dot nearest the average position.
    let sq = 0, sr = 0;
    for (const d of mine) { sq += grid.q[d.cell]; sr += grid.r[d.cell]; }
    sq /= mine.length; sr /= mine.length;
    let centre = mine[0].cell, bestC = Infinity;
    for (const d of mine) {
      const e = Math.abs(grid.q[d.cell] - sq) + Math.abs(grid.r[d.cell] - sr);
      if (e < bestC) { bestC = e; centre = d.cell; }
    }

    // Defend: an owned spawn with enemy dots pressed against it.
    for (const s of game.spawns) {
      if (s.owner !== player) continue;
      let threat = -1, count = 0;
      for (const e of s.exits) {
        const o = game.occ[e];
        if (o && o.player === enemy) { count++; threat = e; }
      }
      if (count >= (s.home ? 2 : 4) && rng.next() < 0.8) {
        goal = -1;
        return threat; // charge into the attackers
      }
    }

    // The enemy has no spawns left: hunt down their last dots.
    if (!game.spawns.some((s) => s.owner === enemy)) {
      goal = -1;
      let prey = -1, bestD = Infinity;
      for (const d of game.dots) {
        if (d.player !== enemy) continue;
        const dd = hexDist(grid, centre, d.cell);
        if (dd < bestD) { bestD = dd; prey = d.cell; }
      }
      if (prey >= 0) return prey;
    }

    // Keep pressing the current goal while it's making progress.
    if (goal >= 0) {
      const s = game.spawns[goal];
      const stale = game.tick - goalSince > 160 && s.meter >= lastMeter;
      if (s.owner !== player && !stale) {
        if (game.tick - goalSince > 80) { lastMeter = s.meter; }
        return s.center;
      }
      goal = -1;
    }

    // Pick a new goal: near, weak, and preferably not defended.
    const myCount = mine.length;
    const theirCount = game.dotCount[enemy];
    let best = -1, bestScore = Infinity;
    for (const s of game.spawns) {
      if (s.owner === player) continue;
      let defenders = 0;
      for (const d of game.dots) if (d.player === enemy && hexDist(grid, d.cell, s.center) < 6) defenders++;
      let score = hexDist(grid, centre, s.center) + s.meter * 0.8 + defenders * 0.6;
      if (s.owner === enemy) score += (myCount > theirCount * 1.2 ? -4 : 8) + caution;
      score += rng.next() * noise;
      if (score < bestScore) { bestScore = score; best = s.id; }
    }
    if (best < 0) return null;
    goal = best;
    goalSince = game.tick;
    lastMeter = game.spawns[best].meter;
    return game.spawns[best].center;
  }

  return { player, think };
}
