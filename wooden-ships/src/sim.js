// @ts-check
// Wooden Ships simulation: ships, wind, cannon balls and the sea.
//
// Deterministic: same params + same inputs = same game on every browser.
// State is in floats, but the sim only uses + − × ÷, sqrt, abs, min, max and
// Math.round, which IEEE 754 defines exactly. Headings are integers (TURN to
// a full turn, 0 = east, clockwise because screen y points down), sines come
// from a table built here with + and × only, and angles of attack come from
// dot and cross products, never from atan2. Randomness is the seeded RNG.
//
// Units: metres, and metres per *game* second for ship and wind velocities.
// One tick is 1/tickRate real seconds and timeScale/tickRate game seconds.
// Gunnery, turning and reloads are set in real seconds (see RULES.md, Scale).

import { createRng } from './rng.js';

export const TURN = 65536;
const QUARTER = TURN / 4;
const HALF = TURN / 2;
const MASK = TURN - 1;
const PI = 3.141592653589793;
/** Metres per second in one knot. */
export const KTS = 0.514444;

// sin over a quarter turn, by Taylor series with + and × only (exact in IEEE
// 754, so every engine builds the same table). The x^19 error term is < 1e-15.
const SIN_Q = new Float64Array(QUARTER + 1);
for (let k = 1; k < QUARTER; k++) {
  const x = (k / QUARTER) * (PI / 2);
  const x2 = x * x;
  let s = 1;
  for (const d of [272, 210, 156, 110, 72, 42, 20, 6]) s = 1 - (x2 / d) * s;
  SIN_Q[k] = x * s;
}
SIN_Q[QUARTER] = 1;

/** @param {number} a heading units */
export function isin(a) {
  a &= MASK;
  const r = a & (QUARTER - 1);
  switch (a >> 14) {
    case 0: return SIN_Q[r];
    case 1: return SIN_Q[QUARTER - r];
    case 2: return -SIN_Q[r];
    default: return -SIN_Q[QUARTER - r];
  }
}
/** @param {number} a heading units */
export const icos = (a) => isin(a + QUARTER);
/** Degrees to heading units. @param {number} d */
export const deg = (d) => Math.round((d * TURN) / 360);
/** Heading units to degrees (presentation only). @param {number} a */
export const toDeg = (a) => ((a & MASK) * 360) / TURN;
/** Heading units to radians (presentation only). @param {number} a */
export const toRad = (a) => ((a & MASK) * 2 * PI) / TURN;
/** Signed difference b − a, in [−HALF, HALF). @param {number} a @param {number} b */
export const angleDiff = (a, b) => ((b - a + HALF) & MASK) - HALF;

/**
 * Heading of the vector (x, y), rounded down to a heading unit. Binary search
 * on the sine table, so it's as deterministic as the rest of the sim.
 * @param {number} x @param {number} y
 */
export function angleOf(x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  const mn = Math.min(ax, ay), mx = Math.max(ax, ay);
  if (mx === 0) return 0;
  let lo = 0, hi = TURN / 8;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (SIN_Q[mid] * mx <= SIN_Q[QUARTER - mid] * mn) lo = mid; else hi = mid - 1;
  }
  let t = lo;
  if (ay > ax) t = QUARTER - t;
  if (x < 0) t = HALF - t;
  if (y < 0) t = TURN - t;
  return t & MASK;
}

// ---------------------------------------------------------------------------
// Parameters

/**
 * Ship types are data, so a campaign can add more. Coefficients follow
 * RULES.md, Sailing. `mass` divides every force: it sets how quickly a ship
 * gathers way and loses it, without changing her top speeds.
 */
export const SHIP_TYPES = {
  frigate: {
    length: 40, beam: 12, mass: 6,
    lift: 1.0, drag: 1.0, bowDrag: 0.05, keelDrag: 1.0, windage: 0.02,
    /** degrees per real second at full rudder and full steering speed */
    turnRate: 40,
    /** knots: forward speed at which the rudder is fully effective */
    steerSpeed: 3,
    gunsPerSide: 4,
    /** metres of hull the guns are spread along */
    gunSpan: 30,
  },
};
/** @typedef {typeof SHIP_TYPES.frigate} ShipType */

/** Wind presets: seconds between shifts (0 = never) and the biggest shift. */
export const WIND_PRESETS = {
  steady: { min: 0, max: 0, angle: 0, speed: 0 },
  shifty: { min: 20, max: 40, angle: 30, speed: 4 },
  gusty: { min: 10, max: 20, angle: 45, speed: 6 },
};

export const DEFAULTS = {
  seed: 1,
  tickRate: 30,
  /** game seconds per real second */
  timeScale: 4,
  /** metres per terrain tile */
  tile: 22,
  /** sea size in tiles: 136 × 22 m is about 3 km, 75 ship lengths. The same on every screen. */
  width: 136,
  height: 136,
  /** 'none' | 'some' | 'many' */
  islands: 'some',
  /** island blobs (each with its mirror image) per 1,000 tiles of sea, for 'some' and 'many' */
  islandsSome: 0.8,
  islandsMany: 1.6,
  /** a key of WIND_PRESETS */
  wind: 'shifty',
  /** knots */
  windMin: 8,
  windMax: 20,
  /** real seconds over which a shift eases in */
  shiftEase: 5,
  shadow: true,
  /** metres downwind of a ship that its shadow reaches */
  shadowRange: 160,
  /** full width of the shadow cone, degrees */
  shadowCone: 30,
  shadowFactor: 0.5,
  /** hull drags are multiplied by this in shallows */
  shallowsDrag: 3,
  crewPerGun: 3,
  /** metres per real second, relative to the firing ship */
  muzzleSpeed: 150,
  /** metres a ball flies before it splashes */
  gunRange: 300,
  /** degrees of random error either way, per ball */
  spread: 3,
  /** real seconds per side */
  reload: 5,
  /** degrees each gun can swing forward or aft of square */
  traverse: 20,
  /** real seconds between guns in a ripple */
  ripple: 0.1,
  /** real seconds the sea stays quiet (no ball in the air, no gun firing) before a finished fight is over */
  endDelay: 3,
  /** metres between the two ships at the start */
  startGap: 700,
  /** metres each ship starts to one side of the centre line, so they pass rather than collide */
  startOffset: 60,
  /** metres per game second of way on at the start */
  startSpeed: 3,
  /** metres per game second a ship is pushed off land, the edge or another ship */
  bounce: 1,
};
/** @typedef {typeof DEFAULTS} Params */

export const DEEP = 0, SHALLOW = 1, LAND = 2;
export const BLUE = 0, RED = 1;
/** game.winner when every ship has struck */
export const DRAW = 2;
export const PORT = 0, STARBOARD = 1;

/**
 * @typedef {{ side: number, firing: number, fireAt: number, reloadLeft: number }} Battery
 *   side: −1 port, +1 starboard. firing: guns still to fire in this ripple.
 * @typedef {{
 *   id: number, side: number, type: ShipType,
 *   x: number, y: number, vx: number, vy: number, heading: number,
 *   rudder: number, crew: number, maxCrew: number, struck: boolean,
 *   batteries: Battery[], shadowed: boolean, terrain: number,
 * }} Ship
 *   rudder: −100 (hard to port) … +100 (hard to starboard)
 * @typedef {{ x: number, y: number, vx: number, vy: number, life: number, owner: number }} Ball
 * @typedef {{
 *   dir: number, speed: number, fromDir: number, fromSpeed: number,
 *   toDir: number, toSpeed: number, ease: number, next: number,
 * }} Wind
 *   dir: where it blows FROM, heading units. speed: knots.
 * @typedef {{
 *   params: Params, rng: import('./rng.js').Rng, tick: number,
 *   W: number, H: number, seaW: number, seaH: number,
 *   corners: Uint8Array, wind: Wind,
 *   ships: Ship[], balls: Ball[], winner: number,
 *   ending: number, quiet: number,
 *   stats: { fired: number[], hits: number[] },
 * }} Game
 * @typedef {{
 *   fired: {ship: number, x: number, y: number, dx: number, dy: number}[],
 *   hits: {ship: number, by: number, x: number, y: number}[],
 *   splashes: {x: number, y: number, land: boolean}[],
 *   struck: number[], bumps: {ship: number, x: number, y: number}[],
 *   shift: boolean,
 * }} Events
 * @typedef {{ type: 'rudder', value: number } | { type: 'fire', battery: number }} Input
 */

// ---------------------------------------------------------------------------
// Setup

/**
 * @param {Partial<Params>} [overrides]
 * @returns {Game}
 */
export function createGame(overrides = {}) {
  /** @type {Params} */
  const params = { ...DEFAULTS, ...overrides };
  const rng = createRng(params.seed);
  const W = params.width, H = params.height;
  const seaW = W * params.tile, seaH = H * params.tile;
  /** @type {Game} */
  const game = {
    params, rng, tick: 0, W, H, seaW, seaH,
    corners: new Uint8Array((W + 1) * (H + 1)),
    wind: { dir: 0, speed: 0, fromDir: 0, fromSpeed: 0, toDir: 0, toSpeed: 0, ease: 0, next: 0 },
    ships: [], balls: [], winner: -1, ending: -1, quiet: 0,
    stats: { fired: [0, 0], hits: [0, 0] },
  };

  // Blue at the bottom (portrait) or left (landscape), red point-symmetric.
  const portrait = seaH >= seaW;
  const cx = seaW / 2, cy = seaH / 2;
  const half = params.startGap / 2, off = params.startOffset;
  const blue = portrait
    ? { x: cx + off, y: cy + half, heading: deg(270) }
    : { x: cx - half, y: cy + off, heading: 0 };
  const starts = [blue, { x: seaW - blue.x, y: seaH - blue.y, heading: (blue.heading + HALF) & MASK }];
  for (let i = 0; i < 2; i++) game.ships.push(makeShip(game, i, i, SHIP_TYPES.frigate, starts[i]));

  generateIslands(game, starts);

  // The wind starts across the line between the ships: neither has the weather gauge.
  const across = portrait ? 0 : QUARTER;
  const dir = (across + (rng.int(2) ? HALF : 0)) & MASK;
  const speed = params.windMin + rng.int(params.windMax - params.windMin + 1);
  Object.assign(game.wind, { dir, speed, fromDir: dir, fromSpeed: speed, toDir: dir, toSpeed: speed });
  game.wind.ease = easeTicks(game);
  game.wind.next = nextShiftTick(game);
  return game;
}

/**
 * @param {Game} game @param {number} id @param {number} side @param {ShipType} type
 * @param {{x: number, y: number, heading: number}} at
 * @returns {Ship}
 */
function makeShip(game, id, side, type, at) {
  const crew = game.params.crewPerGun * type.gunsPerSide * 2;
  const v = game.params.startSpeed;
  return {
    id, side, type, x: at.x, y: at.y,
    vx: icos(at.heading) * v, vy: isin(at.heading) * v, heading: at.heading,
    rudder: 0, crew, maxCrew: crew, struck: false,
    batteries: [-1, 1].map((s) => ({ side: s, firing: 0, fireAt: 0, reloadLeft: 0 })),
    shadowed: false, terrain: DEEP,
  };
}

/** @param {Game} game */
function easeTicks(game) {
  return Math.max(1, Math.round(game.params.shiftEase * game.params.tickRate));
}
/** @param {Game} game */
function nextShiftTick(game) {
  const p = WIND_PRESETS[/** @type {keyof typeof WIND_PRESETS} */ (game.params.wind)] ?? WIND_PRESETS.shifty;
  if (!p.min) return Infinity;
  return game.tick + (p.min + game.rng.int(p.max - p.min + 1)) * game.params.tickRate;
}

// ---------------------------------------------------------------------------
// The map: terrain at tile corners (see RULES.md, The sea)

/** Corner index → index of its 180° mirror image. */
const mirrorOf = (/** @type {Game} */ game, /** @type {number} */ i) => game.corners.length - 1 - i;

/**
 * Terrain at a point: that of the nearest tile corner. Outside the sea is LAND
 * as far as ships and balls are concerned.
 * @param {Game} game @param {number} x @param {number} y
 */
export function terrainAt(game, x, y) {
  if (x < 0 || y < 0 || x > game.seaW || y > game.seaH) return LAND;
  const i = Math.round(x / game.params.tile), j = Math.round(y / game.params.tile);
  return game.corners[j * (game.W + 1) + i];
}

/**
 * Islands: blobs of land corners, mirrored through the centre, kept clear of
 * the starts. Then diagonal-only tiles are smoothed away and a ring of
 * shallows is laid one tile wide around all land.
 * @param {Game} game @param {{x: number, y: number}[]} starts
 */
function generateIslands(game, starts) {
  const { rng, params, W, H, corners } = game;
  const cw = W + 1;
  const density = params.islands === 'many' ? params.islandsMany : params.islands === 'some' ? params.islandsSome : 0;
  const blobs = Math.round((density * W * H) / 1000);
  const keepOut = 160; // metres of clear water around each start, beyond the island's radius
  let placed = 0;
  for (let tries = 0; placed < blobs && tries < 50 * blobs; tries++) {
    const ci = 1 + rng.int(W - 1), cj = 1 + rng.int(H - 1);
    const r = (3 + rng.int(6)) / 2; // 1.5 to 4 tiles
    const reach = (r + 1) * params.tile + keepOut;
    let clear = true;
    for (const s of starts) {
      const dx = ci * params.tile - s.x, dy = cj * params.tile - s.y;
      if (dx * dx + dy * dy < reach * reach) clear = false;
    }
    // Keep the middle open too, so the ships always meet somewhere.
    const mx = ci - W / 2, my = cj - H / 2;
    if (mx * mx + my * my < (r + 3) * (r + 3)) clear = false;
    if (!clear) continue;
    placed++;
    const R = Math.ceil(r + 1);
    for (let j = cj - R; j <= cj + R; j++) {
      for (let i = ci - R; i <= ci + R; i++) {
        if (i < 0 || j < 0 || i > W || j > H) continue;
        const d2 = (i - ci) * (i - ci) + (j - cj) * (j - cj);
        const rr = r + (rng.int(3) - 1) * 0.5;
        if (d2 <= rr * rr) {
          const k = j * cw + i;
          corners[k] = LAND;
          corners[mirrorOf(game, k)] = LAND;
        }
      }
    }
  }
  smoothDiagonals(game, LAND);
  // Shallows: every corner within one step of land.
  const land = corners.slice();
  for (let j = 0; j <= H; j++) {
    for (let i = 0; i <= W; i++) {
      const k = j * cw + i;
      if (land[k] === LAND) continue;
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii <= W && jj <= H && land[jj * cw + ii] === LAND) { near = true; break; }
        }
      }
      if (near) corners[k] = SHALLOW;
    }
  }
  smoothDiagonals(game, SHALLOW);
}

/**
 * The tile set has no piece for two opposite corners at a level with the
 * other two below it, so raise one more corner (and its mirror) until no
 * tile looks like that. Every change keeps the map point-symmetric.
 * @param {Game} game @param {number} level
 */
function smoothDiagonals(game, level) {
  const { W, H, corners } = game;
  const cw = W + 1;
  const up = (/** @type {number} */ k) => corners[k] >= level;
  const raise = (/** @type {number} */ k) => {
    corners[k] = level;
    corners[mirrorOf(game, k)] = level;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const tl = j * cw + i, tr = tl + 1, bl = tl + cw, br = bl + 1;
        if (up(tl) && up(br) && !up(tr) && !up(bl)) { raise(tr); changed = true; }
        else if (up(tr) && up(bl) && !up(tl) && !up(br)) { raise(tl); changed = true; }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inputs

/**
 * Apply a player's (or the CPU's) input to their ship.
 * @param {Game} game @param {number} shipId @param {Input} input
 */
export function applyInput(game, shipId, input) {
  const ship = game.ships[shipId];
  if (!ship || ship.struck || game.winner >= 0) return;
  if (input.type === 'fire' && game.ending >= 0) return; // the fight is decided: no new shots
  if (input.type === 'rudder') {
    const v = Math.round(input.value);
    ship.rudder = Math.max(-100, Math.min(100, v || 0));
  } else if (input.type === 'fire') {
    const b = ship.batteries[input.battery];
    if (!b || b.reloadLeft > 0 || b.firing > 0) return;
    b.firing = ship.type.gunsPerSide;
    b.fireAt = game.tick;
    b.reloadLeft = Math.round(game.params.reload * game.params.tickRate);
  }
}

// ---------------------------------------------------------------------------
// Queries shared with the renderer and the CPU

/**
 * The true wind as a velocity (where it blows TO), metres per game second.
 * One wind for the whole sea in the duel; a function of position so a storm
 * could be a patch of different wind later.
 * @param {Game} game @param {number} [_x] @param {number} [_y]
 */
export function windAt(game, _x, _y) {
  const w = game.wind;
  const s = w.speed * KTS;
  return { x: -icos(w.dir) * s, y: -isin(w.dir) * s };
}

/** Unit vector out of a battery's side. @param {Ship} ship @param {number} battery */
export function batteryDir(ship, battery) {
  const sgn = battery === STARBOARD ? 1 : -1;
  return { x: -isin(ship.heading) * sgn, y: icos(ship.heading) * sgn };
}

/**
 * Where gun `g` of a battery sits, and the unit direction it would fire in
 * now (before spread): at the nearest enemy's centre, clamped to its arc.
 * @param {Game} game @param {Ship} ship @param {number} battery @param {number} g
 */
export function aimGun(game, ship, battery, g) {
  const t = ship.type;
  const c = icos(ship.heading), s = isin(ship.heading);
  const sgn = battery === STARBOARD ? 1 : -1;
  const along = t.gunsPerSide > 1 ? t.gunSpan / 2 - (g * t.gunSpan) / (t.gunsPerSide - 1) : 0;
  const rx = -s * sgn, ry = c * sgn; // out of this side
  const x = ship.x + c * along + rx * (t.beam / 2);
  const y = ship.y + s * along + ry * (t.beam / 2);
  let dx = rx, dy = ry;
  const target = nearestEnemy(game, ship, x, y);
  if (target) {
    const tx = target.x - x, ty = target.y - y;
    const d = Math.sqrt(tx * tx + ty * ty);
    if (d > 0) {
      const ux = tx / d, uy = ty / d;
      const fwd = ux * c + uy * s; // how far forward of square, as a sine
      const out = ux * rx + uy * ry;
      const tr = deg(game.params.traverse);
      const sinT = isin(tr), cosT = icos(tr);
      if (out > 0 && Math.abs(fwd) <= sinT) {
        dx = ux; dy = uy;
      } else {
        const f = fwd >= 0 ? sinT : -sinT;
        dx = rx * cosT + c * f;
        dy = ry * cosT + s * f;
      }
    }
  }
  return { x, y, dx, dy };
}

/** @param {Game} game @param {Ship} ship @param {number} x @param {number} y */
function nearestEnemy(game, ship, x, y) {
  /** @type {Ship|null} */
  let best = null;
  let bd = Infinity;
  for (const o of game.ships) {
    if (o.side === ship.side || o.struck) continue;
    const dx = o.x - x, dy = o.y - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/**
 * Squared distance from a point to a ship's centre line (the capsule's
 * spine). The hull is a capsule `length` long and `beam` wide.
 * @param {Ship} ship @param {number} x @param {number} y
 */
export function hullDistance2(ship, x, y) {
  const half = (ship.type.length - ship.type.beam) / 2;
  const c = icos(ship.heading), s = isin(ship.heading);
  const px = x - ship.x, py = y - ship.y;
  const t = Math.max(-half, Math.min(half, px * c + py * s));
  const ex = px - c * t, ey = py - s * t;
  return ex * ex + ey * ey;
}

/** @param {Ship} ship @param {number} x @param {number} y */
export function hullContains(ship, x, y) {
  const r = ship.type.beam / 2;
  return hullDistance2(ship, x, y) <= r * r;
}

/** Forward speed in m per game second. @param {Ship} ship */
export const forwardSpeed = (ship) => ship.vx * icos(ship.heading) + ship.vy * isin(ship.heading);

// ---------------------------------------------------------------------------
// The tick

/**
 * Advance one tick.
 * @param {Game} game
 * @returns {Events}
 */
export function step(game) {
  /** @type {Events} */
  const ev = { fired: [], hits: [], splashes: [], struck: [], bumps: [], shift: false };
  if (game.winner >= 0) return ev;
  updateWind(game, ev);
  const prev = game.ships.map((s) => ({ x: s.x, y: s.y, heading: s.heading }));
  for (const ship of game.ships) sail(game, ship);
  for (let i = 0; i < game.ships.length; i++) landCollision(game, game.ships[i], prev[i], ev);
  shipCollisions(game, prev, ev);
  for (const ship of game.ships) fireBatteries(game, ship, ev);
  moveBalls(game, ev);

  if (ev.hits.length) {
    for (const ship of game.ships) {
      if (!ship.struck && ship.crew <= 0) {
        ship.struck = true;
        ship.rudder = 0;
        for (const b of ship.batteries) b.firing = 0;
        ev.struck.push(ship.id);
      }
    }
  }
  if (ev.struck.length && game.ending < 0 && liveSides(game).size <= 1) game.ending = game.tick;
  if (game.ending >= 0) {
    // The fight is decided, but the sea plays on: balls already in the air can
    // still land (and strike the other side too, which makes a draw), and the
    // game is over only once nothing has been fired or in flight for endDelay.
    const quiet = !game.balls.length && game.ships.every((s) => s.batteries.every((b) => b.firing <= 0));
    game.quiet = quiet ? game.quiet + 1 : 0;
    if (game.quiet >= Math.round(game.params.endDelay * game.params.tickRate)) {
      const alive = liveSides(game);
      game.winner = alive.size === 0 ? DRAW : [...alive][0];
    }
  }
  game.tick++;
  return ev;
}

/** Sides that still have a ship afloat (not struck). @param {Game} game */
function liveSides(game) {
  return new Set(game.ships.filter((s) => !s.struck).map((s) => s.side));
}

/** @param {Game} game @param {Events} ev */
function updateWind(game, ev) {
  const w = game.wind;
  const p = WIND_PRESETS[/** @type {keyof typeof WIND_PRESETS} */ (game.params.wind)] ?? WIND_PRESETS.shifty;
  if (game.tick >= w.next) {
    const a = deg(p.angle);
    w.fromDir = w.dir;
    w.fromSpeed = w.speed;
    w.toDir = (w.dir + game.rng.int(2 * a + 1) - a) & MASK;
    const ds = game.rng.int(2 * p.speed + 1) - p.speed;
    w.toSpeed = Math.max(game.params.windMin, Math.min(game.params.windMax, w.speed + ds));
    w.ease = 0;
    w.next = nextShiftTick(game);
    ev.shift = true;
  }
  const n = easeTicks(game);
  if (w.ease < n) {
    w.ease++;
    const k = w.ease / n;
    w.dir = (w.fromDir + Math.round(angleDiff(w.fromDir, w.toDir) * k)) & MASK;
    w.speed = w.fromSpeed + (w.toSpeed - w.fromSpeed) * k;
  }
}

/**
 * Is this ship in another ship's wind shadow?
 * @param {Game} game @param {Ship} ship @param {{x: number, y: number}} wind
 */
function inShadow(game, ship, wind) {
  const p = game.params;
  if (!p.shadow) return false;
  const ws = Math.sqrt(wind.x * wind.x + wind.y * wind.y);
  if (ws === 0) return false;
  const ux = wind.x / ws, uy = wind.y / ws;
  const halfCone = deg(p.shadowCone / 2);
  const tanHalf = isin(halfCone) / icos(halfCone);
  for (const o of game.ships) {
    if (o === ship) continue;
    const dx = ship.x - o.x, dy = ship.y - o.y;
    const along = dx * ux + dy * uy;
    if (along <= 0 || along > p.shadowRange) continue;
    if (Math.abs(dx * uy - dy * ux) <= along * tanHalf) return true;
  }
  return false;
}

/**
 * The sailing model, RULES.md steps 1–7. Hull drag is applied in closed form
 * (v / (1 + k|v|dt), the exact solution of dv/dt = −k v|v|), which can't
 * overshoot however big the keel drag or the tick.
 * @param {Game} game @param {Ship} ship
 */
function sail(game, ship) {
  const p = game.params, t = ship.type;
  const dt = p.timeScale / p.tickRate;
  let wind = windAt(game, ship.x, ship.y);
  ship.shadowed = inShadow(game, ship, wind);
  if (ship.shadowed) wind = { x: wind.x * p.shadowFactor, y: wind.y * p.shadowFactor };
  const ax = wind.x - ship.vx, ay = wind.y - ship.vy; // apparent wind (blowing to)
  const aw = Math.sqrt(ax * ax + ay * ay);
  const c = icos(ship.heading), s = isin(ship.heading);
  let drive = 0;
  if (aw > 0 && !ship.struck) {
    const cosA = -(ax * c + ay * s) / aw; // 1 head to wind, −1 dead downwind
    const sinA = Math.abs(s * ax - c * ay) / aw;
    drive = Math.max(0, t.lift * sinA - t.drag * cosA) * aw;
  }
  const fx = c * drive + t.windage * ax;
  const fy = s * drive + t.windage * ay;
  let vx = ship.vx + (fx / t.mass) * dt;
  let vy = ship.vy + (fy / t.mass) * dt;

  ship.terrain = terrainAt(game, ship.x, ship.y);
  const mul = ship.terrain === SHALLOW ? p.shallowsDrag : 1;
  let vf = vx * c + vy * s;
  let vs = -vx * s + vy * c;
  vf = vf / (1 + (t.bowDrag * mul * Math.abs(vf) * dt) / t.mass);
  vs = vs / (1 + (t.keelDrag * mul * Math.abs(vs) * dt) / t.mass);
  ship.vx = vf * c - vs * s;
  ship.vy = vf * s + vs * c;

  const steer = Math.max(-1, Math.min(1, vf / (t.steerSpeed * KTS)));
  const perTick = (t.turnRate * TURN) / 360 / p.tickRate;
  ship.heading = (ship.heading + Math.round((ship.rudder / 100) * perTick * steer)) & MASK;
  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
}

/**
 * Points around the hull that are checked against land and the sea's edge.
 * @param {Ship} ship
 */
function hullPoints(ship) {
  const L = ship.type.length / 2, B = ship.type.beam / 2;
  const c = icos(ship.heading), s = isin(ship.heading);
  /** @type {[number, number][]} */
  const local = [[L, 0], [-L, 0], [L / 2, B * 0.8], [L / 2, -B * 0.8], [0, B], [0, -B], [-L / 2, B * 0.8], [-L / 2, -B * 0.8]];
  return local.map(([a, b]) => ({ x: ship.x + c * a - s * b, y: ship.y + s * a + c * b }));
}

/** @param {Game} game @param {Ship} ship */
function touchesLand(game, ship) {
  return hullPoints(ship).some((q) => terrainAt(game, q.x, q.y) === LAND);
}

/**
 * Touching an island or the edge stops a ship dead and pushes her clear,
 * away from where she touched.
 * @param {Game} game @param {Ship} ship @param {{x: number, y: number, heading: number}} prev
 * @param {Events} ev
 */
function landCollision(game, ship, prev, ev) {
  const hit = hullPoints(ship).filter((q) => terrainAt(game, q.x, q.y) === LAND);
  if (!hit.length) return;
  let hx = 0, hy = 0;
  for (const q of hit) { hx += q.x; hy += q.y; }
  hx /= hit.length; hy /= hit.length;
  let ax = ship.x - hx, ay = ship.y - hy;
  const d = Math.sqrt(ax * ax + ay * ay);
  if (d > 0) { ax /= d; ay /= d; }
  // Undo the move but keep the turn (undoing the turn too could pin her
  // against the shore for ever), then nudge her out if she still touches.
  ship.x = prev.x;
  ship.y = prev.y;
  for (let k = 0; k < 6 && touchesLand(game, ship); k++) {
    ship.x += ax;
    ship.y += ay;
  }
  ship.vx = ax * game.params.bounce;
  ship.vy = ay * game.params.bounce;
  ev.bumps.push({ ship: ship.id, x: hx, y: hy });
}

/**
 * Closest distance² between two segments (the hulls' spines).
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 * @param {number} cx @param {number} cy @param {number} dx @param {number} dy
 */
function segDist2(ax, ay, bx, by, cx, cy, dx, dy) {
  const ux = bx - ax, uy = by - ay, vx = dx - cx, vy = dy - cy, wx = ax - cx, wy = ay - cy;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  const den = a * c - b * b;
  let s = den > 1e-9 ? Math.max(0, Math.min(1, (b * e - c * d) / den)) : 0;
  let t = c > 0 ? (b * s + e) / c : 0;
  if (t < 0) { t = 0; s = a > 0 ? Math.max(0, Math.min(1, -d / a)) : 0; }
  else if (t > 1) { t = 1; s = a > 0 ? Math.max(0, Math.min(1, (b - d) / a)) : 0; }
  const px = wx + ux * s - vx * t, py = wy + uy * s - vy * t;
  return px * px + py * py;
}

/** @param {Ship} ship */
function spine(ship) {
  const half = (ship.type.length - ship.type.beam) / 2;
  const c = icos(ship.heading) * half, s = isin(ship.heading) * half;
  return [ship.x + c, ship.y + s, ship.x - c, ship.y - s];
}

/** @param {Ship} a @param {Ship} b */
function shipsTouch(a, b) {
  const [ax, ay, bx, by] = spine(a), [cx, cy, dx, dy] = spine(b);
  const r = (a.type.beam + b.type.beam) / 2;
  return segDist2(ax, ay, bx, by, cx, cy, dx, dy) < r * r;
}

/**
 * Ships that touch bounce apart and lose most of their speed.
 * @param {Game} game @param {{x: number, y: number, heading: number}[]} prev @param {Events} ev
 */
function shipCollisions(game, prev, ev) {
  const ships = game.ships;
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i], b = ships[j];
      if (!shipsTouch(a, b)) continue;
      const nowA = { x: a.x, y: a.y }, nowB = { x: b.x, y: b.y };
      a.x = prev[i].x; a.y = prev[i].y; // undo the moves, keep the turns
      b.x = prev[j].x; b.y = prev[j].y;
      if (shipsTouch(a, b)) { Object.assign(a, nowA); Object.assign(b, nowB); } // already tangled: let them drift apart
      let nx = a.x - b.x, ny = a.y - b.y;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d > 0) { nx /= d; ny /= d; } else { nx = 1; ny = 0; }
      const k = game.params.bounce / 2;
      a.vx = a.vx * 0.2 + nx * k; a.vy = a.vy * 0.2 + ny * k;
      b.vx = b.vx * 0.2 - nx * k; b.vy = b.vy * 0.2 - ny * k;
      ev.bumps.push({ ship: a.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  }
}

/** @param {Game} game @param {Ship} ship @param {Events} ev */
function fireBatteries(game, ship, ev) {
  const p = game.params;
  const gap = Math.max(1, Math.round(p.ripple * p.tickRate));
  const perTick = p.muzzleSpeed / p.tickRate;
  const dt = p.timeScale / p.tickRate;
  const life = Math.round((p.gunRange / p.muzzleSpeed) * p.tickRate);
  const spread = deg(p.spread);
  for (let bi = 0; bi < ship.batteries.length; bi++) {
    const b = ship.batteries[bi];
    if (b.reloadLeft > 0) b.reloadLeft--;
    if (b.firing <= 0 || game.tick < b.fireAt) continue;
    const g = ship.type.gunsPerSide - b.firing;
    b.firing--;
    b.fireAt = game.tick + gap;
    const aim = aimGun(game, ship, bi, g);
    const e = game.rng.int(2 * spread + 1) - spread;
    const ce = icos(e), se = isin(e);
    const dx = aim.dx * ce - aim.dy * se, dy = aim.dx * se + aim.dy * ce;
    game.balls.push({
      x: aim.x, y: aim.y,
      vx: dx * perTick + ship.vx * dt, vy: dy * perTick + ship.vy * dt,
      life, owner: ship.id,
    });
    game.stats.fired[ship.side]++;
    ev.fired.push({ ship: ship.id, x: aim.x, y: aim.y, dx, dy });
  }
}

/** @param {Game} game @param {Events} ev */
function moveBalls(game, ev) {
  const kept = [];
  for (const ball of game.balls) {
    let gone = false;
    // Two samples per tick (a tick is 5 m of flight, a hull 12 m wide).
    for (const f of [0.5, 1]) {
      const x = ball.x + ball.vx * f, y = ball.y + ball.vy * f;
      for (const ship of game.ships) {
        if (ship.id === ball.owner || !hullContains(ship, x, y)) continue;
        if (ship.crew > 0) ship.crew--;
        const by = game.ships[ball.owner];
        if (by) game.stats.hits[by.side]++;
        ev.hits.push({ ship: ship.id, by: ball.owner, x, y });
        gone = true;
        break;
      }
      if (!gone && terrainAt(game, x, y) === LAND) {
        if (x >= 0 && y >= 0 && x <= game.seaW && y <= game.seaH) ev.splashes.push({ x, y, land: true });
        gone = true;
      }
      if (gone) break;
    }
    if (gone) continue;
    ball.x += ball.vx;
    ball.y += ball.vy;
    if (--ball.life <= 0) {
      ev.splashes.push({ x: ball.x, y: ball.y, land: false });
      continue;
    }
    kept.push(ball);
  }
  game.balls = kept;
}

// ---------------------------------------------------------------------------

/**
 * Hash of everything that affects the game's future, for desync checks and
 * determinism tests.
 * @param {Game} game
 */
export function stateHash(game) {
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const mixInt = (/** @type {number} */ v) => { h = Math.imul(h ^ (v >>> 0), 16777619); };
  const mix = (/** @type {number} */ v) => { f[0] = v; mixInt(u[0]); mixInt(u[1]); };
  mixInt(game.tick); mixInt(game.ending); mixInt(game.quiet);
  mixInt(game.rng.state());
  mix(game.wind.dir); mix(game.wind.speed);
  for (const s of game.ships) {
    mix(s.x); mix(s.y); mix(s.vx); mix(s.vy); mixInt(s.heading); mixInt(s.rudder); mixInt(s.crew);
    for (const b of s.batteries) { mixInt(b.firing); mixInt(b.reloadLeft); }
  }
  for (const b of game.balls) { mix(b.x); mix(b.y); mix(b.vx); mix(b.vy); mixInt(b.life); }
  for (let i = 0; i < game.corners.length; i++) mixInt(game.corners[i]);
  return h >>> 0;
}
