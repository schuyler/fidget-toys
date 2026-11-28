import test from 'node:test';
import assert from 'node:assert/strict';
import { createLockstep } from '../lockstep.js';

// A toy game: each seat has a counter that inputs add to, and step() mixes
// them into a running total, so order and timing of inputs both matter.
const toy = {
  applyInput: (g, seat, n) => { if (n < 0) return false; g.c[seat] += n; },
  step: (g) => { g.tick++; g.total = (g.total * 31 + g.c.reduce((a, b) => a + b, 0)) >>> 0; return g.tick; },
  hash: (g) => g.total,
  tick: (g) => g.tick,
};
const newToy = (seats) => ({ tick: 0, total: 0, c: new Array(seats).fill(0) });

/** N devices joined by an in-order network that delivers each message after `lag` frames. */
function devices(seats, lag = 2) {
  const inflight = Array.from({ length: seats }, () => []);
  let now = 0;
  const ds = Array.from({ length: seats }, (_, s) => {
    const game = newToy(seats);
    const ls = createLockstep(game, toy, s, (msg) => {
      for (let o = 0; o < seats; o++) if (o !== s) inflight[o].push({ at: now + lag, msg: JSON.parse(JSON.stringify(msg)) });
    }, { seats });
    return { game, ls };
  });
  return {
    ds,
    frame() {
      now++;
      ds.forEach((d, i) => { while (inflight[i].length && inflight[i][0].at <= now) d.ls.receive(inflight[i].shift().msg); });
      for (const d of ds) { d.ls.pump(); if (d.ls.ready()) d.ls.advance(); }
    },
  };
}

test('three seats stay in step and agree', () => {
  const net = devices(3);
  for (let f = 0; f < 200; f++) {
    net.ds.forEach((d, s) => { if (f % (s + 2) === 0) d.ls.queue(s + 1); });
    net.frame();
  }
  const [a, ...rest] = net.ds;
  assert.ok(a.game.tick > 150);
  for (const d of rest) {
    assert.ok(Math.abs(a.game.tick - d.game.tick) <= 3);
    assert.equal(d.ls.desyncAt, -1);
  }
  assert.equal(a.ls.desyncAt, -1);
  assert.ok(a.ls.log.some(([, s]) => s === 2), 'inputs from every seat were applied');
});

test('a tick waits for every seat', () => {
  const net = devices(3);
  net.ds[2].ls.pump = () => {}; // seat 2 never sends
  for (let f = 0; f < 50; f++) net.frame();
  assert.equal(net.ds[0].game.tick, net.ds[0].ls.delay);
});

test('rejected inputs stay out of the log; merge folds pending inputs', () => {
  const game = newToy(2);
  const sent = [];
  const ls = createLockstep(game, { ...toy, merge: (p, n) => (p.length ? ((p[p.length - 1] += n), true) : false) }, 0, (m) => sent.push(m));
  ls.queue(2); ls.queue(3); ls.queue(-1);
  ls.advance(); // tick 1 needs no inputs
  ls.pump();
  const first = sent.find((m) => m.k === 'in' && m.i.length);
  assert.deepEqual(first.i, [4]); // 2 + 3 + -1 folded into one
  ls.receive({ k: 'in', s: 1, t: ls.delay + 1, i: [-5] });
  while (game.tick <= ls.delay) { assert.ok(ls.ready()); ls.advance(); }
  assert.deepEqual(ls.log, [[ls.delay + 1, 0, 4]]);
});

test('messages claiming the local seat or no seat are ignored', () => {
  const game = newToy(2);
  const ls = createLockstep(game, toy, 0, () => {});
  for (let k = 1; k <= ls.delay; k++) ls.advance();
  ls.pump();
  const t = ls.delay + 1;
  ls.receive({ k: 'in', s: 0, t, i: [9] });
  ls.receive({ k: 'in', s: 7, t, i: [9] });
  assert.equal(ls.ready(), false);
  ls.receive({ k: 'in', s: 1, t, i: [] });
  assert.equal(ls.ready(), true);
});

test('a hash mismatch from any seat is a desync', () => {
  const game = newToy(3);
  const ls = createLockstep(game, toy, 0, () => {}, { seats: 3, delay: 1, hashEvery: 1 });
  ls.pump();
  ls.advance();
  ls.receive({ k: 'h', s: 1, t: 1, v: game.total });
  assert.equal(ls.desyncAt, -1);
  ls.receive({ k: 'h', s: 2, t: 1, v: game.total + 1 });
  assert.equal(ls.desyncAt, 1);
});
