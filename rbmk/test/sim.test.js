import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReactor, step, setControls, scram, readouts, snapshot, reactivity, rodShape,
  xenonStep, xenonEquilibrium, margin, DEFAULTS,
} from '../src/sim.js';

const HOUR = 3600;
/** Step for `seconds` of physics time in frame-sized chunks; collect events. */
function run(s, seconds, dt = 0.02) {
  const events = [];
  for (let t = 0; t < seconds - 1e-9 && (s.status === 'running' || s.status === 'scramming'); t += dt) {
    events.push(...step(s, dt));
  }
  return events;
}
/** Physics without feedback or xenon: power follows the rods alone. */
const bare = { voidWorth: 0, dopplerWorth: 0, xenonScale: 0 };

test('a reactor at full power stays put', () => {
  const s = createReactor();
  assert.equal(margin(s), 30);
  assert.ok(Math.abs(reactivity(s)) < 1e-12);
  run(s, 60);
  assert.ok(Math.abs(s.n - 1) < 1e-6, `power ${s.n}`);
  assert.ok(Math.abs(s.X - 1) < 1e-6, `xenon ${s.X}`);
});

test('steady state at any power has r = 0 and more rods in at lower power', () => {
  let last = 0;
  for (const power of [1, 0.5, 0.2, 0.06]) {
    const s = createReactor({}, { power });
    assert.ok(Math.abs(reactivity(s)) < 1e-12, `power ${power}`);
    assert.ok(margin(s) > last, `margin ${margin(s)} at ${power}`);
    last = margin(s);
  }
});

test('xenon peaks hours after power is cut, then burns off when it comes back', () => {
  const p = DEFAULTS;
  let { I, X } = xenonEquilibrium(p, 1);
  let peak = 0, at = 0;
  for (let t = 60; t <= 30 * HOUR; t += 60) {
    ({ I, X } = xenonStep(p, I, X, 0, 60));
    if (X > peak) { peak = X; at = t; }
  }
  assert.ok(peak > 1.8, `peak ${peak}`);
  assert.ok(at > 6 * HOUR && at < 12 * HOUR, `peak at ${at / HOUR} h`);

  // From a pit, full power burns xenon off within the hour.
  ({ I, X } = xenonEquilibrium(p, 1));
  for (let t = 0; t < 8 * HOUR; t += 60) ({ I, X } = xenonStep(p, I, X, 0.06, 60));
  const pit = X;
  for (let t = 0; t < HOUR; t += 60) ({ I, X } = xenonStep(p, I, X, 1, 60));
  assert.ok(pit > 1.8 && X < pit - 0.3, `pit ${pit} → ${X}`);
});

test('a rod movement changes power at once (prompt jump), then precursors follow', () => {
  const s = createReactor(bare);
  s.rods -= 1 / 60; s.rodsTarget = s.rods; // one rod out: +$0.20
  step(s, 0.001);
  assert.ok(Math.abs(s.n - 1 / (1 - 0.2)) < 0.005, `prompt jump to ${s.n}`);
  const jumped = s.n;
  run(s, 5);
  assert.ok(s.n > jumped * 1.1, `then rises: ${s.n}`);
});

test('power doubles at the rate the period meter reports', () => {
  const s = createReactor(bare);
  s.rods -= 0.25 / 12; s.rodsTarget = s.rods; // +$0.25
  step(s, 1e-6);
  const rate = readouts(s).growthRate;
  assert.ok(Math.abs(rate - 0.08 * 0.25 / 0.75) < 1e-9);
  const start = s.n;
  run(s, 20);
  const expected = start * Math.exp(rate * 20);
  assert.ok(Math.abs(s.n / expected - 1) < 0.01, `${s.n} vs ${expected}`);
});

test('below roughly a third of full power the reactor is unstable; at full power it settles', () => {
  const growth = (power) => {
    const s = createReactor({ xenonScale: 0 }, { power });
    s.C *= 1.01; s.n *= 1.01;
    run(s, 30);
    return s.n / power;
  };
  const low = growth(0.06), mid = growth(0.2), high = growth(1);
  assert.ok(low > 1.1, `6%: ${low}`);
  assert.ok(mid > 1.01 && mid < low, `20%: ${mid}`);
  assert.ok(Math.abs(high - 1) < 0.003, `100%: ${high}`);
});

test('a rod entering from fully withdrawn adds reactivity first (the graphite tip)', () => {
  const p = DEFAULTS;
  assert.ok(rodShape(p, 0.07) > 0);
  assert.ok(rodShape(p, 0.4) < 0);
  assert.equal(rodShape(p, 1), -1);
  assert.ok(rodShape(p, 0.07, 2) > rodShape(p, 0.07, 1), 'xenon skews the flux and makes it worse');

  // Scram from full power: reactivity rises before it falls.
  const s = createReactor();
  scram(s);
  let peak = s.r;
  for (let i = 0; i < 50; i++) { step(s, 0.02); peak = Math.max(peak, s.r); }
  assert.ok(peak > 0.05, `peak r ${peak}`);
});

test('AZ-5 with a healthy margin shuts the reactor down', () => {
  const s = createReactor();
  scram(s);
  const events = run(s, 60);
  assert.equal(s.status, 'shutdown');
  assert.ok(events.some((e) => e.type === 'shutdown'));
});

test('AZ-5 in a xenon pit with few rods in goes prompt critical', () => {
  const s = createReactor({}, { power: 0.06, X: 2 });
  assert.ok(margin(s) < 12, `margin ${margin(s)}`);
  scram(s);
  const events = run(s, 30);
  assert.equal(s.status, 'meltdown');
  assert.equal(s.cause, 'prompt');
  assert.deepEqual(events.at(-1), { type: 'meltdown', cause: 'prompt' });
});

test('AZ-5 at low power with ~20 rods in survives', () => {
  const s = createReactor({}, { power: 0.06, X: 1.5 });
  assert.ok(margin(s) > 19, `margin ${margin(s)}`);
  scram(s);
  run(s, 60);
  assert.equal(s.status, 'shutdown');
});

test('pulling every rod at full power melts the reactor', () => {
  const s = createReactor();
  setControls(s, { rodsTarget: 0 });
  run(s, 30);
  assert.equal(s.status, 'meltdown');
});

test('low pressure at full power dries out the channels and damages the fuel', () => {
  const s = createReactor();
  setControls(s, { pTarget: 55 });
  const events = run(s, 120);
  assert.ok(events.some((e) => e.type === 'dryout' && e.on));
  assert.equal(s.status, 'meltdown');
  assert.equal(s.cause, 'fuel');
});

test('high pressure lifts the relief valves', () => {
  const s = createReactor();
  setControls(s, { pTarget: 80 });
  const events = run(s, 20);
  assert.ok(events.some((e) => e.type === 'relief' && e.open));
  assert.ok(s.reliefTime > 0);
  assert.equal(s.status, 'running');
});

test('controls clamp, and lock once AZ-5 is pressed', () => {
  const s = createReactor();
  setControls(s, { rodsTarget: 999, pTarget: 10 });
  assert.equal(s.rodsTarget, 1);
  assert.equal(s.pTarget, DEFAULTS.pMin);
  scram(s);
  setControls(s, { rodsTarget: 0, pTarget: 70 });
  assert.equal(s.rodsTarget, 1);
  assert.equal(s.pTarget, DEFAULTS.pMin);
});

test('the margin printout is late and shows the margin from when it started', () => {
  const s = createReactor();
  const atStart = (DEFAULTS.printEvery + 1) / DEFAULTS.xenonScale;
  run(s, atStart);
  assert.ok(s.printing && s.printing.value === 30, 'printing started at 30 rods');
  setControls(s, { rodsTarget: 34 });
  const events = run(s, DEFAULTS.printDelay / DEFAULTS.xenonScale);
  const printed = events.find((e) => e.type === 'printout');
  assert.ok(printed && printed.value === 30, `printed ${printed && printed.value}`);
  assert.ok(margin(s) > 33, `true margin ${margin(s)}`);
  assert.equal(readouts(s).printout.value, 30);
});

test('readouts leave out what the operator cannot see', () => {
  const r = readouts(createReactor());
  for (const hidden of ['X', 'I', 'r', 'margin', 'xenon', 'reactivity']) assert.ok(!(hidden in r), hidden);
  assert.ok(Math.abs(r.thermalMW - 3200) < 1e-9);
  assert.ok(Math.abs(r.electricMW - 992) < 1e-9);
  assert.equal(r.growthRate, 0);
});

test('same inputs give an identical game, and snapshots replay', () => {
  const script = (s) => {
    run(s, 10);
    setControls(s, { rodsTarget: 40, pTarget: 66 });
    run(s, 40);
    setControls(s, { rodsTarget: 36 });
    run(s, 30);
  };
  const a = createReactor(), b = createReactor();
  script(a); script(b);
  assert.deepEqual(a, b);

  const before = snapshot(a);
  const copy = snapshot(a);
  run(a, 10);
  assert.notDeepEqual(a, before);
  run(copy, 10);
  assert.deepEqual(copy, a);
});
