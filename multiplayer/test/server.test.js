import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { start } from '../server.js';

const ORIGIN = 'http://127.0.0.1:8765';
let server, base;

before(async () => {
  server = await start({ port: 0, host: '127.0.0.1', allowedOrigins: ['http://127.0.0.1:*'] });
  base = `ws://127.0.0.1:${server.port}`;
});
after(() => server?.close());

/** Connect; resolves { ws, status: 101 } on success or { status } on refusal. */
function connect(path, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + path, origin === null ? {} : { headers: { Origin: origin } });
    ws.on('open', () => resolve({ ws, status: 101 }));
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); ws.terminate(); });
    ws.on('error', reject);
  });
}

/** Messages a socket receives over the next `ms` milliseconds. */
function collect(ws, ms = 200) {
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  return new Promise((r) => setTimeout(() => r(got), ms));
}

test('R3: rooms with the same code under different games are separate', async () => {
  const a0 = await connect('/room/game-a/SAME?seat=0');
  const a1 = await connect('/room/game-a/SAME?seat=1');
  const b0 = await connect('/room/game-b/SAME?seat=0');
  const b1 = await connect('/room/game-b/SAME?seat=1');
  for (const c of [a0, a1, b0, b1]) assert.equal(c.status, 101);
  const gotA = collect(a1.ws), gotB = collect(b1.ws);
  a0.ws.send(JSON.stringify({ msg: { hello: 'a' } }));
  assert.deepEqual(await gotA, [{ from: 0, msg: { hello: 'a' } }]);
  assert.deepEqual(await gotB, []);
  for (const c of [a0, a1, b0, b1]) c.ws.close();
});

test('R3: a second connection for a taken seat is refused with 409', async () => {
  const first = await connect('/room/game-a/TAKEN?seat=0');
  assert.equal(first.status, 101);
  const second = await connect('/room/game-a/TAKEN?seat=0');
  assert.equal(second.status, 409);
  first.ws.close();
});

test('R5: a disallowed or missing Origin is refused with 403', async () => {
  assert.equal((await connect('/room/game-a/ORIG?seat=0', 'https://evil.example')).status, 403);
  assert.equal((await connect('/room/game-a/ORIG?seat=0', null)).status, 403);
});
