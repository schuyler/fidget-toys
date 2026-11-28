// @ts-check
// The grid dispatcher's orders, the inspector, and the operator's rating.
// Pure: no DOM, no clock, no Math.random. It reads the reactor and never
// changes it.
//
// The order schedule and the inspectors' visits depend only on the seed, not
// on anything the operator does: the same seed gives every player the same
// shift, and the plan could be announced ahead. Order times are whole game
// seconds, drawn as whole minutes. The rating is float state and follows the
// same rule as sim.js: only + − × ÷, min, max and abs touch it, plus
// Math.round and % on whole numbers (both exact).

import { createRng, int, range } from './rng.js';
import { margin } from './sim.js';

/**
 * @typedef {typeof ORDER_DEFAULTS} OrderParams
 * @typedef {import('./rng.js').Rng} Rng
 * @typedef {import('./sim.js').State} Reactor
 *
 * @typedef {Object} Order
 * @property {number} index
 * @property {'follow'|'low'|'urgent'} kind
 * @property {number} target     MWe
 * @property {number} tol        ± MWe
 * @property {number} start      game s: when it's given
 * @property {number} deadline   game s: the output must be in band from here...
 * @property {number} end        game s: ...to here, when the next order is given
 *
 * @typedef {Object} Report
 * @property {number} visit      game s: when the inspector came
 * @property {number} at         game s: when it reaches the teletype
 * @property {number} margin     true margin at the visit, rods
 * @property {boolean} reprimand
 *
 * @typedef {Object} Shift
 * @property {OrderParams} params
 * @property {'on'|'sacked'|'over'} status   'over': AZ-5 or meltdown ended it
 * @property {number} clock        game s, as far as the rating has been counted
 * @property {number} rating       0..100
 * @property {Order} order         the order in force
 * @property {number} inBand       game s in band so far during this order's hold
 * @property {Rng} orderRng
 * @property {Rng} inspectRng
 * @property {number} nextVisit    game s
 * @property {Report[]} reports    visits not yet on the teletype
 * @property {number} reliefSeen   the reactor's reliefTime already charged for
 * @property {number} met
 * @property {number} missed
 *
 * @typedef {{ type: 'order', order: Order }
 *   | { type: 'met', order: Order }
 *   | { type: 'missed', order: Order }
 *   | { type: 'inspection', report: Report }
 *   | { type: 'sacked' }} ShiftEvent
 */

const MIN = 60;
const HOUR = 3600;

export const ORDER_DEFAULTS = {
  startMWe: 990,          // the shift starts at full power (3200 MWt × 0.31 ≈ 992 MWe)
  // Order kinds: target range (MWe, multiples of 10) and hold (minutes)
  followMWe: [500, 990],
  followHold: [60, 180],
  lowMWe: [100, 400],     // down to ~10% thermal: well into the unstable region, on purpose
  // ...but not at once: the floor of a low hold starts here and deepens through the
  // shift, so the first pits are shallow enough to learn on.
  lowStartMWe: 200,
  lowDeepen: 50,          // MWe lower...
  lowEvery: HOUR,         // ...every this long (the floor reaches lowMWe[0] after 2 h)
  lowHold: [240, 480],    // long enough to dig most of a xenon pit (peak ~10 h)
  urgentMWe: [800, 990],
  urgentHold: [60, 120],
  lowChance: 0.3,         // share of ordinary orders that are low holds
  // The trap: an urgent rise straight after a low hold, likelier as the shift goes on
  trapBase: 0.1,
  trapPerHour: 0.05,
  trapMax: 0.8,
  // Ramp allowance (game s)
  rampBase: 20 * MIN,
  rampPer100: 10 * MIN,   // per 100 MWe of change
  urgentRamp: 15 * MIN,
  // Tolerance tightens through the shift
  tolStart: 50,
  tolStep: 5,
  tolEvery: 2 * HOUR,
  tolMin: 20,
  // Rating
  missRate: 40,           // points per game hour out of band after the deadline
  metShare: 0.8,          // share of the hold in band that counts as met
  metBonus: 5,
  reliefRate: 10,         // points per game hour the relief valves are open
  // Inspections
  visitGap: [1, 16 * 60], // minutes between visits, uniform: one per ~8 game hours
  minRods: 15,            // the rule
  reprimand: 25,          // points
  reportDelay: [30, 60],  // minutes until the visit reaches the teletype
};

/** Chance, in thousandths, that an urgent rise follows a low hold ending at `t`. @param {OrderParams} p @param {number} t */
export function trapChance(p, t) {
  return Math.round(1000 * Math.min(p.trapMax, p.trapBase + p.trapPerHour * t / HOUR));
}

/** Tolerance for an order given at `t` (whole seconds). @param {OrderParams} p @param {number} t */
export function tolerance(p, t) {
  const steps = (t - t % p.tolEvery) / p.tolEvery;
  return Math.max(p.tolMin, p.tolStart - p.tolStep * steps);
}

/**
 * Target range of a low hold given at `t` (whole seconds): its floor deepens
 * through the shift, down to lowMWe[0].
 * @param {OrderParams} p @param {number} t @returns {number[]}
 */
export function lowRange(p, t) {
  const steps = (t - t % p.lowEvery) / p.lowEvery;
  return [Math.max(p.lowMWe[0], Math.min(p.lowMWe[1], p.lowStartMWe - p.lowDeepen * steps)), p.lowMWe[1]];
}

/** @param {Rng} rng @param {number[]} mwe */
const pickTarget = (rng, [lo, hi]) => lo + 10 * int(rng, (hi - lo) / 10 + 1);

/**
 * The order after `prev` (or the first, given at 0). Seed-only: it reads
 * nothing but the previous order and the RNG.
 * @param {OrderParams} p @param {Rng} rng @param {Order|null} prev
 * @returns {Order}
 */
export function nextOrder(p, rng, prev) {
  const start = prev ? prev.end : 0;
  const from = prev ? prev.target : p.startMWe;
  // Draw the same numbers whatever the branch, so a change to one kind's
  // ranges doesn't shift every later order.
  const roll = int(rng, 1000);
  const draws = {
    follow: pickTarget(rng, p.followMWe), low: pickTarget(rng, lowRange(p, start)), urgent: pickTarget(rng, p.urgentMWe),
  };
  const holds = {
    follow: range(rng, p.followHold[0], p.followHold[1]),
    low: range(rng, p.lowHold[0], p.lowHold[1]),
    urgent: range(rng, p.urgentHold[0], p.urgentHold[1]),
  };
  /** @type {Order['kind']} */
  let kind;
  if (prev && prev.kind === 'low') kind = roll < trapChance(p, start) ? 'urgent' : 'follow';
  else kind = roll < Math.round(1000 * p.lowChance) ? 'low' : 'follow';
  const target = draws[kind];
  const ramp = kind === 'urgent' ? p.urgentRamp
    : p.rampBase + Math.round(p.rampPer100 * Math.abs(target - from) / 100 / MIN) * MIN;
  const deadline = start + ramp;
  return {
    index: prev ? prev.index + 1 : 0, kind, target, tol: tolerance(p, start),
    start, deadline, end: deadline + holds[kind] * MIN,
  };
}

/**
 * The orders a seed gives up to `until` game seconds, without a reactor.
 * @param {number} seed @param {number} until @param {Partial<OrderParams>} [params]
 */
export function schedule(seed, until, params = {}) {
  const p = { ...ORDER_DEFAULTS, ...params };
  const rng = createRng(seed);
  /** @type {Order[]} */
  const out = [];
  let o = nextOrder(p, rng, null);
  while (o.start < until) { out.push(o); o = nextOrder(p, rng, o); }
  return out;
}

/** @param {number} seed @param {Partial<OrderParams>} [params] @returns {Shift} */
export function createShift(seed, params = {}) {
  const p = { ...ORDER_DEFAULTS, ...params };
  const orderRng = createRng(seed);
  // A separate stream, so inspections don't move when the orders change.
  const inspectRng = createRng((seed ^ 0x5bd1e995) >>> 0);
  return {
    params: p, status: 'on', clock: 0, rating: 100,
    order: nextOrder(p, orderRng, null), inBand: 0,
    orderRng, inspectRng, nextVisit: range(inspectRng, p.visitGap[0], p.visitGap[1]) * MIN,
    reports: [], reliefSeen: 0, met: 0, missed: 0,
  };
}

/** Electrical output, MWe. @param {Reactor} s */
export const electricMW = (s) => Math.max(0, s.n) * s.params.nominalMW * s.params.efficiency;

/**
 * Bring the shift up to the reactor's clock: count time in and out of band,
 * end orders and give new ones, send inspectors, charge for relief valves.
 * Call after each sim step. The output is taken as constant over the step.
 * The first order is in force from the start; its event comes from
 * `createShift`'s caller (it's `shift.order`).
 * @param {Shift} sh @param {Reactor} s
 * @returns {ShiftEvent[]}
 */
export function updateShift(sh, s) {
  /** @type {ShiftEvent[]} */
  const events = [];
  if (sh.status !== 'on') return events;
  if (s.status !== 'running') { sh.status = 'over'; return events; }
  const p = sh.params;
  const mwe = electricMW(s);

  while (sh.clock < s.clock) {
    const o = sh.order;
    const to = Math.min(s.clock, o.end, sh.nextVisit);
    const held = Math.max(0, to - Math.max(sh.clock, o.deadline));
    if (Math.abs(mwe - o.target) > o.tol) sh.rating -= p.missRate * held / HOUR;
    else sh.inBand += held;
    sh.clock = to;

    if (sh.clock >= o.end) {
      const met = sh.inBand >= p.metShare * (o.end - o.deadline);
      if (met) { sh.met++; sh.rating = Math.min(100, sh.rating + p.metBonus); }
      else sh.missed++;
      events.push({ type: met ? 'met' : 'missed', order: o });
      sh.order = nextOrder(p, sh.orderRng, o);
      sh.inBand = 0;
      events.push({ type: 'order', order: sh.order });
    }
    if (sh.clock >= sh.nextVisit) {
      const m = margin(s);
      const at = sh.nextVisit + range(sh.inspectRng, p.reportDelay[0], p.reportDelay[1]) * MIN;
      // Visits can be closer together than report delays: keep them in teletype order.
      let i = sh.reports.length;
      while (i > 0 && sh.reports[i - 1].at > at) i--;
      sh.reports.splice(i, 0, { visit: sh.nextVisit, at, margin: m, reprimand: m < p.minRods });
      sh.nextVisit += range(sh.inspectRng, p.visitGap[0], p.visitGap[1]) * MIN;
    }
  }

  // Reports reach the teletype late; the reprimand lands with the news.
  while (sh.reports.length && sh.reports[0].at <= sh.clock) {
    const report = /** @type {Report} */ (sh.reports.shift());
    if (report.reprimand) sh.rating -= p.reprimand;
    events.push({ type: 'inspection', report });
  }

  sh.rating -= p.reliefRate * (s.reliefTime - sh.reliefSeen) / HOUR;
  sh.reliefSeen = s.reliefTime;

  if (sh.rating <= 0) {
    sh.rating = 0;
    sh.status = 'sacked';
    events.push({ type: 'sacked' });
  }
  return events;
}

/** A copy of the shift, for replay. @param {Shift} sh @returns {Shift} */
export function snapshotShift(sh) {
  return {
    ...sh, order: { ...sh.order }, orderRng: { ...sh.orderRng }, inspectRng: { ...sh.inspectRng },
    reports: sh.reports.map((r) => ({ ...r })),
  };
}
