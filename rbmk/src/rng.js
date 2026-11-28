// @ts-check
// Small seeded PRNG (mulberry32), integer-only, so the dispatcher gives the
// same orders in every engine. Unlike the other toys' closures, the state is
// a plain object, so a shift can be snapshotted and replayed by copying it.

/** @typedef {{ s: number }} Rng */

/** @param {number} seed @returns {Rng} */
export const createRng = (seed) => ({ s: seed >>> 0 });

/** Next uint32. @param {Rng} rng */
export function u32(rng) {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Integer in [0, n). @param {Rng} rng @param {number} n */
export const int = (rng, n) => u32(rng) % n;

/** Integer in [lo, hi], inclusive. @param {Rng} rng @param {number} lo @param {number} hi */
export const range = (rng, lo, hi) => lo + int(rng, hi - lo + 1);
