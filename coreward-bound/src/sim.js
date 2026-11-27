// @ts-check
// Coreward Bound simulation core. Deterministic: integer state plus a
// seeded RNG, with no dependence on wall-clock time or Math.random. See
// RULES.md for the rules this implements.
//
// Every action is a function taking the game and returning a list of
// events (or a refusal); the renderer animates the events, the CPU and the
// player call the same functions.

import { createRng } from './rng.js';
import { createGrid, axialToIndex, DIRS, rotate, hexDist, ring, dirTo, stepFrom, within, lineTraces } from './hex.js';

/** @typedef {import('./hex.js').Grid} Grid */
/** @typedef {import('./rng.js').Rng} Rng */

export const DRAW = 2;

/** Terrain. */
export const VOID = 0, PERIPHERY = 1, ARM = 2, CORE = 3;
export const TERRAIN_NAMES = ['Void', 'Periphery', 'Arm', 'Core'];

/** Tech types. */
export const REACH = 0, FOCUS = 1, INDUSTRY = 2, FORCE = 3;
export const TECH_TYPES = ['Reach', 'Focus', 'Industry', 'Force'];
export const TECH_EFFECTS = ['+1 safe range and sight', '+1 to scatter rolls', '+1 fleet built per settlement per turn', '+1 strength in combat and when taking settlements'];
/** Tech names, six per type; a tech's id is its index here, its type is id / 6. */
export const TECH_NAMES = [
  'Long Sight', 'The Patient Map', 'Far Listening', 'Wide Chorus', 'Distant Kin', 'Star Atlas',
  'Choral Navigation', 'Anchor Songs', 'Lattice Dreaming', 'Still Mind', 'The Narrow Way', 'True Naming',
  'Borrowed Memory', 'Hive Yards', 'Seed Ships', 'The Long Harvest', 'Many Hands', 'Foundry Hymns',
  'War Chants', 'Iron Will', 'Shared Fury', 'The Shield Song', 'Bright Lances', 'Stone Hearts',
];
export const techType = (/** @type {number} */ id) => (id / 6) | 0;

/** Galaxy sizes: map radius and the spiral arm's segment lengths (see makeGalaxy). */
export const GALAXIES = {
  small: { radius: 10, arm: [1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4] },
  medium: { radius: 12, arm: [1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5] },
  large: { radius: 14, arm: [1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6] },
};

export const DEFAULTS = {
  galaxy: /** @type {keyof typeof GALAXIES} */ ('medium'),
  core: 2,             // cells up to this far from the centre are core
  beacons: 2,          // beacon pairs (one per arm each)
  dust: 4,             // dust lane pairs
  dustLength: 5,       // cells each dust lane runs along an arm's edge
  safeRange: 2,        // + Reach
  sight: 5,            // a stack is lost if no settlement of yours is in sight (this + Reach) and line of sight
  startFleets: 4,
  startRp: 3,
  secondRp: 1,         // extra RP for whoever goes second
  homeValue: 3,
  homePotential: 5,
  fleetCost: 3,
  foundCost: 2,        // fleets
  foundValue: 1,       // a new settlement's value (or its potential, if lower)
  freeStack: 3,        // fleets in one hex that cost no upkeep
  researchBase: 2,
  relicsToWin: 3,
  relicRespawn: 3,     // rounds after a pickup before a new relic appears on a free spawn hex
  turnLimit: 60,       // rounds; then the higher score wins
  seed: 1,
};

/** @typedef {typeof DEFAULTS} Params */

/**
 * @typedef {Object} Stack
 * @property {number} owner
 * @property {number} cell
 * @property {number} fleets
 * @property {number} ready   fleets that may still jump this turn
 * @property {number} idle    fleets that began this turn here and haven't left: only these can be spent on growing, building and research
 * @property {number} relics  relics carried
 */

/**
 * @typedef {Object} Civ
 * @property {number} rp
 * @property {number[]} techs     tech ids, in the order learned
 * @property {number} relics      delivered
 * @property {number[]} offer     the two techs on offer to research
 * @property {boolean} alive
 * @property {Uint8Array} known   1 where this civ has seen the hex's potential
 * @property {number} home
 */

/**
 * @typedef {Object} Game
 * @property {Params} params
 * @property {Grid} grid
 * @property {Rng} rng
 * @property {Uint8Array} terrain
 * @property {Uint8Array} potential
 * @property {Uint8Array} beacon
 * @property {Uint8Array} dust      bitmask of dust edges per cell, by direction
 * @property {Int8Array} owner      settlement owner, -1 = none
 * @property {Uint8Array} value     settlement value
 * @property {Int32Array} founded   turn a settlement was founded (or taken), -1: it isn't working until its owner's next turn
 * @property {Int32Array} grown     turn a settlement last grew, -1
 * @property {Uint8Array} built     fleets built at each settlement this turn
 * @property {Uint8Array} relicAt   relics lying in each hex
 * @property {number[]} spawns      the hexes a relic can appear on: the centre and its six neighbours
 * @property {number[]} respawn     pending new relics, each the rounds left (0 = waiting for a free spawn hex)
 * @property {Stack[]} stacks
 * @property {Civ[]} civs
 * @property {number} turn          half-turns played: civ turn+0 = first player
 * @property {number} current       civ whose turn it is
 * @property {number} first         civ who moved first
 * @property {number} winner        -1 while playing, a civ, or DRAW
 * @property {string} winBy         'relics' | 'elimination' | 'score' | ''
 * @property {number} epoch         bumped whenever a settlement changes hands (keys the sight cache)
 * @property {{key: number, map: Uint8Array}[]} sightCache  per civ: hexes in sight of its settlements
 */

/**
 * @typedef {{type: 'jump', civ: number, from: number, to: number, n: number, roll: number, need: number,
 *   landed: number, scatter: number, losses: number, lost: boolean, relics: number, chain: boolean}
 * | {type: 'pickup', civ: number, cell: number, relics: number}
 * | {type: 'drop', cell: number, relics: number}
 * | {type: 'return', cell: number}
 * | {type: 'respawn', cell: number}
 * | {type: 'hazard', civ: number, cell: number, lost: number, left: number}
 * | {type: 'deliver', civ: number, cell: number, relics: number, total: number}
 * | {type: 'combat', cell: number, attacker: number, defender: number, before: [number, number], after: [number, number], rounds: number}
 * | {type: 'flip', civ: number, from: number, cell: number, roll: number, need: number, ok: boolean, tech: number}
 * | {type: 'found', civ: number, cell: number}
 * | {type: 'grow', civ: number, cell: number, value: number}
 * | {type: 'build', civ: number, cell: number}
 * | {type: 'research', civ: number, cell: number, tech: number}
 * | {type: 'income', civ: number, rp: number, upkeep: number, starved: number}
 * | {type: 'turn', civ: number, turn: number}
 * | {type: 'eliminated', civ: number}
 * | {type: 'win', civ: number, by: string}} GameEvent
 */

/** A refused action. @typedef {{ error: string }} Refusal */

// ---------------------------------------------------------------- the galaxy

/**
 * Lay out a two-armed spiral. The arm is a turtle walk out from the
 * centre, turning 30° after each segment (a 30° heading on a hex grid is
 * an alternating zig-zag of the two 60° directions either side). The second
 * arm is the first turned 180°. Integer-only, so every device builds the
 * same galaxy from the same seed.
 * @param {Game} game
 */
function makeGalaxy(game) {
  const { grid: g, params: p, rng } = game;
  /** @type {number[]} */ const spine = [];
  let q = 2, r = 0, h = 2, alt = 0;
  for (const L of GALAXIES[p.galaxy].arm) {
    for (let k = 0; k < L; k++) {
      const d = h % 2 === 0 ? h / 2 : ((alt++ % 2 ? (h + 1) / 2 : (h - 1) / 2) % 6);
      q += DIRS[d][0];
      r += DIRS[d][1];
      const i = axialToIndex(g, q, r);
      if (i < 0) break;
      spine.push(i);
    }
    h = (h + 1) % 12;
  }
  // distance from either arm's spine, by breadth-first search
  const dist = new Int16Array(g.N).fill(999);
  /** @type {number[]} */ const queue = [];
  for (const i of spine) for (const j of [i, rotate(g, i)]) { dist[j] = 0; queue.push(j); }
  for (let k = 0; k < queue.length; k++) {
    const c = /** @type {number} */ (queue[k]);
    for (let d = 0; d < 6; d++) {
      const n = g.nbr[c * 6 + d];
      if (n >= 0 && dist[n] > dist[c] + 1) { dist[n] = dist[c] + 1; queue.push(n); }
    }
  }
  // terrain and potential, generated for one cell of each symmetric pair
  for (let i = 0; i < g.N; i++) {
    const j = rotate(g, i);
    if (j < i) continue;
    let t = VOID;
    if (ring(g, i) <= p.core) t = CORE;
    else if (dist[i] === 0 || (dist[i] === 1 && rng.int(100) < 25)) t = ARM;
    else if (dist[i] === 1 || (dist[i] === 2 && rng.int(100) < 25)) t = PERIPHERY;
    const pot = t === ARM ? 3 + rng.int(3) : t === PERIPHERY ? 1 + rng.int(3) : 0;
    game.terrain[i] = game.terrain[j] = t;
    game.potential[i] = game.potential[j] = pot;
  }
  const c = g.centre;
  game.spawns = [c, ...[0, 1, 2, 3, 4, 5].map((d) => g.nbr[c * 6 + d])];
  // relics start on the centre and an opposite pair of its neighbours, so neither civ is nearer
  const d0 = rng.int(3);
  for (const k of [c, g.nbr[c * 6 + d0], g.nbr[c * 6 + d0 + 3]]) game.relicAt[k] = 1;

  const home = spine[spine.length - 1];
  game.civs[0].home = home;
  game.civs[1].home = rotate(g, home);

  // beacons: bright arm stars partway along each arm
  const armCells = spine.filter((i) => ring(g, i) >= 4 && hexDist(g, i, home) >= 3);
  /** @type {number[]} */ const beacons = [];
  for (let b = 0; b < p.beacons && armCells.length; b++) {
    for (let tries = 0; tries < 20; tries++) {
      const i = armCells[rng.int(armCells.length)];
      if (beacons.every((x) => hexDist(g, x, i) >= 4)) { beacons.push(i); break; }
    }
  }
  for (const i of beacons) {
    game.beacon[i] = game.beacon[rotate(g, i)] = 1;
    game.terrain[i] = game.terrain[rotate(g, i)] = ARM;
  }

  // dust lanes: walls along an arm's edge, between it and the void
  const bordersVoid = (/** @type {number} */ i) => game.terrain[i] === PERIPHERY && ring(g, i) >= 4
    && [0, 1, 2, 3, 4, 5].some((d) => { const n = g.nbr[i * 6 + d]; return n >= 0 && game.terrain[n] === VOID; });
  const starts = [];
  for (let i = 0; i < g.N; i++) if (bordersVoid(i) && hexDist(g, i, home) >= 3 && hexDist(g, i, rotate(g, home)) >= 3) starts.push(i);
  for (let lane = 0; lane < p.dust && starts.length; lane++) {
    let cur = starts[rng.int(starts.length)];
    for (let step = 0; step < p.dustLength; step++) {
      for (let d = 0; d < 6; d++) {
        const n = g.nbr[cur * 6 + d];
        if (n >= 0 && game.terrain[n] === VOID) {
          setDust(game, cur, d);
          setDust(game, rotate(g, cur), dirTo(g, rotate(g, cur), rotate(g, n)));
        }
      }
      const next = [];
      for (let d = 0; d < 6; d++) {
        const n = g.nbr[cur * 6 + d];
        if (n >= 0 && bordersVoid(n) && !hasAnyDust(game, n)) next.push(n);
      }
      if (!next.length) break;
      cur = next[rng.int(next.length)];
    }
  }
}

/** @param {Game} game @param {number} a @param {number} d */
function setDust(game, a, d) {
  const b = game.grid.nbr[a * 6 + d];
  if (b < 0) return;
  game.dust[a] |= 1 << d;
  game.dust[b] |= 1 << ((d + 3) % 6);
}
const hasAnyDust = (/** @type {Game} */ game, /** @type {number} */ i) => game.dust[i] !== 0;

// ---------------------------------------------------------------- setup

/**
 * @param {Partial<Params>} [opts]
 * @returns {Game}
 */
export function createGame(opts = {}) {
  const params = { ...DEFAULTS, ...opts };
  if (!(params.galaxy in GALAXIES)) params.galaxy = 'medium';
  const grid = createGrid(GALAXIES[params.galaxy].radius);
  const N = grid.N;
  const rng = createRng(params.seed);
  /** @returns {Civ} */
  const civ = () => ({ rp: params.startRp, techs: [], relics: 0, offer: [], alive: true, known: new Uint8Array(N), home: -1 });
  /** @type {Game} */
  const game = {
    params, grid, rng,
    terrain: new Uint8Array(N), potential: new Uint8Array(N), beacon: new Uint8Array(N), dust: new Uint8Array(N),
    owner: new Int8Array(N).fill(-1), value: new Uint8Array(N),
    founded: new Int32Array(N).fill(-1), grown: new Int32Array(N).fill(-1), built: new Uint8Array(N),
    relicAt: new Uint8Array(N), spawns: [], respawn: [],
    stacks: [], civs: [civ(), civ()],
    turn: 0, current: 0, first: 0, winner: -1, winBy: '',
    epoch: 0, sightCache: [{ key: -1, map: new Uint8Array(N) }, { key: -1, map: new Uint8Array(N) }],
  };
  makeGalaxy(game);
  for (let c = 0; c < 2; c++) {
    const home = game.civs[c].home;
    game.potential[home] = params.homePotential;
    game.terrain[home] = ARM;
    game.owner[home] = c;
    game.value[home] = params.homeValue;
    game.stacks.push({ owner: c, cell: home, fleets: params.startFleets, ready: params.startFleets, idle: params.startFleets, relics: 0 });
    for (const i of within(grid, home, 1)) game.civs[c].known[i] = 1;
    drawOffer(game, c);
  }
  game.civs[1].rp += params.secondRp;
  return game;
}

// ---------------------------------------------------------------- queries

/** Tech level of a type: techs of that type plus delivered relics. */
export function level(/** @type {Game} */ game, /** @type {number} */ c, /** @type {number} */ type) {
  const civ = game.civs[c];
  let n = civ.relics;
  for (const t of civ.techs) if (techType(t) === type) n++;
  return n;
}

export const safeRange = (/** @type {Game} */ game, /** @type {number} */ c) => game.params.safeRange + level(game, c, REACH);
export const sightRange = (/** @type {Game} */ game, /** @type {number} */ c) => game.params.sight + level(game, c, REACH);
export const buildLimit = (/** @type {Game} */ game, /** @type {number} */ c) => 1 + level(game, c, INDUSTRY);

/** @param {Game} game @param {number} owner @param {number} cell */
export function stackAt(game, owner, cell) {
  return game.stacks.find((s) => s.owner === owner && s.cell === cell) ?? null;
}

/** The enemy stack in a hex, if any. */
export function enemyAt(/** @type {Game} */ game, /** @type {number} */ c, /** @type {number} */ cell) {
  return game.stacks.find((s) => s.owner !== c && s.cell === cell) ?? null;
}

/** A settlement with an enemy stack in it is besieged: it makes nothing and builds nothing. */
export function besieged(/** @type {Game} */ game, /** @type {number} */ cell) {
  const o = game.owner[cell];
  return o >= 0 && enemyAt(game, o, cell) !== null;
}

/** How a rival's stack size looks: '1', '2–3', '4–6' or '7+'. */
export function band(/** @type {number} */ n) {
  return n <= 1 ? '1' : n <= 3 ? '2–3' : n <= 6 ? '4–6' : '7+';
}
/** A guess at a stack's size from its band (the CPU uses this, never the real number). */
export function bandGuess(/** @type {number} */ n) {
  return n <= 1 ? 1 : n <= 3 ? 3 : n <= 6 ? 5 : 8;
}

export const isCore = (/** @type {Game} */ game, /** @type {number} */ i) => game.terrain[i] === CORE;

/** A civ's settlement that counts for jumping and delivery: owned, and not founded or taken this turn. */
export function working(/** @type {Game} */ game, /** @type {number} */ c, /** @type {number} */ cell) {
  return game.owner[cell] === c && game.founded[cell] !== game.turn;
}

/**
 * Does a straight line from a to b cross a dust edge? A line counts as
 * crossing only if both of its traces do, so a line that grazes the end of
 * a lane slips past.
 * @param {Game} game @param {number} a @param {number} b
 */
export function crossesDust(game, a, b) {
  const g = game.grid;
  const traces = lineTraces(g, a, b);
  return traces.every((t) => {
    for (let k = 1; k < t.length; k++) {
      const x = t[k - 1], y = t[k];
      if (x < 0 || y < 0 || x === y) continue;
      const d = dirTo(g, x, y);
      if (d >= 0 && game.dust[x] & (1 << d)) return true;
    }
    return false;
  });
}

/**
 * Clear line of sight: no dust in the way, and the core's glare doesn't
 * lie between (it blocks sight through it, not into or out of it).
 * @param {Game} game @param {number} a @param {number} b
 */
export function lineOfSight(game, a, b) {
  if (crossesDust(game, a, b)) return false;
  const traces = lineTraces(game.grid, a, b);
  const glare = traces.every((t) => t.slice(1, -1).some((i) => i >= 0 && isCore(game, i)));
  return !glare;
}

/** Is a hex in sight of one of a civ's settlements? */
export function inSight(/** @type {Game} */ game, /** @type {number} */ c, /** @type {number} */ cell) {
  return sightMap(game, c)[cell] === 1;
}

/**
 * Every hex in sight of a civ's settlements, cached until a settlement
 * changes hands or the civ's sight range changes.
 * @param {Game} game @param {number} c
 */
export function sightMap(game, c) {
  const range = sightRange(game, c);
  const key = game.epoch * 64 + range;
  const cache = game.sightCache[c];
  if (cache.key === key) return cache.map;
  cache.map.fill(0);
  for (let s = 0; s < game.grid.N; s++) {
    if (game.owner[s] !== c) continue;
    for (const i of within(game.grid, s, range)) if (!cache.map[i] && lineOfSight(game, i, s)) cache.map[i] = 1;
  }
  cache.key = key;
  return cache.map;
}

/**
 * @typedef {Object} Outcome
 * @property {number} cell    where the stack lands, -1 if lost off the map
 * @property {number} scatter hexes from the target
 * @property {number} losses  fleets lost on the way
 * @property {boolean} lost   the whole stack is lost
 * @property {number} weight  chances in 36
 */

/**
 * @typedef {Object} Preview
 * @property {number} from @property {number} to @property {number} n
 * @property {number} dist
 * @property {boolean} over     over safe range
 * @property {number} need
 * @property {number} bonus     added to the d6
 * @property {number} hits      faces of the d6 (of 6) that land on target
 * @property {boolean} chain    landing on target lets the stack jump again
 * @property {Outcome[]} outcomes  every scatter result, by face then direction
 * @property {number} loseChance   chances in 36 that the whole stack is lost
 */

/**
 * Can this jump be made, and what might happen? Returns a refusal or the
 * full odds. The same function decides the real jump, so the preview is
 * never wrong.
 * @param {Game} game @param {number} from @param {number} to @param {number} [n]  fleets to send (default: all ready)
 * @returns {Preview | Refusal}
 */
export function preview(game, from, to, n) {
  const c = game.current;
  const g = game.grid;
  if (game.winner >= 0) return { error: 'The game is over.' };
  const stack = stackAt(game, c, from);
  if (!stack || stack.ready <= 0) return { error: 'No fleets here can jump this turn.' };
  const count = n ?? stack.ready;
  if (count < 1 || count > stack.ready) return { error: 'Not that many fleets are ready.' };
  if (to < 0 || to === from) return { error: 'Pick another hex.' };
  const dist = hexDist(g, from, to);
  const fromOwn = game.owner[from] === c;
  const toOwn = game.owner[to] === c;
  const over = dist > safeRange(game, c);
  if (over && !working(game, c, from)) {
    return { error: fromOwn ? 'Too far. Long jumps from a settlement founded or taken this turn have to wait a turn.' : 'Too far. Long jumps can only start from your own settlement.' };
  }
  if (dist > 1 && crossesDust(game, from, to) && !(fromOwn && toOwn)) {
    return { error: 'Dust in the way. Only a one-hex hop, or a jump between your own settlements, can cross it.' };
  }
  const bonus = level(game, c, FOCUS) + (toOwn ? 1 : 0) + (game.beacon[to] ? 1 : 0) - (over ? 2 : 0);
  if (stack.relics && !working(game, c, to) && stackAt(game, c, to)?.relics) return { error: 'A stack can carry only one relic.' };
  const need = 2 + Math.floor(dist / 3);
  let hits = 0;
  /** @type {Outcome[]} */ const outcomes = [];
  let loseChance = 0;
  for (let face = 1; face <= 6; face++) {
    if (dist === 1 || face + bonus >= need) { hits++; continue; }
    const k = need - face - bonus;
    for (let d = 0; d < 6; d++) {
      const o = scatterOutcome(game, c, from, to, d, k, count, over);
      outcomes.push(o);
      if (o.lost) loseChance += 1;
    }
  }
  // relic carriers never chain: delivering (or carrying) a relic is the end of the move
  return { from, to, n: count, dist, over, need, bonus, hits, chain: working(game, c, to) && !over && stack.relics === 0, outcomes, loseChance };
}

/**
 * Where a stack ends up if it scatters k hexes in direction d from its target.
 * @param {Game} game @param {number} c @param {number} from @param {number} to
 * @param {number} d @param {number} k @param {number} n @param {boolean} over
 * @returns {Outcome}
 */
function scatterOutcome(game, c, from, to, d, k, n, over) {
  const losses = Math.floor(k / 2) * (over ? 2 : 1);
  const viaCore = isCore(game, from) || isCore(game, to);
  if (viaCore) return { cell: -1, scatter: k, losses: n, lost: true, weight: 1 };
  let cell = stepFrom(game.grid, to, d, k);
  if (game.owner[to] === c) {
    // aimed at your own settlement: never lost, so fall short of the edge or the core
    let kk = k;
    while (kk > 0 && (cell < 0 || isCore(game, cell))) cell = stepFrom(game.grid, to, d, --kk);
    return { cell, scatter: kk, losses: Math.min(losses, n), lost: losses >= n, weight: 1 };
  }
  if (cell < 0 || isCore(game, cell) || losses >= n) return { cell, scatter: k, losses: Math.min(losses, n), lost: true, weight: 1 };
  if (!inSight(game, c, cell)) return { cell, scatter: k, losses, lost: true, weight: 1 };
  return { cell, scatter: k, losses, lost: false, weight: 1 };
}

// ---------------------------------------------------------------- actions

/** @param {Game} game @returns {Refusal | null} */
function notYourMove(game) {
  if (game.winner >= 0) return { error: 'The game is over.' };
  return null;
}

/** @param {Game} game @param {number} c */
function rollD6(game, c) { void c; return 1 + game.rng.int(6); }

/**
 * Jump n fleets from one hex to another.
 * @param {Game} game @param {number} from @param {number} to @param {number} [n]
 * @returns {GameEvent[] | Refusal}
 */
export function jump(game, from, to, n) {
  const pv = preview(game, from, to, n);
  if ('error' in pv) return pv;
  const c = game.current;
  /** @type {GameEvent[]} */ const ev = [];
  const stack = /** @type {Stack} */ (stackAt(game, c, from));
  const relics = stack.relics;
  stack.fleets -= pv.n;
  stack.ready -= pv.n;
  stack.idle = Math.min(stack.idle, stack.fleets);
  stack.relics = 0;
  if (stack.fleets <= 0) removeStack(game, stack);

  const roll = pv.dist === 1 ? 0 : rollD6(game, c); // a one-hex hop needs no roll
  const onTarget = pv.dist === 1 || roll + pv.bonus >= pv.need;
  /** @type {GameEvent & {type: 'jump'}} */
  const je = { type: 'jump', civ: c, from, to, n: pv.n, roll, need: pv.need, landed: to, scatter: 0, losses: 0, lost: false, relics, chain: false };
  ev.push(je);
  let fleets = pv.n;
  let cell = to;
  if (!onTarget) {
    const k = pv.need - roll - pv.bonus;
    const d = game.rng.int(6);
    const o = scatterOutcome(game, c, from, to, d, k, pv.n, pv.over);
    je.landed = o.cell;
    je.scatter = o.scatter;
    je.losses = o.losses;
    je.lost = o.lost;
    if (o.lost) {
      if (relics) returnRelic(game, ev);
      return ev;
    }
    fleets -= o.losses;
    cell = o.cell;
  }
  je.chain = onTarget && pv.chain;
  arrive(game, c, cell, fleets, relics, je.chain, ev);
  checkWin(game, ev);
  return ev;
}

/**
 * A group of fleets arrives in a hex: pick up relics, fight, merge, deliver, take.
 * @param {Game} game @param {number} c @param {number} cell @param {number} fleets
 * @param {number} relics @param {boolean} chain @param {GameEvent[]} ev
 */
function arrive(game, c, cell, fleets, relics, chain, ev) {
  game.civs[c].known[cell] = 1;
  const foe = enemyAt(game, c, cell);
  if (foe) {
    const r = fight(game, c, fleets, foe, ev, cell);
    fleets = r;
    if (fleets <= 0) {
      if (relics) dropRelics(game, cell, relics, ev);
      return;
    }
  }
  let mine = stackAt(game, c, cell);
  if (!mine) {
    mine = { owner: c, cell, fleets: 0, ready: 0, idle: 0, relics: 0 };
    game.stacks.push(mine);
  }
  mine.fleets += fleets;
  if (chain) mine.ready += fleets;
  mine.relics += relics;
  deliver(game, mine, ev);
  if (mine.relics > 1) { dropRelics(game, cell, mine.relics - 1, ev); mine.relics = 1; } // only by scatter
  if (game.owner[cell] >= 0 && game.owner[cell] !== c) tryFlip(game, mine, ev);
}

/**
 * Fight to the finish. Returns the attacker's surviving fleets.
 * @param {Game} game @param {number} c @param {number} fleets @param {Stack} foe
 * @param {GameEvent[]} ev @param {number} cell
 */
function fight(game, c, fleets, foe, ev, cell) {
  const before = /** @type {[number, number]} */ ([fleets, foe.fleets]);
  const fa = level(game, c, FORCE), fd = level(game, foe.owner, FORCE) + (game.owner[cell] === foe.owner ? 1 : 0);
  let rounds = 0;
  while (fleets > 0 && foe.fleets > 0) {
    rounds++;
    const ha = Math.max(1, Math.floor(((fleets + fa) * rollD6(game, c)) / 10));
    const hd = Math.max(1, Math.floor(((foe.fleets + fd) * rollD6(game, foe.owner)) / 10));
    fleets = Math.max(0, fleets - hd);
    foe.fleets = Math.max(0, foe.fleets - ha);
  }
  foe.ready = Math.min(foe.ready, foe.fleets);
  foe.idle = Math.min(foe.idle, foe.fleets);
  ev.push({ type: 'combat', cell, attacker: c, defender: foe.owner, before, after: [fleets, foe.fleets], rounds });
  if (foe.fleets <= 0) {
    if (foe.relics) dropRelics(game, cell, foe.relics, ev);
    removeStack(game, foe);
  }
  return fleets;
}

/** @param {Game} game @param {Stack} s @param {GameEvent[]} ev */
function deliver(game, s, ev) {
  if (!s.relics || !working(game, s.owner, s.cell) || besieged(game, s.cell)) return;
  const civ = game.civs[s.owner];
  civ.relics += s.relics;
  ev.push({ type: 'deliver', civ: s.owner, cell: s.cell, relics: s.relics, total: civ.relics });
  s.relics = 0;
}

/**
 * Try to take an undefended enemy settlement.
 * @param {Game} game @param {Stack} s @param {GameEvent[]} ev
 */
function tryFlip(game, s, ev) {
  const cell = s.cell, from = game.owner[cell];
  if (from < 0 || from === s.owner || enemyAt(game, s.owner, cell)) return;
  const roll = rollD6(game, s.owner);
  const need = game.value[cell] + 4;
  const ok = roll + s.fleets + level(game, s.owner, FORCE) >= need;
  let tech = -1;
  if (ok) {
    game.owner[cell] = s.owner;
    game.epoch++;
    game.value[cell] = Math.max(0, game.value[cell] - 1);
    game.founded[cell] = game.turn;
    game.civs[s.owner].known[cell] = 1;
    if (rollD6(game, s.owner) >= 5) {
      const mine = game.civs[s.owner].techs;
      const theirs = game.civs[from].techs.filter((t) => !mine.includes(t));
      if (theirs.length) {
        tech = theirs[game.rng.int(theirs.length)];
        learn(game, s.owner, tech);
      }
    }
  }
  ev.push({ type: 'flip', civ: s.owner, from, cell, roll, need: need - s.fleets - level(game, s.owner, FORCE), ok, tech });
  if (ok) {
    if (!game.owner.some((o) => o === from)) eliminate(game, from, ev);
  }
}

/** @param {Game} game @param {number} c @param {GameEvent[]} ev */
function eliminate(game, c, ev) {
  game.civs[c].alive = false;
  for (const s of game.stacks.filter((x) => x.owner === c)) {
    if (s.relics) dropRelics(game, s.cell, s.relics, ev);
    removeStack(game, s);
  }
  ev.push({ type: 'eliminated', civ: c });
}

/** @param {Game} game @param {Stack} s */
function removeStack(game, s) {
  const k = game.stacks.indexOf(s);
  if (k >= 0) game.stacks.splice(k, 1);
}

/** Spawn hexes with no relic and no stack of either civ. @param {Game} game */
function freeSpawns(game) {
  return game.spawns.filter((c) => !game.relicAt[c] && !game.stacks.some((s) => s.cell === c));
}

/** A relic back on the board cancels the pending respawn with the most rounds left. @param {Game} game */
function cancelRespawn(game) {
  if (game.respawn.length) game.respawn.splice(game.respawn.indexOf(Math.max(...game.respawn)), 1);
}

/** Relics dropped where a carrier fell. @param {Game} game @param {number} cell @param {number} n @param {GameEvent[]} ev */
function dropRelics(game, cell, n, ev) {
  game.relicAt[cell] += n;
  for (let k = 0; k < n; k++) cancelRespawn(game);
  ev.push({ type: 'drop', cell, relics: n });
}

/** A relic lost in space goes to a random free spawn hex, or waits for one. @param {Game} game @param {GameEvent[]} ev */
function returnRelic(game, ev) {
  cancelRespawn(game);
  const free = freeSpawns(game);
  if (!free.length) { game.respawn.push(0); return; }
  const cell = free[game.rng.int(free.length)];
  game.relicAt[cell]++;
  ev.push({ type: 'return', cell });
}

/** @param {Game} game @param {number} c @param {number} tech */
function learn(game, c, tech) {
  const civ = game.civs[c];
  if (civ.techs.includes(tech)) return;
  civ.techs.push(tech);
  civ.offer = civ.offer.filter((t) => t !== tech);
  if (civ.offer.length < 2) drawOffer(game, c);
}

/** Two techs this civ doesn't know. @param {Game} game @param {number} c */
function drawOffer(game, c) {
  const civ = game.civs[c];
  const pool = [];
  for (let t = 0; t < TECH_NAMES.length; t++) if (!civ.techs.includes(t)) pool.push(t);
  civ.offer = [];
  while (civ.offer.length < 2 && pool.length) civ.offer.push(pool.splice(game.rng.int(pool.length), 1)[0]);
}

/** Fleets it costs this civ to research a tech. */
export function researchCost(/** @type {Game} */ game, /** @type {number} */ c, /** @type {number} */ tech) {
  const civ = game.civs[c];
  const rivalKnows = game.civs[1 - c].techs.includes(tech);
  return game.params.researchBase + Math.floor(civ.techs.length / 3) - (rivalKnows ? 1 : 0);
}

/**
 * Spend fleets from a stack, the ones that can't jump any more first.
 * @param {Game} game @param {Stack} s @param {number} n
 */
function spend(game, s, n) {
  s.fleets -= n;
  s.idle -= n;
  s.ready = Math.min(s.ready, s.fleets);
  if (s.fleets <= 0) {
    if (s.relics) dropRelics(game, s.cell, s.relics, []); // can't happen at a settlement, where relics are delivered
    removeStack(game, s);
  }
}

const RELIC_STAYS = 'The relic needs a fleet left to wait here for delivery.';

/**
 * What can be built in a hex right now? Each entry is null if allowed or a reason.
 * @param {Game} game @param {number} cell
 */
export function buildOptions(game, cell) {
  const c = game.current, p = game.params;
  const s = stackAt(game, c, cell);
  const fleets = s ? s.idle : 0;
  const arrived = s && s.fleets > s.idle ? ' (fleets that arrived this turn have to wait a turn)' : '';
  const mine = game.owner[cell] === c;
  const sieged = mine && besieged(game, cell);
  /** @type {{found: string|null, grow: string|null, build: string|null, research: (string|null)[]}} */
  const out = { found: null, grow: null, build: null, research: [] };
  if (game.owner[cell] >= 0) out.found = 'There is a settlement here already.';
  else if (game.terrain[cell] === VOID) out.found = 'Nothing can be settled in the void.';
  else if (isCore(game, cell)) out.found = 'Nothing can be settled in the core.';
  else if (!game.civs[c].known[cell]) out.found = 'Land here first, to see what it is worth.';
  else if (!s || s.fleets < p.foundCost) out.found = `Needs ${p.foundCost} fleets here.`;
  else if (s.relics && s.fleets <= p.foundCost) out.found = RELIC_STAYS;
  if (!mine) out.grow = out.build = 'Not your settlement.';
  else if (sieged) out.grow = out.build = 'Besieged: drive the enemy out first.';
  else {
    if (game.value[cell] >= game.potential[cell]) out.grow = 'Already at its potential.';
    else if (game.founded[cell] === game.turn) out.grow = 'Founded this turn: grow it next turn.';
    else if (game.built[cell] > 0) out.grow = 'Built a fleet here this turn.';
    else if (fleets < 1) out.grow = `Needs a fleet here${arrived}.`;
    if (game.value[cell] < 1) out.build = 'Grow it to value 1 first.';
    else if (game.founded[cell] === game.turn) out.build = 'Founded this turn: build here next turn.';
    else if (game.grown[cell] === game.turn) out.build = 'Grew this turn.';
    else if (game.built[cell] >= buildLimit(game, c)) out.build = 'Built as many as it can this turn.';
    else if (game.civs[c].rp < p.fleetCost) out.build = `Needs ${p.fleetCost} RP.`;
  }
  for (const t of game.civs[c].offer) {
    const cost = researchCost(game, c, t);
    out.research.push(!mine ? 'Research at one of your settlements.' : sieged ? 'Besieged.' : fleets < cost ? `Needs ${cost} fleets here${arrived}.`
      : s && s.relics && s.fleets <= cost ? RELIC_STAYS : null);
  }
  return out;
}

/**
 * Found a settlement with the fleets in a hex.
 * @param {Game} game @param {number} cell @returns {GameEvent[] | Refusal}
 */
export function found(game, cell) {
  const bad = notYourMove(game) ?? reason(buildOptions(game, cell).found);
  if (bad) return bad;
  const c = game.current;
  const s = /** @type {Stack} */ (stackAt(game, c, cell));
  /** @type {GameEvent[]} */ const ev = [];
  game.owner[cell] = c;
  game.epoch++;
  game.value[cell] = Math.min(game.params.foundValue, game.potential[cell]);
  game.founded[cell] = game.turn;
  ev.push({ type: 'found', civ: c, cell });
  // fleets that arrived this turn are spent first, so idle and ready never exceed fleets
  const cost = game.params.foundCost;
  s.idle -= cost - Math.min(cost, s.fleets - s.idle);
  s.fleets -= cost;
  s.ready = Math.min(s.ready, s.fleets);
  if (s.fleets <= 0) removeStack(game, s);
  checkWin(game, ev);
  return ev;
}

/** Spend a fleet to raise a settlement's value by 1. @param {Game} game @param {number} cell @returns {GameEvent[] | Refusal} */
export function grow(game, cell) {
  const bad = notYourMove(game) ?? reason(buildOptions(game, cell).grow);
  if (bad) return bad;
  const c = game.current;
  spend(game, /** @type {Stack} */ (stackAt(game, c, cell)), 1);
  game.value[cell]++;
  game.grown[cell] = game.turn;
  return [{ type: 'grow', civ: c, cell, value: game.value[cell] }];
}

/** Build a fleet for RP. It can't jump until next turn. @param {Game} game @param {number} cell @returns {GameEvent[] | Refusal} */
export function build(game, cell) {
  const bad = notYourMove(game) ?? reason(buildOptions(game, cell).build);
  if (bad) return bad;
  const c = game.current;
  game.civs[c].rp -= game.params.fleetCost;
  game.built[cell]++;
  let s = stackAt(game, c, cell);
  if (!s) { s = { owner: c, cell, fleets: 0, ready: 0, idle: 0, relics: 0 }; game.stacks.push(s); }
  s.fleets++;
  return [{ type: 'build', civ: c, cell }];
}

/**
 * Research one of the two techs on offer, paying in fleets at a settlement.
 * @param {Game} game @param {number} cell @param {number} pick  0 or 1
 * @returns {GameEvent[] | Refusal}
 */
export function research(game, cell, pick) {
  const c = game.current;
  const opts = buildOptions(game, cell);
  if (pick !== 0 && pick !== 1 || pick >= opts.research.length) return { error: 'No such tech on offer.' };
  const bad = notYourMove(game) ?? reason(opts.research[pick]);
  if (bad) return bad;
  const tech = game.civs[c].offer[pick];
  spend(game, /** @type {Stack} */ (stackAt(game, c, cell)), researchCost(game, c, tech));
  learn(game, c, tech);
  return [{ type: 'research', civ: c, cell, tech }];
}

/** @param {string|null} r @returns {Refusal|null} */
function reason(r) { return r ? { error: r } : null; }

/**
 * End the current civ's turn and start the other's: income, upkeep,
 * the core's glare, relics reappearing, sieges pressing on.
 * @param {Game} game @returns {GameEvent[]}
 */
export function endTurn(game) {
  /** @type {GameEvent[]} */ const ev = [];
  if (game.winner >= 0) return ev;
  // the core's glare: every fleet that ends its owner's turn there rolls a d6, and a 1 destroys it
  for (const s of game.stacks.slice()) {
    if (s.owner !== game.current || !isCore(game, s.cell)) continue;
    let lost = 0;
    for (let k = 0; k < s.fleets; k++) if (rollD6(game, s.owner) === 1) lost++;
    if (!lost) continue;
    s.fleets -= lost;
    s.ready = Math.min(s.ready, s.fleets);
    s.idle = Math.min(s.idle, s.fleets);
    ev.push({ type: 'hazard', civ: s.owner, cell: s.cell, lost, left: s.fleets });
    if (s.fleets <= 0) {
      if (s.relics) dropRelics(game, s.cell, s.relics, ev);
      removeStack(game, s);
    }
  }
  game.turn++;
  game.current = 1 - game.current;
  const c = game.current, p = game.params;
  if (game.current === game.first) {
    /** @type {number[]} */ const waiting = [];
    for (const t of game.respawn) {
      const left = Math.max(0, t - 1);
      const free = left === 0 ? freeSpawns(game) : [];
      if (free.length) {
        const cell = free[game.rng.int(free.length)];
        game.relicAt[cell]++;
        ev.push({ type: 'respawn', cell });
      } else waiting.push(left);
    }
    game.respawn = waiting;
  }
  // a carrier that waited at a settlement founded or taken last turn delivers now
  for (const s of game.stacks) if (s.owner === c) deliver(game, s, ev);
  checkWin(game, ev);
  if (game.winner >= 0) return ev;
  if (game.current === game.first && game.turn >= 2 * p.turnLimit) {
    scoreWin(game, ev);
    return ev;
  }
  ev.push({ type: 'turn', civ: c, turn: game.turn });
  game.built.fill(0);
  const civ = game.civs[c];
  for (const s of game.stacks) if (s.owner === c) s.ready = s.idle = s.fleets;
  // income and upkeep
  let income = 0;
  for (let i = 0; i < game.grid.N; i++) if (game.owner[i] === c && !besieged(game, i)) income += game.value[i];
  let upkeep = 0;
  for (const s of game.stacks) if (s.owner === c) upkeep += Math.max(0, s.fleets - p.freeStack);
  civ.rp += income - upkeep;
  let starved = 0;
  while (civ.rp < 0) {
    const big = game.stacks.filter((s) => s.owner === c).sort((a, b) => b.fleets - a.fleets)[0];
    if (!big || big.fleets <= p.freeStack) { civ.rp = 0; break; }
    spend(game, big, 1);
    starved++;
    civ.rp++;
  }
  ev.push({ type: 'income', civ: c, rp: income, upkeep, starved });
  // relics: a stack with no relic that held a relic's hex through the rival's turn picks one up, and a new one is due
  for (const s of game.stacks) {
    if (s.owner !== c || s.relics || !game.relicAt[s.cell]) continue;
    s.relics = 1;
    game.relicAt[s.cell]--;
    game.respawn.push(p.relicRespawn);
    ev.push({ type: 'pickup', civ: c, cell: s.cell, relics: 1 });
    deliver(game, s, ev);
  }
  // sieges: stacks sitting in enemy settlements try again to take them
  for (const s of game.stacks.slice()) {
    if (s.owner === c && game.owner[s.cell] >= 0 && game.owner[s.cell] !== c && game.stacks.includes(s)) tryFlip(game, s, ev);
  }
  checkWin(game, ev);
  return ev;
}

/** @param {Game} game @param {GameEvent[]} ev */
function checkWin(game, ev) {
  if (game.winner >= 0) return;
  for (let c = 0; c < 2; c++) {
    if (game.civs[c].relics >= game.params.relicsToWin) { win(game, c, 'relics', ev); return; }
  }
  const alive = [0, 1].filter((c) => game.civs[c].alive);
  if (alive.length === 1) win(game, alive[0], 'elimination', ev);
}

/** Score at the turn limit: relics first, then settlement value. */
export function score(/** @type {Game} */ game, /** @type {number} */ c) {
  let v = 0;
  for (let i = 0; i < game.grid.N; i++) if (game.owner[i] === c) v += game.value[i];
  return game.civs[c].relics * 100 + v;
}

/** @param {Game} game @param {GameEvent[]} ev */
function scoreWin(game, ev) {
  const a = score(game, 0), b = score(game, 1);
  if (a === b) { game.winner = DRAW; game.winBy = 'score'; ev.push({ type: 'win', civ: DRAW, by: 'score' }); }
  else win(game, a > b ? 0 : 1, 'score', ev);
}

/** @param {Game} game @param {number} c @param {string} by @param {GameEvent[]} ev */
function win(game, c, by, ev) {
  game.winner = c;
  game.winBy = by;
  ev.push({ type: 'win', civ: c, by });
}

/** A short fingerprint of the game state, for checking two runs agree. */
export function stateHash(/** @type {Game} */ game) {
  let h = 2166136261 >>> 0;
  const mix = (/** @type {number} */ x) => { h = Math.imul(h ^ (x & 0xffff), 16777619) >>> 0; h = Math.imul(h ^ (x >>> 16), 16777619) >>> 0; };
  mix(game.turn); mix(game.current); mix(game.winner); mix(game.rng.state());
  for (let i = 0; i < game.grid.N; i++) { mix(game.owner[i] + 1); mix(game.value[i]); mix(game.relicAt[i]); }
  for (const s of game.stacks) { mix(s.owner); mix(s.cell); mix(s.fleets); mix(s.ready); mix(s.idle); mix(s.relics); }
  for (const civ of game.civs) { mix(civ.rp); mix(civ.relics); for (const t of civ.techs) mix(t); }
  for (let i = 0; i < game.grid.N; i++) mix(game.founded[i] + 1);
  for (const t of game.respawn) mix(t);
  return h;
}

/**
 * An action, as the player or the CPU sends it. Network play will send these.
 * @typedef {{kind: 'jump', from: number, to: number, n: number}
 * | {kind: 'found', cell: number} | {kind: 'grow', cell: number} | {kind: 'build', cell: number}
 * | {kind: 'research', cell: number, pick: number} | {kind: 'end'}} Action
 */

/** Apply an action for the current civ. @param {Game} game @param {Action} a @returns {GameEvent[] | Refusal} */
export function act(game, a) {
  switch (a.kind) {
    case 'jump': return jump(game, a.from, a.to, a.n);
    case 'found': return found(game, a.cell);
    case 'grow': return grow(game, a.cell);
    case 'build': return build(game, a.cell);
    case 'research': return research(game, a.cell, a.pick);
    case 'end': return endTurn(game);
  }
  return { error: 'Unknown action.' };
}
