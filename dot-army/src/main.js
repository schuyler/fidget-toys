// Wires the simulation, renderer, input, AI and sound together.

import { createGame, applyInput, applyInputTo, step, stateHash } from './sim.js';
import { createAI } from './ai.js';
import { createRenderer, COLORS } from './render.js';
import { createAudio } from './audio.js';
import { cellCenter, pixelToCell } from './hex.js';
import { createLockstep } from './lockstep.js';
import { broadcastTransport, PROTOCOL } from './net.js';
import { relayTransport, DEFAULT_RELAY, SEAT_TAKEN } from '../../multiplayer/relay.js';
import { createLobby, roomCode, cleanCode } from '../../multiplayer/lobby.js';
import { createNetPanel } from '../../multiplayer/netpanel.js';

// The settings players see: six simple choices, each a preset. Everything
// else (meters, regen, spawn interval, facing arc) stays at the sim defaults.
const CHOICES = {
  mode: ['cpu-easy', 'cpu'],
  /** cells across the screen's short side; the long side fills the screen */
  size: { small: 24, medium: 34, large: 46 },
  /** ticks per second */
  speed: { slow: 5, average: 8, fast: 12 },
  /** neutral spawn points, and the sim's extraSpawnRate that keeps anti-snowball working at that count */
  spawns: { few: { neutral: 4, extra: 50 }, some: { neutral: 6, extra: 65 }, many: { neutral: 10, extra: 80 } },
  /** most targets a player may have */
  targets: { '1': 1, '2': 2, '3': 3 },
  /** rock layout */
  obstacles: { none: 'open', some: 'rocks', many: 'dense' },
};
const SQRT3 = Math.sqrt(3);

// v2: only the six simple choices are stored, so values from the old
// advanced fields can't linger invisibly.
const SETTINGS_KEY = 'dot-army-settings-v2';
const defaultSettings = { mode: 'cpu-easy', size: 'medium', speed: 'average', spawns: 'some', targets: '3', obstacles: 'none' };
/** @param {any} raw */
function sanitize(raw) {
  const out = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;
  if (CHOICES.mode.includes(raw.mode)) out.mode = raw.mode;
  for (const k of /** @type {const} */ (['size', 'speed', 'spawns', 'targets', 'obstacles'])) {
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
 *   gameNo: number, waitingSince: number, joinedAt: number,
 *   status: 'lobby'|'playing'|'version'|'desync'|'left'|'full'|'unreachable'|'lost',
 * }}
 */
let net = null;
/** The one player on this screen: blue locally, or this device's seat online. */
const me = () => (net ? net.local : 0);
/**
 * The local player's targets as this device has issued them: created from the
 * game's list when it starts, changed only by issue(), never re-read from the
 * game (online, the game lags what was issued by a few ticks).
 * @type {number[]}
 */
let mine = [];

/**
 * Presses being tracked, by pointerId. index: the local target it holds (-1 if
 * gated); x0, y0: where it began (client CSS px); gated: it began while
 * gestures were off, so it does nothing; pending: set while a press near a
 * marker isn't yet a tap or a drag, null once the target follows the pointer.
 * @type {Map<number, { index: number, x0: number, y0: number, gated: boolean, pending: null | { onMarker: boolean } }>}
 */
const drags = new Map();
/** @type {{x: number, y: number}[]} smoothed on-screen positions (board px) of the local player's markers, index-aligned with `mine`. The opponent's are never drawn. */
let markersPx = [];

/**
 * @param {boolean} [start] false: set up the board but wait at the start menu
 * @param {{ seed: number, width: number, height: number, tickRate: number, neutralSpawns: number, extraSpawnRate: number, maxTargets: number, terrain: string }} [fixed]
 *   a network guest plays exactly the host's game
 */
function newGame(start = true, fixed) {
  gameSerial++;
  const short = CHOICES.size[/** @type {keyof typeof CHOICES.size} */ (settings.size)];
  const portrait = screenPortrait();
  gamePortrait = portrait;
  // Match the board's aspect ratio to the space it will be drawn in (hex rows
  // are 1.5 radii tall, columns sqrt(3) wide).
  const { w: availW, h: availH } = renderer.area();
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
    neutralSpawns: CHOICES.spawns[/** @type {keyof typeof CHOICES.spawns} */ (settings.spawns)].neutral,
    extraSpawnRate: CHOICES.spawns[/** @type {keyof typeof CHOICES.spawns} */ (settings.spawns)].extra,
    maxTargets: CHOICES.targets[/** @type {keyof typeof CHOICES.targets} */ (settings.targets)],
    terrain: CHOICES.obstacles[/** @type {keyof typeof CHOICES.obstacles} */ (settings.obstacles)],
    seed: (Math.random() * 2 ** 31) >>> 0,
  });
  mine = [...game.targets[me()]];
  renderer.setView({ flip: !!net && net.local === 1, local: me() });
  ais = [null, net ? null
    : createAI(1, game.params.seed, settings.mode === 'cpu-easy'
      ? { thinkEvery: 16, caution: 8, noise: 14, dragSpeed: 1.1 }
      : { dragSpeed: 2.2 })];
  renderer.setGame(game);
  drags.clear();
  rebuildMarkers();
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

/** Every local marker at its target's cell. */
function rebuildMarkers() {
  markersPx = mine.map(cellPx);
}

// ---------------------------------------------------------------------------
// Input: the whole screen is yours. Tap empty board to add a target (at the
// cap: move the nearest one there), tap a target to remove it, drag to move it.

/** A press this close (board px) to a marker grabs it for dragging. */
const grab = () => Math.max(40, renderer.size * 3.5);
/** A press this close to a marker is on it: a tap there removes it. */
const hit = () => Math.max(14, renderer.size * 2);
/** A press that moves farther than this (client CSS px) is a drag, not a tap. */
const TAP_SLOP = 10;

/** The WAITING overlay is showing: the other device has stalled for more than 600 ms. */
const waitingShown = () => !!net && phase === 'play' && !!net.waitingSince && performance.now() - net.waitingSince > 600;
/** Gestures may change targets only during a game, online only once lockstep is up and while not stalled. */
const actionsOn = () => (phase === 'countdown' || phase === 'play') && (!net || (!!net.ls && !waitingShown()));

/**
 * Validate an input against the local model, then apply it: straight to the
 * game offline, through lockstep online. Keeps the marker list in step.
 * @param {import('./sim.js').Input} input
 */
function issue(input) {
  if (net && !net.ls) return false;
  if (!applyInputTo(mine, input, game.params.maxTargets, game.grid.N)) return false;
  if (net) net.ls.queue(input); else applyInput(game, me(), input);
  if (input.op === 'add') markersPx.push(cellPx(input.cell));
  else if (input.op === 'remove') markersPx.splice(input.index, 1);
  return true;
}

/** Board position of a pointer event, clamped to the board. */
function boardPoint(/** @type {PointerEvent} */ e) {
  const { w, h } = renderer.board;
  const b = renderer.toBoard(e.clientX, e.clientY);
  return { x: Math.max(0, Math.min(w, b.x)), y: Math.max(0, Math.min(h, b.y)) };
}

/** Local target indices held by pointers other than `except`. */
function heldBy(/** @type {number} */ except) {
  const held = new Set();
  for (const [id, d] of drags) if (id !== except) held.add(d.index);
  return held;
}

/** The unheld local target nearest (board px) to b, within `within`: its index, or -1. */
function nearestFree(/** @type {{x: number, y: number}} */ b, /** @type {Set<number>} */ held, within = Infinity) {
  let best = -1, bestD = within;
  markersPx.forEach((m, i) => {
    const d = Math.hypot(m.x - b.x, m.y - b.y);
    if (!held.has(i) && d <= bestD) { best = i; bestD = d; }
  });
  return best;
}

/** A tap on empty board: add a target there, or at the cap move the nearest free one. Returns the target's index, or -1. */
function tapEmpty(/** @type {{x: number, y: number}} */ b, /** @type {number} */ pointerId) {
  const cell = pixelToCell(game.grid, b.x, b.y, renderer.size);
  if (mine.length < game.params.maxTargets) return issue({ op: 'add', cell }) ? mine.length - 1 : -1;
  const index = nearestFree(b, heldBy(pointerId));
  return index >= 0 && issue({ op: 'move', index, cell }) ? index : -1;
}

canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  e.preventDefault();
  if (phase === 'over') {
    if (performance.now() - overAt < 900) return;
    if (!net) newGame();
    else if (NET_ERRORS[net.status]) leaveToMenu();
    else if (net.role === 'host' && net.status === 'playing') hostStart(); // rematch
    return;
  }
  if (paused) {
    if (!rotated()) paused = false; // can't resume until the phone is turned back
    return;
  }
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or stale pointer */ }
  const drag = { index: -1, x0: e.clientX, y0: e.clientY, gated: !actionsOn(), pending: /** @type {null | { onMarker: boolean }} */ (null) };
  drags.set(e.pointerId, drag);
  if (drag.gated) return;
  const b = boardPoint(e);
  const held = heldBy(e.pointerId);
  const near = nearestFree(b, held, grab());
  if (near >= 0) {
    const m = markersPx[near];
    const d = Math.hypot(m.x - b.x, m.y - b.y);
    // a tap on a held marker never removes a neighbour
    let heldD = Infinity;
    for (const i of held) if (i >= 0) heldD = Math.min(heldD, Math.hypot(markersPx[i].x - b.x, markersPx[i].y - b.y));
    drag.index = near;
    drag.pending = { onMarker: d <= hit() && !(heldD < d) };
    return;
  }
  drag.index = tapEmpty(b, e.pointerId);
  if (drag.index < 0) drags.delete(e.pointerId); // nothing to hold: ignore the press
  else markersPx[drag.index] = b;
});

canvas.addEventListener('pointermove', (e) => {
  const drag = drags.get(e.pointerId);
  if (!drag || drag.gated || !actionsOn()) return;
  if (drag.pending && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > TAP_SLOP) drag.pending = null;
  if (drag.pending) return;
  const b = boardPoint(e);
  markersPx[drag.index] = b;
  issue({ op: 'move', index: drag.index, cell: pixelToCell(game.grid, b.x, b.y, renderer.size) });
});

canvas.addEventListener('pointerup', (e) => {
  const drag = drags.get(e.pointerId);
  if (drag && drag.pending && !drag.gated && actionsOn()) {
    const b = boardPoint(e);
    if (!drag.pending.onMarker) {
      tapEmpty(b, e.pointerId);
    } else if (issue({ op: 'remove', index: drag.index })) {
      for (const other of drags.values()) if (other.index > drag.index) other.index--;
    } else if (game.params.maxTargets === 1) {
      tapEmpty(b, e.pointerId); // a tap on the only marker jumps it
    }
  }
  drags.delete(e.pointerId);
});
canvas.addEventListener('pointercancel', (e) => drags.delete(e.pointerId));

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

  // markers glide to their cell, except those a finger is moving
  const followed = new Set();
  for (const d of drags.values()) if (!d.gated && !d.pending) followed.add(d.index);
  const k = 1 - Math.exp(-dt * 14);
  const markers = markersPx.map((m, i) => {
    const dragging = followed.has(i);
    if (!dragging) {
      const goal = cellPx(mine[i]);
      m = markersPx[i] = { x: m.x + (goal.x - m.x) * k, y: m.y + (goal.y - m.y) * k };
    }
    return { x: m.x, y: m.y, player: me(), dragging };
  });

  renderer.draw(phase === 'play' ? acc / tickMs : 1, paused ? 0 : dt, {
    markers,
    overlay: overlay(),
    hints: now < hintsUntil,
  });
  requestAnimationFrame(frame);
}

function tick() {
  for (const ai of ais) {
    if (!ai) continue;
    for (const input of ai.think(game)) applyInput(game, ai.player, input);
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
    const err = NET_ERRORS[net.status];
    if (err) return { lines: err, sub: 'tap for the menu' };
    if (net.status === 'lobby') {
      return net.role === 'host'
        ? { lines: [net.room], sub: 'waiting for the other player to join…' }
        : performance.now() - net.joinedAt > NO_HOST_MS
          ? { lines: ['NO ONE', 'HERE YET'], sub: `room ${net.room} has no host · check the code, or ☰ to leave` }
          : { lines: ['JOINING'], sub: `room ${net.room} · waiting for the host…` };
    }
    if (waitingShown()) {
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
  rebuildMarkers();
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
  $('pause-leave').hidden = !net;
  syncMute();
  pauseDialog.showModal();
});
function resume() {
  pauseDialog.close();
  if (!rotated()) paused = false;
}
$('pause-resume').addEventListener('click', resume);
pauseDialog.addEventListener('cancel', (e) => { e.preventDefault(); resume(); });
$('pause-leave').addEventListener('click', () => leaveToMenu());
$('pause-new').addEventListener('click', () => { pauseDialog.close(); newGame(); });
$('pause-settings').addEventListener('click', () => detour(pauseDialog, openSettings));
$('pause-rules').addEventListener('click', () => detour(pauseDialog, () => rulesDialog.showModal()));
muteBtn.addEventListener('click', () => { audio.setMuted(!audio.muted); syncMute(); });

// ---------------------------------------------------------------------------
// Network play: the host (blue) picks the board and settings and sends them
// to the guest (red); after that only lockstep inputs and hashes flow.

/** How long a guest waits on JOINING before being told no one is hosting. */
const NO_HOST_MS = 5000;

/** Statuses that end a network session, and what they say. */
const NET_ERRORS = /** @type {Record<string, string[] | undefined>} */ ({
  left: ['OPPONENT LEFT'],
  full: ['ROOM FULL'],
  unreachable: ["CAN'T REACH", 'THE SERVER'],
  lost: ['CONNECTION LOST'],
});

// ?relay=bc: two tabs in one browser, no server. ?relay=wss://...: that relay. Neither: the default.
const relayParam = query.get('relay');

/** The link that brings the other player into this room as guest. */
function linkFor(/** @type {string} */ code) {
  const relay = relayParam ? `&relay=${encodeURIComponent(relayParam)}` : '';
  return `${location.origin}${location.pathname}?room=${code}${relay}`;
}

/** @param {string} room @param {'host'|'guest'} role */
function startNet(room, role) {
  const seat = role === 'host' ? 0 : 1;
  const transport = relayParam === 'bc'
    ? broadcastTransport(room, role)
    : relayTransport(relayParam || DEFAULT_RELAY, 'dot-army', room, seat, { ping: debug });
  const session = { role, local: seat, room, transport, ls: null, gameNo: 0, waitingSince: 0, joinedAt: performance.now(), status: 'lobby' };
  net = session;
  transport.onMessage(onNetMessage);
  transport.onEvent(onNetEvent);
  newGame(false); // a board to look at while waiting; replaced when the game starts
  if (role === 'guest') {
    const hello = () => {
      if (net !== session || session.status !== 'lobby') return;
      session.transport.send({ k: 'hello', v: PROTOCOL });
      setTimeout(hello, 500); // until the host answers
    };
    hello();
  }
}

/** @param {import('../../multiplayer/relay.js').RelayEvent} e */
function onNetEvent(e) {
  if (!net) return;
  const s = net.status;
  if (s === 'version' || s === 'desync' || NET_ERRORS[s]) return; // the first problem is the one shown
  let status;
  if (e.type === 'peer-left') {
    // A guest leaving before the game starts just leaves the host waiting.
    if (s === 'playing' || net.role === 'guest') status = 'left';
  } else {
    status = e.code === SEAT_TAKEN ? 'full' : !e.opened ? 'unreachable' : 'lost';
  }
  if (!status) return;
  net.status = status;
  if (status === 'left') net.transport.close(); // free the seat: the game is over
  phase = 'over';
  overAt = performance.now();
  lobby.close();
}

/** End any network session and go back to the start menu. */
function leaveToMenu() {
  if (net) net.transport.close();
  net = null;
  lobby.close();
  if (pauseDialog.open) pauseDialog.close();
  newGame(false);
  if (!startDialog.open) startDialog.showModal();
}

const lobby = createLobby(/** @type {HTMLDialogElement} */ ($('lobby')), {
  onJoin(code) {
    lobby.close();
    startNet(code, 'guest');
  },
  onBack: leaveToMenu,
});

$('start-online').addEventListener('click', () => {
  audio.unlock();
  startDialog.close();
  const code = roomCode();
  startNet(code, 'host');
  lobby.openHosting(code, linkFor(code));
});
$('start-join').addEventListener('click', () => {
  audio.unlock();
  startDialog.close();
  lobby.openJoin();
});

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
    const { seed, width, height, tickRate, neutralSpawns, extraSpawnRate, maxTargets, terrain } = msg;
    newGame(true, { seed, width, height, tickRate, neutralSpawns, extraSpawnRate, maxTargets, terrain });
    attachLockstep();
  } else if ((msg.k === 'in' || msg.k === 'h') && msg.g === net.gameNo && net.ls) {
    net.ls.receive(msg);
  }
}

/** Host: deal a fresh game (also used for rematches) and tell the guest. */
function hostStart() {
  if (!net) return;
  lobby.close();
  net.gameNo++;
  newGame(true); // the host's settings and screen pick the board
  const p = game.params;
  net.transport.send({
    k: 'start', g: net.gameNo, v: PROTOCOL,
    seed: p.seed, width: p.width, height: p.height, tickRate: p.tickRate, neutralSpawns: p.neutralSpawns,
    extraSpawnRate: p.extraSpawnRate, maxTargets: p.maxTargets, terrain: p.terrain,
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

// ?room=ABCD joins a game as guest straight away (that's what shared links
// are); &host makes this device the host instead.
const room = query.get('room');
if (room) {
  startNet(cleanCode(room), query.has('host') ? 'host' : 'guest');
} else {
  newGame(false);
  startDialog.showModal();
}
// ?debug shows the network panel and exposes a state fingerprint for automated tests.
if (debug) {
  createNetPanel(() => net?.transport.stats() ?? null);
  /** @type {any} */ (window).dotArmyDebug = () => ({
    tick: game.tick, hash: stateHash(game), status: net?.status, desync: net?.ls?.desyncAt ?? -1,
    winner: game.winner, targets: game.targets.map((t) => [...t]), net: net?.transport.stats() ?? null,
    overlay: (() => { const o = overlay(); return o ? { lines: o.lines, sub: o.sub } : null; })(),
    board: renderer.board,
  });
}
requestAnimationFrame(frame);
