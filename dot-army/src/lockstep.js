// @ts-check
// Deterministic lockstep for two players on separate devices.
//
// Each device runs the whole simulation. The only thing exchanged is each
// player's target cell, stamped with the tick it takes effect on. Local input
// is scheduled `delay` ticks in the future, which hides network latency, and
// a device only advances to tick T once it knows both players' inputs for T.
// Every `hashEvery` ticks each side sends a fingerprint of its state, and a
// mismatch is reported as a desync.
//
// Messages (plain JSON-able objects):
//   { k: 'in', t, c }  my input for tick t: target cell, or -1 for "no change"
//   { k: 'h', t, v }   my state hash after tick t

import { setTarget, step, stateHash } from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {{ k: 'in', t: number, c: number } | { k: 'h', t: number, v: number }} LockstepMessage */

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
  /** inputs[p]: tick → cell (-1 = no change) */
  const inputs = [new Map(), new Map()];
  /** hashes[p]: tick → state hash */
  const hashes = [new Map(), new Map()];
  /** Every input applied, in order: [tick, player, cell]. Enough to replay the game. */
  /** @type {[number, number, number][]} */
  const log = [];
  // Ticks 1..delay have no inputs from anyone: targets start where createGame put them.
  let lastSent = game.tick + delay;
  let pending = -1;
  let desyncAt = -1;

  /** The local player moved their marker. Only the latest move per tick is sent. */
  function setLocal(/** @type {number} */ cell) {
    pending = cell;
  }

  /** Send local inputs for every tick up to `delay` ahead of the simulation. */
  function pump() {
    while (lastSent < game.tick + delay) {
      lastSent++;
      inputs[localPlayer].set(lastSent, pending);
      send({ k: 'in', t: lastSent, c: pending });
      pending = -1;
    }
  }

  /** @param {LockstepMessage} msg */
  function receive(msg) {
    if (msg.k === 'in') inputs[remote].set(msg.t, msg.c);
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
      const c = inputs[p].get(t);
      inputs[p].delete(t);
      if (c !== undefined && c >= 0) {
        setTarget(game, p, c);
        log.push([t, p, c]);
      }
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
    setLocal,
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
