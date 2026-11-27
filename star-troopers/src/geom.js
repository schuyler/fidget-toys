// Pixel geometry for the board: presentation only, so floats are fine here.
// The same pointy-top, odd-r layout as hex.js; adapted from dot-army/src/hex.js.

/** @typedef {import('./hex.js').Grid} Grid */

const SQRT3 = Math.sqrt(3);

/** Centre of a cell in board pixels, for hexes of circumradius `size`. */
export function cellCenter(/** @type {Grid} */ g, /** @type {number} */ i, /** @type {number} */ size) {
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
 * Board-pixel point → the cell under it, or -1 if it's off the board (more
 * than a hex radius from the nearest cell's centre).
 * @param {Grid} g @param {number} x @param {number} y @param {number} size
 */
export function pixelToCell(g, x, y, size) {
  const x0 = x - size * SQRT3 / 2, y0 = y - size;
  const fq = (SQRT3 / 3 * x0 - y0 / 3) / size;
  const fr = (2 / 3 * y0) / size;
  const fs = -fq - fr;
  let rq = Math.round(fq), rr = Math.round(fr);
  const rs = Math.round(fs);
  const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs - fs);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  const row = Math.max(0, Math.min(g.H - 1, rr));
  const col = Math.max(0, Math.min(g.W - 1, rq + ((row - (row & 1)) >> 1)));
  const cell = row * g.W + col;
  const [cx, cy] = cellCenter(g, cell, size);
  return Math.hypot(cx - x, cy - y) <= size ? cell : -1;
}
