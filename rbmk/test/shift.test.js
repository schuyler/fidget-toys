import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, tick, isOver, TICK } from '../src/shift.js';
import { DEFAULTS } from '../src/sim.js';

test('parameters go to the reactor or the dispatcher; unknown ones are refused', () => {
  const g = createGame(1, { xenonWorth: 6, tolMin: 10 });
  assert.equal(g.reactor.params.xenonWorth, 6);
  assert.equal(g.shift.params.tolMin, 10);
  assert.throws(() => createGame(1, { nonsense: 1 }), /unknown parameter/);
});

test('every tick advances the same physics time, and the shift keeps up', () => {
  const g = createGame(1);
  for (let i = 0; i < 300; i++) tick(g);
  assert.equal(g.ticks, 300);
  assert.ok(Math.abs(g.reactor.clock - 300 * TICK * DEFAULTS.xenonScale) < 1e-6);
  assert.equal(g.shift.clock, g.reactor.clock);
});

test('input reaches the reactor only through setControls and scram', () => {
  const g = createGame(1);
  tick(g, { rodsTarget: 40, pTarget: 72 });
  assert.equal(g.reactor.rodsTarget, 40 / 60);
  assert.equal(g.reactor.pTarget, 72);
  tick(g, { scram: true });
  assert.equal(g.reactor.status, 'scramming');
  let n = 0;
  while (!isOver(g) && n++ < 30 * 60) tick(g);
  assert.equal(g.reactor.status, 'shutdown');
  assert.deepEqual(tick(g, { rodsTarget: 0 }), { sim: [], shift: [] }, 'nothing happens after the end');
});

test('the same seed and inputs give the same shift', () => {
  const play = () => {
    const g = createGame(5);
    for (let i = 0; i < 3000; i++) tick(g, i === 100 ? { rodsTarget: 34 } : i === 1500 ? { pTarget: 66 } : {});
    return g;
  };
  assert.deepEqual(play(), play());
});
