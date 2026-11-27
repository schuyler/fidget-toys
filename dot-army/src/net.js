// @ts-check
// Dot Army's protocol version, and the development transport. The relay
// transport lives in multiplayer/relay.js.

/** Bump when anything that affects the simulation or the protocol changes. */
export const PROTOCOL = 2;

/** @typedef {import('../../multiplayer/relay.js').Transport} Transport */

/**
 * Development transport: two tabs in the same browser talk over a
 * BroadcastChannel. No server involved, so no peer-left or close events.
 * @param {string} room @param {'host'|'guest'} role
 * @returns {Transport}
 */
export function broadcastTransport(room, role) {
  const ch = new BroadcastChannel(`dot-army:${room}`);
  /** @type {(msg: any) => void} */
  let cb = () => {};
  let sent = 0, received = 0;
  ch.onmessage = (e) => { if (e.data && e.data.from !== role) { received++; cb(e.data.msg); } };
  return {
    send: (msg) => { sent++; ch.postMessage({ from: role, msg }); },
    onMessage: (f) => { cb = f; },
    onEvent: () => {},
    stats: () => ({ state: 'open', rtt: null, sent, received, close: null }),
    close: () => { cb = () => {}; ch.close(); },
  };
}
