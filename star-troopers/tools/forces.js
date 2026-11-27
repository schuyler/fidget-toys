// Force matching: how many troopers of one faction are worth how many of
// another? For each pair of factions, plays every combination of squad
// sizes (from both sides of the map) and prints the first faction's share
// of decisive games. Balanced combinations are where that crosses 50%.
//
// Usage: node star-troopers/tools/forces.js [gamesPerSide] [sizes=3,4,5,6] [pairs=orrin:compact,...] [key=value ...]
import { createGame, resolveTurn, DRAW } from '../src/sim.js';
import { createAI } from '../src/ai.js';

const args = process.argv.slice(2);
const perSide = Number(args[0] ?? 50);
let sizes = [3, 4, 5, 6];
let pairs = [['orrin', 'compact'], ['vell', 'compact'], ['orrin', 'vell']];
/** @type {Record<string, string|number>} */
const params = {};
for (const kv of args.slice(1)) {
  const [k, v] = kv.split('=');
  if (k === 'sizes') sizes = v.split(',').map(Number);
  else if (k === 'pairs') pairs = v.split(',').map((p) => p.split(':'));
  else params[k] = isNaN(Number(v)) ? v : Number(v);
}

/** Share of decisive games won by `a` fielding na against `b` fielding nb. */
function share(/** @type {string} */ a, /** @type {number} */ na, /** @type {string} */ b, /** @type {number} */ nb) {
  let aw = 0, bw = 0, turns = 0;
  for (const flip of [0, 1]) for (let s = 0; s < perSide; s++) {
    const game = createGame(flip
      ? { ...params, seed: 9000 + s, faction0: b, squad0: nb, faction1: a, squad1: na }
      : { ...params, seed: 9000 + s, faction0: a, squad0: na, faction1: b, squad1: nb });
    const ais = [createAI(0, s * 3 + 1), createAI(1, s * 7 + 2)];
    while (game.winner < 0) {
      const x = ais[0].plan(game), y = ais[1].plan(game);
      resolveTurn(game, game.troopers.map((t) => (t.side ? y : x)[t.id]));
    }
    turns += game.last?.turn ?? 0;
    if (game.winner === DRAW) continue;
    const aSide = flip ? 1 : 0;
    if (game.winner === aSide) aw++; else bw++;
  }
  return { pct: Math.round((100 * aw) / Math.max(1, aw + bw)), turns: +(turns / (2 * perSide)).toFixed(1) };
}

for (const [a, b] of pairs) {
  /** @type {Record<string, Record<string, string>>} */
  const table = {};
  for (const na of sizes) {
    /** @type {Record<string, string>} */
    const row = {};
    for (const nb of sizes) {
      const r = share(a, na, b, nb);
      row[`${nb} ${b}`] = `${r.pct}% (${r.turns}t)`;
    }
    table[`${na} ${a}`] = row;
  }
  console.log(`\n${a} vs ${b}: ${a}'s share of decisive games (average turns)`);
  console.table(table);
}
console.log(`\n${perSide * 2} games per cell (about ±${Math.round(100 / Math.sqrt(perSide * 2))} points).`);
