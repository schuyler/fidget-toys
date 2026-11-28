// @ts-check
// RBMK reactor simulation. Pure: no DOM, no clock, no randomness.
//
// Determinism: state is floats, and only + − × ÷, min, max and abs touch
// it (no Math.exp, log, pow), so the same inputs give bit-identical games
// in any engine. That's what lets the end screen replay a shift.
//
// Model (see DESIGN.md):
//   reactivity r, in dollars ($1 = prompt critical), from rods, xenon,
//   steam (positive: the RBMK's flaw) and fuel temperature (negative).
//   Power by one-group point kinetics with the prompt-jump approximation:
//     n = C / (1 − r),  dC/dt = λ (n − C)
//   Xenon and iodine run on the shift clock, which is sped up (xenonScale).

/**
 * @typedef {typeof DEFAULTS} Params
 *
 * @typedef {Object} State
 * @property {Params} params
 * @property {'running'|'scramming'|'shutdown'|'meltdown'} status
 * @property {null|'prompt'|'fuel'} cause      why it melted down
 * @property {number} clock       shift time, game seconds
 * @property {number} C           delayed-neutron precursors (power-like)
 * @property {number} n           power, fraction of nominal
 * @property {number} r           reactivity, dollars (as of the last step)
 * @property {number} rods        bank insertion 0..1 (fraction of the rods in)
 * @property {number} rodsTarget
 * @property {number} scramX      on scram: how far the withdrawn rods have travelled, 0..1
 * @property {number} scramFrom   bank insertion when AZ-5 was pressed
 * @property {number} P           drum pressure, bar
 * @property {number} pTarget
 * @property {number} flow        main pump flow, 1 = nominal
 * @property {number} alpha       steam (void) fraction
 * @property {number} Tf          fuel temperature, °C
 * @property {number} I           iodine-135, 1 = full-power equilibrium
 * @property {number} X           xenon-135, 1 = full-power equilibrium
 * @property {number} damage      fuel damage 0..1
 * @property {boolean} relief     relief valves open
 * @property {number} reliefTime  game seconds the relief valves have been open
 * @property {{ value: number, at: number }} printout  the last margin printout (rods, clock)
 * @property {{ value: number, at: number } | null} printing  the one being computed
 *
 * @typedef {{ type: 'meltdown', cause: 'prompt'|'fuel' }
 *   | { type: 'shutdown' }
 *   | { type: 'relief', open: boolean }
 *   | { type: 'printout', value: number }
 *   | { type: 'dryout', on: boolean }} SimEvent
 */

const LN2 = 0.6931471805599453;
const HOUR = 3600;

export const DEFAULTS = {
  // Plant
  nominalMW: 3200,       // thermal
  efficiency: 0.31,      // MWe per MWt
  rodCount: 60,          // rods in the bank; the margin printout counts these
  // Kinetics
  lambda: 0.08,          // delayed-neutron decay constant, 1/s (one group)
  promptLimit: 0.995,    // r at or above this is prompt critical: meltdown
  maxDt: 0.02,           // physics sub-step, s
  maxRateDt: 0.05,       // sub-step shrinks so λ·r/(1−r)·dt stays under this
  // Reactivity, dollars
  rodWorth: 12,          // the whole bank, all rods in
  xenonWorth: 4,         // xenon at full-power equilibrium
  voidWorth: 5,          // steam fraction 1.0
  dopplerWorth: 1.5,     // per 600 °C of fuel above T_ref
  tipWorth: 0.06,        // graphite displacer effect, per rod, as a fraction of its worth
  tipXenon: 2,           // ...multiplied by 1 + this × (X − 1) when xenon is above equilibrium:
                         // xenon poisons the middle of the core, pushing flux to the bottom,
                         // which is where the displacers arrive
  tipWidth: 0.3,         // the displacer effect is felt over this much of a rod's travel
  startRods: 0.5,        // bank insertion at full power, used to set the core's excess reactivity
  // Rods
  strokeTime: 8,         // s for a rod's full travel (normal drive and scram alike)
  // Steam and temperature
  alphaMax: 0.55,
  alphaN0: 0.1,          // steam rises steeply below about this power
  alphaSub: 0.05,        // subcooling offset
  alphaPerBar: 0.01,     // less steam per bar of pressure
  alphaTau: 2,           // s
  dryoutAlpha: 0.58,     // above this, heat transfer collapses
  dryoutSlope: 8,
  dryoutFloor: 0.2,
  fuelRise: 600,         // °C above coolant at full power
  fuelTau: 5,            // s
  tRef: 285,             // °C: Doppler zero (coolant temperature at 70 bar)
  damageTemp: 1200,      // °C: fuel damage above this
  damageScale: 400,      // °C over the limit that doubles the damage rate
  damageTime: 20,        // s to destroy the fuel at damageTemp + damageScale
  meltTemp: 2800,        // °C: the fuel melts outright (UO2 melts near 2850 °C)
  // Pressure
  pMin: 55,
  pMax: 80,
  pNominal: 70,
  pTau: 3,               // s
  reliefP: 78,           // relief valves lift above this
  // Xenon (game time)
  halfLifeI: 6.57 * HOUR,
  halfLifeX: 9.14 * HOUR,
  burnout: 5,            // xenon burnout at full power, as a multiple of its decay rate
  directYield: 0.04,     // share of xenon made directly, not via iodine
  xenonScale: 120,       // game seconds per physics second (1 s = 2 game min)
  // Margin printout (game time)
  printEvery: 300,
  printDelay: 60,
};

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** Smoothstep: a rod's worth against its own depth (weak at the ends of travel). @param {number} x */
const sStep = (x) => x * x * (3 - 2 * x);

/** Saturation temperature, °C (linear fit to steam tables, 55–80 bar). @param {number} P */
export const tSat = (P) => 270 + (P - 55) * 1.0;

/** Equilibrium steam fraction. @param {Params} p @param {number} n @param {number} P @param {number} flow */
export function alphaEq(p, n, P, flow) {
  const m = Math.max(0, n) / flow;
  return clamp(p.alphaMax * m / (m + p.alphaN0) - p.alphaSub - p.alphaPerBar * (P - p.pNominal), 0, p.alphaMax + 0.2);
}

/** Heat-transfer factor: 1 normally, collapsing past dryout. @param {Params} p @param {number} alpha */
export function heatTransfer(p, alpha) {
  return alpha <= p.dryoutAlpha ? 1 : Math.max(p.dryoutFloor, 1 - (alpha - p.dryoutAlpha) * p.dryoutSlope);
}

/** Equilibrium fuel temperature. @param {Params} p @param {number} n @param {number} P @param {number} alpha */
export function fuelEq(p, n, P, alpha) {
  return tSat(P) + p.fuelRise * Math.max(0, n) / heatTransfer(p, alpha);
}

/**
 * One rod's reactivity at depth x (0 = fully out), as a fraction of its full
 * worth. Negative is absorbing. Near the top it's *positive*: the graphite
 * displacer on the rod's tip pushes water out of the bottom of the channel
 * before the absorber arrives.
 * @param {Params} p @param {number} x @param {number} [X] xenon (skews the flux)
 */
export function rodShape(p, x, X = 1) {
  const u = x / p.tipWidth;
  const tip = u < 1 ? 4 * u * (1 - u) : 0;
  return -sStep(x) + p.tipWorth * (1 + p.tipXenon * Math.max(0, X - 1)) * tip;
}

/**
 * The bank's reactivity. In normal operation rods move one after another, so
 * the bank is linear in insertion and the tip effect is negligible. On scram
 * every withdrawn rod moves at once, and their displacers all arrive together.
 * @param {State} s
 */
export function rodReactivity(s) {
  const p = s.params;
  if (s.status === 'running') return -p.rodWorth * s.rods;
  const out = 1 - s.scramFrom;
  return -p.rodWorth * (s.scramFrom - out * rodShape(p, s.scramX, s.X));
}

/** Xenon equilibrium for a steady power. @param {Params} p @param {number} n */
export function xenonEquilibrium(p, n) {
  const lx = LN2 / p.halfLifeX, sig = p.burnout * lx;
  return { I: n, X: (lx + sig) * n / (lx + sig * n) };
}

/**
 * Advance iodine and xenon by dt game seconds at power n.
 * dI/dt = λI (n − I)
 * dX/dt = (λX + σ) (g n + (1 − g) I) − λX X − σ n X
 * (normalized so both are 1 at full-power equilibrium; σ is burnout at full power)
 * @param {Params} p @param {number} I @param {number} X @param {number} n @param {number} dt
 */
export function xenonStep(p, I, X, n, dt) {
  const li = LN2 / p.halfLifeI, lx = LN2 / p.halfLifeX, sig = p.burnout * lx, g = p.directYield;
  const nn = Math.max(0, n);
  const dI = li * (nn - I);
  const dX = (lx + sig) * (g * nn + (1 - g) * I) - lx * X - sig * nn * X;
  return { I: I + dI * dt, X: Math.max(0, X + dX * dt) };
}

/** The core's built-in excess reactivity: whatever makes r = 0 at full power. @param {Params} p */
function fuelReactivity(p) {
  const a = alphaEq(p, 1, p.pNominal, 1);
  const tf = fuelEq(p, 1, p.pNominal, a);
  return p.rodWorth * p.startRods + p.xenonWorth - p.voidWorth * a + p.dopplerWorth * (tf - p.tRef) / 600;
}

/** Total reactivity, dollars. @param {State} s */
export function reactivity(s) {
  const p = s.params;
  return fuelReactivity(p) + rodReactivity(s) - p.xenonWorth * s.X + p.voidWorth * s.alpha
    - p.dopplerWorth * (s.Tf - p.tRef) / 600;
}

/**
 * A reactor at steady state: the given power and pressure, xenon at
 * equilibrium (unless `X` is given), rods wherever that leaves r = 0.
 * @param {Partial<Params>} [params]
 * @param {{ power?: number, pressure?: number, X?: number, I?: number }} [start]
 * @returns {State}
 */
export function createReactor(params = {}, start = {}) {
  const p = { ...DEFAULTS, ...params };
  const n = start.power ?? 1;
  const P = start.pressure ?? p.pNominal;
  const eq = xenonEquilibrium(p, n);
  const alpha = alphaEq(p, n, P, 1);
  /** @type {State} */
  const s = {
    params: p, status: 'running', cause: null, clock: 0,
    C: n, n, r: 0, rods: 0, rodsTarget: 0, scramX: 0, scramFrom: 0,
    P, pTarget: P, flow: 1, alpha, Tf: fuelEq(p, n, P, alpha),
    I: start.I ?? eq.I, X: start.X ?? eq.X, damage: 0, relief: false, reliefTime: 0,
    printout: { value: 0, at: 0 }, printing: null,
  };
  // Rods are linear in normal operation, so solve r = 0 for them directly.
  s.rods = clamp(reactivity(s) / p.rodWorth, 0, 1);
  s.rodsTarget = s.rods;
  s.r = reactivity(s);
  s.printout = { value: margin(s), at: 0 };
  return s;
}

/** Operational reactivity margin, in rods (the true figure, not the printout). @param {State} s */
export const margin = (s) => s.rods * s.params.rodCount;

/**
 * The player's controls. Ignored once AZ-5 is pressed.
 * @param {State} s @param {{ rodsTarget?: number, pTarget?: number }} c rodsTarget in rods (0..rodCount), pTarget in bar
 */
export function setControls(s, c) {
  if (s.status !== 'running') return;
  if (c.rodsTarget !== undefined) s.rodsTarget = clamp(c.rodsTarget / s.params.rodCount, 0, 1);
  if (c.pTarget !== undefined) s.pTarget = clamp(c.pTarget, s.params.pMin, s.params.pMax);
}

/** Press AZ-5: every rod drives in, and the controls lock. @param {State} s */
export function scram(s) {
  if (s.status !== 'running') return;
  s.status = 'scramming';
  s.scramFrom = s.rods;
  s.scramX = 0;
}

/**
 * Advance the physics by dt seconds (already slowed by any slow motion; the
 * shift clock advances dt × xenonScale). Returns what happened.
 * @param {State} s @param {number} dt
 * @returns {SimEvent[]}
 */
export function step(s, dt) {
  /** @type {SimEvent[]} */
  const events = [];
  let left = dt;
  while (left > 1e-12 && (s.status === 'running' || s.status === 'scramming')) {
    const rate = Math.abs(s.params.lambda * s.r / (1 - s.r));
    let h = Math.min(left, s.params.maxDt);
    if (rate * h > s.params.maxRateDt) h = s.params.maxRateDt / rate;
    substep(s, h, events);
    left -= h;
  }
  return events;
}

/** @param {State} s @param {number} h @param {SimEvent[]} events */
function substep(s, h, events) {
  const p = s.params;
  const travel = h / p.strokeTime;

  // Rods
  if (s.status === 'running') {
    const d = s.rodsTarget - s.rods;
    s.rods += clamp(d, -travel, travel);
  } else {
    s.scramX = Math.min(1, s.scramX + travel);
  }

  // Pressure, steam, fuel temperature (first-order lags)
  s.P += (s.pTarget - s.P) * Math.min(1, h / p.pTau);
  const wasDry = s.alpha > p.dryoutAlpha;
  s.alpha += (alphaEq(p, s.n, s.P, s.flow) - s.alpha) * Math.min(1, h / p.alphaTau);
  const dry = s.alpha > p.dryoutAlpha;
  if (dry !== wasDry) events.push({ type: 'dryout', on: dry });
  // Heat in from fission, out to the coolant. A power spike heats the fuel
  // faster than it can cool, however brief.
  const heatIn = p.fuelRise * Math.max(0, s.n);
  const heatOut = (s.Tf - tSat(s.P)) * heatTransfer(p, s.alpha);
  s.Tf += (heatIn - heatOut) * h / p.fuelTau;

  // Xenon, on the shift clock
  const gh = h * p.xenonScale;
  const xe = xenonStep(p, s.I, s.X, s.n, gh);
  s.I = xe.I; s.X = xe.X;
  s.clock += gh;

  // Power: prompt jump to the new reactivity, then precursors follow
  s.r = reactivity(s);
  if (s.r >= p.promptLimit) return melt(s, 'prompt', events);
  s.n = s.C / (1 - s.r);
  s.C += p.lambda * (s.n - s.C) * h;

  // Fuel damage
  if (s.Tf >= p.meltTemp) return melt(s, 'fuel', events);
  if (s.Tf > p.damageTemp) {
    s.damage += (1 + (s.Tf - p.damageTemp) / p.damageScale) / 2 * h / p.damageTime;
    if (s.damage >= 1) return melt(s, 'fuel', events);
  }

  // Relief valves
  const open = s.P > p.reliefP;
  if (open !== s.relief) { s.relief = open; events.push({ type: 'relief', open }); }
  if (open) s.reliefTime += gh;

  // Margin printout: started every printEvery, delivered printDelay later,
  // showing the margin from when it started.
  if (s.printing && s.clock >= s.printing.at + p.printDelay) {
    s.printout = s.printing;
    s.printing = null;
    events.push({ type: 'printout', value: s.printout.value });
  }
  if (!s.printing && s.clock >= s.printout.at + p.printEvery) {
    s.printing = { value: margin(s), at: s.clock };
  }

  // A completed scram that has brought power down ends the shift.
  if (s.status === 'scramming' && s.scramX >= 1 && s.n < 0.01) {
    s.status = 'shutdown';
    events.push({ type: 'shutdown' });
  }
}

/** @param {State} s @param {'prompt'|'fuel'} cause @param {SimEvent[]} events */
function melt(s, cause, events) {
  s.status = 'meltdown';
  s.cause = cause;
  events.push({ type: 'meltdown', cause });
}

/**
 * What the instruments show. Leaves out what the operator can't see
 * (xenon, iodine, reactivity, the true margin).
 * @param {State} s
 */
export function readouts(s) {
  const p = s.params;
  const thermal = Math.max(0, s.n) * p.nominalMW;
  return {
    status: s.status,
    clock: s.clock,
    thermalMW: thermal,
    electricMW: thermal * p.efficiency,
    coreTemp: s.Tf,
    steam: s.alpha,
    pressure: s.P,
    pTarget: s.pTarget,
    rods: s.status === 'running' ? s.rods * p.rodCount : p.rodCount * (s.scramFrom + (1 - s.scramFrom) * s.scramX),
    rodsTarget: s.rodsTarget * p.rodCount,
    /** Power's growth rate, 1/s. Doubling time is ln 2 / this (presentation does the log). */
    growthRate: s.status === 'meltdown' ? Infinity : p.lambda * s.r / (1 - s.r),
    printout: s.printout,
    dryout: s.alpha > p.dryoutAlpha,
    damageLamp: s.damage > 0,
    relief: s.relief,
  };
}

/** A copy of the state, for replay. @param {State} s @returns {State} */
export function snapshot(s) {
  return { ...s, printout: { ...s.printout }, printing: s.printing && { ...s.printing } };
}
