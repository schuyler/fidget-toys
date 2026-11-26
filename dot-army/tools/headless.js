// Runs CPU-vs-CPU games without a browser, to tune default parameters.
// Usage: node dot-army/tools/headless.js [games] [key=value ...]
import { createGame, setTarget, step } from '../src/sim.js';
import { createAI } from '../src/ai.js';

const args = process.argv.slice(2);
const games = Number(args[0] ?? 20);
const overrides = {};
for (const kv of args.slice(1)) {
  const [k, v] = kv.split('=');
  overrides[k] = isNaN(Number(v)) ? v : Number(v);
}
const maxTicks = 8 * 60 * 6; // six minutes at 8 ticks/s

const results = [];
for (let g = 0; g < games; g++) {
  const seed = 1000 + g;
  const game = createGame({ ...overrides, seed });
  const ais = [createAI(0, seed * 3 + 1, { dragSpeed: 2.2 }), createAI(1, seed * 7 + 2, { dragSpeed: 2.2 })];
  let kills = 0, captures = 0, peak = 0, lockedSum = 0;
  const t0 = performance.now();
  while (game.winner < 0 && game.tick < maxTicks) {
    for (const ai of ais) {
      const t = ai.think(game);
      if (t !== null) setTarget(game, ai.player, t);
    }
    const ev = step(game);
    kills += ev.kills.length;
    captures += ev.captures.length;
    peak = Math.max(peak, game.dots.length);
    lockedSum += game.dots.filter((d) => d.locked).length / Math.max(1, game.dots.length);
  }
  const ms = performance.now() - t0;
  results.push({ seed, winner: game.winner, secs: Math.round(game.tick / 8), kills, captures, peak,
    lockedPct: Math.round((100 * lockedSum) / game.tick), msPerTick: +(ms / game.tick).toFixed(3) });
}
console.table(results);
const done = results.filter((r) => r.winner >= 0);
const avg = (k) => (done.reduce((a, r) => a + r[k], 0) / Math.max(1, done.length)).toFixed(1);
console.log(`finished ${done.length}/${games}  blue ${done.filter((r) => r.winner === 0).length}  red ${done.filter((r) => r.winner === 1).length}  avg secs ${avg('secs')}  avg captures ${avg('captures')}`);
