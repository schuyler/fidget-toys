// @ts-check
// Hex grid geometry. Pointy-top hexes stored as a rectangle in "odd-r"
// offset layout (odd rows shifted right half a cell), with axial (q, r)
// coordinates for the maths. Adapted from dot-army/src/hex.js.
//
// Star Troopers mirrors its maps top-to-bottom rather than rotating them:
// with an odd number of rows, reflecting row r onto row H-1-r is an exact
// symmetry of this layout, and the centre row maps onto itself. That's
// what lets a symmetric map have three victory hexes on its centre line.

/** Axial direction vectors, indexed 0..5: E, NE, NW, W, SW, SE (screen y points down). */
export const DIRS = /** @type {const} */ ([
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
]);

/**
 * @typedef {Object} Grid
 * @property {number} W  columns
 * @property {number} H  rows (odd, so the centre row is a mirror line)
 * @property {number} N  W * H
 * @property {Int32Array} nbr  N*6 neighbour table, -1 = off board
 * @property {Int16Array} q  axial q per cell
 * @property {Int16Array} r  axial r per cell
 */

/**
 * @param {number} W
 * @param {number} H
 * @returns {Grid}
 */
export function createGrid(W, H) {
  const N = W * H;
  const q = new Int16Array(N);
  const r = new Int16Array(N);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      q[i] = col - ((row - (row & 1)) >> 1);
      r[i] = row;
    }
  }
  const nbr = new Int32Array(N * 6);
  const grid = { W, H, N, nbr, q, r };
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < 6; d++) {
      nbr[i * 6 + d] = axialToIndex(grid, q[i] + DIRS[d][0], r[i] + DIRS[d][1]);
    }
  }
  return grid;
}

/**
 * @param {Grid} g @param {number} q @param {number} r
 * @returns {number} cell index, or -1 if off board
 */
export function axialToIndex(g, q, r) {
  if (r < 0 || r >= g.H) return -1;
  const col = q + ((r - (r & 1)) >> 1);
  if (col < 0 || col >= g.W) return -1;
  return r * g.W + col;
}

/** Cell index from offset coordinates. */
export function cellAt(/** @type {Grid} */ g, /** @type {number} */ col, /** @type {number} */ row) {
  return row * g.W + col;
}

/** Row of a cell. */
export function rowOf(/** @type {Grid} */ g, /** @type {number} */ i) {
  return (i / g.W) | 0;
}

/** Column of a cell. */
export function colOf(/** @type {Grid} */ g, /** @type {number} */ i) {
  return i % g.W;
}

/** Hex distance in steps. */
export function hexDist(/** @type {Grid} */ g, /** @type {number} */ a, /** @type {number} */ b) {
  const dq = g.q[a] - g.q[b];
  const dr = g.r[a] - g.r[b];
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) >> 1;
}

/** The cell reflected across the centre row (the map's symmetry). */
export function reflect(/** @type {Grid} */ g, /** @type {number} */ i) {
  return cellAt(g, colOf(g, i), g.H - 1 - rowOf(g, i));
}

/** Are two cells neighbours? */
export function adjacent(/** @type {Grid} */ g, /** @type {number} */ a, /** @type {number} */ b) {
  for (let d = 0; d < 6; d++) if (g.nbr[a * 6 + d] === b) return true;
  return false;
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
 * The cells a straight line from a to b passes through, as pairs. The line
 * is traced twice, nudged a hair to either side. Where both traces agree,
 * the pair holds the same cell twice; where the line runs exactly along an
 * edge, the pair holds the cell on each side of it. Endpoints included.
 * Plain doubles with a fixed nudge, so it's the same in every engine.
 * @param {Grid} g @param {number} a @param {number} b
 * @returns {[number, number][]}
 */
export function linePairs(g, a, b) {
  const n = hexDist(g, a, b);
  const aq = g.q[a], ar = g.r[a], as = -aq - ar;
  const bq = g.q[b], br = g.r[b], bs = -bq - br;
  /** @type {[number, number][]} */
  const out = [];
  const e = 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const q = aq + (bq - aq) * t, r = ar + (br - ar) * t, s = as + (bs - as) * t;
    const [q1, r1] = cubeRound(q + e, r + 2 * e, s - 3 * e);
    const [q2, r2] = cubeRound(q - e, r - 2 * e, s + 3 * e);
    out.push([axialToIndex(g, q1, r1), axialToIndex(g, q2, r2)]);
  }
  return out;
}
