// Canvas renderer: the board, troopers, plotted orders, and playback effects.
// Presentation only. Main hands it everything to draw each frame; nothing
// here feeds back into the game.

import { cellCenter, boardSize, fitSize, pixelToCell } from './geom.js';
import { OPEN, BRUSH, RUINS, HIGH, ROCK, BUILDING } from './sim.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Order} Order */

export const COLORS = {
  bg: '#0d1020',
  sides: ['#3d8bff', '#ff4d5e'],
  sidesDim: ['rgba(61,139,255,0.35)', 'rgba(255,77,94,0.35)'],
  neutral: '#9aa3c7',
  move: '#e8ecff',
  fire: '#ff8a4d',
  dodge: '#4dc3ff',
  watch: '#ffd24d',
  bomb: '#c47dff',
  text: '#e8ecff',
};

const TERRAIN = {
  [OPEN]: '#161b36',
  [BRUSH]: '#1c3527',
  [RUINS]: '#3a3328',
  [HIGH]: '#2b3756',
  [ROCK]: '#070912',
  [BUILDING]: '#4b5072',
};

const GLYPH = { compact: 'C', orrin: 'O', vell: 'V' };
/** Hex radius in CSS px at zoom 1: about 42 px across, a comfortable tap. */
export const BASE_SIZE = 24;

/**
 * A trooper (or a swarm) as drawn. x, y are in board units (hex radius 1).
 * @typedef {{ id: number, x: number, y: number, side: number, faction: string, shock: number, pool: number,
 *   down: boolean, leader: boolean, count: number, dim?: boolean, selected?: boolean, done?: boolean }} Piece
 */

/**
 * What main wants drawn this frame.
 * @typedef {Object} Scene
 * @property {Piece[]} pieces
 * @property {number[]} owners             victory owner by index
 * @property {Int32Array|null} reach       move cost per cell for the selection, -1 = out of reach
 * @property {Uint8Array|null} sight       1 = in sight from the selection's cell
 * @property {{ from: number, d: Order, side: number, selected: boolean }[]} plans  plotted orders to draw
 * @property {{ cell: number, cells: number[] } | null} aim   bomb footprint under the finger
 * @property {{ x: number, y: number, cell: number, label: string } | null} drag  destination drag ghost
 */

/** @param {HTMLCanvasElement} canvas */
export function createRenderer(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  let dpr = 1, cw = 0, ch = 0;
  /** @type {Game|null} */ let game = null;
  /** Board-unit centres, one per cell. @type {[number, number][]} */ let centres = [];
  // Camera: hex radius in CSS px, and where the board's origin sits on screen.
  let size = BASE_SIZE, ox = 0, oy = 0;
  /** The part of the screen the board may use (between the HUD and the bar). */
  let area = { top: 0, bottom: 0 };
  /** @type {{ t0: number, life: number, draw: (k: number) => void }[]} */
  let fx = [];

  function setGame(/** @type {Game} */ g) {
    game = g;
    centres = [];
    for (let i = 0; i < g.grid.N; i++) centres.push(/** @type {[number, number]} */ (cellCenter(g.grid, i, 1)));
    fx = [];
  }

  /** Resize the canvas; keep the board where it was, clamped. */
  function layout(/** @type {{ top: number, bottom: number }} */ a) {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    area = a;
    size = Math.max(minSize(), Math.min(maxSize(), size));
    clamp();
  }

  const viewH = () => Math.max(50, ch - area.top - area.bottom);
  /** Zoomed all the way out, the whole board fits. */
  const minSize = () => (game ? fitSize(game.grid, cw - 8, viewH() - 8) : BASE_SIZE);
  const maxSize = () => Math.max(minSize(), 2 * BASE_SIZE);

  /** Keep the board on screen: centred if it's smaller than the view, else no gaps at the edges. */
  function clamp() {
    if (!game) return;
    const b = boardSize(game.grid, size);
    const vh = viewH();
    ox = b.w <= cw ? (cw - b.w) / 2 : Math.min(8, Math.max(cw - b.w - 8, ox));
    oy = b.h <= vh ? area.top + (vh - b.h) / 2 : Math.min(area.top + 8, Math.max(area.top + vh - b.h - 8, oy));
  }

  /** Start a game zoomed to `s` (clamped), showing the bottom of the board, where the player starts. */
  function home(s = BASE_SIZE) {
    if (!game) return;
    size = Math.max(minSize(), Math.min(maxSize(), s));
    const b = boardSize(game.grid, size);
    ox = (cw - b.w) / 2;
    oy = area.top + viewH() - b.h;
    clamp();
  }

  function pan(/** @type {number} */ dx, /** @type {number} */ dy) { ox += dx; oy += dy; clamp(); }

  /** Zoom by factor k about a screen point. */
  function zoom(/** @type {number} */ k, /** @type {number} */ px, /** @type {number} */ py) {
    const s = Math.max(minSize(), Math.min(maxSize(), size * k));
    ox = px - ((px - ox) * s) / size;
    oy = py - ((py - oy) * s) / size;
    size = s;
    clamp();
  }

  /** Scroll so a cell is in view (centred if it's off screen or near an edge). */
  function reveal(/** @type {number} */ cell) {
    const [x, y] = toScreen(cell);
    const m = size * 2;
    if (x < m || x > cw - m || y < area.top + m || y > ch - area.bottom - m) {
      ox += cw / 2 - x;
      oy += area.top + viewH() / 2 - y;
      clamp();
    }
  }

  /** Screen (CSS px) position of a cell's centre. */
  function toScreen(/** @type {number} */ cell) {
    const [x, y] = centres[cell];
    return [ox + x * size, oy + y * size];
  }
  /** Cell under a screen point, or -1. */
  function cellAtPoint(/** @type {number} */ px, /** @type {number} */ py) {
    if (!game) return -1;
    return pixelToCell(game.grid, px - ox, py - oy, size);
  }
  /** Board units under a screen point. */
  function toBoard(/** @type {number} */ px, /** @type {number} */ py) {
    return { x: (px - ox) / size, y: (py - oy) / size };
  }

  // ---- Drawing ----

  /** @param {number} x @param {number} y @param {number} r */
  function hexPath(x, y, r) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  const sx = (/** @type {number} */ bx) => ox + bx * size;
  const sy = (/** @type {number} */ by) => oy + by * size;

  function drawBoard(/** @type {Scene} */ scene) {
    if (!game) return;
    const g = game;
    const vic = new Map(g.victory.map((v, i) => [v.cell, scene.owners[i] ?? v.owner]));
    for (let i = 0; i < g.grid.N; i++) {
      const x = sx(centres[i][0]), y = sy(centres[i][1]);
      if (x < -size || x > cw + size || y < -size || y > ch + size) continue;
      const t = g.terrain[i];
      hexPath(x, y, size * (t === ROCK ? 1.0 : 0.94));
      ctx.fillStyle = TERRAIN[t];
      ctx.fill();
      drawTerrainMark(t, x, y);
      if (scene.sight && !scene.sight[i] && t !== ROCK) {
        hexPath(x, y, size * 0.94);
        ctx.fillStyle = 'rgba(5,7,16,0.45)';
        ctx.fill();
      }
      if (scene.reach && scene.reach[i] >= 0) {
        hexPath(x, y, size * 0.94);
        ctx.fillStyle = 'rgba(61,139,255,0.16)';
        ctx.fill();
      }
      const owner = vic.get(i);
      if (owner !== undefined) {
        hexPath(x, y, size * 0.8);
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.strokeStyle = owner < 0 ? COLORS.neutral : COLORS.sides[owner];
        ctx.stroke();
        ctx.fillStyle = owner < 0 ? COLORS.neutral : COLORS.sides[owner];
        ctx.font = `${Math.round(size * 0.55)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('◆', x, y - size * 0.55);
      }
    }
  }

  /** Small marks so terrain reads without colour alone. */
  function drawTerrainMark(/** @type {number} */ t, /** @type {number} */ x, /** @type {number} */ y) {
    const r = size;
    ctx.lineWidth = Math.max(1, r * 0.07);
    if (t === BRUSH) {
      ctx.fillStyle = '#2f5a41';
      for (const [dx, dy] of [[-0.35, -0.2], [0.3, -0.3], [0, 0.25], [-0.3, 0.35], [0.38, 0.2]]) {
        ctx.beginPath(); ctx.arc(x + dx * r, y + dy * r, r * 0.09, 0, Math.PI * 2); ctx.fill();
      }
    } else if (t === RUINS) {
      ctx.strokeStyle = '#5c5240';
      ctx.beginPath();
      ctx.moveTo(x - 0.45 * r, y + 0.2 * r); ctx.lineTo(x - 0.15 * r, y + 0.2 * r); ctx.lineTo(x - 0.15 * r, y - 0.2 * r);
      ctx.moveTo(x + 0.1 * r, y - 0.35 * r); ctx.lineTo(x + 0.45 * r, y - 0.35 * r); ctx.lineTo(x + 0.45 * r, y);
      ctx.stroke();
    } else if (t === HIGH) {
      ctx.strokeStyle = '#41517c';
      ctx.beginPath();
      ctx.moveTo(x - 0.4 * r, y + 0.15 * r); ctx.lineTo(x - 0.1 * r, y - 0.2 * r); ctx.lineTo(x + 0.2 * r, y + 0.15 * r);
      ctx.moveTo(x, y + 0.35 * r); ctx.lineTo(x + 0.25 * r, y + 0.05 * r); ctx.lineTo(x + 0.5 * r, y + 0.35 * r);
      ctx.stroke();
    } else if (t === BUILDING) {
      ctx.fillStyle = '#62688f';
      ctx.fillRect(x - 0.35 * r, y - 0.3 * r, 0.7 * r, 0.6 * r);
      ctx.fillStyle = TERRAIN[BUILDING];
      ctx.fillRect(x - 0.2 * r, y - 0.15 * r, 0.15 * r, 0.15 * r);
      ctx.fillRect(x + 0.05 * r, y - 0.15 * r, 0.15 * r, 0.15 * r);
    }
  }

  function drawPlans(/** @type {Scene} */ scene) {
    for (const { from, d, side, selected } of scene.plans) {
      const alpha = selected ? 1 : 0.55;
      ctx.globalAlpha = alpha;
      const col = COLORS.sides[side];
      let [x, y] = toScreen(from);
      // movement
      if (d.path.length) {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (const c of d.path) { const [px, py] = toScreen(c); ctx.lineTo(px, py); }
        ctx.stroke();
        [x, y] = toScreen(d.path[d.path.length - 1]);
        ctx.beginPath();
        ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.5, size * 0.08);
        ctx.setLineDash([size * 0.18, size * 0.12]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // overwatch: a ring at the end; dodge: a badge
      if (d.overwatch > 0) {
        ctx.strokeStyle = COLORS.watch;
        ctx.lineWidth = Math.max(1.5, size * 0.07);
        ctx.beginPath(); ctx.arc(x, y, size * 0.72, -Math.PI * 0.8, -Math.PI * 0.2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, size * 0.72, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
      }
      // fire, from the start cell
      if (d.fire > 0 && d.target >= 0 && game) {
        const tgt = game.troopers[d.target];
        const [ax, ay] = toScreen(from), [bx, by] = toScreen(tgt.cell);
        ctx.strokeStyle = COLORS.fire;
        ctx.lineWidth = Math.max(2, size * 0.1);
        ctx.setLineDash([size * 0.25, size * 0.15]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]);
        label(bx + size * 0.55, by - size * 0.55, String(d.fire), COLORS.fire);
      }
      // launch: an arc to the cell, and the cell marked
      if ((d.launch ?? 0) > 0 && (d.launchAt ?? -1) >= 0) {
        const [ax, ay] = toScreen(from), [bx, by] = toScreen(/** @type {number} */ (d.launchAt));
        ctx.strokeStyle = COLORS.bomb;
        ctx.lineWidth = Math.max(2, size * 0.09);
        ctx.setLineDash([size * 0.12, size * 0.12]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + bx) / 2, Math.min(ay, by) - size * 3, bx, by);
        ctx.stroke();
        ctx.setLineDash([]);
        crosshair(bx, by, COLORS.bomb);
        label(bx + size * 0.55, by + size * 0.55, String(d.launch), COLORS.bomb);
      }
      ctx.globalAlpha = 1;
    }
  }

  function crosshair(/** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ col) {
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1.5, size * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, size * 0.45, 0, Math.PI * 2);
    ctx.moveTo(x - size * 0.7, y); ctx.lineTo(x + size * 0.7, y);
    ctx.moveTo(x, y - size * 0.7); ctx.lineTo(x, y + size * 0.7);
    ctx.stroke();
  }

  function label(/** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ s, /** @type {string} */ col) {
    ctx.font = `600 ${Math.round(Math.max(11, size * 0.5))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(s).width + 8, h = Math.max(14, size * 0.6);
    ctx.fillStyle = 'rgba(13,16,32,0.85)';
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = col;
    ctx.fillText(s, x, y + 1);
  }

  function drawPieces(/** @type {Piece[]} */ pieces) {
    for (const p of pieces) {
      if (p.down) continue;
      const x = sx(p.x), y = sy(p.y), r = size * 0.56;
      ctx.globalAlpha = p.dim ? 0.4 : 1;
      if (p.selected) {
        ctx.beginPath(); ctx.arc(x, y, r + size * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.sides[p.side];
      ctx.fill();
      // health ring: the part of the pool still usable
      const left = Math.max(0, (p.pool - p.shock) / p.pool);
      ctx.lineWidth = Math.max(2, size * 0.11);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.arc(x, y, r + ctx.lineWidth / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = left > 0.5 ? '#7dffb0' : left > 0.25 ? COLORS.watch : COLORS.sides[1];
      ctx.beginPath(); ctx.arc(x, y, r + ctx.lineWidth / 2, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(size * 0.6)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(GLYPH[/** @type {keyof typeof GLYPH} */ (p.faction)] ?? '?', x, y + 1);
      if (p.leader) {
        ctx.font = `${Math.round(size * 0.45)}px system-ui, sans-serif`;
        ctx.fillStyle = COLORS.watch;
        ctx.fillText('★', x - r * 0.9, y - r * 0.9);
      }
      if (p.count > 1) label(x + r * 0.95, y - r * 0.9, `×${p.count}`, COLORS.text);
      if (p.done) {
        ctx.font = `700 ${Math.round(size * 0.42)}px system-ui, sans-serif`;
        ctx.fillStyle = '#7dffb0';
        ctx.fillText('✓', x + r * 0.95, y + r * 0.9);
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawAim(/** @type {Scene} */ scene) {
    if (!scene.aim) return;
    for (const c of scene.aim.cells) {
      const [x, y] = toScreen(c);
      hexPath(x, y, size * 0.9);
      ctx.fillStyle = c === scene.aim.cell ? 'rgba(196,125,255,0.45)' : 'rgba(196,125,255,0.22)';
      ctx.fill();
    }
  }

  function drawDrag(/** @type {Scene} */ scene) {
    const d = scene.drag;
    if (!d) return;
    if (d.cell >= 0) {
      const [x, y] = toScreen(d.cell);
      hexPath(x, y, size * 0.94);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.arc(d.x, d.y, size * 0.56, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.sides[0]; ctx.fill();
    ctx.globalAlpha = 1;
    // the bubble sits above the finger, where it can be read
    if (d.label) label(d.x, d.y - size * 2.2, d.label, COLORS.text);
  }

  /** @param {Scene} scene @param {number} now */
  function draw(scene, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cw, ch);
    if (!game) return;
    drawBoard(scene);
    drawAim(scene);
    drawPlans(scene);
    drawPieces(scene.pieces);
    fx = fx.filter((f) => now - f.t0 < f.life);
    for (const f of fx) f.draw(Math.min(1, (now - f.t0) / f.life));
    drawDrag(scene);
  }

  // ---- Effects for playback ----

  const effects = {
    /** A shot: a line that fades, and a number over the target. */
    tracer(/** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ col, /** @type {number} */ now) {
      fx.push({ t0: now, life: 700, draw: (k) => {
        const [ax, ay] = toScreen(from), [bx, by] = toScreen(to);
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + (bx - ax) * Math.min(1, k * 3), ay + (by - ay) * Math.min(1, k * 3)); ctx.stroke();
        ctx.globalAlpha = 1;
      } });
    },
    text(/** @type {number} */ cell, /** @type {string} */ s, /** @type {string} */ col, /** @type {number} */ now, offset = 0) {
      fx.push({ t0: now, life: 1300, draw: (k) => {
        const [x, y] = toScreen(cell);
        ctx.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
        label(x, y - size * (0.9 + offset * 0.7 + k * 0.8), s, col);
        ctx.globalAlpha = 1;
      } });
    },
    arc(/** @type {number} */ from, /** @type {number} */ to, /** @type {number} */ now) {
      fx.push({ t0: now, life: 900, draw: (k) => {
        const [ax, ay] = toScreen(from), [bx, by] = toScreen(to);
        const cx = (ax + bx) / 2, cy = Math.min(ay, by) - size * 3;
        const t = Math.min(1, k * 1.2);
        const x = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx;
        const y = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by;
        ctx.fillStyle = COLORS.bomb;
        ctx.beginPath(); ctx.arc(x, y, size * 0.2, 0, Math.PI * 2); ctx.fill();
        crosshair(bx, by, COLORS.bomb);
      } });
    },
    blast(/** @type {number[]} */ cells, /** @type {number} */ centre, /** @type {number} */ now) {
      fx.push({ t0: now, life: 900, draw: (k) => {
        for (const c of cells) {
          const [x, y] = toScreen(c);
          hexPath(x, y, size * 0.94);
          ctx.fillStyle = c === centre ? `rgba(255,210,77,${0.8 * (1 - k)})` : `rgba(255,138,77,${0.55 * (1 - k)})`;
          ctx.fill();
        }
      } });
    },
    /** A bomb that scattered: from where it was aimed to where it landed. */
    arrow(/** @type {number} */ from, /** @type {number} */ to, /** @type {number} */ now) {
      fx.push({ t0: now, life: 1400, draw: (k) => {
        const [ax, ay] = toScreen(from), [bx, by] = toScreen(to);
        ctx.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
        ctx.strokeStyle = COLORS.bomb;
        ctx.lineWidth = Math.max(2, size * 0.1);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        const a = Math.atan2(by - ay, bx - ax);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - size * 0.4 * Math.cos(a - 0.5), by - size * 0.4 * Math.sin(a - 0.5));
        ctx.lineTo(bx - size * 0.4 * Math.cos(a + 0.5), by - size * 0.4 * Math.sin(a + 0.5));
        ctx.closePath();
        ctx.fillStyle = COLORS.bomb; ctx.fill();
        ctx.globalAlpha = 1;
      } });
    },
    clear() { fx = []; },
  };

  return {
    setGame, layout, home, pan, zoom, reveal, toScreen, toBoard, cellAtPoint, draw, effects,
    get size() { return size; },
    get centres() { return centres; },
  };
}
