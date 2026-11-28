// Runs CPU-vs-CPU games without a browser, to tune default parameters.
// Usage: node wooden-ships/tools/headless.js [games] [key=value ...]
//   level0=easy|hard, level1=easy|hard (default hard), any DEFAULTS key (e.g. islands=many wind=gusty),
//   ship.<key>=N to change the frigate (e.g. ship.mass=8), minutes=N (default 6).
import { createGame, applyInput, step, SHIP_TYPES, BLUE, RED, DRAW } from '../src/sim.js';
import { createAI } from '../src/ai.js';

const args = process.argv.slice(2);
const games = Number(args[0] ?? 20);
/** @type {Record<string, any>} */
const overrides = {};
const levels = ['hard', 'hard'];
let minutes = 6;
for (const kv of args.slice(1)) {
  const [k, v] = kv.split('=');
  const val = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
  if (k === 'level0') levels[0] = v;
  else if (k === 'level1') levels[1] = v;
  else if (k === 'minutes') minutes = Number(v);
  else if (k.startsWith('ship.')) SHIP_TYPES.frigate[k.slice(5)] = val;
  else overrides[k] = val;
}

const rows = [];
for (let g = 0; g < games; g++) {
  const seed = 1000 + g;
  const game = createGame({ ...overrides, seed });
  const maxTicks = minutes * 60 * game.params.tickRate;
  const ais = [createAI(0, seed * 3 + 1, { level: levels[0] }), createAI(1, seed * 7 + 2, { level: levels[1] })];
  let firstHit = -1, firstHitBy = -1, upwindAtShift = -1, bumps = 0, inIrons = [0, 0];
  const t0 = performance.now();
  while (game.winner < 0 && game.tick < maxTicks) {
    for (const ai of ais) for (const input of ai.think(game)) applyInput(game, ai.ship, input);
    const ev = step(game);
    if (ev.hits.length && firstHit < 0) { firstHit = game.tick; firstHitBy = game.ships[ev.hits[0].by].side; }
    if (ev.shift && upwindAtShift < 0 && game.tick > 1) {
      // Who's upwind when the first shift comes: the one further toward where the wind blows from.
      const [a, b] = game.ships;
      const fx = -Math.cos(game.wind.toDir * 2 * Math.PI / 65536), fy = -Math.sin(game.wind.toDir * 2 * Math.PI / 65536);
      upwindAtShift = ((a.x - b.x) * -fx + (a.y - b.y) * -fy) > 0 ? BLUE : RED;
    }
    bumps += ev.bumps.length;
    for (const s of game.ships) {
      const v = Math.hypot(s.vx, s.vy);
      if (v < 0.3) inIrons[s.side]++;
    }
  }
  rows.push({
    seed, winner: game.winner, secs: (game.ending >= 0 ? game.ending : game.tick) / game.params.tickRate,
    crew: game.ships.map((s) => s.crew), fired: game.stats.fired, hits: game.stats.hits,
    firstHitBy, firstHit: firstHit / game.params.tickRate, upwindAtShift, bumps,
    stopped: inIrons.map((t) => t / game.params.tickRate), ms: performance.now() - t0,
  });
}

const pct = (n) => `${Math.round((100 * n) / rows.length)}%`;
const finished = rows.filter((r) => r.winner >= 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
for (const r of rows) {
  const w = r.winner === BLUE ? 'blue' : r.winner === RED ? 'red ' : r.winner === DRAW ? 'draw' : '----';
  console.log(`seed ${r.seed}: ${w} ${r.secs.toFixed(0).padStart(4)}s crew ${r.crew.join('/').padEnd(5)} shots ${r.fired.join('/')} hits ${r.hits.join('/')} first hit ${r.firstHit >= 0 ? r.firstHit.toFixed(0) + 's' : '-'} stopped ${r.stopped.map((s) => s.toFixed(0)).join('/')}s bumps ${r.bumps} (${r.ms.toFixed(0)} ms)`);
}
const shots = rows.reduce((a, r) => a + r.fired[0] + r.fired[1], 0), hits = rows.reduce((a, r) => a + r.hits[0] + r.hits[1], 0);
console.log(`\n${rows.length} games, ${levels[0]} (blue) vs ${levels[1]} (red), ${JSON.stringify(overrides)}`);
console.log(`finished in ${minutes} min: ${pct(finished.length)}; mean length ${mean(finished.map((r) => r.secs)).toFixed(0)} s`);
console.log(`blue ${pct(rows.filter((r) => r.winner === BLUE).length)}, red ${pct(rows.filter((r) => r.winner === RED).length)}, draws ${pct(rows.filter((r) => r.winner === DRAW).length)}`);
console.log(`accuracy ${(100 * hits / Math.max(1, shots)).toFixed(0)}% of ${shots} balls`);
const fh = finished.filter((r) => r.firstHitBy >= 0);
console.log(`first to hit went on to win: ${fh.length ? Math.round(100 * fh.filter((r) => r.firstHitBy === r.winner).length / fh.length) : '-'}%`);
const up = finished.filter((r) => r.upwindAtShift >= 0);
console.log(`upwind at the first shift went on to win: ${up.length ? Math.round(100 * up.filter((r) => r.upwindAtShift === r.winner).length / up.length) : '-'}% of ${up.length}`);
