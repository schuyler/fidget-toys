// @ts-check
// Development transport: two tabs in the same browser talk over a
// BroadcastChannel (?relay=bc in the games). No server involved, so no
// peer-left or close events.

/** @typedef {import('./relay.js').Transport} Transport */

/**
 * @param {string} game  keeps different games' rooms apart, like the relay's path
 * @param {string} room @param {number} seat
 * @returns {Transport}
 */
export function broadcastTransport(game, room, seat) {
  const ch = new BroadcastChannel(`${game}:${room}`);
  /** @type {(msg: any) => void} */
  let cb = () => {};
  let sent = 0, received = 0;
  ch.onmessage = (e) => { if (e.data && e.data.from !== seat) { received++; cb(e.data.msg); } };
  return {
    send: (msg) => { sent++; ch.postMessage({ from: seat, msg }); },
    onMessage: (f) => { cb = f; },
    onEvent: () => {},
    stats: () => ({ state: 'open', rtt: null, sent, received, close: null }),
    close: () => { cb = () => {}; ch.close(); },
  };
}
