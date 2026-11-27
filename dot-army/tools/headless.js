// Runs CPU-vs-CPU games without a browser, to tune default parameters.
// Usage: node dot-army/tools/headless.js [games] [key=value ...]
import { createGame, applyInput, step } from '../src/sim.js';
import { createAI } from '../src/ai.js';

// cpuTargets0=N / cpuTargets1=N cap each CPU's targets (blue / red); `swap` runs
// every seed twice with the two configurations on opposite sides.
const args = process.argv.slice(2);
const games = Number(args[0] ?? 20);
const swap = args.includes('swap');
const overrides = {};
const cpuTargets = [undefined, undefined];
for (const kv of args.slice(1)) {
  if (kv === 'swap') continue;
  const [k, v] = kv.split('=');
  const val = isNaN(Number(v)) ? v : Number(v);
  if (k === 'cpuTargets0') cpuTargets[0] = val;
  else if (k === 'cpuTargets1') cpuTargets[1] = val;
  else overrides[k] = val;
}
const maxTicks = 8 * 60 * 6; // six minutes at 8 ticks/s

const results = [];
for (let run = 0; run < games * (swap ? 2 : 1); run++) {
  const g = swap ? run >> 1 : run;
  const flipped = swap && (run & 1) === 1; // configuration 0 plays red
  const caps = flipped ? [cpuTargets[1], cpuTargets[0]] : cpuTargets;
  const seed = 1000 + g;
  const game = createGame({ ...overrides, seed });
  const ais = [createAI(0, seed * 3 + 1, { dragSpeed: 2.2, maxTargets: caps[0] }), createAI(1, seed * 7 + 2, { dragSpeed: 2.2, maxTargets: caps[1] })];
  const held = [0, 0];
  let kills = 0, captures = 0, peak = 0, lockedSum = 0, leader = -1, flips = 0;
  const t0 = performance.now();
  while (game.winner < 0 && game.tick < maxTicks) {
    for (const ai of ais) {
      for (const input of ai.think(game)) applyInput(game, ai.player, input);
    }
    const ev = step(game);
    for (let p = 0; p < 2; p++) held[p] += game.targets[p].length;
    kills += ev.kills.length;
    captures += ev.captures.length;
    peak = Math.max(peak, game.dots.length);
    // lead changes in spawns owned: a rough measure of how swingy the game is
    const owned = [0, 1].map((p) => game.spawns.filter((s) => s.owner === p).length);
    const lead = owned[0] > owned[1] ? 0 : owned[1] > owned[0] ? 1 : leader;
    if (leader >= 0 && lead !== leader) flips++;
    leader = lead;
    lockedSum += game.dots.filter((d) => d.locked).length / Math.max(1, game.dots.length);
  }
  const ms = performance.now() - t0;
  // winnerCfg: which configuration won (0 = cpuTargets0, 1 = cpuTargets1)
  const winnerCfg = game.winner < 0 ? -1 : flipped ? 1 - game.winner : game.winner;
  results.push({ seed, winner: game.winner, winnerCfg, held0: +(held[0] / game.tick).toFixed(2), held1: +(held[1] / game.tick).toFixed(2),
    cfg0Side: flipped ? 'red' : 'blue', secs: Math.round(game.tick / 8), kills, captures, flips, peak,
    lockedPct: Math.round((100 * lockedSum) / game.tick), msPerTick: +(ms / game.tick).toFixed(3) });
}
console.table(results);
const done = results.filter((r) => r.winner >= 0);
const avg = (k) => (done.reduce((a, r) => a + r[k], 0) / Math.max(1, done.length)).toFixed(1);
const se = (k) => { const n = done.length, m = done.reduce((a, r) => a + r[k], 0) / n; return Math.sqrt(done.reduce((a, r) => a + (r[k] - m) ** 2, 0) / (n - 1) / n).toFixed(1); };
console.log(`finished ${done.length}/${games * (swap ? 2 : 1)}  blue ${done.filter((r) => r.winner === 0).length}  red ${done.filter((r) => r.winner === 1).length}  avg secs ${avg('secs')}  avg captures ${avg('captures')}  avg lead changes ${avg('flips')} ±${se('flips')}  avg peak ${avg('peak')}`);

// average targets held per tick, over all games (finished or not)
const heldAvg = (k) => (results.reduce((a, r) => a + r[k], 0) / results.length).toFixed(2);
console.log(`avg targets held  blue ${heldAvg('held0')}  red ${heldAvg('held1')}`);
if (swap) {
  // per configuration: cpuTargets0 / cpuTargets1 wherever they sat
  const cfgHeld = (c) => (results.reduce((a, r) => a + ((r.cfg0Side === 'blue') === (c === 0) ? r.held0 : r.held1), 0) / results.length).toFixed(2);
  for (const c of [0, 1]) {
    const wins = done.filter((r) => r.winnerCfg === c).length;
    console.log(`config ${c} (cpuTargets${c}=${cpuTargets[c] ?? 'default'})  wins ${wins}/${done.length} = ${(100 * wins / Math.max(1, done.length)).toFixed(0)}%  avg targets held ${cfgHeld(c)}`);
  }
}
