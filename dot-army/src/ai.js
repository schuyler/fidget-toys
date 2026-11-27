// @ts-check
// A simple CPU opponent. It only ever changes its own targets, through inputs,
// like a human, and it drags them there at a limited speed rather than
// teleporting them. With room for more than one target it plays two roles:
// attack (its first target, never removed) and defend (added at a threatened
// spawn, removed when the threat is gone). Deliberately uses its own RNG so it
// never disturbs the game's RNG stream.

import { hexDist, dirToward } from './hex.js';
import { createRng } from './rng.js';
import { applyInputTo } from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Input} Input */

/**
 * @param {number} player
 * @param {number} seed
 * @param {{ thinkEvery?: number, caution?: number, noise?: number, dragSpeed?: number, maxTargets?: number }} [opts]
 *   caution: extra reluctance (in cells of distance) to attack spawns the enemy owns
 *   dragSpeed: cells per tick the markers move toward where the CPU wants them, shared by all of them (Infinity = jump)
 *   maxTargets: use at most this many targets (the game's own cap still applies); for headless comparisons
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
  /** @type {('attack'|'defend')[]} */
  const ROLES = ['defend', 'attack']; // spending order for the drag budget
  /** @type {number[] | null} my targets as I have issued them; copied from the game once, never re-read */
  let model = null;
  /** @type {('attack'|'defend')[]} role of each model entry, kept in step with it */
  let roles = [];
  const aim = { attack: -1, defend: -1 }; // cell each role wants its target on
  let travel = 0;       // cells of drag owed, shared by all targets
  let lastTick = -1;

  /**
   * Call every frame; it acts at most once per game tick. Returns the inputs
   * to apply to its player, already validated against its own model.
   * @param {Game} game @returns {Input[]}
   */
  function think(game) {
    if (game.tick === lastTick) return [];
    lastTick = game.tick;
    if (!model) {
      model = [...game.targets[player]];
      roles = model.map((_, i) => (i === 0 ? 'attack' : 'defend'));
    }
    const m = model;
    const cap = Math.min(opts.maxTargets ?? Infinity, game.params.maxTargets);
    const N = game.grid.N;
    /** @type {Input[]} */
    const out = [];
    /** Apply to the model first; only an accepted input is returned. @param {Input} input */
    const issue = (input) => applyInputTo(m, input, cap, N) && (out.push(input), true);

    if (game.tick % thinkEvery === 0) decide(game, cap);

    // A removed defend target leaves no aim; a defend aim with no target gets one.
    if (aim.defend < 0 && roles.includes('defend')) {
      const k = roles.indexOf('defend');
      if (issue({ op: 'remove', index: k })) roles.splice(k, 1);
    }
    if (aim.defend >= 0 && !roles.includes('defend') && issue({ op: 'add', cell: aim.defend })) roles.push('defend');

    if (!Number.isFinite(dragSpeed)) {
      for (const role of ROLES) {
        const k = roles.indexOf(role);
        if (k >= 0 && aim[role] >= 0 && m[k] !== aim[role]) issue({ op: 'move', index: k, cell: aim[role] });
      }
      return out;
    }

    /** The next cell a role's target would step to, or -1 if it is at its aim, has none, or is blocked. */
    const stepFor = (/** @type {'attack'|'defend'} */ role) => {
      const k = roles.indexOf(role);
      if (k < 0 || aim[role] < 0 || m[k] === aim[role]) return -1;
      const next = game.grid.nbr[m[k] * 6 + dirToward(game.grid, m[k], aim[role])];
      return next < 0 || m.includes(next) ? -1 : next;
    };
    if (!ROLES.some((r) => stepFor(r) >= 0)) { travel = 0; return out; }
    travel += dragSpeed;
    while (travel >= 1) {
      const role = ROLES.find((r) => stepFor(r) >= 0);
      if (!role) { travel = 0; break; }
      if (issue({ op: 'move', index: roles.indexOf(role), cell: stepFor(role) })) travel -= 1;
      else { travel = 0; break; }
    }
    travel = Math.min(travel, Math.max(1, dragSpeed));
    return out;
  }

  /**
   * Update the aims. With room for a second target, defend gets its own aim
   * and attack carries on; with one target, a threat diverts the attack aim.
   * @param {Game} game @param {number} cap
   */
  function decide(game, cap) {
    const { grid } = game;
    const enemy = 1 - player;
    const mine = game.dots.filter((d) => d.player === player);
    if (!mine.length) return;

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
    let threat = -1;
    for (const s of game.spawns) {
      if (s.owner !== player) continue;
      let hit = -1, count = 0;
      for (const e of s.exits) {
        const o = game.occ[e];
        if (o && o.player === enemy) { count++; hit = e; }
      }
      if (count >= (s.home ? 2 : 4) && (cap > 1 || rng.next() < 0.8)) { threat = hit; break; }
    }
    if (cap > 1) aim.defend = threat;
    else if (threat >= 0) {
      goal = -1;
      aim.attack = threat; // charge into the attackers
      return;
    }

    const want = attackAim(game, mine, centre);
    if (want !== null) aim.attack = want;
  }

  /** @param {Game} game @param {import('./sim.js').Dot[]} mine @param {number} centre @returns {number|null} the cell attack now wants, or null for no change */
  function attackAim(game, mine, centre) {
    const { grid } = game;
    const enemy = 1 - player;

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
