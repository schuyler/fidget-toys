// @ts-check
// Transports carry messages between the two devices in a network game.
// Lockstep doesn't care what carries them, as long as each direction is
// delivered in order.

/** Bump when anything that affects the simulation or the protocol changes. */
export const PROTOCOL = 1;

/**
 * @typedef {Object} Transport
 * @property {(msg: object) => void} send
 * @property {(cb: (msg: any) => void) => void} onMessage
 * @property {() => void} close
 */

/**
 * Development transport: two tabs in the same browser talk over a
 * BroadcastChannel. No server involved.
 * @param {string} room @param {'host'|'guest'} role
 * @returns {Transport}
 */
export function broadcastTransport(room, role) {
  const ch = new BroadcastChannel(`dot-army:${room}`);
  /** @type {(msg: any) => void} */
  let cb = () => {};
  ch.onmessage = (e) => { if (e.data && e.data.from !== role) cb(e.data.msg); };
  return {
    send: (msg) => ch.postMessage({ from: role, msg }),
    onMessage: (f) => { cb = f; },
    close: () => ch.close(),
  };
}

/** A short, unambiguous room code (no 0/O, 1/I/L). */
export function roomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
