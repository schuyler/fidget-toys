// Wires the simulation, renderer, input, CPU and sound together.

import { createGame, applyInput, step, isin, deg, PORT, STARBOARD, BLUE, RED, DRAW } from './sim.js';
import { createAI } from './ai.js';
import { createRenderer, loadAssets, COLORS } from './render.js';
import { createAudio } from './audio.js';

// The settings players see: five simple choices, each a preset. The tuning
// parameters stay at the sim's DEFAULTS.
const CHOICES = {
  mode: ['cpu-easy', 'cpu'],
  islands: { none: 'none', some: 'some', many: 'many' },
  wind: { steady: 'steady', shifty: 'shifty', gusty: 'gusty' },
  shadow: { off: false, on: true },
  crew: { '2': 2, '3': 3, '5': 5 },
};
const SETTINGS_KEY = 'wooden-ships-settings-v1';
const defaultSettings = { mode: 'cpu-easy', islands: 'some', wind: 'shifty', shadow: 'on', crew: '3' };
/** @param {any} raw */
function sanitize(raw) {
  const out = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;
  if (CHOICES.mode.includes(raw.mode)) out.mode = raw.mode;
  for (const k of /** @type {const} */ (['islands', 'wind', 'shadow', 'crew'])) {
    if (typeof raw[k] === 'string' && raw[k] in CHOICES[k]) out[k] = raw[k];
  }
  return out;
}
let settings = { ...defaultSettings };
try {
  settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
} catch { /* storage unavailable: use defaults */ }

const query = new URLSearchParams(location.search);
const debug = query.has('debug');
const YOU = 0;
/** Tiles across the sea's short side (22 m each: about 1,000 m). */
const SHORT_TILES = 45;
/** Pixels of sideways drag for full rudder: about a thumb's width. */
const FULL_LOCK_PX = 48;
/** The fire buttons and steering swap sides only once the bow is this far past straight across the screen. */
const SWAP = isin(deg(15));

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const audio = createAudio();
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {import('./sim.js').Game} */
let game;
/** @type {ReturnType<typeof createAI>|null} */
let ai = null;
/** @type {ReturnType<typeof createRenderer>} */
let renderer;
let phase = 'menu'; // 'menu' | 'countdown' | 'play' | 'over'
let countdown = 0;
let lastCount = 0;
let paused = false;
let acc = 0;
let overAt = 0;
let gameSerial = 0;
/** Your starboard side faces screen left (your ship is heading down the screen). */
let leftIsStarboard = false;

function newGame(start = true) {
  const w = window.innerWidth, h = window.innerHeight;
  const long = Math.min(110, Math.max(SHORT_TILES, Math.round((SHORT_TILES * Math.max(w, h)) / Math.min(w, h))));
  const portrait = h >= w;
  const seed = query.has('seed') ? Number(query.get('seed')) : (Math.random() * 2 ** 31) >>> 0;
  game = createGame({
    seed,
    width: portrait ? SHORT_TILES : long,
    height: portrait ? long : SHORT_TILES,
    islands: settings.islands,
    wind: settings.wind,
    shadow: CHOICES.shadow[/** @type {'on'|'off'} */ (settings.shadow)],
    crewPerGun: CHOICES.crew[/** @type {'2'|'3'|'5'} */ (settings.crew)],
  });
  ai = createAI(RED, (seed * 7 + 3) >>> 0, { level: settings.mode === 'cpu' ? 'hard' : 'easy' });
  renderer.setGame(game);
  gameSerial++;
  acc = 0;
  steering.clear();
  keys.clear();
  pressed.clear();
  updateFacing(true);
  paused = false;
  if (start) {
    phase = 'countdown';
    countdown = 3;
    lastCount = 0;
  } else {
    phase = 'menu';
  }
}

// ---------------------------------------------------------------------------
// Input: drag sideways anywhere to steer; two fire buttons in the corners.

/** @type {Map<number, {x0: number, cur: number, flip: boolean}>} pointers steering, with where each started and how far it has dragged */
const steering = new Map();
/** @type {Map<number, number>} pointers holding a fire button → button index */
const pressed = new Map();
/** @type {Set<string>} */
const keys = new Set();
let keyFlip = false;
let lastRudder = 0;

/** @param {boolean} [force] */
function updateFacing(force = false) {
  const s = isin(game.ships[YOU].heading);
  if (force) leftIsStarboard = s > 0;
  else if (s > SWAP) leftIsStarboard = true;
  else if (s < -SWAP) leftIsStarboard = false;
}

/** Battery fired by screen button 0 (left) or 1 (right). @param {number} button */
const batteryFor = (button) => ((button === 0) === leftIsStarboard ? STARBOARD : PORT);

/** @param {number} button */
function fire(button) {
  if (phase !== 'play' || paused) return;
  applyInput(game, YOU, { type: 'fire', battery: batteryFor(button) });
}

/** The rudder the fingers (or keys) ask for, −1 … 1. Drag the way you want the bow to swing. */
function wantedRudder() {
  for (const [, s] of steering) {
    const d = s.cur / FULL_LOCK_PX;
    return Math.max(-1, Math.min(1, s.flip ? -d : d));
  }
  const k = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  return keyFlip ? -k : k;
}

function syncRudder() {
  const r = Math.round(wantedRudder() * 100);
  if (r !== lastRudder && phase === 'play' && !paused) {
    lastRudder = r;
    applyInput(game, YOU, { type: 'rudder', value: r });
  }
}

/** @param {PointerEvent} e */
function buttonAt(e) {
  const spots = renderer.buttonSpots();
  for (let i = 0; i < spots.length; i++) {
    const b = spots[i];
    if (Math.hypot(e.clientX - b.x, e.clientY - b.y) < b.r * 1.25) return i;
  }
  return -1;
}

canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (paused) { resume(); return; }
  if (phase === 'over') {
    if (performance.now() - overAt > 900) newGame();
    return;
  }
  if (phase === 'menu') return;
  const b = buttonAt(e);
  if (b >= 0) {
    pressed.set(e.pointerId, b);
    fire(b);
    return;
  }
  if (steering.size === 0) {
    canvas.setPointerCapture?.(e.pointerId);
    steering.set(e.pointerId, { x0: e.clientX, cur: 0, flip: leftIsStarboard });
  }
});
canvas.addEventListener('pointermove', (e) => {
  const s = steering.get(e.pointerId);
  if (s) s.cur = e.clientX - s.x0;
});
const lift = (/** @type {PointerEvent} */ e) => { steering.delete(e.pointerId); pressed.delete(e.pointerId); };
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);

const KEYMAP = /** @type {Record<string, string>} */ ({
  ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right',
});
window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const k = KEYMAP[e.key];
  if (k) {
    if (!keys.has('left') && !keys.has('right')) keyFlip = leftIsStarboard;
    keys.add(k);
    e.preventDefault();
  } else if (!e.repeat && (e.key === 'z' || e.key === 'Z' || e.key === 'q' || e.key === 'Q')) fire(0);
  else if (!e.repeat && (e.key === 'x' || e.key === 'X' || e.key === 'e' || e.key === 'E')) fire(1);
  else if (e.key === ' ' && phase === 'over' && performance.now() - overAt > 900) newGame();
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.key]; if (k) keys.delete(k); });

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
    syncRudder();
    acc += dt * 1000;
    let steps = 0;
    while (acc >= tickMs && steps++ < 4) {
      acc -= tickMs;
      tick();
      if (phase !== 'play') break;
    }
    if (acc > tickMs) acc = tickMs;
  }
  updateFacing();
  const me = game.ships[YOU];
  const reload = Math.round(game.params.reload * game.params.tickRate);
  const spots = renderer.buttonSpots();
  const held = new Set(pressed.values());
  const buttons = spots.map((s, i) => {
    const bat = me.batteries[batteryFor(i)];
    return { ...s, battery: batteryFor(i), reload: 1 - bat.reloadLeft / reload, firing: bat.firing > 0, pressed: held.has(i), label: i === 0 ? 'left' : 'right' };
  });
  const r = wantedRudder();
  renderer.draw(phase === 'play' && !paused ? acc / tickMs : 1, paused ? 0 : dt, {
    you: YOU,
    buttons: phase === 'menu' ? [] : buttons,
    rudder: steering.size && phase === 'play' ? r : null,
    overlay: overlay(),
    timeScale: game.params.timeScale,
  });
  requestAnimationFrame(frame);
}

function tick() {
  if (ai) for (const input of ai.think(game)) applyInput(game, ai.ship, input);
  const ev = step(game);
  renderer.onTick(ev);
  const firedBy = new Set(ev.fired.map((f) => f.ship));
  for (const s of firedBy) audio.boom(s === YOU);
  if (ev.hits.length) {
    audio.hit();
    if (ev.hits.some((h) => h.ship === YOU)) { try { navigator.vibrate?.(25); } catch { /* not supported */ } }
  }
  if (ev.splashes.length && game.tick % 3 === 0) audio.splash();
  if (ev.bumps.length && game.tick % 15 === 0) audio.bump();
  if (game.winner >= 0) {
    phase = 'over';
    overAt = performance.now();
    audio.end(game.winner === game.ships[YOU].side);
  }
}

function overlay() {
  if (phase === 'countdown' && !paused) {
    return { lines: [String(Math.ceil(countdown))], sub: 'you are blue · drag to steer, corners to fire' };
  }
  if (paused) return { lines: ['PAUSED'], sub: 'tap to resume' };
  if (phase === 'over') {
    const w = game.winner;
    const lines = w === DRAW ? ['BOTH', 'STRUCK'] : w === game.ships[YOU].side ? ['SHE', 'STRIKES!'] : ['YOU', 'STRUCK'];
    return {
      lines,
      color: w === DRAW ? COLORS.text : COLORS.players[w],
      sub: `${Math.round(game.tick / game.params.tickRate)}s · tap to sail again`,
      stats: statRows(),
    };
  }
  return null;
}

function statRows() {
  const st = game.stats;
  const acc = (/** @type {number} */ s) => (st.fired[s] ? `${Math.round((100 * st.hits[s]) / st.fired[s])}%` : '–');
  return {
    names: ['You', 'CPU'],
    rows: /** @type {[string, string|number, string|number][]} */ ([
      ['Crew left', game.ships[BLUE].crew, game.ships[RED].crew],
      ['Balls fired', st.fired[BLUE], st.fired[RED]],
      ['Hits', st.hits[BLUE], st.hits[RED]],
      ['Accuracy', acc(BLUE), acc(RED)],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Settings

const dialog = /** @type {HTMLDialogElement} */ ($('settings'));
const form = /** @type {HTMLFormElement} */ ($('settings-form'));
function openSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const el = /** @type {RadioNodeList|null} */ (form.elements.namedItem(k));
    if (el) el.value = v;
  }
  dialog.showModal();
}
form.addEventListener('submit', (e) => {
  const submitter = /** @type {HTMLButtonElement|null} */ (/** @type {SubmitEvent} */ (e).submitter);
  if (submitter?.value === 'reset') settings = { ...defaultSettings };
  else if (submitter?.value === 'apply') settings = sanitize(Object.fromEntries(new FormData(form)));
  else return;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  newGame();
});

window.addEventListener('resize', () => {
  if (!renderer) return;
  if (phase === 'menu') { newGame(false); return; } // nothing started: shape the sea to the new screen
  renderer.layout(); // a game in progress keeps its sea and is fitted to the screen
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (phase === 'play' || phase === 'countdown')) paused = true;
});

// ---------------------------------------------------------------------------
// Start menu, pause menu (☰) and the how-to-play card. Settings and Rules
// return to whichever menu opened them unless a new game started.

const startDialog = /** @type {HTMLDialogElement} */ ($('start'));
const pauseDialog = /** @type {HTMLDialogElement} */ ($('pause'));
const rulesDialog = /** @type {HTMLDialogElement} */ ($('rules'));
/** @type {HTMLDialogElement|null} */ let returnTo = null;
let openedAtGame = 0;

function detour(/** @type {HTMLDialogElement} */ from, /** @type {() => void} */ open) {
  audio.unlock();
  returnTo = from;
  openedAtGame = gameSerial;
  from.close();
  open();
}
for (const d of [dialog, rulesDialog]) {
  d.addEventListener('close', () => {
    const back = returnTo;
    returnTo = null;
    if (back && gameSerial === openedAtGame && !back.open) back.showModal();
  });
}

$('start-new').addEventListener('click', () => { audio.unlock(); startDialog.close(); newGame(); });
$('start-settings').addEventListener('click', () => detour(startDialog, openSettings));
$('start-rules').addEventListener('click', () => detour(startDialog, () => rulesDialog.showModal()));
startDialog.addEventListener('cancel', (e) => { e.preventDefault(); $('start-new').click(); });

const muteBtn = $('pause-sound');
const syncMute = () => { muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on'; };
syncMute();

$('btn-menu').addEventListener('click', () => {
  audio.unlock();
  if (phase === 'countdown' || phase === 'play') paused = true;
  $('pause-resume').hidden = phase === 'over' || phase === 'menu';
  syncMute();
  pauseDialog.showModal();
});
function resume() {
  pauseDialog.close();
  paused = false;
  last = performance.now();
}
$('pause-resume').addEventListener('click', resume);
pauseDialog.addEventListener('cancel', (e) => { e.preventDefault(); resume(); });
$('pause-new').addEventListener('click', () => { pauseDialog.close(); newGame(); });
$('pause-settings').addEventListener('click', () => detour(pauseDialog, openSettings));
$('pause-rules').addEventListener('click', () => detour(pauseDialog, () => rulesDialog.showModal()));
muteBtn.addEventListener('click', () => { audio.setMuted(!audio.muted); syncMute(); });

if (debug) {
  /** @type {any} */ (window).woodenShipsDebug = () => ({
    phase, tick: game.tick, winner: game.winner, paused, leftIsStarboard,
    wind: { ...game.wind },
    ships: game.ships.map((s) => ({ x: s.x, y: s.y, heading: s.heading, rudder: s.rudder, crew: s.crew, struck: s.struck, reload: s.batteries.map((b) => b.reloadLeft) })),
    fired: [...game.stats.fired], sea: [game.seaW, game.seaH],
  });
}

// ---------------------------------------------------------------------------

loadAssets(new URL('../assets/', import.meta.url).href).then((assets) => {
  renderer = createRenderer(canvas, assets);
  newGame(false);
  startDialog.showModal();
  requestAnimationFrame(frame);
}).catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<p style="padding:24px">Couldn't load the game's pictures (${String(err.message)}). Try reloading.</p>`);
});
