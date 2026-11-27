// Wires the simulation, the CPU, the renderer and the page together.

import {
  createGame, act, preview, buildOptions, researchCost, stackAt, enemyAt, besieged, band, level, safeRange,
  TERRAIN_NAMES, TECH_NAMES, TECH_TYPES, TECH_EFFECTS, techType, isCore, DRAW, VOID,
} from './sim.js';
import { createAI } from './ai.js';
import { createRenderer } from './render.js';
import { within } from './hex.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').GameEvent} GameEvent */
/** @typedef {import('./sim.js').Action} Action */

const YOU = 0, CPU = 1;

// Settings the player sees: two presets.
const CHOICES = { level: ['easy', 'hard'], galaxy: ['small', 'medium', 'large'] };
const SETTINGS_KEY = 'coreward-bound-settings-v1';
const defaultSettings = { level: 'easy', galaxy: 'medium' };
/** @param {any} raw */
function sanitize(raw) {
  const out = { ...defaultSettings };
  if (raw && typeof raw === 'object') {
    if (CHOICES.level.includes(raw.level)) out.level = raw.level;
    if (CHOICES.galaxy.includes(raw.galaxy)) out.galaxy = raw.galaxy;
  }
  return out;
}
let settings = { ...defaultSettings };
try { settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')); } catch { /* storage unavailable */ }

const query = new URLSearchParams(location.search);
const debug = query.has('debug');
/** CPU pacing: ?fast skips most of the waiting (for tests). */
const pace = query.has('fast') ? 0.05 : 1;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const canvas = /** @type {HTMLCanvasElement} */ ($('game'));
const renderer = createRenderer(canvas);

/** @type {Game} */ let game;
/** @type {ReturnType<typeof createAI>} */ let ai;
let cpuRunning = false;
let gameId = 0;

const view = {
  selected: -1,
  /** @type {Set<number>} */ reach: new Set(),
  /** @type {Set<number>} */ far: new Set(),
  /** @type {import('./sim.js').Preview|null} */ preview: null,
  busy: false,
  send: 0,
  /** Cells you've looked at this turn (they count as handled for Next). @type {Set<number>} */ visited: new Set(),
};

// Icons for the HUD, drawn once; colour comes from the text colour, size from CSS.
const ICONS = {
  coin: '<svg class="ico coin" viewBox="0 0 16 16" aria-label="RP" role="img"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="6.6" y="4.6" width="2.8" height="6.8" rx="1.2" fill="currentColor"/></svg>',
  flask: '<svg class="ico flask" viewBox="0 0 16 16" aria-label="Techs" role="img"><path d="M6 2h4M6.5 2v4.5L2.8 13a1 1 0 0 0 .9 1.5h8.6a1 1 0 0 0 .9-1.5L9.5 6.5V2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><path d="M4.6 10.5h6.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

// ------------------------------------------------------------------ game flow

/** @param {boolean} [quiet] no welcome message (the galaxy behind the start menu) */
function newGame(quiet = false) {
  gameId++;
  const seed = (Math.random() * 2 ** 31) >>> 0;
  game = createGame({ galaxy: /** @type {any} */ (settings.galaxy), seed });
  ai = createAI(CPU, seed ^ 0x5bd1e995, { level: /** @type {any} */ (settings.level) });
  cpuRunning = false;
  renderer.setGame(game);
  renderer.startAt(game.civs[YOU].home);
  view.visited.clear();
  deselect();
  refresh();
  if (!quiet) toast('Your home is the blue ring. The relics wait at the core.', 'you');
  if (debug) /** @type {any} */ (window).corewardDebug = { get game() { return game; }, act: playerAct, view, renderer, endTurn: playerEnd };
}

/**
 * Apply a player action and show what happened.
 * @param {Action} a
 */
function playerAct(a) {
  if (game.current !== YOU || cpuRunning || game.winner >= 0) return null;
  const ev = act(game, a);
  if ('error' in ev) { toast(ev.error, 'bad'); return ev; }
  for (const e of ev) { renderer.animate(e); narrate(e); }
  afterChange();
  return ev;
}

function afterChange() {
  if (view.selected >= 0) select(view.selected, true);
  refresh();
  if (game.winner >= 0) gameOver();
}

function playerEnd() {
  if (game.current !== YOU || cpuRunning || game.winner >= 0) return;
  deselect();
  const ev = act(game, { kind: 'end' });
  if (!('error' in ev)) for (const e of ev) { renderer.animate(e); narrate(e); }
  refresh();
  if (game.winner >= 0) { gameOver(); return; }
  cpuTurn();
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms * pace));

async function cpuTurn() {
  const id = gameId;
  cpuRunning = true;
  refresh();
  await sleep(350);
  let guard = 0;
  while (id === gameId && game.current === CPU && game.winner < 0 && guard++ < 200) {
    const a = ai.next(game);
    if (a.kind === 'jump') {
      renderer.centerOn(a.from, { ifOffscreen: true });
      await sleep(renderer.busy() ? 450 : 0);
    }
    const ev = act(game, a);
    if (id !== gameId) return;
    if ('error' in ev) { act(game, { kind: 'end' }); break; } // shouldn't happen; never stall the game
    let wait = 120;
    for (const e of ev) {
      renderer.animate(e);
      narrate(e);
      if (e.type === 'jump') { wait = Math.max(wait, 700); if (e.landed >= 0) renderer.centerOn(e.landed, { ifOffscreen: true }); }
      if (e.type === 'combat' || e.type === 'flip' || e.type === 'pickup' || e.type === 'deliver') wait = Math.max(wait, 1100);
    }
    refresh();
    if (a.kind === 'end') break;
    await sleep(wait);
  }
  if (id !== gameId) return;
  cpuRunning = false;
  view.visited.clear();
  refresh();
  if (game.winner >= 0) gameOver();
  else if (game.current === YOU) renderer.fit([...mine().settlements, ...mine().stacks]);
}

function gameOver() {
  const w = game.winner;
  const by = game.winBy;
  $('over-title').textContent = w === YOU ? 'You win' : w === DRAW ? 'A draw' : 'The CPU wins';
  const text = by === 'relics' ? (w === YOU ? 'Three relics delivered.' : 'The CPU delivered three relics.')
    : by === 'elimination' ? (w === YOU ? 'The CPU has no settlements left.' : 'You have no settlements left.')
    : `Time ran out. Score: you ${scoreText(YOU)}, CPU ${scoreText(CPU)}.`;
  $('over-text').textContent = `${text} ${game.turn >> 1} rounds.`;
  setTimeout(() => /** @type {HTMLDialogElement} */ ($('over')).showModal(), 900 * pace);
}
const scoreText = (/** @type {number} */ c) => `${game.civs[c].relics} relics, ${game.owner.reduce((t, o, i) => t + (o === c ? game.value[i] : 0), 0)} value`;

// ------------------------------------------------------------------ selection

function deselect() {
  view.selected = -1;
  view.reach = new Set();
  view.far = new Set();
  view.preview = null;
  renderPanel();
  renderer.markDirty();
}

/** @param {number} cell @param {boolean} [keep] keep the aimed preview if it still works */
function select(cell, keep = false) {
  const aimed = keep && view.preview ? view.preview.to : -1;
  view.selected = cell;
  view.reach = new Set();
  view.far = new Set();
  view.preview = null;
  const s = stackAt(game, YOU, cell);
  if (s && s.ready > 0 && game.current === YOU && !cpuRunning) {
    if (!keep || view.send < 1 || view.send > s.ready) view.send = s.ready;
    const range = safeRange(game, YOU);
    const extra = game.owner[cell] === YOU ? range + 4 : range;
    for (const t of within(game.grid, cell, extra)) {
      if (t === cell) continue;
      const pv = preview(game, cell, t, view.send);
      if ('error' in pv) continue;
      (pv.over ? view.far : view.reach).add(t);
    }
    if (aimed >= 0) {
      const pv = preview(game, cell, aimed, view.send);
      if (!('error' in pv)) view.preview = pv;
    }
  }
  view.visited.add(cell);
  renderPanel();
  updateBar();
  renderer.markDirty();
  if (!keep) renderer.reveal([cell, ...view.reach], panel.hidden ? innerHeight : panel.getBoundingClientRect().top - 12);
}

/** Your settlements and stacks, as cells. */
function mine() {
  return {
    settlements: Array.from(game.owner, (o, c) => (o === YOU ? c : -1)).filter((c) => c >= 0),
    stacks: game.stacks.filter((s) => s.owner === YOU).map((s) => s.cell),
  };
}

/** Cells where you still have something to do, in cell order. */
function openCells() {
  const open = new Set();
  for (const s of game.stacks) {
    if (s.owner === YOU && (s.ready > 0 || !buildOptions(game, s.cell).found)) open.add(s.cell);
  }
  for (const c of mine().settlements) {
    const o = buildOptions(game, c);
    if (!o.build || !o.grow || o.research.some((x) => !x)) open.add(c);
  }
  return [...open].sort((a, b) => a - b);
}
const todo = () => openCells().filter((c) => !view.visited.has(c));

/** @param {number} cell */
function tap(cell) {
  if (cell < 0) { deselect(); return; }
  if (cpuRunning || game.winner >= 0) { select(cell); return; }
  const from = view.selected;
  const s = from >= 0 ? stackAt(game, YOU, from) : null;
  if (s && s.ready > 0 && cell !== from) {
    if (view.preview && view.preview.to === cell) { // tapping the aimed hex cancels; only Jump jumps
      view.preview = null;
      renderPanel();
      renderer.markDirty();
      return;
    }
    const pv = preview(game, from, cell, view.send);
    if (!('error' in pv)) {
      view.preview = pv;
      renderPanel();
      renderer.markDirty();
      return;
    }
    // not a jump: select what's there instead if it's yours, else say why not
    if (game.owner[cell] !== YOU && !stackAt(game, YOU, cell)) {
      toast(pv.error, 'bad');
      return;
    }
  }
  if (cell === from) { deselect(); return; }
  select(cell);
}

function doJump() {
  const pv = view.preview;
  if (!pv) return;
  const ev = playerAct({ kind: 'jump', from: pv.from, to: pv.to, n: pv.n });
  if (!ev || 'error' in ev) return;
  const j = ev.find((e) => e.type === 'jump');
  // follow the stack if it can go on, else stay put
  const landed = j && j.type === 'jump' ? j.landed : -1;
  const left = stackAt(game, YOU, pv.from);
  if (landed >= 0 && stackAt(game, YOU, landed)?.ready) select(landed);
  else if (left && left.ready > 0) select(pv.from);
  else if (landed >= 0 && stackAt(game, YOU, landed)) select(landed);
  else deselect();
  if (landed >= 0) renderer.centerOn(landed, { ifOffscreen: true });
}

function nextOpen() {
  const left = todo();
  if (!left.length) return;
  select(left.find((c) => c > view.selected) ?? left[0]);
}

// ------------------------------------------------------------------ panel

const panel = $('panel'), body = $('panel-body');
let researchOpen = false;
panel.addEventListener('toggle', (e) => { if (e.target instanceof HTMLDetailsElement) researchOpen = e.target.open; }, true);

function renderPanel() {
  const cell = view.selected;
  if (cell < 0 || !game) { panel.hidden = true; return; }
  panel.hidden = false;
  const g = game;
  const t = g.terrain[cell];
  const known = g.civs[YOU].known[cell];
  const parts = [];
  const worth = isCore(g, cell) ? '' : known ? ` · worth ${g.potential[cell]}` : ' · worth ?';
  const extras = [g.beacon[cell] ? 'beacon' : '', g.dust[cell] ? 'dust lane' : '', g.relicAt[cell] ? `relic${g.relicAt[cell] > 1 ? `s ×${g.relicAt[cell]}` : ''}` : ''].filter(Boolean).join(' · ');
  parts.push(`<h3>${TERRAIN_NAMES[t]}<span class="sub">${worth}${extras ? ` · ${extras}` : ''}</span><button class="close" data-act="close" aria-label="Close">×</button></h3>`);
  const yourTurn = g.current === YOU && !cpuRunning && g.winner < 0;

  // settlement
  const o = g.owner[cell];
  if (o >= 0) {
    const who = o === YOU ? (g.civs[YOU].home === cell ? 'Your home' : 'Your settlement') : (g.civs[CPU].home === cell ? 'CPU home' : 'CPU settlement');
    const potential = o === YOU || known ? ` of ${g.potential[cell]}` : '';
    parts.push(`<p><b>${who}</b>, value ${g.value[cell]}${potential}${besieged(g, cell) ? ' · <b>besieged</b>: makes nothing' : ''}.</p>`);
  } else if (t === VOID && known) {
    parts.push('<p>Empty space. Nothing can be settled here, but stacks can jump to it.</p>');
  } else if (isCore(g, cell)) {
    parts.push('<p>The core. Nothing can be settled here; a jump in or out that misses is fatal, and every fleet that ends a turn here risks the glare (1 in 6).</p>');
  }
  if (g.relicAt[cell]) parts.push('<p>A relic lies here. Hold the hex through the CPU\'s turn to pick it up.</p>');

  const foe = enemyAt(g, YOU, cell);
  if (foe) parts.push(`<p><b style="color:var(--cpu)">CPU stack</b>: ${band(foe.fleets)} fleets${foe.relics ? ', carrying a relic' : ''}.</p>`);

  const s = stackAt(g, YOU, cell);
  if (s) {
    const arrived = s.fleets - s.idle;
    const bits = [`${s.ready} ready to jump`];
    if (arrived > 0 && yourTurn) bits.push(`${arrived} arrived this turn`);
    parts.push(`<p><b style="color:var(--you)">Your stack</b>: ${s.fleets} fleet${s.fleets > 1 ? 's' : ''}${yourTurn ? ` (${bits.join(', ')})` : ''}${s.relics ? `, <b style="color:var(--gold)">carrying ${s.relics > 1 ? `${s.relics} relics` : 'a relic'}</b>` : ''}.</p>`);
    if (yourTurn && s.ready > 0) {
      if (s.ready > 1) {
        parts.push(`<div class="row"><span class="why">Send</span><span class="stepper"><button data-act="less" aria-label="Fewer">−</button><span>${view.send} of ${s.ready}</span><button data-act="more" aria-label="More">+</button></span></div>`);
      }
      const pv = view.preview;
      if (pv) {
        const pct = Math.round((pv.hits / 6) * 100);
        const lose = Math.round((pv.loseChance / 36) * 100);
        const cls = lose > 0 ? 'bad' : pct === 100 ? 'good' : 'risky';
        const maxScatter = pv.outcomes.reduce((m, x) => Math.max(m, x.scatter), 0);
        const maxLoss = pv.outcomes.reduce((m, x) => Math.max(m, x.lost ? pv.n : x.losses), 0);
        const notes = [];
        if (pct < 100) notes.push(`a miss scatters up to ${maxScatter} hex${maxScatter > 1 ? 'es' : ''}${maxLoss ? `, losing up to ${maxLoss >= pv.n ? 'everything' : `${maxLoss} fleet${maxLoss > 1 ? 's' : ''}`}` : ''}`);
        if (lose > 0) notes.push(`<b style="color:var(--bad)">${lose}% chance the stack is lost</b>`);
        if (pv.over) notes.push('over range: harder, and the move ends');
        if (pv.chain) notes.push('lands at your settlement: it can jump again');
        const target = enemyAt(g, YOU, pv.to) ? ' · <b>attack!</b>' : g.owner[pv.to] === CPU ? ' · try to take it' : '';
        parts.push(`<hr><div class="row"><span class="odds ${cls}">${pct}%</span><span class="why">on target · ${pv.dist} hex${pv.dist > 1 ? 'es' : ''} · roll ${pv.need}+${pv.bonus ? ` with ${pv.bonus > 0 ? '+' : ''}${pv.bonus}` : ''}${target}</span></div>`);
        if (notes.length) parts.push(`<p>${notes.join('; ')}.</p>`);
        parts.push(`<div class="row"><button class="act go" data-act="jump">Jump ${pv.n} fleet${pv.n > 1 ? 's' : ''}</button><button class="act" data-act="unaim">Cancel</button><span class="why">or tap the hex again to cancel</span></div>`);
      } else {
        parts.push('<p class="why">Tap a highlighted hex to aim. Blue: safe range. Gold: over range.</p>');
      }
    }
  }

  // building
  if (yourTurn && (o === YOU || s)) {
    const opts = buildOptions(g, cell);
    const btn = (/** @type {string} */ actName, /** @type {string} */ label, /** @type {string|null} */ why) =>
      `<button class="act" data-act="${actName}" ${why ? 'disabled' : ''} title="${why ?? ''}">${label}</button>`;
    const lines = [];
    if (o < 0 && s) lines.push(btn('found', `Settle (${g.params.foundCost} fleets)`, opts.found) + (opts.found ? `<span class="why">${opts.found}</span>` : ''));
    if (o === YOU) {
      lines.push(btn('build', `Build fleet (${g.params.fleetCost} RP)`, opts.build) + btn('grow', 'Grow +1 (1 fleet)', opts.grow));
      const fresh = g.founded[cell] === g.turn;
      if (fresh) lines.push('<span class="why">Ready next turn: until then it can\'t build or grow, launch long jumps, let stacks chain on, or take a relic.</span>');
      const why = [opts.build, opts.grow].filter((x) => x && !/^Not your/.test(x) && !(fresh && /^Founded this turn/.test(x)));
      if (why.length) lines.push(`<span class="why">${[...new Set(why)].join(' ')}</span>`);
    }
    if (lines.length) parts.push(`<hr>${lines.map((l) => `<div class="row">${l}</div>`).join('')}`);
    if (o === YOU) {
      const cards = g.civs[YOU].offer.map((tech, i) => {
        const cost = researchCost(g, YOU, tech);
        const why = opts.research[i];
        return `<button class="tech" data-act="research" data-pick="${i}" ${why ? 'disabled' : ''} title="${why ?? ''}"><b>${TECH_NAMES[tech]}</b><i>${TECH_TYPES[techType(tech)]}: ${TECH_EFFECTS[techType(tech)]}</i><i>Costs ${cost} fleet${cost > 1 ? 's' : ''} here</i></button>`;
      }).join('');
      const ready = opts.research.some((x) => !x);
      parts.push(`<details ${researchOpen ? 'open' : ''}><summary class="why">Research${ready ? '' : ' (needs fleets that began the turn here)'}</summary><div class="techs">${cards}</div></details>`);
    }
  }
  body.innerHTML = parts.join('');
}

panel.addEventListener('click', (e) => {
  const el = /** @type {HTMLElement|null} */ ((/** @type {HTMLElement} */ (e.target)).closest('[data-act]'));
  if (!el || /** @type {HTMLButtonElement} */ (el).disabled) return;
  const cell = view.selected;
  const s = stackAt(game, YOU, cell);
  switch (el.dataset.act) {
    case 'close': deselect(); break;
    case 'less': if (s) { view.send = Math.max(1, view.send - 1); select(cell, true); } break;
    case 'more': if (s) { view.send = Math.min(s.ready, view.send + 1); select(cell, true); } break;
    case 'jump': doJump(); break;
    case 'unaim': view.preview = null; renderPanel(); renderer.markDirty(); break;
    case 'found': playerAct({ kind: 'found', cell }); break;
    case 'build': playerAct({ kind: 'build', cell }); break;
    case 'grow': playerAct({ kind: 'grow', cell }); break;
    case 'research': playerAct({ kind: 'research', cell, pick: Number(el.dataset.pick) }); break;
  }
});

// ------------------------------------------------------------------ HUD and messages

function refresh() {
  if (!game) return;
  const side = (/** @type {number} */ c) => {
    const civ = game.civs[c];
    return `${ICONS.coin} ${civ.rp} · ${ICONS.flask} ${civ.techs.length} · <b>◆ ${civ.relics}/3</b>`;
  };
  $('hud-you').innerHTML = side(YOU);
  $('hud-cpu').innerHTML = side(CPU);
  $('hud-turn').textContent = game.winner >= 0 ? 'Game over' : cpuRunning || game.current === CPU ? 'CPU moving…' : `Round ${(game.turn >> 1) + 1}`;
  const endBtn = /** @type {HTMLButtonElement} */ ($('btn-end'));
  endBtn.disabled = cpuRunning || game.current !== YOU || game.winner >= 0;
  renderPanel();
  updateBar();
}

/** Next greys out and End turn pulses once everything open has been handled or visited. */
function updateBar() {
  const endBtn = /** @type {HTMLButtonElement} */ ($('btn-end'));
  const none = endBtn.disabled || todo().length === 0;
  endBtn.classList.toggle('pulse', !endBtn.disabled && none);
  /** @type {HTMLButtonElement} */ ($('btn-next')).disabled = none;
}

function openCompare() {
  const [a, b] = [YOU, CPU].map((c) => game.civs[c]);
  const row = (/** @type {string} */ name, /** @type {string} */ x, /** @type {string} */ y) => `<tr><th scope="row">${name}</th><td>${x}</td><td>${y}</td></tr>`;
  const techs = (/** @type {import('./sim.js').Civ} */ c) => (c.techs.length ? c.techs.map((t) => TECH_NAMES[t]).join(', ') : 'none');
  const lvl = (/** @type {number} */ c, /** @type {number} */ t) => {
    const n = level(game, c, t);
    return n ? `${n}: ${TECH_EFFECTS[t].replace('+1', `+${n}`)}` : '0';
  };
  $('compare-body').innerHTML = `<table><thead><tr><th></th><th class="you">You</th><th class="cpu">CPU</th></tr></thead><tbody>`
    + row('Banked RP', `${a.rp}`, `${b.rp}`)
    + row('Techs researched', `${a.techs.length}: ${techs(a)}`, `${b.techs.length}: ${techs(b)}`)
    + TECH_TYPES.map((k, t) => row(k, lvl(YOU, t), lvl(CPU, t))).join('')
    + row('Relics', `${a.relics}/3`, `${b.relics}/3`)
    + `</tbody></table><p class="hint">Levels count techs and delivered relics (each relic is +1 to all four).</p>`;
  dlg('compare').showModal();
}

/** @param {string} text @param {string} [kind] */
function toast(text, kind = '') {
  const box = $('toast');
  const el = document.createElement('div');
  el.textContent = text;
  if (kind) el.className = kind;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild?.remove();
  setTimeout(() => el.remove(), 3300);
}

/** Say what happened, briefly, when it matters. @param {GameEvent} e */
function narrate(e) {
  const mine = 'civ' in e && e.civ === YOU;
  switch (e.type) {
    case 'jump':
      if (e.lost) toast(mine ? `Lost in space: ${e.n} fleet${e.n > 1 ? 's' : ''}${e.relics ? ' and the relic, which returns to the core' : ''}.` : 'A CPU stack was lost in space.', mine ? 'bad' : 'cpu');
      else if (e.scatter && mine) toast(`Missed: scattered ${e.scatter} hex${e.scatter > 1 ? 'es' : ''}${e.losses ? `, lost ${e.losses}` : ''}.`, 'bad');
      break;
    case 'combat': {
      const youAtt = e.attacker === YOU;
      const [a, d] = e.after;
      const won = youAtt ? a > 0 : d > 0;
      toast(won ? 'You won the fight.' : 'You lost the fight.', won ? 'you' : 'cpu');
      break;
    }
    case 'flip':
      if (e.ok) toast(mine ? `Settlement taken!${e.tech >= 0 ? ` You learned ${TECH_NAMES[e.tech]}.` : ''}` : `The CPU took one of your settlements.${e.tech >= 0 ? ` It copied ${TECH_NAMES[e.tech]} (${TECH_TYPES[techType(e.tech)]}).` : ''}`, mine ? 'you' : 'cpu');
      else if (mine) toast(`Couldn't take it (rolled ${e.roll}, needed ${e.need}). Stay to try again next turn.`);
      break;
    case 'pickup': toast(mine ? 'Relic picked up! Get it to one of your settlements.' : 'The CPU picked up a relic!', 'gold'); break;
    case 'deliver': toast(mine ? `Relic delivered: ${e.total}/3. +1 to everything.` : `The CPU delivered a relic: ${e.total}/3.`, 'gold'); break;
    case 'drop': toast('A relic was dropped.', 'gold'); break;
    case 'respawn': toast('A new relic glows at the core.', 'gold'); break;
    case 'research':
      toast(mine ? `Learned ${TECH_NAMES[e.tech]}: ${TECH_EFFECTS[techType(e.tech)]}.` : `The CPU learned ${TECH_NAMES[e.tech]} (${TECH_TYPES[techType(e.tech)]}).`, mine ? 'you' : 'cpu');
      break;
    case 'hazard': toast(`The core's glare destroyed ${e.lost} ${mine ? '' : 'CPU '}fleet${e.lost > 1 ? 's' : ''}.`, mine ? 'bad' : 'cpu'); break;
    case 'income':
      if (e.civ === YOU && (e.upkeep || e.starved)) toast(`Income ${e.rp} RP, upkeep ${e.upkeep}${e.starved ? `: ${e.starved} unpaid fleet${e.starved > 1 ? 's' : ''} lost` : ''}.`, e.starved ? 'bad' : '');
      break;
    case 'eliminated': toast(e.civ === YOU ? 'You have no settlements left.' : 'The CPU has no settlements left!', e.civ === YOU ? 'bad' : 'you'); break;
  }
}

// ------------------------------------------------------------------ input

/** @type {Map<number, {x: number, y: number, sx: number, sy: number}>} */
const pointers = new Map();
let dragged = false;
let pinchDist = 0;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  if (pointers.size === 1) dragged = false;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    dragged = true;
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1) {
    if (!dragged && Math.hypot(p.x - p.sx, p.y - p.sy) > 8) dragged = true;
    if (dragged) renderer.pan(dx, dy);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) renderer.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    pinchDist = d;
  }
});
const up = (/** @type {PointerEvent} */ e) => {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (p && pointers.size === 0 && !dragged && e.type === 'pointerup') tap(renderer.cellAtScreen(e.clientX, e.clientY));
};
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  renderer.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') deselect();
  else if (e.key === 'Enter' && view.preview) doJump();
  else if (e.key === 'n') nextOpen();
});

$('btn-end').addEventListener('click', playerEnd);
$('btn-next').addEventListener('click', nextOpen);
for (const id of ['civ-you', 'civ-cpu']) $(id).addEventListener('click', () => { if (game) openCompare(); });
$('btn-home').addEventListener('click', () => {
  if (!game) return;
  renderer.centerOn(game.civs[YOU].home);
});

// ------------------------------------------------------------------ menus

const dlg = (/** @type {string} */ id) => /** @type {HTMLDialogElement} */ ($(id));

function openSettings() {
  const form = /** @type {HTMLFormElement} */ ($('settings-form'));
  for (const [k, v] of Object.entries(settings)) {
    const input = /** @type {HTMLInputElement|null} */ (form.querySelector(`input[name="${k}"][value="${v}"]`));
    if (input) input.checked = true;
  }
  dlg('settings').showModal();
}
dlg('settings').addEventListener('close', () => {
  if (dlg('settings').returnValue !== 'save') return;
  const form = /** @type {HTMLFormElement} */ ($('settings-form'));
  const data = Object.fromEntries(new FormData(form));
  settings = sanitize(data);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
});

$('start-new').addEventListener('click', () => { dlg('start').close(); newGame(); });
$('start-settings').addEventListener('click', openSettings);
const pages = [...document.querySelectorAll('#rules .page')];
let page = 0;
function showPage(/** @type {number} */ n) {
  page = Math.max(0, Math.min(pages.length - 1, n));
  pages.forEach((el, i) => { /** @type {HTMLElement} */ (el).hidden = i !== page; });
  $('page-num').textContent = `${page + 1} / ${pages.length}`;
  /** @type {HTMLButtonElement} */ ($('page-prev')).disabled = page === 0;
  /** @type {HTMLButtonElement} */ ($('page-next')).disabled = page === pages.length - 1;
}
$('page-prev').addEventListener('click', () => showPage(page - 1));
$('page-next').addEventListener('click', () => showPage(page + 1));
const openRules = () => { showPage(0); dlg('rules').showModal(); };
$('start-rules').addEventListener('click', openRules);
$('btn-menu').addEventListener('click', () => dlg('pause').showModal());
$('pause-resume').addEventListener('click', () => dlg('pause').close());
$('pause-new').addEventListener('click', () => { dlg('pause').close(); newGame(); });
$('pause-settings').addEventListener('click', openSettings);
$('pause-rules').addEventListener('click', openRules);
$('over-new').addEventListener('click', () => { dlg('over').close(); newGame(); });
$('over-look').addEventListener('click', () => { dlg('over').close(); renderer.overview(); });
dlg('start').addEventListener('cancel', (e) => e.preventDefault());

// ------------------------------------------------------------------ go

window.addEventListener('resize', () => renderer.resize());
renderer.resize();
newGame(true); // a galaxy behind the start menu
dlg('start').showModal();

function frame(/** @type {number} */ now) {
  view.busy = cpuRunning;
  renderer.draw(view, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
