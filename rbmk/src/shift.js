// @ts-check
// One shift: the reactor and the dispatcher, driven in fixed ticks. Pure, so
// the headless tool and the browser loop share it, and two devices stepping
// the same inputs (later co-op) stay in step.
//
// The interface changes the reactor only through `tick`'s input, which goes to
// setControls and scram. Anything that changes the passage of time (slow
// motion) belongs in sim.js, not here: every tick advances the same physics
// time.

import { createReactor, step, setControls, scram, DEFAULTS } from './sim.js';
import { createShift, updateShift, ORDER_DEFAULTS } from './orders.js';

/** Physics seconds per tick (30 a second, as Wooden Ships). */
export const TICK = 1 / 30;

/**
 * @typedef {import('./sim.js').State} Reactor
 * @typedef {import('./sim.js').SimEvent} SimEvent
 * @typedef {import('./orders.js').Shift} Shift
 * @typedef {import('./orders.js').ShiftEvent} ShiftEvent
 * @typedef {{ reactor: Reactor, shift: Shift, ticks: number }} Game
 * @typedef {{ rodsTarget?: number, pTarget?: number, scram?: boolean }} Input
 */

/**
 * A new shift. `params` may mix reactor (DEFAULTS) and dispatcher
 * (ORDER_DEFAULTS) keys; each side takes its own.
 * @param {number} seed @param {Record<string, any>} [params]
 * @returns {Game}
 */
export function createGame(seed, params = {}) {
  /** @type {Record<string, any>} */
  const sim = {};
  /** @type {Record<string, any>} */
  const orders = {};
  for (const [k, v] of Object.entries(params)) {
    if (k in DEFAULTS) sim[k] = v;
    else if (k in ORDER_DEFAULTS) orders[k] = v;
    else throw new Error(`unknown parameter ${k}`);
  }
  return { reactor: createReactor(sim), shift: createShift(seed, orders), ticks: 0 };
}

/** Whether the shift is still going (not sacked, scrammed to shutdown, or melted). @param {Game} g */
export const isOver = (g) => g.shift.status === 'sacked' || g.reactor.status === 'shutdown' || g.reactor.status === 'meltdown';

/**
 * Apply the operator's input, then advance one tick.
 * @param {Game} g @param {Input} [input]
 * @returns {{ sim: SimEvent[], shift: ShiftEvent[] }}
 */
export function tick(g, input = {}) {
  const s = g.reactor;
  if (isOver(g)) return { sim: [], shift: [] };
  setControls(s, input);
  if (input.scram) scram(s);
  const sim = step(s, TICK);
  const shift = updateShift(g.shift, s);
  g.ticks++;
  return { sim, shift };
}
