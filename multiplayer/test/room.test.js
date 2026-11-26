import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, parseRequest, originAllowed, MAX_BYTES, MAX_PER_SECOND } from '../room.js';

/** A fake socket: records what it was sent and how it was closed. */
function fakeConn() {
  return {
    sent: /** @type {any[]} */ ([]),
    closed: /** @type {null | { code: number, reason: string }} */ (null),
    send(text) { this.sent.push(JSON.parse(text)); },
    close(code, reason) { this.closed = { code, reason }; },
  };
}

/** A room with `n` seats filled, and a controllable clock. */
function roomWith(n) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const room = createRoom({ now: clock.now });
  const conns = [];
  for (let s = 0; s < n; s++) {
    const c = fakeConn();
    assert.equal(room.join(s, c), 'ok');
    conns.push(c);
  }
  return { room, conns, clock };
}

// R4 -----------------------------------------------------------------------

test('R4: a message goes to every other seat, tagged with the sender, and not back to the sender', () => {
  const { room, conns: [a, b, c] } = roomWith(3);
  room.message(a, JSON.stringify({ msg: { k: 'in', t: 4, c: 17 } }));
  assert.deepEqual(b.sent, [{ from: 0, msg: { k: 'in', t: 4, c: 17 } }]);
  assert.deepEqual(c.sent, [{ from: 0, msg: { k: 'in', t: 4, c: 17 } }]);
  assert.deepEqual(a.sent, []);
});

test('R4: `to` delivers to that seat only', () => {
  const { room, conns: [a, b, c] } = roomWith(3);
  room.message(b, JSON.stringify({ to: 2, msg: 'secret' }));
  assert.deepEqual(c.sent, [{ from: 1, msg: 'secret' }]);
  assert.deepEqual(a.sent, []);
  assert.deepEqual(b.sent, []);
});

test('R4: when a seat leaves, the others get peer-left and the seat is free again', () => {
  const { room, conns: [a, b, c] } = roomWith(3);
  room.leave(b);
  assert.deepEqual(a.sent, [{ from: -1, msg: { k: 'peer-left', seat: 1 } }]);
  assert.deepEqual(c.sent, [{ from: -1, msg: { k: 'peer-left', seat: 1 } }]);
  assert.equal(room.size(), 2);
  assert.equal(room.has(1), false);
  assert.equal(room.join(1, fakeConn()), 'ok');
});

// R3 (room core part) ------------------------------------------------------

test('R3: a second connection for a taken seat is refused', () => {
  const room = createRoom({});
  assert.equal(room.join(0, fakeConn()), 'ok');
  assert.equal(room.has(0), true);
  assert.equal(room.join(0, fakeConn()), 'taken');
  assert.equal(room.size(), 1);
});

test('R3: requests are keyed by game, code and seat', () => {
  assert.deepEqual(parseRequest(new URL('ws://h/room/dot-army/ABCD?seat=1')), { game: 'dot-army', code: 'ABCD', seat: 1 });
  assert.deepEqual(parseRequest(new URL('ws://h/room/coreward-bound/ABCD?seat=0')), { game: 'coreward-bound', code: 'ABCD', seat: 0 });
});

// R5 -----------------------------------------------------------------------

test('R5: only allowed origins pass; a missing Origin is refused', () => {
  const allow = ['https://schuyler.info', 'http://localhost:*'];
  assert.equal(originAllowed('https://schuyler.info', allow), true);
  assert.equal(originAllowed('http://localhost:8765', allow), true);
  assert.equal(originAllowed('https://evil.example', allow), false);
  assert.equal(originAllowed('https://schuyler.info.evil.example', allow), false);
  assert.equal(originAllowed('http://localhost:8765.evil.example', allow), false);
  assert.equal(originAllowed(null, allow), false);
});

test('R5: an oversized message closes the socket and is not forwarded', () => {
  const { room, conns: [a, b] } = roomWith(2);
  room.message(a, JSON.stringify({ msg: 'x'.repeat(MAX_BYTES) }));
  assert.equal(a.closed?.code, 1009);
  assert.deepEqual(b.sent.filter((m) => m.from !== -1), []);
});

test('R5: a flood closes the socket; frames that arrive after the close are ignored without throwing', () => {
  const { room, conns: [a, b] } = roomWith(2);
  for (let i = 0; i < MAX_PER_SECOND; i++) room.message(a, JSON.stringify({ msg: i }));
  assert.equal(a.closed, null);
  room.message(a, JSON.stringify({ msg: 'one too many' }));
  assert.equal(a.closed?.code, 1008);
  // ws keeps delivering frames it already parsed after close()
  for (let i = 0; i < 10; i++) room.message(a, JSON.stringify({ msg: 'late' }));
  const relayed = b.sent.filter((m) => m.from === 0).map((m) => m.msg);
  assert.equal(relayed.length, MAX_PER_SECOND);
  assert.ok(!relayed.includes('one too many') && !relayed.includes('late'));
});

test('R5: binary frames count toward the flood limit', () => {
  const { room, conns: [a] } = roomWith(2);
  for (let i = 0; i <= MAX_PER_SECOND; i++) room.message(a, null);
  assert.equal(a.closed?.code, 1008);
});

test('R5: a steady rate under the cap is never cut off (the window is per second, not per lifetime)', () => {
  const { room, conns: [a, b], clock } = roomWith(2);
  for (let sec = 0; sec < 3; sec++) {
    for (let i = 0; i < MAX_PER_SECOND; i++) room.message(a, JSON.stringify({ msg: i }));
    clock.advance(1001);
  }
  assert.equal(a.closed, null);
  assert.equal(b.sent.length, 3 * MAX_PER_SECOND);
});
