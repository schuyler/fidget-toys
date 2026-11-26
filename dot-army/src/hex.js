// @ts-check
// Hex grid geometry. Pointy-top hexes stored as a rectangle in "odd-r"
// offset layout (odd rows shifted right half a cell), with axial (q, r)
// coordinates for the maths. Every cell is a single integer index
// (row * width + col), and each cell's six neighbours are precomputed into a
// flat table, so the simulation never does coordinate maths in its hot loops.

/** Axial direction vectors, indexed 0..5: E, NE, NW, W, SW, SE (screen y points down). */
export const DIRS = /** @type {const} */ ([
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
]);

/**
 * @typedef {Object} Grid
 * @property {number} W  columns
 * @property {number} H  rows (kept even so 180° rotation is an exact symmetry)
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
 * @param {Grid} g
 * @param {number} q
 * @param {number} r
 * @returns {number} cell index, or -1 if off board
 */
export function axialToIndex(g, q, r) {
  if (r < 0 || r >= g.H) return -1;
  const col = q + ((r - (r & 1)) >> 1);
  if (col < 0 || col >= g.W) return -1;
  return r * g.W + col;
}

/**
 * Hex distance in steps.
 * @param {Grid} g @param {number} a @param {number} b
 */
export function hexDist(g, a, b) {
  const dq = g.q[a] - g.q[b];
  const dr = g.r[a] - g.r[b];
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) >> 1;
}

/**
 * The direction (0..5) that best points from cell `from` toward cell `to`.
 * Uses integer cube-coordinate dot products, so it's deterministic.
 * Returns -1 if from === to.
 * @param {Grid} g @param {number} from @param {number} to
 */
export function dirToward(g, from, to) {
  const vq = g.q[to] - g.q[from];
  const vr = g.r[to] - g.r[from];
  if (vq === 0 && vr === 0) return -1;
  const vs = -vq - vr;
  let best = 0, bestDot = -Infinity;
  for (let d = 0; d < 6; d++) {
    const dq = DIRS[d][0], dr = DIRS[d][1], ds = -dq - dr;
    const dot = dq * vq + dr * vr + ds * vs;
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

/** Smallest number of 60° steps between two directions (0..3). */
export function dirDiff(/** @type {number} */ a, /** @type {number} */ b) {
  const d = (a - b + 6) % 6;
  return d > 3 ? 6 - d : d;
}

/** Cell index of the 180°-rotated position (the board's point symmetry). */
export function mirror(/** @type {Grid} */ g, /** @type {number} */ i) {
  return g.N - 1 - i;
}

// ---- Pixel geometry (rendering/input only; floats are fine here) ----

const SQRT3 = Math.sqrt(3);

/**
 * Centre of a cell in board pixels, for hex "size" (centre-to-corner radius).
 * @param {Grid} g @param {number} i @param {number} size
 * @returns {[number, number]}
 */
export function cellCenter(g, i, size) {
  const q = g.q[i], r = g.r[i];
  return [size * SQRT3 * (q + r / 2) + size * SQRT3 / 2, size * 1.5 * r + size];
}

/** Board extent in pixels for a given hex size. */
export function boardSize(/** @type {Grid} */ g, /** @type {number} */ size) {
  return { w: size * SQRT3 * (g.W + 0.5), h: size * (1.5 * (g.H - 1) + 2) };
}

/** Largest hex size that fits the board inside w × h pixels. */
export function fitSize(/** @type {Grid} */ g, /** @type {number} */ w, /** @type {number} */ h) {
  return Math.min(w / (SQRT3 * (g.W + 0.5)), h / (1.5 * (g.H - 1) + 2));
}

/**
 * Board-pixel point → nearest cell index (clamped onto the board).
 * @param {Grid} g @param {number} x @param {number} y @param {number} size
 */
export function pixelToCell(g, x, y, size) {
  x -= size * SQRT3 / 2;
  y -= size;
  const fq = (SQRT3 / 3 * x - y / 3) / size;
  const fr = (2 / 3 * y) / size;
  // cube rounding
  const fs = -fq - fr;
  let rq = Math.round(fq), rr = Math.round(fr), rs = Math.round(fs);
  const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs - fs);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // clamp in offset space
  let row = Math.max(0, Math.min(g.H - 1, rr));
  let col = rq + ((row - (row & 1)) >> 1);
  col = Math.max(0, Math.min(g.W - 1, col));
  return row * g.W + col;
}

/** Screen angle (radians) of direction d. */
export function dirAngle(/** @type {number} */ d) {
  return -d * Math.PI / 3;
}
