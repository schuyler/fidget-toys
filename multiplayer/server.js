// The room relay as a plain Node server, for hosting at home behind a
// TLS-terminating reverse proxy.
//
//   PORT=8788 HOST=127.0.0.1 ALLOWED_ORIGINS=https://example.com node server.js

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRoom, parseRequest, originAllowed, parseOrigins, MAX_BYTES } from './room.js';

/**
 * @param {{ port?: number, host?: string, allowedOrigins?: string[] }} [opts]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function start(opts = {}) {
  const allow = opts.allowedOrigins ?? parseOrigins(undefined);
  /** @type {Map<string, ReturnType<typeof createRoom>>} */
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });

  const refuse = (/** @type {import('node:stream').Duplex} */ socket, /** @type {number} */ status) => {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const server = http.createServer((req, res) => {
    const ok = parseRequest(new URL(req.url ?? '/', 'http://x'));
    res.writeHead(ok ? 426 : 400).end();
  });

  server.on('upgrade', (req, socket, head) => {
    // Node drops its own error handler before 'upgrade'; without one, a client that
    // resets the connection after being refused crashes the whole process.
    socket.on('error', () => {});
    const r = parseRequest(new URL(req.url ?? '/', 'http://x'));
    if (!r) return refuse(socket, 400);
    if (!originAllowed(req.headers.origin ?? null, allow)) return refuse(socket, 403);
    const key = `${r.game}/${r.code}`;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A taken seat completes the handshake and is closed with 4409, because a
      // browser can't see the HTTP status of a refused handshake.
      if (rooms.get(key)?.has(r.seat)) {
        ws.on('error', () => {}); // a bad frame before the close lands must not crash the server
        return ws.close(4409, 'seat taken');
      }
      // Created only once the handshake succeeded, so failed ones leave nothing behind.
      let room = rooms.get(key);
      if (!room) rooms.set(key, room = createRoom());
      const theRoom = room;
      theRoom.join(r.seat, ws);
      ws.on('message', (data, isBinary) => theRoom.message(ws, isBinary ? null : data.toString()));
      const gone = () => {
        theRoom.leave(ws);
        if (theRoom.size() === 0 && rooms.get(key) === theRoom) rooms.delete(key);
      };
      ws.on('close', gone);
      ws.on('error', gone);
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 8788, opts.host ?? '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port: addr.port,
        close: () => new Promise((done) => {
          for (const ws of wss.clients) ws.terminate();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await start({
    port: Number(process.env.PORT ?? 8788),
    host: process.env.HOST ?? '127.0.0.1',
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  });
  console.log(`room relay listening on ${process.env.HOST ?? '127.0.0.1'}:${s.port}`);
}
