import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, cellAt, idle, checkOrder, pathCost, preview, blastCells, landChance, meanBlastShock, los, spendable,
  COVER_ORIGINAL, BLAST, ROCK, BRUSH, BUILDING, RUINS, DEFAULTS,
} from '../src/sim.js';
import { createGrid, hexDist } from '../src/hex.js';
import {
  unitsFor, budget, used, free, reachable, route, visibleEnemies, setDestination, setFire, adjust, coverOf,
  shotPreview, bombPreview, repeatLast, holdWatch, toCover, fallBack, bombAt, ordersFor, lastFor,
} from '../src/plot.js';

// The playtest rules (R2), two stages a turn.
const RULES = { combat: 'dice', defence: 'original', command: 1 };
const C = (col, row) => cellAt(createGrid(DEFAULTS.width, DEFAULTS.height), col, row);
const make = (troopers, extra = {}, params = {}) => createGame({ ...RULES, ...params }, { troopers, ...extra });
const unitOf = (game, id) => /** @type {any} */ (unitsFor(game, game.troopers[id].side).find((u) => u.ids.includes(id)));
const draft = (o = {}) => ({ ...idle(), ...o });

/** Every member's order is legal. */
function legal(game, unit, d) {
  for (const id of unit.ids) assert.equal(checkOrder(game, game.troopers[id], d), null, `trooper ${id}: ${JSON.stringify(d)}`);
}

/** Every simple path from `start` of up to `n` steps, avoiding rock (brute force, for checking route()). */
function allPaths(game, start, n) {
  const out = [];
  const walk = (at, acc) => {
    if (acc.length) out.push(acc.slice());
    if (acc.length === n) return;
    for (let d = 0; d < 6; d++) {
      const c = game.grid.nbr[at * 6 + d];
      if (c < 0 || c === start || acc.includes(c) || game.terrain[c] === ROCK) continue;
      acc.push(c); walk(c, acc); acc.pop();
    }
  };
  walk(start, []);
  return out;
}
const exposure = (game, path, foes) => path.filter((c) => foes.some((f) => los(game, f.cell, c))).length;

// ---- Units (R12) ----

test('R12: each trooper is its own unit; a Vell swarm sharing a cell is one unit led by its lowest id', () => {
  const g = make([
    { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 0, cell: C(3, 15), faction: 'vell' },
    { side: 0, cell: C(8, 15), faction: 'vell' }, { side: 1, cell: C(6, 3) },
  ], {}, { swarm: 1, faction0: 'vell' });
  const units = unitsFor(g, 0);
  assert.equal(units.length, 2);
  assert.deepEqual(units[0], { lead: 0, ids: [0, 1, 2], cell: C(3, 15) });
  assert.deepEqual(units[1], { lead: 3, ids: [3], cell: C(8, 15) });
  assert.deepEqual(unitsFor(g, 1), [{ lead: 4, ids: [4], cell: C(6, 3) }]);
});

test('R12: a unit\'s budget is its most-hurt member\'s spendable points', () => {
  const g = make([
    { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 0, cell: C(3, 15), faction: 'vell', shock: 4 }, { side: 1, cell: C(6, 3) },
  ], {}, { swarm: 1, faction0: 'vell' });
  const u = unitOf(g, 0);
  assert.equal(budget(g, u), spendable(g, g.troopers[1]));
  assert.equal(budget(g, u), 2);
});

test('R12: ordersFor copies a unit\'s plot to every member, and leaves undrafted troopers idle', () => {
  const g = make([
    { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 0, cell: C(3, 15), faction: 'vell' },
    { side: 0, cell: C(8, 15), faction: 'vell' }, { side: 1, cell: C(6, 3) },
  ], {}, { swarm: 1, faction0: 'vell' });
  const d = draft({ dodge: 2 });
  const orders = ordersFor(g, 0, new Map([[0, d]]));
  assert.equal(orders.length, g.troopers.length);
  assert.deepEqual(orders[0], d);
  assert.deepEqual(orders[1], d);
  assert.notEqual(orders[1], orders[0]); // a copy, not shared
  assert.equal(orders[2], null);
  assert.equal(orders[3], null);
});

test('lastFor finds a swarm\'s last orders by any member, so they survive the lead going down', () => {
  const g = make([
    { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 0, cell: C(3, 15), faction: 'vell' }, { side: 1, cell: C(6, 3) },
  ], {}, { swarm: 1, faction0: 'vell' });
  const d = draft({ dodge: 3 });
  // main stores a unit's orders under every member
  const last = new Map([[0, d], [1, d], [2, d]]);
  g.troopers[0].down = true;
  const u = unitOf(g, 1);
  assert.equal(u.lead, 1);
  assert.deepEqual(lastFor(last, u), d);
});

// ---- Selection: move range and sight (R5) ----

test('R5: reachable costs open 1, brush 2; rock, other troopers\' cells and cells beyond the budget are out', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 0, cell: C(7, 14) }, { side: 1, cell: C(6, 3) }],
    { terrain: [[C(5, 14), BRUSH], [C(6, 13), ROCK]] });
  const cost = reachable(g, unitOf(g, 0), 3);
  assert.equal(cost[C(6, 14)], 0);
  assert.equal(cost[C(5, 14)], 2);   // brush
  assert.equal(cost[C(6, 13)], -1);  // rock
  assert.equal(cost[C(7, 14)], -1);  // a friend stands there
  assert.equal(cost[C(4, 14)], 3);   // through brush (2) then open (1)
  assert.equal(cost[C(6, 10)], -1);  // four steps away: beyond 3
  for (let c = 0; c < g.grid.N; c++) if (cost[c] > 3) assert.fail(`cell ${c} costs ${cost[c]}`);
});

test('R5: with swarms on, a lone Vell may join two others, but a pair may not (four can\'t share)', () => {
  const g = make([
    { side: 0, cell: C(6, 14), faction: 'vell' },
    { side: 0, cell: C(8, 14), faction: 'vell' }, { side: 0, cell: C(8, 14), faction: 'vell' },
    { side: 0, cell: C(7, 15), faction: 'vell' }, { side: 0, cell: C(7, 15), faction: 'vell' },
    { side: 1, cell: C(6, 3) },
  ], {}, { swarm: 1, faction0: 'vell' });
  assert.equal(reachable(g, unitOf(g, 0), 6)[C(8, 14)], 2);
  assert.equal(reachable(g, unitOf(g, 1), 6)[C(7, 15)], -1);
});

test('R5: visibleEnemies are the foes in line of sight from where the unit stands', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }, { side: 1, cell: C(2, 14) }],
    { terrain: [[C(4, 14), ROCK]] });
  assert.deepEqual(visibleEnemies(g, unitOf(g, 0)), [1]);
});

// ---- Moving (R6, R7) ----

test('R6: route is the cheapest path, and among the cheapest the one least in enemy sight', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(9, 8) }],
    { terrain: [[C(7, 11), BUILDING], [C(8, 11), BUILDING], [C(7, 12), BUILDING]] });
  const u = unitOf(g, 0);
  const foes = [g.troopers[1]];
  const cost = reachable(g, u, 6);
  for (const dest of [C(6, 12), C(9, 13), C(4, 13)]) {
    const cheapest = allPaths(g, C(6, 14), 4).filter((p) => p[p.length - 1] === dest)
      .map((p) => ({ p, cost: pathCost(g, C(6, 14), p), exp: exposure(g, p, foes) }));
    const min = Math.min(...cheapest.map((x) => x.cost));
    const ties = cheapest.filter((x) => x.cost === min);
    assert.ok(Math.min(...ties.map((x) => x.exp)) < Math.max(...ties.map((x) => x.exp)), 'fixture has a real choice');
    const r = /** @type {number[]} */ (route(g, u, dest));
    assert.equal(r[r.length - 1], dest);
    assert.equal(pathCost(g, C(6, 14), r), min);
    assert.equal(pathCost(g, C(6, 14), r), cost[dest]);
    assert.equal(exposure(g, r, foes), Math.min(...ties.map((x) => x.exp)));
  }
});

test('R6: setDestination plots the route; dropping on the trooper itself clears the move', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }]);
  const u = unitOf(g, 0);
  const d = /** @type {any} */ (setDestination(g, u, draft({ dodge: 1 }), C(6, 12)));
  assert.equal(d.path.length, 2);
  assert.equal(d.path[1], C(6, 12));
  assert.equal(d.dodge, 1);
  legal(g, u, d);
  const back = /** @type {any} */ (setDestination(g, u, d, C(6, 14)));
  assert.deepEqual(back.path, []);
  assert.equal(back.dodge, 1);
});

test('R7: a move that needs more than the free points takes them from dodge first, then watch; fire is untouched', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }]);
  const u = unitOf(g, 0);
  assert.equal(budget(g, u), 6);
  const start = draft({ target: 1, fire: 2, dodge: 2, overwatch: 2 });
  const d = /** @type {any} */ (setDestination(g, u, start, C(6, 11))); // 3 cells of open ground
  assert.deepEqual([d.fire, d.dodge, d.overwatch], [2, 0, 1]);
  assert.equal(used(g, u, d), 6);
  legal(g, u, d);
});

test('R7: a destination costing more than the points not in fire or launch is refused', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }]);
  const u = unitOf(g, 0);
  const start = draft({ target: 1, fire: 2, dodge: 2 });
  assert.equal(setDestination(g, u, start, C(6, 9)), null);   // 5 cells: only 4 points aren't in the shot
  assert.notEqual(setDestination(g, u, start, C(6, 10)), null);
  assert.equal(setDestination(g, u, start, C(0, 0)), null);   // nowhere near
  // a launch is never cut to make room either
  const bomb = draft({ launch: 3, launchAt: C(6, 8), dodge: 1 });
  assert.equal(setDestination(g, u, bomb, C(6, 10)), null);    // 4 cells: only 3 points aren't in the bomb
  const ok = /** @type {any} */ (setDestination(g, u, bomb, C(6, 11)));
  assert.deepEqual([ok.launch, ok.dodge], [3, 0]);
});

// ---- Points (R8, R9) ----

test('R8: setFire aims at a visible enemy, within the free points', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }, { side: 1, cell: C(2, 14) }],
    { terrain: [[C(4, 14), ROCK]] });
  const u = unitOf(g, 0);
  const d = /** @type {any} */ (setFire(g, u, draft({ dodge: 2 }), 1, 9));
  assert.deepEqual([d.target, d.fire, d.dodge], [1, 4, 2]);
  legal(g, u, d);
});

test('R9: adjust keeps every task between 0 and the free points', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }]);
  const u = unitOf(g, 0);
  let d = draft();
  for (let i = 0; i < 10; i++) d = adjust(g, u, d, 'dodge', 1);
  assert.equal(d.dodge, 6);
  d = adjust(g, u, d, 'overwatch', 1);
  assert.equal(d.overwatch, 0);
  d = adjust(g, u, adjust(g, u, d, 'dodge', -2), 'overwatch', 1);
  assert.deepEqual([d.dodge, d.overwatch], [4, 1]);
  for (let i = 0; i < 10; i++) d = adjust(g, u, d, 'overwatch', -1);
  assert.equal(d.overwatch, 0);
  assert.equal(free(g, u, d), 2);
  legal(g, u, d);
});

test('R9: launch points can\'t be added before a cell is aimed at, and step between 0 and the minimum', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }]);
  const u = unitOf(g, 0);
  assert.equal(adjust(g, u, draft(), 'launch', 1).launch, 0);
  let d = draft({ launchAt: C(6, 8) });
  d = adjust(g, u, d, 'launch', 1);
  assert.equal(d.launch, 3);
  d = adjust(g, u, d, 'launch', 1);
  assert.equal(d.launch, 4);
  legal(g, u, d);
  d = adjust(g, u, adjust(g, u, d, 'launch', -1), 'launch', -1);
  assert.equal(d.launch, 0);
  legal(g, u, d);
  // too few points for the minimum: no launch
  const tired = make([{ side: 0, cell: C(6, 14), shock: 7 }, { side: 1, cell: C(6, 3) }]);
  const tu = unitOf(tired, 0);
  assert.equal(adjust(tired, tu, draft({ launchAt: C(6, 8) }), 'launch', 1).launch, 0);
  // fire needs a target first
  assert.equal(adjust(g, u, draft(), 'fire', 1).fire, 0);
});

test('coverOf is the cover term the defence uses under the playtest rules: the original table', () => {
  const g = make([], { terrain: [[C(1, 1), BRUSH], [C(2, 1), BUILDING], [C(3, 1), RUINS]] });
  assert.deepEqual([C(0, 1), C(1, 1), C(2, 1), C(3, 1)].map((c) => coverOf(g, c)), [COVER_ORIGINAL[0], COVER_ORIGINAL[1], COVER_ORIGINAL[5], COVER_ORIGINAL[2]]);
});

// ---- Previews (R8, R9) ----

test('R8: a single trooper\'s shot preview is the sim\'s preview', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }], { terrain: [[C(6, 8), BRUSH]] });
  const p = shotPreview(g, unitOf(g, 0), 1, 5);
  const s = preview(g, g.troopers[0], g.troopers[1], 5);
  assert.deepEqual({ attack: p.attack, defence: p.defence, shock: p.shock, cancel: p.cancel }, s);
  assert.deepEqual(p.victims, [1]);
});

test('R8: a swarm of three pools one shot at three times the attack; a pair fires two shots', () => {
  const sw = { swarm: 1, faction0: 'vell', faction1: 'terrans' };
  const three = make([
    { side: 0, cell: C(6, 14), faction: 'vell' }, { side: 0, cell: C(6, 14), faction: 'vell' }, { side: 0, cell: C(6, 14), faction: 'vell' },
    { side: 1, cell: C(6, 8) },
  ], {}, sw);
  const single = make([{ side: 0, cell: C(6, 14), faction: 'vell' }, { side: 1, cell: C(6, 8) }], {}, sw);
  const p3 = shotPreview(three, unitOf(three, 0), 3, 1);
  assert.equal(p3.attack, 3 * 1 * 4);
  assert.equal(p3.shock, preview(single, single.troopers[0], single.troopers[1], 3).shock); // 12 attack either way
  const two = make([
    { side: 0, cell: C(6, 14), faction: 'vell' }, { side: 0, cell: C(6, 14), faction: 'vell' }, { side: 1, cell: C(6, 8) },
  ], {}, sw);
  const p2 = shotPreview(two, unitOf(two, 0), 2, 2);
  assert.ok(p2.shock > 0);
  assert.equal(p2.shock, 2 * preview(single, single.troopers[0], single.troopers[1], 2).shock);
});

test('R8: fire hits everyone in the target\'s cell, so the preview sums over every occupant', () => {
  const sw = { swarm: 1, faction0: 'terrans', faction1: 'vell' };
  const g = make([
    { side: 0, cell: C(6, 14) },
    { side: 1, cell: C(6, 8), faction: 'vell' }, { side: 1, cell: C(6, 8), faction: 'vell' }, { side: 1, cell: C(6, 8), faction: 'vell' },
  ], {}, sw);
  const p = shotPreview(g, unitOf(g, 0), 2, 6);
  const one = preview(g, g.troopers[0], g.troopers[2], 6).shock;
  assert.ok(one > 0);
  assert.deepEqual(p.victims, [1, 2, 3]);
  assert.equal(p.shock, 3 * one);
});

test('R9: the bomb preview shows the blast footprint, the landing chance counting friendly dodge, and who it hits', () => {
  const g = make([
    { side: 0, cell: C(6, 14) }, { side: 0, cell: C(9, 14) },
    { side: 1, cell: C(6, 8) }, { side: 1, cell: C(7, 8) },
  ]);
  const u = unitOf(g, 0);
  const at = C(6, 8);
  // the friend at (9,14) stays put and dodges 3: not in the footprint, so it doesn't count
  const drafts = new Map([[1, draft({ dodge: 3 })]]);
  const p = bombPreview(g, u, at, 3, drafts);
  assert.deepEqual(p.cells.map((x) => x.cell).sort((a, b) => a - b), blastCells(g, at).map((x) => x.cell).sort((a, b) => a - b));
  const sd = 2 * 3 - Math.ceil(hexDist(g.grid, C(6, 14), at) / 5);
  assert.equal(p.land, landChance(sd));
  assert.deepEqual(p.hits.map((h) => h.id).sort(), [2, 3]);
  assert.equal(p.hits.find((h) => h.id === 2).shock, meanBlastShock(g, BLAST[0], at));
  assert.equal(p.friendly, false);
  // a friend standing next to the target is in the footprint: warned, and its dodge counts against landing
  const g2 = make([{ side: 0, cell: C(6, 14) }, { side: 0, cell: C(6, 9) }, { side: 1, cell: C(6, 8) }]);
  const p2 = bombPreview(g2, unitOf(g2, 0), C(6, 8), 3, new Map([[1, draft({ dodge: 3 })]]));
  assert.equal(p2.friendly, true);
  assert.equal(p2.land, landChance(2 * 3 - Math.ceil(hexDist(g2.grid, C(6, 14), C(6, 8)) / 5) - 3 * 2));
  assert.ok(p2.land < 1);
});

// ---- Presets (R10) ----

test('R10: Hold + watch: no move, a third into dodge, the rest into overwatch', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }]);
  const u = unitOf(g, 0);
  const d = /** @type {any} */ (holdWatch(g, u));
  assert.deepEqual([d.path.length, d.dodge, d.overwatch, d.fire, d.launch], [0, 2, 4, 0, 0]);
  legal(g, u, d);
});

test('R10: To cover: moves to cover in reach nearest a victory hex we don\'t hold, the rest into dodge', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }], {
    terrain: [[C(2, 13), BRUSH], [C(6, 12), BRUSH], [C(6, 6), BUILDING]],
    victory: [{ cell: C(6, 6), owner: -1 }],
  });
  const u = unitOf(g, 0);
  const d = /** @type {any} */ (toCover(g, u));
  assert.equal(d.path[d.path.length - 1], C(6, 12)); // brush nearer the hex than (2,13)
  assert.equal(d.dodge, budget(g, u) - pathCost(g, C(6, 14), d.path));
  legal(g, u, d);
  // nothing in reach: no preset
  const bare = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }], { victory: [{ cell: C(6, 6), owner: -1 }] });
  assert.equal(toCover(bare, unitOf(bare, 0)), null);
});

test('R10: Fall back: moves out of every enemy\'s sight, the rest into dodge', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }], {
    terrain: [[C(4, 13), ROCK], [C(4, 12), ROCK], [C(5, 12), ROCK]],
  });
  const u = unitOf(g, 0);
  const d = /** @type {any} */ (fallBack(g, u));
  const end = d.path.length ? d.path[d.path.length - 1] : C(6, 14);
  assert.equal(los(g, C(6, 8), end), false);
  assert.equal(d.dodge, budget(g, u) - pathCost(g, C(6, 14), d.path));
  legal(g, u, d);
});

test('R10: Bomb at: the fewest points that land it if nobody dodges, the rest into dodge; none with under 3 points', () => {
  const g = make([{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 8) }]);
  const u = unitOf(g, 0);
  const d = /** @type {any} */ (bombAt(g, u, draft(), C(6, 8)));
  assert.deepEqual([d.launch, d.launchAt, d.dodge], [3, C(6, 8), 3]); // 3 x Aim 2 = 6 beats range rating 2
  legal(g, u, d);
  // it keeps the move and shot already plotted, and the rest becomes dodge
  const kept = /** @type {any} */ (bombAt(g, u, draft({ path: [C(6, 13)], target: 1, fire: 1, dodge: 1 }), C(6, 8)));
  assert.deepEqual([kept.path.length, kept.fire, kept.launch, kept.dodge], [1, 1, 3, 1]);
  legal(g, u, kept);
  assert.equal(bombAt(g, u, draft({ target: 1, fire: 4 }), C(6, 8)), null); // only 2 points left
  const tired = make([{ side: 0, cell: C(6, 14), shock: 7 }, { side: 1, cell: C(6, 8) }]);
  assert.equal(bombAt(tired, unitOf(tired, 0), draft(), C(6, 8)), null);
});

test('R10: Repeat last: same target, fire, dodge and watch, no move, launch points into dodge, shrunk to fit', () => {
  const g = make([{ side: 0, cell: C(6, 14), shock: 4 }, { side: 1, cell: C(6, 8) }]);
  const u = unitOf(g, 0);
  assert.equal(budget(g, u), 5);
  const last = draft({ path: [C(6, 13)], target: 1, fire: 3, dodge: 1, overwatch: 1, launch: 0 });
  const d = /** @type {any} */ (repeatLast(g, u, last));
  assert.deepEqual([d.path.length, d.target, d.fire, d.dodge, d.overwatch], [0, 1, 3, 1, 1]);
  legal(g, u, d);
  // too big for the budget: dodge goes first, then watch, then fire
  const big = /** @type {any} */ (repeatLast(g, u, draft({ target: 1, fire: 4, dodge: 2, overwatch: 2 })));
  assert.deepEqual([big.fire, big.dodge, big.overwatch], [4, 0, 1]);
  // a launch becomes dodge
  const bomb = /** @type {any} */ (repeatLast(g, u, draft({ launch: 3, launchAt: C(6, 8), dodge: 1 })));
  assert.deepEqual([bomb.launch, bomb.dodge], [0, 4]);
  legal(g, u, bomb);
  // a target that's gone: its fire points go to dodge
  g.troopers[1].down = true;
  const gone = /** @type {any} */ (repeatLast(g, u, last));
  assert.deepEqual([gone.target, gone.fire, gone.dodge, gone.overwatch], [-1, 0, 4, 1]);
});

test('R9: every preset and adjustment produces legal orders, in a busy random position', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = createGame({ ...RULES, seed, faction0: 'vell', faction1: 'orrin', squad0: 6, squad1: 4, swarm: seed % 2 });
    for (const u of unitsFor(g, 0)) {
      const foes = visibleEnemies(g, u);
      const ds = [holdWatch(g, u), toCover(g, u), fallBack(g, u), bombAt(g, u, draft(), g.troopers[unitsFor(g, 1)[0].lead].cell)];
      if (foes.length) ds.push(setFire(g, u, draft(), foes[0], 99));
      for (const d of ds.filter(Boolean)) {
        legal(g, u, d);
        legal(g, u, adjust(g, u, d, 'dodge', 1));
        legal(g, u, adjust(g, u, d, 'overwatch', 3));
        legal(g, u, repeatLast(g, u, d));
      }
    }
  }
});
