// @ts-check
// Small seeded PRNG (mulberry32). Integer-only state so the simulation is
// reproducible across JS engines: same seed + same inputs = same game.

/**
 * @typedef {{ next: () => number, int: (n: number) => number, state: () => number }} Rng
 */

/**
 * @param {number} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let s = seed >>> 0;
  /** @returns {number} uint32 */
  function u32() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  return {
    /** Float in [0, 1). Only used for non-gameplay-critical choices. */
    next: () => u32() / 4294967296,
    /** Integer in [0, n). */
    int: (n) => u32() % n,
    state: () => s,
  };
}
