// @ts-check
// Client side of the room relay: the same Transport interface as
// dot-army/src/net.js, carried over a WebSocket to multiplayer/server.js or
// multiplayer/worker.js.

/**
 * @param {string} baseUrl  e.g. 'wss://rooms.example.com' or 'ws://localhost:8788'
 * @param {string} game @param {string} code @param {number} seat
 * @returns {import('../dot-army/src/net.js').Transport}
 */
export function relayTransport(baseUrl, game, code, seat) {
  const ws = new WebSocket(`${baseUrl.replace(/\/$/, '')}/room/${game}/${code}?seat=${seat}`);
  /** @type {string[]} */
  let queue = [];
  /** @type {(msg: any) => void} */
  let cb = () => {};
  ws.onopen = () => { for (const t of queue) ws.send(t); queue = []; };
  ws.onclose = () => { queue = []; };
  ws.onmessage = (e) => {
    let env;
    try { env = JSON.parse(e.data); } catch { return; }
    if (env && env.from >= 0) cb(env.msg); // server events (from: -1) aren't used yet
  };
  return {
    send(msg) {
      const text = JSON.stringify({ msg });
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(text);
      // closing or closed: dropped
    },
    onMessage: (f) => { cb = f; },
    close: () => ws.close(),
  };
}
