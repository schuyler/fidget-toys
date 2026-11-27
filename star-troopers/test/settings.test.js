import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, paramsFor, DEFAULT_SETTINGS, FORCES } from '../src/settings.js';
import { squadSizes, DEFAULTS } from '../src/sim.js';

test('R2: every settings choice plays the original rules: dice, original defence, command, Meeting', () => {
  for (const you of ['compact', 'orrin', 'vell']) for (const swarms of ['off', 'on']) {
    const p = paramsFor({ ...DEFAULT_SETTINGS, you, swarms }, 7);
    assert.equal(p.combat, 'dice');
    assert.equal(p.defence, 'original');
    assert.equal(p.command, 1);
    assert.equal(p.scenario, 'meeting');
    assert.equal(p.seed, 7);
  }
});

test('R3: forces come from the FORCES table, by each side\'s faction', () => {
  for (const forces of /** @type {const} */ (['lighter', 'standard'])) {
    for (const you of ['compact', 'orrin', 'vell']) for (const enemy of ['compact', 'orrin', 'vell']) {
      const p = paramsFor({ ...DEFAULT_SETTINGS, you, enemy, forces }, 1);
      assert.equal(p.faction0, you);
      assert.equal(p.faction1, enemy);
      assert.deepEqual(squadSizes({ ...DEFAULTS, ...p }), [FORCES[forces][you], FORCES[forces][enemy]]);
    }
  }
  assert.deepEqual(FORCES.lighter, { orrin: 4, compact: 6, vell: 6 });
  assert.deepEqual(FORCES.standard, { orrin: 6, compact: 8, vell: 8 });
});

test('R3: the defaults: you Compact, enemy Orrin, CPU Easy, Lighter forces, some terrain, no swarms', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { you: 'compact', enemy: 'orrin', cpu: 'easy', forces: 'lighter', terrain: 'some', swarms: 'off' });
});

test('R3: terrain and swarms map onto the sim parameters; swarms are off by default', () => {
  assert.equal(DEFAULT_SETTINGS.swarms, 'off');
  assert.equal(paramsFor(DEFAULT_SETTINGS, 1).swarm, 0);
  assert.equal(paramsFor({ ...DEFAULT_SETTINGS, swarms: 'on' }, 1).swarm, 1);
  for (const terrain of ['open', 'some', 'dense']) assert.equal(paramsFor({ ...DEFAULT_SETTINGS, terrain }, 1).terrain, terrain);
});

test('R3: stored settings are sanitized: junk and partial values fall back to the defaults', () => {
  assert.deepEqual(sanitize(null), DEFAULT_SETTINGS);
  assert.deepEqual(sanitize('nope'), DEFAULT_SETTINGS);
  assert.deepEqual(sanitize({ you: 'xeno', cpu: 'brutal', forces: 3 }), DEFAULT_SETTINGS);
  const s = sanitize({ you: 'vell', enemy: 'compact', cpu: 'hard', forces: 'standard', terrain: 'dense', swarms: 'on', extra: 1 });
  assert.deepEqual(s, { you: 'vell', enemy: 'compact', cpu: 'hard', forces: 'standard', terrain: 'dense', swarms: 'on' });
  assert.deepEqual(sanitize({ you: 'orrin' }), { ...DEFAULT_SETTINGS, you: 'orrin' });
});
