// @ts-check
// Star Troopers simulation core. Deterministic: integer state plus a seeded
// RNG, with no dependence on wall-clock time or Math.random. See RULES.md
// for the rules this implements; the phases in resolveTurn match "A turn".

import { createRng } from './rng.js';
import { createGrid, hexDist, reflect, rowOf, colOf, cellAt, linePairs } from './hex.js';

/** @typedef {import('./hex.js').Grid} Grid */
/** @typedef {import('./rng.js').Rng} Rng */

export const DRAW = 2;

/** Terrain types. */
export const OPEN = 0, BRUSH = 1, RUINS = 2, HIGH = 3, ROCK = 4, BUILDING = 5;
/** Cover by terrain type. Buildings are the best cover, as urban terrain was in the original. */
export const COVER = [0, 1, 2, 1, 0, 3];
/**
 * The original's terrain values, mapped onto ours: Clear 1 (open),
 * Broken/Crater 2 (ruins), Organic 3 (brush), Urban 6 (buildings). High
 * ground sits between broken ground and the original's mountains (6).
 */
export const COVER_ORIGINAL = [1, 3, 2, 3, 0, 6];

/** Cover value of a cell under the game's settings. */
export function coverValue(/** @type {Game} */ game, /** @type {number} */ cell) {
  const table = game.params.cover === 'original' ? COVER_ORIGINAL : COVER;
  return table[game.terrain[cell]] * game.params.coverScale;
}

/** Does a cell give more cover than open ground? */
export function isCover(/** @type {Game} */ game, /** @type {number} */ cell) {
  const table = game.params.cover === 'original' ? COVER_ORIGINAL : COVER;
  return table[game.terrain[cell]] > table[OPEN];
}

/**
 * The factions. Pool, Aim and Recovery are StarSoldier's own numbers for
 * the species each one pays homage to (see RULES.md); never tune these.
 */
export const FACTIONS = /** @type {const} */ ({
  compact: { name: 'Compact', pool: 9, aim: 2, recovery: 3 },
  orrin: { name: 'Orrin', pool: 12, aim: 2, recovery: 1 },
  vell: { name: 'Vell', pool: 6, aim: 4, recovery: 2 },
});

/** @typedef {keyof typeof FACTIONS} FactionKey */

/** A trooper's value: pool + Aim + Recovery (List's Specific Tactical Value). */
export function factionValue(/** @type {FactionKey} */ f) {
  const x = FACTIONS[f];
  return x.pool + x.aim + x.recovery;
}

export const DEFAULTS = {
  width: 13,
  height: 19,
  terrain: 'some',          // 'open' | 'some' | 'dense'
  scenario: 'meeting',      // 'meeting' | 'assault'
  faction0: 'compact',      // side 0 starts at the bottom
  faction1: 'compact',      // side 1 starts at the top
  attacker: 0,              // Assault: which side attacks
  squad: 4,
  rangeStep: 2,
  motionStep: 2,
  cover: 'draft',           // tuning knob: 'draft' or 'original' (the 1977 game's terrain values)
  coverScale: 1,            // tuning knob: multiplies every cover value
  damageDivisor: 3,
  stages: 2,                // stages per game-turn: 2 as in the original's Standard Game, or 1
  stageCap: 6,              // most points a trooper spends in one stage (two-stage turns)
  maxShot: 0,               // tuning knob: most points in one shot, 0 = no cap
  maxSpend: 0,              // tuning knob: most points one trooper spends in a game-turn, 0 = no cap
  overwatchRange: 6,
  surplusPct: 120,
  holdToWin: 2,
  turnLimit: 12,
  hexTerrain: 'building',   // what victory hexes stand on: 'building' | 'ruins' | 'brush' | 'open'
  noise: 0,
  dodgeAimCap: 0,           // tuning knob: dodge counts at most this much per point (0 = full Aim)
  recoverWhenHit: 0,        // tuning knob: 1 = troopers recover even when hit (the original: only if not hit)
  seed: 1,
};

/** @typedef {typeof DEFAULTS} Params */

/**
 * @typedef {Object} Trooper
 * @property {number} id
 * @property {number} side      0 or 1
 * @property {FactionKey} faction
 * @property {number} pool
 * @property {number} aim
 * @property {number} recovery
 * @property {number} cell
 * @property {number} shock
 * @property {boolean} down
 * @property {boolean} dugIn    Assault defenders until they leave their zone
 * @property {number} spent    points already spent this game-turn (in its first stage)
 */

/**
 * One trooper's orders for a turn. Missing orders mean "do nothing".
 * @typedef {Object} Order
 * @property {number[]} path    cells to step through, not including the start
 * @property {number} target    id of the trooper to shoot, or -1
 * @property {number} fire      points in the shot
 * @property {number} dodge
 * @property {number} overwatch
 */

/**
 * @typedef {Object} Shot
 * @property {'fire'|'overwatch'} kind
 * @property {number} from       trooper id
 * @property {number} to         trooper id
 * @property {number} attack
 * @property {number} defence
 * @property {number} shock      0 on a miss
 * @property {boolean} miss      attack < defence
 * @property {number} shockBefore  target's shock at the start of the turn
 * @property {number} step       movement step for overwatch, -1 for fire
 */

/**
 * What happened in a turn, for playback and stats.
 * @typedef {Object} TurnEvents
 * @property {number} turn
 * @property {number} stage    1 or 2 (always 1 with one-stage turns)
 * @property {Shot[]} shots
 * @property {{id: number, from: number, to: number}[][]} steps
 * @property {{id: number, step: number}[]} blocked
 * @property {number[]} pinned
 * @property {{id: number, step: number}[]} downs   step -1 = fire phase
 * @property {{id: number, amount: number}[]} recovered
 * @property {{cell: number, from: number, to: number}[]} captures
 */

/**
 * @typedef {Object} Victory
 * @property {number} cell
 * @property {number} owner  0, 1 or -1 (neutral)
 */

/**
 * @typedef {Object} Game
 * @property {Params} params
 * @property {Grid} grid
 * @property {Rng} rng
 * @property {Uint8Array} terrain
 * @property {Trooper[]} troopers   indexed by id; downed troopers stay in the list
 * @property {Victory[]} victory
 * @property {number} turn          the game-turn being played, from 1
 * @property {number} stage         the stage about to be played: 1, or 2 with two-stage turns
 * @property {number} winner        -1 while playing, 0, 1 or DRAW
 * @property {number} defender      Assault: the defending side, else -1
 * @property {TurnEvents|null} last
 */

/**
 * Explicit layout, for tests and hand-made maps. Terrain defaults to open.
 * @typedef {Object} Layout
 * @property {[number, number][]} [terrain]   [cell, type] pairs
 * @property {{side: number, cell: number, faction?: FactionKey, shock?: number, dugIn?: boolean}[]} troopers
 * @property {Victory[]} [victory]
 */

/**
 * @param {Partial<Params>} [overrides]
 * @param {Layout} [layout]
 * @returns {Game}
 */
export function createGame(overrides = {}, layout) {
  /** @type {Params} */
  const params = { ...DEFAULTS, ...overrides };
  if (!(params.faction0 in FACTIONS) || !(params.faction1 in FACTIONS)) {
    throw new Error(`unknown faction: ${params.faction0} / ${params.faction1}`);
  }
  params.height |= 1; // odd, so the centre row is the mirror line
  const grid = createGrid(params.width, params.height);
  /** @type {Game} */
  const game = {
    params, grid,
    rng: createRng(params.seed),
    terrain: new Uint8Array(grid.N),
    troopers: [],
    victory: [],
    turn: 1,
    stage: 1,
    winner: -1,
    defender: params.scenario === 'assault' ? 1 - params.attacker : -1,
    last: null,
  };
  if (layout) {
    for (const [cell, type] of layout.terrain ?? []) game.terrain[cell] = type;
    for (const t of layout.troopers) {
      const tr = addTrooper(game, t.side, t.faction ?? sideFaction(game, t.side), t.cell);
      tr.shock = t.shock ?? 0;
      tr.dugIn = t.dugIn ?? false;
    }
    game.victory = (layout.victory ?? []).map((v) => ({ ...v }));
  } else {
    generate(game);
  }
  return game;
}

/** @returns {FactionKey} */
function sideFaction(/** @type {Game} */ game, /** @type {number} */ side) {
  return /** @type {FactionKey} */ (side === 0 ? game.params.faction0 : game.params.faction1);
}

/**
 * @param {Game} game @param {number} side @param {FactionKey} faction @param {number} cell
 */
function addTrooper(game, side, faction, cell) {
  const f = FACTIONS[faction];
  /** @type {Trooper} */
  const t = {
    id: game.troopers.length, side, faction,
    pool: f.pool, aim: f.aim, recovery: f.recovery,
    cell, shock: 0, down: false, dugIn: false, spent: 0,
  };
  game.troopers.push(t);
  return t;
}

/** Is a cell in a side's deployment zone (the three rows along its edge)? */
export function inZone(/** @type {Game} */ game, /** @type {number} */ side, /** @type {number} */ cell) {
  const row = rowOf(game.grid, cell);
  return side === 0 ? row >= game.grid.H - 3 : row <= 2;
}

/** How many troopers each side fields. */
export function squadSizes(/** @type {Params} */ p) {
  if (p.scenario !== 'assault') return [p.squad, p.squad];
  const att = p.attacker, def = 1 - att;
  const fa = /** @type {FactionKey} */ (att === 0 ? p.faction0 : p.faction1);
  const fd = /** @type {FactionKey} */ (def === 0 ? p.faction0 : p.faction1);
  // fewest attackers whose total value is at least surplusPct% of the defender's
  const need = p.surplusPct * p.squad * factionValue(fd);
  const per = 100 * factionValue(fa);
  const n = Math.floor((need + per - 1) / per);
  const sizes = [0, 0];
  sizes[att] = n;
  sizes[def] = p.squad;
  return sizes;
}

// ---- Map generation ----

/** @param {Game} game */
function generate(game) {
  const { grid, params } = game;
  const mid = (grid.H - 1) >> 1;
  const counts = { open: 3, some: 11, dense: 16 };
  const features = counts[/** @type {keyof typeof counts} */ (params.terrain)] ?? 7;
  const vcols = [Math.round((grid.W - 1) / 6), (grid.W - 1) >> 1, grid.W - 1 - Math.round((grid.W - 1) / 6)];
  const vrow = params.scenario === 'assault'
    ? (game.defender === 1 ? 4 : grid.H - 5)
    : mid;
  const vcells = vcols.map((c) => cellAt(grid, c, vrow));

  for (let attempt = 0; attempt < 30; attempt++) {
    game.terrain.fill(OPEN);
    // Features are grown in the top half (centre row included) and then
    // mirrored, so the whole map is symmetric top-to-bottom.
    for (let f = 0; f < features; f++) {
      const roll = game.rng.int(20);
      const type = roll < 8 ? BRUSH : roll < 14 ? RUINS : roll < 17 ? HIGH : ROCK;
      const size = 2 + game.rng.int(4);
      let cell = cellAt(grid, game.rng.int(grid.W), 3 + game.rng.int(mid - 2));
      for (let k = 0; k < size; k++) {
        const row = rowOf(grid, cell);
        if (row >= 3 && row <= mid) game.terrain[cell] = type;
        const next = grid.nbr[cell * 6 + game.rng.int(6)];
        if (next >= 0) cell = next;
      }
    }
    for (let i = 0; i < grid.N; i++) {
      if (rowOf(grid, i) > mid) game.terrain[i] = game.terrain[reflect(grid, i)];
    }
    const ht = { open: OPEN, brush: BRUSH, ruins: RUINS, building: BUILDING }[/** @type {'open'|'brush'|'ruins'|'building'} */ (params.hexTerrain)] ?? BUILDING;
    for (const v of vcells) game.terrain[v] = ht;
    if (connected(game, vcells)) break;
    if (attempt === 29) for (let i = 0; i < grid.N; i++) if (game.terrain[i] === ROCK) game.terrain[i] = OPEN;
  }

  game.victory = vcells.map((cell) => ({ cell, owner: game.defender }));

  const sizes = squadSizes(params);
  for (const side of [0, 1]) {
    const row = side === 0 ? grid.H - 3 : 2;
    const n = sizes[side];
    for (let k = 0; k < n; k++) {
      const col = Math.min(grid.W - 1, Math.floor(((2 * k + 1) * grid.W) / (2 * n)));
      const t = addTrooper(game, side, sideFaction(game, side), cellAt(grid, col, row));
      t.dugIn = side === game.defender;
    }
  }
}

/** Can every victory hex and both deployment zones reach each other? */
function connected(/** @type {Game} */ game, /** @type {number[]} */ vcells) {
  const { grid } = game;
  const start = cellAt(grid, grid.W >> 1, grid.H - 1);
  const seen = new Uint8Array(grid.N);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const c = /** @type {number} */ (queue.pop());
    for (let d = 0; d < 6; d++) {
      const n = grid.nbr[c * 6 + d];
      if (n >= 0 && !seen[n] && game.terrain[n] !== ROCK) { seen[n] = 1; queue.push(n); }
    }
  }
  for (const v of vcells) if (!seen[v]) return false;
  for (let col = 0; col < grid.W; col++) {
    if (!seen[cellAt(grid, col, 0)] || !seen[cellAt(grid, col, 2)]) return false;
  }
  return true;
}

// ---- Queries ----

/** Usable task points this turn. */
export function usable(/** @type {Trooper} */ t) {
  return t.pool - t.shock;
}

/**
 * Points a trooper can spend in the stage being plotted. With two-stage
 * turns (the original's rules 15.21-15.24), that's its usable points less
 * whatever it spent in the first stage, and never more than six in one
 * stage. Points it can't spend still count towards staying power, since
 * shock comes out of the pool.
 * @param {Game} game @param {Trooper} t
 */
export function spendable(game, t) {
  const p = game.params;
  const two = p.stages === 2;
  let room = usable(t) - (two ? t.spent : 0);
  if (two) room = Math.min(room, p.stageCap);
  if (p.maxSpend > 0) room = Math.min(room, p.maxSpend - (two ? t.spent : 0));
  return Math.max(0, room);
}

/** Troopers still in the game. */
export function living(/** @type {Game} */ game, side = -1) {
  return game.troopers.filter((t) => !t.down && (side < 0 || t.side === side));
}

/** The living trooper in a cell, or null. */
export function occupant(/** @type {Game} */ game, /** @type {number} */ cell) {
  for (const t of game.troopers) if (!t.down && t.cell === cell) return t;
  return null;
}

/** Cost to step from one cell into a neighbouring one (Infinity for rock). */
export function enterCost(/** @type {Game} */ game, /** @type {number} */ from, /** @type {number} */ to) {
  const t = game.terrain[to];
  if (t === ROCK) return Infinity;
  if (t === HIGH) return game.terrain[from] === HIGH ? 1 : 2;
  return t === OPEN ? 1 : 2; // brush, ruins and buildings
}

/** Total cost of a path starting from `start`; Infinity if it's not a legal path. */
export function pathCost(/** @type {Game} */ game, /** @type {number} */ start, /** @type {number[]} */ path) {
  let cost = 0, at = start;
  for (const c of path) {
    if (c < 0 || c >= game.grid.N || !isNeighbour(game, at, c)) return Infinity;
    cost += enterCost(game, at, c);
    at = c;
  }
  return cost;
}

function isNeighbour(/** @type {Game} */ game, /** @type {number} */ a, /** @type {number} */ b) {
  for (let d = 0; d < 6; d++) if (game.grid.nbr[a * 6 + d] === b) return true;
  return false;
}

/** Line of sight between two cells (see RULES.md, "Line of sight"). */
export function los(/** @type {Game} */ game, /** @type {number} */ a, /** @type {number} */ b) {
  const high = game.terrain[a] === HIGH || game.terrain[b] === HIGH;
  /** @param {number} c */
  const blocks = (c) => c >= 0 && (game.terrain[c] === ROCK || game.terrain[c] === BUILDING || (game.terrain[c] === RUINS && !high));
  const pairs = linePairs(game.grid, a, b);
  for (let i = 1; i < pairs.length - 1; i++) {
    const [c1, c2] = pairs[i];
    if (c1 === c2 ? blocks(c1) : blocks(c1) && blocks(c2)) return false;
  }
  return true;
}

/**
 * Defence of `target` against a shot from `fromCell`, given its orders.
 * @param {Game} game @param {Trooper} target @param {number} fromCell
 * @param {Order|undefined|null} order  the target's orders this turn
 */
export function defenceOf(game, target, fromCell, order) {
  const p = game.params;
  return coverValue(game, target.cell)
    + Math.floor(hexDist(game.grid, fromCell, target.cell) / p.rangeStep)
    + Math.floor((order?.path.length ?? 0) / p.motionStep)
    + (order?.dodge ?? 0) * (p.dodgeAimCap > 0 ? Math.min(target.aim, p.dodgeAimCap) : target.aim)
    + (target.dugIn ? 1 : 0);
}

/** Shock from a shot before noise; -1 means a miss. */
export function baseShock(/** @type {Params} */ p, /** @type {number} */ attack, /** @type {number} */ defence) {
  return attack < defence ? -1 : Math.floor((attack - defence) / p.damageDivisor);
}

/**
 * The preview from RULES.md: shock if the target neither dodges nor moves,
 * and the dodge points that would cancel the shot completely.
 * @param {Game} game @param {Trooper} shooter @param {Trooper} target @param {number} points
 */
export function preview(game, shooter, target, points) {
  const attack = points * shooter.aim;
  const still = defenceOf(game, target, shooter.cell, null);
  const shock = Math.max(0, baseShock(game.params, attack, still));
  const cancel = attack < still ? 0 : Math.floor((attack - still) / target.aim) + 1;
  return { attack, defence: still, shock, cancel };
}

// ---- Orders ----

/**
 * Checks one trooper's orders. Returns null if they're legal, otherwise
 * a reason.
 * @param {Game} game @param {Trooper} t @param {Order} o
 */
export function checkOrder(game, t, o) {
  if (t.down) return 'trooper is down';
  for (const k of /** @type {const} */ (['fire', 'dodge', 'overwatch'])) {
    if (!Number.isInteger(o[k]) || o[k] < 0) return `bad ${k}`;
  }
  const move = pathCost(game, t.cell, o.path);
  if (move === Infinity) return 'illegal path';
  if (move + o.fire + o.dodge + o.overwatch > spendable(game, t)) return 'not enough points';
  if (o.fire > 0) {
    const target = game.troopers[o.target];
    if (!target || target.down || target.side === t.side) return 'bad target';
    if (!los(game, t.cell, target.cell)) return 'no line of sight';
    if (game.params.maxShot > 0 && o.fire > game.params.maxShot) return 'shot too big';
  }
  return null;
}

/** An order that does nothing. */
export function idle() {
  return { path: [], target: -1, fire: 0, dodge: 0, overwatch: 0 };
}

// ---- The turn ----

/**
 * Plays one turn from both sides' orders, indexed by trooper id. Throws on
 * illegal orders: callers check them first.
 * @param {Game} game
 * @param {(Order|null|undefined)[]} orders
 * @returns {TurnEvents}
 */
export function resolveTurn(game, orders) {
  if (game.winner >= 0) throw new Error('game is over');
  const p = game.params;
  /** @type {Order[]} */
  const ord = game.troopers.map((t) => orders[t.id] ?? idle());
  for (const t of living(game)) {
    const why = checkOrder(game, t, ord[t.id]);
    if (why) throw new Error(`trooper ${t.id}: ${why}`);
  }
  /** @type {TurnEvents} */
  const ev = { turn: game.turn, stage: game.stage, shots: [], steps: [], blocked: [], pinned: [], downs: [], recovered: [], captures: [] };
  for (const t of living(game)) {
    const o = ord[t.id];
    t.spent += pathCost(game, t.cell, o.path) + o.fire + o.dodge + o.overwatch;
  }
  const shockBefore = game.troopers.map((t) => t.shock);
  const hit = new Uint8Array(game.troopers.length);

  /**
   * @param {'fire'|'overwatch'} kind @param {Trooper} from @param {Trooper} to
   * @param {number} points @param {number} step @param {number[]} pending
   */
  const shoot = (kind, from, to, points, step, pending) => {
    const attack = points * from.aim;
    const defence = defenceOf(game, to, from.cell, ord[to.id]);
    let shock = baseShock(p, attack, defence);
    const miss = shock < 0;
    if (miss) shock = 0;
    else if (p.noise > 0) shock = Math.max(0, shock + [-1, 0, 0, 1][game.rng.int(4)] * p.noise);
    pending[to.id] += shock;
    ev.shots.push({ kind, from: from.id, to: to.id, attack, defence, shock, miss, shockBefore: shockBefore[to.id], step });
  };

  /** @param {number[]} pending @param {number} step */
  const applyShock = (pending, step) => {
    for (const t of game.troopers) {
      if (pending[t.id] <= 0 || t.down) continue;
      t.shock += pending[t.id];
      hit[t.id] = 1;
      if (t.shock >= t.pool) {
        t.shock = t.pool;
        t.down = true;
        ev.downs.push({ id: t.id, step });
      }
    }
  };

  // 2. Fire: everyone shoots from where they started, all at once.
  {
    const pending = game.troopers.map(() => 0);
    for (const t of living(game)) {
      const o = ord[t.id];
      if (o.fire > 0) shoot('fire', t, game.troopers[o.target], o.fire, -1, pending);
    }
    applyShock(pending, -1);
  }

  // 3. Move: one cell per step, all at once, with overwatch after each step.
  {
    const stopped = new Uint8Array(game.troopers.length);
    const watched = new Uint8Array(game.troopers.length); // overwatch already fired
    const longest = Math.max(0, ...living(game).map((t) => ord[t.id].path.length));
    for (let s = 0; s < longest; s++) {
      /** @type {Map<number, number>} trooper id -> cell it wants */
      const want = new Map();
      for (const t of living(game)) {
        if (!stopped[t.id] && ord[t.id].path.length > s) want.set(t.id, ord[t.id].path[s]);
      }
      // Knock out blocked moves until nothing changes: two movers into one
      // cell, a swap, or a cell held by someone who isn't leaving it.
      let changed = true;
      while (changed) {
        changed = false;
        /** @type {Map<number, number>} */
        const claims = new Map();
        for (const cell of want.values()) claims.set(cell, (claims.get(cell) ?? 0) + 1);
        for (const [id, cell] of want) {
          const occ = occupant(game, cell);
          const contested = /** @type {number} */ (claims.get(cell)) > 1;
          const heldStill = occ !== null && !want.has(occ.id);
          const swap = occ !== null && want.get(occ.id) === game.troopers[id].cell;
          if (contested || heldStill || swap) {
            want.delete(id);
            stopped[id] = 1;
            ev.blocked.push({ id, step: s });
            changed = true;
          }
        }
      }
      /** @type {{id: number, from: number, to: number}[]} */
      const moves = [];
      for (const [id, cell] of want) {
        const t = game.troopers[id];
        moves.push({ id, from: t.cell, to: cell });
        t.cell = cell;
        if (t.dugIn && !inZone(game, t.side, cell)) t.dugIn = false;
      }
      ev.steps.push(moves);

      // Overwatch: shoot the nearest enemy that moved this step, in sight
      // and in range. Each trooper's overwatch fires once per turn.
      const pending = game.troopers.map(() => 0);
      for (const w of living(game)) {
        if (ord[w.id].overwatch <= 0 || watched[w.id]) continue;
        let best = null, bestD = Infinity;
        for (const m of moves) {
          const e = game.troopers[m.id];
          if (e.side === w.side) continue;
          const d = hexDist(game.grid, w.cell, e.cell);
          if (d > p.overwatchRange || d >= bestD || !los(game, w.cell, e.cell)) continue;
          best = e; bestD = d;
        }
        if (best) {
          watched[w.id] = 1;
          shoot('overwatch', w, best, ord[w.id].overwatch, s, pending);
        }
      }
      for (const t of game.troopers) {
        if (pending[t.id] > 0 && !t.down) { stopped[t.id] = 1; ev.pinned.push(t.id); }
      }
      applyShock(pending, s);
    }
  }

  // 4. Recovery: troopers that weren't hit shake off some shock.
  for (const t of living(game)) {
    if ((hit[t.id] && !p.recoverWhenHit) || t.shock === 0) continue;
    const amount = Math.min(t.shock, t.recovery);
    t.shock -= amount;
    ev.recovered.push({ id: t.id, amount });
  }

  // 5. Control: a victory hex goes to the side on it, unless an enemy is next to it.
  for (const v of game.victory) {
    const occ = occupant(game, v.cell);
    if (!occ) continue;
    let contested = false;
    for (let d = 0; d < 6; d++) {
      const n = game.grid.nbr[v.cell * 6 + d];
      const o = n >= 0 ? occupant(game, n) : null;
      if (o && o.side !== occ.side) contested = true;
    }
    if (!contested && v.owner !== occ.side) {
      ev.captures.push({ cell: v.cell, from: v.owner, to: occ.side });
      v.owner = occ.side;
    }
  }

  // 6. Win check.
  game.winner = winCheck(game);
  game.last = ev;
  if (game.winner < 0) {
    if (p.stages === 2 && game.stage === 1) {
      game.stage = 2;
    } else {
      game.stage = 1;
      game.turn++;
      for (const t of game.troopers) t.spent = 0;
    }
  }
  return ev;
}

/** Victory hexes held by a side. */
export function held(/** @type {Game} */ game, /** @type {number} */ side) {
  return game.victory.filter((v) => v.owner === side).length;
}

/** @param {Game} game */
function winCheck(game) {
  const p = game.params;
  // The turn limit counts whole game-turns, so it only bites after the last stage.
  const atLimit = game.turn >= p.turnLimit && (p.stages !== 2 || game.stage === 2);
  const a0 = living(game, 0).length, a1 = living(game, 1).length;
  if (a0 === 0 && a1 === 0) return DRAW;
  if (a0 === 0) return 1;
  if (a1 === 0) return 0;
  const h0 = held(game, 0), h1 = held(game, 1);
  if (p.scenario === 'assault') {
    const att = p.attacker;
    if (held(game, att) >= p.holdToWin) return att;
    if (atLimit) return 1 - att;
    return -1;
  }
  const n = game.victory.length;
  if (n > 0 && h0 === n) return 0;
  if (n > 0 && h1 === n) return 1;
  if (atLimit) return h0 > h1 ? 0 : h1 > h0 ? 1 : DRAW;
  return -1;
}

/** Hash of the whole game state, for determinism tests. */
export function stateHash(/** @type {Game} */ game) {
  let h = 2166136261 >>> 0;
  /** @param {number} x */
  const mix = (x) => { h = Math.imul(h ^ (x & 0xffff), 16777619) >>> 0; h = Math.imul(h ^ (x >>> 16), 16777619) >>> 0; };
  mix(game.turn); mix(game.stage); mix(game.winner + 1); mix(game.rng.state());
  for (const t of game.troopers) { mix(t.cell); mix(t.shock); mix(t.down ? 1 : 0); mix(t.dugIn ? 1 : 0); mix(t.spent); }
  for (const v of game.victory) { mix(v.cell); mix(v.owner + 1); }
  for (let i = 0; i < game.terrain.length; i++) mix(game.terrain[i]);
  return h;
}

export { colOf, rowOf, cellAt };
