// @ts-check
// Dot Army simulation core. Deterministic: integer state plus a seeded RNG,
// with no dependence on wall-clock time or Math.random. See RULES.md for the
// rules this implements; phase numbers below match that document.

import { createRng } from './rng.js';
import { createGrid, dirToward, dirDiff, hexDist, mirror } from './hex.js';

/** @typedef {import('./hex.js').Grid} Grid */
/** @typedef {import('./rng.js').Rng} Rng */

export const BLUE = 0;
export const RED = 1;
export const NEUTRAL = -1;
const INF = 0x3fffffff;

export const DEFAULTS = {
  width: 60,
  height: 40,
  tickRate: 8,
  spawnInterval: 2,
  neutralSpawns: 6,
  meterMax: 40,
  neutralMeter: 10,
  meterRegen: 8,
  facingArc: 1,
  maxDotsPerPlayer: 0,
  terrain: 'open',
  seed: 1,
};

/** @typedef {typeof DEFAULTS} Params */

/**
 * @typedef {Object} Dot
 * @property {number} id
 * @property {number} player
 * @property {number} cell
 * @property {number} facing   0..5
 * @property {number} prevCell  cell at the start of this tick (for rendering)
 * @property {number} prevFacing
 * @property {boolean} locked   in a stalemate this tick
 * @property {boolean} settled  arrived: at the target, or packed in behind settled friends
 */

/**
 * @typedef {Object} Spawn
 * @property {number} id
 * @property {number} center
 * @property {number[]} cells  the 7 blob cells
 * @property {number[]} exits  the 12 ring cells around the blob (on board)
 * @property {number} owner    BLUE, RED or NEUTRAL
 * @property {number} meter
 * @property {boolean} home
 */

/**
 * @typedef {Object} Events
 * @property {{cell: number, victim: number, killerCell: number}[]} kills
 * @property {{spawn: number, player: number, amount: number}[]} hits
 * @property {{spawn: number, from: number, to: number}[]} captures
 * @property {number} spawned
 * @property {number} consumed
 */

/**
 * @typedef {Object} Game
 * @property {Params} params
 * @property {Grid} grid
 * @property {Rng} rng
 * @property {number} tick
 * @property {Uint8Array} terrain  0 free, 1 wall, 2 spawn
 * @property {Int16Array} spawnOf  spawn id per cell, -1 if none
 * @property {(Dot|null)[]} occ    dot occupying each cell
 * @property {Dot[]} dots
 * @property {Spawn[]} spawns
 * @property {number[]} targets    target cell per player
 * @property {Int32Array[]} dist   flow field per player
 * @property {number[]} dotCount   per player
 * @property {number} nextId
 * @property {number} winner       -1 while playing
 * @property {Events} events       what happened in the last tick
 * @property {Stats} stats         running totals per player, for the end screen
 */

/**
 * @typedef {Object} Stats  each entry is [blue, red]
 * @property {number[]} spawned   dots emitted
 * @property {number[]} kills     enemy dots destroyed
 * @property {number[]} lost      own dots destroyed in combat
 * @property {number[]} spent     own dots used up attacking or reinforcing spawns
 * @property {number[]} captures  spawns taken
 * @property {number[]} peak      largest army on the field at once
 */

const FREE = 0, WALL = 1, SPAWN = 2;

/**
 * Optional explicit layout (used by tests and future map designs).
 * @typedef {Object} Layout
 * @property {{center: number, owner: number, meter?: number, home?: boolean}[]} spawns
 * @property {number[]} [walls]
 */

/**
 * @param {Partial<Params>} [overrides]
 * @param {Layout} [layout]
 * @returns {Game}
 */
export function createGame(overrides = {}, layout) {
  /** @type {Params} */
  const params = { ...DEFAULTS, ...overrides };
  params.height += params.height & 1; // keep H even: 180° rotation is then exact
  const grid = createGrid(params.width, params.height);
  const N = grid.N;
  /** @type {Game} */
  const game = {
    params, grid,
    rng: createRng(params.seed),
    tick: 0,
    terrain: new Uint8Array(N),
    spawnOf: new Int16Array(N).fill(-1),
    occ: new Array(N).fill(null),
    dots: [],
    spawns: [],
    targets: [0, 0],
    dist: [new Int32Array(N), new Int32Array(N)],
    dotCount: [0, 0],
    nextId: 1,
    winner: -1,
    events: emptyEvents(),
    stats: { spawned: [0, 0], kills: [0, 0], lost: [0, 0], spent: [0, 0], captures: [0, 0], peak: [0, 0] },
  };
  if (layout) {
    for (const s of layout.spawns) addSpawn(game, s.center, s.owner, s.meter ?? params.meterMax, !!s.home);
    for (const w of layout.walls ?? []) game.terrain[w] = WALL;
  } else {
    generateLayout(game);
  }
  // Targets start just in front of each home.
  for (const s of game.spawns) {
    if (s.home && s.owner >= 0) game.targets[s.owner] = frontOf(game, s);
  }
  computeFlowFields(game);
  return game;
}

function emptyEvents() {
  return { kills: [], hits: [], captures: [], spawned: 0, consumed: 0 };
}

/** @param {Game} game @param {number} center @param {number} owner @param {number} meter @param {boolean} home */
function addSpawn(game, center, owner, meter, home) {
  const { grid } = game;
  const id = game.spawns.length;
  const cells = [center];
  for (let d = 0; d < 6; d++) cells.push(grid.nbr[center * 6 + d]);
  for (const c of cells) {
    if (c < 0) throw new Error('spawn blob off board');
    game.terrain[c] = SPAWN;
    game.spawnOf[c] = id;
  }
  /** @type {number[]} */
  const exits = [];
  for (const c of cells) {
    for (let d = 0; d < 6; d++) {
      const n = grid.nbr[c * 6 + d];
      if (n >= 0 && game.spawnOf[n] !== id && !exits.includes(n)) exits.push(n);
    }
  }
  exits.sort((a, b) => a - b);
  game.spawns.push({ id, center, cells, exits, owner, meter, home });
}

/** A cell a few steps out from a home spawn, toward the board centre. */
function frontOf(/** @type {Game} */ game, /** @type {Spawn} */ s) {
  const { grid } = game;
  const mid = (grid.H >> 1) * grid.W + (grid.W >> 1);
  const d = dirToward(grid, s.center, mid);
  let c = s.center;
  for (let k = 0; k < 4; k++) {
    const n = grid.nbr[c * 6 + d];
    if (n < 0) break;
    c = n;
  }
  return c;
}

/** @param {Game} game */
function generateLayout(game) {
  const { grid, params, rng } = game;
  const { W, H } = grid;
  // Homes at the two ends of the long axis. In portrait, blue is at the
  // bottom (nearest the player holding that end of the phone).
  const blueHome = W >= H
    ? ((H >> 1) - 1) * W + 3
    : (H - 4) * W + ((W >> 1) - 1);
  addSpawn(game, blueHome, BLUE, params.meterMax, true);
  addSpawn(game, mirror(grid, blueHome), RED, params.meterMax, true);

  const pairs = Math.ceil(params.neutralSpawns / 2);
  const margin = 3;
  let minSep = Math.max(6, Math.floor(Math.min(W, H) / 3));
  let placed = 0, tries = 0;
  while (placed < pairs && minSep >= 4) {
    if (++tries > 400) { minSep--; tries = 0; continue; }
    const col = margin + rng.int(W - 2 * margin);
    const row = margin + rng.int(H - 2 * margin);
    const c = row * W + col;
    const m = mirror(grid, c);
    if (hexDist(grid, c, m) < minSep) continue;
    if (game.spawns.some((s) => hexDist(grid, s.center, c) < minSep || hexDist(grid, s.center, m) < minSep)) continue;
    addSpawn(game, c, NEUTRAL, params.neutralMeter, false);
    addSpawn(game, m, NEUTRAL, params.neutralMeter, false);
    placed++;
  }

  if (params.terrain === 'rocks') generateRocks(game, 220);
  else if (params.terrain === 'dense') generateRocks(game, 100);
}

/**
 * Scatter mirrored rock clusters, keeping every spawn reachable. If a layout
 * cuts something off, retry with slightly fewer rocks.
 * @param {Game} game @param {number} cellsPerRock  board cells per rock cluster
 */
function generateRocks(game, cellsPerRock) {
  const { grid, rng } = game;
  const { W, H, N } = grid;
  for (let attempt = 0; attempt < 20; attempt++) {
    const walls = new Uint8Array(N);
    const clusters = Math.floor(((W * H) / cellsPerRock) * (1 - attempt * 0.04));
    for (let k = 0; k < clusters; k++) {
      // a short random walk makes an irregular rock
      let c = rng.int(N);
      const len = 3 + rng.int(9);
      for (let s = 0; s < len; s++) {
        if (game.spawns.every((sp) => hexDist(grid, sp.center, c) > 3)) {
          walls[c] = 1;
          walls[mirror(grid, c)] = 1;
        }
        const n = grid.nbr[c * 6 + rng.int(6)];
        if (n >= 0) c = n;
      }
    }
    // connectivity: every spawn's exits reachable from blue home's exits
    const seen = new Uint8Array(N);
    const queue = [game.spawns[0].exits[0]];
    seen[queue[0]] = 1;
    while (queue.length) {
      const u = /** @type {number} */ (queue.pop());
      for (let d = 0; d < 6; d++) {
        const v = grid.nbr[u * 6 + d];
        if (v >= 0 && !seen[v] && !walls[v] && game.terrain[v] === FREE) { seen[v] = 1; queue.push(v); }
      }
    }
    if (game.spawns.every((s) => s.exits.every((e) => seen[e]))) {
      for (let i = 0; i < N; i++) if (walls[i]) game.terrain[i] = WALL;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Queries

/** Does `dot` face the neighbour that lies in direction `dir` from it? */
export function faces(/** @type {Game} */ game, /** @type {Dot} */ dot, /** @type {number} */ dir) {
  const diff = dirDiff(dir, dot.facing);
  return game.params.facingArc >= 3 ? diff <= 1 : diff === 0;
}

/** Spawn id the player's target sits on, or -1. */
export function targetSpawn(/** @type {Game} */ game, /** @type {number} */ player) {
  return game.spawnOf[game.targets[player]];
}

/** @param {Game} game @param {number} player @param {number} cell */
export function setTarget(game, player, cell) {
  if (cell >= 0 && cell < game.grid.N) game.targets[player] = cell;
}

/** @param {Game} game @param {number} player @param {number} cell @param {number} facing */
export function placeDot(game, player, cell, facing) {
  if (game.occ[cell] || game.terrain[cell] !== FREE) return null;
  /** @type {Dot} */
  const dot = { id: game.nextId++, player, cell, facing, prevCell: cell, prevFacing: facing, locked: false, settled: false };
  game.dots.push(dot);
  game.occ[cell] = dot;
  game.dotCount[player]++;
  return dot;
}

// ---------------------------------------------------------------------------
// Tick

/** Advance the game by one tick. Returns the tick's events. */
export function step(/** @type {Game} */ game) {
  if (game.winner >= 0) return game.events;
  game.tick++;
  game.events = emptyEvents();
  computeFlowFields(game);   // phase 2 (phase 1, input, happens via setTarget)
  moveDots(game);            // phase 3
  resolveCombat(game);       // phase 4
  resolveSpawnAttacks(game); // phase 5
  regenMeters(game);
  emitDots(game);            // phase 6
  checkWin(game);            // phase 7
  for (let p = 0; p < 2; p++) game.stats.peak[p] = Math.max(game.stats.peak[p], game.dotCount[p]);
  return game.events;
}

/** Phase 2: BFS distance field from each player's target. */
function computeFlowFields(/** @type {Game} */ game) {
  const { grid, terrain } = game;
  const { N, nbr } = grid;
  const queue = new Int32Array(N);
  for (let p = 0; p < 2; p++) {
    const dist = game.dist[p];
    dist.fill(INF);
    let head = 0, tail = 0;
    const t = game.targets[p];
    const sp = game.spawnOf[t];
    const seeds = sp >= 0 ? game.spawns[sp].cells : [t];
    for (const s of seeds) { dist[s] = 0; queue[tail++] = s; }
    while (head < tail) {
      const u = queue[head++];
      const du = dist[u] + 1;
      for (let d = 0; d < 6; d++) {
        const v = nbr[u * 6 + d];
        if (v >= 0 && terrain[v] === FREE && dist[v] === INF) {
          dist[v] = du;
          queue[tail++] = v;
        }
      }
    }
  }
}

/** Phase 3. */
function moveDots(/** @type {Game} */ game) {
  const { grid, occ, terrain, rng, dots } = game;
  const nbr = grid.nbr;

  // Stalemates are judged on the board as it stands before anyone moves.
  for (const dot of dots) {
    dot.prevCell = dot.cell;
    dot.prevFacing = dot.facing;
    dot.locked = false;
    dot.settled = false;
    for (let d = 0; d < 6; d++) {
      const n = nbr[dot.cell * 6 + d];
      if (n < 0) continue;
      const e = occ[n];
      if (e && e.player !== dot.player && faces(game, dot, d) && faces(game, e, (d + 3) % 6)) {
        dot.locked = true;
        break;
      }
    }
  }

  // Dots closest to their own target move first, so columns flow as a unit.
  const keyed = dots.map((dot) => ({ dot, key: game.dist[dot.player][dot.cell] * 1024 + rng.int(1024) }));
  keyed.sort((a, b) => a.key - b.key);

  const tSpawn = [targetSpawn(game, BLUE), targetSpawn(game, RED)];
  const tCenter = tSpawn.map((ts, p) => (ts >= 0 ? game.spawns[ts].center : game.targets[p]));
  /** Squared straight-line distance to the player's target, in integer units. */
  const e2 = (/** @type {number} */ cell, /** @type {number} */ p) => {
    const dq = grid.q[cell] - grid.q[tCenter[p]], dr = grid.r[cell] - grid.r[tCenter[p]];
    return 3 * (2 * dq + dr) * (2 * dq + dr) + 9 * dr * dr;
  };

  for (const { dot } of keyed) {
    if (dot.locked) continue;
    const p = dot.player;
    const D = game.dist[p];
    const cur = D[dot.cell];
    let best = -1, bestDist = cur, bestDiff = 9, ties = 0;
    let closerExists = false, closerAllSettled = true, closerAllFriends = true;
    let enemyDir = -1, enemyDiff = 9; // nearest-to-facing enemy blocking the way
    for (let d = 0; d < 6; d++) {
      const n = nbr[dot.cell * 6 + d];
      if (n < 0 || terrain[n] !== FREE) continue;
      const dn = D[n];
      if (dn >= cur) continue;
      closerExists = true;
      const o = occ[n];
      if (o) {
        if (o.player !== p) {
          closerAllFriends = false;
          const ed = dirDiff(d, dot.facing);
          if (ed < enemyDiff) { enemyDiff = ed; enemyDir = d; }
        }
        if (o.player !== p || !o.settled) closerAllSettled = false;
        continue;
      }
      const diff = dirDiff(d, dot.facing);
      if (dn < bestDist || (dn === bestDist && diff < bestDiff)) {
        best = d; bestDist = dn; bestDiff = diff; ties = 1;
      } else if (dn === bestDist && diff === bestDiff) {
        ties++;
        if (rng.int(ties) === 0) best = d; // uniform among equal choices
      }
    }

    // Blocked by friends: sidestep around the ring (same path distance) if
    // that brings us nearer in a straight line. Crowds then spread round the
    // target instead of queueing back along the path. The straight-line
    // distance strictly falls with every sidestep, so dots can't oscillate.
    if (best < 0 && closerExists && closerAllFriends) {
      let bestE = e2(dot.cell, p);
      for (let d = 0; d < 6; d++) {
        const n = nbr[dot.cell * 6 + d];
        if (n < 0 || terrain[n] !== FREE || occ[n] || D[n] !== cur) continue;
        const en = e2(n, p);
        if (en < bestE) { bestE = en; best = d; }
      }
    }

    // Blocked by an enemy standing where we want to go: turn on it.
    if (best < 0 && enemyDir >= 0) {
      dot.facing = enemyDir;
      continue;
    }

    if (best >= 0) {
      const n = nbr[dot.cell * 6 + best];
      occ[dot.cell] = null;
      occ[n] = dot;
      dot.cell = n;
      dot.facing = best;
      continue;
    }

    // Can't advance. Next to the spawn we're targeting: face it (attack or
    // reinforce), unless it's our own and already full, in which case guard it.
    const ts = tSpawn[p];
    if (ts >= 0) {
      const s = game.spawns[ts];
      const wantsContact = s.owner !== p || s.meter < game.params.meterMax;
      let faceDir = -1, faceDiff = 9;
      for (let d = 0; d < 6; d++) {
        const n = nbr[dot.cell * 6 + d];
        if (n >= 0 && game.spawnOf[n] === ts) {
          const diff = dirDiff(d, dot.facing);
          if (diff < faceDiff) { faceDiff = diff; faceDir = d; }
        }
      }
      if (faceDir >= 0) {
        dot.facing = wantsContact ? faceDir : dirToward(grid, game.spawns[ts].center, dot.cell);
        dot.settled = true;
        continue;
      }
    }

    if (cur === 0) {
      dot.settled = true;
      faceHostileSpawn(game, dot);
      continue;
    }

    // Clustering: packed in behind friends that have already arrived, turn to
    // face away from the target. Because dots are processed nearest-first,
    // "settled" spreads outward from the target, so the group becomes an
    // outward-facing hedgehog, while a column held up by a fight up front
    // (whose leader is locked, not settled) keeps facing forward.
    if (cur < INF && closerExists && closerAllSettled) {
      dot.settled = true;
      // Settled against an enemy or neutral spawn: attack it instead.
      if (faceHostileSpawn(game, dot)) continue;
      const from = ts >= 0 ? game.spawns[ts].center : game.targets[p];
      const away = dirToward(grid, from, dot.cell);
      if (away >= 0) dot.facing = away;
    }
  }
}

/**
 * If the dot touches a spawn it doesn't own, turn to face it (choosing the
 * smallest turn) and return true.
 * @param {Game} game @param {Dot} dot
 */
function faceHostileSpawn(game, dot) {
  const nbr = game.grid.nbr;
  let faceDir = -1, faceDiff = 9;
  for (let d = 0; d < 6; d++) {
    const n = nbr[dot.cell * 6 + d];
    if (n < 0) continue;
    const sid = game.spawnOf[n];
    if (sid < 0 || game.spawns[sid].owner === dot.player) continue;
    const diff = dirDiff(d, dot.facing);
    if (diff < faceDiff) { faceDiff = diff; faceDir = d; }
  }
  if (faceDir < 0) return false;
  dot.facing = faceDir;
  return true;
}

/** Phase 4: judge every contact from one snapshot, then remove all losers together. */
function resolveCombat(/** @type {Game} */ game) {
  const { grid, occ, dots } = game;
  const nbr = grid.nbr;
  /** @type {Set<Dot>} */
  const dead = new Set();
  for (const a of dots) {
    for (let d = 0; d < 6; d++) {
      if (!faces(game, a, d)) continue;
      const n = nbr[a.cell * 6 + d];
      if (n < 0) continue;
      const b = occ[n];
      if (b && b.player !== a.player && !faces(game, b, (d + 3) % 6)) {
        if (!dead.has(b)) {
          game.events.kills.push({ cell: b.cell, victim: b.player, killerCell: a.cell });
          game.stats.kills[a.player]++;
          game.stats.lost[b.player]++;
        }
        dead.add(b);
      }
    }
  }
  if (dead.size) removeDots(game, dead);
}

/** @param {Game} game @param {Set<Dot>} gone */
function removeDots(game, gone) {
  for (const d of gone) {
    game.occ[d.cell] = null;
    game.dotCount[d.player]--;
  }
  game.dots = game.dots.filter((d) => !gone.has(d));
}

/**
 * Phase 5: dots throw themselves at a spawn they face if it's the one their
 * player is targeting (attack or reinforce), or if they've settled against
 * an enemy or neutral spawn (attack only). Dots merely passing by don't.
 */
function resolveSpawnAttacks(/** @type {Game} */ game) {
  const { grid, params } = game;
  const nbr = grid.nbr;
  /** @type {Map<number, Dot[][]>} spawn id → [blue dots, red dots] */
  const contacts = new Map();
  for (const dot of game.dots) {
    const ts = targetSpawn(game, dot.player);
    for (let d = 0; d < 6; d++) {
      if (!faces(game, dot, d)) continue;
      const n = nbr[dot.cell * 6 + d];
      if (n < 0) continue;
      const sid = game.spawnOf[n];
      if (sid < 0) continue;
      if (sid === ts || (dot.settled && game.spawns[sid].owner !== dot.player)) {
        let entry = contacts.get(sid);
        if (!entry) contacts.set(sid, (entry = [[], []]));
        entry[dot.player].push(dot);
        break;
      }
    }
  }
  if (!contacts.size) return;

  /** @type {Set<Dot>} */
  const used = new Set();
  for (const [sid, [blue, red]] of [...contacts.entries()].sort((a, b) => a[0] - b[0])) {
    const s = game.spawns[sid];
    const by = [blue, red];
    if (s.owner === NEUTRAL) {
      for (const d of blue) used.add(d);
      for (const d of red) used.add(d);
      if (blue.length) game.events.hits.push({ spawn: sid, player: BLUE, amount: blue.length });
      if (red.length) game.events.hits.push({ spawn: sid, player: RED, amount: red.length });
      const net = s.meter - blue.length - red.length;
      if (net > 0) s.meter = net;
      else if (blue.length !== red.length) {
        const to = blue.length > red.length ? BLUE : RED;
        game.events.captures.push({ spawn: sid, from: NEUTRAL, to });
        s.owner = to;
        s.meter = clamp(-net, 1, params.meterMax);
      } else s.meter = 0;
    } else {
      const o = s.owner, e = 1 - o;
      const attackers = by[e];
      const room = params.meterMax - s.meter + attackers.length;
      const reinforcers = by[o].slice(0, Math.max(0, room));
      for (const d of attackers) used.add(d);
      for (const d of reinforcers) used.add(d);
      if (attackers.length) game.events.hits.push({ spawn: sid, player: e, amount: attackers.length });
      if (reinforcers.length) game.events.hits.push({ spawn: sid, player: o, amount: reinforcers.length });
      const net = s.meter + reinforcers.length - attackers.length;
      if (net > 0) s.meter = Math.min(net, params.meterMax);
      else {
        game.events.captures.push({ spawn: sid, from: o, to: e });
        s.owner = e;
        s.meter = clamp(-net, 1, params.meterMax);
      }
    }
  }
  game.events.consumed = used.size;
  for (const d of used) game.stats.spent[d.player]++;
  for (const c of game.events.captures) game.stats.captures[c.to]++;
  removeDots(game, used);
}

function clamp(/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Owned spawns slowly recover. */
function regenMeters(/** @type {Game} */ game) {
  const { meterRegen, meterMax } = game.params;
  if (meterRegen <= 0 || game.tick % meterRegen !== 0) return;
  for (const s of game.spawns) if (s.owner >= 0 && s.meter < meterMax) s.meter++;
}

/** Phase 6: each owned spawn emits one dot at its free exit nearest the owner's target. */
function emitDots(/** @type {Game} */ game) {
  const { params, rng, grid } = game;
  if (game.tick % params.spawnInterval !== 0) return;
  for (const s of game.spawns) {
    if (s.owner < 0) continue;
    if (params.maxDotsPerPlayer > 0 && game.dotCount[s.owner] >= params.maxDotsPerPlayer) continue;
    const D = game.dist[s.owner];
    let best = -1, bestD = Infinity, ties = 0;
    for (const e of s.exits) {
      if (game.occ[e] || game.terrain[e] !== FREE) continue;
      if (D[e] < bestD) { best = e; bestD = D[e]; ties = 1; }
      else if (D[e] === bestD && rng.int(++ties) === 0) best = e;
    }
    if (best < 0) continue;
    const facing = dirToward(grid, s.center, best);
    const dot = placeDot(game, s.owner, best, facing);
    if (dot) { dot.prevCell = s.center; game.events.spawned++; game.stats.spawned[s.owner]++; }
  }
}

/** Phase 7. */
/**
 * Phase 7: a player with no spawns and no dots is eliminated. Neutral spawns
 * don't matter. A draw can't happen: owned spawns only ever change hands,
 * never go neutral, so someone always owns at least one.
 * @param {Game} game
 */
function checkWin(game) {
  for (let p = 0; p < 2; p++) {
    if (game.dotCount[p] === 0 && !game.spawns.some((s) => s.owner === p)) {
      game.winner = 1 - p;
      return;
    }
  }
}

/** A compact fingerprint of the game state, for determinism tests. */
export function stateHash(/** @type {Game} */ game) {
  let h = 2166136261 >>> 0;
  const mix = (/** @type {number} */ v) => { h = Math.imul(h ^ (v & 0xffff), 16777619) >>> 0; h = Math.imul(h ^ (v >>> 16), 16777619) >>> 0; };
  mix(game.tick);
  for (const d of game.dots) { mix(d.id); mix(d.player); mix(d.cell); mix(d.facing); }
  for (const s of game.spawns) { mix(s.owner + 1); mix(s.meter); }
  mix(game.rng.state());
  return h >>> 0;
}
