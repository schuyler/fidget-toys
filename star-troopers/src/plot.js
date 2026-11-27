// @ts-check
// Drafting orders in the interface. Everything here is a pure function of
// the game and a draft: nothing mutates the game, and every draft returned
// is a legal order for each trooper in its unit (or null, for "can't").
// See RULES.md, Controls.

import {
  living, spendable, pathCost, enterCost, los, occupants, canShare, idle, defenceOf, meanFireShock, cancelDodge,
  dodgeValue, blastCells, meanBlastShock, landChance, coverValue, BLAST, ROCK, OPEN, COVER, COVER_ORIGINAL,
} from './sim.js';
import { hexDist } from './hex.js';

/** @typedef {import('./sim.js').Game} Game */
/** @typedef {import('./sim.js').Trooper} Trooper */
/** @typedef {import('./sim.js').Order} Order */
/**
 * One counter on the board: a trooper, or a Vell swarm sharing a cell, which
 * is plotted once for all its members.
 * @typedef {{ lead: number, ids: number[], cell: number }} Unit
 */

/** A side's units, in trooper order. A swarm is led by its lowest id. */
export function unitsFor(/** @type {Game} */ game, /** @type {number} */ side) {
  const mine = living(game, side);
  /** @type {Unit[]} */
  const out = [];
  const done = new Set();
  for (const t of mine) {
    if (done.has(t.id)) continue;
    const group = game.params.swarm ? mine.filter((m) => m === t || (m.cell === t.cell && canShare(game, [t, m]))) : [t];
    for (const m of group) done.add(m.id);
    out.push({ lead: t.id, ids: group.map((m) => m.id), cell: t.cell });
  }
  return out;
}

const members = (/** @type {Game} */ game, /** @type {Unit} */ u) => u.ids.map((id) => game.troopers[id]);

/** Points the unit can spend this stage: its most-hurt member's. */
export function budget(/** @type {Game} */ game, /** @type {Unit} */ u) {
  return Math.min(...members(game, u).map((t) => spendable(game, t)));
}

/** Points a draft spends. */
export function used(/** @type {Game} */ game, /** @type {Unit} */ u, /** @type {Order} */ d) {
  return pathCost(game, u.cell, d.path) + d.fire + d.dodge + d.overwatch + (d.launch ?? 0);
}

/** Points a draft leaves unspent. */
export function free(/** @type {Game} */ game, /** @type {Unit} */ u, /** @type {Order} */ d) {
  return budget(game, u) - used(game, u, d);
}

/** Can the unit step into this cell? Not rock, and not where others stand unless they could all share. */
function passable(/** @type {Game} */ game, /** @type {Unit} */ u, /** @type {number} */ cell) {
  if (game.terrain[cell] === ROCK) return false;
  const others = occupants(game, cell).filter((o) => !u.ids.includes(o.id));
  return !others.length || canShare(game, [...members(game, u), ...others]);
}

/**
 * Cheapest paths over the unit's passable cells, ordered by points and then
 * by a tie-break cost per cell entered.
 * @param {Game} game @param {Unit} u @param {number} limit  most points to spend
 * @param {(cell: number) => number} tie
 */
function search(game, u, limit, tie) {
  const N = game.grid.N;
  const key = new Float64Array(N).fill(Infinity);
  const cost = new Int32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  const doneCell = new Uint8Array(N);
  key[u.cell] = 0;
  cost[u.cell] = 0;
  // Small boards: a linear scan for the next cell is plenty.
  for (;;) {
    let c = -1;
    for (let i = 0; i < N; i++) if (!doneCell[i] && key[i] < Infinity && (c < 0 || key[i] < key[c])) c = i;
    if (c < 0) break;
    doneCell[c] = 1;
    for (let d = 0; d < 6; d++) {
      const n = game.grid.nbr[c * 6 + d];
      if (n < 0 || doneCell[n] || !passable(game, u, n)) continue;
      const nc = cost[c] + enterCost(game, c, n);
      if (nc > limit) continue;
      // points dominate; the tie-break never adds up to a whole point
      const k = nc * 10000 + (key[c] - cost[c] * 10000) + tie(n);
      if (k < key[n]) { key[n] = k; cost[n] = nc; prev[n] = c; }
    }
  }
  return { cost, prev };
}

/** Move cost to every cell within `maxCost` points (-1 = out of reach). */
export function reachable(/** @type {Game} */ game, /** @type {Unit} */ u, /** @type {number} */ maxCost) {
  return search(game, u, Math.max(0, maxCost), () => 0).cost;
}

/** Is a cell in sight of any living enemy of this unit? */
function exposed(/** @type {Game} */ game, /** @type {Unit} */ u, /** @type {number} */ cell) {
  const side = game.troopers[u.lead].side;
  return living(game, 1 - side).some((f) => los(game, f.cell, cell));
}

/**
 * The route to a cell: the cheapest by points, and among those the one
 * that spends the fewest cells in enemy sight. null if it can't get there.
 * @param {Game} game @param {Unit} u @param {number} dest
 * @returns {number[] | null}
 */
export function route(game, u, dest) {
  if (dest === u.cell) return [];
  const seen = new Map();
  const { cost, prev } = search(game, u, Infinity, (c) => {
    if (!seen.has(c)) seen.set(c, exposed(game, u, c) ? 1 : 0);
    return seen.get(c);
  });
  if (cost[dest] < 0) return null;
  const path = [];
  for (let c = dest; c !== u.cell; c = prev[c]) path.push(c);
  return path.reverse();
}

/** Enemies the unit can see from where it stands (and so can shoot this stage). */
export function visibleEnemies(/** @type {Game} */ game, /** @type {Unit} */ u) {
  const side = game.troopers[u.lead].side;
  return living(game, 1 - side).filter((f) => los(game, u.cell, f.cell)).map((f) => f.id);
}

/**
 * Plot a move to `dest` (the unit's own cell clears the move). A move
 * needing more than the free points takes them from dodge, then overwatch;
 * fire and launch points are never touched, so a move that needs them is
 * refused (null).
 * @param {Game} game @param {Unit} u @param {Order} d @param {number} dest
 * @returns {Order | null}
 */
export function setDestination(game, u, d, dest) {
  const path = route(game, u, dest);
  if (!path) return null;
  const move = pathCost(game, u.cell, path);
  if (move > budget(game, u) - d.fire - (d.launch ?? 0)) return null;
  const nd = { ...d, path };
  let over = Math.max(0, used(game, u, nd) - budget(game, u));
  const fromDodge = Math.min(over, nd.dodge);
  nd.dodge -= fromDodge;
  over -= fromDodge;
  nd.overwatch -= over;
  return nd;
}

/**
 * Aim at an enemy with up to `points`, within the free points. null if the
 * unit can't see it.
 * @param {Game} game @param {Unit} u @param {Order} d @param {number} target @param {number} points
 * @returns {Order | null}
 */
export function setFire(game, u, d, target, points) {
  if (!visibleEnemies(game, u).includes(target)) return null;
  const base = { ...d, target, fire: 0 };
  return { ...base, fire: Math.max(0, Math.min(points, free(game, u, base))) };
}

/**
 * Change one task's points by `delta`, within 0 and the free points. Fire
 * needs a target first; a launch needs a cell, and steps between nothing
 * and the minimum launch.
 * @param {Game} game @param {Unit} u @param {Order} d
 * @param {'fire'|'dodge'|'overwatch'|'launch'} key @param {number} delta
 * @returns {Order}
 */
export function adjust(game, u, d, key, delta) {
  const room = free(game, u, d);
  if (key === 'fire' && d.target < 0) return d;
  if (key === 'launch') {
    const cur = d.launch ?? 0;
    const min = game.params.minLaunch;
    if ((d.launchAt ?? -1) < 0) return d;
    if (delta > 0) {
      if (cur === 0) return room >= min ? { ...d, launch: min } : d;
      return { ...d, launch: cur + Math.min(delta, room) };
    }
    return { ...d, launch: cur + delta < min ? 0 : cur + delta };
  }
  const cur = d[key];
  return { ...d, [key]: Math.max(0, Math.min(cur + room, cur + delta)) };
}

/** The cover term a shot's defence uses for this cell, under the game's defence setting. */
export function coverOf(/** @type {Game} */ game, /** @type {number} */ cell) {
  return game.params.defence === 'original'
    ? COVER_ORIGINAL[game.terrain[cell]] * game.params.coverScale
    : coverValue(game, cell);
}
const openCover = (/** @type {Game} */ game) => (game.params.defence === 'original' ? COVER_ORIGINAL[OPEN] : COVER[OPEN]) * game.params.coverScale;

/**
 * What a shot would do if the target stood still and didn't dodge. A swarm
 * of three fires one pooled shot at three times the attack; a pair fires
 * two shots. Fire hits everyone in the target's cell, so the expected loss
 * is summed over them. `cancel` is the dodge that would make the target
 * itself unhittable.
 * @param {Game} game @param {Unit} u @param {number} targetId @param {number} points
 */
export function shotPreview(game, u, targetId, points) {
  const shooter = game.troopers[u.lead];
  const target = game.troopers[targetId];
  const n = u.ids.length;
  const shots = n === 3 ? 1 : n;
  const attack = points * shooter.aim * (n === 3 ? 3 : 1);
  const victims = occupants(game, target.cell);
  let shock = 0;
  for (const v of victims) shock += shots * meanFireShock(game.params, attack, defenceOf(game, v, shooter.cell, null));
  const defence = defenceOf(game, target, shooter.cell, null);
  return { attack, defence, shock, cancel: cancelDodge(game.params, attack, defence, target.aim), victims: victims.map((v) => v.id) };
}

/** Where each of a side's troopers will end the stage, by its draft (or where it stands). */
function plannedEnds(/** @type {Game} */ game, /** @type {number} */ side, /** @type {Map<number, Order>} */ drafts) {
  /** @type {{t: Trooper, end: number, dodge: number}[]} */
  const out = [];
  for (const u of unitsFor(game, side)) {
    const d = drafts.get(u.lead);
    const end = d && d.path.length ? d.path[d.path.length - 1] : u.cell;
    for (const t of members(game, u)) out.push({ t, end, dodge: d ? d.dodge : 0 });
  }
  return out;
}

/**
 * A bomb at `cell`: the blast's reach, the chance it lands where aimed
 * (counting the dodge of our own troopers that will end up in the blast;
 * enemy dodge is unknown), the expected loss to enemies standing there now,
 * and whether any of ours will be in the blast.
 * @param {Game} game @param {Unit} u @param {number} cell @param {number} points @param {Map<number, Order>} drafts
 */
export function bombPreview(game, u, cell, points, drafts) {
  const shooter = game.troopers[u.lead];
  const cells = blastCells(game, cell);
  const dist = new Map(cells.map((c) => [c.cell, c.dist]));
  let cm = 0, friendly = false;
  for (const { t, end, dodge } of plannedEnds(game, shooter.side, drafts)) {
    if (!dist.has(end)) continue;
    friendly = true;
    cm += dodgeValue(game, t, dodge);
  }
  const sd = shooter.aim * points - (Math.ceil(hexDist(game.grid, u.cell, cell) / 5) + cm);
  const hits = living(game, 1 - shooter.side)
    .filter((f) => dist.has(f.cell))
    .map((f) => ({ id: f.id, shock: meanBlastShock(game, BLAST[/** @type {number} */ (dist.get(f.cell))], f.cell) }));
  return { cells, land: landChance(sd), hits, friendly };
}

// ---- Quick orders ----

/** Hold + watch: stay put, a third into dodge, the rest into overwatch. */
export function holdWatch(/** @type {Game} */ game, /** @type {Unit} */ u) {
  const b = budget(game, u);
  const dodge = Math.floor(b / 3);
  return { ...idle(), dodge, overwatch: b - dodge };
}

/** A move to `end`, with every point left over in dodge. */
function moveAndDodge(/** @type {Game} */ game, /** @type {Unit} */ u, /** @type {number} */ end) {
  const path = /** @type {number[]} */ (route(game, u, end));
  return { ...idle(), path, dodge: budget(game, u) - pathCost(game, u.cell, path) };
}

/**
 * To cover: the cover in reach nearest a victory hex this side doesn't
 * hold (any hex, if it holds them all), then the best cover, then the
 * cheapest; the rest into dodge. null if there's no cover in reach.
 * @param {Game} game @param {Unit} u
 */
export function toCover(game, u) {
  const side = game.troopers[u.lead].side;
  const cost = reachable(game, u, budget(game, u));
  let hexes = game.victory.filter((v) => v.owner !== side).map((v) => v.cell);
  if (!hexes.length) hexes = game.victory.map((v) => v.cell);
  const near = (/** @type {number} */ c) => (hexes.length ? Math.min(...hexes.map((h) => hexDist(game.grid, c, h))) : 0);
  let best = -1;
  for (let c = 0; c < game.grid.N; c++) {
    if (cost[c] < 0 || coverOf(game, c) <= openCover(game)) continue;
    if (best < 0 || near(c) < near(best) || (near(c) === near(best)
      && (coverOf(game, c) > coverOf(game, best) || (coverOf(game, c) === coverOf(game, best) && cost[c] < cost[best])))) best = c;
  }
  return best < 0 ? null : moveAndDodge(game, u, best);
}

/**
 * Fall back: a cell in reach out of every enemy's sight, with the best
 * cover, then the cheapest, then the farthest from them; the rest into
 * dodge. A trooper nobody hits recovers. null if there's nowhere hidden.
 * @param {Game} game @param {Unit} u
 */
export function fallBack(game, u) {
  const side = game.troopers[u.lead].side;
  const foes = living(game, 1 - side);
  const cost = reachable(game, u, budget(game, u));
  const away = (/** @type {number} */ c) => Math.min(...foes.map((f) => hexDist(game.grid, c, f.cell)));
  let best = -1;
  for (let c = 0; c < game.grid.N; c++) {
    if (cost[c] < 0 || foes.some((f) => los(game, f.cell, c))) continue;
    if (best < 0) { best = c; continue; }
    const dc = coverOf(game, c) - coverOf(game, best);
    if (dc > 0 || (dc === 0 && (cost[c] < cost[best] || (cost[c] === cost[best] && away(c) > away(best))))) best = c;
  }
  return best < 0 ? null : moveAndDodge(game, u, best);
}

/**
 * Bomb at a cell, keeping the move, shot and overwatch already plotted: the
 * fewest points that land it if nobody dodges near it (or all it has), and
 * whatever's left into dodge. null if there aren't enough points for a launch.
 * @param {Game} game @param {Unit} u @param {Order} d @param {number} cell
 * @returns {Order | null}
 */
export function bombAt(game, u, d, cell) {
  const base = { ...d, launch: 0, launchAt: cell, dodge: 0 };
  const avail = free(game, u, base);
  const min = game.params.minLaunch;
  if (avail < min) return null;
  const aim = game.troopers[u.lead].aim;
  const rating = Math.ceil(hexDist(game.grid, u.cell, cell) / 5);
  let k = avail;
  for (let p = min; p <= avail; p++) if (aim * p - rating >= 0) { k = p; break; }
  return { ...base, launch: k, dodge: avail - k };
}

/**
 * Repeat last orders: the same target (if it's still there and in sight),
 * fire, dodge and overwatch, without the move; launch points (and fire at a
 * lost target) go into dodge. Shrunk to fit: dodge first, then overwatch,
 * then fire.
 * @param {Game} game @param {Unit} u @param {Order} last
 * @returns {Order}
 */
export function repeatLast(game, u, last) {
  const keep = last.target >= 0 && last.fire > 0 && visibleEnemies(game, u).includes(last.target);
  const d = {
    ...idle(),
    target: keep ? last.target : -1,
    fire: keep ? last.fire : 0,
    dodge: last.dodge + (keep ? 0 : last.fire) + (last.launch ?? 0),
    overwatch: last.overwatch,
  };
  let over = used(game, u, d) - budget(game, u);
  for (const k of /** @type {const} */ (['dodge', 'overwatch', 'fire'])) {
    const take = Math.max(0, Math.min(over, d[k]));
    d[k] -= take;
    over -= take;
  }
  return d;
}

/**
 * Orders for a whole side, indexed by trooper id: each unit's draft copied
 * to every member; null (idle) where there's no draft.
 * @param {Game} game @param {number} side @param {Map<number, Order>} drafts
 * @returns {(Order|null)[]}
 */
export function ordersFor(game, side, drafts) {
  /** @type {(Order|null)[]} */
  const out = game.troopers.map(() => null);
  for (const u of unitsFor(game, side)) {
    const d = drafts.get(u.lead);
    if (d) for (const id of u.ids) out[id] = { ...d, path: d.path.slice() };
  }
  return out;
}

/**
 * A unit's last committed orders, found by any member (main stores them
 * under every member), so they survive a swarm's lead going down.
 * @param {Map<number, Order>} last @param {Unit} u
 */
export function lastFor(last, u) {
  for (const id of u.ids) {
    const d = last.get(id);
    if (d) return d;
  }
  return undefined;
}
