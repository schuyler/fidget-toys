// Wires the simulation, renderer, input, CPU and sound together.

import { createGame, applyInput, step, stateHash, isin, deg, PORT, STARBOARD, BLUE, RED, DRAW } from './sim.js';
import { createAI } from './ai.js';
import { createRenderer, loadAssets, COLORS } from './render.js';
import { createAudio } from './audio.js';
import { createLockstep, PROTOCOL } from './net.js';
import { broadcastTransport } from '../../multiplayer/broadcast.js';
import { relayTransport, DEFAULT_RELAY, SEAT_TAKEN } from '../../multiplayer/relay.js';
import { createLobby, roomCode, cleanCode } from '../../multiplayer/lobby.js';
import { createNetPanel } from '../../multiplayer/netpanel.js';

// The settings players see: six simple choices, each a preset. The tuning
// parameters stay at the sim's DEFAULTS.
const CHOICES = {
  mode: ['cpu-easy', 'cpu'],
  islands: { none: 'none', some: 'some', many: 'many' },
  wind: { steady: 'steady', shifty: 'shifty', gusty: 'gusty' },
  shadow: { off: false, on: true },
  crew: { '2': 2, '3': 3, '5': 5 },
  steer: { drag: 'drag', wheel: 'wheel' },
};
const SETTINGS_KEY = 'wooden-ships-settings-v1';
const defaultSettings = { mode: 'cpu-easy', islands: 'some', wind: 'shifty', shadow: 'on', crew: '3', steer: 'drag' };
/** @param {any} raw */
function sanitize(raw) {
  const out = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;
  if (CHOICES.mode.includes(raw.mode)) out.mode = raw.mode;
  for (const k of /** @type {const} */ (['islands', 'wind', 'shadow', 'crew', 'steer'])) {
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
/** ?debug: state hash after each of the last 300 ticks, so browser tests can compare two devices at the same tick. */
const hashAt = new Map();
/** Pixels of sideways drag for full rudder: about a thumb's width. */
const FULL_LOCK_PX = 48;
/** Wheel mode: how far the wheel turns, either way, for full rudder (a quarter turn). */
const WHEEL_LOCK = Math.PI / 2;
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

/**
 * Network game state, or null for play against the CPU.
 * @type {null | {
 *   role: 'host'|'guest', local: number, room: string,
 *   transport: import('../../multiplayer/relay.js').Transport,
 *   ls: ReturnType<typeof createLockstep> | null,
 *   gameNo: number, waitingSince: number, joinedAt: number,
 *   status: 'lobby'|'playing'|'version'|'desync'|'left'|'full'|'unreachable'|'lost',
 * }}
 */
let net = null;
/** Your ship: blue against the CPU, or this device's seat online (host blue, guest red). */
const you = () => (net ? net.local : BLUE);

/**
 * The game's settings, as createGame takes them. A network guest gets
 * exactly the host's, from the start message.
 * @typedef {{ seed: number, islands: string, wind: string, shadow: boolean, crewPerGun: number }} Deal
 */

/** @returns {Deal} */
function deal() {
  return {
    seed: query.has('seed') ? Number(query.get('seed')) : (Math.random() * 2 ** 31) >>> 0,
    islands: settings.islands,
    wind: settings.wind,
    shadow: CHOICES.shadow[/** @type {'on'|'off'} */ (settings.shadow)],
    crewPerGun: CHOICES.crew[/** @type {'2'|'3'|'5'} */ (settings.crew)],
  };
}

/**
 * @param {boolean} [start] false: set up the sea but wait at the start menu
 * @param {Deal} [fixed] a network guest plays exactly the host's game
 */
function newGame(start = true, fixed) {
  const d = fixed ?? deal();
  game = createGame({ ...d });
  hashAt.clear();
  if (net) net.ls = null; // the old game's lockstep is done; attachLockstep() makes the next
  ai = net ? null : createAI(RED, (d.seed * 7 + 3) >>> 0, { level: settings.mode === 'cpu' ? 'hard' : 'easy' });
  renderer.setSteering(/** @type {'drag'|'wheel'} */ (settings.steer));
  renderer.setGame(game);
  gameSerial++;
  acc = 0;
  steering.clear();
  wheelGrip = null;
  keys.clear();
  pressed.clear();
  lastRudder = 0;
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
// Input. Drag mode: drag sideways anywhere to steer. Wheel mode: drag round
// the wheel at the bottom. Either way the rudder centres when you let go, and
// two fire buttons sit along the bottom of the screen.

/** @type {Map<number, {x0: number, cur: number, flip: boolean}>} pointers steering, with where each started and how far it has dragged */
const steering = new Map();
/** @type {Map<number, number>} pointers holding a fire button → button index */
const pressed = new Map();
/**
 * Wheel mode: the pointer turning the wheel, the angle it was last seen at
 * round the wheel's hub, and how far it has turned the wheel (radians,
 * clockwise on screen positive, clamped to ±WHEEL_LOCK).
 * @type {{id: number, last: number, turn: number}|null}
 */
let wheelGrip = null;
/** @type {Set<string>} */
const keys = new Set();
let lastRudder = 0;

/** @param {boolean} [force] */
function updateFacing(force = false) {
  const s = isin(game.ships[you()].heading);
  if (force) leftIsStarboard = s > 0;
  else if (s > SWAP) leftIsStarboard = true;
  else if (s < -SWAP) leftIsStarboard = false;
}

/** Battery fired by screen button 0 (left) or 1 (right). @param {number} button */
const batteryFor = (button) => ((button === 0) === leftIsStarboard ? STARBOARD : PORT);

/** Steering and firing count only during play, online only once lockstep is up. */
const actionsOn = () => phase === 'play' && !paused && (!net || !!net.ls);

/**
 * Send one of your inputs: straight to the game against the CPU, through
 * lockstep online (where it takes effect a few ticks later on both devices).
 * @param {import('./sim.js').Input} input
 */
function issue(input) {
  if (net) net.ls?.queue(input);
  else applyInput(game, you(), input);
}

/** @param {number} button */
function fire(button) {
  if (!actionsOn()) return;
  issue({ type: 'fire', battery: batteryFor(button) });
}

/**
 * The rudder the fingers (or keys) ask for, −1 … 1, positive to starboard.
 * Starboard rudder turns the ship clockwise on screen whatever her heading,
 * so the wheel and the keys need no flip: clockwise (or →) is starboard.
 * Drag mode is screen-relative instead: drag the way you want the bow to swing.
 */
function wantedRudder() {
  if (wheelGrip) return wheelGrip.turn / WHEEL_LOCK;
  for (const [, s] of steering) {
    const d = s.cur / FULL_LOCK_PX;
    return Math.max(-1, Math.min(1, s.flip ? -d : d));
  }
  return (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
}

/** Wheel mode: the pointer's angle round the wheel's hub, or null too near the hub to tell. @param {PointerEvent} e */
function wheelAngle(e) {
  const w = renderer.wheelSpot();
  if (!w) return null;
  const dx = e.clientX - w.x, dy = e.clientY - w.y;
  return Math.hypot(dx, dy) < w.r * 0.2 ? null : Math.atan2(dy, dx);
}

/** Is this press on the wheel (spokes and handles included)? @param {PointerEvent} e */
function onWheel(e) {
  const w = renderer.wheelSpot();
  return !!w && Math.hypot(e.clientX - w.x, e.clientY - w.y) < w.r * 1.25;
}

function syncRudder() {
  const r = Math.round(wantedRudder() * 100);
  if (r !== lastRudder && actionsOn()) {
    lastRudder = r;
    issue({ type: 'rudder', value: r });
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
    if (performance.now() - overAt > 900) again();
    return;
  }
  if (phase === 'menu') return;
  const b = buttonAt(e);
  if (b >= 0) {
    pressed.set(e.pointerId, b);
    fire(b);
    return;
  }
  if (settings.steer === 'wheel') {
    if (!wheelGrip && onWheel(e)) {
      canvas.setPointerCapture?.(e.pointerId);
      // Grabbing the hub itself gives no angle yet; the first move away from it sets one.
      wheelGrip = { id: e.pointerId, last: wheelAngle(e) ?? NaN, turn: 0 };
    }
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
  if (wheelGrip && wheelGrip.id === e.pointerId) {
    const a = wheelAngle(e);
    if (a === null) return;
    if (!Number.isNaN(wheelGrip.last)) {
      let d = a - wheelGrip.last; // the short way round, so crossing ±π doesn't jump a whole turn
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      wheelGrip.turn = Math.max(-WHEEL_LOCK, Math.min(WHEEL_LOCK, wheelGrip.turn + d));
    }
    wheelGrip.last = a;
  }
});
const lift = (/** @type {PointerEvent} */ e) => {
  steering.delete(e.pointerId);
  pressed.delete(e.pointerId);
  if (wheelGrip && wheelGrip.id === e.pointerId) wheelGrip = null; // let go and the wheel spins back to centre
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);

const KEYMAP = /** @type {Record<string, string>} */ ({
  ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right',
});
window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const k = KEYMAP[e.key];
  if (k) {
    keys.add(k);
    e.preventDefault();
  } else if (!e.repeat && (e.key === 'z' || e.key === 'Z' || e.key === 'q' || e.key === 'Q')) fire(0);
  else if (!e.repeat && (e.key === 'x' || e.key === 'X' || e.key === 'e' || e.key === 'E')) fire(1);
  else if (e.key === ' ' && phase === 'over' && performance.now() - overAt > 900) again();
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
    if (net && net.ls) net.ls.pump();
    while (acc >= tickMs && steps++ < 4) {
      if (net && (!net.ls || !net.ls.ready())) break; // waiting on the other device's input
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
  updateFacing();
  const me = game.ships[you()];
  const reload = Math.round(game.params.reload * game.params.tickRate);
  const spots = renderer.buttonSpots();
  const held = new Set(pressed.values());
  const buttons = spots.map((s, i) => {
    const bat = me.batteries[batteryFor(i)];
    return { ...s, battery: batteryFor(i), reload: 1 - bat.reloadLeft / reload, firing: bat.firing > 0, pressed: held.has(i), label: i === 0 ? 'left' : 'right' };
  });
  const r = wantedRudder();
  const live = phase === 'play' && !paused;
  renderer.draw(live ? acc / tickMs : 1, paused ? 0 : dt, {
    you: you(),
    buttons: phase === 'menu' ? [] : buttons,
    rudder: steering.size && live ? r : null,
    wheel: phase === 'menu' ? null : { turn: live ? r * WHEEL_LOCK : 0, held: !!wheelGrip },
    overlay: overlay(),
    timeScale: game.params.timeScale,
  });
  requestAnimationFrame(frame);
}

function tick() {
  if (ai) for (const input of ai.think(game)) applyInput(game, ai.ship, input);
  const ev = net && net.ls ? net.ls.advance() : step(game);
  renderer.onTick(ev);
  const firedBy = new Set(ev.fired.map((f) => f.ship));
  for (const s of firedBy) audio.boom(s === you());
  if (ev.hits.length) {
    audio.hit();
    if (ev.hits.some((h) => h.ship === you())) { try { navigator.vibrate?.(25); } catch { /* not supported */ } }
  }
  if (net && net.ls && net.ls.desyncAt >= 0) {
    phase = 'over';
    net.status = 'desync';
    return;
  }
  if (debug) {
    hashAt.set(game.tick, stateHash(game));
    hashAt.delete(game.tick - 300);
  }
  if (ev.splashes.length && game.tick % 3 === 0) audio.splash();
  if (ev.bumps.length && game.tick % 15 === 0) audio.bump();
  if (game.winner >= 0) {
    phase = 'over';
    overAt = performance.now();
    audio.end(game.winner === game.ships[you()].side);
  }
}

/** Tap (or space) on the end screen: a new game against the CPU, a rematch from the host online. */
function again() {
  if (!net) newGame();
  else if (NET_ERRORS[net.status]) leaveToMenu();
  else if (net.role === 'host' && net.status === 'playing') hostStart(); // rematch
}

/** The WAITING overlay is showing: the other device has stalled for more than 600 ms. */
const waitingShown = () => !!net && phase === 'play' && !!net.waitingSince && performance.now() - net.waitingSince > 600;

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
    if (waitingShown()) return { lines: ['WAITING'], sub: 'for the other ship…' };
  }
  if (phase === 'countdown' && !paused) {
    const how = settings.steer === 'wheel' ? 'turn the wheel to steer, cannons to fire' : 'drag to steer, buttons to fire';
    return { lines: [String(Math.ceil(countdown))], sub: `you are ${you() === BLUE ? 'blue' : 'red'} · ${how}` };
  }
  if (paused) return { lines: ['PAUSED'], sub: net ? 'tap to resume · the other ship waits for you' : 'tap to resume' };
  if (phase === 'over') {
    const w = game.winner;
    const lines = w === DRAW ? ['DRAW!'] : w === game.ships[you()].side ? ['VICTORY!'] : ['DEFEAT!'];
    const next = !net ? 'tap to sail again' : net.role === 'host' ? 'tap for a rematch' : 'waiting for the host to start a rematch';
    return {
      lines,
      color: w === DRAW ? COLORS.text : COLORS.players[w],
      sub: `${Math.round(game.ending / game.params.tickRate)}s · ${next}`,
      stats: statRows(),
    };
  }
  return null;
}

function statRows() {
  const st = game.stats;
  const acc = (/** @type {number} */ s) => (st.fired[s] ? `${Math.round((100 * st.hits[s]) / st.fired[s])}%` : '–');
  return {
    names: !net ? ['You', 'CPU'] : net.local === BLUE ? ['You', 'Them'] : ['Them', 'You'],
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
  renderer.layout(); // the sea is the same on every screen; only the camera changes
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
  // In a network game the host's settings rule and rematches go through the host.
  $('pause-new').hidden = !!net;
  $('pause-settings').hidden = !!net;
  $('pause-leave').hidden = !net;
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
$('pause-leave').addEventListener('click', () => leaveToMenu());
$('pause-settings').addEventListener('click', () => detour(pauseDialog, openSettings));
$('pause-rules').addEventListener('click', () => detour(pauseDialog, () => rulesDialog.showModal()));
muteBtn.addEventListener('click', () => { audio.setMuted(!audio.muted); syncMute(); });

// ---------------------------------------------------------------------------
// Network play, as in Dot Army: the host (blue) picks the sea and settings and
// sends them to the guest (red); after that only lockstep inputs and hashes
// flow. See dot-army/NETWORK.md for the messages.

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
  const seat = role === 'host' ? BLUE : RED;
  const transport = relayParam === 'bc'
    ? broadcastTransport('wooden-ships', room, seat)
    : relayTransport(relayParam || DEFAULT_RELAY, 'wooden-ships', room, seat, { ping: debug });
  /** @type {NonNullable<typeof net>} */
  const session = { role, local: seat, room, transport, ls: null, gameNo: 0, waitingSince: 0, joinedAt: performance.now(), status: 'lobby' };
  net = session;
  transport.onMessage(onNetMessage);
  transport.onEvent(onNetEvent);
  newGame(false); // a sea to look at while waiting; replaced when the game starts
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
  net.status = /** @type {NonNullable<typeof net>['status']} */ (status);
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

/** A start message's settings, checked: anything malformed means the other device isn't speaking this protocol. @param {any} m @returns {Deal | null} */
function dealFrom(m) {
  const ok = Number.isInteger(m.seed) && typeof m.islands === 'string' && typeof m.wind === 'string'
    && typeof m.shadow === 'boolean' && Number.isInteger(m.crewPerGun) && m.crewPerGun > 0;
  return ok ? { seed: m.seed, islands: m.islands, wind: m.wind, shadow: m.shadow, crewPerGun: m.crewPerGun } : null;
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
    const d = dealFrom(msg);
    if (msg.v !== PROTOCOL || !d) { net.status = 'version'; return; }
    if (msg.g <= net.gameNo) return; // already playing that one
    net.gameNo = msg.g;
    newGame(true, d);
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
  const d = deal();
  newGame(true, d);
  net.transport.send({ k: 'start', g: net.gameNo, v: PROTOCOL, ...d });
  attachLockstep();
}

function attachLockstep() {
  if (!net) return;
  const g = net.gameNo;
  const transport = net.transport;
  const delay = Number(query.get('delay')) || undefined; // ?delay=N to try other input delays
  net.ls = createLockstep(game, net.local, (m) => transport.send({ ...m, g }), { delay });
  net.status = 'playing';
}

if (debug) {
  /** @type {any} */ (window).woodenShipsDebug = () => ({
    phase, tick: game.tick, winner: game.winner, paused, leftIsStarboard,
    hash: stateHash(game), hashes: Object.fromEntries(hashAt), status: net?.status, desync: net?.ls?.desyncAt ?? -1, net: net?.transport.stats() ?? null,
    overlay: (() => { const o = overlay(); return o ? { lines: o.lines, sub: o.sub } : null; })(),
    buttons: renderer.buttonSpots(), wheel: renderer.wheelSpot(),
    wind: { ...game.wind },
    ships: game.ships.map((s) => ({ x: s.x, y: s.y, heading: s.heading, rudder: s.rudder, crew: s.crew, struck: s.struck, reload: s.batteries.map((b) => b.reloadLeft) })),
    fired: [...game.stats.fired], sea: [game.seaW, game.seaH], view: renderer.view(),
  });
  /** For browser tests: set a ship's fields, e.g. { x, y } to move her (she's left stopped unless vx/vy are given). */
  /** @type {any} */ (window).woodenShipsDebugSet = (/** @type {number} */ id, /** @type {Record<string, number>} */ fields) => {
    Object.assign(game.ships[id], { vx: 0, vy: 0 }, fields);
  };
}

// ---------------------------------------------------------------------------

loadAssets(new URL('../assets/', import.meta.url).href).then((assets) => {
  renderer = createRenderer(canvas, assets);
  if (debug) createNetPanel(() => net?.transport.stats() ?? null);
  // ?room=ABCD joins a game as guest straight away (that's what shared links
  // are); &host makes this device the host instead.
  const room = query.get('room');
  if (room) startNet(cleanCode(room), query.has('host') ? 'host' : 'guest');
  else {
    newGame(false);
    startDialog.showModal();
  }
  requestAnimationFrame(frame);
}).catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<p style="padding:24px">Couldn't load the game's pictures (${String(err.message)}). Try reloading.</p>`);
});
