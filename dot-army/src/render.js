// Canvas renderer. Everything here is presentation: smooth interpolation
// between ticks, particles, the territory glow. None of it feeds back into
// the simulation.

import { cellCenter, boardSize, fitSize, dirAngle } from './hex.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Events} Events */

export const COLORS = {
  bg: '#0d1020',
  cell: '#141933',
  cellEdge: '#1b2142',
  rock: '#2a2f4a',
  rockEdge: '#3a4066',
  neutral: '#7d8597',
  players: ['#3d8bff', '#ff4d5e'],
  playersDim: ['rgba(61,139,255,', 'rgba(255,77,94,'],
  playersGlow: [[61, 139, 255], [255, 77, 94]],
  text: '#e8ecff',
};

const SQRT3 = Math.sqrt(3);

/**
 * @typedef {Object} Particle
 * @property {number} x @property {number} y @property {number} vx @property {number} vy
 * @property {number} life @property {number} max @property {string} color @property {number} size
 * @property {number} kind 0 = spark, 1 = ring
 */

/** @param {HTMLCanvasElement} canvas */
export function createRenderer(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  let dpr = 1, cw = 0, ch = 0;
  let size = 8, ox = 0, oy = 0, bw = 0, bh = 0;
  let portrait = false;
  // Whose screen this is: one player per screen. Online, the guest's board is
  // turned 180° (flip) so their home is nearest them.
  let view = { flip: false, local: 0 };
  /** @type {HTMLCanvasElement|null} */ let staticLayer = null;
  /** @type {Game|null} */ let game = null;

  // territory glow: one pixel per half-cell, upscaled with smoothing
  /** @type {Float32Array[]} */ let heat = [];
  /** @type {HTMLCanvasElement} */ const glowCanvas = document.createElement('canvas');
  /** @type {ImageData|null} */ let glowData = null;

  /** @type {Particle[]} */ let particles = [];
  /** @type {Map<number, {flash: number, shake: number, wave: number, waveColor: string, alert: number}>} */
  let spawnFx = new Map();
  let shake = 0;

  /** @param {Game} g */
  function setGame(g) {
    game = g;
    particles = [];
    spawnFx = new Map();
    heat = [new Float32Array(g.grid.N), new Float32Array(g.grid.N)];
    glowCanvas.width = g.grid.W * 2 + 1;
    glowCanvas.height = g.grid.H;
    glowData = new ImageData(glowCanvas.width, glowCanvas.height);
    layout();
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    portrait = ch > cw;
    if (!game) return;
    const hud = portrait ? 34 : 38;
    const padX = 10, padY = portrait ? hud * 2 : hud + 10;
    size = fitSize(game.grid, cw - padX * 2, ch - padY - (portrait ? 0 : 8));
    const b = boardSize(game.grid, size);
    bw = b.w; bh = b.h;
    ox = (cw - bw) / 2;
    oy = portrait ? (ch - bh) / 2 : hud + (ch - hud - bh) / 2;
    buildStatic();
  }

  /** Grid, rocks and spawn footprints never move: draw them once. */
  function buildStatic() {
    if (!game) return;
    const g = game.grid;
    staticLayer = document.createElement('canvas');
    staticLayer.width = Math.ceil(bw * dpr) + 2;
    staticLayer.height = Math.ceil(bh * dpr) + 2;
    const s = /** @type {CanvasRenderingContext2D} */ (staticLayer.getContext('2d'));
    s.scale(dpr, dpr);
    for (let i = 0; i < g.N; i++) {
      const [x, y] = cellCenter(g, i, size);
      const t = game.terrain[i];
      if (t === 2) continue;
      hexPath(s, x, y, size * (t === 1 ? 1.02 : 0.9));
      s.fillStyle = t === 1 ? COLORS.rock : COLORS.cell;
      s.fill();
      if (t === 1) { s.strokeStyle = COLORS.rockEdge; s.lineWidth = 1; s.stroke(); }
    }
  }

  /** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} r */
  function hexPath(c, x, y, r) {
    c.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
  }

  /** Feed one tick's events into effects; returns nothing, mutates fx state. */
  function onTick(/** @type {Events} */ ev) {
    if (!game) return;
    const g = game.grid;
    // territory heat
    for (let p = 0; p < 2; p++) {
      const h = heat[p];
      for (let i = 0; i < h.length; i++) h[i] *= 0.94;
    }
    for (const d of game.dots) {
      const h = heat[d.player];
      h[d.cell] = Math.min(1.6, h[d.cell] + 0.35);
    }
    // kills → particles
    for (const k of ev.kills) {
      const [x, y] = cellCenter(g, k.cell, size);
      const color = COLORS.players[k.victim];
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = (0.6 + Math.random() * 1.6) * size * 6;
        particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.35 + Math.random() * 0.3, color, size: size * (0.25 + Math.random() * 0.25), kind: 0 });
      }
      particles.push({ x, y, vx: 0, vy: 0, life: 0, max: 0.25, color: '#ffffff', size: size * 0.6, kind: 1 });
    }
    for (const h of ev.hits) {
      const fx = fxFor(h.spawn);
      fx.flash = 1;
      fx.shake = Math.min(1, fx.shake + 0.25 * h.amount);
      // Under attack: an owned spawn hit by the other side. (If it just
      // changed hands, owner is now the attacker and the capture wave shows.)
      const owner = game.spawns[h.spawn].owner;
      if (owner >= 0 && h.player !== owner) fx.alert = 1;
    }
    for (const c of ev.captures) {
      const fx = fxFor(c.spawn);
      fx.wave = 1;
      fx.waveColor = COLORS.players[c.to];
      const s = game.spawns[c.spawn];
      const [x, y] = cellCenter(g, s.center, size);
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        const v = size * (10 + Math.random() * 8);
        particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.6 + Math.random() * 0.3, color: COLORS.players[c.to], size: size * 0.35, kind: 0 });
      }
      shake = Math.max(shake, s.home ? 1 : 0.45);
    }
    if (particles.length > 3000) particles.splice(0, particles.length - 3000);
  }

  function fxFor(/** @type {number} */ id) {
    let fx = spawnFx.get(id);
    if (!fx) spawnFx.set(id, (fx = { flash: 0, shake: 0, wave: 0, waveColor: '#fff', alert: 0 }));
    return fx;
  }

  function updateGlow() {
    if (!game || !glowData) return;
    const { W, H } = game.grid;
    const data = glowData.data;
    const gw = glowCanvas.width;
    data.fill(0);
    const [b, r] = COLORS.playersGlow;
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        const hb = Math.min(1, heat[0][i]), hr = Math.min(1, heat[1][i]);
        const a = Math.max(hb, hr);
        if (a < 0.02) continue;
        const t = hb + hr > 0 ? hb / (hb + hr) : 0.5;
        const R = r[0] + (b[0] - r[0]) * t, G = r[1] + (b[1] - r[1]) * t, B = r[2] + (b[2] - r[2]) * t;
        const x0 = col * 2 + (row & 1);
        for (let k = 0; k < 2; k++) {
          const o = (row * gw + x0 + k) * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = a * 255;
        }
      }
    }
    /** @type {CanvasRenderingContext2D} */ (glowCanvas.getContext('2d')).putImageData(glowData, 0, 0);
  }

  /**
   * @param {number} alpha  0..1 progress through the current tick
   * @param {number} dt     seconds since last frame
   * @param {{ targetsPx: ({x: number, y: number}|null)[], dragging: boolean[], overlay: {lines: string[], color?: string, sub?: string}|null, hints: boolean, human: boolean[] }} ui
   */
  function draw(alpha, dt, ui) {
    if (!game || !staticLayer) return;
    const g = game.grid;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cw, ch);

    shake = Math.max(0, shake - dt * 2.5);
    const sx = shake ? (Math.random() - 0.5) * shake * size * 0.8 : 0;
    const sy = shake ? (Math.random() - 0.5) * shake * size * 0.8 : 0;
    ctx.save();
    ctx.translate(ox + sx, oy + sy);
    if (view.flip) { ctx.translate(bw, bh); ctx.rotate(Math.PI); }

    ctx.drawImage(staticLayer, 0, 0, staticLayer.width / dpr, staticLayer.height / dpr);

    // territory glow
    updateGlow();
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(glowCanvas, 0, size * 0.25, glowCanvas.width * size * SQRT3 / 2, g.H * size * 1.5);
    ctx.restore();

    drawSpawns(dt);
    drawDots(alpha);
    drawClashes();
    drawParticles(dt);
    drawTargets(ui);

    ctx.restore();
    drawHud();
    if (ui.overlay) drawOverlay(ui.overlay);
  }

  function drawSpawns(/** @type {number} */ dt) {
    if (!game) return;
    const g = game.grid;
    const now = performance.now() / 1000;
    for (const s of game.spawns) {
      const fx = spawnFx.get(s.id);
      let jx = 0, jy = 0;
      if (fx) {
        fx.flash = Math.max(0, fx.flash - dt * 4);
        fx.shake = Math.max(0, fx.shake - dt * 3);
        fx.wave = Math.max(0, fx.wave - dt * 1.4);
        fx.alert = s.owner >= 0 ? Math.max(0, fx.alert - dt * 1.2) : 0;
        if (fx.shake) { jx = (Math.random() - 0.5) * fx.shake * size * 0.5; jy = (Math.random() - 0.5) * fx.shake * size * 0.5; }
      }
      const color = s.owner >= 0 ? COLORS.players[s.owner] : COLORS.neutral;
      const [cx, cy] = cellCenter(g, s.center, size);
      // blob: the seven cells
      ctx.save();
      ctx.translate(jx, jy);
      ctx.shadowColor = color;
      ctx.shadowBlur = size * (s.owner >= 0 ? 1.6 : 0.6);
      for (const c of s.cells) {
        const [x, y] = cellCenter(g, c, size);
        hexPath(ctx, x, y, size * 1.02);
        ctx.fillStyle = color;
        ctx.globalAlpha = s.owner >= 0 ? 0.55 : 0.35;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      // core
      const pulse = s.owner >= 0 ? 0.08 * Math.sin(now * 4 + s.id) : 0;
      hexPath(ctx, cx, cy, size * (0.75 + pulse));
      ctx.fillStyle = color;
      ctx.fill();
      if (s.home) {
        hexPath(ctx, cx, cy, size * 0.38);
        ctx.fillStyle = COLORS.bg;
        ctx.fill();
      }
      if (fx && fx.flash > 0) {
        for (const c of s.cells) {
          const [x, y] = cellCenter(g, c, size);
          hexPath(ctx, x, y, size * 1.02);
          ctx.fillStyle = `rgba(255,255,255,${fx.flash * 0.45})`;
          ctx.fill();
        }
      }
      // meter ring; while under attack it throbs: bigger, thicker, glowing
      const alert = fx ? fx.alert : 0;
      const throb = alert * (0.5 + 0.5 * Math.sin(now * 14));
      const R = size * 2.75 * (1 + alert * 0.25 + throb * 0.35);
      ctx.lineWidth = Math.max(2, size * 0.32) * (1 + alert * 0.6 + throb * 0.8);
      if (alert > 0) { ctx.shadowColor = color; ctx.shadowBlur = size * 2.5 * alert; }
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      const frac = s.meter / game.params.meterMax;
      if (frac > 0) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
      // capture shockwave
      if (fx && fx.wave > 0) {
        ctx.strokeStyle = fx.waveColor;
        ctx.globalAlpha = fx.wave;
        ctx.lineWidth = size * 0.5 * fx.wave + 1;
        ctx.beginPath();
        ctx.arc(cx, cy, R + (1 - fx.wave) * size * 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawDots(/** @type {number} */ alpha) {
    if (!game) return;
    const g = game.grid;
    const t = alpha * alpha * (3 - 2 * alpha); // smoothstep: a little "march" in each step
    const r = size * 0.78;
    for (let p = 0; p < 2; p++) {
      ctx.beginPath();
      for (const d of game.dots) {
        if (d.player !== p) continue;
        const [x0, y0] = cellCenter(g, d.prevCell, size);
        const [x1, y1] = cellCenter(g, d.cell, size);
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        let a0 = dirAngle(d.prevFacing), a1 = dirAngle(d.facing);
        let da = a1 - a0;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        const a = a0 + da * Math.min(1, t * 1.6);
        // arrowhead: tip, two back corners, and a notch
        const ca = Math.cos(a), sa = Math.sin(a);
        const pt = (/** @type {number} */ fx, /** @type {number} */ fy) => [x + fx * ca - fy * sa, y + fx * sa + fy * ca];
        const [tx, ty] = pt(r * 1.1, 0);
        const [lx, ly] = pt(-r * 0.75, -r * 0.8);
        const [nx, ny] = pt(-r * 0.35, 0);
        const [rx, ry] = pt(-r * 0.75, r * 0.8);
        ctx.moveTo(tx, ty); ctx.lineTo(lx, ly); ctx.lineTo(nx, ny); ctx.lineTo(rx, ry); ctx.closePath();
      }
      ctx.fillStyle = COLORS.players[p];
      ctx.fill();
    }
  }

  /** Little white sparks where two dots are locked head-on. */
  function drawClashes() {
    if (!game) return;
    const g = game.grid;
    ctx.fillStyle = '#ffffff';
    const flicker = performance.now() / 70;
    for (const d of game.dots) {
      if (!d.locked || d.player !== 0) continue;
      const n = g.nbr[d.cell * 6 + d.facing];
      const e = n >= 0 ? game.occ[n] : null;
      if (!e || !e.locked) continue;
      const [x0, y0] = cellCenter(g, d.cell, size);
      const [x1, y1] = cellCenter(g, n, size);
      const s = size * (0.18 + 0.12 * Math.abs(Math.sin(flicker + d.id)));
      ctx.beginPath();
      ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawParticles(/** @type {number} */ dt) {
    let w = 0;
    for (const p of particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      particles[w++] = p;
      const k = 1 - p.life / p.max;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - dt * 4; p.vy *= 1 - dt * 4;
      ctx.globalAlpha = k;
      if (p.kind === 1) {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size + (1 - k) * size * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size * k + 0.5, p.size * k + 0.5);
      }
    }
    particles.length = w;
    ctx.globalAlpha = 1;
  }

  /** @param {{ targetsPx: ({x: number, y: number}|null)[], dragging: boolean[], hints: boolean, human: boolean[] }} ui */
  function drawTargets(ui) {
    const now = performance.now() / 1000;
    for (let p = 0; p < 2; p++) {
      const t = ui.targetsPx[p];
      if (!t) continue;
      const color = COLORS.players[p];
      const R = Math.max(12, size * 1.7) * (ui.dragging[p] ? 1.35 : 1) * (1 + 0.06 * Math.sin(now * 5 + p));
      ctx.save();
      ctx.translate(t.x, t.y);
      // 1. Dark backing disc: dims the dots underneath so the marker reads
      //    even on top of a same-coloured crowd.
      const back = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.6);
      back.addColorStop(0, 'rgba(8,10,22,0.82)');
      back.addColorStop(0.65, 'rgba(8,10,22,0.6)');
      back.addColorStop(1, 'rgba(8,10,22,0)');
      ctx.fillStyle = back;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.6, 0, Math.PI * 2);
      ctx.fill();
      // 2. Arcs: dark outline with a drop shadow, then the team colour.
      const spin = now * (p ? -0.8 : 0.8);
      ctx.rotate(spin);
      ctx.lineCap = 'round';
      const arcs = () => {
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          ctx.arc(0, 0, R, k * Math.PI / 2 + 0.25, (k + 1) * Math.PI / 2 - 0.25);
          ctx.stroke();
        }
      };
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.strokeStyle = '#05060f';
      ctx.lineWidth = 7;
      arcs();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      arcs();
      ctx.rotate(-spin);
      // 3. White centre ringed in the team colour: nothing else is white.
      const r0 = Math.max(4, R * 0.24);
      ctx.beginPath();
      ctx.arc(0, 0, r0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
      if (ui.hints && ui.human[p]) {
        ctx.save();
        ctx.translate(t.x, t.y);
        if (view.flip) ctx.rotate(Math.PI);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now * 6);
        ctx.font = `600 ${Math.max(12, size * 1.6)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('drag me', 0, R + Math.max(16, size * 2.4));
        ctx.restore();
      }
    }
  }

  /** Tug-of-war bar of spawn ownership, plus dot counts. */
  function drawHud() {
    if (!game) return;
    hudBar(cw / 2, portrait ? ch - 20 : 22, view.local);
  }

  /** @param {number} x @param {number} y @param {number} first  player shown on the left */
  function hudBar(x, y, first) {
    if (!game) return;
    const n = game.spawns.length;
    const blue = game.spawns.filter((s) => s.owner === 0).length;
    const red = game.spawns.filter((s) => s.owner === 1).length;
    const w = Math.min(cw * 0.5, 360), h = 10, gap = 3;
    const seg = (w - gap * (n - 1)) / n;
    ctx.save();
    ctx.translate(x, y);
    // The reader sees their own colour on the left.
    const order = [first, 1 - first];
    const counts = first ? [red, blue] : [blue, red];
    for (let i = 0; i < n; i++) {
      const owner = i < counts[0] ? order[0] : i >= n - counts[1] ? order[1] : -1;
      ctx.fillStyle = owner >= 0 ? COLORS.players[owner] : 'rgba(125,133,151,0.35)';
      roundRect(-w / 2 + i * (seg + gap), -h / 2, seg, h, 3);
      ctx.fill();
    }
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.players[order[0]];
    ctx.fillText(String(game.dotCount[order[0]]), -w / 2 - 10, 0);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.players[order[1]];
    ctx.fillText(String(game.dotCount[order[1]]), w / 2 + 10, 0);
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

  /** @param {{lines: string[], color?: string, sub?: string}} o */
  function drawOverlay(o) {
    ctx.save();
    ctx.fillStyle = o.stats ? 'rgba(13,16,32,0.78)' : 'rgba(13,16,32,0.35)';
    ctx.fillRect(0, 0, cw, ch);
    // with a stats table underneath, pull the text toward the middle so it fits
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

  /**
   * Two-column stats table, drawn in the overlay's frame.
   * @param {{names: string[], rows: [string, number, number][]}} st @param {number} top
   */
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

  return {
    setGame,
    layout,
    onTick,
    draw,
    /** Screen point → board pixel coords. */
    toBoard(/** @type {number} */ x, /** @type {number} */ y) {
      return view.flip ? { x: bw - (x - ox), y: bh - (y - oy) } : { x: x - ox, y: y - oy };
    },
    /** @param {{ flip: boolean, local: number }} v */
    setView(v) { view = { ...v }; },
    get size() { return size; },
    get board() { return { x: ox, y: oy, w: bw, h: bh }; },
  };
}

