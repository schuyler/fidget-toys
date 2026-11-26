import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, setTarget, placeDot, stateHash, BLUE, RED, NEUTRAL } from '../src/sim.js';
import { createGrid, axialToIndex, cellCenter, pixelToCell, mirror, dirToward } from '../src/hex.js';
import { createAI } from '../src/ai.js';

const E = 0, NE = 1, NW = 2, W = 3, SW = 4, SE = 5;

/** Empty 24×16 board with no spawns unless given. */
function board(layout = { spawns: [] }, params = {}) {
  return createGame({ width: 24, height: 16, ...params }, layout);
}
/** Cell from axial offset relative to a centre-ish origin. */
function at(game, dq, dr) {
  const o = 8 * game.grid.W + 10;
  return axialToIndex(game.grid, game.grid.q[o] + dq, game.grid.r[o] + dr);
}
const nb = (game, cell, d) => game.grid.nbr[cell * 6 + d];

test('neighbour table is symmetric and 180° rotation maps direction d to d+3', () => {
  const g = createGrid(17, 12);
  for (let i = 0; i < g.N; i++) {
    for (let d = 0; d < 6; d++) {
      const j = g.nbr[i * 6 + d];
      if (j < 0) continue;
      assert.equal(g.nbr[j * 6 + (d + 3) % 6], i);
      assert.equal(g.nbr[mirror(g, i) * 6 + (d + 3) % 6], mirror(g, j));
    }
  }
});

test('pixel → cell round-trips every cell centre', () => {
  const g = createGrid(15, 10);
  for (let i = 0; i < g.N; i++) {
    const [x, y] = cellCenter(g, i, 9);
    assert.equal(pixelToCell(g, x, y, 9), i);
  }
});

test('a dot facing an enemy\'s back destroys it', () => {
  const game = board();
  const a = at(game, 0, 0), b = nb(game, a, E);
  placeDot(game, BLUE, a, E);
  placeDot(game, RED, b, E); // facing away
  setTarget(game, BLUE, a); setTarget(game, RED, b);
  const ev = step(game);
  assert.equal(ev.kills.length, 1);
  assert.deepEqual(game.dotCount, [1, 0]);
});

test('head-on dots lock in a stalemate and stay put even when their targets move', () => {
  const game = board();
  const a = at(game, 0, 0), b = nb(game, a, E);
  placeDot(game, BLUE, a, E);
  placeDot(game, RED, b, W);
  setTarget(game, BLUE, at(game, -6, 0)); // both want to walk away
  setTarget(game, RED, at(game, 7, 0));
  for (let i = 0; i < 3; i++) step(game);
  assert.deepEqual(game.dotCount, [1, 1]);
  assert.equal(game.occ[a]?.player, BLUE);
  assert.equal(game.occ[b]?.player, RED);
  assert.ok(game.dots.every((d) => d.locked));
});

test('side-on contact harms nobody', () => {
  const game = board();
  const a = at(game, 0, 0), b = nb(game, a, NE);
  placeDot(game, BLUE, a, E);
  placeDot(game, RED, b, E);
  setTarget(game, BLUE, a); setTarget(game, RED, b);
  const ev = step(game);
  assert.equal(ev.kills.length, 0);
});

test('combat is simultaneous: a dot can kill and be killed in the same tick', () => {
  const game = board();
  const a = at(game, 0, 0), b = nb(game, a, E), c = nb(game, b, E);
  placeDot(game, BLUE, a, E);  // A faces B's back
  placeDot(game, RED, b, E);   // B faces C's back
  placeDot(game, BLUE, c, E);
  setTarget(game, BLUE, c); setTarget(game, RED, b);
  const ev = step(game);
  assert.equal(ev.kills.length, 2);
  assert.equal(game.occ[a]?.player, BLUE);
  assert.equal(game.occ[b], null);
  assert.equal(game.occ[c], null);
});

test('dots that reach the target cluster into an outward-facing hedgehog', () => {
  const game = board();
  const t = at(game, 0, 0);
  placeDot(game, BLUE, t, E);
  for (let d = 0; d < 6; d++) placeDot(game, BLUE, nb(game, t, d), (d + 3) % 6); // all facing inward
  setTarget(game, BLUE, t);
  step(game);
  for (let d = 0; d < 6; d++) assert.equal(game.occ[nb(game, t, d)]?.facing, d, `ring dot ${d} faces outward`);
});

test('a column held up by a fight keeps facing forward', () => {
  const game = board();
  const front = at(game, 0, 0);
  placeDot(game, RED, nb(game, front, E), W);
  placeDot(game, BLUE, front, E);
  placeDot(game, BLUE, nb(game, front, W), E);
  placeDot(game, BLUE, nb(game, nb(game, front, W), W), E);
  setTarget(game, BLUE, at(game, 8, 0));
  setTarget(game, RED, nb(game, front, E));
  step(game);
  // the two behind the locked leader may shuffle sideways, but none turn around
  for (const d of game.dots) if (d.player === BLUE) assert.notEqual(d.facing, W);
});

function exitFacingBlob(game, spawn) {
  // [exit cell, direction from it into the blob] for each exit touching the blob
  const out = [];
  for (const e of spawn.exits) {
    for (let d = 0; d < 6; d++) if (game.spawnOf[nb(game, e, d)] === spawn.id) { out.push([e, d]); break; }
  }
  return out;
}

test('an owned spawn emits one dot per interval at the free exit nearest the target', () => {
  const game = board({ spawns: [{ center: at(game0(), 0, 0), owner: BLUE }, { center: at(game0(), -7, 0), owner: NEUTRAL }] }, { spawnInterval: 2 });
  const s = game.spawns[0];
  setTarget(game, BLUE, at(game, 6, 0));
  step(game);
  assert.equal(game.dotCount[BLUE], 0, 'tick 1 is not an emission tick');
  step(game);
  assert.equal(game.dotCount[BLUE], 1);
  const dot = game.dots[0];
  assert.ok(s.exits.includes(dot.cell));
  assert.equal(game.dist[BLUE][dot.cell], Math.min(...s.exits.map((e) => game.dist[BLUE][e])));
  assert.equal(dot.facing, dirToward(game.grid, s.center, dot.cell), 'faces outward');
});
function game0() { return board(); }

test('a spawn with every exit blocked emits nothing; guarding dots face outward', () => {
  const game = board({ spawns: [{ center: at(game0(), 0, 0), owner: BLUE }, { center: at(game0(), -7, 0), owner: NEUTRAL }] }, { spawnInterval: 1 });
  const s = game.spawns[0];
  for (const e of s.exits) placeDot(game, BLUE, e, E);
  setTarget(game, BLUE, s.center); // guard our own full spawn
  step(game);
  assert.equal(game.dotCount[BLUE], s.exits.length);
  for (const e of s.exits) assert.equal(game.occ[e]?.facing, dirToward(game.grid, s.center, e));
});

test('attacking a neutral spawn drains its meter, then captures it with overflow', () => {
  const game = board({ spawns: [{ center: at(game0(), 0, 0), owner: NEUTRAL, meter: 3 }] }, { spawnInterval: 1000 });
  const s = game.spawns[0];
  setTarget(game, BLUE, s.center);
  setTarget(game, RED, at(game, -9, -5));
  const faces = exitFacingBlob(game, s);
  placeDot(game, BLUE, faces[0][0], faces[0][1]);
  placeDot(game, BLUE, faces[1][0], faces[1][1]);
  step(game);
  assert.equal(s.meter, 1);
  assert.equal(game.dotCount[BLUE], 0, 'attackers are used up');
  for (let i = 2; i < 5; i++) placeDot(game, BLUE, faces[i][0], faces[i][1]);
  const ev = step(game);
  assert.equal(ev.captures.length, 1);
  assert.equal(s.owner, BLUE);
  assert.equal(s.meter, 2);
});

test('a dot settled next to a neutral spawn attacks it without targeting it', () => {
  const game = board({ spawns: [{ center: at(game0(), 0, 0), owner: NEUTRAL, meter: 5 }] }, { spawnInterval: 1000 });
  const s = game.spawns[0];
  const e = s.exits[0];
  placeDot(game, BLUE, e, dirToward(game.grid, s.center, e)); // facing away from the blob
  setTarget(game, BLUE, e); // target beside the spawn, not on it
  setTarget(game, RED, at(game, -9, -5));
  step(game);
  assert.equal(s.meter, 4);
  assert.equal(game.dotCount[BLUE], 0);
});

test('dots walking past a spawn leave it alone', () => {
  const game = board({ spawns: [{ center: at(game0(), 0, 0), owner: NEUTRAL, meter: 5 }] }, { spawnInterval: 1000 });
  const s = game.spawns[0];
  // a dot on the ring, facing into the blob, but with somewhere else to be
  const [e, d] = exitFacingBlob(game, s)[0];
  placeDot(game, BLUE, e, d);
  setTarget(game, BLUE, at(game, 9, 5));
  setTarget(game, RED, at(game, -9, -5));
  step(game);
  assert.equal(s.meter, 5);
  assert.equal(game.dotCount[BLUE], 1);
});

test('owning every spawn wins', () => {
  const game = board({ spawns: [{ center: at(game0(), -5, 0), owner: BLUE }, { center: at(game0(), 5, 0), owner: NEUTRAL, meter: 1 }] }, { spawnInterval: 1000 });
  const s = game.spawns[1];
  setTarget(game, BLUE, s.center);
  const [e, d] = exitFacingBlob(game, s)[0];
  placeDot(game, BLUE, e, d);
  step(game);
  assert.equal(game.winner, BLUE);
});

test('same seed and same inputs give the same game', () => {
  const run = () => {
    const game = createGame({ seed: 42, terrain: 'rocks' });
    const ais = [createAI(0, 5), createAI(1, 9)];
    for (let i = 0; i < 400 && game.winner < 0; i++) {
      for (const ai of ais) { const t = ai.think(game); if (t !== null) setTarget(game, ai.player, t); }
      step(game);
    }
    return stateHash(game);
  };
  assert.equal(run(), run());
});

test('generated layouts are point-symmetric', () => {
  const game = createGame({ seed: 7, terrain: 'rocks', width: 50, height: 30 });
  const g = game.grid;
  for (let i = 0; i < g.N; i++) assert.equal(game.terrain[i], game.terrain[mirror(g, i)]);
  for (const s of game.spawns) {
    const m = game.spawns[game.spawnOf[mirror(g, s.center)]];
    assert.equal(m.center, mirror(g, s.center));
    assert.equal(m.meter, s.meter);
  }
});

test('the CPU drags its marker at a limited speed instead of jumping', () => {
  const game = createGame({ seed: 11 });
  const ai = createAI(RED, 3, { dragSpeed: 0.5 });
  let prev = game.targets[RED], moved = 0;
  for (let i = 0; i < 200; i++) {
    const t = ai.think(game);
    if (t !== null) {
      assert.ok(game.grid.nbr.subarray(prev * 6, prev * 6 + 6).includes(t), 'one cell per move');
      setTarget(game, RED, t);
      prev = t;
      moved++;
    }
    step(game);
  }
  assert.ok(moved > 0 && moved <= 100, `moved ${moved} cells in 200 ticks at 0.5 cells/tick`);
});

test('dense rocks stay symmetric and leave every spawn reachable', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const game = createGame({ seed, terrain: 'dense' });
    const g = game.grid;
    let rocks = 0;
    for (let i = 0; i < g.N; i++) {
      assert.equal(game.terrain[i], game.terrain[mirror(g, i)]);
      if (game.terrain[i] === 1) rocks++;
    }
    assert.ok(rocks > 0, 'has rocks');
    // every spawn has a reachable exit in blue's flow field from its home
    setTarget(game, BLUE, game.spawns[0].exits[0]);
    step(game);
    for (const s of game.spawns) assert.ok(s.exits.some((e) => game.dist[BLUE][e] < 1e9), `spawn ${s.id} reachable`);
  }
});

test('stats track kills, losses, spawning and spending', () => {
  const game = createGame({ seed: 21 });
  const ais = [createAI(0, 1), createAI(1, 2)];
  let kills = 0, spawned = 0, consumed = 0;
  for (let i = 0; i < 600 && game.winner < 0; i++) {
    for (const ai of ais) { const t = ai.think(game); if (t !== null) setTarget(game, ai.player, t); }
    const ev = step(game);
    kills += ev.kills.length; spawned += ev.spawned; consumed += ev.consumed;
  }
  const st = game.stats;
  assert.equal(st.kills[0] + st.kills[1], kills);
  assert.deepEqual(st.lost, [st.kills[1], st.kills[0]]);
  assert.equal(st.spawned[0] + st.spawned[1], spawned);
  assert.equal(st.spent[0] + st.spent[1], consumed);
  for (let p = 0; p < 2; p++) {
    assert.equal(st.spawned[p] - st.lost[p] - st.spent[p], game.dotCount[p], 'every dot accounted for');
  }
});
