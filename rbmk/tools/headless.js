// Runs whole shifts with CPU operators, no browser, to tune the defaults.
// Usage: node rbmk/tools/headless.js [shifts] [key=value ...]
//   op=cautious|greedy|idle|all (default all), hours=N (cap, default 96 game hours),
//   seed=N (first seed, default 1), trace=SEED (an hourly timeline of that seed),
//   any DEFAULTS (sim.js) or ORDER_DEFAULTS (orders.js) key; arrays comma-separated
//   (e.g. lowMWe=200,450), and operator habits as op.key=N (e.g. greedy.gmax=0.05; see OPS).
//
// Operators see only what a player sees: readouts(), the order in force, the
// rating and the teletype. They act only through tick()'s input (setControls
// and scram). The tool reads hidden state (xenon, reactivity, true margin)
// only to report on the shift afterwards.
import { createGame, tick, isOver } from '../src/shift.js';
import { readouts, margin } from '../src/sim.js';

const HOUR = 3600;
const LN2 = Math.LN2;

/** The operators' habits, overridable from the command line (e.g. greedy.gmax=0.1). */
/** @type {Record<string, Record<string, number>>} */
const OPS = {
  // gmax: the fastest growth it will ask for (1/s; doubling time is ln 2 / gmax).
  // kp: wanted growth per unit of relative error. kr: share of the rod estimate it moves each look.
  // The protection trips AZ-5 at a 10 s doubling time; both operators know it and stay slower.
  // In a pit, cautious aims high in the band (burns xenon faster) and lowers pressure for steam.
  // look: ticks between glances at the panel (15 = half a second, a person's reaction time).
  cautious: { look: 15, floor: 16, gmax: 0.03, kp: 0.15, kr: 0.3, scramDoubling: 12, aimHigh: 0.6, pLow: 58 },
  greedy: { look: 15, gmax: 0.06, kp: 0.3, kr: 0.3 },
};

const args = process.argv.slice(2);
const count = Number(args[0] ?? 40);
/** @type {Record<string, any>} */
const overrides = {};
let ops = ['cautious', 'greedy', 'idle'], hours = 96, firstSeed = 1, trace = -1;
for (const kv of args.slice(1)) {
  const [k, v] = kv.split('=');
  if (k === 'op') ops = v === 'all' ? ops : v.split(',');
  else if (k === 'hours') hours = Number(v);
  else if (k === 'seed') firstSeed = Number(v);
  else if (k === 'trace') trace = Number(v);
  else if (k.includes('.')) { const [op, key] = k.split('.'); OPS[op][key] = Number(v); }
  else overrides[k] = v.includes(',') ? v.split(',').map(Number) : Number(v);
}

// ---- Operators -------------------------------------------------------------
// Each looks at the panel every LOOK ticks (about a quarter second) and returns
// an input. The shared controller turns the gap to the order into a wanted
// growth rate (read on the period meter), then moves rods by the operator's
// rule of thumb: one rod is about $0.20, which changes the growth rate by
// about λ × 0.2 ≈ 0.016 /s near critical.

const LOOK = 8;
const PER_ROD = 0.016;


/**
 * @typedef {ReturnType<typeof readouts>} Panel
 * @typedef {import('../src/orders.js').Order} Order
 * @typedef {{ panel: Panel, order: Order, rating: number, teletype: any[] }} View
 * @typedef {import('../src/shift.js').Input} Input
 */

/**
 * How far to move the rods (positive is in) to steer output toward the order.
 * @param {Panel} r @param {Order} o @param {Record<string, number>} c
 */
function rodMove(r, o, c, aim = o.target) {
  const err = (aim - r.electricMW) / Math.max(o.target, 1);
  const want = Math.max(-c.gmax, Math.min(c.gmax, c.kp * err));
  return c.kr * (r.growthRate - want) / PER_ROD;
}

/**
 * Keeps 16 rods in, never lets the period get short, scrams on any alarm. With
 * the bank at its floor it plays the pit as well as the rule allows: it aims
 * high in the band and trades pressure for steam.
 */
function cautious() {
  const c = OPS.cautious, floor = c.floor;
  let p = 70;
  return {
    /** @param {View} v @returns {Input} */
    think({ panel: r, order: o }) {
      if (r.dryout || r.damageLamp || r.growthRate > LN2 / c.scramDoubling) return { scram: true };
      const atFloor = r.rodsTarget <= floor + 1;
      const aim = atFloor ? o.target + c.aimHigh * o.tol : o.target;
      let target = r.rodsTarget + rodMove(r, o, c, aim);
      // The printout is late: stop withdrawing if even it says the margin is near the rule.
      if (r.printout.value < floor + 1) target = Math.max(target, Math.min(r.rodsTarget, r.rods));
      if (atFloor && r.electricMW < aim) p = Math.max(c.pLow, p - 0.25);
      else if (!atFloor || r.electricMW > o.target + o.tol / 2) p = Math.min(70, p + 0.25);
      return { rodsTarget: Math.max(floor, target), pTarget: p };
    },
  };
}

/** Meets every order at any cost: no rod floor, drops pressure when out of rods, panics into AZ-5 on fuel damage. */
function greedy() {
  const c = OPS.greedy;
  let p = 70;
  return {
    /** @param {View} v @returns {Input} */
    think({ panel: r, order: o }) {
      if (r.damageLamp) return { scram: true };
      const target = Math.max(0, r.rodsTarget + rodMove(r, o, c));
      const short = o.target - r.electricMW > o.tol / 2, over = r.electricMW - o.target > o.tol / 2;
      if (target <= 0.5 && short) p = Math.max(55, p - 0.25);       // out of rods: more steam
      else if (over || target > 3) p = Math.min(70, p + 0.25);      // put it back when it can
      return { rodsTarget: target, pTarget: p };
    },
  };
}

/** Never touches anything. */
function idle() {
  return { /** @returns {Input} */ think: () => ({}) };
}

const OPERATORS = { cautious, greedy, idle };

// ---- One shift ---------------------------------------------------------------

/** @param {string} name @param {number} seed */
function runShift(name, seed) {
  const g = createGame(seed, overrides);
  const op = OPERATORS[/** @type {keyof typeof OPERATORS} */ (name)]();
  const s = g.reactor, sh = g.shift;
  const cap = hours * HOUR;
  /** @type {any[]} */
  let teletype = [];
  /** @type {import('../src/shift.js').Input} */
  let input = {};
  const rec = {
    name, seed, outcome: 'survived', cause: '', hours: 0, reprimands: 0, minMargin: Infinity, maxX: 0,
    lastPit: -Infinity, scramRods: NaN, scramX: NaN, scramN: NaN, rPeak: -Infinity, lastOrder: sh.order, kinds: { low: 0, urgent: 0 },
    /** @type {string[]} */ lines: [],
  };
  let nextTrace = 0;
  while (!isOver(g) && s.clock < cap) {
    if (g.ticks % (OPS[name]?.look ?? LOOK) === 0 && s.status === 'running') {
      input = op.think({ panel: readouts(s), order: sh.order, rating: sh.rating, teletype });
      teletype = [];
      if (input.scram) { rec.scramRods = margin(s); rec.scramX = s.X; rec.scramN = s.n; }
    } else input = {};
    const ev = tick(g, input);
    teletype.push(...ev.sim, ...ev.shift);
    if (ev.sim.some((e) => e.type === 'trip')) { rec.scramRods = margin(s); rec.scramX = s.X; rec.scramN = s.n; }
    for (const e of ev.shift) {
      if (e.type === 'inspection' && e.report.reprimand) rec.reprimands++;
      if (e.type === 'order') { rec.lastOrder = e.order; if (e.order.kind !== 'follow') rec.kinds[e.order.kind]++; }
    }
    rec.minMargin = Math.min(rec.minMargin, margin(s));
    rec.maxX = Math.max(rec.maxX, s.X);
    rec.rPeak = Math.max(rec.rPeak, s.r);
    if (s.X >= 1.4) rec.lastPit = s.clock;
    if (seed === trace && s.clock >= nextTrace) {
      nextTrace += HOUR;
      const o = sh.order, r = readouts(s);
      rec.lines.push(`  ${(s.clock / HOUR).toFixed(1).padStart(5)} h  ${o.kind.padEnd(6)} ${String(o.target).padStart(3)}±${o.tol}`
        + `  out ${r.electricMW.toFixed(0).padStart(4)} MWe  rods ${r.rods.toFixed(1).padStart(4)}  ${r.pressure.toFixed(1)} bar`
        + `  Xe ${s.X.toFixed(2)}  rating ${sh.rating.toFixed(0)}`);
    }
  }
  rec.hours = s.clock / HOUR;
  if (s.status === 'meltdown') { rec.outcome = 'meltdown'; rec.cause = s.cause ?? ''; }
  else if (sh.status === 'sacked') rec.outcome = 'sacked';
  else if (s.status === 'shutdown') rec.outcome = s.tripped ? 'tripped' : 'scram';
  rec.tripped = s.tripped;
  rec.met = sh.met; rec.missed = sh.missed; rec.rating = sh.rating;
  rec.afterPit = s.clock - rec.lastPit <= 3 * HOUR;
  return rec;
}

// ---- Report -------------------------------------------------------------------

const median = (/** @type {number[]} */ a) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN;
};
const f1 = (/** @type {number} */ x) => x.toFixed(1);

/** @type {Record<string, any[]>} */
const all = {};
for (const name of ops) {
  all[name] = [];
  for (let i = 0; i < count; i++) {
    const r = runShift(name, firstSeed + i);
    all[name].push(r);
    const what = r.outcome === 'meltdown' ? `MELT ${r.cause.padEnd(6)}` : r.outcome.padEnd(11);
    let extra = '';
    if (r.outcome === 'meltdown') extra = `${r.afterPit ? ' after pit' : ''}${isNaN(r.scramRods) ? '' : ` ${r.tripped ? 'trip' : 'scram'} at ${f1(r.scramRods)} rods Xe ${r.scramX.toFixed(2)} ${Math.round(100 * r.scramN)}% power`}`;
    else if (r.outcome === 'sacked') extra = ` last ${r.lastOrder.kind} ${r.lastOrder.target}±${r.lastOrder.tol}`;
    else if (r.outcome === 'scram' || r.outcome === 'tripped') extra = ` at ${f1(r.scramRods)} rods Xe ${r.scramX.toFixed(2)} ${Math.round(100 * r.scramN)}% power`;
    console.log(`${name.padEnd(8)} seed ${String(r.seed).padStart(3)}: ${what} ${f1(r.hours).padStart(5)} h  orders ${r.met}/${r.missed}`
      + `  low ${r.kinds.low} urgent ${r.kinds.urgent}  reprimands ${r.reprimands}  min margin ${f1(r.minMargin)}  max Xe ${r.maxX.toFixed(2)}${extra}`);
    for (const line of r.lines) console.log(line);
  }
}

console.log(`\n${count} shifts each, cap ${hours} game h, ${JSON.stringify(overrides)}`);
/** @type {[string, boolean][]} */
const checks = [];
/** @type {Record<string, number>} */
const scores = {};
for (const name of ops) {
  const rows = all[name], n = rows.length;
  const by = (/** @type {string} */ o) => rows.filter((r) => r.outcome === o);
  const melts = by('meltdown'), sacked = by('sacked');
  const hrs = rows.map((r) => r.hours);
  // Score: hours on shift, 0 for a meltdown (DESIGN.md, "Losing and ending").
  const score = rows.reduce((a, r) => a + (r.outcome === 'meltdown' ? 0 : r.hours), 0) / n;
  const met = rows.reduce((a, r) => a + r.met, 0), orders = rows.reduce((a, r) => a + r.met + r.missed, 0);
  console.log(`${name}: sacked ${sacked.length}, meltdown ${melts.length} (prompt ${melts.filter((r) => r.cause === 'prompt').length},`
    + ` fuel ${melts.filter((r) => r.cause === 'fuel').length}, after a pit ${melts.filter((r) => r.afterPit).length}),`
    + ` scrammed ${by('scram').length}, tripped ${by('tripped').length}, survived ${by('survived').length};`
    + ` hours median ${f1(median(hrs))} (${f1(Math.min(...hrs))}–${f1(Math.max(...hrs))}); orders met ${Math.round(100 * met / Math.max(1, orders))}%; mean score ${f1(score)} h`);
  scores[name] = score;
  if (name === 'cautious') {
    checks.push(['cautious: no meltdowns', melts.length === 0]);
    checks.push(['cautious: ≥ 90% sacked before the cap', sacked.length >= 0.9 * n]);
    checks.push(['cautious: median shift 12–48 h', median(hrs) >= 12 && median(hrs) <= 48]);
    checks.push(['cautious: ≤ 15% sacked within 10 h', rows.filter((r) => r.hours < 10).length <= 0.15 * n]);
    checks.push(['cautious: scrams and trips ≤ 10%', by('scram').length + by('tripped').length <= 0.1 * n]);
  } else if (name === 'greedy') {
    checks.push(['greedy: meltdown in 15–60%', melts.length >= 0.15 * n && melts.length <= 0.6 * n]);
    checks.push(['greedy: ≥ ⅔ of meltdowns after a pit', melts.length > 0 && melts.filter((r) => r.afterPit).length >= (2 / 3) * melts.length]);
  } else if (name === 'idle') {
    checks.push(['idle: all sacked', sacked.length === n]);
    checks.push(['idle: median ≤ 4 h, max ≤ 8 h', median(hrs) <= 4 && Math.max(...hrs) <= 8]);
  }
}
if ('cautious' in scores && 'greedy' in scores) {
  checks.push(['obeying the rule pays on average (cautious mean score > greedy)', scores.cautious > scores.greedy]);
}
console.log('');
for (const [what, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
