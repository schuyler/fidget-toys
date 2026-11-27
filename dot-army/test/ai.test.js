import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, applyInput, BLUE, RED } from '../src/sim.js';
import { createAI } from '../src/ai.js';

/**
 * CPU vs CPU. Returns the most targets each side held, every rejected input,
 * and the running cells-moved budget check for each side.
 */
function play({ seed, maxTargets, dragSpeed = 2.2, ticks = 1500 }) {
  const game = createGame({ seed, maxTargets });
  const ais = [createAI(BLUE, seed * 7 + 1, { dragSpeed }), createAI(RED, seed * 7 + 2, { dragSpeed })];
  const maxHeld = [1, 1];
  const rejected = [];
  const moved = [0, 0];
  const overBudget = [];
  const notOneCell = [];
  let n = 0;
  for (; n < ticks && game.winner < 0; n++) {
    for (const ai of ais) {
      for (const inp of ai.think(game)) {
        if (inp.op === 'move') {
          const prev = game.targets[ai.player][inp.index];
          if (!game.grid.nbr.subarray(prev * 6, prev * 6 + 6).includes(inp.cell)) notOneCell.push([game.tick, ai.player, inp]);
          moved[ai.player]++;
        }
        if (applyInput(game, ai.player, inp) !== true) rejected.push([game.tick, ai.player, inp]);
      }
      maxHeld[ai.player] = Math.max(maxHeld[ai.player], game.targets[ai.player].length);
      if (moved[ai.player] > dragSpeed * (n + 1) + 1e-9) overBudget.push([n + 1, ai.player, moved[ai.player]]);
    }
    step(game);
  }
  return { maxHeld, rejected, overBudget, notOneCell, ticks: n };
}

test('C7: with maxTargets 3 the CPU holds two or more targets at some point', () => {
  const seen = [1, 2, 3].map((seed) => play({ seed, maxTargets: 3 }));
  const most = Math.max(...seen.flatMap((r) => r.maxHeld));
  assert.ok(most >= 2, `most targets held: ${most}`);
  for (const r of seen) assert.deepEqual(r.rejected, [], 'every input is accepted by applyInput');
});

test('C7: with maxTargets 1 the CPU never holds more than one target', () => {
  for (const seed of [1, 2, 3]) {
    const r = play({ seed, maxTargets: 1 });
    assert.deepEqual(r.maxHeld, [1, 1]);
    assert.deepEqual(r.rejected, []);
  }
});

test('C7: cells moved across all targets stay within dragSpeed times ticks', () => {
  for (const seed of [1, 2]) {
    const r = play({ seed, maxTargets: 3, dragSpeed: 1.1, ticks: 800 });
    assert.deepEqual(r.overBudget, []);
    assert.deepEqual(r.notOneCell, [], 'each move is one cell');
    assert.deepEqual(r.rejected, []);
  }
});
