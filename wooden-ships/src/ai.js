// @ts-check
// The CPU captain. It only ever sends the inputs a human can (rudder and the
// two fire buttons), through applyInput, and keeps its own RNG so it never
// disturbs the game's.
//
// Plan (re-made every few ticks): pick a point beside the enemy — on her beam
// to trade broadsides, or across her bow or stern to rake (hard only) — that
// it can reach soonest given the wind; steer for it, beating when it's
// upwind; dodge land; fire a side when a simulated ripple would hit.

import { createRng } from './rng.js';
import {
  TURN, deg, isin, icos, angleOf, angleDiff, aimGun, forwardSpeed, terrainAt,
  hullDistance2, LAND, SHALLOW, STARBOARD, PORT,
} from './sim.js';

/** Rough share of top speed at each angle off the true wind (measured headless at 14 kts). */
const POLAR = [[0, 0], [45, 0], [50, 0.06], [55, 0.17], [60, 0.28], [65, 0.37], [70, 0.46], [80, 0.6], [90, 0.74], [110, 0.91], [135, 1], [180, 0.79]];
/** Close-hauled: degrees off the wind it beats at. */
const BEAT = 65;
const BEAT_U = deg(BEAT);

/** @param {number} offDeg */
function polar(offDeg) {
  for (let i = 1; i < POLAR.length; i++) {
    const [a1, v1] = POLAR[i], [a0, v0] = POLAR[i - 1];
    if (offDeg <= a1) return v0 + ((v1 - v0) * (offDeg - a0)) / (a1 - a0);
  }
  return POLAR[POLAR.length - 1][1];
}
/** Speed share made good along a bearing `offDeg` off the wind, beating if need be. @param {number} offDeg */
function madeGood(offDeg) {
  if (offDeg >= BEAT) return polar(offDeg);
  return polar(BEAT) * icos(deg(BEAT - offDeg));
}

/**
 * @param {number} shipId
 * @param {number} seed
 * @param {{ level?: 'easy'|'hard' }} [opts]
 */
export function createAI(shipId, seed, opts = {}) {
  const rng = createRng(seed);
  const hard = opts.level !== 'easy';
  const period = hard ? 5 : 10;
  /** Easy reacts a second late: its inputs wait in this queue. */
  const delay = hard ? 0 : 30;
  /** @type {{at: number, input: import('./sim.js').Input}[]} */
  const queue = [];
  let rudder = 0;
  /** Which tack it's on: +1 = heading clockwise of the wind, −1 anticlockwise. */
  let tack = 1;
  let tackSince = 0;
  let wearing = 0; // ticks left of a wear (turning downwind round to the other tack)
  let wearDir = 1;

  /** @param {import('./sim.js').Game} game */
  function think(game) {
    /** @type {import('./sim.js').Input[]} */
    const out = [];
    const me = game.ships[shipId];
    if (!me || me.struck || game.winner >= 0) return out;
    const foe = game.ships.find((s) => s.side !== me.side && !s.struck);
    if (!foe) { // the fight is won: straighten up and sail on until the end screen
      if (rudder !== 0) { rudder = 0; out.push({ type: 'rudder', value: 0 }); }
      return out;
    }

    if (game.tick % period === 0) {
      const r = steer(game, me, foe);
      if (r !== rudder) { rudder = r; queue.push({ at: game.tick + delay, input: { type: 'rudder', value: r } }); }
      for (const b of [PORT, STARBOARD]) {
        const bat = me.batteries[b];
        if (bat.reloadLeft > 0 || bat.firing > 0) continue;
        const hits = predictHits(game, me, foe, b);
        if (hits >= (hard ? 2 : 1)) queue.push({ at: game.tick + delay, input: { type: 'fire', battery: b } });
      }
    }
    while (queue.length && queue[0].at <= game.tick) out.push(/** @type {any} */ (queue.shift()).input);
    return out;
  }

  /**
   * @param {import('./sim.js').Game} game
   * @param {import('./sim.js').Ship} me
   * @param {import('./sim.js').Ship} foe
   */
  function steer(game, me, foe) {
    const wf = game.wind.dir; // wind blows FROM here
    const top = Math.max(1, game.wind.speed * 0.5144); // rough top speed, m per game s
    const fc = icos(foe.heading), fs = isin(foe.heading);
    const R = 120;
    /** @type {{x: number, y: number, kind: 'beam'|'rake'}[]} */
    const spots = [
      { x: -fs * R, y: fc * R, kind: 'beam' }, // off her starboard side
      { x: fs * R, y: -fc * R, kind: 'beam' }, // off her port side
    ];
    if (hard) spots.push({ x: fc * R * 1.2, y: fs * R * 1.2, kind: 'rake' }, { x: -fc * R * 1.2, y: -fs * R * 1.2, kind: 'rake' });
    let best = null, bestEta = Infinity;
    for (const s of spots) {
      let gx = foe.x + s.x, gy = foe.y + s.y;
      let eta = 0;
      for (let k = 0; k < 2; k++) { // lead the enemy by our time to get there
        const lead = Math.min(eta, 25);
        const px = foe.x + foe.vx * lead + s.x, py = foe.y + foe.vy * lead + s.y;
        gx = px; gy = py;
        const dx = gx - me.x, dy = gy - me.y;
        const off = Math.abs(angleDiff(wf, angleOf(dx, dy))) * 360 / TURN;
        eta = Math.sqrt(dx * dx + dy * dy) / (top * Math.max(0.05, madeGood(off)));
      }
      // Off the map or on land: not a real option.
      if (terrainAt(game, gx, gy) === LAND) eta += 1000;
      if (eta < bestEta) { bestEta = eta; best = { x: gx, y: gy, kind: s.kind }; }
    }
    if (!best) return 0;
    const dx = best.x - me.x, dy = best.y - me.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let want = angleOf(dx, dy);
    if (dist < 50) {
      // Arrived: lie alongside (beam) or across her line (rake).
      if (best.kind === 'beam') want = foe.heading;
      else {
        const a = (foe.heading + TURN / 4) & (TURN - 1), b = (foe.heading - TURN / 4) & (TURN - 1);
        want = Math.abs(angleDiff(me.heading, a)) < Math.abs(angleDiff(me.heading, b)) ? a : b;
      }
    }

    const vf = forwardSpeed(me);
    const myOff = angleDiff(wf, me.heading);
    // Beating: the goal is inside the no-go zone, so sail close-hauled on a tack.
    const wantOff = angleDiff(wf, want);
    if (wearing > 0) {
      wearing -= period;
      if (Math.abs(angleDiff(wf, me.heading)) < BEAT_U && Math.sign(myOff) === tack) wearing = 0;
      else return wearDir * 100 * (vf < 0 ? -1 : 1);
    }
    if (Math.abs(wantOff) < BEAT_U) {
      const here = Math.sign(myOff) || 1;
      if (here !== tack && game.tick - tackSince > 60) tack = here;
      const onTack = (wf + tack * BEAT_U) & (TURN - 1);
      const other = (wf - tack * BEAT_U) & (TURN - 1);
      const gain = Math.abs(angleDiff(onTack, want)) - Math.abs(angleDiff(other, want));
      if (gain > deg(30) && game.tick - tackSince > 90) {
        if (vf > 1.2) { tack = -tack; tackSince = game.tick; }
        else if (game.tick - tackSince > 300) {
          // Too slow to tack: wear round instead (turn away through downwind).
          tack = -tack; tackSince = game.tick; wearing = 400; wearDir = -tack;
          return wearDir * 100 * (vf < 0 ? -1 : 1);
        }
      }
      want = (wf + tack * BEAT_U) & (TURN - 1);
    }

    want = clearHeading(game, me, want);
    let diff = angleDiff(me.heading, want);
    // In irons (stopped, bow near the wind): steer for the tack's side, and
    // remember a ship going backwards steers the other way.
    if (Math.abs(vf) < 0.3 && Math.abs(myOff) < deg(50)) diff = (Math.sign(myOff) || tack) * deg(90);
    let r = Math.max(-100, Math.min(100, Math.round((diff / deg(25)) * 100)));
    if (vf < 0) r = -r;
    if (!hard) r = Math.round(r / 20) * 20; // easy is a little heavy-handed on the helm
    return r;
  }

  /**
   * The nearest heading to `want` that doesn't run onto land in the next
   * few lengths (hard also avoids shallows when it can).
   * @param {import('./sim.js').Game} game @param {import('./sim.js').Ship} me @param {number} want
   */
  function clearHeading(game, me, want) {
    const speed = Math.max(2, Math.sqrt(me.vx * me.vx + me.vy * me.vy));
    const look = Math.min(220, 40 + speed * 18);
    const blocked = (/** @type {number} */ h, /** @type {boolean} */ strict) => {
      const c = icos(h), s = isin(h);
      for (let d = 30; d <= look; d += 20) {
        for (const side of [-8, 0, 8]) {
          const t = terrainAt(game, me.x + c * d - s * side, me.y + s * d + c * side);
          if (t === LAND || (strict && t === SHALLOW)) return true;
        }
      }
      return false;
    };
    for (const strict of hard ? [true, false] : [false]) {
      if (!blocked(want, strict)) return want;
      for (let k = 1; k <= 9; k++) {
        for (const sgn of [1, -1]) {
          const h = (want + sgn * k * deg(20)) & (TURN - 1);
          if (!blocked(h, strict)) return h;
        }
      }
    }
    return want;
  }

  /**
   * How many balls of a ripple from this side would hit, if fired now:
   * guns aim as the sim aims them, and the enemy holds her course.
   * @param {import('./sim.js').Game} game @param {import('./sim.js').Ship} me
   * @param {import('./sim.js').Ship} foe @param {number} b
   */
  function predictHits(game, me, foe, b) {
    const p = game.params;
    const dt = p.timeScale / p.tickRate;
    const perTick = p.muzzleSpeed / p.tickRate;
    const life = Math.round((p.gunRange / p.muzzleSpeed) * p.tickRate);
    const gap = Math.max(1, Math.round(p.ripple * p.tickRate));
    const r = foe.type.beam / 2;
    const slop = hard ? 0 : 25;
    const ox = slop ? (rng.next() - 0.5) * 2 * slop : 0, oy = slop ? (rng.next() - 0.5) * 2 * slop : 0;
    let hits = 0;
    for (let g = 0; g < me.type.gunsPerSide; g++) {
      const aim = aimGun(game, me, b, g);
      const k0 = g * gap;
      const bx0 = aim.x + me.vx * dt * k0, by0 = aim.y + me.vy * dt * k0;
      const vx = aim.dx * perTick + me.vx * dt, vy = aim.dy * perTick + me.vy * dt;
      for (let k = 1; k <= life; k++) {
        const t = k0 + k;
        const bx = bx0 + vx * k, by = by0 + vy * k;
        const fx = foe.x + foe.vx * dt * t + ox, fy = foe.y + foe.vy * dt * t + oy;
        if (hullDistance2({ ...foe, x: fx, y: fy }, bx, by) <= r * r) { hits++; break; }
        if (terrainAt(game, bx, by) === LAND) break;
      }
    }
    return hits;
  }

  return { ship: shipId, think };
}
