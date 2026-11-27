import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stateHash } from '../src/sim.js';
import { createLockstep } from '../src/lockstep.js';
import { createAI } from '../src/ai.js';
import { createRng } from '../src/rng.js';

/** Two devices joined by a laggy in-order fake network; records every message sent. */
function twoDevices({ seed = 5, maxLag = 6, rngSeed = 99, cpu = true } = {}) {
  const net = createRng(rngSeed);
  const inflight = [[], []];
  const sent = [[], []];
  let now = 0;
  const devices = [0, 1].map((p) => {
    const game = createGame({ seed, width: 40, height: 26, maxTargets: 3 });
    const ai = cpu ? createAI(p, seed * 31 + p, { dragSpeed: 2.2 }) : null;
    const ls = createLockstep(game, p, (msg) => {
      sent[p].push(msg);
      const q = inflight[1 - p];
      const last = q.length ? q[q.length - 1].at : now;
      q.push({ at: Math.max(last, now + 1 + net.int(maxLag)), msg });
    });
    return { p, game, ai, ls };
  });
  return {
    devices, sent,
    frame() {
      now++;
      for (let i = 0; i < 2; i++) {
        while (inflight[i].length && inflight[i][0].at <= now) devices[i].ls.receive(inflight[i].shift().msg);
      }
      for (const d of devices) {
        if (d.ai) for (const inp of d.ai.think(d.game)) d.ls.queue(inp);
        d.ls.pump();
        if (d.ls.ready()) d.ls.advance();
      }
    },
  };
}

test('C12: CPUs adding, removing and moving targets on both devices stay in sync', () => {
  const net = twoDevices();
  const [a, b] = net.devices;
  for (let i = 0; i < 4000 && (a.game.winner < 0 || b.game.winner < 0); i++) net.frame();
  for (let i = 0; i < 50; i++) net.frame();
  assert.equal(a.ls.desyncAt, -1);
  assert.equal(b.ls.desyncAt, -1);
  const t = Math.min(a.game.tick, b.game.tick);
  assert.ok(t > 300, `played ${t} ticks`);
  if (a.game.tick === b.game.tick) assert.equal(stateHash(a.game), stateHash(b.game));
  assert.deepEqual(a.ls.log.filter(([tick]) => tick <= t), b.ls.log.filter(([tick]) => tick <= t));
  for (const p of [0, 1]) {
    for (const op of ['add', 'remove', 'move']) {
      assert.ok(a.ls.log.some(([, player, inp]) => player === p && inp.op === op), `player ${p} logged a ${op}`);
    }
  }
});

test('C12: a drag during the countdown goes out as one move under 4096 bytes and stays in sync', () => {
  const net = twoDevices({ cpu: false });
  const [a, b] = net.devices;
  const cells = [];
  for (let i = 0; i < 500; i++) { cells.push(100 + i); a.ls.queue({ op: 'move', index: 0, cell: 100 + i }); }
  for (let i = 0; i < 30; i++) net.frame();
  const ins = net.sent[0].filter((m) => m.k === 'in');
  const withInputs = ins.filter((m) => m.i.length > 0);
  assert.equal(withInputs.length, 1, 'the drag is sent once');
  assert.deepEqual(withInputs[0].i, [{ op: 'move', index: 0, cell: cells[cells.length - 1] }]);
  for (const m of ins) assert.ok(JSON.stringify(m).length < 4096);
  // both devices converge on the same state with the move applied
  let compared = false;
  for (let i = 0; i < 100 && !compared; i++) {
    net.frame();
    if (a.game.tick === b.game.tick && a.game.tick > 10) {
      compared = true;
      assert.equal(stateHash(a.game), stateHash(b.game));
      assert.equal(a.game.targets[0][0], cells[cells.length - 1]);
      assert.equal(b.game.targets[0][0], cells[cells.length - 1]);
    }
  }
  assert.ok(compared, 'devices reached the same tick');
  assert.equal(a.ls.desyncAt, -1);
  assert.equal(b.ls.desyncAt, -1);
});
