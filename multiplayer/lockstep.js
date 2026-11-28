// @ts-check
// Deterministic tick lockstep for players on separate devices.
//
// Each device runs the whole simulation. The only thing exchanged is each
// seat's inputs, stamped with the tick they take effect on. Local input is
// scheduled `delay` ticks in the future, which hides network latency, and a
// device only advances to tick T once it knows every seat's inputs for T.
// Every `hashEvery` ticks each seat sends a fingerprint of its state, and a
// mismatch is reported as a desync.
//
// The game comes in as an adapter, so the same code runs Dot Army and Wooden
// Ships. Its simulation must be deterministic: same inputs, same state, on
// every device.
//
// Messages (plain JSON-able objects; the transport says who sent them):
//   { k: 'in', s, t, i }  seat s's inputs for tick t, an array ([] for no change)
//   { k: 'h', s, t, v }   seat s's state hash after tick t

/**
 * @template G, I, E
 * @typedef {{
 *   applyInput: (game: G, seat: number, input: I) => boolean | void,
 *   step: (game: G) => E,
 *   hash: (game: G) => number,
 *   tick: (game: G) => number,
 *   merge?: (pending: I[], input: I) => boolean,
 * }} Adapter
 * applyInput: false means the input was rejected and stays out of the log
 * (undefined counts as accepted). merge: fold `input` into the inputs already
 * pending for the next send; true if it did, false to append it.
 */

/**
 * @template I
 * @typedef {{ k: 'in', s: number, t: number, i: I[] } | { k: 'h', s: number, t: number, v: number }} LockstepMessage
 */

/**
 * @template G, I, E
 * @param {G} game
 * @param {Adapter<G, I, E>} adapter
 * @param {number} localSeat
 * @param {(msg: LockstepMessage<I>) => void} send
 * @param {{ seats?: number, delay?: number, hashEvery?: number }} [opts]
 */
export function createLockstep(game, adapter, localSeat, send, opts = {}) {
  const seats = opts.seats ?? 2;
  const delay = opts.delay ?? 3;
  const hashEvery = opts.hashEvery ?? 8;
  const { applyInput, step, hash, tick, merge } = adapter;
  /** @type {Map<number, I[]>[]} inputs[s]: tick → that seat's inputs, in order */
  const inputs = Array.from({ length: seats }, () => new Map());
  /** @type {Map<number, number>[]} hashes[s]: tick → state hash */
  const hashes = Array.from({ length: seats }, () => new Map());
  /** Every input applyInput accepted, in order: [tick, seat, input]. Enough to replay the game. */
  /** @type {[number, number, I][]} */
  const log = [];
  // Ticks 1..delay have no inputs from anyone.
  let lastSent = tick(game) + delay;
  /** @type {I[]} */
  let pending = [];
  let desyncAt = -1;

  /** Queue a local input for the next tick to be sent. @param {I} input */
  function queue(input) {
    if (merge && merge(pending, input)) return;
    pending.push(input);
  }

  /** Send local inputs for every tick up to `delay` ahead of the simulation. */
  function pump() {
    while (lastSent < tick(game) + delay) {
      lastSent++;
      inputs[localSeat].set(lastSent, pending);
      send({ k: 'in', s: localSeat, t: lastSent, i: pending });
      pending = [];
    }
  }

  /**
   * A message from another seat. One that claims the local seat or no seat
   * at all is dropped.
   * @param {LockstepMessage<I>} msg
   */
  function receive(msg) {
    const s = msg.s;
    if (s === localSeat || !(s >= 0 && s < seats)) return;
    if (msg.k === 'in') inputs[s].set(msg.t, msg.i);
    else if (msg.k === 'h') { hashes[s].set(msg.t, msg.v); check(msg.t); }
  }

  /** Can the next tick be simulated yet? */
  function ready() {
    const t = tick(game) + 1;
    return t <= delay || inputs.every((m) => m.has(t));
  }

  /** Simulate the next tick. Call only when ready(). */
  function advance() {
    const t = tick(game) + 1;
    for (let s = 0; s < seats; s++) {
      const list = inputs[s].get(t);
      inputs[s].delete(t);
      for (const input of list ?? []) if (applyInput(game, s, input) !== false) log.push([t, s, input]);
    }
    const ev = step(game);
    const now = tick(game);
    if (now % hashEvery === 0) {
      const v = hash(game);
      hashes[localSeat].set(now, v);
      send({ k: 'h', s: localSeat, t: now, v });
      check(now);
    }
    return ev;
  }

  function check(/** @type {number} */ t) {
    if (!hashes.every((m) => m.has(t))) return;
    const v = hashes[0].get(t);
    if (desyncAt < 0 && hashes.some((m) => m.get(t) !== v)) desyncAt = t;
    for (const m of hashes) m.delete(t);
  }

  return {
    queue,
    pump,
    receive,
    ready,
    advance,
    log,
    delay,
    /** Tick at which the devices first disagreed, or -1. */
    get desyncAt() { return desyncAt; },
  };
}
