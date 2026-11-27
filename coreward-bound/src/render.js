// Canvas renderer: the galaxy, the pieces, the jump preview and the
// animations. Pure presentation: floats and Math.random are fine here, and
// nothing in this file changes the game.

import { cellCenter, pixelToCell, hexDist } from './hex.js';
import { VOID, PERIPHERY, ARM, CORE, band, isCore } from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Preview} Preview */

export const COLORS = {
  bg: '#06070f',
  civ: ['#4fb3ff', '#ff8a4c'],
  civRgb: [[79, 179, 255], [255, 138, 76]],
  gold: '#ffd36b',
  bad: '#ff5d6c',
  dust: 'rgba(150, 104, 62, 0.95)',
  text: '#e8ecff',
};

const SIZE = 26; // hex size in world units (centre to corner)
const SQRT3 = Math.sqrt(3);

/**
 * @typedef {Object} View
 * @property {number} selected        hex selected, or -1
 * @property {Set<number>} reach      hexes the selected stack can jump to within safe range
 * @property {Set<number>} far        hexes it can jump to over range
 * @property {Preview|null} preview
 * @property {boolean} busy           the CPU is moving (or an animation is playing)
 */

/** @param {HTMLCanvasElement} canvas */
export function createRenderer(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  let dpr = 1, cw = 0, ch = 0;
  /** camera: world point at the screen centre, and zoom (screen px per world unit) */
  const cam = { x: 0, y: 0, z: 1 };
  /** @type {{x: number, y: number, z: number, t0: number, dur: number, from: {x: number, y: number, z: number}} | null} */
  let tween = null;
  /** @type {Game|null} */ let game = null;
  /** @type {HTMLCanvasElement|null} */ let nebula = null;
  let nebulaR = 0;
  /** @type {{x: number, y: number, r: number, a: number, tw: number}[]} */ let stars = [];
  /** @type {Anim[]} */ let anims = [];
  let dirty = true;

  /**
   * @typedef {{kind: 'jump', from: number, to: number, landed: number, civ: number, lost: boolean, t0: number, dur: number}
   * | {kind: 'burst', cell: number, color: string, t0: number, dur: number, big: boolean}
   * | {kind: 'text', cell: number, text: string, color: string, t0: number, dur: number}} Anim
   */

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    stars = [];
    const n = Math.round((cw * ch) / 2600);
    for (let i = 0; i < n; i++) {
      stars.push({ x: Math.random() * cw, y: Math.random() * ch, r: Math.random() < 0.08 ? 1.3 : 0.7, a: 0.25 + Math.random() * 0.6, tw: Math.random() * 6.28 });
    }
    dirty = true;
  }

  /** @param {Game} g */
  function setGame(g) {
    game = g;
    buildNebula();
    anims = [];
    dirty = true;
  }

  /** The soft glow of the arms and the nucleus, painted once per game in world space. */
  function buildNebula() {
    if (!game) return;
    const g = game.grid;
    nebulaR = (g.R + 2) * SIZE * SQRT3;
    const scale = 0.5;
    const px = Math.ceil(nebulaR * 2 * scale);
    nebula = document.createElement('canvas');
    nebula.width = nebula.height = px;
    const n = /** @type {CanvasRenderingContext2D} */ (nebula.getContext('2d'));
    n.scale(scale, scale);
    n.translate(nebulaR, nebulaR);
    n.globalCompositeOperation = 'lighter';
    for (let i = 0; i < g.N; i++) {
      const t = game.terrain[i];
      if (t === VOID) continue;
      const { x, y } = cellCenter(g, i, SIZE);
      const [rad, col] = t === ARM ? [SIZE * 2.2, 'rgba(130, 95, 255, 0.13)'] : t === PERIPHERY ? [SIZE * 1.6, 'rgba(80, 70, 200, 0.05)']
        : [SIZE * 3, 'rgba(255, 190, 90, 0.16)'];
      const grad = n.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, col);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      n.fillStyle = grad;
      n.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // a scatter of faint stars along the arms
    for (let i = 0; i < g.N; i++) {
      const t = game.terrain[i];
      const count = t === ARM ? 7 : t === PERIPHERY ? 4 : t === VOID ? 1 : 10;
      const { x, y } = cellCenter(g, i, SIZE);
      for (let k = 0; k < count; k++) {
        const a = Math.random() * 6.28, d = Math.random() * SIZE;
        n.fillStyle = t === CORE ? `rgba(255, 220, 160, ${0.2 + Math.random() * 0.4})` : `rgba(210, 210, 255, ${0.15 + Math.random() * 0.45})`;
        n.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.4, 1.4);
      }
    }
  }

  // ------------------------------------------------------------ camera

  const toScreen = (/** @type {number} */ wx, /** @type {number} */ wy) => ({ x: (wx - cam.x) * cam.z + cw / 2, y: (wy - cam.y) * cam.z + ch / 2 });
  const toWorld = (/** @type {number} */ sx, /** @type {number} */ sy) => ({ x: (sx - cw / 2) / cam.z + cam.x, y: (sy - ch / 2) / cam.z + cam.y });

  /** Cell under a screen point, or -1. */
  function cellAtScreen(/** @type {number} */ sx, /** @type {number} */ sy) {
    if (!game) return -1;
    const w = toWorld(sx, sy);
    return pixelToCell(game.grid, w.x, w.y, SIZE);
  }

  function clampCam() {
    if (!game) return;
    const lim = (game.grid.R + 1) * SIZE * 1.6;
    cam.x = Math.max(-lim, Math.min(lim, cam.x));
    cam.y = Math.max(-lim, Math.min(lim, cam.y));
    cam.z = Math.max(minZoom(), Math.min(2.6, cam.z));
  }
  function minZoom() {
    if (!game) return 0.3;
    const span = (game.grid.R + 1) * SIZE * 2 * 0.9;
    return Math.min(cw / span, ch / span) * 0.85;
  }

  function pan(/** @type {number} */ dx, /** @type {number} */ dy) {
    tween = null;
    cam.x -= dx / cam.z;
    cam.y -= dy / cam.z;
    clampCam();
    dirty = true;
  }

  function zoomAt(/** @type {number} */ sx, /** @type {number} */ sy, /** @type {number} */ f) {
    tween = null;
    const before = toWorld(sx, sy);
    cam.z *= f;
    clampCam();
    const after = toWorld(sx, sy);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    clampCam();
    dirty = true;
  }

  /** Glide the camera to a cell. @param {number} cell @param {{zoom?: number, dur?: number, ifOffscreen?: boolean}} [o] */
  function centerOn(cell, o = {}) {
    if (!game || cell < 0) return;
    const { x, y } = cellCenter(game.grid, cell, SIZE);
    if (o.ifOffscreen) {
      const s = toScreen(x, y);
      const m = 70;
      if (s.x > m && s.x < cw - m && s.y > m + 30 && s.y < ch - m - 120) return;
    }
    tween = { x, y, z: o.zoom ?? cam.z, t0: performance.now(), dur: o.dur ?? 450, from: { ...cam } };
    dirty = true;
  }

  // Visible map area: below the HUD, above the bottom bar (or a panel).
  const TOP = 44, BAR = 64;

  /** Glide so a world point sits in the middle of the visible band. @param {number} wx @param {number} wy @param {number} z */
  function glideTo(wx, wy, z) {
    tween = { x: wx, y: wy - ((TOP + ch - BAR) / 2 - ch / 2) / z, z, t0: performance.now(), dur: 450, from: { ...cam } };
    dirty = true;
  }

  /** Bounding box of cells in world pixels, with a hex of margin. @param {number[]} cells */
  function worldBox(cells) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cells) {
      const p = cellCenter(game.grid, c, SIZE);
      x0 = Math.min(x0, p.x - SIZE * 1.2); x1 = Math.max(x1, p.x + SIZE * 1.2);
      y0 = Math.min(y0, p.y - SIZE * 1.2); y1 = Math.max(y1, p.y + SIZE * 1.2);
    }
    return { x0, y0, x1, y1 };
  }

  /** Glide (and zoom, within [minZoom, 1.2]) so all these cells are in view. @param {number[]} cells */
  function fit(cells) {
    if (!game || !cells.length) return;
    const b = worldBox(cells);
    const z = Math.max(minZoom(), Math.min(1.2, (cw - 24) / (b.x1 - b.x0), (ch - TOP - BAR) / (b.y1 - b.y0)));
    glideTo((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, z);
  }

  /**
   * Pan the least needed to bring these cells into the visible area (no zoom
   * change); if they can't all fit, centre on the first.
   * @param {number[]} cells @param {number} bottom screen y the area ends at
   */
  function reveal(cells, bottom) {
    if (!game || !cells.length) return;
    const b = worldBox(cells);
    const l = (b.x0 - cam.x) * cam.z + cw / 2, r = (b.x1 - cam.x) * cam.z + cw / 2;
    const t = (b.y0 - cam.y) * cam.z + ch / 2, d = (b.y1 - cam.y) * cam.z + ch / 2;
    if (l >= 0 && r <= cw && t >= TOP && d <= bottom) return;
    if (r - l > cw || d - t > bottom - TOP) {
      const p = cellCenter(game.grid, cells[0], SIZE);
      tween = { x: p.x, y: p.y - ((TOP + bottom) / 2 - ch / 2) / cam.z, z: cam.z, t0: performance.now(), dur: 350, from: { ...cam } };
    } else {
      const sx = l < 0 ? -l : r > cw ? cw - r : 0, sy = t < TOP ? TOP - t : d > bottom ? bottom - d : 0;
      tween = { x: cam.x - sx / cam.z, y: cam.y - sy / cam.z, z: cam.z, t0: performance.now(), dur: 350, from: { ...cam } };
    }
    dirty = true;
  }

  /** Zoom out to the whole galaxy. */
  function overview() {
    if (!game) return;
    tween = { x: 0, y: 0, z: minZoom() / 0.85 * 0.95, t0: performance.now(), dur: 500, from: { ...cam } };
    dirty = true;
  }

  /** Start on a civ's home, zoomed so its neighbourhood fills the screen. */
  function startAt(/** @type {number} */ cell) {
    if (!game) return;
    const { x, y } = cellCenter(game.grid, cell, SIZE);
    cam.x = x * 0.5; cam.y = y * 0.5; // between home and the centre, so the goal is in view
    const span = Math.hypot(x, y) + SIZE * 3;
    cam.z = Math.max(minZoom(), Math.min(1.2, (Math.min(cw, ch - 120) * 0.95) / span));
    clampCam();
    dirty = true;
  }

  // ------------------------------------------------------------ effects

  /** @param {import('./sim.js').GameEvent} e */
  function animate(e) {
    const now = performance.now();
    if (e.type === 'jump') {
      anims.push({ kind: 'jump', from: e.from, to: e.to, landed: e.landed, civ: e.civ, lost: e.lost, t0: now, dur: 520 });
      if (e.lost) anims.push({ kind: 'text', cell: e.to, text: 'Lost!', color: COLORS.bad, t0: now + 520, dur: 1400 });
      else if (e.scatter) anims.push({ kind: 'text', cell: e.landed, text: e.losses ? `Scattered −${e.losses}` : 'Scattered', color: COLORS.gold, t0: now + 520, dur: 1400 });
    } else if (e.type === 'combat') {
      anims.push({ kind: 'burst', cell: e.cell, color: '#ffffff', t0: now, dur: 700, big: true });
      anims.push({ kind: 'text', cell: e.cell, text: `${e.before[0] - e.after[0]} : ${e.before[1] - e.after[1]} lost`, color: COLORS.text, t0: now + 200, dur: 1600 });
    } else if (e.type === 'flip') {
      anims.push({ kind: 'burst', cell: e.cell, color: e.ok ? COLORS.civ[e.civ] : '#888', t0: now, dur: 800, big: e.ok });
      anims.push({ kind: 'text', cell: e.cell, text: e.ok ? 'Taken!' : 'Held', color: e.ok ? COLORS.civ[e.civ] : COLORS.text, t0: now, dur: 1400 });
    } else if (e.type === 'hazard') {
      anims.push({ kind: 'text', cell: e.cell, text: `Glare −${e.lost}`, color: COLORS.bad, t0: now, dur: 1600 });
    } else if (e.type === 'found' || e.type === 'grow' || e.type === 'build' || e.type === 'research') {
      anims.push({ kind: 'burst', cell: e.cell, color: COLORS.civ[e.civ], t0: now, dur: 500, big: false });
    } else if (e.type === 'pickup' || e.type === 'deliver' || e.type === 'respawn' || e.type === 'return' || e.type === 'drop') {
      anims.push({ kind: 'burst', cell: e.cell, color: COLORS.gold, t0: now, dur: 900, big: true });
      if (e.type === 'deliver') anims.push({ kind: 'text', cell: e.cell, text: `Relic ${e.total}/3`, color: COLORS.gold, t0: now, dur: 1800 });
    }
    dirty = true;
  }

  const busy = () => anims.length > 0 || tween !== null;

  // ------------------------------------------------------------ drawing

  /** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} r */
  function hexPath(c, x, y, r) {
    c.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
  }

  /** @param {View} view @param {number} now */
  function draw(view, now) {
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      cam.x = tween.from.x + (tween.x - tween.from.x) * e;
      cam.y = tween.from.y + (tween.y - tween.from.y) * e;
      cam.z = tween.from.z + (tween.z - tween.from.z) * e;
      if (t >= 1) tween = null;
      dirty = true;
    }
    anims = anims.filter((a) => now < a.t0 + a.dur);
    const animating = anims.length > 0 || view.selected >= 0 || (game && game.relicAt.some((r) => r > 0));
    if (!dirty && !animating) return;
    dirty = false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cw, ch);
    for (const s of stars) {
      ctx.globalAlpha = s.a * (0.75 + 0.25 * Math.sin(now / 900 + s.tw));
      ctx.fillStyle = '#cfd6ff';
      const px = (s.x - cam.x * 0.05) % cw, py = (s.y - cam.y * 0.05) % ch;
      ctx.fillRect(px < 0 ? px + cw : px, py < 0 ? py + ch : py, s.r, s.r);
    }
    ctx.globalAlpha = 1;
    if (!game) return;
    const g = game.grid;

    // world transform
    ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * (cw / 2 - cam.x * cam.z), dpr * (ch / 2 - cam.y * cam.z));
    if (nebula) ctx.drawImage(nebula, -nebulaR, -nebulaR, nebulaR * 2, nebulaR * 2);

    const known = game.civs[0].known;
    const detail = cam.z > 0.55;

    // hex grid
    for (let i = 0; i < g.N; i++) {
      const { x, y } = cellCenter(g, i, SIZE);
      const t = game.terrain[i];
      hexPath(ctx, x, y, SIZE * 0.97);
      if (t === VOID) {
        ctx.strokeStyle = 'rgba(90, 100, 160, 0.06)';
      } else if (t === PERIPHERY) {
        ctx.fillStyle = 'rgba(70, 60, 160, 0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(120, 110, 220, 0.16)';
      } else if (t === ARM) {
        ctx.fillStyle = 'rgba(130, 105, 255, 0.26)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(170, 150, 255, 0.45)';
      } else {
        const spawn = game.spawns.includes(i); // where relics appear
        ctx.fillStyle = spawn ? 'rgba(255, 200, 100, 0.22)' : 'rgba(255, 180, 90, 0.10)';
        ctx.fill();
        ctx.strokeStyle = spawn ? 'rgba(255, 210, 120, 0.6)' : 'rgba(255, 190, 110, 0.25)';
      }
      ctx.lineWidth = 1;
      ctx.stroke();
      // what a hex is worth, once you've been there
      if (detail && known[i] && game.owner[i] < 0 && !isCore(game, i)) {
        const p = game.potential[i];
        ctx.fillStyle = p === 0 ? 'rgba(160, 165, 200, 0.45)' : 'rgba(230, 235, 255, 0.85)';
        if (p === 0) {
          ctx.fillRect(x - 4, y + SIZE * 0.45, 8, 1.5);
        } else {
          for (let k = 0; k < p; k++) {
            ctx.beginPath();
            ctx.arc(x + (k - (p - 1) / 2) * 5.5, y + SIZE * 0.5, 1.8, 0, 6.29);
            ctx.fill();
          }
        }
      }
    }

    // reachable hexes for the selected stack
    for (const i of view.far) {
      const { x, y } = cellCenter(g, i, SIZE);
      hexPath(ctx, x, y, SIZE * 0.86);
      ctx.fillStyle = 'rgba(255, 211, 107, 0.07)';
      ctx.fill();
    }
    for (const i of view.reach) {
      const { x, y } = cellCenter(g, i, SIZE);
      hexPath(ctx, x, y, SIZE * 0.86);
      ctx.fillStyle = 'rgba(79, 179, 255, 0.13)';
      ctx.fill();
    }

    // dust lanes
    ctx.lineCap = 'round';
    for (let i = 0; i < g.N; i++) {
      if (!game.dust[i]) continue;
      const { x, y } = cellCenter(g, i, SIZE);
      for (let d = 0; d < 6; d++) {
        if (!(game.dust[i] & (1 << d))) continue;
        const n = g.nbr[i * 6 + d];
        if (n < i) continue; // draw each edge once
        // the edge between i and its neighbour in direction d
        const a1 = (-Math.PI / 3) * d + Math.PI / 6, a2 = a1 - Math.PI / 3;
        ctx.strokeStyle = 'rgba(120, 80, 45, 0.45)';
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(x + SIZE * Math.cos(a1), y + SIZE * Math.sin(a1));
        ctx.lineTo(x + SIZE * Math.cos(a2), y + SIZE * Math.sin(a2));
        ctx.stroke();
        ctx.strokeStyle = COLORS.dust;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    // beacons
    for (let i = 0; i < g.N; i++) {
      if (!game.beacon[i]) continue;
      const { x, y } = cellCenter(g, i, SIZE);
      star(x, y - (game.owner[i] >= 0 ? SIZE * 0.55 : 0), 9 + Math.sin(now / 400 + i) * 1.2, '#fffbe8');
    }

    // relics
    for (let i = 0; i < g.N; i++) {
      if (!game.relicAt[i]) continue;
      const { x, y } = cellCenter(g, i, SIZE);
      relic(x, y, 1 + 0.12 * Math.sin(now / 300 + i), game.relicAt[i]);
    }

    // settlements
    for (let i = 0; i < g.N; i++) {
      const o = game.owner[i];
      if (o < 0) continue;
      const { x, y } = cellCenter(g, i, SIZE);
      const col = COLORS.civ[o];
      const home = game.civs[o].home === i;
      const sieged = game.stacks.some((s) => s.cell === i && s.owner !== o);
      ctx.beginPath();
      ctx.arc(x, y, SIZE * 0.5, 0, 6.29);
      ctx.fillStyle = 'rgba(6, 8, 20, 0.92)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = col;
      if (sieged) ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (home) {
        ctx.beginPath();
        ctx.arc(x, y, SIZE * 0.66, 0, 6.29);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.font = `700 ${SIZE * 0.55}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${game.value[i]}`, x, y + 1);
      if (o === 0 && detail) {
        // potential, as a thin arc: how much room to grow
        const frac = game.potential[i] ? game.value[i] / game.potential[i] : 1;
        ctx.beginPath();
        ctx.arc(x, y, SIZE * 0.5 + 3.5, -Math.PI / 2, -Math.PI / 2 + 6.283 * frac);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // stacks
    for (const s of game.stacks) {
      const { x, y } = cellCenter(g, s.cell, SIZE);
      const onTown = game.owner[s.cell] >= 0;
      const sx = onTown ? x + SIZE * 0.42 : x, sy = onTown ? y - SIZE * 0.42 : y;
      const mine = s.owner === 0;
      const col = COLORS.civ[s.owner];
      const dim = mine && s.ready === 0 && game.current === 0;
      ctx.globalAlpha = dim ? 0.6 : 1;
      ship(sx, sy, col, s.owner);
      const label = mine ? `${s.fleets}` : band(s.fleets);
      ctx.font = `700 ${SIZE * 0.42}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(label).width + 8;
      const bx = sx + SIZE * 0.36, by = sy + SIZE * 0.34;
      ctx.fillStyle = 'rgba(6, 8, 20, 0.95)';
      roundRect(bx - w / 2, by - 8, w, 16, 8);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(label, bx, by + 0.5);
      if (mine && s.ready > 0 && s.ready < s.fleets && game.current === 0) {
        ctx.fillStyle = COLORS.civ[0];
        ctx.font = `600 ${SIZE * 0.32}px system-ui, sans-serif`;
        ctx.fillText(`${s.ready} ready`, sx, sy - SIZE * 0.55);
      }
      if (s.relics) relic(sx - SIZE * 0.32, sy + SIZE * 0.2, 0.6, s.relics);
      ctx.globalAlpha = 1;
    }

    // selection and jump preview
    if (view.selected >= 0) {
      const { x, y } = cellCenter(g, view.selected, SIZE);
      hexPath(ctx, x, y, SIZE * (0.92 + 0.04 * Math.sin(now / 220)));
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (view.preview) {
      const pv = view.preview;
      const a = cellCenter(g, pv.from, SIZE), b = cellCenter(g, pv.to, SIZE);
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -now / 40;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // every hex it might scatter to
      /** @type {Map<number, {lost: boolean, n: number, losses: number}>} */
      const spots = new Map();
      for (const o of pv.outcomes) {
        const key = o.cell;
        const cur = spots.get(key);
        if (cur) { cur.n++; cur.lost = cur.lost || o.lost; } else spots.set(key, { lost: o.lost, n: 1, losses: o.losses });
      }
      for (const [cell, sp] of spots) {
        if (cell < 0) continue;
        const p = cellCenter(g, cell, SIZE);
        if (sp.lost) {
          ctx.strokeStyle = COLORS.bad;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(p.x - 6, p.y - 6); ctx.lineTo(p.x + 6, p.y + 6);
          ctx.moveTo(p.x + 6, p.y - 6); ctx.lineTo(p.x - 6, p.y + 6);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4.5, 0, 6.29);
          ctx.fillStyle = sp.losses ? '#ffa94d' : COLORS.gold;
          ctx.fill();
        }
      }
      hexPath(ctx, b.x, b.y, SIZE * 0.95);
      ctx.strokeStyle = pv.loseChance > 0 ? COLORS.bad : pv.hits === 6 ? '#7ee2a8' : COLORS.gold;
      ctx.lineWidth = 3;
      ctx.stroke();
      // odds badge
      const pct = Math.round((pv.hits / 6) * 100);
      ctx.font = `700 ${SIZE * 0.5}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = `${pct}%`;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(6, 8, 20, 0.92)';
      roundRect(b.x - w / 2, b.y - SIZE * 1.25 - 10, w, 20, 10);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, b.x, b.y - SIZE * 1.25 + 0.5);
    }

    // animations
    for (const an of anims) {
      const t = (now - an.t0) / an.dur;
      if (t < 0) continue;
      if (an.kind === 'jump') {
        const a = cellCenter(g, an.from, SIZE);
        const aim = cellCenter(g, an.to, SIZE);
        const land = an.landed >= 0 ? cellCenter(g, an.landed, SIZE) : aim;
        const e = 1 - Math.pow(1 - Math.min(1, t), 3);
        // streak towards the target; if it scattered, a kink to where it really went
        const mid = t < 0.75 ? e / 0.9 : 1;
        const hx = a.x + (aim.x - a.x) * Math.min(1, mid), hy = a.y + (aim.y - a.y) * Math.min(1, mid);
        let px = hx, py = hy;
        if (t >= 0.75 && an.landed !== an.to) {
          const k = (t - 0.75) / 0.25;
          px = aim.x + (land.x - aim.x) * k; py = aim.y + (land.y - aim.y) * k;
        }
        const [r, gg, bb] = COLORS.civRgb[an.civ];
        const grad = ctx.createLinearGradient(a.x, a.y, px, py);
        grad.addColorStop(0, `rgba(${r},${gg},${bb},0)`);
        grad.addColorStop(1, `rgba(${r},${gg},${bb},${0.9 * (1 - Math.max(0, t - 0.8) * 5)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(hx, hy);
        if (t >= 0.75 && an.landed !== an.to) ctx.lineTo(px, py);
        ctx.stroke();
        ctx.fillStyle = an.lost && t > 0.85 ? COLORS.bad : '#ffffff';
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, 6.29);
        ctx.fill();
      } else if (an.kind === 'burst') {
        const p = cellCenter(g, an.cell, SIZE);
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = an.color;
        ctx.lineWidth = an.big ? 3 : 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, SIZE * (0.4 + t * (an.big ? 1.4 : 0.8)), 0, 6.29);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (an.kind === 'text') {
        const p = cellCenter(g, an.cell, SIZE);
        ctx.globalAlpha = t < 0.8 ? 1 : (1 - t) * 5;
        ctx.font = `700 ${Math.max(13, SIZE * 0.5)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(6, 8, 20, 0.9)';
        const yy = p.y - SIZE * 0.9 - t * 18;
        ctx.strokeText(an.text, p.x, yy);
        ctx.fillStyle = an.color;
        ctx.fillText(an.text, p.x, yy);
        ctx.globalAlpha = 1;
      }
    }

    // arrows at the screen edge pointing to rival stacks out of view
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of game.stacks) {
      if (s.owner === 0) continue;
      const w = cellCenter(g, s.cell, SIZE);
      const p = toScreen(w.x, w.y);
      const m = 18;
      if (p.x > 0 && p.x < cw && p.y > 0 && p.y < ch) continue;
      // only ones near something of yours: a threat, not noise
      let near = false;
      for (let i = 0; i < g.N && !near; i++) if (game.owner[i] === 0 && hexDist(g, i, s.cell) <= 5) near = true;
      if (!near) continue;
      const ang = Math.atan2(p.y - ch / 2, p.x - cw / 2);
      const ex = Math.max(m, Math.min(cw - m, p.x)), ey = Math.max(m + 44, Math.min(ch - m - 56, p.y));
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(ang);
      ctx.fillStyle = COLORS.civ[1];
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-3, 0); ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
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

  /** A four-pointed star. @param {number} x @param {number} y @param {number} r @param {string} col */
  function star(x, y, r, col) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    grad.addColorStop(0, 'rgba(255, 250, 220, 0.55)');
    grad.addColorStop(1, 'rgba(255, 250, 220, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (Math.PI / 4) * k - Math.PI / 2;
      const rr = k % 2 === 0 ? r : r * 0.28;
      if (k === 0) ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      else ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
  }

  /** A glowing relic. @param {number} x @param {number} y @param {number} s scale @param {number} n */
  function relic(x, y, s, n) {
    const r = SIZE * 0.34 * s;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
    grad.addColorStop(0, 'rgba(255, 211, 107, 0.6)');
    grad.addColorStop(1, 'rgba(255, 211, 107, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
    ctx.fillStyle = COLORS.gold;
    ctx.strokeStyle = '#fff6d8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.7, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.7, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (n > 1) {
      ctx.fillStyle = '#1a1200';
      ctx.font = `700 ${r}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${n}`, x, y + 0.5);
    }
  }

  /** A little ship. @param {number} x @param {number} y @param {string} col @param {number} owner */
  function ship(x, y, col, owner) {
    const r = SIZE * 0.36;
    ctx.save();
    ctx.translate(x, y);
    if (owner === 1) ctx.rotate(Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.8, r * 0.75);
    ctx.lineTo(0, r * 0.35);
    ctx.lineTo(-r * 0.8, r * 0.75);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(6, 8, 20, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  return {
    resize, setGame, draw, pan, zoomAt, centerOn, fit, reveal, overview, startAt, cellAtScreen, animate, busy,
    markDirty: () => { dirty = true; },
    get zoom() { return cam.z; },
  };
}
