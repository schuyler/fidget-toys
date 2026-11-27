// @ts-check
// Client side of the room relay: a Transport carried over a WebSocket to
// multiplayer/server.js or multiplayer/worker.js.

/** The relay games use unless the page says otherwise (?relay=). */
export const DEFAULT_RELAY = 'wss://fidget-rooms.erle.workers.dev';

/** Close code the relay uses for a seat that's already taken. */
export const SEAT_TAKEN = 4409;

/**
 * @typedef {{ type: 'peer-left', seat: number }
 *         | { type: 'closed', code: number, reason: string, opened: boolean }} RelayEvent
 * @typedef {{ state: 'connecting' | 'open' | 'closed', rtt: number | null, sent: number, received: number,
 *             close: { code: number, reason: string } | null }} TransportStats
 * @typedef {Object} Transport  carries a game's messages, in order, to the other device(s)
 * @property {(msg: object) => void} send
 * @property {(cb: (msg: any) => void) => void} onMessage
 * @property {(cb: (e: RelayEvent) => void) => void} onEvent
 * @property {() => TransportStats} stats
 * @property {() => void} close  leaving on purpose: reports nothing, delivers nothing more
 */

const PING_MS = 2000;

/**
 * @param {string} baseUrl  e.g. 'wss://rooms.example.com' or 'ws://localhost:8788'
 * @param {string} game @param {string} code @param {number} seat
 * @param {{ ping?: boolean }} [opts]  ping: measure round-trip time to the other seat
 * @returns {Transport}
 */
export function relayTransport(baseUrl, game, code, seat, opts = {}) {
  const ws = new WebSocket(`${baseUrl.replace(/\/$/, '')}/room/${game}/${code}?seat=${seat}`);
  /** @type {string[]} */
  let queue = [];
  /** @type {(msg: any) => void} */
  let onMsg = () => {};
  /** @type {(e: RelayEvent) => void} */
  let onEv = () => {};
  let opened = false;
  /** @type {TransportStats} */
  const st = { state: 'connecting', rtt: null, sent: 0, received: 0, close: null };
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let pinger;

  const raw = (/** @type {object} */ msg) => {
    const text = JSON.stringify({ msg });
    if (ws.readyState === WebSocket.OPEN) { ws.send(text); st.sent++; }
    else if (ws.readyState === WebSocket.CONNECTING) queue.push(text);
    // closing or closed: dropped
  };

  ws.onopen = () => {
    opened = true;
    st.state = 'open';
    for (const t of queue) { ws.send(t); st.sent++; }
    queue = [];
    if (opts.ping) pinger = setInterval(() => raw({ k: '_ping', t: performance.now() }), PING_MS);
  };
  const closed = (/** @type {number} */ code, /** @type {string} */ reason) => {
    if (st.state === 'closed') return; // report once
    queue = [];
    clearInterval(pinger);
    st.state = 'closed';
    st.close = { code, reason };
    onEv({ type: 'closed', code, reason, opened });
  };
  ws.onclose = (e) => closed(e.code, e.reason);
  // Browsers follow a failed connection with close (1006); Node's WebSocket only fires error.
  ws.onerror = () => { if (!opened) closed(1006, ''); };
  ws.onmessage = (e) => {
    let env;
    try { env = JSON.parse(e.data); } catch { return; }
    if (!env || typeof env !== 'object') return;
    st.received++;
    const msg = env.msg;
    if (env.from === -1) {
      if (msg && msg.k === 'peer-left') onEv({ type: 'peer-left', seat: msg.seat });
      return;
    }
    if (msg && msg.k === '_ping') return raw({ k: '_pong', t: msg.t });
    if (msg && msg.k === '_pong') { st.rtt = Math.round(performance.now() - msg.t); return; }
    onMsg(msg);
  };

  return {
    send: raw,
    onMessage: (f) => { onMsg = f; },
    onEvent: (f) => { onEv = f; },
    stats: () => ({ ...st, close: st.close && { ...st.close } }),
    close() {
      onMsg = () => {};
      onEv = () => {};
      clearInterval(pinger);
      ws.close();
    },
  };
}
