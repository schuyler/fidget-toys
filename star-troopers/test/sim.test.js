import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, resolveTurn, checkOrder, squadSizes, los, preview, stateHash, idle, spendable, blastCells,
  fireLoss, meanFireShock, blastLoss, landChance, defenceOf, FIRE_CRT, LW_CRT, inCommand, canShare,
  cellAt, ROCK, RUINS, HIGH, BRUSH, BUILDING, DRAW, DEFAULTS,
} from '../src/sim.js';
import { createGrid, reflect, axialToIndex, linePairs } from '../src/hex.js';
import { createAI } from '../src/ai.js';

/**
 * Open 13×19 board with the given troopers (and optional terrain, hexes).
 * One-stage turns unless asked, so each resolveTurn is a whole turn.
 */
function board(troopers, extra = {}, params = {}) {
  return createGame({ stages: 1, ...params }, { troopers, ...extra });
}
const C = (col, row) => cellAt(createGrid(DEFAULTS.width, DEFAULTS.height), col, row);
/** Orders: { id: partial order } -> array by id. */
function orders(game, byId) {
  return game.troopers.map((t) => (byId[t.id] ? { ...idle(), ...byId[t.id] } : null));
}
const E = (c) => c + 1; // east neighbour within a row

test('reflecting across the centre row is a symmetry of the grid', () => {
  const g = createGrid(13, 19);
  for (let i = 0; i < g.N; i++) {
    assert.equal(reflect(g, reflect(g, i)), i);
    for (let d = 0; d < 6; d++) {
      const j = g.nbr[i * 6 + d];
      const k = g.nbr[reflect(g, i) * 6 + (6 - d) % 6]; // NE<->SE, NW<->SW
      assert.equal(k, j < 0 ? -1 : reflect(g, j));
    }
  }
});

test('line of sight: rock between blocks, cells at either end do not', () => {
  const game = board([], { terrain: [[C(5, 9), ROCK], [C(9, 9), ROCK]] });
  assert.equal(los(game, C(3, 9), C(7, 9)), false);
  assert.equal(los(game, C(6, 9), C(9, 9)), true);   // rock is the far end
  assert.equal(los(game, C(3, 7), C(7, 7)), true);
});

test('line of sight: ruins block, except to or from high ground', () => {
  const game = board([], { terrain: [[C(5, 9), RUINS], [C(7, 9), HIGH]] });
  assert.equal(los(game, C(3, 9), C(6, 9)), false);
  assert.equal(los(game, C(3, 9), C(7, 9)), true);
  const brush = board([], { terrain: [[C(5, 9), BRUSH]] });
  assert.equal(los(brush, C(3, 9), C(7, 9)), true);
});

test('buildings block line of sight even from high ground, and give cover 3', () => {
  const game = board([{ side: 0, cell: C(8, 9) }, { side: 1, cell: C(5, 9) }],
    { terrain: [[C(4, 9), BUILDING], [C(7, 9), HIGH], [C(5, 9), BUILDING]] });
  assert.equal(los(game, C(3, 9), C(7, 9)), false); // seen from high ground, still blocked
  assert.equal(los(game, C(8, 9), C(5, 9)), true);  // the target's own building doesn't block
  assert.equal(preview(game, game.troopers[0], game.troopers[1], 1).defence, 3 + 1);
});

test('the original cover table: open ground 1, buildings 6', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], { terrain: [[C(6, 8), BUILDING]] }, { cover: 'original' });
  // target in the open at range 4: cover 1 + range 2
  assert.equal(preview(game, game.troopers[0], game.troopers[1], 1).defence, 1 + 2);
  game.troopers[1].cell = C(6, 8);
  assert.equal(preview(game, game.troopers[0], game.troopers[1], 1).defence, 6 + 2);
});

test('victory hexes are buildings by default', () => {
  const game = createGame({ seed: 5 });
  assert.ok(game.victory.every((v) => game.terrain[v.cell] === BUILDING));
});

test('line of sight along an edge is blocked only if both cells block', () => {
  const g = createGrid(13, 19);
  const a = C(4, 8);
  const b = axialToIndex(g, g.q[a] + 1, g.r[a] + 1); // two steps, straight down an edge
  const [c1, c2] = linePairs(g, a, b)[1];
  assert.notEqual(c1, c2);
  assert.equal(los(board([], { terrain: [[c1, ROCK]] }), a, b), true);
  assert.equal(los(board([], { terrain: [[c1, ROCK], [c2, ROCK]] }), a, b), false);
});

test('line of sight is the same in both directions', () => {
  const game = createGame({ seed: 7, terrain: 'dense' });
  for (let i = 0; i < game.grid.N; i += 7) {
    for (let j = 0; j < game.grid.N; j += 11) assert.equal(los(game, i, j), los(game, j, i));
  }
});

test('the rules example: 6 points at range 4 deals 3, or 2 if the target dodges 2', () => {
  for (const [dodge, expected] of [[0, 3], [2, 2]]) {
    const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { recoverWhenHit: 0 });
    const ev = resolveTurn(game, orders(game, { 0: { target: 1, fire: 6 }, 1: { dodge } }));
    assert.equal(ev.shots[0].attack, 12);
    assert.equal(ev.shots[0].defence, 2 + 2 * dodge);
    assert.equal(game.troopers[1].shock, expected);
  }
});

test('a shot misses when attack is below defence, and the preview says so', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], { terrain: [[C(6, 9), RUINS]] });
  // attack 2 against cover 2 + range 2 = 4
  assert.deepEqual(preview(game, game.troopers[0], game.troopers[1], 1), { attack: 2, defence: 4, shock: 0, cancel: 0 });
  const ev = resolveTurn(game, orders(game, { 0: { target: 1, fire: 1 } }));
  assert.equal(ev.shots[0].miss, true);
  assert.equal(game.troopers[1].shock, 0);
});

test('fire is simultaneous: a trooper that goes down still shoots', () => {
  const game = board([{ side: 0, cell: C(2, 9), faction: 'vell' }, { side: 1, cell: C(4, 9), faction: 'vell' }]);
  const ev = resolveTurn(game, orders(game, { 0: { target: 1, fire: 6 }, 1: { target: 0, fire: 6 } }));
  assert.equal(ev.downs.length, 2);
  assert.equal(game.winner, DRAW);
});

test('two troopers stepping into the same cell are both blocked', () => {
  const game = board([{ side: 0, cell: C(4, 9) }, { side: 1, cell: C(6, 9) }]);
  resolveTurn(game, orders(game, { 0: { path: [C(5, 9), C(5, 8)] }, 1: { path: [C(5, 9)] } }));
  assert.equal(game.troopers[0].cell, C(4, 9));
  assert.equal(game.troopers[1].cell, C(6, 9));
});

test('swapping is blocked, following right behind is not', () => {
  const swap = board([{ side: 0, cell: C(4, 9) }, { side: 0, cell: C(5, 9) }]);
  resolveTurn(swap, orders(swap, { 0: { path: [C(5, 9)] }, 1: { path: [C(4, 9)] } }));
  assert.deepEqual(swap.troopers.map((t) => t.cell), [C(4, 9), C(5, 9)]);

  const follow = board([{ side: 0, cell: C(4, 9) }, { side: 0, cell: C(5, 9) }]);
  resolveTurn(follow, orders(follow, { 0: { path: [C(5, 9), C(6, 9)] }, 1: { path: [C(6, 9), C(7, 9)] } }));
  assert.deepEqual(follow.troopers.map((t) => t.cell), [C(6, 9), C(7, 9)]);
});

test('overwatch shoots the first enemy to move into view, and pins it', () => {
  // Rock hides the runner until it steps out at (6, 9).
  const game = board(
    [{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 7) }],
    { terrain: [[C(4, 8), ROCK], [C(5, 8), ROCK], [C(4, 7), ROCK], [C(3, 8), ROCK]] },
  );
  assert.equal(los(game, C(2, 9), C(6, 7)), false);
  const path = [C(6, 8), C(6, 9), C(6, 10), C(6, 11)];
  const ev = resolveTurn(game, orders(game, { 0: { overwatch: 4 }, 1: { path } }));
  assert.equal(ev.shots.length, 1);
  assert.equal(ev.shots[0].kind, 'overwatch');
  assert.ok(ev.shots[0].shock > 0);
  assert.deepEqual(ev.pinned, [1]);
  assert.ok(game.troopers[1].cell !== C(6, 11));
});

test('overwatch ignores enemies standing still and fires once per turn', () => {
  const game = board([
    { side: 0, cell: C(2, 9) },
    { side: 1, cell: C(5, 9) },               // in view, not moving
    { side: 1, cell: C(5, 11) },
    { side: 1, cell: C(7, 11) },
  ]);
  const ev = resolveTurn(game, orders(game, {
    0: { overwatch: 2 },
    2: { path: [C(5, 12), C(5, 13)] },
    3: { path: [C(7, 12), C(7, 13)] },
  }));
  const ow = ev.shots.filter((s) => s.kind === 'overwatch');
  assert.equal(ow.length, 1);
  assert.notEqual(ow[0].to, 1);
});

test('only troopers that were not hit recover (rule 6.31)', () => {
  const game = board([
    { side: 0, cell: C(2, 9), shock: 4 },
    { side: 1, cell: C(6, 9), shock: 4 },
  ]);
  resolveTurn(game, orders(game, { 0: { target: 1, fire: 3 } }));
  assert.equal(game.troopers[0].shock, 1);      // Compact recovers 3
  assert.equal(game.troopers[1].shock, 4 + 1);  // attack 6 - range 2 = 4, divided by 3
});

test('the recoverWhenHit knob lets troopers recover even when hit', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9), shock: 4 }], {}, { recoverWhenHit: 1 });
  resolveTurn(game, orders(game, { 0: { target: 1, fire: 3 } }));
  assert.equal(game.troopers[1].shock, 4 + 1 - 3);
});

test('dug in gives +1 defence until the trooper leaves its zone, even if it comes back', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 2), dugIn: true }]);
  const t = game.troopers[1];
  const dug = preview(game, game.troopers[0], t, 4).defence;
  t.dugIn = false;
  assert.equal(preview(game, game.troopers[0], t, 4).defence, dug - 1);
  t.dugIn = true;
  resolveTurn(game, orders(game, { 1: { path: [C(6, 3), C(6, 2)] } }));
  assert.equal(t.cell, C(6, 2));
  assert.equal(t.dugIn, false);
});

test('victory hexes: taken unless an enemy is adjacent, and they stay taken', () => {
  const hex = C(6, 9);
  const game = board(
    [{ side: 0, cell: hex }, { side: 1, cell: E(hex) }, { side: 1, cell: C(2, 2) }],
    // two more hexes far away, so taking this one doesn't end the game
    { victory: [{ cell: hex, owner: -1 }, { cell: C(0, 0), owner: -1 }, { cell: C(12, 18), owner: -1 }] },
  );
  resolveTurn(game, orders(game, {}));
  assert.equal(game.victory[0].owner, -1);    // contested
  resolveTurn(game, orders(game, { 1: { path: [E(E(hex))] } }));
  assert.equal(game.victory[0].owner, 0);
  resolveTurn(game, orders(game, { 0: { path: [C(6, 10)] }, 1: { path: [E(E(E(hex)))] } }));
  assert.equal(game.victory[0].owner, 0);     // sticky
});

test('Meeting: holding all three hexes wins; at the limit more hexes wins', () => {
  const hexes = [C(2, 9), C(6, 9), C(10, 9)];
  const game = board(
    [{ side: 0, cell: hexes[0] }, { side: 0, cell: hexes[1] }, { side: 0, cell: hexes[2] }, { side: 1, cell: C(6, 2) }],
    { victory: hexes.map((cell) => ({ cell, owner: -1 })) },
  );
  resolveTurn(game, orders(game, {}));
  assert.equal(game.winner, 0);

  const late = board(
    [{ side: 0, cell: hexes[0] }, { side: 1, cell: C(6, 2) }],
    { victory: hexes.map((cell) => ({ cell, owner: -1 })) },
    { turnLimit: 1 },
  );
  resolveTurn(late, orders(late, {}));
  assert.equal(late.winner, 0);

  const even = board([{ side: 0, cell: C(6, 15) }, { side: 1, cell: C(6, 2) }],
    { victory: hexes.map((cell) => ({ cell, owner: -1 })) }, { turnLimit: 1 });
  resolveTurn(even, orders(even, {}));
  assert.equal(even.winner, DRAW);
});

test('Assault: the attacker wins on holding two hexes, the defender at the limit', () => {
  const hexes = [C(2, 4), C(6, 4), C(10, 4)];
  const params = { scenario: 'assault', attacker: 0, turnLimit: 2 };
  const game = board(
    [{ side: 0, cell: hexes[0] }, { side: 0, cell: hexes[1] }, { side: 1, cell: C(10, 1) }],
    { victory: hexes.map((cell) => ({ cell, owner: 1 })) }, params,
  );
  resolveTurn(game, orders(game, {}));
  assert.equal(game.winner, 0);

  const held = board([{ side: 0, cell: C(6, 15) }, { side: 1, cell: C(10, 1) }],
    { victory: hexes.map((cell) => ({ cell, owner: 1 })) }, params);
  resolveTurn(held, orders(held, {}));
  assert.equal(held.winner, -1);
  resolveTurn(held, orders(held, {}));
  assert.equal(held.winner, 1);
});

test('orders are checked: points, paths, sight and the shot cap', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }],
    { terrain: [[C(3, 10), ROCK], [C(4, 9), ROCK]] }, { maxShot: 6 });
  const t = game.troopers[0];
  assert.equal(checkOrder(game, t, { ...idle(), dodge: 9 }), null);
  assert.equal(checkOrder(game, t, { ...idle(), dodge: 10 }), 'not enough points');
  assert.equal(checkOrder(game, t, { ...idle(), path: [C(3, 10)] }), 'illegal path');
  assert.equal(checkOrder(game, t, { ...idle(), path: [C(4, 7)] }), 'illegal path'); // not adjacent
  assert.equal(checkOrder(game, t, { ...idle(), target: 1, fire: 2 }), 'no line of sight');
  const open = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { maxShot: 6 });
  assert.equal(checkOrder(open, open.troopers[0], { ...idle(), target: 1, fire: 7 }), 'shot too big');
  assert.throws(() => resolveTurn(game, orders(game, { 0: { dodge: 10 } })));
});

test('the maxSpend knob caps points spent per turn, not the pool', () => {
  const game = board([{ side: 0, cell: C(2, 9), faction: 'orrin' }, { side: 1, cell: C(6, 9) }], {}, { maxSpend: 9 });
  const t = game.troopers[0];
  assert.equal(checkOrder(game, t, { ...idle(), dodge: 9 }), null);
  assert.equal(checkOrder(game, t, { ...idle(), dodge: 10 }), 'not enough points');
  assert.equal(t.pool, 12);
});

test('two stages: at most 6 points a stage, and the second gets what the first left', () => {
  const two = { stages: 2 };
  const game = createGame(two, { troopers: [{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9), faction: 'orrin' }] });
  const [c, o] = game.troopers;
  assert.equal(checkOrder(game, c, { ...idle(), dodge: 7 }), 'not enough points');
  resolveTurn(game, orders(game, { 0: { dodge: 6 }, 1: { dodge: 6 } }));
  assert.equal(game.stage, 2);
  assert.equal(game.turn, 1);
  assert.equal(spendable(game, c), 3);   // Compact: 9 - 6
  assert.equal(spendable(game, o), 6);   // Orrin: 12 - 6, capped at 6
  resolveTurn(game, orders(game, { 0: { dodge: 3 }, 1: { dodge: 6 } }));
  assert.deepEqual([game.turn, game.stage], [2, 1]);
  assert.equal(spendable(game, c), 6);   // a new game-turn
});

test('two stages: the turn limit counts game-turns, and recovery happens each stage', () => {
  const game = createGame({ stages: 2, turnLimit: 1 }, {
    troopers: [{ side: 0, cell: C(6, 15), shock: 6 }, { side: 1, cell: C(6, 2) }],
    victory: [{ cell: C(6, 9), owner: -1 }, { cell: C(2, 9), owner: -1 }, { cell: C(10, 9), owner: -1 }],
  });
  resolveTurn(game, orders(game, {}));
  assert.equal(game.winner, -1);                 // only stage 1 of turn 1
  assert.equal(game.troopers[0].shock, 3);
  resolveTurn(game, orders(game, {}));
  assert.equal(game.winner, DRAW);               // end of turn 1, nobody holds anything
  assert.equal(game.troopers[0].shock, 0);
});

test('a guided bomb that lands: 30 on the hex, 15 next door, 5 two away, friends included', () => {
  const game = board([
    { side: 0, cell: C(2, 9) },            // launcher
    { side: 1, cell: C(6, 9) },            // aimed at: 30 / 1 / 2.5 = 12, down
    { side: 1, cell: C(7, 9) },            // adjacent: 15 / 1 / 2.5 = 6
    { side: 1, cell: C(8, 9) },            // two away: 5 / 1 / 2.5 = 2
    { side: 0, cell: C(5, 9) },            // a friend, adjacent: 6
  ], {}, { blastOddsCap: 0 });
  const ev = resolveTurn(game, orders(game, { 0: { launch: 5, launchAt: C(6, 9) } }));
  assert.deepEqual(ev.launches, [{ from: 0, aimed: C(6, 9), landed: C(6, 9), sd: 10 - 1, die: 0 }]);
  assert.equal(game.troopers[1].down, true);
  assert.deepEqual([2, 3, 4].map((i) => game.troopers[i].shock), [6, 2, 6]);
});

test('blast odds are capped: a direct hit in the open is 10 to 1, not 30 to 1', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }, { side: 1, cell: C(8, 9) }], {}, { blastOddsCap: 10 });
  resolveTurn(game, orders(game, { 0: { launch: 5, launchAt: C(6, 9) } }));
  assert.equal(game.troopers[1].shock, 4);   // floor(10 / 2.5)
  assert.equal(game.troopers[2].shock, 2);   // 5 to 1, under the cap
});

test('blasts are shielded by woods and buildings, and hit a building direct for 2', () => {
  const game = board([], { terrain: [[C(7, 9), BUILDING], [C(5, 9), BRUSH]] });
  const reach = blastCells(game, C(6, 9)).map((b) => b.cell);
  assert.ok(!reach.includes(C(7, 9)) && !reach.includes(C(5, 9)));
  const hit = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], { terrain: [[C(6, 9), BUILDING]] });
  resolveTurn(hit, orders(hit, { 0: { launch: 5, launchAt: C(6, 9) } }));
  assert.equal(hit.troopers[1].shock, 2);
});

test('bombs go off after movement, so a target that moves away escapes', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }]);
  resolveTurn(game, orders(game, { 0: { launch: 5, launchAt: C(6, 9) }, 1: { path: [C(6, 8), C(6, 7), C(6, 6)] } }));
  assert.equal(game.troopers[1].shock, 0);
});

test('launch orders are checked, and a blast counts as being hit (no recovery)', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(8, 9), shock: 2 }]);
  const t = game.troopers[0];
  assert.equal(checkOrder(game, t, { ...idle(), launch: 2, launchAt: C(6, 9) }), 'launch too small');
  assert.equal(checkOrder(game, t, { ...idle(), launch: 6, launchAt: C(6, 9), dodge: 4 }), 'not enough points');
  assert.equal(checkOrder(game, t, { ...idle(), launch: 3, launchAt: -1 }), 'bad launch target');
  resolveTurn(game, orders(game, { 0: { launch: 5, launchAt: C(6, 9) } }));
  assert.equal(game.troopers[1].shock, 2 + 2);   // two away, and no recovery
});

test('bombs only scatter when the scatter differential is negative', () => {
  let scattered = 0;
  for (let seed = 1; seed <= 60; seed++) {
    // 3 points at Aim 2 = 6, against range 1 + the target's 9 dodge x 2 = 19: SD -13
    const bad = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { seed });
    const ev = resolveTurn(bad, orders(bad, { 0: { launch: 3, launchAt: C(6, 9) }, 1: { dodge: 9 } }));
    if (ev.launches[0].landed !== C(6, 9)) scattered++;
    const good = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { seed });
    assert.equal(resolveTurn(good, orders(good, { 0: { launch: 5, launchAt: C(6, 9) } })).launches[0].landed, C(6, 9));
  }
  assert.equal(scattered, 60);   // at -6 or worse the table always scatters
});

test('the 1977 fire table: averages in mean mode, a column value in dice mode, nothing under +1', () => {
  const mean = createGame({ combat: 'mean' }, { troopers: [] });
  assert.deepEqual([1, 3, 5, 9, 14].map((d) => fireLoss(mean, 10 + d, 10).shock), [1, 4, 6, 9, 9]);
  assert.deepEqual(fireLoss(mean, 10, 10), { shock: 0, miss: true, roll: 0 });
  assert.ok(Math.abs(meanFireShock({ ...DEFAULTS, combat: 'dice' }, 13, 10) - 155 / 36) < 1e-9);
  const dice = createGame({ combat: 'dice', seed: 3 }, { troopers: [] });
  const column = new Set(FIRE_CRT.map((row) => row[2]));
  for (let i = 0; i < 50; i++) assert.ok(column.has(fireLoss(dice, 13, 10).shock));
});

test('the 1977 launched weapons table: odds against the terrain value', () => {
  const g = createGame({ combat: 'mean' }, { troopers: [], terrain: [[C(6, 9), BUILDING]] });
  assert.equal(blastLoss(g, 30, C(2, 9)).shock, 8);   // 30 to 1 in the open: average 8.25
  assert.equal(blastLoss(g, 15, C(2, 9)).shock, 3);   // 15 to 1: average 3.2
  assert.equal(blastLoss(g, 30, C(6, 9)).shock, 1);   // 5 to 1 on a building: average 0.67
  assert.equal(blastLoss(g, 5, C(6, 9)).shock, 0);    // under 1 to 1: no effect
});

test('dice mode stuns, and a stunned trooper does not recover', () => {
  let stuns = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9), shock: 2 }],
      { terrain: [[C(6, 9), BUILDING]] }, { combat: 'dice', seed });
    const ev = resolveTurn(game, orders(game, { 0: { launch: 6, launchAt: C(6, 9) } }));
    if (ev.stunned.includes(1)) {
      stuns++;
      assert.equal(game.troopers[1].shock, 2);  // no loss, but no recovery either
    }
  }
  assert.ok(stuns >= 8 && stuns <= 32, `stunned ${stuns} of 60, expected about 18`);   // rolls of 6 or 7: 11 in 36
});

test('the 1977 scatter table: landing chances, and scatter of up to three hexes', () => {
  assert.deepEqual([0, -1, -2, -3, -4, -5, -6, -9].map(landChance), [1, 4 / 6, 3 / 6, 2 / 6, 2 / 6, 1 / 6, 0, 0]);
  const far = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const g = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { seed });
    const ev = resolveTurn(g, orders(g, { 0: { launch: 3, launchAt: C(6, 9) }, 1: { dodge: 9 } }));
    const { landed } = ev.launches[0];
    assert.notEqual(landed, C(6, 9));                // SD -13: always scatters
    if (landed >= 0) far.add(Math.max(Math.abs(g.grid.q[landed] - g.grid.q[C(6, 9)]), Math.abs(g.grid.r[landed] - g.grid.r[C(6, 9)])));
  }
  assert.ok([...far].every((d) => d >= 1 && d <= 3));
});

test('original defence: terrain value, 1 per ten hexes of range, 1 per point spent moving', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], { terrain: [[C(6, 9), BRUSH]] }, { defence: 'original' });
  const t = game.troopers[1];
  assert.equal(defenceOf(game, t, C(2, 9), null), 3 + 1);
  assert.equal(defenceOf(game, t, C(2, 9), { ...idle(), path: [C(7, 9)], moveCost: 1, dodge: 2 }), 3 + 1 + 1 + 4);
});

test('leaders: about 1 in 5 Compact, 3 in 7 Orrin, no Vell', () => {
  const lead = (f, n) => createGame({ seed: 4, faction0: f, squad0: n }).troopers.filter((t) => t.side === 0 && t.leader).length;
  assert.deepEqual([lead('compact', 6), lead('compact', 10), lead('orrin', 4), lead('orrin', 7), lead('vell', 8)], [1, 2, 2, 3, 0]);
});

test('in command: terrain value plus range rating to a leader, within current points', () => {
  const game = board([
    { side: 0, cell: C(2, 2), leader: true },
    { side: 0, cell: C(2, 12) },                 // open (1) + 10 cells (2) = 3 <= 9
    { side: 0, cell: C(6, 18) },                 // building (6) + about 17 cells (4) > 9
    { side: 0, cell: C(2, 17), shock: 5 },       // open (1) + 15 cells (3) = 4 <= 4
    { side: 1, cell: C(10, 10) },                // no leader on its side
    { side: 1, cell: C(11, 10), faction: 'vell' },
  ], { terrain: [[C(6, 18), BUILDING]] });
  assert.deepEqual(game.troopers.map((t) => inCommand(game, t)), [true, true, false, true, false, true]);
});

test('with command on, troopers in command fire first, and their hits cut the others\' shots', () => {
  const setup = (command) => board(
    [{ side: 0, cell: C(2, 9), faction: 'vell' }, { side: 1, cell: C(4, 9) }],  // the Compact trooper has no leader
    {}, { command },
  );
  const both = setup(0);
  let ev = resolveTurn(both, orders(both, { 0: { target: 1, fire: 6 }, 1: { target: 0, fire: 6 } }));
  assert.equal(ev.shots.length, 2);
  const cmd = setup(1);
  ev = resolveTurn(cmd, orders(cmd, { 0: { target: 1, fire: 6 }, 1: { target: 0, fire: 6 } }));
  // The Vell's shot (attack 24 against 1) takes 7, more than the 6 the Compact had in its shot.
  assert.equal(ev.shots.length, 1);
  assert.equal(ev.shots[0].from, 0);
});

test('a trooper hit by fire still gets its launch off in the same part of the stage', () => {
  const game = board([{ side: 0, cell: C(2, 9), faction: 'vell' }, { side: 1, cell: C(4, 9) }, { side: 0, cell: C(9, 3) }]);
  const ev = resolveTurn(game, orders(game, { 0: { target: 1, fire: 6 }, 1: { launch: 3, launchAt: C(9, 3) } }));
  assert.equal(ev.launches.length, 1);
});

const V = 'vell';

test('swarms: up to three Vell share a cell; nobody else does', () => {
  const g = createGame({ swarm: 1, faction0: V, squad0: 7 });
  const vell = g.troopers.filter((t) => t.side === 0);
  const cells = new Map();
  for (const t of vell) cells.set(t.cell, (cells.get(t.cell) ?? 0) + 1);
  assert.deepEqual([...cells.values()], [3, 3, 1]);
  const [a, b, c, d] = vell;
  assert.ok(canShare(g, [a, b, c]) && !canShare(g, [a, b, c, d]));
  const compact = g.troopers.filter((t) => t.side === 1);
  assert.ok(!canShare(g, [compact[0], compact[1]]) && !canShare(g, [a, compact[0]]));
  assert.ok(!canShare(createGame({ faction0: V }), createGame({ faction0: V }).troopers.slice(0, 2)));
});

test('swarms move together, and a fourth Vell or a Compact trooper can\'t join', () => {
  const at = C(4, 9), to = C(5, 9);
  const game = board([
    { side: 0, cell: at, faction: V }, { side: 0, cell: at, faction: V }, { side: 0, cell: at, faction: V },
    { side: 0, cell: C(5, 10), faction: V }, { side: 0, cell: C(6, 10) },
    { side: 1, cell: C(6, 1) },
  ], {}, { swarm: 1 });
  resolveTurn(game, orders(game, { 0: { path: [to] }, 1: { path: [to] }, 2: { path: [to] }, 3: { path: [to] }, 4: { path: [to] } }));
  // all five wanted one cell: nobody gets in, since together they can't share
  assert.deepEqual(game.troopers.slice(0, 5).map((t) => t.cell), [at, at, at, C(5, 10), C(6, 10)]);
  resolveTurn(game, orders(game, { 0: { path: [to] }, 1: { path: [to] }, 2: { path: [to] } }));
  assert.deepEqual(game.troopers.slice(0, 3).map((t) => t.cell), [to, to, to]);
});

test('a swarm pools its dodge, and pools a shot when all three plot the same one', () => {
  const at = C(2, 9);
  const mk = () => board([
    { side: 0, cell: at, faction: V }, { side: 0, cell: at, faction: V }, { side: 0, cell: at, faction: V },
    { side: 1, cell: C(8, 9) },
  ], {}, { swarm: 1, combat: 'mean' });
  const game = mk();
  // three shots of 2 points (attack 8 each) pool into one of attack 24
  let ev = resolveTurn(game, orders(game, { 0: { target: 3, fire: 2 }, 1: { target: 3, fire: 2 }, 2: { target: 3, fire: 2 } }));
  assert.deepEqual(ev.shots.map((x) => x.attack), [24]);
  const split = mk();
  ev = resolveTurn(split, orders(split, { 0: { target: 3, fire: 2 }, 1: { target: 3, fire: 2 }, 2: { target: 3, fire: 1 } }));
  assert.deepEqual(ev.shots.map((x) => x.attack), [8, 8, 4]);
  // the Compact shoots back at one of them: two of the swarm dodging 1 each (x4) protects all three
  const dodge = mk();
  ev = resolveTurn(dodge, orders(dodge, { 0: { dodge: 1 }, 1: { dodge: 1 }, 3: { target: 2, fire: 6 } }));
  assert.ok(ev.shots.every((x) => x.defence === 3 + 8));   // open 0 + range 3 (6 cells / 2) + pooled dodge 8
});

test('fire at a swarm hits every member, each separately', () => {
  const at = C(6, 9);
  const game = board([
    { side: 0, cell: at, faction: V }, { side: 0, cell: at, faction: V }, { side: 0, cell: at, faction: V },
    { side: 1, cell: C(2, 9) },
  ], {}, { swarm: 1 });
  const ev = resolveTurn(game, orders(game, { 3: { target: 1, fire: 6 } }));
  assert.deepEqual(ev.shots.map((x) => x.to).sort(), [0, 1, 2]);
});

test('Assault squads: the attacker fields at least 1.2x the defender\'s value', () => {
  const a = { ...DEFAULTS, scenario: 'assault', attacker: 0 };
  assert.deepEqual(squadSizes({ ...a }), [5, 4]);                                         // 70 vs 56
  assert.deepEqual(squadSizes({ ...a, faction0: 'orrin' }), [5, 4]);                      // 75 vs 56
  assert.deepEqual(squadSizes({ ...a, faction0: 'vell', faction1: 'orrin' }), [6, 4]);    // 84 vs 60
  assert.deepEqual(squadSizes({ ...a, attacker: 1, faction0: 'orrin' }), [4, 6]);         // 84 vs 60 (70 < 72)
  assert.deepEqual(squadSizes({ ...DEFAULTS }), [4, 4]);
});

test('squad0 and squad1 set each side\'s squad size in Meeting', () => {
  assert.deepEqual(squadSizes({ ...DEFAULTS, squad0: 6, squad1: 3 }), [6, 3]);
  const game = createGame({ seed: 2, squad0: 6, squad1: 3 });
  assert.deepEqual([0, 1].map((s) => game.troopers.filter((t) => t.side === s).length), [6, 3]);
});

test('generated Meeting maps are mirror images top to bottom', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const game = createGame({ seed, terrain: 'dense' });
    const g = game.grid;
    for (let i = 0; i < g.N; i++) assert.equal(game.terrain[i], game.terrain[reflect(g, i)]);
    const [s0, s1] = [0, 1].map((s) => game.troopers.filter((t) => t.side === s).map((t) => t.cell));
    assert.deepEqual(s1, s0.map((c) => reflect(g, c)));
    for (const v of game.victory) assert.equal(reflect(g, v.cell), v.cell);
  }
});

test('Assault defenders start dug in and owning the hexes', () => {
  const game = createGame({ seed: 3, scenario: 'assault', attacker: 0 });
  assert.ok(game.victory.every((v) => v.owner === 1));
  assert.ok(game.troopers.filter((t) => t.side === 1).every((t) => t.dugIn));
  assert.ok(game.troopers.filter((t) => t.side === 0).every((t) => !t.dugIn));
});

/** Plays a whole CPU-vs-CPU game, returning the game. */
function playOut(params, seeds) {
  const game = createGame(params);
  const ais = [createAI(0, seeds[0]), createAI(1, seeds[1])];
  const trace = [];
  while (game.winner < 0) {
    const a = ais[0].plan(game), b = ais[1].plan(game);
    for (const t of game.troopers) {
      const o = (t.side === 0 ? a : b)[t.id];
      if (o) assert.equal(checkOrder(game, t, o), null);
    }
    resolveTurn(game, game.troopers.map((t) => (t.side === 0 ? a : b)[t.id]));
    trace.push(game.troopers.map((t) => [t.cell, t.shock, t.down]));
  }
  return { game, trace };
}

test('same seeds, same game; and the CPU only gives legal orders', () => {
  for (const scenario of ['meeting', 'assault']) {
    const x = playOut({ seed: 42, scenario, noise: 1 }, [5, 6]).game;
    const y = playOut({ seed: 42, scenario, noise: 1 }, [5, 6]).game;
    assert.equal(stateHash(x), stateHash(y));
  }
});

test('no side advantage: identical CPUs on a mirrored map play mirror-image games', () => {
  // Without bombs: a scattering bomb picks its direction at random, so with
  // them on, the two sides' games stop being exact mirror images by chance.
  for (const seed of [11, 12, 13]) {
    const { game, trace } = playOut({ seed, launched: 0 }, [99, 99]);
    const g = game.grid;
    const n = game.troopers.length / 2;
    for (const turn of trace) {
      for (let i = 0; i < n; i++) {
        const [c0, s0, d0] = turn[i], [c1, s1, d1] = turn[i + n];
        assert.equal(c1, reflect(g, c0));
        assert.equal(s1, s0);
        assert.equal(d1, d0);
      }
    }
  }
});

// ---- R14: dice rolls are recorded in the events, without changing the game ----

test('R14: a dice shot that hits records its two-dice roll, and the shock is that row of the table', () => {
  const rolls = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    // 6 points at Aim 2 = 12 against open ground (1) at range 4 (1): differential +10, column +9
    const g = board([{ side: 0, cell: C(6, 12) }, { side: 1, cell: C(6, 8) }], {}, { combat: 'dice', defence: 'original', seed });
    const ev = resolveTurn(g, orders(g, { 0: { target: 1, fire: 6 } }));
    const shot = ev.shots[0];
    assert.ok(Number.isInteger(shot.roll) && shot.roll >= 2 && shot.roll <= 12, `roll ${shot.roll}`);
    assert.equal(shot.shock, FIRE_CRT[shot.roll - 2][8]);
    rolls.add(shot.roll);
  }
  assert.ok(rolls.size > 3);
});

test('R14: no dice, no roll: a miss under dice, and any shot under the formula, record roll 0', () => {
  // 1 point at Aim 2 = 2 against open (1) + range (1) + 3 dodge at Aim 2 (6): a miss
  const miss = board([{ side: 0, cell: C(6, 12) }, { side: 1, cell: C(6, 8) }], {}, { combat: 'dice', defence: 'original' });
  const ev = resolveTurn(miss, orders(miss, { 0: { target: 1, fire: 1 }, 1: { dodge: 3 } }));
  assert.equal(ev.shots[0].miss, true);
  assert.equal(ev.shots[0].roll, 0);
  const formula = board([{ side: 0, cell: C(6, 12) }, { side: 1, cell: C(6, 8) }]);
  assert.equal(resolveTurn(formula, orders(formula, { 0: { target: 1, fire: 6 } })).shots[0].roll, 0);
});

test('R14: blast shots record their roll and whether they stunned', () => {
  let stuns = 0;
  for (let seed = 1; seed <= 80; seed++) {
    // a direct hit on brush (terrain 3): 30 / 3 = 10 to 1, column 6-10
    const g = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], { terrain: [[C(6, 9), BRUSH]] }, { combat: 'dice', seed });
    const ev = resolveTurn(g, orders(g, { 0: { launch: 5, launchAt: C(6, 9) } }));
    const shot = ev.shots.find((s) => s.kind === 'blast' && s.to === 1);
    assert.ok(shot && shot.roll >= 2 && shot.roll <= 12);
    const cell = LW_CRT[shot.roll - 2][1];
    assert.equal(shot.stun, cell === -1);
    assert.equal(shot.shock, cell === -1 ? 0 : cell);
    assert.equal(ev.stunned.includes(1), shot.stun);
    if (shot.stun) stuns++;
  }
  assert.ok(stuns > 0);
});

test('R14: a launch records its scatter die: 1-6 when it needed a roll, 0 when it could not miss', () => {
  const dice = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const bad = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { seed });
    const ev = resolveTurn(bad, orders(bad, { 0: { launch: 3, launchAt: C(6, 9) }, 1: { dodge: 9 } }));
    assert.ok(ev.launches[0].sd < 0);
    assert.ok(ev.launches[0].die >= 1 && ev.launches[0].die <= 6);
    dice.add(ev.launches[0].die);
    const good = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9) }], {}, { seed });
    assert.equal(resolveTurn(good, orders(good, { 0: { launch: 5, launchAt: C(6, 9) } })).launches[0].die, 0);
  }
  assert.ok(dice.size > 2);
});

test('R14: recording rolls changes nothing: a seeded CPU game ends in the same state as before', () => {
  const g = createGame({ combat: 'dice', defence: 'original', command: 1, faction0: 'compact', squad0: 6, faction1: 'vell', squad1: 6, swarm: 1, seed: 4242 });
  const ais = [createAI(0, 1), createAI(1, 2)];
  for (let n = 0; n < 9; n++) {
    const o = [];
    for (const ai of ais) ai.plan(g).forEach((x, i) => { if (x) o[i] = x; });
    resolveTurn(g, o);
  }
  assert.equal(stateHash(g), 4010343239); // recorded before the change
});

test('the preview\'s cancelling dodge follows the combat setting: under the tables a shot needs +1 to hurt', () => {
  // Compact (Aim 2) at a Compact in the open 4 cells away: original defence 1 + 1 = 2.
  const dice = board([{ side: 0, cell: C(6, 12) }, { side: 1, cell: C(6, 8) }], {}, { combat: 'dice', defence: 'original' });
  const [a, b] = dice.troopers;
  assert.equal(preview(dice, a, b, 1).cancel, 0);   // 2 against 2: already no loss
  assert.equal(preview(dice, a, b, 3).cancel, 2);   // 6 against 2: dodge 2 makes it 6 against 6
  assert.equal(preview(dice, a, b, 2).cancel, 1);   // 4 against 2: dodge 1 is enough
  // the formula needs attack below defence
  const formula = board([{ side: 0, cell: C(6, 12) }, { side: 1, cell: C(6, 8) }], {}, { defence: 'original' });
  assert.equal(preview(formula, formula.troopers[0], formula.troopers[1], 1).cancel, 1);
  assert.equal(preview(formula, formula.troopers[0], formula.troopers[1], 2).cancel, 2);
});
