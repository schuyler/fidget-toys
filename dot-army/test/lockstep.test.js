import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stateHash } from '../src/sim.js';
import { createLockstep } from '../src/lockstep.js';
import { createAI } from '../src/ai.js';
import { createRng } from '../src/rng.js';

/**
 * Two devices, each with its own copy of the game and a CPU player driving
 * its local input, joined by a fake network that delivers messages in order
 * after a random lag (measured in "frames" of the test loop).
 */
function twoDevices({ seed = 5, maxLag = 6, rngSeed = 99 } = {}) {
  const net = createRng(rngSeed);
  const inflight = [[], []]; // messages travelling *to* device i: {at, msg}
  let now = 0;
  const devices = [0, 1].map((p) => {
    const game = createGame({ seed, width: 40, height: 26 });
    const ai = createAI(p, seed * 31 + p, { dragSpeed: 2.2 });
    const ls = createLockstep(game, p, (msg) => {
      const q = inflight[1 - p];
      const last = q.length ? q[q.length - 1].at : now;
      q.push({ at: Math.max(last, now + 1 + net.int(maxLag)), msg }); // in order, like a WebSocket
    });
    return { p, game, ai, ls };
  });
  return {
    devices,
    /** One frame: deliver due messages, then each device thinks, sends, and steps at most once. */
    frame({ blockTo = -1 } = {}) {
      now++;
      for (let i = 0; i < 2; i++) {
        if (i === blockTo) continue;
        while (inflight[i].length && inflight[i][0].at <= now) devices[i].ls.receive(inflight[i].shift().msg);
      }
      for (const d of devices) {
        for (const inp of d.ai.think(d.game)) d.ls.queue(inp);
        d.ls.pump();
        if (d.ls.ready()) d.ls.advance();
      }
    },
  };
}

test('two devices with laggy links stay in perfect sync', () => {
  const net = twoDevices();
  const [a, b] = net.devices;
  for (let i = 0; i < 3000 && (a.game.winner < 0 || b.game.winner < 0); i++) net.frame();
  assert.equal(a.ls.desyncAt, -1);
  assert.equal(b.ls.desyncAt, -1);
  // let the slower one catch up, then compare whole states
  for (let i = 0; i < 50; i++) net.frame();
  const t = Math.min(a.game.tick, b.game.tick);
  assert.ok(t > 300, `played ${t} ticks`);
  if (a.game.tick === b.game.tick) assert.equal(stateHash(a.game), stateHash(b.game));
  assert.deepEqual(a.ls.log.filter(([tick]) => tick <= t), b.ls.log.filter(([tick]) => tick <= t));
});

test('a device never runs ahead of inputs it has not received', () => {
  const net = twoDevices();
  const [a] = net.devices;
  for (let i = 0; i < 100; i++) net.frame({ blockTo: 0 }); // device 0 hears nothing
  assert.equal(a.game.tick, a.ls.delay, 'stalls after the delay window');
});

test('a mismatch is reported as a desync', () => {
  const net = twoDevices();
  const [a, b] = net.devices;
  for (let i = 0; i < 40; i++) net.frame();
  b.game.spawns.find((s) => s.owner < 0).meter -= 1; // corrupt one device (neutral spawns never regen)
  for (let i = 0; i < 60; i++) net.frame();
  assert.ok(a.ls.desyncAt > 0 || b.ls.desyncAt > 0);
});
