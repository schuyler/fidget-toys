// @ts-check
// Deterministic lockstep for two players on separate devices.
//
// Each device runs the whole simulation. The only thing exchanged is each
// player's target inputs (add, remove, move), stamped with the tick they take effect on. Local input
// is scheduled `delay` ticks in the future, which hides network latency, and
// a device only advances to tick T once it knows both players' inputs for T.
// Every `hashEvery` ticks each side sends a fingerprint of its state, and a
// mismatch is reported as a desync.
//
// Messages (plain JSON-able objects):
//   { k: 'in', t, i }  my inputs for tick t: an Input[] (see sim.js), [] for no change
//   { k: 'h', t, v }   my state hash after tick t

import { applyInput, step, stateHash } from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Input} Input */
/** @typedef {{ k: 'in', t: number, i: Input[] } | { k: 'h', t: number, v: number }} LockstepMessage */

/**
 * @param {Game} game
 * @param {number} localPlayer  0 (blue, host) or 1 (red, guest)
 * @param {(msg: LockstepMessage) => void} send
 * @param {{ delay?: number, hashEvery?: number }} [opts]
 */
export function createLockstep(game, localPlayer, send, opts = {}) {
  const delay = opts.delay ?? 3;
  const hashEvery = opts.hashEvery ?? 8;
  const remote = 1 - localPlayer;
  /** @type {Map<number, Input[]>[]} inputs[p]: tick → that player's inputs, in order */
  const inputs = [new Map(), new Map()];
  /** hashes[p]: tick → state hash */
  const hashes = [new Map(), new Map()];
  /** Every input applyInput accepted, in order: [tick, player, input]. Enough to replay the game. */
  /** @type {[number, number, Input][]} */
  const log = [];
  // Ticks 1..delay have no inputs from anyone: targets start where createGame put them.
  let lastSent = game.tick + delay;
  /** @type {Input[]} */
  let pending = [];
  let desyncAt = -1;

  /**
   * Queue a local input for the next tick to be sent. A move replaces an
   * earlier pending move of the same index if no add or remove came between
   * them (indices haven't shifted, and all of a tick's inputs apply before the
   * step), so a long drag before the first send stays one input.
   * @param {Input} input
   */
  function queue(input) {
    if (input.op === 'move') {
      for (let k = pending.length - 1; k >= 0; k--) {
        const q = pending[k];
        if (q.op !== 'move') break;
        if (q.index === input.index) { pending[k] = input; return; }
      }
    }
    pending.push(input);
  }

  /** Send local inputs for every tick up to `delay` ahead of the simulation. */
  function pump() {
    while (lastSent < game.tick + delay) {
      lastSent++;
      inputs[localPlayer].set(lastSent, pending);
      send({ k: 'in', t: lastSent, i: pending });
      pending = [];
    }
  }

  /** @param {LockstepMessage} msg */
  function receive(msg) {
    if (msg.k === 'in') inputs[remote].set(msg.t, msg.i);
    else if (msg.k === 'h') { hashes[remote].set(msg.t, msg.v); check(msg.t); }
  }

  /** Can the next tick be simulated yet? */
  function ready() {
    const t = game.tick + 1;
    return t <= delay || (inputs[0].has(t) && inputs[1].has(t));
  }

  /** Simulate the next tick. Call only when ready(). */
  function advance() {
    const t = game.tick + 1;
    for (let p = 0; p < 2; p++) {
      const list = inputs[p].get(t);
      inputs[p].delete(t);
      for (const input of list ?? []) if (applyInput(game, p, input)) log.push([t, p, input]);
    }
    const ev = step(game);
    if (game.tick % hashEvery === 0) {
      const v = stateHash(game);
      hashes[localPlayer].set(game.tick, v);
      send({ k: 'h', t: game.tick, v });
      check(game.tick);
    }
    return ev;
  }

  function check(/** @type {number} */ t) {
    const a = hashes[0].get(t), b = hashes[1].get(t);
    if (a === undefined || b === undefined) return;
    if (a !== b && desyncAt < 0) desyncAt = t;
    hashes[0].delete(t);
    hashes[1].delete(t);
  }

  return {
    queue,
    pump,
    receive,
    ready,
    advance,
    log,
    delay,
    /** Tick at which the two devices first disagreed, or -1. */
    get desyncAt() { return desyncAt; },
  };
}
