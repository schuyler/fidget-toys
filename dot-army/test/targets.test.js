import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, setTarget, applyInput, applyInputTo, placeDot, stateHash, BLUE, RED, NEUTRAL } from '../src/sim.js';
import { axialToIndex, hexDist } from '../src/hex.js';
import { createRng } from '../src/rng.js';

const E = 0;

function board(layout = { spawns: [] }, params = {}) {
  return createGame({ width: 24, height: 16, ...params }, layout);
}
function at(game, dq, dr) {
  const o = 8 * game.grid.W + 10;
  return axialToIndex(game.grid, game.grid.q[o] + dq, game.grid.r[o] + dr);
}
const nb = (game, cell, d) => game.grid.nbr[cell * 6 + d];
function game0() { return board(); }

test('C1: a player never exceeds maxTargets, and the last target cannot be removed', () => {
  const game = board({ spawns: [] }, { maxTargets: 3 });
  const p = BLUE;
  assert.equal(game.targets[p].length, 1);
  assert.equal(applyInput(game, p, { op: 'add', cell: at(game, 1, 0) }), true);
  assert.equal(applyInput(game, p, { op: 'add', cell: at(game, 2, 0) }), true);
  const before = [...game.targets[p]];
  assert.equal(before.length, 3);
  assert.equal(applyInput(game, p, { op: 'add', cell: at(game, 3, 0) }), false, 'add at the cap is refused');
  assert.deepEqual(game.targets[p], before, 'list unchanged');
  assert.equal(applyInput(game, p, { op: 'remove', index: 2 }), true);
  assert.equal(applyInput(game, p, { op: 'remove', index: 1 }), true);
  assert.equal(game.targets[p].length, 1);
  assert.equal(applyInput(game, p, { op: 'remove', index: 0 }), false, 'the last target stays');
  assert.equal(game.targets[p].length, 1);

  // the shared rule function, with a small cap
  const list = [5];
  assert.equal(applyInputTo(list, { op: 'add', cell: 6 }, 2, 100), true);
  assert.equal(applyInputTo(list, { op: 'add', cell: 7 }, 2, 100), false);
  assert.deepEqual(list, [5, 6]);
  assert.equal(applyInputTo(list, { op: 'remove', index: 0 }, 2, 100), true);
  assert.deepEqual(list, [6]);
  assert.equal(applyInputTo(list, { op: 'remove', index: 0 }, 2, 100), false);
  assert.deepEqual(list, [6]);
});

test('C2: with two targets, each dot heads to the nearer one by path', () => {
  const game = board({ spawns: [] }, { maxTargets: 3 });
  const left = at(game, -8, 0), right = at(game, 8, 0);
  setTarget(game, BLUE, left);
  assert.equal(applyInput(game, BLUE, { op: 'add', cell: right }), true);
  const a = at(game, -4, 0), b = at(game, 4, 0);
  placeDot(game, BLUE, a, E);
  placeDot(game, BLUE, b, E);
  const dotA = game.occ[a], dotB = game.occ[b];
  assert.ok(dotA && dotB);
  step(game);
  assert.equal(game.near[BLUE][a], 0, 'left-side cell drains to target 0');
  assert.equal(game.near[BLUE][b], 1, 'right-side cell drains to target 1');
  for (let i = 0; i < 3; i++) step(game);
  assert.ok(hexDist(game.grid, dotA.cell, left) < hexDist(game.grid, a, left), 'left dot moved toward the left target');
  assert.ok(hexDist(game.grid, dotB.cell, right) < hexDist(game.grid, b, right), 'right dot moved toward the right target');
});

test('C5: a spawn targeted by a non-first target is attacked and drained as with one target', () => {
  const game = board({ spawns: [{ center: at(game0(), 0, 0), owner: NEUTRAL, meter: 3 }, { center: at(game0(), -7, 0), owner: BLUE }, { center: at(game0(), 7, 0), owner: RED }] }, { spawnInterval: 1000 });
  const s = game.spawns[0];
  setTarget(game, BLUE, at(game, -9, -5));
  setTarget(game, RED, at(game, -9, -5));
  assert.equal(applyInput(game, BLUE, { op: 'add', cell: s.center }), true);
  assert.equal(game.targets[BLUE][1], s.center);
  const faces = [];
  for (const e of s.exits) for (let d = 0; d < 6; d++) if (game.spawnOf[nb(game, e, d)] === s.id) { faces.push([e, d]); break; }
  placeDot(game, BLUE, faces[0][0], faces[0][1]);
  placeDot(game, BLUE, faces[1][0], faces[1][1]);
  step(game);
  assert.equal(s.meter, 1);
  assert.equal(game.dotCount[BLUE], 0, 'attackers are used up');
  for (let i = 2; i < 5; i++) placeDot(game, BLUE, faces[i][0], faces[i][1]);
  const ev = step(game);
  assert.equal(ev.captures.length, 1);
  assert.equal(s.owner, BLUE);
  assert.equal(s.meter, 2);
});

test('C6: dots gather into an outward-facing hedgehog at each of two targets', () => {
  const game = board({ spawns: [] }, { maxTargets: 3 });
  const t0 = at(game, -6, 0), t1 = at(game, 6, 0);
  setTarget(game, BLUE, t0);
  assert.equal(applyInput(game, BLUE, { op: 'add', cell: t1 }), true);
  for (const t of [t0, t1]) {
    placeDot(game, BLUE, t, E);
    for (let d = 0; d < 6; d++) placeDot(game, BLUE, nb(game, t, d), (d + 3) % 6); // all facing inward
  }
  step(game);
  for (const t of [t0, t1]) {
    for (let d = 0; d < 6; d++) assert.equal(game.occ[nb(game, t, d)]?.facing, d, `ring dot ${d} at ${t} faces outward`);
  }
});

test('C8: same seed and same inputs including adds and removes give the same state hash', () => {
  const run = () => {
    const game = createGame({ seed: 42, terrain: 'rocks', maxTargets: 3 });
    const rng = createRng(1234);
    const accepted = { add: 0, remove: 0, move: 0 };
    for (let i = 0; i < 300; i++) {
      if (i % 7 === 0) {
        for (const p of [BLUE, RED]) {
          const n = game.targets[p].length;
          const r = rng.int(3);
          const input = r === 0 ? { op: 'add', cell: rng.int(game.grid.N) }
            : r === 1 ? { op: 'remove', index: rng.int(n) }
            : { op: 'move', index: rng.int(n), cell: rng.int(game.grid.N) };
          if (applyInput(game, p, input)) accepted[input.op]++;
        }
      }
      step(game);
    }
    return { hash: stateHash(game), accepted };
  };
  const a = run(), b = run();
  assert.ok(a.accepted.add > 0 && a.accepted.remove > 0 && a.accepted.move > 0, JSON.stringify(a.accepted));
  assert.equal(a.hash, b.hash);
});
