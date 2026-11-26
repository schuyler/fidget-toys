// Wires the simulation, renderer, input, AI and sound together.

import { createGame, setTarget, step } from './sim.js';
import { createAI } from './ai.js';
import { createRenderer, COLORS } from './render.js';
import { createAudio } from './audio.js';
import { cellCenter, pixelToCell } from './hex.js';

// The settings players see: five simple choices, each a preset. Everything
// else (meters, regen, spawn interval, facing arc) stays at the sim defaults.
const CHOICES = {
  mode: ['2p', 'cpu-easy', 'cpu'],
  /** cells across the screen's short side; the long side fills the screen */
  size: { small: 24, medium: 34, large: 46 },
  /** ticks per second */
  speed: { slow: 5, average: 8, fast: 12 },
  /** neutral spawn points */
  spawns: { few: 4, some: 6, many: 10 },
  /** rock layout */
  obstacles: { none: 'open', some: 'rocks', many: 'dense' },
};
const SQRT3 = Math.sqrt(3);

// v2: only the five simple choices are stored, so values from the old
// advanced fields can't linger invisibly.
const SETTINGS_KEY = 'dot-army-settings-v2';
const defaultSettings = { mode: '2p', size: 'medium', speed: 'average', spawns: 'some', obstacles: 'none' };
/** @param {any} raw */
function sanitize(raw) {
  const out = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;
  if (CHOICES.mode.includes(raw.mode)) out.mode = raw.mode;
  for (const k of /** @type {const} */ (['size', 'speed', 'spawns', 'obstacles'])) {
    if (typeof raw[k] === 'string' && raw[k] in CHOICES[k]) out[k] = raw[k];
  }
  return out;
}
let settings = { ...defaultSettings };
try {
  settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
} catch { /* storage unavailable: use defaults */ }

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const renderer = createRenderer(canvas);
const audio = createAudio();

/** @type {import('./sim.js').Game} */
let game;
/** @type {(ReturnType<typeof createAI>|null)[]} */
let ais = [null, null];
let phase = 'countdown'; // 'countdown' | 'play' | 'over'
let countdown = 0;
let paused = false;
let acc = 0;
let overAt = 0;
let lastCount = 0;
let hintsUntil = 0;

/** pointerId → player being dragged */
const drags = new Map();
/** @type {{x: number, y: number}[]} smoothed on-screen target positions (board px) */
let targetsPx = [{ x: 0, y: 0 }, { x: 0, y: 0 }];

function newGame() {
  const short = CHOICES.size[/** @type {keyof typeof CHOICES.size} */ (settings.size)];
  const portrait = window.innerHeight > window.innerWidth;
  // Match the board's aspect ratio to the screen (hex rows are 1.5 radii
  // tall, columns sqrt(3) wide), leaving room for the HUD.
  const availW = window.innerWidth - 20;
  const availH = window.innerHeight - (portrait ? 68 : 56);
  const aspect = availW / availH;
  let width, height;
  if (portrait) {
    width = short;
    height = Math.round((SQRT3 * (width + 0.5) / aspect - 0.5) / 1.5);
  } else {
    height = short;
    width = Math.round((aspect * (1.5 * height + 0.5)) / SQRT3 - 0.5);
  }
  width = Math.max(short, Math.min(short * 3, width));
  height = Math.max(short, Math.min(short * 3, height));
  game = createGame({
    width,
    height,
    tickRate: CHOICES.speed[/** @type {keyof typeof CHOICES.speed} */ (settings.speed)],
    neutralSpawns: CHOICES.spawns[/** @type {keyof typeof CHOICES.spawns} */ (settings.spawns)],
    terrain: CHOICES.obstacles[/** @type {keyof typeof CHOICES.obstacles} */ (settings.obstacles)],
    seed: (Math.random() * 2 ** 31) >>> 0,
  });
  ais = [null, settings.mode === '2p' ? null
    : createAI(1, game.params.seed, settings.mode === 'cpu-easy'
      ? { thinkEvery: 16, aggression: 0.5, noise: 14, dragSpeed: 0.55 }
      : { dragSpeed: 1.1 })];
  renderer.setGame(game);
  drags.clear();
  targetsPx = [0, 1].map((p) => cellPx(game.targets[p]));
  phase = 'countdown';
  countdown = 3.2;
  lastCount = 4;
  paused = false;
  acc = 0;
  hintsUntil = performance.now() + 7000;
}

function cellPx(/** @type {number} */ cell) {
  const [x, y] = cellCenter(game.grid, cell, renderer.size);
  return { x, y };
}

// ---------------------------------------------------------------------------
// Input: each finger grabs a marker; multitouch lets both players drag at once.

function humanPlayers() {
  return [true, settings.mode === '2p'];
}

/** Which player "owns" this half of the screen (blue: bottom/left). */
function sideOf(/** @type {number} */ x, /** @type {number} */ y) {
  return renderer.portrait ? (y > window.innerHeight / 2 ? 0 : 1) : (x < window.innerWidth / 2 ? 0 : 1);
}

canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  e.preventDefault();
  if (phase === 'over') {
    if (performance.now() - overAt > 900) newGame();
    return;
  }
  if (paused) { paused = false; return; }
  const b = renderer.toBoard(e.clientX, e.clientY);
  const human = humanPlayers();
  const grab = Math.max(40, renderer.size * 3.5);
  let player = -1, bestD = Infinity;
  const side = sideOf(e.clientX, e.clientY);
  for (let p = 0; p < 2; p++) {
    if (!human[p] || [...drags.values()].includes(p)) continue;
    const t = targetsPx[p];
    // prefer your own side's marker when both are in reach
    const d = Math.hypot(t.x - b.x, t.y - b.y) - (p === side ? grab * 0.5 : 0);
    if (d < grab && d < bestD) { bestD = d; player = p; }
  }
  // Not on a marker: a tap on your own half jumps your marker there.
  if (player < 0 && human[side] && ![...drags.values()].includes(side)) player = side;
  if (player < 0) return;
  drags.set(e.pointerId, player);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or stale pointer */ }
  moveTarget(player, b.x, b.y);
});

canvas.addEventListener('pointermove', (e) => {
  const player = drags.get(e.pointerId);
  if (player === undefined) return;
  const b = renderer.toBoard(e.clientX, e.clientY);
  moveTarget(player, b.x, b.y);
});

function endDrag(/** @type {PointerEvent} */ e) {
  drags.delete(e.pointerId);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function moveTarget(/** @type {number} */ player, /** @type {number} */ x, /** @type {number} */ y) {
  const { w, h } = renderer.board;
  x = Math.max(0, Math.min(w, x));
  y = Math.max(0, Math.min(h, y));
  targetsPx[player] = { x, y };
  setTarget(game, player, pixelToCell(game.grid, x, y, renderer.size));
}

// ---------------------------------------------------------------------------
// Main loop

let last = performance.now();
function frame(/** @type {number} */ now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const tickMs = 1000 / game.params.tickRate;

  if (phase === 'countdown' && !paused) {
    countdown -= dt;
    const c = Math.ceil(countdown);
    if (c !== lastCount && c > 0) { lastCount = c; audio.count(); }
    if (countdown <= 0) { phase = 'play'; audio.go(); }
  } else if (phase === 'play' && !paused) {
    acc += dt * 1000;
    let steps = 0;
    while (acc >= tickMs && steps++ < 4) {
      acc -= tickMs;
      tick();
      if (phase !== 'play') break;
    }
    if (acc > tickMs) acc = tickMs; // don't spiral after a stall
  }

  // markers glide to their cell when not being dragged
  const dragging = [false, false];
  for (const p of drags.values()) dragging[p] = true;
  for (let p = 0; p < 2; p++) {
    if (dragging[p]) continue;
    const goal = cellPx(game.targets[p]);
    const k = 1 - Math.exp(-dt * 14);
    targetsPx[p] = { x: targetsPx[p].x + (goal.x - targetsPx[p].x) * k, y: targetsPx[p].y + (goal.y - targetsPx[p].y) * k };
  }

  renderer.draw(phase === 'play' ? acc / tickMs : 1, paused ? 0 : dt, {
    targetsPx,
    dragging,
    overlay: overlay(),
    hints: now < hintsUntil,
    human: humanPlayers(),
  });
  requestAnimationFrame(frame);
}

function tick() {
  for (const ai of ais) {
    if (!ai) continue;
    const t = ai.think(game);
    if (t !== null) setTarget(game, ai.player, t);
  }
  const ev = step(game);
  renderer.onTick(ev);
  if (ev.kills.length) audio.kills(ev.kills.length);
  if (ev.hits.length && game.tick % 2 === 0) audio.hit(ev.hits[0].player);
  for (const c of ev.captures) {
    audio.capture(c.to);
    try { navigator.vibrate?.(30); } catch { /* not supported */ }
  }
  if (game.winner >= 0) {
    phase = 'over';
    overAt = performance.now();
    audio.win(game.winner);
  }
}

function overlay() {
  if (phase === 'countdown') {
    const c = Math.ceil(countdown);
    return { lines: [String(c)], sub: settings.mode === '2p' ? 'blue vs red' : 'you are blue' };
  }
  if (paused) return { lines: ['PAUSED'], sub: 'tap to resume' };
  if (phase === 'over') {
    const cpuWon = settings.mode !== '2p' && game.winner === 1;
    return {
      lines: [cpuWon ? 'CPU WINS' : `${game.winner === 0 ? 'BLUE' : 'RED'} WINS`],
      color: COLORS.players[game.winner],
      sub: `${Math.round(game.tick / game.params.tickRate)}s · tap to play again`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Toolbar and settings

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

$('btn-pause').addEventListener('click', () => {
  if (phase !== 'over') paused = !paused;
});
$('btn-restart').addEventListener('click', () => newGame());
const muteBtn = $('btn-mute');
const syncMute = () => { muteBtn.textContent = audio.muted ? '🔇' : '🔊'; };
syncMute();
muteBtn.addEventListener('click', () => { audio.unlock(); audio.setMuted(!audio.muted); syncMute(); });

const dialog = /** @type {HTMLDialogElement} */ ($('settings'));
const form = /** @type {HTMLFormElement} */ ($('settings-form'));
$('btn-settings').addEventListener('click', () => {
  paused = phase !== 'over';
  for (const [k, v] of Object.entries(settings)) {
    const el = /** @type {RadioNodeList|null} */ (form.elements.namedItem(k)); // radio group: setting .value checks the match
    if (el) el.value = v;
  }
  dialog.showModal();
});
form.addEventListener('submit', (e) => {
  const submitter = /** @type {HTMLButtonElement|null} */ (/** @type {SubmitEvent} */ (e).submitter);
  if (submitter?.value === 'reset') {
    settings = { ...defaultSettings };
  } else if (submitter?.value === 'apply') {
    settings = sanitize(Object.fromEntries(new FormData(form)));
  } else {
    paused = false;
    return;
  }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  newGame();
});

window.addEventListener('resize', () => {
  renderer.layout();
  targetsPx = [0, 1].map((p) => cellPx(game.targets[p]));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase === 'play') paused = true;
});

newGame();
requestAnimationFrame(frame);
