// Wires the simulation, renderer, input, AI and sound together.

import { createGame, setTarget, step, stateHash } from './sim.js';
import { createAI } from './ai.js';
import { createRenderer, COLORS } from './render.js';
import { createAudio } from './audio.js';
import { cellCenter, pixelToCell } from './hex.js';
import { createLockstep } from './lockstep.js';
import { broadcastTransport, PROTOCOL } from './net.js';
import { relayTransport } from '../../multiplayer/relay.js';

// The settings players see: five simple choices, each a preset. Everything
// else (meters, regen, spawn interval, facing arc) stays at the sim defaults.
const CHOICES = {
  mode: ['cpu-easy', 'cpu'],
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
const defaultSettings = { mode: 'cpu-easy', size: 'medium', speed: 'average', spawns: 'some', obstacles: 'none' };
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
let phase = 'menu'; // 'menu' | 'countdown' | 'play' | 'over'
let countdown = 0;
let paused = false;
let acc = 0;
let overAt = 0;
let lastCount = 0;
let hintsUntil = 0;
let gamePortrait = false;
let gameSerial = 0;
const screenPortrait = () => window.innerHeight > window.innerWidth;
/** The phone was turned since this game's board was laid out. */
const rotated = () => !net && screenPortrait() !== gamePortrait;

/**
 * Network game state, or null for local play.
 * @type {null | {
 *   role: 'host'|'guest', local: number, room: string,
 *   transport: import('./net.js').Transport,
 *   ls: ReturnType<typeof createLockstep> | null,
 *   gameNo: number, waitingSince: number, status: string,
 * }}
 */
let net = null;
/** The one player on this screen: blue locally, or this device's seat online. */
const me = () => (net ? net.local : 0);
/** In a network game, the cell the local player last aimed at (applied a few ticks later). */
let localAim = -1;

/** pointerId → player being dragged */
const drags = new Map();
/** @type {{x: number, y: number}[]} smoothed on-screen target positions (board px) */
let targetsPx = [{ x: 0, y: 0 }, { x: 0, y: 0 }];

/**
 * @param {boolean} [start] false: set up the board but wait at the start menu
 * @param {{ seed: number, width: number, height: number, tickRate: number, neutralSpawns: number, terrain: string }} [fixed]
 *   a network guest plays exactly the host's game
 */
function newGame(start = true, fixed) {
  gameSerial++;
  const short = CHOICES.size[/** @type {keyof typeof CHOICES.size} */ (settings.size)];
  const portrait = screenPortrait();
  gamePortrait = portrait;
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
  game = createGame(fixed ?? {
    width,
    height,
    tickRate: CHOICES.speed[/** @type {keyof typeof CHOICES.speed} */ (settings.speed)],
    neutralSpawns: CHOICES.spawns[/** @type {keyof typeof CHOICES.spawns} */ (settings.spawns)],
    terrain: CHOICES.obstacles[/** @type {keyof typeof CHOICES.obstacles} */ (settings.obstacles)],
    seed: (Math.random() * 2 ** 31) >>> 0,
  });
  localAim = -1;
  renderer.setView({ flip: !!net && net.local === 1, local: me() });
  ais = [null, net ? null
    : createAI(1, game.params.seed, settings.mode === 'cpu-easy'
      ? { thinkEvery: 16, caution: 8, noise: 14, dragSpeed: 1.1 }
      : { dragSpeed: 2.2 })];
  renderer.setGame(game);
  drags.clear();
  targetsPx = [0, 1].map((p) => cellPx(game.targets[p]));
  phase = start ? 'countdown' : 'menu';
  countdown = 3.2;
  lastCount = 4;
  paused = false;
  acc = 0;
  hintsUntil = start ? performance.now() + 7000 : 0;
}

function cellPx(/** @type {number} */ cell) {
  const [x, y] = cellCenter(game.grid, cell, renderer.size);
  return { x, y };
}

// ---------------------------------------------------------------------------
// Input: the whole screen is yours. A press anywhere moves your marker there,
// and dragging keeps it under your finger.

function humanPlayers() {
  return [me() === 0, me() === 1];
}

canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  e.preventDefault();
  if (phase === 'over') {
    if (performance.now() - overAt < 900) return;
    if (!net) newGame();
    else if (net.role === 'host' && net.status === 'playing') hostStart(); // rematch
    return;
  }
  if (paused) {
    if (!rotated()) paused = false; // can't resume until the phone is turned back
    return;
  }
  const player = me();
  if ([...drags.values()].includes(player)) return; // another finger already has it
  const b = renderer.toBoard(e.clientX, e.clientY);
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
  const cell = pixelToCell(game.grid, x, y, renderer.size);
  if (net && net.ls && player === net.local) {
    net.ls.setLocal(cell); // takes effect a few ticks from now, on both devices
    localAim = cell;
  } else if (!net) {
    setTarget(game, player, cell);
  }
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
    if (net && net.ls) net.ls.pump();
    while (acc >= tickMs && steps++ < 4) {
      if (net && net.ls && !net.ls.ready()) break; // waiting on the other device's input
      acc -= tickMs;
      tick();
      if (phase !== 'play') break;
    }
    if (acc > tickMs) acc = tickMs; // don't spiral after a stall
    if (net) {
      const stalled = acc >= tickMs && !!net.ls && !net.ls.ready();
      net.waitingSince = stalled ? net.waitingSince || now : 0;
    }
  }

  // markers glide to their cell when not being dragged
  const dragging = [false, false];
  for (const p of drags.values()) dragging[p] = true;
  for (let p = 0; p < 2; p++) {
    if (dragging[p]) continue;
    const goal = cellPx(net && p === net.local && localAim >= 0 ? localAim : game.targets[p]);
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
  const ev = net && net.ls ? net.ls.advance() : step(game);
  renderer.onTick(ev);
  if (ev.kills.length) audio.kills(ev.kills.length);
  if (ev.hits.length && game.tick % 2 === 0) audio.hit(ev.hits[0].player);
  for (const c of ev.captures) {
    audio.capture(c.to);
    try { navigator.vibrate?.(30); } catch { /* not supported */ }
  }
  if (net && net.ls && net.ls.desyncAt >= 0) {
    phase = 'over';
    net.status = 'desync';
    return;
  }
  if (game.winner >= 0) {
    phase = 'over';
    overAt = performance.now();
    audio.win(game.winner);
  }
}

function overlay() {
  if (net) {
    if (net.status === 'version') return { lines: ['UPDATE NEEDED'], sub: 'the two devices are running different versions · reload both' };
    if (net.status === 'desync') return { lines: ['OUT OF SYNC'], sub: `the two devices disagree at tick ${net.ls?.desyncAt} · please report this` };
    if (net.status === 'lobby') {
      return net.role === 'host'
        ? { lines: [net.room], sub: 'waiting for the other player to join…' }
        : { lines: ['JOINING'], sub: `room ${net.room} · waiting for the host…` };
    }
    if (phase === 'play' && net.waitingSince && performance.now() - net.waitingSince > 600) {
      return { lines: ['WAITING'], sub: 'for the other player…' };
    }
  }
  if (rotated() && phase !== 'menu' && phase !== 'over') {
    return { lines: ['ROTATE BACK'], sub: `this game is laid out for ${gamePortrait ? 'portrait' : 'landscape'} · ↻ starts a new one` };
  }
  if (phase === 'countdown' && !paused) {
    const c = Math.ceil(countdown);
    const who = me() ? 'you are red' : 'you are blue';
    return { lines: [String(c)], sub: who };
  }
  if (paused) return { lines: ['PAUSED'], sub: 'tap to resume' };
  if (phase === 'over') {
    const again = !net ? 'tap to play again' : net.role === 'host' ? 'tap for a rematch' : 'waiting for the host to start a rematch';
    return {
      lines: [game.winner === me() ? 'YOU WIN' : net ? 'YOU LOSE' : 'CPU WINS'],
      color: COLORS.players[game.winner],
      sub: `${Math.round(game.tick / game.params.tickRate)}s · ${again}`,
      stats: statRows(),
    };
  }
  return null;
}

/** End-of-game table: [label, blue, red]. */
function statRows() {
  const st = game.stats;
  const names = !net ? ['You', 'CPU'] : net.local === 0 ? ['You', 'Them'] : ['Them', 'You'];
  return {
    names,
    rows: /** @type {[string, number, number][]} */ ([
      ['Dots made', st.spawned[0], st.spawned[1]],
      ['Kills', st.kills[0], st.kills[1]],
      ['Lost in battle', st.lost[0], st.lost[1]],
      ['Thrown at spawns', st.spent[0], st.spent[1]],
      ['Spawns captured', st.captures[0], st.captures[1]],
      ['Biggest army', st.peak[0], st.peak[1]],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Settings

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const dialog = /** @type {HTMLDialogElement} */ ($('settings'));
const form = /** @type {HTMLFormElement} */ ($('settings-form'));
function openSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const el = /** @type {RadioNodeList|null} */ (form.elements.namedItem(k)); // radio group: setting .value checks the match
    if (el) el.value = v;
  }
  dialog.showModal();
}
form.addEventListener('submit', (e) => {
  const submitter = /** @type {HTMLButtonElement|null} */ (/** @type {SubmitEvent} */ (e).submitter);
  if (submitter?.value === 'reset') {
    settings = { ...defaultSettings };
  } else if (submitter?.value === 'apply') {
    settings = sanitize(Object.fromEntries(new FormData(form)));
  } else {
    return; // cancel: the close handler below goes back to whichever menu opened it
  }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  newGame();
});

window.addEventListener('resize', () => {
  if (phase === 'menu' && rotated()) {
    newGame(false); // nothing has started yet: rebuild the board for the new orientation
    return;
  }
  renderer.layout();
  targetsPx = [0, 1].map((p) => cellPx(game.targets[p]));
  if (rotated() && (phase === 'countdown' || phase === 'play')) paused = true;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase === 'play') paused = true;
});

// ---------------------------------------------------------------------------
// Start menu (every page load), pause menu (☰), and the how-to-play card.
// Settings and Rules can be opened from either menu; closing them without
// starting a new game returns to that menu.

const startDialog = /** @type {HTMLDialogElement} */ ($('start'));
const pauseDialog = /** @type {HTMLDialogElement} */ ($('pause'));
const rulesDialog = /** @type {HTMLDialogElement} */ ($('rules'));
/** @type {HTMLDialogElement|null} */ let returnTo = null;
let openedAtGame = 0;

/** Leave a menu for Settings or Rules, remembering where to come back to. */
function detour(/** @type {HTMLDialogElement} */ from, /** @type {() => void} */ open) {
  audio.unlock(); // any tap: browsers allow sound from here on
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

$('start-new').addEventListener('click', () => {
  audio.unlock();
  startDialog.close();
  newGame();
});
$('start-settings').addEventListener('click', () => detour(startDialog, openSettings));
$('start-rules').addEventListener('click', () => detour(startDialog, () => rulesDialog.showModal()));
// Escape on the start menu means "just play".
startDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  $('start-new').click();
});

const muteBtn = $('pause-sound');
const syncMute = () => { muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on'; };
syncMute();

$('btn-menu').addEventListener('click', () => {
  audio.unlock();
  if (phase === 'countdown' || phase === 'play') paused = true;
  $('pause-resume').hidden = phase === 'over';
  // In a network game the host's settings rule and rematches go through the host.
  $('pause-new').hidden = !!net;
  $('pause-settings').hidden = !!net;
  syncMute();
  pauseDialog.showModal();
});
function resume() {
  pauseDialog.close();
  if (!rotated()) paused = false;
}
$('pause-resume').addEventListener('click', resume);
pauseDialog.addEventListener('cancel', (e) => { e.preventDefault(); resume(); });
$('pause-new').addEventListener('click', () => { pauseDialog.close(); newGame(); });
$('pause-settings').addEventListener('click', () => detour(pauseDialog, openSettings));
$('pause-rules').addEventListener('click', () => detour(pauseDialog, () => rulesDialog.showModal()));
muteBtn.addEventListener('click', () => { audio.setMuted(!audio.muted); syncMute(); });

// ---------------------------------------------------------------------------
// Network play: the host (blue) picks the board and settings and sends them
// to the guest (red); after that only lockstep inputs and hashes flow.

/** @param {string} room @param {'host'|'guest'} role */
function startNet(room, role) {
  const relay = query.get('relay');
  const transport = relay
    ? relayTransport(relay, 'dot-army', room, role === 'host' ? 0 : 1)
    : broadcastTransport(room, role);
  net = { role, local: role === 'host' ? 0 : 1, room, transport, ls: null, gameNo: 0, waitingSince: 0, status: 'lobby' };
  transport.onMessage(onNetMessage);
  newGame(false); // a board to look at while waiting; replaced when the game starts
  if (role === 'guest') {
    const hello = () => {
      if (!net || net.status !== 'lobby') return;
      net.transport.send({ k: 'hello', v: PROTOCOL });
      setTimeout(hello, 500); // until the host answers
    };
    hello();
  }
}

/** @param {any} msg */
function onNetMessage(msg) {
  if (!net || !msg || typeof msg !== 'object') return;
  if (msg.k === 'hello' && net.role === 'host') {
    if (msg.v !== PROTOCOL) net.transport.send({ k: 'bye', why: 'version' });
    else if (net.status === 'lobby') hostStart();
  } else if (msg.k === 'bye' && msg.why === 'version') {
    net.status = 'version';
  } else if (msg.k === 'start' && net.role === 'guest') {
    if (msg.v !== PROTOCOL) { net.status = 'version'; return; }
    if (msg.g <= net.gameNo) return; // already playing that one
    net.gameNo = msg.g;
    const { seed, width, height, tickRate, neutralSpawns, terrain } = msg;
    newGame(true, { seed, width, height, tickRate, neutralSpawns, terrain });
    attachLockstep();
  } else if ((msg.k === 'in' || msg.k === 'h') && msg.g === net.gameNo && net.ls) {
    net.ls.receive(msg);
  }
}

/** Host: deal a fresh game (also used for rematches) and tell the guest. */
function hostStart() {
  if (!net) return;
  net.gameNo++;
  newGame(true); // the host's settings and screen pick the board
  const p = game.params;
  net.transport.send({
    k: 'start', g: net.gameNo, v: PROTOCOL,
    seed: p.seed, width: p.width, height: p.height, tickRate: p.tickRate, neutralSpawns: p.neutralSpawns, terrain: p.terrain,
  });
  attachLockstep();
}

function attachLockstep() {
  if (!net) return;
  const g = net.gameNo;
  const transport = net.transport;
  net.ls = createLockstep(game, net.local, (m) => transport.send({ ...m, g }));
  net.status = 'playing';
}

// ?room=ABCD&host joins a network game directly: through the room relay at
// ?relay=wss://..., or between tabs in one browser without it.
const query = new URLSearchParams(location.search);
const room = query.get('room');
if (room) {
  startNet(room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8), query.has('host') ? 'host' : 'guest');
} else {
  newGame(false);
  startDialog.showModal();
}
// ?debug exposes a state fingerprint (and both targets) for automated tests.
if (query.has('debug')) {
  /** @type {any} */ (window).dotArmyDebug = () => ({ tick: game.tick, hash: stateHash(game), status: net?.status, desync: net?.ls?.desyncAt ?? -1, winner: game.winner, targets: [...game.targets] });
}
requestAnimationFrame(frame);
