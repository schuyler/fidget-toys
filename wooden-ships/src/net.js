// @ts-check
// Wooden Ships' protocol version and its game adapter for the shared tick
// lockstep in multiplayer/lockstep.js, which describes the protocol.

import { createLockstep as createShared } from '../../multiplayer/lockstep.js';
import { applyInput, step, stateHash } from './sim.js';

/** Bump when anything that affects the simulation or the protocol changes. */
export const PROTOCOL = 2; // 2: the host's input delay travels in `start`

/**
 * Input delay in ticks: 4 at 30 ticks a second is 133 ms, which covers the
 * relay's round trip on most connections and is short next to how slowly a
 * ship answers her rudder.
 */
export const DELAY = 4;

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Input} Input */
/** @typedef {import('../../multiplayer/lockstep.js').LockstepMessage<Input>} LockstepMessage */

/**
 * The rudder is a position, not a change, so a newer rudder input replaces
 * any still waiting to be sent. Fire inputs are kept.
 * @param {Input[]} pending @param {Input} input
 */
function merge(pending, input) {
  if (input.type !== 'rudder') return false;
  const k = pending.findIndex((q) => q.type === 'rudder');
  if (k < 0) return false;
  pending[k] = input;
  return true;
}

/** @type {import('../../multiplayer/lockstep.js').Adapter<Game, Input, ReturnType<typeof step>>} */
const adapter = { applyInput, step, hash: stateHash, tick: (g) => g.tick, merge };

/**
 * @param {Game} game
 * @param {number} localShip  0 (blue, host) or 1 (red, guest)
 * @param {(msg: LockstepMessage) => void} send
 * @param {{ delay?: number, hashEvery?: number }} [opts]
 */
export function createLockstep(game, localShip, send, opts = {}) {
  return createShared(game, adapter, localShip, send, { ...opts, delay: opts.delay ?? DELAY });
}
