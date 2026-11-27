// @ts-check
// Hex geometry for a hexagon-shaped map. Cells are stored in a flat list,
// with axial (q, r) coordinates centred on the middle cell, so rotating the
// map 180° is just (q, r) -> (-q, -r) and the centre is a real cell. That's
// the galaxy's symmetry: each civ's arm is the other's, turned half a turn.
// Pointy-top hexes; screen y points down.

/** Axial direction vectors, indexed 0..5: E, NE, NW, W, SW, SE. */
export const DIRS = /** @type {const} */ ([
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
]);

/**
 * @typedef {Object} Grid
 * @property {number} R  radius: cells up to R steps from the centre exist
 * @property {number} N  number of cells
 * @property {Int16Array} q
 * @property {Int16Array} r
 * @property {Int32Array} nbr  N*6 neighbour table, -1 = off the map
 * @property {Int32Array} lookup  (2R+1)^2 table from axial to index, -1 = none
 * @property {number} centre  index of the centre cell
 */

/** @param {number} R @returns {Grid} */
export function createGrid(R) {
  const S = 2 * R + 1;
  const lookup = new Int32Array(S * S).fill(-1);
  /** @type {number[]} */ const qs = [];
  /** @type {number[]} */ const rs = [];
  for (let r = -R; r <= R; r++) {
    for (let q = -R; q <= R; q++) {
      if (Math.abs(q + r) > R) continue;
      lookup[(r + R) * S + (q + R)] = qs.length;
      qs.push(q);
      rs.push(r);
    }
  }
  const N = qs.length;
  const grid = { R, N, q: Int16Array.from(qs), r: Int16Array.from(rs), nbr: new Int32Array(N * 6), lookup, centre: 0 };
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < 6; d++) grid.nbr[i * 6 + d] = axialToIndex(grid, grid.q[i] + DIRS[d][0], grid.r[i] + DIRS[d][1]);
  }
  grid.centre = axialToIndex(grid, 0, 0);
  return grid;
}

/** @param {Grid} g @param {number} q @param {number} r @returns {number} index, or -1 off the map */
export function axialToIndex(g, q, r) {
  const R = g.R;
  if (Math.abs(q) > R || Math.abs(r) > R || Math.abs(q + r) > R) return -1;
  return g.lookup[(r + R) * (2 * R + 1) + (q + R)];
}

/** Hex distance in steps. */
export function hexDist(/** @type {Grid} */ g, /** @type {number} */ a, /** @type {number} */ b) {
  const dq = g.q[a] - g.q[b];
  const dr = g.r[a] - g.r[b];
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) >> 1;
}

/** Distance from the centre. */
export function ring(/** @type {Grid} */ g, /** @type {number} */ i) {
  return hexDist(g, i, g.centre);
}

/** The cell turned 180° about the centre (the map's symmetry). */
export function rotate(/** @type {Grid} */ g, /** @type {number} */ i) {
  return axialToIndex(g, -g.q[i], -g.r[i]);
}

/** The direction from a to its neighbour b, or -1 if they aren't neighbours. */
export function dirTo(/** @type {Grid} */ g, /** @type {number} */ a, /** @type {number} */ b) {
  for (let d = 0; d < 6; d++) if (g.nbr[a * 6 + d] === b) return d;
  return -1;
}

/**
 * The cell k steps from c in direction d, or -1 if that's off the map.
 * @param {Grid} g @param {number} c @param {number} d @param {number} k
 */
export function stepFrom(g, c, d, k) {
  return axialToIndex(g, g.q[c] + DIRS[d][0] * k, g.r[c] + DIRS[d][1] * k);
}

/** Every cell within n steps of c (including c). */
export function within(/** @type {Grid} */ g, /** @type {number} */ c, /** @type {number} */ n) {
  /** @type {number[]} */ const out = [];
  for (let dq = -n; dq <= n; dq++) {
    for (let dr = Math.max(-n, -dq - n); dr <= Math.min(n, -dq + n); dr++) {
      const i = axialToIndex(g, g.q[c] + dq, g.r[c] + dr);
      if (i >= 0) out.push(i);
    }
  }
  return out;
}

/**
 * @param {number} q @param {number} r @param {number} s
 * @returns {[number, number]} rounded axial q, r
 */
function cubeRound(q, r, s) {
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

/**
 * The cells a straight line from a to b passes through, traced twice,
 * nudged a hair to either side (so a line running exactly along an edge
 * sees the cell on each side). Endpoints included. Only +, -, *, / and
 * Math.round on doubles, which are exact the same way in every engine, so
 * this is safe for the deterministic simulation. Off-map cells are -1.
 * @param {Grid} g @param {number} a @param {number} b
 * @returns {[number[], number[]]}
 */
export function lineTraces(g, a, b) {
  const n = hexDist(g, a, b);
  const aq = g.q[a], ar = g.r[a], as = -aq - ar;
  const bq = g.q[b], br = g.r[b], bs = -bq - br;
  /** @type {number[]} */ const t1 = [];
  /** @type {number[]} */ const t2 = [];
  const e = 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const q = aq + (bq - aq) * t, r = ar + (br - ar) * t, s = as + (bs - as) * t;
    const [q1, r1] = cubeRound(q + e, r + 2 * e, s - 3 * e);
    const [q2, r2] = cubeRound(q - e, r - 2 * e, s + 3 * e);
    t1.push(axialToIndex(g, q1, r1));
    t2.push(axialToIndex(g, q2, r2));
  }
  return [t1, t2];
}

// Presentation helpers (floats are fine here: only render/main use them).

const SQRT3 = Math.sqrt(3);

/** Pixel centre of a cell for hexes of the given size (centre to corner). */
export function cellCenter(/** @type {Grid} */ g, /** @type {number} */ i, /** @type {number} */ size) {
  return { x: size * SQRT3 * (g.q[i] + g.r[i] / 2), y: size * 1.5 * g.r[i] };
}

/** The cell under a pixel, or -1. */
export function pixelToCell(/** @type {Grid} */ g, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ size) {
  const q = ((SQRT3 / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  const [rq, rr] = cubeRound(q, r, -q - r);
  return axialToIndex(g, rq, rr);
}
