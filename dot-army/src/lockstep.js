// @ts-check
// Dot Army's game adapter for the shared tick lockstep in
// multiplayer/lockstep.js, which describes the protocol.

import { createLockstep as createShared } from '../../multiplayer/lockstep.js';
import { applyInput, step, stateHash } from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Input} Input */
/** @typedef {import('../../multiplayer/lockstep.js').LockstepMessage<Input>} LockstepMessage */

/**
 * A move replaces an earlier pending move of the same index if no add or
 * remove came between them (indices haven't shifted, and all of a tick's
 * inputs apply before the step), so a long drag before the first send stays
 * one input.
 * @param {Input[]} pending @param {Input} input
 */
function merge(pending, input) {
  if (input.op !== 'move') return false;
  for (let k = pending.length - 1; k >= 0; k--) {
    const q = pending[k];
    if (q.op !== 'move') return false;
    if (q.index === input.index) { pending[k] = input; return true; }
  }
  return false;
}

/** @type {import('../../multiplayer/lockstep.js').Adapter<Game, Input, ReturnType<typeof step>>} */
const adapter = { applyInput, step, hash: stateHash, tick: (g) => g.tick, merge };

/**
 * @param {Game} game
 * @param {number} localPlayer  0 (blue, host) or 1 (red, guest)
 * @param {(msg: LockstepMessage) => void} send
 * @param {{ delay?: number, hashEvery?: number }} [opts]
 */
export function createLockstep(game, localPlayer, send, opts = {}) {
  return createShared(game, adapter, localPlayer, send, opts);
}
