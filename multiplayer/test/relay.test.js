import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../server.js';
import { relayTransport } from '../relay.js';

// relay.js uses the global WebSocket, which in Node sends no Origin header.
// Give it one, as a browser would, without touching relay.js.
const NodeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url) { super(url, { headers: { Origin: 'http://127.0.0.1:8765' } }); }
};

let server, base;
before(async () => {
  server = await start({ port: 0, host: '127.0.0.1', allowedOrigins: ['http://127.0.0.1:*'] });
  base = `ws://127.0.0.1:${server.port}`;
});
after(() => server?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}
/** A transport plus everything it reported. */
function open(code, seat, opts) {
  const t = relayTransport(base, 'test', code, seat, opts);
  const events = [], messages = [];
  t.onEvent((e) => events.push(e));
  t.onMessage((m) => messages.push(m));
  return { t, events, messages };
}

test('R4: the other seat leaving is reported as peer-left', async () => {
  const a = open('LEFT', 0), b = open('LEFT', 1);
  assert.ok(await until(() => a.t.stats().state === 'open' && b.t.stats().state === 'open'));
  b.t.close();
  assert.ok(await until(() => a.events.length > 0));
  assert.deepEqual(a.events, [{ type: 'peer-left', seat: 1 }]);
  a.t.close();
});

test('R5: a taken seat is reported as closed with 4409', async () => {
  const a = open('FULL', 0);
  assert.ok(await until(() => a.t.stats().state === 'open'));
  const c = open('FULL', 0);
  assert.ok(await until(() => c.events.length > 0));
  assert.equal(c.events[0].type, 'closed');
  assert.equal(c.events[0].code, 4409);
  assert.equal(c.events[0].opened, true); // the handshake completes before the close
  assert.equal(c.t.stats().state, 'closed');
  assert.equal(c.t.stats().close?.code, 4409);
  a.t.close();
});

test('R5: an unreachable relay is reported as closed without ever opening', async () => {
  const t = relayTransport('ws://127.0.0.1:1', 'test', 'NOPE', 0);
  const events = [];
  t.onEvent((e) => events.push(e));
  assert.ok(await until(() => events.length > 0));
  assert.equal(events[0].type, 'closed');
  assert.equal(events[0].opened, false);
  assert.notEqual(events[0].code, 4409);
});

test('R6: closing your own transport reports nothing and delivers nothing more', async () => {
  const a = open('MINE', 0), b = open('MINE', 1);
  assert.ok(await until(() => a.t.stats().state === 'open' && b.t.stats().state === 'open'));
  b.t.close();
  a.t.send({ late: true });
  await sleep(300);
  assert.deepEqual(b.events, []);
  assert.deepEqual(b.messages, []);
  a.t.close();
});

test('R7: stats count messages, and pings measure round-trip time without reaching the game', async () => {
  const a = open('PING', 0, { ping: true }), b = open('PING', 1, { ping: true });
  assert.ok(await until(() => a.t.stats().state === 'open' && b.t.stats().state === 'open'));
  for (let i = 0; i < 3; i++) a.t.send({ n: i });
  assert.ok(await until(() => a.t.stats().rtt !== null, 5000), 'rtt measured within 5 s');
  assert.ok(Number.isFinite(a.t.stats().rtt) && a.t.stats().rtt >= 0);
  assert.deepEqual(b.messages, [{ n: 0 }, { n: 1 }, { n: 2 }]); // no _ping / _pong
  assert.ok(a.t.stats().sent >= 3);
  assert.ok(b.t.stats().received >= 3);
  a.t.close(); b.t.close();
});
