import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, resolveTurn, inCommand, living, idle, cellAt, DEFAULTS } from '../src/sim.js';
import { createGrid } from '../src/hex.js';
import { createAI } from '../src/ai.js';
import { buildTimeline, stateAfter } from '../src/playback.js';

const C = (col, row) => cellAt(createGrid(DEFAULTS.width, DEFAULTS.height), col, row);

/** What playback starts from: by trooper id, and by victory hex. */
function snapshot(game) {
  return {
    cell: game.troopers.map((t) => t.cell),
    shock: game.troopers.map((t) => t.shock),
    down: game.troopers.map((t) => t.down),
    pool: game.troopers.map((t) => t.pool),
    owner: game.victory.map((v) => v.owner),
    victoryCells: game.victory.map((v) => v.cell),
  };
}
const commandSet = (game) => (game.params.command ? new Set(living(game).filter((t) => inCommand(game, t)).map((t) => t.id)) : null);

/** Plays CPU-vs-CPU stages, calling back with what playback sees for each. */
function eachStage(params, stages, fn) {
  const g = createGame(params);
  const ais = [createAI(0, params.seed * 3 + 1), createAI(1, params.seed * 7 + 2)];
  for (let n = 0; n < stages && g.winner < 0; n++) {
    const before = snapshot(g);
    const cmd = commandSet(g);
    const o = [];
    for (const ai of ais) ai.plan(g).forEach((x, i) => { if (x) o[i] = x; });
    const ev = resolveTurn(g, o);
    fn({ game: g, before, ev, beats: buildTimeline(before, ev, cmd), cmd });
  }
}

const PLAYTEST = { combat: 'dice', defence: 'original', command: 1 };

test('R13: after the last beat, playback shows exactly the game the stage left behind', () => {
  let stages = 0;
  for (const extra of [{ faction0: 'terrans', faction1: 'orrin', squad0: 6, squad1: 4 }, { faction0: 'vell', faction1: 'terrans', squad0: 6, squad1: 6, swarm: 1 }]) {
    for (let seed = 1; seed <= 6; seed++) {
      eachStage({ ...PLAYTEST, ...extra, seed }, 30, ({ game, before, beats }) => {
        stages++;
        const end = stateAfter(before, beats, beats.length - 1);
        assert.deepEqual(end.cell, game.troopers.map((t) => t.cell));
        assert.deepEqual(end.shock, game.troopers.map((t) => t.shock));
        assert.deepEqual(end.down, game.troopers.map((t) => t.down));
        assert.deepEqual(end.owner, game.victory.map((v) => v.owner));
        const start = stateAfter(before, beats, -1);
        assert.deepEqual([start.cell, start.shock, start.down, start.owner], [before.cell, before.shock, before.down, before.owner]);
      });
    }
  }
  assert.ok(stages > 100);
});

test('R13: beats come in order: fire, launches, each movement step, bombs, then the end of the stage', () => {
  const rank = { fire: 0, launch: 1, step: 2, blast: 3, end: 4 };
  const seen = new Set();
  for (let seed = 1; seed <= 6; seed++) {
    eachStage({ ...PLAYTEST, faction0: 'terrans', faction1: 'orrin', squad0: 6, squad1: 4, seed }, 30, ({ beats }) => {
      for (let i = 1; i < beats.length; i++) assert.ok(rank[beats[i - 1].kind] <= rank[beats[i].kind], beats.map((b) => b.kind).join(','));
      const steps = beats.filter((b) => b.kind === 'step');
      steps.forEach((b, i) => { if (i) assert.ok(b.index > steps[i - 1].index); });
      for (const b of beats) {
        seen.add(b.kind);
        if (b.kind === 'fire') assert.ok(b.shots.length > 0, 'no empty beats');
        if (b.kind === 'launch' || b.kind === 'blast') assert.ok(b.launches.length > 0, 'no empty beats');
      }
    });
  }
  for (const k of Object.keys(rank)) assert.ok(seen.has(k), `saw a ${k} beat`);
});

test('R13: with command on, troopers in command fire in their own wave, first', () => {
  let split = 0;
  for (let seed = 1; seed <= 8; seed++) {
    eachStage({ ...PLAYTEST, faction0: 'terrans', faction1: 'orrin', squad0: 8, squad1: 6, seed }, 30, ({ ev, beats, cmd }) => {
      const fire = beats.filter((b) => b.kind === 'fire');
      const all = ev.shots.filter((s) => s.kind === 'fire');
      assert.deepEqual(fire.flatMap((b) => b.shots), all);
      for (const b of fire) {
        assert.ok(b.wave === 'command' || b.wave === 'rest');
        for (const s of b.shots) assert.equal(cmd.has(s.from), b.wave === 'command');
      }
      if (fire.length === 2) { split++; assert.equal(fire[0].wave, 'command'); }
    });
  }
  assert.ok(split > 0);
});

test('R13: without command, all fire is one wave', () => {
  eachStage({ combat: 'dice', defence: 'original', faction0: 'terrans', faction1: 'orrin', seed: 3 }, 20, ({ beats }) => {
    for (const b of beats) if (b.kind === 'fire') assert.equal(b.wave, 'all');
    assert.ok(beats.filter((b) => b.kind === 'fire').length <= 1);
  });
});

test('R13: each step\'s overwatch shots, and the troopers they pinned, belong to that step', () => {
  // A watcher and a runner crossing its view.
  const g = createGame({ stages: 1 }, { troopers: [{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(2, 10) }] });
  const before = snapshot(g);
  const orders = [{ ...idle(), overwatch: 6 }, { ...idle(), path: [C(3, 10), C(4, 10), C(5, 10)] }];
  const ev = resolveTurn(g, orders);
  const beats = buildTimeline(before, ev, null);
  const steps = beats.filter((b) => b.kind === 'step');
  const ow = ev.shots.find((s) => s.kind === 'overwatch');
  assert.ok(ow && ow.shock > 0, 'fixture: overwatch hits');
  const at = steps.find((b) => b.index === ow.step);
  assert.deepEqual(at.shots, [ow]);
  assert.deepEqual(at.pinned, [1]);
  for (const b of steps) if (b !== at) { assert.deepEqual(b.shots, []); assert.deepEqual(b.pinned, []); }
});

test('R13: a stage where nobody does anything has no fire, launch, step or blast beats', () => {
  const g = createGame({ stages: 1 }, { troopers: [{ side: 0, cell: C(6, 14) }, { side: 1, cell: C(6, 3) }] });
  const before = snapshot(g);
  const beats = buildTimeline(before, resolveTurn(g, []), null);
  assert.ok(beats.every((b) => b.kind === 'end'));
});
