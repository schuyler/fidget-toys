// Wires the simulation, CPU, plotting, playback and renderer together.
// The game only changes through resolveTurn; everything here is presentation.

import { createGame, resolveTurn, checkOrder, inCommand, living, held, los, blastCells, DRAW, FACTIONS, idle } from './sim.js';
import { createAI } from './ai.js';
import { createRenderer, COLORS, BASE_SIZE } from './render.js';
import * as plot from './plot.js';
import { buildTimeline, stateAfter } from './playback.js';
import { sanitize, paramsFor, DEFAULT_SETTINGS } from './settings.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Order} Order */
/** @typedef {import('./plot.js').Unit} Unit */
/** @typedef {import('./playback.js').Beat} Beat */

const SETTINGS_KEY = 'star-troopers-settings-v1';
let settings = { ...DEFAULT_SETTINGS };
try { settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')); } catch { /* storage unavailable */ }

const query = new URLSearchParams(location.search);
const debug = query.has('debug');
const ME = 0, CPU = 1;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const canvas = /** @type {HTMLCanvasElement} */ ($('board'));
const renderer = createRenderer(canvas);

/** @type {Game} */ let game;
/** @type {ReturnType<typeof createAI>} */ let cpu;
/** @type {'menu'|'plot'|'playback'|'over'} */ let phase = 'menu';
/** This stage's units (one per trooper, or per swarm). @type {Unit[]} */ let units = [];
/** Drafts for this stage, by unit lead. @type {Map<number, Order>} */ let drafts = new Map();
/** Each trooper's last committed orders, by trooper id. @type {Map<number, Order>} */ let last = new Map();
let selected = -1; // lead of the selected unit
let aiming = false;
/** @type {null | { kind: 'unit' } | { kind: 'fire', target: number } | { kind: 'bomb' }} */ let pop = null;
/** Cached for the selection: move costs and what it can see. */
let selReach = /** @type {Int32Array|null} */ (null), selSight = /** @type {Uint8Array|null} */ (null);
let selVisible = /** @type {Set<number>} */ (new Set());

/** Plotting stats, for the end screen: the "is this bearable on a phone?" question. */
let stats = { plots: 0, ms: 0, taps: 0 };
let plotStart = 0, plotTaps = 0;

/**
 * The stage being played back (or the last one, for Replay and the log).
 * @type {null | { before: ReturnType<typeof snapshot>, beats: Beat[], ev: import('./sim.js').TurnEvents, cpuOrders: (Order|null)[], k: number, t0: number, started: boolean, replaying: boolean }}
 */
let show = null;

// ---------------------------------------------------------------------------
// Game setup

function newGame(start = true) {
  const seed = query.has('seed') ? Number(query.get('seed')) >>> 0 : (Math.random() * 2 ** 31) >>> 0;
  game = createGame(paramsFor(settings, seed));
  cpu = createAI(CPU, (seed ^ 0x5bd1e995) >>> 0, { level: settings.cpu === 'hard' ? 'hard' : 'easy' });
  renderer.setGame(game);
  layout();
  renderer.home(BASE_SIZE);
  last = new Map();
  stats = { plots: 0, ms: 0, taps: 0 };
  show = null;
  renderer.effects.clear();
  hideOver();
  if (start) beginPlot(); else { phase = 'menu'; units = plot.unitsFor(game, ME); drafts = new Map(); updateUI(); }
}

function beginPlot() {
  phase = 'plot';
  units = plot.unitsFor(game, ME);
  drafts = new Map();
  select(-1);
  plotStart = performance.now();
  plotTaps = 0;
  updateUI();
}

const unitByLead = (/** @type {number} */ lead) => units.find((u) => u.lead === lead) ?? null;
const unitAt = (/** @type {number} */ cell) => units.find((u) => u.cell === cell) ?? null;
const draftOf = (/** @type {Unit} */ u) => drafts.get(u.lead) ?? idle();

/** "Orrin 3": faction and its number in its squad. */
function nameOf(/** @type {number} */ id) {
  const t = game.troopers[id];
  const n = game.troopers.filter((x) => x.side === t.side).indexOf(t) + 1;
  return `${FACTIONS[t.faction].name} ${n}`;
}
function unitName(/** @type {Unit} */ u) {
  return u.ids.length > 1 ? `${nameOf(u.lead)} ×${u.ids.length}` : nameOf(u.lead);
}

function select(/** @type {number} */ lead) {
  selected = lead;
  aiming = false;
  closePopover();
  const u = unitByLead(lead);
  if (!u) { selReach = null; selSight = null; selVisible = new Set(); return; }
  refreshReach();
  const sight = new Uint8Array(game.grid.N);
  for (let c = 0; c < game.grid.N; c++) sight[c] = los(game, u.cell, c) ? 1 : 0;
  selSight = sight;
  selVisible = new Set(plot.visibleEnemies(game, u));
}

/** Cells the selection can still reach: points not in fire or a launch (dodge and watch give way). */
function refreshReach() {
  const u = unitByLead(selected);
  if (!u) return;
  const d = draftOf(u);
  selReach = plot.reachable(game, u, plot.budget(game, u) - d.fire - (d.launch ?? 0));
}

function setDraft(/** @type {Unit} */ u, /** @type {Order|null} */ d) {
  if (!d) return false;
  drafts.set(u.lead, d);
  if (u.lead === selected) refreshReach();
  updateUI();
  return true;
}

// ---------------------------------------------------------------------------
// Layout and input

function layout() {
  const top = $('hud').getBoundingClientRect().height;
  const bottom = $('bar').getBoundingClientRect().height;
  renderer.layout({ top, bottom });
}
window.addEventListener('resize', () => { layout(); placePopover(); });

/** Pointers being tracked. */
const pointers = new Map(); // id -> {x, y}
/** @type {null | { kind: 'pan'|'unit'|'pinch', x0: number, y0: number, moved: boolean, lead: number, cell: number, dist: number }} */
let press = null;
const SLOP = 8;

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // A second finger: whatever the first was doing becomes a pinch.
    const [a, b] = [...pointers.values()];
    press = { kind: 'pinch', x0: 0, y0: 0, moved: true, lead: -1, cell: -1, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    dragGhost = null;
    return;
  }
  if (pointers.size > 2) return;
  const cell = renderer.cellAtPoint(e.clientX, e.clientY);
  const u = phase === 'plot' && !aiming && cell >= 0 ? unitAt(cell) : null;
  press = { kind: u ? 'unit' : 'pan', x0: e.clientX, y0: e.clientY, moved: false, lead: u ? u.lead : -1, cell, dist: 0 };
});

canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev || !press) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (press.kind === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    renderer.pan((e.clientX - prev.x) / 2, (e.clientY - prev.y) / 2);
    if (press.dist > 0) renderer.zoom(dist / press.dist, mx, my);
    press.dist = dist;
    closePopover();
    return;
  }
  if (!press.moved && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > SLOP) {
    press.moved = true;
    if (press.kind === 'unit') { if (selected !== press.lead) select(press.lead); closePopover(); }
  }
  if (!press.moved) return;
  if (press.kind === 'pan') {
    renderer.pan(e.clientX - prev.x, e.clientY - prev.y);
    closePopover();
  } else if (press.kind === 'unit') {
    const cell = renderer.cellAtPoint(e.clientX, e.clientY);
    dragGhost = { x: e.clientX, y: e.clientY, cell, label: dragLabel(cell) };
  }
});

function endPress(/** @type {PointerEvent} */ e, cancelled = false) {
  pointers.delete(e.pointerId);
  const p = press;
  if (!p) return;
  if (p.kind === 'pinch') {
    if (pointers.size === 0) press = null;
    return;
  }
  press = null;
  if (cancelled) { dragGhost = null; return; }
  if (p.kind === 'unit' && p.moved) {
    dragGhost = null;
    dropUnit(p.lead, renderer.cellAtPoint(e.clientX, e.clientY));
    return;
  }
  if (!p.moved) {
    if (phase === 'plot') plotTaps++;
    tap(renderer.cellAtPoint(e.clientX, e.clientY));
  }
}
canvas.addEventListener('pointerup', (e) => endPress(e));
canvas.addEventListener('pointercancel', (e) => endPress(e, true));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  renderer.zoom(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  closePopover();
}, { passive: false });

/** @type {null | { x: number, y: number, cell: number, label: string }} */
let dragGhost = null;

/** What the cell under a dragged trooper would cost, and who could see it there. */
function dragLabel(/** @type {number} */ cell) {
  const u = unitByLead(selected);
  if (!u || cell < 0 || !selReach) return '';
  if (cell === u.cell) return 'stay';
  if (selReach[cell] < 0) return 'out of reach';
  const seen = living(game, CPU).filter((f) => los(game, f.cell, cell)).length;
  return `${selReach[cell]} pts · ${seen ? `seen by ${seen}` : 'unseen'}`;
}

function dropUnit(/** @type {number} */ lead, /** @type {number} */ cell) {
  const u = unitByLead(lead);
  if (!u || cell < 0) return;
  if (cell !== u.cell && (!selReach || selReach[cell] < 0)) { toast('Out of reach'); return; }
  if (!setDraft(u, plot.setDestination(game, u, draftOf(u), cell))) toast('Not enough points');
}

function tap(/** @type {number} */ cell) {
  if (phase === 'playback') { skipPlayback(); return; }
  if (phase !== 'plot') return;
  const u = unitByLead(selected);
  if (aiming && u) {
    if (cell < 0) return;
    aiming = false;
    if (setDraft(u, plot.bombAt(game, u, draftOf(u), cell))) openPopover({ kind: 'bomb' });
    else toast('Not enough points for a bomb');
    return;
  }
  if (cell < 0) return; // off the board
  const mine = unitAt(cell);
  if (mine) {
    if (mine.lead === selected) { if (pop?.kind === 'unit') closePopover(); else openPopover({ kind: 'unit' }); }
    else { select(mine.lead); updateUI(); }
    return;
  }
  const foe = living(game, CPU).find((t) => t.cell === cell);
  if (foe && u) {
    if (!selVisible.has(foe.id)) { toast(`${nameOf(u.lead)} can't see it from here`); return; }
    const d = draftOf(u);
    const points = d.target === foe.id && d.fire > 0 ? d.fire : plot.free(game, u, { ...d, fire: 0 });
    if (setDraft(u, plot.setFire(game, u, d, foe.id, Math.max(1, points)))) openPopover({ kind: 'fire', target: foe.id });
    return;
  }
  if (u && selReach && selReach[cell] >= 0) { closePopover(); dropUnit(u.lead, cell); return; }
  if (pop) { closePopover(); return; }
  select(-1);
  updateUI();
}

// ---------------------------------------------------------------------------
// Popovers

const popEl = $('popover');

function openPopover(/** @type {NonNullable<typeof pop>} */ p) { pop = p; renderPopover(); }
function closePopover() {
  if (!pop && popEl.hidden) return;
  pop = null;
  popEl.hidden = true;
}

/** @param {string} label @param {string} key @param {number} value @param {string} [cls] */
function stepper(label, key, value, cls = '') {
  return `<div class="line ${cls}"><span class="name">${label}</span>
    <button class="step" data-adj="${key}" data-d="-1" aria-label="less ${label}">−</button>
    <span class="val">${value}</span>
    <button class="step" data-adj="${key}" data-d="1" aria-label="more ${label}">+</button></div>`;
}

function renderPopover() {
  const u = unitByLead(selected);
  if (!pop || !u || phase !== 'plot') { closePopover(); return; }
  const d = draftOf(u);
  const free = plot.free(game, u, d);
  let html = '';
  if (pop.kind === 'unit') {
    const lastD = plot.lastFor(last, u);
    const presets = [
      ['last', '⟳ Last', lastD ? plot.repeatLast(game, u, lastD) : null],
      ['hold', 'Hold + watch', plot.holdWatch(game, u)],
      ['cover', 'To cover', plot.toCover(game, u)],
      ['back', 'Fall back', plot.fallBack(game, u)],
    ];
    presetCache = new Map(presets.map(([k, , v]) => [/** @type {string} */ (k), /** @type {Order|null} */ (v)]));
    html = `<h3>${unitName(u)} · ${free} of ${plot.budget(game, u)} free</h3>
      ${stepper('Dodge', 'dodge', d.dodge)}
      ${stepper('Watch', 'overwatch', d.overwatch)}
      ${(d.launch ?? 0) > 0 ? stepper('Bomb', 'launch', d.launch ?? 0) : ''}
      <div class="presets">
        <button data-act="bomb">${(d.launch ?? 0) > 0 ? 'Re-aim bomb' : 'Bomb…'}</button>
        ${presets.map(([k, label, v]) => `<button data-preset="${k}" ${v ? '' : 'disabled'}>${label}</button>`).join('')}
        <button data-act="clear">Clear</button>
      </div>
      <p class="note">Dodge makes every shot at it harder this stage. Watch shoots the nearest enemy that moves within 6 cells in sight.</p>`;
  } else if (pop.kind === 'fire') {
    const target = pop.target;
    const pv = plot.shotPreview(game, u, target, d.fire);
    const n = u.ids.length;
    const how = n === 3 ? 'one pooled shot at ×3' : n === 2 ? 'two shots' : '';
    const victims = pv.victims.length > 1 ? ` (hits all ${pv.victims.length} in the cell)` : '';
    html = `<h3>Fire at ${nameOf(target)}${victims}</h3>
      ${stepper('Fire', 'fire', d.fire)}
      <p class="note">If it stands still and doesn't dodge: <b>≈${fmt(pv.shock)} lost</b>${how ? `, ${how}` : ''}.
      ${d.fire === 0 && free === 0 ? '<b>No points free:</b> lower its dodge, watch or move first.' : pv.cancel > 0 ? `Dodging <b>${pv.cancel}</b> would cancel it.` : '<b>Can\'t beat its defence.</b>'}</p>
      <p class="note">Attack ${pv.attack} against defence ${pv.defence}, then two dice. Moving adds to its defence.</p>
      <div class="presets"><button data-act="nofire">Cancel shot</button><button data-act="done">Done</button></div>`;
  } else if (pop.kind === 'bomb') {
    const at = d.launchAt ?? -1;
    if (at < 0 || !(d.launch ?? 0)) { openPopover({ kind: 'unit' }); return; }
    const bp = plot.bombPreview(game, u, at, d.launch ?? 0, drafts);
    const hits = bp.hits.map((h) => `${nameOf(h.id)} ≈${fmt(h.shock)}`).join(', ') || 'nobody there now';
    html = `<h3>Bomb${u.ids.length > 1 ? `s ×${u.ids.length}, each rolled separately` : ''}</h3>
      ${stepper('Points', 'launch', d.launch ?? 0)}
      <p class="note">Lands <b>${Math.round(bp.land * 100)}%</b> of the time, counting your own troopers' dodge nearby; enemy dodge there makes it likelier to stray.</p>
      <p class="note">Goes off after everyone moves. Would hit: ${hits}.</p>
      ${bp.friendly ? '<p class="note warn">⚠ One of yours ends up in the blast.</p>' : ''}
      <div class="presets"><button data-act="bomb">Re-aim</button><button data-act="nobomb">Cancel bomb</button><button data-act="done">Done</button></div>`;
  }
  popEl.innerHTML = html;
  popEl.hidden = false;
  placePopover();
}

/** @type {Map<string, Order|null>} */ let presetCache = new Map();

const fmt = (/** @type {number} */ x) => (Math.round(x * 10) / 10).toString();

/** Put the popover beside the cell it's about, on whichever side has room. */
function placePopover() {
  if (!pop || popEl.hidden) return;
  const u = unitByLead(selected);
  if (!u) return;
  const d = draftOf(u);
  const cell = pop.kind === 'fire' ? game.troopers[pop.target].cell
    : pop.kind === 'bomb' ? (d.launchAt ?? u.cell)
    : (d.path.length ? d.path[d.path.length - 1] : u.cell);
  const [x, y] = renderer.toScreen(cell);
  const w = popEl.offsetWidth, h = popEl.offsetHeight;
  const gap = renderer.size * 1.1;
  const top = $('hud').getBoundingClientRect().height, bottom = window.innerHeight - $('bar').getBoundingClientRect().height;
  let py = y - gap - h;
  if (py < top + 4) py = y + gap;
  py = Math.max(top + 4, Math.min(bottom - h - 4, py));
  const px = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2));
  popEl.style.left = `${px}px`;
  popEl.style.top = `${py}px`;
}

popEl.addEventListener('click', (e) => {
  const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
  const u = unitByLead(selected);
  if (!b || !u) return;
  plotTaps++;
  const d = draftOf(u);
  if (b.dataset.adj) {
    setDraft(u, plot.adjust(game, u, d, /** @type {'fire'|'dodge'|'overwatch'|'launch'} */ (b.dataset.adj), Number(b.dataset.d)));
    if (pop?.kind === 'bomb' && !(draftOf(u).launch ?? 0)) pop = { kind: 'unit' };
  } else if (b.dataset.preset) {
    const p = presetCache.get(b.dataset.preset);
    if (p) { setDraft(u, p); closePopover(); return; }
  } else {
    const act = b.dataset.act;
    if (act === 'bomb') { aiming = true; hoverCell = -1; closePopover(); toast('Tap a cell to bomb'); updateUI(); return; }
    if (act === 'clear') { drafts.delete(u.lead); refreshReach(); updateUI(); }
    if (act === 'nofire') setDraft(u, { ...d, target: -1, fire: 0 });
    if (act === 'nobomb') { setDraft(u, { ...d, launch: 0, launchAt: -1 }); pop = { kind: 'unit' }; }
    if (act === 'done') { closePopover(); return; }
  }
  renderPopover();
});

// ---------------------------------------------------------------------------
// HUD and bar

function updateUI() {
  if (!game) return;
  // While a stage plays back (or after the game), show the stage that was played.
  const shown = show && phase !== 'plot' ? show.ev : game;
  const turnsLeft = game.params.turnLimit - shown.turn;
  $('hud-turn').textContent = `Turn ${shown.turn}/${game.params.turnLimit} · Stage ${shown.stage} of ${game.params.stages}${turnsLeft === 0 ? ' · last turn' : ''}`;
  const owners = (show && phase === 'playback') ? stateAfter(show.before, show.beats, Math.max(-1, show.k - 1)).owner : game.victory.map((v) => v.owner);
  $('hud-hexes').innerHTML = owners.map((o) => `<span class="${o < 0 ? 'hex-n' : `hex-${o}`}">◆</span>`).join('');
  $('bar').classList.toggle('watching', phase !== 'plot');

  const chips = $('chips');
  chips.innerHTML = units.map((u, i) => {
    const t = game.troopers[u.lead];
    const g = FACTIONS[t.faction].name[0];
    return `<button class="unit-chip ${drafts.has(u.lead) ? 'done' : ''} ${u.lead === selected ? 'selected' : ''}" data-lead="${u.lead}">${g}${game.troopers.filter((x) => x.side === ME).indexOf(t) + 1}${u.ids.length > 1 ? `×${u.ids.length}` : ''}${drafts.has(u.lead) ? ' ✓' : ''}</button>`;
  }).join('');

  const sel = $('sel');
  const u = unitByLead(selected);
  if (phase !== 'plot') {
    sel.textContent = phase === 'playback' ? 'Watching… tap the board to skip.' : '';
  } else if (aiming) {
    sel.innerHTML = '<b>Tap a cell to bomb.</b> No line of sight needed.';
  } else if (!u) {
    const done = units.filter((x) => drafts.has(x.lead)).length;
    sel.innerHTML = `Tap a trooper to give it orders. <b>${done} of ${units.length}</b> plotted.`;
  } else {
    sel.innerHTML = `<b>${unitName(u)}</b>${game.troopers[u.lead].leader ? ' ★' : ''}${game.params.command && !inCommand(game, game.troopers[u.lead]) ? ' (out of command)' : ''} ${pips(u)}`;
  }
  ($('btn-commit')).toggleAttribute('disabled', phase !== 'plot');
  ($('btn-repeat-all')).toggleAttribute('disabled', phase !== 'plot' || !units.some((x) => !drafts.has(x.lead) && plot.lastFor(last, x)));
  if (pop) renderPopover();
}

/** The selected unit's points this stage, one pip per point, coloured by task. */
function pips(/** @type {Unit} */ u) {
  const d = draftOf(u);
  const b = plot.budget(game, u);
  const move = plot.used(game, u, { ...idle(), path: d.path });
  const cells = [
    ...Array(move).fill('move'), ...Array(d.fire).fill('fire'), ...Array(d.dodge).fill('dodge'),
    ...Array(d.overwatch).fill('watch'), ...Array(d.launch ?? 0).fill('bomb'),
  ];
  while (cells.length < b) cells.push('');
  const t = game.troopers[u.lead];
  const free = plot.free(game, u, d);
  // Stage 2 gets what's left of the pool, up to the stage cap (less any shock taken meanwhile).
  const spend = plot.used(game, u, d);
  const next = Math.min(...u.ids.map((id) => {
    const m = game.troopers[id];
    return Math.max(0, Math.min(m.pool - m.shock - m.spent - spend, game.params.stageCap));
  }));
  const after = game.params.stages === 2 && game.stage === 1
    ? `stage 2: up to ${next}`
    : (free > 0 ? `${free} unspent (wasted)` : '');
  return `<span class="pips">${cells.map((c) => `<span class="pip ${c}"></span>`).join('')}</span>
    <span>${t.shock ? `shock ${t.shock}/${t.pool}` : ''} ${after}</span>`;
}

$('chips').addEventListener('click', (e) => {
  const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
  if (!b || phase !== 'plot') return;
  plotTaps++;
  const lead = Number(b.dataset.lead);
  select(lead);
  const u = unitByLead(lead);
  if (u) renderer.reveal(u.cell);
  updateUI();
});

$('btn-repeat-all').addEventListener('click', () => {
  if (phase !== 'plot') return;
  plotTaps++;
  let n = 0;
  for (const u of units) {
    if (drafts.has(u.lead)) continue;
    const l = plot.lastFor(last, u);
    const d = l ? plot.repeatLast(game, u, l) : null;
    if (d) { drafts.set(u.lead, d); n++; }
  }
  refreshReach();
  toast(n ? `Repeated last orders for ${n}` : 'No last orders to repeat');
  updateUI();
});

let toastTimer = 0;
function toast(/** @type {string} */ msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 1800);
}

// ---------------------------------------------------------------------------
// Commit

const confirmDialog = /** @type {HTMLDialogElement} */ ($('confirm'));

$('btn-commit').addEventListener('click', () => {
  if (phase !== 'plot') return;
  plotTaps++;
  const missing = units.filter((u) => !drafts.has(u.lead));
  if (missing.length) {
    const repeatable = missing.filter((u) => plot.lastFor(last, u)).length;
    $('confirm-title').textContent = `${missing.length} with no orders`;
    $('confirm-text').textContent = repeatable
      ? `Repeat their last orders (${repeatable} have some), or leave them standing idle?`
      : 'They have no last orders to repeat. Leave them standing idle?';
    /** @type {HTMLButtonElement} */ (confirmDialog.querySelector('button[value="repeat"]')).disabled = !repeatable;
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
    return;
  }
  commit();
});
confirmDialog.addEventListener('close', () => {
  const v = confirmDialog.returnValue;
  if (v === 'repeat') {
    for (const u of units) {
      if (drafts.has(u.lead)) continue;
      const l = plot.lastFor(last, u);
      const d = l ? plot.repeatLast(game, u, l) : null;
      if (d) drafts.set(u.lead, d);
    }
    commit();
  } else if (v === 'idle') {
    commit();
  }
});

function snapshot() {
  return {
    cell: game.troopers.map((t) => t.cell),
    shock: game.troopers.map((t) => t.shock),
    down: game.troopers.map((t) => t.down),
    pool: game.troopers.map((t) => t.pool),
    owner: game.victory.map((v) => v.owner),
    victoryCells: game.victory.map((v) => v.cell),
  };
}

function commit() {
  const mine = plot.ordersFor(game, ME, drafts);
  const theirs = cpu.plan(game); // the CPU never sees our drafts
  const orders = game.troopers.map((t) => (t.side === ME ? mine[t.id] : theirs[t.id]));
  for (const t of living(game)) {
    const why = checkOrder(game, t, { ...idle(), ...(orders[t.id] ?? {}) });
    if (why) { toast(`Can't commit: ${nameOf(t.id)}: ${why}`); return; }
  }
  stats.plots++;
  stats.ms += performance.now() - plotStart;
  stats.taps += plotTaps;
  for (const u of units) {
    const d = drafts.get(u.lead);
    if (d) for (const id of u.ids) last.set(id, d);
  }
  const before = snapshot();
  const cmd = game.params.command ? new Set(living(game).filter((t) => inCommand(game, t)).map((t) => t.id)) : null;
  const ev = resolveTurn(game, orders);
  show = { before, beats: buildTimeline(before, ev, cmd), ev, cpuOrders: theirs, k: 0, t0: 0, started: false, replaying: false };
  select(-1);
  startPlayback();
}

// ---------------------------------------------------------------------------
// Playback

const DURATION = { fire: 1100, launch: 900, step: 380, blast: 1200, end: 1000 };
const caption = $('caption');

function startPlayback() {
  if (!show) return;
  phase = 'playback';
  show.k = 0;
  show.started = false;
  renderer.effects.clear();
  caption.hidden = false;
  updateUI();
}

function skipPlayback() {
  if (!show) return;
  show.k = show.beats.length;
  renderer.effects.clear();
  finishPlayback();
}

function finishPlayback() {
  caption.hidden = true;
  if (show?.replaying) {
    // A replay ends back where it started: plotting (drafts intact) or the end screen.
    show.replaying = false;
    phase = game.winner >= 0 ? 'over' : 'plot';
    updateUI();
    if (phase === 'over') showOver();
    return;
  }
  if (game.winner >= 0) { phase = 'over'; updateUI(); showOver(); return; }
  beginPlot();
}

function beatDuration(/** @type {Beat} */ b) {
  if (b.kind === 'step') return DURATION.step + (b.shots.length ? 700 : 0);
  return DURATION[b.kind];
}

/** Effects and the caption as a beat starts. */
function startBeat(/** @type {Beat} */ b, /** @type {number} */ now) {
  const fx = renderer.effects;
  const s = /** @type {NonNullable<typeof show>} */ (show);
  // overwatch fires after its step's moves, so a step's effects use where everyone ended up
  const at = stateAfter(s.before, s.beats, b.kind === 'step' ? s.k : s.k - 1);
  /** @param {import('./sim.js').Shot} shot @param {number} i */
  const shotFx = (shot, i) => {
    const from = shot.kind === 'blast' ? -1 : at.cell[shot.from];
    const to = at.cell[shot.to];
    const col = COLORS.sides[game.troopers[shot.from].side];
    if (from >= 0) fx.tracer(from, to, shot.kind === 'overwatch' ? COLORS.watch : col, now);
    const txt = shot.stun ? 'stunned' : shot.miss ? 'miss' : shot.shock ? `−${shot.shock}` : '0';
    fx.text(to, txt, shot.shock ? '#ff8a8a' : COLORS.neutral, now + (shot.kind === 'blast' ? 250 : 120), i % 3);
  };
  if (b.kind === 'fire') {
    caption.textContent = b.wave === 'command' ? 'Fire: troopers in command first' : b.wave === 'rest' ? 'Fire: everyone else' : 'Fire';
    b.shots.forEach(shotFx);
  } else if (b.kind === 'launch') {
    caption.textContent = `Bombs away (${b.launches.length})`;
    for (const l of b.launches) fx.arc(s.before.cell[l.from], l.aimed, now);
  } else if (b.kind === 'step') {
    caption.textContent = `Moving · step ${b.index + 1}`;
    b.shots.forEach(shotFx);
    for (const id of b.pinned) fx.text(at.cell[id], 'pinned', COLORS.watch, now + 300, 2);
    for (const bl of b.blocked) fx.text(at.cell[bl.id], 'blocked', COLORS.neutral, now, 1);
  } else if (b.kind === 'blast') {
    caption.textContent = 'Bombs go off';
    for (const l of b.launches) {
      if (l.landed !== l.aimed) fx.arrow(l.aimed, l.landed >= 0 ? l.landed : l.aimed, now);
      if (l.landed >= 0) fx.blast(blastCells(game, l.landed).map((x) => x.cell), l.landed, now + 200);
    }
    b.shots.forEach(shotFx);
  } else if (b.kind === 'end') {
    caption.textContent = b.captures.length ? 'Hexes change hands' : 'Recovery';
    for (const r of b.recovered) fx.text(at.cell[r.id], `+${r.amount}`, '#7dffb0', now);
    for (const c of b.captures) fx.text(c.cell, c.to === ME ? 'yours' : 'theirs', COLORS.sides[c.to], now, 1);
  }
}

/** Pieces to draw, with movement interpolated during a step beat. */
function piecesNow(/** @type {number} */ now) {
  /** @type {{cell: number[], shock: number[], down: boolean[]}} */
  let state = { cell: game.troopers.map((t) => t.cell), shock: game.troopers.map((t) => t.shock), down: game.troopers.map((t) => t.down) };
  /** @type {Map<number, {from: number, to: number}>} */
  const moving = new Map();
  let k = 0;
  if (show && phase === 'playback') {
    const b = show.beats[show.k];
    state = stateAfter(show.before, show.beats, show.k - 1);
    if (b && b.kind === 'step') {
      k = Math.min(1, (now - show.t0) / DURATION.step);
      for (const m of b.moves) moving.set(m.id, m);
    }
  }
  const centres = renderer.centres;
  /** @type {Map<string, import('./render.js').Piece>} */
  const byPos = new Map();
  const u = unitByLead(selected);
  for (const t of game.troopers) {
    if (state.down[t.id]) continue;
    const m = moving.get(t.id);
    const ease = k * k * (3 - 2 * k);
    const [ax, ay] = centres[m ? m.from : state.cell[t.id]];
    const [bx, by] = m ? centres[m.to] : [ax, ay];
    const x = ax + (bx - ax) * ease, y = ay + (by - ay) * ease;
    const key = `${t.side}:${x.toFixed(3)}:${y.toFixed(3)}`;
    const shock = state.shock[t.id];
    const prev = byPos.get(key);
    if (prev) {
      prev.count++;
      // a swarm shows its most-hurt member
      if (t.pool - shock < prev.pool - prev.shock) { prev.shock = shock; prev.pool = t.pool; }
      continue;
    }
    const unit = phase === 'plot' && t.side === ME ? units.find((x2) => x2.ids.includes(t.id)) : null;
    byPos.set(key, {
      id: t.id, x, y, side: t.side, faction: t.faction, shock, pool: t.pool, leader: t.leader, count: 1,
      selected: !!u && u.ids.includes(t.id),
      dim: !!u && t.side === CPU && !selVisible.has(t.id),
      done: !!unit && drafts.has(unit.lead),
    });
  }
  return [...byPos.values()];
}

function scene(/** @type {number} */ now) {
  const plotting = phase === 'plot';
  const u = unitByLead(selected);
  const owners = show && phase === 'playback' ? stateAfter(show.before, show.beats, Math.max(-1, show.k - 1)).owner : game.victory.map((v) => v.owner);
  /** @type {import('./render.js').Scene['plans']} */
  const plans = plotting ? units.filter((x) => drafts.has(x.lead)).map((x) => ({ from: x.cell, d: draftOf(x), side: ME, selected: x.lead === selected })) : [];
  let aim = null;
  if (plotting && u && aiming && hoverCell >= 0) aim = { cell: hoverCell, cells: blastCells(game, hoverCell).map((b) => b.cell) };
  else if (plotting && u && pop?.kind === 'bomb') {
    const at = draftOf(u).launchAt ?? -1;
    if (at >= 0) aim = { cell: at, cells: blastCells(game, at).map((b) => b.cell) };
  }
  return {
    pieces: piecesNow(now),
    owners,
    reach: plotting && u && !aiming ? selReach : null,
    sight: plotting && u ? selSight : null,
    plans,
    aim,
    drag: dragGhost,
  };
}

let hoverCell = -1;
canvas.addEventListener('pointermove', (e) => { if (aiming) hoverCell = renderer.cellAtPoint(e.clientX, e.clientY); });

function frame(/** @type {number} */ now) {
  if (game) {
    if (phase === 'playback' && show) {
      if (!show.started) { show.started = true; show.t0 = now; if (show.beats[0]) startBeat(show.beats[0], now); updateUI(); }
      while (show.k < show.beats.length && now - show.t0 >= beatDuration(show.beats[show.k])) {
        show.t0 += beatDuration(show.beats[show.k]);
        show.k++;
        if (show.k < show.beats.length) startBeat(show.beats[show.k], now);
        updateUI();
      }
      if (show.k >= show.beats.length) finishPlayback();
    }
    renderer.draw(scene(now), now);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Log and replay

const logDialog = /** @type {HTMLDialogElement} */ ($('log'));
const who = (/** @type {number} */ id) => `<span class="who-${game.troopers[id].side}">${nameOf(id)}</span>`;
const cellName = (/** @type {number} */ c) => `(${c % game.grid.W + 1}, ${Math.floor(c / game.grid.W) + 1})`;

function shotLine(/** @type {import('./sim.js').Shot} */ s) {
  const roll = s.roll ? `, rolled ${s.roll}` : '';
  if (s.kind === 'blast') {
    return `<p>Blast ${s.attack} on ${who(s.to)} (terrain ${s.defence})${roll}: ${s.stun ? 'stunned' : s.shock ? `−${s.shock}` : 'no effect'}</p>`;
  }
  const what = s.kind === 'overwatch' ? 'overwatch' : 'fires at';
  return `<p>${who(s.from)} ${what} ${who(s.to)}: attack ${s.attack} vs defence ${s.defence}${roll}: ${s.miss ? 'miss' : s.shock ? `−${s.shock}` : 'no loss'}</p>`;
}

function renderLog() {
  const body = $('log-body');
  if (!show) { body.innerHTML = '<p>Nothing has happened yet.</p>'; return; }
  const { beats, ev, cpuOrders } = show;
  let html = `<h4>Turn ${ev.turn}, stage ${ev.stage}</h4>`;
  for (const b of beats) {
    if (b.kind === 'fire') { html += `<h4>Fire${b.wave === 'command' ? ' (in command)' : b.wave === 'rest' ? ' (everyone else)' : ''}</h4>`; html += b.shots.map(shotLine).join(''); }
    if (b.kind === 'launch') { html += '<h4>Launches</h4>'; html += b.launches.map((l) => `<p>${who(l.from)} bombs ${cellName(l.aimed)}</p>`).join(''); }
    if (b.kind === 'step' && (b.shots.length || b.blocked.length)) {
      html += `<h4>Step ${b.index + 1}</h4>${b.shots.map(shotLine).join('')}`;
      html += b.blocked.map((x) => `<p>${who(x.id)} is blocked</p>`).join('');
      html += b.pinned.map((id) => `<p>${who(id)} is pinned</p>`).join('');
    }
    if (b.kind === 'blast') {
      html += '<h4>Bombs</h4>';
      for (const l of b.launches) {
        const where = l.landed < 0 ? 'off the map' : l.landed === l.aimed ? 'on target' : `${cellName(l.landed)}, off target`;
        html += `<p>${who(l.from)}'s bomb (scatter ${l.sd}${l.die ? `, die ${l.die}` : ''}) lands ${where}</p>`;
      }
      html += b.shots.map(shotLine).join('');
    }
    if (b.kind === 'end') {
      html += b.recovered.length ? `<h4>Recovery</h4>${b.recovered.map((r) => `<p>${who(r.id)} +${r.amount}</p>`).join('')}` : '';
      html += b.captures.map((c) => `<p>${c.to === ME ? 'You take' : 'The CPU takes'} the hex at ${cellName(c.cell)}</p>`).join('');
    }
  }
  html += '<h4>The CPU\'s orders</h4>';
  for (const t of game.troopers) {
    if (t.side !== CPU || show.before.down[t.id]) continue;
    const o = cpuOrders[t.id];
    if (!o) { html += `<p>${who(t.id)}: nothing</p>`; continue; }
    const parts = [];
    if (o.path.length) parts.push(`move ${o.path.length}`);
    if (o.fire) parts.push(`fire ${o.fire} at ${nameOf(o.target)}`);
    if (o.dodge) parts.push(`dodge ${o.dodge}`);
    if (o.overwatch) parts.push(`watch ${o.overwatch}`);
    if (o.launch) parts.push(`bomb ${o.launch} at ${cellName(o.launchAt ?? -1)}`);
    html += `<p>${who(t.id)}: ${parts.join(', ') || 'nothing'}</p>`;
  }
  body.innerHTML = html;
}

$('btn-log').addEventListener('click', () => { renderLog(); logDialog.returnValue = ''; logDialog.showModal(); });
logDialog.addEventListener('close', () => {
  if (logDialog.returnValue === 'replay' && show && phase !== 'playback') {
    show.replaying = true;
    hideOver();
    startPlayback();
  }
});

// ---------------------------------------------------------------------------
// End of game

const overDialog = /** @type {HTMLDialogElement} */ ($('over'));
function showOver() {
  const w = game.winner;
  $('over-title').textContent = w === DRAW ? 'Draw' : w === ME ? 'You win' : 'CPU wins';
  $('over-title').style.color = w === DRAW ? '' : COLORS.sides[w];
  $('over-sub').textContent = `Turn ${game.last?.turn ?? game.turn} · hexes held ${held(game, ME)}–${held(game, CPU)} · troopers left ${living(game, ME).length}–${living(game, CPU).length}`;
  const n = Math.max(1, stats.plots);
  $('over-stats').innerHTML = [
    ['Plots', stats.plots],
    ['Seconds per plot', (stats.ms / n / 1000).toFixed(0)],
    ['Taps per plot', (stats.taps / n).toFixed(1)],
  ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  if (!overDialog.open) overDialog.showModal();
}
function hideOver() { if (overDialog.open) overDialog.close(); }
$('over-new').addEventListener('click', () => newGame());
$('over-log').addEventListener('click', () => { hideOver(); renderLog(); logDialog.returnValue = ''; logDialog.showModal(); });
$('over-board').addEventListener('click', () => hideOver());

// ---------------------------------------------------------------------------
// Menus and settings (as in Dot Army)

const startDialog = /** @type {HTMLDialogElement} */ ($('start'));
const pauseDialog = /** @type {HTMLDialogElement} */ ($('pause'));
const rulesDialog = /** @type {HTMLDialogElement} */ ($('rules'));
const settingsDialog = /** @type {HTMLDialogElement} */ ($('settings'));
const form = /** @type {HTMLFormElement} */ ($('settings-form'));
/** @type {HTMLDialogElement|null} */ let returnTo = null;

function detour(/** @type {HTMLDialogElement} */ from, /** @type {() => void} */ open) {
  returnTo = from;
  from.close();
  open();
}
for (const d of [settingsDialog, rulesDialog]) {
  d.addEventListener('close', () => {
    const back = returnTo;
    returnTo = null;
    if (back && !back.open && !(d === settingsDialog && settingsDialog.returnValue === 'apply')) back.showModal();
  });
}
function openSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const el = /** @type {RadioNodeList|null} */ (form.elements.namedItem(k));
    if (el) el.value = v;
  }
  settingsDialog.showModal();
}
form.addEventListener('submit', (e) => {
  const submitter = /** @type {HTMLButtonElement|null} */ (/** @type {SubmitEvent} */ (e).submitter);
  if (submitter?.value === 'reset') settings = { ...DEFAULT_SETTINGS };
  else if (submitter?.value === 'apply') settings = sanitize(Object.fromEntries(new FormData(form)));
  else return;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  if (submitter?.value === 'reset') { openSettingsSoon(); return; }
  returnTo = null;
  newGame();
});
/** "Defaults" just refills the form. */
function openSettingsSoon() { setTimeout(openSettings, 0); }

$('start-new').addEventListener('click', () => { startDialog.close(); newGame(); });
$('start-settings').addEventListener('click', () => detour(startDialog, openSettings));
$('start-rules').addEventListener('click', () => detour(startDialog, () => rulesDialog.showModal()));
startDialog.addEventListener('cancel', (e) => { e.preventDefault(); $('start-new').click(); });

$('btn-menu').addEventListener('click', () => { closePopover(); pauseDialog.showModal(); });
$('pause-resume').addEventListener('click', () => pauseDialog.close());
$('pause-new').addEventListener('click', () => { pauseDialog.close(); newGame(); });
$('pause-settings').addEventListener('click', () => detour(pauseDialog, openSettings));
$('pause-rules').addEventListener('click', () => detour(pauseDialog, () => rulesDialog.showModal()));

// ---------------------------------------------------------------------------
// Start

newGame(false);
startDialog.showModal();
requestAnimationFrame(frame);

if (debug) {
  /** For automated tests: the state of play, and where cells are on screen. */
  /** @type {any} */ (window).starTroopersDebug = () => ({
    phase, turn: game.turn, stage: game.stage, winner: game.winner, selected, aiming, pop: pop?.kind ?? null,
    units: units.map((u) => ({ lead: u.lead, ids: u.ids, cell: u.cell, done: drafts.has(u.lead) })),
    enemies: living(game, CPU).map((t) => ({ id: t.id, cell: t.cell, visible: selVisible.has(t.id) })),
    reach: selReach ? [...selReach].map((c, i) => (c >= 0 ? i : -1)).filter((i) => i >= 0) : [],
    size: renderer.size, stats,
  });
  /** @type {any} */ (window).starTroopersCell = (/** @type {number} */ c) => renderer.toScreen(c);
}
