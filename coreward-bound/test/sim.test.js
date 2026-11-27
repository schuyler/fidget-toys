import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, preview, jump, found, grow, build, research, endTurn, act, stateHash, buildOptions, researchCost,
  lineOfSight, crossesDust, inSight, stackAt, band, level, GALAXIES, DEFAULTS, DRAW,
  VOID, PERIPHERY, ARM, CORE, TERRAIN_NAMES, isCore, REACH, FOCUS, FORCE, INDUSTRY,
} from '../src/sim.js';
import { createGrid, rotate, axialToIndex, hexDist, ring, dirTo } from '../src/hex.js';
import { createAI } from '../src/ai.js';

/** The cell at axial (q, r) in a game's grid. */
const at = (game, q, r) => axialToIndex(game.grid, q, r);

/**
 * A plain galaxy for rule tests: every hex outside the core is a known
 * arm-core hex of potential 3, no dust, no beacons, no stacks, no
 * settlements except the ones given. Civ 0 to move.
 */
function board({ towns = [], stacks = [], params = {} } = {}) {
  const game = createGame({ seed: 7, ...params });
  const g = game.grid;
  for (let i = 0; i < g.N; i++) {
    const t = game.terrain[i];
    if (t !== CORE) { game.terrain[i] = ARM; game.potential[i] = 3; }
    game.beacon[i] = 0;
    game.dust[i] = 0;
    game.owner[i] = -1;
    game.value[i] = 0;
    for (const civ of game.civs) civ.known[i] = 1;
  }
  for (const [cell, owner, value = 1] of towns) { game.owner[cell] = owner; game.value[cell] = value; }
  game.stacks = stacks.map(([cell, owner, fleets, relics = 0]) => ({ owner, cell, fleets, ready: fleets, idle: fleets, relics }));
  game.epoch++;
  return game;
}

/** Run a game's d6 rolls from a fixed list, so a test can say what was rolled. */
function rig(game, rolls) {
  const real = game.rng;
  const queue = [...rolls];
  game.rng = { ...real, int: (n) => (n === 6 && queue.length ? queue.shift() - 1 : real.int(n)) };
  return queue;
}

test('rotating 180° is a symmetry of the grid', () => {
  const g = createGrid(12);
  assert.equal(g.N, 1 + 3 * 12 * 13);
  for (let i = 0; i < g.N; i++) {
    assert.equal(rotate(g, rotate(g, i)), i);
    for (let d = 0; d < 6; d++) {
      const j = g.nbr[i * 6 + d];
      const k = g.nbr[rotate(g, i) * 6 + (d + 3) % 6];
      assert.equal(k, j < 0 ? -1 : rotate(g, j));
    }
  }
});

test('every galaxy is the same for both civs, turned half a turn', () => {
  for (const galaxy of Object.keys(GALAXIES)) {
    for (const seed of [1, 2, 3]) {
      const game = createGame({ galaxy, seed });
      const g = game.grid;
      for (let i = 0; i < g.N; i++) {
        const j = rotate(g, i);
        assert.equal(game.terrain[i], game.terrain[j]);
        assert.equal(game.potential[i], game.potential[j]);
        assert.equal(game.beacon[i], game.beacon[j]);
        for (let d = 0; d < 6; d++) {
          const n = g.nbr[i * 6 + d];
          if (n < 0) continue;
          const dust = (game.dust[i] >> d) & 1;
          assert.equal((game.dust[j] >> dirTo(g, j, rotate(g, n))) & 1, dust, 'dust is mirrored');
          assert.equal((game.dust[n] >> ((d + 3) % 6)) & 1, dust, 'dust is on both sides of an edge');
        }
      }
      assert.equal(game.civs[1].home, rotate(g, game.civs[0].home));
      assert.ok(ring(g, game.civs[0].home) >= g.R - 3, `${galaxy}: home near the rim`);
      assert.ok(game.spawns.every((c) => game.terrain[c] === CORE));
      for (let i = 0; i < g.N; i++) assert.equal(game.relicAt[i], game.relicAt[rotate(g, i)], 'relics are placed symmetrically');
      assert.equal(game.owner[game.civs[0].home], 0);
      assert.equal(stackAt(game, 0, game.civs[0].home)?.fleets, DEFAULTS.startFleets);
      assert.equal(game.civs[1].rp, game.civs[0].rp + DEFAULTS.secondRp);
    }
  }
});

test('a hex shows its potential only to a civ that has been there', () => {
  const game = createGame({ seed: 5 });
  const home = game.civs[0].home;
  const far = rotate(game.grid, home);
  assert.equal(game.civs[0].known[home], 1);
  assert.equal(game.civs[0].known[far], 0);
  assert.equal(game.civs[1].known[far], 1);
});

test('a one-hex jump never scatters; longer ones need 2 + distance / 3', () => {
  const a = at(createGame(), 0, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 4]] });
  const one = preview(game, a, at(game, 1, 6));
  assert.equal(one.hits, 6);
  assert.equal(one.outcomes.length, 0);
  const two = preview(game, a, at(game, 2, 6));
  assert.equal(two.need, 2);
  assert.equal(two.hits, 5);           // a 1 misses
  const far = preview(game, a, at(game, 6, 6)); // over range, from a settlement
  assert.equal(far.over, true);
  assert.equal(far.need, 4);
  assert.equal(far.bonus, -2);
  assert.equal(far.hits, 1);           // only a 6
});

test('long jumps only from your own settlement', () => {
  const a = at(createGame(), 0, 6);
  const game = board({ stacks: [[a, 0, 4]] });
  assert.match(preview(game, a, at(game, 5, 6)).error, /Too far/);
  game.owner[a] = 0; game.epoch++;
  assert.ok(!('error' in preview(game, a, at(game, 5, 6))));
});

test('Focus, beacons and aiming at your own settlement all help', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 2, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 4]] });
  assert.equal(preview(game, a, b).bonus, 0);
  game.beacon[b] = 1;
  assert.equal(preview(game, a, b).bonus, 1);
  game.owner[b] = 0; game.epoch++;
  assert.equal(preview(game, a, b).bonus, 2);
  game.civs[0].techs.push(6); // Choral Navigation, a Focus tech
  assert.equal(preview(game, a, b).bonus, 3);
});

test('scatter: the preview lists every outcome, and the real jump lands on one of them', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 0, 8);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 4]] });
  const pv = preview(game, a, b);
  assert.equal(pv.hits, 5);
  assert.equal(pv.outcomes.length, 6);   // a 1, scattering 1 hex in any of six directions
  assert.ok(pv.outcomes.every((o) => o.scatter === 1 && o.losses === 0));
  rig(game, [1]);
  const ev = jump(game, a, b);
  const j = ev.find((e) => e.type === 'jump');
  assert.equal(j.scatter, 1);
  assert.ok(pv.outcomes.some((o) => o.cell === j.landed));
  assert.equal(hexDist(game.grid, j.landed, b), 1);
});

test('scattering into the core, off the map or out of sight loses the stack', () => {
  // into the core: a jump aimed into it that misses is always lost
  const g = createGame().grid;
  const a = at({ grid: g }, 0, 4), core = g.centre;
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 3]] });
  const pv = preview(game, a, game.spawns[1]);
  assert.ok(pv.outcomes.length > 0 && pv.outcomes.every((o) => o.lost));
  void core;
  // out of sight: far from any settlement
  const b = at(game, -8, 8);
  const lone = board({ towns: [[a, 0, 3]], stacks: [[b, 0, 3]] });
  const pv2 = preview(lone, b, at(lone, -8, 10));
  assert.ok(pv2.loseChance > 0);
  assert.ok(pv2.outcomes.every((o) => o.lost));
});

test('a jump aimed at your own settlement is never lost, though it can scatter', () => {
  const a = at(createGame(), 0, 6), rim = at(createGame(), 0, 12);
  const game = board({ towns: [[a, 0, 3], [rim, 0, 1]], stacks: [[a, 0, 9]] });
  const pv = preview(game, a, rim);
  assert.ok(pv.outcomes.length > 0);
  assert.equal(pv.loseChance, 0);
  assert.ok(pv.outcomes.every((o) => o.cell >= 0));
});

test('dust blocks jumps across it, except a one-hex hop or settlement to settlement', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 2, 6);
  const game = board({ stacks: [[a, 0, 4]] });
  const mid = at(game, 1, 6);
  const d = dirTo(game.grid, a, mid);
  game.dust[a] |= 1 << d; game.dust[mid] |= 1 << ((d + 3) % 6);
  assert.equal(crossesDust(game, a, b), true);
  assert.match(preview(game, a, b).error, /Dust/);
  assert.ok(!('error' in preview(game, a, mid)), 'one-hex hop');
  game.owner[a] = 0; game.owner[b] = 0; game.epoch++;
  assert.ok(!('error' in preview(game, a, b)), 'settlement to settlement');
  assert.equal(lineOfSight(game, a, b), false);
});

test('the core blocks sight through it, not into it', () => {
  const game = board();
  const west = at(game, -4, 0), east = at(game, 4, 0);
  assert.equal(lineOfSight(game, west, east), false);
  assert.equal(lineOfSight(game, west, at(game, -2, 0)), true);
});

test('sight: a stack is safe only within sight range of a settlement', () => {
  const a = at(createGame(), 0, 6);
  const game = board({ towns: [[a, 0, 3]] });
  assert.equal(inSight(game, 0, at(game, 0, 6 + DEFAULTS.sight)), true);
  assert.equal(inSight(game, 0, at(game, -6, 6 + DEFAULTS.sight)), false);
  game.civs[0].techs.push(0); // a Reach tech: +1 sight
  assert.equal(inSight(game, 0, at(game, 0, 6 + DEFAULTS.sight + 1)), true);
});

test('chaining: landing on target at your own settlement within safe range lets fleets jump again', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 2, 6), c = at(createGame(), 4, 6);
  const game = board({ towns: [[a, 0, 3], [b, 0, 1]], stacks: [[a, 0, 3]] });
  rig(game, [6]);
  jump(game, a, b);
  assert.equal(stackAt(game, 0, b).ready, 3);
  rig(game, [6]);
  jump(game, b, c);
  assert.equal(stackAt(game, 0, c).ready, 0, 'not a settlement: the move ends');
});

test('relic carriers never chain', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 2, 6);
  const game = board({ towns: [[b, 0, 1]], stacks: [[a, 0, 2, 1]] });
  game.owner[a] = 0; game.epoch++;
  assert.equal(preview(game, a, b).chain, false);
});

test('combat is fought to the finish, and the defender gets +1 at home', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[b, 1, 2]], stacks: [[a, 0, 5], [b, 1, 2]] });
  const ev = jump(game, a, b);
  const fight = ev.find((e) => e.type === 'combat');
  assert.ok(fight);
  assert.ok(fight.after[0] === 0 || fight.after[1] === 0);
  assert.equal(game.stacks.filter((s) => s.cell === b).length, 1);
});

test('hits: strength × d6 / 10, at least 1', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ stacks: [[a, 0, 10], [b, 1, 10]] });
  rig(game, [6, 1, 6, 1]); // attacker rolls 6s, defender 1s: 6 hits then 5; 1 hit each round
  const ev = jump(game, a, b);
  const fight = ev.find((e) => e.type === 'combat');
  assert.deepEqual(fight.before, [10, 10]);
  assert.deepEqual(fight.after, [8, 0]);
  assert.equal(fight.rounds, 2);
});

test('taking a settlement: d6 + fleets + Force >= value + 4; it loses 1 value', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[b, 1, 3], [at(createGame(), 0, -8), 1, 3]], stacks: [[a, 0, 2]] });
  rig(game, [4]); // 4 + 2 = 6 < 7
  const ev = jump(game, a, b);
  assert.equal(ev.find((e) => e.type === 'flip').ok, false);
  assert.equal(game.owner[b], 1);
  endTurn(game);
  assert.match(buildOptions(game, b).build, /Besieged/, 'a besieged settlement builds nothing');
  rig(game, [5, 1]); // the siege goes on at the start of the next turn: 5 + 2 = 7; a 1 copies no tech
  const e2 = endTurn(game);
  const flip = e2.find((e) => e.type === 'flip');
  assert.ok(flip && flip.ok);
  assert.equal(flip.tech, -1);
  assert.equal(game.owner[b], 0);
  assert.equal(game.value[b], 2);
});

test('taking a settlement can copy one of the loser\'s techs', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[b, 1, 0], [at(createGame(), 0, -8), 1, 3]], stacks: [[a, 0, 2]] });
  game.civs[1].techs.push(20);
  rig(game, [6, 6]);
  const flip = jump(game, a, b).find((e) => e.type === 'flip');
  assert.equal(flip.tech, 20);
  assert.ok(game.civs[0].techs.includes(20));
});

test('losing your last settlement knocks you out', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[a, 0, 3], [b, 1, 0]], stacks: [[a, 0, 4], [at(createGame(), 0, -8), 1, 2]] });
  rig(game, [6, 6]);
  const ev = jump(game, a, b);
  assert.ok(ev.some((e) => e.type === 'eliminated' && e.civ === 1));
  assert.equal(game.winner, 0);
  assert.equal(game.winBy, 'elimination');
  assert.equal(game.stacks.some((s) => s.owner === 1), false);
});

test('fleets can found a settlement the turn they arrive, in a hex they have seen', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 4]] });
  game.civs[0].known[b] = 0;
  jump(game, a, b, 2);
  assert.equal(game.civs[0].known[b], 1, 'landing reveals the hex');
  const ev = found(game, b);
  assert.ok(Array.isArray(ev), JSON.stringify(ev));
  assert.equal(game.owner[b], 0);
  assert.equal(game.value[b], 1);
  assert.equal(stackAt(game, 0, b), null, 'both fleets spent');
  assert.match(found(game, game.grid.centre).error, /settlement here|core|Needs/);
});

test('grow, build and their limits', () => {
  const a = at(createGame(), 0, 6);
  const game = board({ towns: [[a, 0, 1]], stacks: [[a, 0, 3]] });
  game.potential[a] = 2;
  game.civs[0].rp = 10;
  assert.ok(Array.isArray(grow(game, a)));
  assert.equal(game.value[a], 2);
  assert.match(build(game, a).error, /Grew this turn/);
  endTurn(game); endTurn(game);
  assert.match(grow(game, a).error, /potential/);
  const rp = game.civs[0].rp;
  assert.ok(Array.isArray(build(game, a)));
  assert.equal(game.civs[0].rp, rp - DEFAULTS.fleetCost);
  assert.match(build(game, a).error, /as many as it can/);
  assert.equal(stackAt(game, 0, a).ready, stackAt(game, 0, a).fleets - 1, 'a new fleet waits a turn');
  game.civs[0].techs.push(12); // an Industry tech
  assert.ok(Array.isArray(build(game, a)));
});

test('research: two techs on offer, cost 2 + techs / 3, less 1 if the rival knows it', () => {
  const a = at(createGame(), 0, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 9]] });
  const offer = [...game.civs[0].offer];
  assert.equal(offer.length, 2);
  assert.notEqual(offer[0], offer[1]);
  assert.equal(researchCost(game, 0, offer[0]), 2);
  game.civs[1].techs.push(offer[0]);
  assert.equal(researchCost(game, 0, offer[0]), 1);
  const ev = research(game, a, 0);
  assert.equal(ev[0].tech, offer[0]);
  assert.deepEqual(game.civs[0].techs, [offer[0]]);
  assert.equal(stackAt(game, 0, a).fleets, 8);
  assert.equal(game.civs[0].offer.length, 2);
  assert.ok(!game.civs[0].offer.includes(offer[0]));
  game.civs[0].techs.push(1, 2);
  assert.equal(researchCost(game, 0, game.civs[0].offer[0]), 3);
});

test('a tech is +1 to its type, and a relic is +1 to every type', () => {
  const game = board();
  game.civs[0].techs.push(0, 1, 18);
  assert.equal(level(game, 0, REACH), 2);
  assert.equal(level(game, 0, FORCE), 1);
  game.civs[0].relics = 1;
  assert.deepEqual([REACH, FOCUS, INDUSTRY, FORCE].map((t) => level(game, 0, t)), [3, 1, 1, 2]);
});

test('relics: hold the core hex through the rival turn, then carry it home', () => {
  const town = at(createGame(), 0, 3);
  const game = board({ towns: [[town, 0, 1], [at(createGame(), 0, -8), 1, 1]], stacks: [[town, 0, 3]] });
  const core = game.grid.centre; // three hexes away
  game.civs[0].techs.push(0); // Reach: safe range 3
  rig(game, [6]);
  jump(game, town, core);
  assert.equal(stackAt(game, 0, core).relics, 0, 'not yet');
  rig(game, [6, 6, 6]); // the core's glare spares all three
  endTurn(game);
  const ev = endTurn(game);
  assert.ok(ev.some((e) => e.type === 'pickup'));
  assert.equal(stackAt(game, 0, core).relics, 1);
  assert.equal(game.relicAt[core], 0);
  rig(game, [6]);
  const back = jump(game, core, town);
  assert.ok(back.some((e) => e.type === 'deliver'));
  assert.equal(game.civs[0].relics, 1);
  // a new relic appears on a spawn hex three rounds after the pickup
  const onSpawns = () => game.spawns.reduce((t, c) => t + game.relicAt[c], 0);
  assert.equal(onSpawns(), 2);
  for (let k = 0; k < 2 * DEFAULTS.relicRespawn - 2; k++) endTurn(game);
  assert.equal(onSpawns(), 2, 'not yet');
  endTurn(game); endTurn(game);
  assert.equal(onSpawns(), 3);
});

test('a relic lost in space goes back to a spawn hex; one dropped in combat stays put', () => {
  const town = at(createGame(), 0, 3);
  const centre = createGame().grid.centre;
  const game = board({ towns: [[town, 0, 1], [at(createGame(), 0, -8), 1, 1]], stacks: [[centre, 0, 1, 1]] });
  game.relicAt[centre] = 0;
  game.civs[0].techs.push(0);
  rig(game, [1]); // missing a jump out of the core is fatal
  const ev = jump(game, centre, town);
  assert.ok(ev.find((e) => e.type === 'jump').lost);
  assert.ok(ev.some((e) => e.type === 'return'));
  assert.equal(game.spawns.reduce((t, c) => t + game.relicAt[c], 0), 3);

  const a = at(game, 0, 6), b = at(game, 1, 6);
  const g2 = board({ towns: [[at(game, 0, 8), 0, 1], [at(game, 0, -8), 1, 1]], stacks: [[a, 0, 1], [b, 1, 9, 1]] });
  rig(g2, [1, 6]);
  jump(g2, a, b);
  assert.equal(stackAt(g2, 1, b).relics, 1, 'the defender survived and kept it');
  const g3 = board({ towns: [[at(game, 0, 8), 0, 1], [at(game, 0, -8), 1, 1]], stacks: [[a, 0, 9], [b, 1, 1, 1]] });
  rig(g3, [6, 1]);
  const e3 = jump(g3, a, b);
  assert.ok(e3.some((e) => e.type === 'drop'));
  assert.equal(stackAt(g3, 0, b).relics, 0, 'dropped: picked up only by holding the hex');
  assert.equal(g3.relicAt[b], 1);
});

test('three relics win', () => {
  const town = at(createGame(), 0, 4);
  const game = board({ towns: [[town, 0, 1]], stacks: [[at(createGame(), 0, 5), 0, 1, 1]] });
  game.civs[0].relics = 2;
  const ev = jump(game, at(game, 0, 5), town);
  assert.ok(ev.some((e) => e.type === 'win'));
  assert.equal(game.winner, 0);
  assert.equal(game.winBy, 'relics');
});

test('upkeep: fleets beyond the third in a hex cost 1 RP each, and starve if unpaid', () => {
  const a = at(createGame(), 0, 6);
  const game = board({ towns: [[a, 0, 2], [at(createGame(), 0, -8), 1, 1]], stacks: [[a, 0, 7]] });
  game.civs[0].rp = 0;
  endTurn(game);
  const ev = endTurn(game);
  const inc = ev.find((e) => e.type === 'income');
  assert.equal(inc.rp, 2);
  assert.equal(inc.upkeep, 4);
  assert.equal(inc.starved, 2);
  assert.equal(stackAt(game, 0, a).fleets, 5);
  assert.equal(game.civs[0].rp, 0);
});

test('rival stack sizes show as bands', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 7, 20].map(band), ['1', '2–3', '2–3', '4–6', '4–6', '7+', '7+']);
});

test('the turn limit ends the game on score', () => {
  const game = createGame({ turnLimit: 2 });
  for (let k = 0; k < 4; k++) endTurn(game);
  assert.ok(game.winner === 0 || game.winner === 1 || game.winner === DRAW);
  assert.equal(game.winBy, 'score');
});

test('CPU games are deterministic, finish, and never send a refused action', () => {
  for (const galaxy of Object.keys(GALAXIES)) {
    const run = () => {
      const game = createGame({ galaxy, seed: 42 });
      const ais = [createAI(0, 1), createAI(1, 2, { level: 'easy' })];
      let guard = 0;
      while (game.winner < 0 && guard++ < 20000) {
        const ev = act(game, ais[game.current].next(game));
        assert.ok(Array.isArray(ev), `refused: ${ev.error}`);
      }
      return game;
    };
    const a = run(), b = run();
    assert.ok(a.winner >= 0, `${galaxy}: finished`);
    assert.equal(stateHash(a), stateHash(b));
  }
});

test('the CPU only uses what it may know: it never reads rival stack sizes exactly', async () => {
  // Two games that differ only in the exact size of a rival stack within the
  // same band must get the same CPU decisions.
  const decide = (fleets) => {
    const game = createGame({ seed: 9 });
    const s1 = stackAt(game, 1, game.civs[1].home);
    s1.fleets = s1.ready = s1.idle = fleets;
    const ai = createAI(0, 5);
    const out = [];
    for (let k = 0; k < 6; k++) { const a = ai.next(game); out.push(a); if (a.kind === 'end') break; act(game, a); }
    return JSON.stringify(out);
  };
  assert.equal(decide(4), decide(6));
});

void VOID;

// ---------------------------------------------------------------- playtest batch 1

const centreOf = () => createGame().grid.centre;
const spawnTotal = (game) => game.spawns.reduce((t, c) => t + game.relicAt[c], 0);

test('terrain names: void, periphery, arm, core', () => {
  assert.deepEqual(TERRAIN_NAMES, ['Void', 'Periphery', 'Arm', 'Core']);
  assert.deepEqual([VOID, PERIPHERY, ARM, CORE], [0, 1, 2, 3]);
  const game = createGame();
  assert.equal(isCore(game, game.grid.centre), true);
  assert.equal(isCore(game, at(game, 0, DEFAULTS.core)), true);
  assert.equal(isCore(game, at(game, 0, DEFAULTS.core + 1)), false);
});

test('voids are worth nothing and can\'t be settled, but stacks can stand in them', () => {
  for (const seed of [1, 2, 3, 4]) {
    const game = createGame({ seed });
    for (let i = 0; i < game.grid.N; i++) if (game.terrain[i] === VOID) assert.equal(game.potential[i], 0);
  }
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 4]] });
  game.terrain[b] = VOID; game.potential[b] = 0;
  const ev = jump(game, a, b, 2);
  assert.ok(Array.isArray(ev));
  assert.equal(stackAt(game, 0, b).fleets, 2);
  assert.match(found(game, b).error, /void/);
});

test('a settlement founded this turn can\'t build, anchor chain or long jumps, or take a relic', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 2, 6), far = at(createGame(), 0, 12);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 4], [b, 0, 4]] });
  game.civs[0].rp = 10;
  assert.ok(Array.isArray(found(game, b)));
  assert.match(buildOptions(game, b).build, /Founded this turn/);
  assert.match(build(game, b).error, /Founded this turn/);
  assert.equal(preview(game, a, b).chain, false, 'no chaining through it yet');
  assert.match(preview(game, b, far).error, /Too far/, 'no over-range launch from it yet');
  endTurn(game); endTurn(game);
  assert.equal(buildOptions(game, b).build, null);
  assert.equal(preview(game, a, b).chain, true);
  assert.ok(!('error' in preview(game, b, far)));
});

test('a carrier waits at a settlement founded this turn, and delivers at the start of the next', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 3, 1]] });
  jump(game, a, b);
  const ev = found(game, b);
  assert.ok(Array.isArray(ev));
  assert.equal(ev.some((e) => e.type === 'deliver'), false);
  assert.equal(stackAt(game, 0, b).relics, 1);
  endTurn(game);
  const next = endTurn(game);
  assert.ok(next.some((e) => e.type === 'deliver'));
  assert.equal(game.civs[0].relics, 1);
});

test('a carrier can\'t found or research away its last fleets', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[a, 0, 3]], stacks: [[a, 0, 2, 1]] });
  jump(game, a, b);
  assert.match(found(game, b).error, /relic/);
  // research at a settlement founded this turn, with the fleets that are left
  const c = at(createGame(), 0, 9);
  const g2 = board({ stacks: [[c, 0, 4, 1]] });
  assert.ok(Array.isArray(found(g2, c)));
  const cost = researchCost(g2, 0, g2.civs[0].offer[0]);
  assert.equal(cost, 2);
  assert.match(research(g2, c, 0).error, /relic/);
});

test('a settlement taken this turn isn\'t working until its new owner\'s next turn', () => {
  const a = at(createGame(), 0, 6), b = at(createGame(), 1, 6);
  const game = board({ towns: [[a, 0, 3], [b, 1, 1], [at(createGame(), 0, -8), 1, 1]], stacks: [[a, 0, 12]] });
  game.civs[0].rp = 10;
  jump(game, a, b, 9);
  assert.equal(game.owner[b], 0, 'taken');
  assert.equal(preview(game, a, b).chain, false);
  assert.match(buildOptions(game, b).build, /this turn/);
  endTurn(game); endTurn(game);
  assert.equal(preview(game, a, b).chain, true);
});

test('every fleet that ends its turn in the core rolls a d6 and is lost on a 1', () => {
  const inner = at(createGame(), 0, 2), outer = at(createGame(), 0, 5), theirs = at(createGame(), 2, -2);
  const game = board({ stacks: [[outer, 0, 3], [inner, 0, 4], [theirs, 1, 3]] });
  rig(game, [1, 6, 1, 6]);
  const ev = endTurn(game);
  const h = ev.find((e) => e.type === 'hazard');
  assert.ok(h, 'a hazard event');
  assert.equal(h.cell, inner);
  assert.equal(h.lost, 2);
  assert.equal(stackAt(game, 0, inner).fleets, 2);
  assert.equal(stackAt(game, 0, outer).fleets, 3, 'outside the core: no roll');
  assert.equal(stackAt(game, 1, theirs).fleets, 3, 'the rival rolls at the end of its own turn');
});

test('the core\'s glare can wipe out a stack, which drops its relic there', () => {
  const inner = at(createGame(), 0, 2);
  const game = board({ stacks: [[inner, 0, 1, 1]] });
  rig(game, [1]);
  const ev = endTurn(game);
  assert.equal(stackAt(game, 0, inner), null);
  assert.ok(ev.some((e) => e.type === 'drop' && e.cell === inner));
  assert.equal(game.relicAt[inner], 1);
});

test('a stack picks up one relic at a time and carries only one', () => {
  const x = at(createGame(), 0, 5);
  const game = board({ stacks: [[x, 0, 3]] });
  game.relicAt[x] = 2;
  endTurn(game); endTurn(game);
  assert.equal(stackAt(game, 0, x).relics, 1);
  assert.equal(game.relicAt[x], 1, 'one left behind');
  endTurn(game); endTurn(game);
  assert.equal(stackAt(game, 0, x).relics, 1, 'a carrier can\'t pick up another');
  assert.equal(game.relicAt[x], 1);
});

test('a jump can\'t bring two relics together, except to be delivered', () => {
  const a = at(createGame(), 0, 5), b = at(createGame(), 0, 6);
  const game = board({ stacks: [[a, 0, 2, 1], [b, 0, 2, 1]] });
  assert.match(preview(game, a, b).error, /one relic/);
  game.owner[b] = 0; game.value[b] = 1; game.epoch++;
  assert.ok(!('error' in preview(game, a, b)), 'into your own settlement it is delivered');
});

test('a carrier that scatters onto another of yours drops the extra relic', () => {
  const town = at(createGame(), 0, 9), a = at(createGame(), 0, 6), t = at(createGame(), 3, 6);
  const game = board({ towns: [[town, 0, 3]], stacks: [[a, 0, 3, 1]] });
  const pv = preview(game, a, t);
  assert.equal(pv.need, 3);
  const d = pv.outcomes.slice(0, 6).findIndex((o) => !o.lost && o.cell >= 0 && o.cell !== a);
  assert.ok(d >= 0);
  const land = pv.outcomes[d].cell;
  game.stacks.push({ owner: 0, cell: land, fleets: 2, ready: 2, idle: 2, relics: 1 });
  rig(game, [1, d + 1]);
  const ev = jump(game, a, t);
  assert.equal(ev.find((e) => e.type === 'jump').landed, land);
  assert.equal(stackAt(game, 0, land).relics, 1);
  assert.equal(game.relicAt[land], 1);
  assert.ok(ev.some((e) => e.type === 'drop'));
});

test('relics start on the centre and an opposite pair of its neighbours', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const game = createGame({ seed });
    const g = game.grid, c = g.centre;
    assert.deepEqual([...game.spawns].sort((x, y) => x - y), [c, ...[0, 1, 2, 3, 4, 5].map((d) => g.nbr[c * 6 + d])].sort((x, y) => x - y));
    assert.equal(game.relicAt[c], 1);
    const others = game.spawns.filter((s) => s !== c && game.relicAt[s]);
    assert.equal(others.length, 2);
    assert.equal(rotate(g, others[0]), others[1]);
    assert.equal(spawnTotal(game), 3);
  }
});

test('a new relic never appears where a stack stands, and waits while every spawn hex is taken', () => {
  const game = board();
  for (const s of game.spawns) game.relicAt[s] = 0;
  game.respawn = [1];
  game.stacks = game.spawns.map((cell) => ({ owner: 1, cell, fleets: 1, ready: 1, idle: 1, relics: 0 }));
  rig(game, [6, 6, 6, 6, 6, 6, 6]);
  endTurn(game); endTurn(game); // a round starts: the timer runs out with nowhere free
  assert.equal(spawnTotal(game), 0);
  assert.deepEqual(game.respawn, [0]);
  const freed = game.spawns[3];
  game.stacks = game.stacks.filter((s) => s.cell !== freed);
  rig(game, [6, 6, 6, 6, 6, 6]);
  endTurn(game); endTurn(game);
  assert.equal(game.relicAt[freed], 1, 'the only free spawn hex');
  assert.deepEqual(game.respawn, []);
});

test('a relic coming back to the board cancels a pending respawn', () => {
  const town = at(createGame(), 0, 3), centre = centreOf();
  const game = board({ towns: [[town, 0, 1]], stacks: [[centre, 0, 1, 1]] });
  game.relicAt[centre] = 0;
  game.respawn = [3];
  game.civs[0].techs.push(0);
  rig(game, [1]); // lost on the way out
  const ev = jump(game, centre, town);
  assert.ok(ev.some((e) => e.type === 'return'));
  assert.deepEqual(game.respawn, []);
  assert.equal(spawnTotal(game), 3);
});

test('a relic lost in space waits for a free spawn hex if none is free', () => {
  const town = at(createGame(), 0, 4), from = at(createGame(), 0, 2);
  const game = board({ towns: [[town, 0, 1]], stacks: [[from, 0, 1, 1]] });
  for (const s of game.spawns) game.relicAt[s] = 0;
  for (const cell of game.spawns) game.stacks.push({ owner: 1, cell, fleets: 1, ready: 1, idle: 1, relics: 0 });
  game.respawn = [];
  rig(game, [1]);
  const ev = jump(game, from, at(game, 0, 5));
  assert.ok(ev.find((e) => e.type === 'jump').lost);
  assert.equal(spawnTotal(game), 0);
  assert.deepEqual(game.respawn, [0]);
});
