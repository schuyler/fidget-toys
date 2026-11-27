import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, resolveTurn, checkOrder, squadSizes, los, preview, stateHash, idle,
  cellAt, ROCK, RUINS, HIGH, BRUSH, BUILDING, DRAW, DEFAULTS,
} from '../src/sim.js';
import { createGrid, reflect, axialToIndex, linePairs } from '../src/hex.js';
import { createAI } from '../src/ai.js';

/** Open 13×19 board with the given troopers (and optional terrain, hexes). */
function board(troopers, extra = {}, params = {}) {
  return createGame(params, { troopers, ...extra });
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

test('with recoverWhenHit off, only troopers that were not hit recover', () => {
  const game = board([
    { side: 0, cell: C(2, 9), shock: 4 },
    { side: 1, cell: C(6, 9), shock: 4 },
  ], {}, { recoverWhenHit: 0 });
  resolveTurn(game, orders(game, { 0: { target: 1, fire: 3 } }));
  assert.equal(game.troopers[0].shock, 1);      // Compact recovers 3
  assert.equal(game.troopers[1].shock, 4 + 1);  // attack 6 - range 2 = 4, divided by 3
});

test('by default troopers recover every turn, hit or not', () => {
  const game = board([{ side: 0, cell: C(2, 9) }, { side: 1, cell: C(6, 9), shock: 4 }]);
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

test('Assault squads: the attacker fields at least 1.2x the defender\'s value', () => {
  const a = { ...DEFAULTS, scenario: 'assault', attacker: 0 };
  assert.deepEqual(squadSizes({ ...a }), [5, 4]);                                         // 70 vs 56
  assert.deepEqual(squadSizes({ ...a, faction0: 'orrin' }), [5, 4]);                      // 75 vs 56
  assert.deepEqual(squadSizes({ ...a, faction0: 'vell', faction1: 'orrin' }), [6, 4]);    // 84 vs 60
  assert.deepEqual(squadSizes({ ...a, attacker: 1, faction0: 'orrin' }), [4, 6]);         // 84 vs 60 (70 < 72)
  assert.deepEqual(squadSizes({ ...DEFAULTS }), [4, 4]);
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
  for (const seed of [11, 12, 13]) {
    const { game, trace } = playOut({ seed }, [99, 99]);
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
