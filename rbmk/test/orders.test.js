import test from 'node:test';
import assert from 'node:assert/strict';
import { createReactor, scram } from '../src/sim.js';
import {
  createShift, updateShift, schedule, nextOrder, trapChance, tolerance, lowRange, electricMW, snapshotShift, ORDER_DEFAULTS,
} from '../src/orders.js';
import { createRng } from '../src/rng.js';

const MIN = 60, HOUR = 3600;
const P = ORDER_DEFAULTS;
const noVisits = { visitGap: [1e6, 1e6] };

/** Set the reactor's output to `mwe` directly (the rating only reads n). */
function setOutput(s, mwe) { s.n = mwe / (s.params.nominalMW * s.params.efficiency); }

/**
 * Run the shift to `until` game seconds in `dt` steps. `output` gives MWe
 * from the order in force: 'band' sits on the target, 'off' at zero.
 */
function drive(sh, s, until, output = 'band', dt = 30) {
  const events = [];
  while (s.clock < until && sh.status === 'on') {
    const mwe = output === 'band' ? sh.order.target : output === 'off' ? 0 : output(sh.order);
    setOutput(s, mwe);
    s.clock = Math.min(until, s.clock + dt);
    events.push(...updateShift(sh, s));
  }
  return events;
}

test('the same seed gives the same orders; different seeds differ', () => {
  assert.deepEqual(schedule(7, 48 * HOUR), schedule(7, 48 * HOUR));
  assert.notDeepEqual(schedule(7, 48 * HOUR), schedule(8, 48 * HOUR));
});

test('the orders do not depend on what the operator does', () => {
  const quiet = { ...noVisits, missRate: 0 };
  const a = createShift(3, quiet), b = createShift(3, quiet);
  const ra = createReactor(), rb = createReactor();
  const ea = drive(a, ra, 30 * HOUR, 'band').filter((e) => e.type === 'order');
  const eb = drive(b, rb, 30 * HOUR, 'off').filter((e) => e.type === 'order');
  assert.ok(ea.length > 5);
  assert.deepEqual(ea, eb);
  assert.deepEqual(ea.map((e) => e.order), schedule(3, 30 * HOUR).slice(1));
});

test('orders follow one another, in range, with the ramp allowance the rules give', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const orders = schedule(seed, 40 * HOUR);
    let from = P.startMWe, prev = null;
    for (const o of orders) {
      assert.equal(o.start, prev ? prev.end : 0);
      assert.equal(o.target % 10, 0);
      const [lo, hi] = o.kind === 'low' ? lowRange(P, o.start) : P[`${o.kind}MWe`];
      assert.ok(o.target >= lo && o.target <= hi, `${o.kind} ${o.target}`);
      const [hlo, hhi] = P[`${o.kind}Hold`];
      assert.ok(o.end - o.deadline >= hlo * MIN && o.end - o.deadline <= hhi * MIN);
      if (o.kind === 'urgent') {
        assert.equal(prev?.kind, 'low', 'an urgent rise only follows a low hold');
        assert.equal(o.deadline - o.start, P.urgentRamp);
      } else {
        const ramp = P.rampBase + Math.round(P.rampPer100 * Math.abs(o.target - from) / 100 / MIN) * MIN;
        assert.equal(o.deadline - o.start, ramp);
      }
      assert.equal(o.tol, tolerance(P, o.start));
      from = o.target; prev = o;
    }
  }
});

test('tolerance tightens every two hours down to a floor', () => {
  assert.equal(tolerance(P, 0), 50);
  assert.equal(tolerance(P, 2 * HOUR - 60), 50);
  assert.equal(tolerance(P, 2 * HOUR), 45);
  assert.equal(tolerance(P, 12 * HOUR), 20);
  assert.equal(tolerance(P, 30 * HOUR), 20);
});

test('low holds start shallow and deepen through the shift', () => {
  assert.deepEqual(lowRange(P, 0), [200, 400]);
  assert.deepEqual(lowRange(P, HOUR - 60), [200, 400]);
  assert.deepEqual(lowRange(P, HOUR), [150, 400]);
  assert.deepEqual(lowRange(P, 2 * HOUR), [100, 400]);
  assert.deepEqual(lowRange(P, 30 * HOUR), [100, 400]);
  let early = Infinity, late = Infinity;
  for (let seed = 1; seed <= 500; seed++) {
    for (const o of schedule(seed, 30 * HOUR)) {
      if (o.kind !== 'low') continue;
      if (o.start < HOUR) early = Math.min(early, o.target);
      if (o.start >= 2 * HOUR) late = Math.min(late, o.target);
    }
  }
  assert.equal(early, 200);
  assert.equal(late, 100);
});

test('the trap (an urgent rise after a low hold) gets likelier through the shift', () => {
  assert.equal(trapChance(P, 0), 100);
  assert.equal(trapChance(P, 6 * HOUR), 400);
  assert.equal(trapChance(P, 20 * HOUR), 800);
  // Measured: how often a low hold is followed by an urgent rise, early vs late.
  const tally = { early: [0, 0], late: [0, 0] };
  for (let seed = 1; seed <= 3000; seed++) {
    const orders = schedule(seed, 40 * HOUR);
    for (let i = 0; i + 1 < orders.length; i++) {
      if (orders[i].kind !== 'low') continue;
      const end = orders[i].end;
      const bucket = end < 8 * HOUR ? tally.early : end >= 16 * HOUR ? tally.late : null;
      if (!bucket) continue;
      bucket[0] += orders[i + 1].kind === 'urgent' ? 1 : 0;
      bucket[1]++;
    }
  }
  const early = tally.early[0] / tally.early[1], late = tally.late[0] / tally.late[1];
  assert.ok(early > 0.2 && early < 0.45, `early ${early}`);
  assert.ok(late > 0.7 && late < 0.85, `late ${late}`);
});

test('changing one order kind leaves the rest of the draws where they were', () => {
  const a = createRng(11), b = createRng(11);
  const pa = nextOrder(P, a, null), pb = nextOrder({ ...P, urgentMWe: [900, 990] }, b, null);
  assert.equal(pa.kind, pb.kind);
  assert.deepEqual(a, b, 'both consumed the same number of draws');
});

test('no penalty before the deadline; points lost at the set rate after it', () => {
  const sh = createShift(1, noVisits), s = createReactor();
  const o = sh.order;
  drive(sh, s, o.deadline, 'off');
  assert.equal(sh.rating, 100);
  drive(sh, s, o.deadline + 30 * MIN, 'off');
  assert.ok(Math.abs(sh.rating - (100 - P.missRate / 2)) < 1e-9, `${sh.rating}`);
});

test('an order held in band is met (+5, capped at 100); one mostly out is missed', () => {
  const sh = createShift(1, { ...noVisits, missRate: 1 }), s = createReactor();
  const first = sh.order;
  let ev = drive(sh, s, first.end, 'band');
  assert.deepEqual(ev.map((e) => e.type), ['met', 'order']);
  assert.equal(sh.rating, 100);
  sh.rating = 80;
  const second = sh.order;
  drive(sh, s, second.end, 'band');
  assert.equal(sh.rating, 85);
  const third = sh.order;
  ev = drive(sh, s, third.end, (o) => (s.clock < o.deadline + 0.3 * (o.end - o.deadline) ? o.target : 0));
  assert.equal(ev[0].type, 'missed');
  assert.deepEqual([sh.met, sh.missed], [2, 1]);
});

test('relief valves cost rating for the time they are open', () => {
  const sh = createShift(1, noVisits), s = createReactor();
  setOutput(s, sh.order.target);
  s.clock = 10 * MIN; s.reliefTime = 30 * MIN;
  updateShift(sh, s);
  assert.ok(Math.abs(sh.rating - (100 - P.reliefRate / 2)) < 1e-9);
});

test('inspectors check the true margin and report late; only below 15 rods costs rating', () => {
  for (const [rods, reprimand] of [[10, true], [30, false]]) {
    const sh = createShift(5, { visitGap: [60, 60], missRate: 0 }), s = createReactor();
    s.rods = rods / s.params.rodCount;
    let ev = drive(sh, s, 60 * MIN + 29 * MIN);
    assert.equal(ev.filter((e) => e.type === 'inspection').length, 0, 'not reported yet');
    assert.equal(sh.rating, 100);
    ev = drive(sh, s, 60 * MIN + 61 * MIN).filter((e) => e.type === 'inspection');
    assert.equal(ev.length, 1);
    const r = ev[0].report;
    assert.equal(r.visit, 60 * MIN);
    assert.ok(r.at >= r.visit + 30 * MIN && r.at <= r.visit + 60 * MIN);
    assert.ok(Math.abs(r.margin - rods) < 1e-9);
    assert.equal(r.reprimand, reprimand);
    assert.equal(sh.rating, reprimand ? 100 - P.reprimand : 100);
  }
});

test('reports reach the teletype in order even when visits come close together', () => {
  const sh = createShift(9, { visitGap: [1, 5], missRate: 0 }), s = createReactor();
  const ev = drive(sh, s, 10 * HOUR).filter((e) => e.type === 'inspection');
  assert.ok(ev.length > 50);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].report.at >= ev[i - 1].report.at);
});

test('rating at zero sacks the operator, and the shift stops counting', () => {
  const sh = createShift(1, noVisits), s = createReactor();
  const ev = drive(sh, s, 20 * HOUR, 'off');
  assert.equal(ev.at(-1).type, 'sacked');
  assert.equal(sh.status, 'sacked');
  assert.equal(sh.rating, 0);
  s.clock += HOUR;
  assert.deepEqual(updateShift(sh, s), []);
});

test('AZ-5 ends the shift: the rating freezes', () => {
  const sh = createShift(1, noVisits), s = createReactor();
  drive(sh, s, sh.order.deadline + 10 * MIN, 'off');
  const rating = sh.rating;
  scram(s);
  s.clock += HOUR;
  assert.deepEqual(updateShift(sh, s), []);
  assert.equal(sh.status, 'over');
  assert.equal(sh.rating, rating);
});

test('electrical output is thermal power times efficiency', () => {
  const s = createReactor();
  assert.ok(Math.abs(electricMW(s) - 3200 * 0.31) < 1e-6);
});

test('a snapshot of the shift replays identically', () => {
  const sh = createShift(4), s = createReactor();
  const wobble = (o) => o.target + ((s.clock / 30) % 7) * 15 - 45;
  drive(sh, s, 6 * HOUR, wobble);
  const copy = snapshotShift(sh), s2 = { ...s };
  const e1 = drive(sh, s, 20 * HOUR, wobble);
  const e2 = drive(copy, s2, 20 * HOUR, (o) => o.target + ((s2.clock / 30) % 7) * 15 - 45);
  assert.deepEqual(e1, e2);
  assert.deepEqual(sh, copy);
});
