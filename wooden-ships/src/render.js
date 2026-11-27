// Canvas renderer: sea, islands, ships, balls, effects and the HUD.
// Presentation only: floats and Math.random are fine here. Everything goes
// through a camera (world metres → screen pixels), so a sea bigger than the
// screen would be a camera change, not a rewrite.

import { icos, isin, toRad, angleDiff, batteryDir, windAt, LAND, SHALLOW } from './sim.js';

/** @typedef {import('./sim.js').Game} Game @typedef {import('./sim.js').Events} Events */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

export const COLORS = {
  text: '#e8ecff',
  players: ['#4f8fd8', '#e0645a'],
  ocean: '#abe3f5',
  deep: '#8fd3ee',
};

// Tile pieces from the prototype's Tiled map ("corner" terrain set). Key:
// TL·8 + TR·4 + BR·2 + BL·1, a bit set when that corner is at the level.
const SHALLOW_TILES = { 2: 9, 3: 10, 1: 11, 6: 25, 15: 26, 9: 27, 4: 41, 12: 42, 8: 43, 13: 57, 14: 58, 11: 73, 7: 74 };
const BEACH_TILES = { 2: 0, 3: 1, 1: 2, 6: 16, 9: 18, 4: 32, 12: 33, 8: 34, 13: 3, 14: 4, 11: 19, 7: 20 };
const SAND = [67, 68];

/**
 * Load the sprite sheet (with its XML atlas), the terrain tiles and the
 * compass arrow.
 * @param {string} base URL of the assets directory, ending in /
 */
export async function loadAssets(base) {
  const img = (/** @type {string} */ src) => new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(`could not load ${src}`));
    i.src = base + src;
  });
  const [sheet, tiles, arrow, xml] = await Promise.all([
    img('shipsMiscellaneous_sheet.png'), img('tiles_sheet.png'), img('arrow.png'),
    fetch(base + 'shipsMiscellaneous_sheet.xml').then((r) => r.text()),
  ]);
  /** @type {Map<string, Rect>} */
  const atlas = new Map();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  for (const el of doc.querySelectorAll('SubTexture')) {
    const n = (/** @type {string} */ k) => Number(el.getAttribute(k));
    atlas.set(String(el.getAttribute('name')).replace(/\.png$/, ''), { x: n('x'), y: n('y'), w: n('width'), h: n('height') });
  }
  return { sheet: /** @type {HTMLImageElement} */ (sheet), tiles: /** @type {HTMLImageElement} */ (tiles), arrow: /** @type {HTMLImageElement} */ (arrow), atlas };
}
/** @typedef {Awaited<ReturnType<typeof loadAssets>>} Assets */

/** Metres of sea across the screen's short side: about 11 ship lengths, so a ship is ~35 px on a phone. */
export const VIEW_SHORT = 450;
/** Most pixels the pre-drawn island layer may have (phones cap canvas size). */
const MAX_TERRAIN_PX = 12e6;

/** Safe-area insets, read from the #safe-probe element (JS can't read env()). */
function safeInsets() {
  const probe = document.getElementById('safe-probe');
  if (!probe) return { top: 0, bottom: 0, left: 0, right: 0 };
  const st = getComputedStyle(probe);
  const n = (/** @type {string} */ v) => parseFloat(v) || 0;
  return { top: n(st.paddingTop), bottom: n(st.paddingBottom), left: n(st.paddingLeft), right: n(st.paddingRight) };
}

/**
 * @typedef {{ x: number, y: number, vx: number, vy: number, life: number, max: number,
 *   kind: 'smoke'|'ring'|'dust'|'flash'|'boom'|'wood'|'foam', size: number, rot: number, spin: number, sprite?: string }} Fx
 * @typedef {{ x: number, y: number, r: number, battery: number, reload: number, firing: boolean, pressed: boolean, label: string }} FireButton
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Assets} assets
 */
export function createRenderer(canvas, assets) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  let dpr = 1, cw = 0, ch = 0;
  /** camera: screen = o + world × scale, centred on (camX, camY) */
  let scale = 1, ox = 0, oy = 0;
  let camX = 0, camY = 0, camReady = false;
  /** pixels per metre in the terrain layer */
  let terrainScale = 1;
  /** where the off-screen enemy arrow was last drawn, for tests */
  /** @type {{x: number, y: number, dist: number}|null} */ let arrow = null;
  let safe = { top: 0, bottom: 0, left: 0, right: 0 };
  /** @type {Game|null} */ let game = null;
  /** @type {HTMLCanvasElement|null} */ let terrain = null;
  /** previous tick's ship poses, for interpolation */
  /** @type {{x: number, y: number, heading: number}[]} */ let prev = [];
  /** @type {{x: number, y: number}[]} */ let prevBalls = [];
  /** @type {Fx[]} */ let fx = [];
  /** @type {{x: number, y: number, len: number, life: number}[]} */ let streaks = [];
  let shake = 0;
  let time = 0;

  /** @param {Game} g */
  function setGame(g) {
    game = g;
    fx = [];
    streaks = [];
    camReady = false;
    snapshot();
    layout();
  }

  function snapshot() {
    if (!game) return;
    prev = game.ships.map((s) => ({ x: s.x, y: s.y, heading: s.heading }));
    prevBalls = game.balls.map((b) => ({ x: b.x, y: b.y }));
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    safe = safeInsets();
    if (!game) return;
    scale = Math.min(cw, ch) / VIEW_SHORT;
    camReady = false;
    buildTerrain();
  }

  /** Islands never move: draw the tiles once, at screen resolution. */
  function buildTerrain() {
    if (!game) return;
    const g = game;
    terrainScale = Math.min(scale * dpr, Math.sqrt(MAX_TERRAIN_PX / (g.seaW * g.seaH)));
    const t = g.params.tile * terrainScale;
    terrain = document.createElement('canvas');
    terrain.width = Math.ceil(g.seaW * terrainScale);
    terrain.height = Math.ceil(g.seaH * terrainScale);
    const c = /** @type {CanvasRenderingContext2D} */ (terrain.getContext('2d'));
    c.imageSmoothingQuality = 'high';
    c.fillStyle = COLORS.ocean;
    c.fillRect(0, 0, terrain.width, terrain.height);
    // a faint swell so open water isn't flat
    c.globalAlpha = 0.18;
    c.fillStyle = COLORS.deep;
    for (let i = 0; i < (g.W * g.H) / 6; i++) {
      const x = Math.random() * terrain.width, y = Math.random() * terrain.height;
      c.beginPath();
      c.ellipse(x, y, t * (0.6 + Math.random()), t * 0.18, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
    const cw1 = g.W + 1;
    const at = (/** @type {number} */ i, /** @type {number} */ j) => g.corners[j * cw1 + i];
    const piece = (/** @type {number} */ id, /** @type {number} */ i, /** @type {number} */ j) => {
      const x0 = Math.round(i * t), y0 = Math.round(j * t);
      const x1 = Math.round((i + 1) * t), y1 = Math.round((j + 1) * t);
      c.drawImage(assets.tiles, (id % 16) * 64, Math.floor(id / 16) * 64, 64, 64, x0, y0, x1 - x0, y1 - y0);
    };
    for (const [level, set] of /** @type {[number, Record<number, number>][]} */ ([[SHALLOW, SHALLOW_TILES], [LAND, BEACH_TILES]])) {
      for (let j = 0; j < g.H; j++) {
        for (let i = 0; i < g.W; i++) {
          const key = (at(i, j) >= level ? 8 : 0) | (at(i + 1, j) >= level ? 4 : 0) | (at(i + 1, j + 1) >= level ? 2 : 0) | (at(i, j + 1) >= level ? 1 : 0);
          if (!key) continue;
          if (key === 15 && level === LAND) {
            piece(SAND[Math.abs((i * 73856093) ^ (j * 19349663)) % 2], i, j);
          } else {
            const id = set[key];
            if (id !== undefined) piece(id, i, j);
          }
        }
      }
    }
  }

  /**
   * Follow your ship, leading a little the way she's moving; when the enemy
   * is near, pan toward the middle so both fit, but never push your ship
   * out of the middle 60% of the screen. Smoothed, and kept inside the sea.
   * @param {{x: number, y: number}[]} poses @param {number} you @param {number} dt @param {number} ts
   */
  function updateCamera(poses, you, dt, ts) {
    if (!game) return;
    const g = game;
    const me = poses[you], ship = g.ships[you];
    const vw = cw / scale, vh = ch / scale;
    let tx = me.x, ty = me.y;
    const foeIdx = g.ships.findIndex((s) => s.side !== ship.side);
    if (foeIdx >= 0) {
      const f = poses[foeIdx];
      tx = (me.x + f.x) / 2;
      ty = (me.y + f.y) / 2;
    }
    // lead: where she'll be in about a second and a half
    tx += Math.max(-vw * 0.2, Math.min(vw * 0.2, ship.vx * ts * 1.5));
    ty += Math.max(-vh * 0.2, Math.min(vh * 0.2, ship.vy * ts * 1.5));
    tx = Math.max(me.x - vw * 0.3, Math.min(me.x + vw * 0.3, tx));
    ty = Math.max(me.y - vh * 0.3, Math.min(me.y + vh * 0.3, ty));
    if (!camReady) { camX = tx; camY = ty; camReady = true; }
    const k = 1 - Math.exp(-dt * 2.5);
    camX += (tx - camX) * k;
    camY += (ty - camY) * k;
    camX = vw >= g.seaW ? g.seaW / 2 : Math.max(vw / 2, Math.min(g.seaW - vw / 2, camX));
    camY = vh >= g.seaH ? g.seaH / 2 : Math.max(vh / 2, Math.min(g.seaH - vh / 2, camY));
    ox = cw / 2 - camX * scale;
    oy = ch / 2 - camY * scale;
  }

  /** @param {number} x @param {number} y */
  const sx = (x) => ox + x * scale;
  const sy = (/** @type {number} */ y) => oy + y * scale;

  /** @param {Events} ev */
  function onTick(ev) {
    if (!game) return;
    const g = game;
    snapshot();
    const w = windAt(g);
    for (const f of ev.fired) {
      const ship = g.ships[f.ship];
      fx.push({ x: f.x + f.dx * 2, y: f.y + f.dy * 2, vx: 0, vy: 0, life: 0.12, max: 0.12, kind: 'flash', size: 9, rot: Math.atan2(f.dy, f.dx), spin: 0 });
      for (let i = 0; i < 4; i++) {
        fx.push({
          x: f.x + f.dx * 3, y: f.y + f.dy * 3,
          vx: f.dx * (6 + Math.random() * 6) + w.x * 0.8 + ship.vx, vy: f.dy * (6 + Math.random() * 6) + w.y * 0.8 + ship.vy,
          life: 1.2 + Math.random() * 0.8, max: 2, kind: 'smoke', size: 3 + Math.random() * 3, rot: 0, spin: 0,
        });
      }
    }
    for (const h of ev.hits) {
      fx.push({ x: h.x, y: h.y, vx: 0, vy: 0, life: 0.35, max: 0.35, kind: 'boom', size: 14, rot: Math.random() * 6, spin: 0, sprite: Math.random() < 0.5 ? 'explosion2' : 'explosion3' });
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 8;
        fx.push({ x: h.x, y: h.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.9, max: 0.9, kind: 'wood', size: 3, rot: a, spin: (Math.random() - 0.5) * 12, sprite: `wood (${1 + Math.floor(Math.random() * 4)})` });
      }
      if (h.ship === 0) shake = Math.min(1, shake + 0.25);
    }
    for (const s of ev.splashes) {
      if (s.land) fx.push({ x: s.x, y: s.y, vx: 0, vy: 0, life: 0.6, max: 0.6, kind: 'dust', size: 5, rot: 0, spin: 0 });
      else fx.push({ x: s.x, y: s.y, vx: 0, vy: 0, life: 0.7, max: 0.7, kind: 'ring', size: 5, rot: 0, spin: 0 });
    }
    // wakes
    if (g.tick % 3 === 0) {
      for (const ship of g.ships) {
        const v = Math.hypot(ship.vx, ship.vy);
        if (v < 0.8) continue;
        const c = icos(ship.heading), s = isin(ship.heading), L = ship.type.length / 2;
        for (const side of [-1, 1]) {
          fx.push({ x: ship.x - c * L * 0.8 - s * side * 3, y: ship.y - s * L * 0.8 + c * side * 3, vx: -s * side * 1.2, vy: c * side * 1.2, life: 2.5, max: 2.5, kind: 'foam', size: 2 + Math.min(3, v * 0.4), rot: 0, spin: 0 });
        }
      }
    }
  }

  /**
   * @param {number} alpha 0–1 between the previous tick and this one
   * @param {number} dt real seconds since the last frame
   * @param {{ you: number, buttons: FireButton[], rudder: number|null, overlay: Overlay|null, timeScale: number }} ui
   */
  function draw(alpha, dt, ui) {
    if (!game) return;
    const g = game;
    time += dt;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1020';
    ctx.fillRect(0, 0, cw, ch);
    const poses = g.ships.map((s, i) => {
      const p = prev[i] ?? s;
      return { x: p.x + (s.x - p.x) * alpha, y: p.y + (s.y - p.y) * alpha, heading: p.heading + angleDiff(p.heading, s.heading) * alpha };
    });
    updateCamera(poses, ui.you, dt, ui.timeScale);

    ctx.save();
    if (shake > 0) {
      const k = shake * 4;
      ctx.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
      shake = Math.max(0, shake - dt * 2.5);
    }
    if (terrain) {
      // only the part of the island layer that's on screen
      const x0 = Math.max(0, -ox / scale), y0 = Math.max(0, -oy / scale);
      const x1 = Math.min(g.seaW, (cw - ox) / scale), y1 = Math.min(g.seaH, (ch - oy) / scale);
      if (x1 > x0 && y1 > y0) {
        ctx.drawImage(terrain, x0 * terrainScale, y0 * terrainScale, (x1 - x0) * terrainScale, (y1 - y0) * terrainScale,
          sx(x0), sy(y0), (x1 - x0) * scale, (y1 - y0) * scale);
      }
    }

    drawStreaks(dt, ui.timeScale);
    drawFx(dt, ui.timeScale, ['foam', 'ring']);
    const me = g.ships[ui.you];
    if (me && !me.struck && g.winner < 0) drawNoGo(me, poses[ui.you]);
    g.ships.forEach((s, i) => drawShip(s, poses[i]));
    drawBalls(alpha);
    drawFx(dt, ui.timeScale, ['smoke', 'dust', 'flash', 'boom', 'wood']);
    ctx.restore();

    drawEnemyArrow(poses, ui.you);
    drawCompass();
    drawCrew(ui.you);
    for (const b of ui.buttons) drawButton(b, me);
    if (ui.rudder !== null) drawRudder(ui.rudder);
    if (ui.overlay) drawOverlay(ui.overlay);
  }

  /** Wind streaks drift with the true wind (game speed shown at real time). @param {number} dt @param {number} ts */
  function drawStreaks(dt, ts) {
    if (!game) return;
    const w = windAt(game);
    const ws = Math.hypot(w.x, w.y);
    // In world metres, so they slide past as the camera pans.
    const vx0 = -ox / scale, vy0 = -oy / scale, vw = cw / scale, vh = ch / scale;
    const spawn = (/** @type {{x: number, y: number, len: number, life: number}} */ s) => {
      s.x = vx0 + Math.random() * vw; s.y = vy0 + Math.random() * vh; s.life = 2 + Math.random() * 2;
    };
    const want = Math.round((cw * ch) / 9000);
    while (streaks.length < want) {
      const s = { x: 0, y: 0, len: (10 + Math.random() * 18) / scale, life: 0 };
      spawn(s);
      s.life = Math.random() * 3;
      streaks.push(s);
    }
    if (ws === 0) return;
    const ux = w.x / ws, uy = w.y / ws;
    const v = ws * ts;
    const m = 40 / scale;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    for (const s of streaks) {
      s.x += ux * v * dt;
      s.y += uy * v * dt;
      s.life -= dt;
      if (s.life <= 0 || s.x < vx0 - m || s.y < vy0 - m || s.x > vx0 + vw + m || s.y > vy0 + vh + m) spawn(s);
      const a = Math.min(1, s.life, 3 - s.life) * 0.35;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(sx(s.x), sy(s.y));
      ctx.lineTo(sx(s.x - ux * s.len), sy(s.y - uy * s.len));
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The no-go zone: a faint wedge ahead of the bow, 45° either side of the
   * apparent wind, so you can see when you're about to sail into it.
   * @param {import('./sim.js').Ship} ship @param {{x: number, y: number, heading: number}} pose
   */
  function drawNoGo(ship, pose) {
    if (!game) return;
    const w = windAt(game);
    const ax = w.x - ship.vx, ay = w.y - ship.vy;
    if (Math.hypot(ax, ay) < 0.1) return;
    const from = Math.atan2(-ay, -ax);
    const c = Math.cos(toRad(pose.heading)), s = Math.sin(toRad(pose.heading));
    const L = ship.type.length / 2;
    const x = sx(pose.x + c * L), y = sy(pose.y + s * L);
    const r = 90 * scale;
    ctx.save();
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(10,30,60,0.22)');
    grad.addColorStop(1, 'rgba(10,30,60,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, from - Math.PI / 4, from + Math.PI / 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** @param {string} name @param {number} x @param {number} y @param {number} w @param {number} h */
  function sprite(name, x, y, w, h) {
    const r = assets.atlas.get(name);
    if (r) ctx.drawImage(assets.sheet, r.x, r.y, r.w, r.h, x, y, w, h);
  }

  /** @param {import('./sim.js').Ship} ship @param {{x: number, y: number, heading: number}} pose */
  function drawShip(ship, pose) {
    if (!game) return;
    const L = ship.type.length;
    const px = (L / 108) * scale; // the hull sprite is 108 px long
    const frac = ship.crew / ship.maxCrew;
    const hull = ship.struck ? 4 : frac > 2 / 3 ? 1 : frac > 1 / 3 ? 2 : 3;
    const heading = toRad(pose.heading);
    ctx.save();
    ctx.translate(sx(pose.x), sy(pose.y));
    ctx.rotate(heading); // local frame: +x is the bow, +y is starboard
    // shadow
    ctx.fillStyle = 'rgba(0,30,60,0.18)';
    ctx.beginPath();
    ctx.ellipse(1.5 * scale, 2 * scale, (L / 2) * scale, (ship.type.beam / 2) * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.rotate(-Math.PI / 2); // sprites point their bows down the sheet
    sprite(`hullLarge (${hull})`, -25 * px, -54 * px, 50 * px, 108 * px);
    ctx.restore();

    // Sail, braced to the apparent wind: square to the keel running before
    // it, braced round (lee yardarm aft) as the wind comes forward.
    const w = windAt(game);
    const ax = w.x - ship.vx, ay = w.y - ship.vy;
    const c = icos(ship.heading), s = isin(ship.heading);
    const fromFwd = -(ax * c + ay * s), fromStbd = -(-ax * s + ay * c);
    const off = Math.atan2(Math.abs(fromStbd), fromFwd); // 0 head to wind … π dead aft
    const brace = ship.struck ? 0.15 : Math.min(1.05, (Math.PI - off) / 2);
    const sign = fromStbd >= 0 ? -1 : 1;
    const mast = -L * 0.12;
    ctx.save();
    ctx.translate(mast * scale, 0);
    ctx.rotate(sign * brace);
    ctx.rotate(-Math.PI / 2);
    const sail = ship.struck ? 'sailLarge (1)' : ship.side === 0 ? 'sailLarge (5)' : 'sailLarge (3)';
    sprite(sail, -33 * px, -2 * px, 66 * px, 47 * px);
    ctx.restore();
    // ensign at the stern, streaming downwind; struck ships have hauled it down
    if (!ship.struck) {
      ctx.save();
      ctx.translate((-L / 2 + 3) * scale, 0);
      ctx.rotate(Math.atan2(ay, ax) - heading - Math.PI / 2);
      sprite(ship.side === 0 ? 'flag (5)' : 'flag (3)', -3 * px, 0, 6 * px * 1.4, 22 * px * 1.4);
      ctx.restore();
    }
    ctx.restore();
  }

  /** @param {number} alpha */
  function drawBalls(alpha) {
    if (!game) return;
    const d = Math.max(4, 3.5 * scale);
    for (let i = 0; i < game.balls.length; i++) {
      const b = game.balls[i];
      const p = prevBalls[i];
      // new balls (no previous) or a reshuffled list after a hit: just draw where it is
      const near = p && Math.hypot(p.x - b.x, p.y - b.y) < 12;
      const x = near ? p.x + (b.x - p.x) * alpha : b.x, y = near ? p.y + (b.y - p.y) * alpha : b.y;
      sprite('cannonBall', sx(x) - d / 2, sy(y) - d / 2, d, d);
    }
  }

  /** @param {number} dt @param {number} ts @param {Fx['kind'][]} kinds */
  function drawFx(dt, ts, kinds) {
    const keep = [];
    for (const f of fx) {
      if (!kinds.includes(f.kind)) { keep.push(f); continue; }
      f.life -= dt;
      if (f.life <= 0) continue;
      keep.push(f);
      const k = 1 - f.life / f.max; // 0 → 1 over its life
      f.x += f.vx * dt * (f.kind === 'smoke' || f.kind === 'foam' ? ts * 0.5 : 1);
      f.y += f.vy * dt * (f.kind === 'smoke' || f.kind === 'foam' ? ts * 0.5 : 1);
      f.rot += f.spin * dt;
      const x = sx(f.x), y = sy(f.y), r = f.size * scale;
      ctx.save();
      switch (f.kind) {
        case 'smoke':
          ctx.globalAlpha = 0.55 * (1 - k);
          ctx.fillStyle = '#e9eef2';
          ctx.beginPath();
          ctx.arc(x, y, r * (1 + k * 2.5), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'foam':
          ctx.globalAlpha = 0.5 * (1 - k);
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, y, r * (0.6 + k), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'ring':
          ctx.globalAlpha = 0.8 * (1 - k);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, r * (0.3 + k * 1.4), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.9 * (1 - k);
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, y, r * 0.35 * (1 - k), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'dust':
          ctx.globalAlpha = 0.7 * (1 - k);
          ctx.fillStyle = '#d9c39a';
          ctx.beginPath();
          ctx.arc(x, y, r * (0.5 + k), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'flash':
          ctx.globalAlpha = 1 - k;
          ctx.translate(x, y);
          ctx.rotate(f.rot);
          sprite('explosion3', -r / 2, -r / 2, r, r);
          break;
        case 'boom':
          ctx.globalAlpha = 1 - k * k;
          ctx.translate(x, y);
          ctx.rotate(f.rot);
          sprite(f.sprite ?? 'explosion2', -r / 2 * (1 + k * 0.5), -r / 2 * (1 + k * 0.5), r * (1 + k * 0.5), r * (1 + k * 0.5));
          break;
        case 'wood':
          ctx.globalAlpha = 1 - k;
          ctx.translate(x, y);
          ctx.rotate(f.rot);
          sprite(f.sprite ?? 'wood (1)', -r, -r / 2, r * 2, r);
          break;
      }
      ctx.restore();
    }
    fx = keep;
  }

  /**
   * When the enemy is off screen, an arrow on the screen's edge points at
   * her, with how far away she is. It keeps clear of the HUD and buttons.
   * @param {{x: number, y: number}[]} poses @param {number} you
   */
  function drawEnemyArrow(poses, you) {
    arrow = null;
    if (!game) return;
    const g = game;
    const me = g.ships[you];
    const i = g.ships.findIndex((s) => s.side !== me.side);
    if (i < 0) return;
    const foe = g.ships[i], f = poses[i], mp = poses[you];
    const ex = sx(f.x), ey = sy(f.y);
    const pad = (foe.type.length / 2) * scale;
    if (ex > -pad && ey > -pad && ex < cw + pad && ey < ch + pad) return;
    const r = buttonSpots()[0].r;
    const left = 24 + safe.left, right = cw - 24 - safe.right;
    const top = 104 + safe.top, bottom = ch - 40 - 2 * r - safe.bottom;
    const cx = cw / 2, cy = (top + bottom) / 2;
    const dx = ex - cx, dy = ey - cy;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (right - cx) / dx);
    if (dx < 0) t = Math.min(t, (left - cx) / dx);
    if (dy > 0) t = Math.min(t, (bottom - cy) / dy);
    if (dy < 0) t = Math.min(t, (top - cy) / dy);
    if (!isFinite(t)) return;
    const x = cx + dx * t, y = cy + dy * t;
    const dist = Math.round(Math.hypot(f.x - mp.x, f.y - mp.y) / 10) * 10;
    arrow = { x, y, dist };
    const a = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(x, y);
    ctx.save();
    ctx.rotate(a);
    ctx.fillStyle = foe.struck ? '#c9ced8' : COLORS.players[foe.side];
    ctx.strokeStyle = 'rgba(13,16,32,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -11);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 11);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    // distance, set back toward the middle of the screen, clear of the arrow
    ctx.font = '700 12px system-ui, sans-serif';
    const tw = ctx.measureText(`${dist} m`).width;
    const lx = -Math.cos(a) * (18 + tw / 2), ly = -Math.sin(a) * 24;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(13,16,32,0.7)';
    ctx.strokeText(`${dist} m`, lx, ly);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${dist} m`, lx, ly);
    ctx.restore();
  }

  function drawCompass() {
    if (!game) return;
    const r = 24;
    const x = 12 + safe.left + r, y = 10 + safe.top + r;
    const dir = toRad(game.wind.dir) + Math.PI; // the way it blows
    ctx.save();
    ctx.fillStyle = 'rgba(13,16,32,0.55)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(x, y);
    ctx.save();
    ctx.rotate(dir);
    const aw = 30, ah = (30 * 46) / 62;
    ctx.drawImage(assets.arrow, -aw / 2, -ah / 2, aw, ah); // the arrow image points right (east)
    ctx.restore();
    ctx.fillStyle = '#123049';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.round(game.wind.speed)} kts`, 0, r + 4);
    ctx.restore();
  }

  /** Crew left: the hit points. @param {number} you */
  function drawCrew(you) {
    if (!game) return;
    const g = game;
    const y = 12 + safe.top;
    const pill = (/** @type {import('./sim.js').Ship} */ s, /** @type {number} */ x, /** @type {string} */ name) => {
      const w = 92, h = 22;
      ctx.fillStyle = 'rgba(13,16,32,0.55)';
      roundRect(x - w / 2, y, w, h, 11);
      ctx.fill();
      ctx.fillStyle = COLORS.players[s.side];
      const frac = Math.max(0, s.crew / s.maxCrew);
      roundRect(x - w / 2 + 3, y + 3, (w - 6) * frac, h - 6, 8);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.struck ? `${name}: struck` : `${name}: ${s.crew} crew`, x, y + h / 2 + 0.5);
    };
    ctx.save();
    const meShip = g.ships[you], them = g.ships.find((s) => s.side !== meShip.side);
    pill(meShip, cw / 2 - 50, 'You');
    if (them) pill(them, cw / 2 + 50, 'CPU');
    ctx.restore();
  }

  /**
   * A fire button: an arrow the way that side's guns point on screen right
   * now, and an arc that fills as it reloads.
   * @param {FireButton} b @param {import('./sim.js').Ship|undefined} ship
   */
  function drawButton(b, ship) {
    ctx.save();
    const ready = b.reload >= 1 && !b.firing && ship && !ship.struck;
    ctx.globalAlpha = ready ? 0.9 : 0.6;
    ctx.fillStyle = b.pressed ? 'rgba(255,255,255,0.35)' : 'rgba(13,16,32,0.55)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r - 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = ready ? COLORS.players[ship?.side ?? 0] : '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r - 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, b.reload));
    ctx.stroke();
    if (ship) {
      const d = batteryDir(ship, b.battery);
      const a = Math.atan2(d.y, d.x);
      ctx.translate(b.x, b.y);
      ctx.rotate(a);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(b.r * 0.5, 0);
      ctx.lineTo(-b.r * 0.15, -b.r * 0.32);
      ctx.lineTo(-b.r * 0.05, 0);
      ctx.lineTo(-b.r * 0.15, b.r * 0.32);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(-a);
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.globalAlpha = 0.7;
      ctx.fillText(b.label, 0, b.r + 3);
    }
    ctx.restore();
  }

  /** Rudder indicator while steering. @param {number} rudder −1 … 1 */
  function drawRudder(rudder) {
    const w = Math.min(180, cw * 0.4), y = ch - 26 - safe.bottom;
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = 'rgba(13,16,32,0.55)';
    roundRect(cw / 2 - w / 2 - 6, y - 9, w + 12, 18, 9);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(cw / 2 - 1, y - 6, 2, 12);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cw / 2 + rudder * (w / 2), y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** @typedef {{lines: string[], color?: string, sub?: string, stats?: {names: string[], rows: [string, string|number, string|number][]}}} Overlay */

  /** @param {Overlay} o */
  function drawOverlay(o) {
    ctx.save();
    ctx.fillStyle = o.stats ? 'rgba(13,16,32,0.78)' : 'rgba(13,16,32,0.35)';
    ctx.fillRect(0, 0, cw, ch);
    const k = o.stats ? 0.1 : 0;
    ctx.translate(cw / 2, ch * (0.5 - k * 1.5));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = o.color ?? COLORS.text;
    ctx.shadowColor = o.color ?? '#000';
    ctx.shadowBlur = 20;
    const big = Math.min(72, Math.max(36, Math.min(cw, ch) * 0.12));
    o.lines.forEach((line, i) => {
      ctx.font = `800 ${big}px system-ui, sans-serif`;
      ctx.fillText(line, 0, (i - (o.lines.length - 1) / 2) * big * 1.1);
    });
    if (o.sub) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.text;
      ctx.globalAlpha = 0.75;
      ctx.font = `500 ${Math.round(big * 0.3)}px system-ui, sans-serif`;
      ctx.fillText(o.sub, 0, (o.lines.length / 2) * big * 1.1 + big * 0.3);
      ctx.globalAlpha = 1;
    }
    if (o.stats) drawStats(o.stats, (o.lines.length / 2) * big * 1.1 + big * 0.85);
    ctx.restore();
  }

  /** @param {{names: string[], rows: [string, string|number, string|number][]}} st @param {number} top */
  function drawStats(st, top) {
    const fs = Math.max(12, Math.min(15, cw * 0.036));
    const lh = fs * 1.55;
    const xl = -fs * 7.8, xb = fs * 3.4, xr = fs * 7.8;
    ctx.shadowBlur = 0;
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.players[0];
    ctx.fillText(st.names[0], xb, top);
    ctx.fillStyle = COLORS.players[1];
    ctx.fillText(st.names[1], xr, top);
    st.rows.forEach(([label, b, r], i) => {
      const y = top + lh * (i + 1);
      ctx.font = `500 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(232,236,255,0.7)';
      ctx.fillText(label, xl, y);
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.players[0];
      ctx.fillText(String(b), xb, y);
      ctx.fillStyle = COLORS.players[1];
      ctx.fillText(String(r), xr, y);
    });
  }

  /** Where the two fire buttons go: the bottom corners, clear of the home indicator. */
  function buttonSpots() {
    const r = Math.max(30, Math.min(44, Math.min(cw, ch) * 0.1));
    const y = ch - 22 - r - safe.bottom;
    return [{ x: 16 + safe.left + r, y, r }, { x: cw - 16 - safe.right - r, y, r }];
  }

  return {
    setGame, layout, onTick, draw, buttonSpots,
    /** The sea on screen, in metres, and the enemy arrow if one is showing (for tests). */
    view() {
      return { x: -ox / scale, y: -oy / scale, w: cw / scale, h: ch / scale, arrow };
    },
  };
}
