// Balance search: plays every cross-faction pairing, from both sides of
// the map, for each combination of settings, and ranks the settings by
// how even the worst pairing is. It also reports how each faction plays
// (where its points go, damage dealt and taken), because a setting that
// balances wins by making the factions play alike isn't a fix.
//
// Usage: node star-troopers/tools/balance.js [gamesPerSide] [key=v1,v2 ...] [top=N]
//   e.g. node star-troopers/tools/balance.js 100 dodgeAimCap=0,3 maxSpend=0,10
import { createGame, resolveTurn, living, pathCost, DRAW, isCover } from '../src/sim.js';
import { createAI } from '../src/ai.js';

const FACTIONS = ['compact', 'orrin', 'vell'];
const PAIRS = [['orrin', 'compact'], ['vell', 'compact'], ['orrin', 'vell']];

const args = process.argv.slice(2);
const perSide = Number(args[0] ?? 100);
let top = 3;
/** @type {Record<string, (string|number)[]>} */
const axes = {};
for (const kv of args.slice(1)) {
  const [k, v] = kv.split('=');
  if (k === 'top') { top = Number(v); continue; }
  axes[k] = v.split(',').map((x) => (isNaN(Number(x)) ? x : Number(x)));
}
/** @param {Record<string, (string|number)[]>} ax */
function combos(ax) {
  /** @type {Record<string, string|number>[]} */
  let out = [{}];
  for (const [k, vs] of Object.entries(ax)) out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })));
  return out;
}

/** Per-faction running totals. */
const blankProfile = () => ({ move: 0, fire: 0, dodge: 0, overwatch: 0, dealt: 0, taken: 0, turns: 0 });

/**
 * @param {Record<string, string|number>} params
 */
function evaluate(params) {
  const shares = [];
  /** @type {Record<string, ReturnType<typeof blankProfile>>} */
  const prof = Object.fromEntries(FACTIONS.map((f) => [f, blankProfile()]));
  let turns = 0, limit = 0, games = 0, tt = 0, inCover = 0;
  for (const [a, b] of PAIRS) {
    let aw = 0, bw = 0;
    for (const flip of [0, 1]) for (let s = 0; s < perSide; s++) {
      const f0 = flip ? b : a, f1 = flip ? a : b;
      const game = createGame({ ...params, seed: 7000 + s, faction0: f0, faction1: f1 });
      const ais = [createAI(0, s * 3 + 1), createAI(1, s * 7 + 2)];
      while (game.winner < 0) {
        const x = ais[0].plan(game), y = ais[1].plan(game);
        const orders = game.troopers.map((t) => (t.side ? y : x)[t.id]);
        for (const t of living(game)) {
          const o = orders[t.id];
          const p = prof[t.faction];
          p.turns++; tt++;
          if (isCover(game, t.cell)) inCover++;
          if (!o) continue;
          p.move += pathCost(game, t.cell, o.path);
          p.fire += o.fire; p.dodge += o.dodge; p.overwatch += o.overwatch;
        }
        const ev = resolveTurn(game, orders);
        for (const sh of ev.shots) {
          prof[game.troopers[sh.from].faction].dealt += sh.shock;
          prof[game.troopers[sh.to].faction].taken += sh.shock;
        }
      }
      games++;
      turns += game.last?.turn ?? 0;
      if ((game.last?.turn ?? 0) >= game.params.turnLimit) limit++;
      if (game.winner !== DRAW) {
        const w = game.winner === 0 ? f0 : f1;
        if (w === a) aw++; else bw++;
      }
    }
    shares.push(Math.round((100 * aw) / Math.max(1, aw + bw)));
  }
  // Where each faction's points go, as percentages of points spent.
  /** @type {Record<string, {move: number, fire: number, dodge: number, overwatch: number, dealt: number, taken: number}>} */
  const profiles = {};
  for (const f of FACTIONS) {
    const p = prof[f];
    const spent = Math.max(1, p.move + p.fire + p.dodge + p.overwatch);
    profiles[f] = {
      move: Math.round((100 * p.move) / spent), fire: Math.round((100 * p.fire) / spent),
      dodge: Math.round((100 * p.dodge) / spent), overwatch: Math.round((100 * p.overwatch) / spent),
      dealt: +(p.dealt / Math.max(1, p.turns)).toFixed(2), taken: +(p.taken / Math.max(1, p.turns)).toFixed(2),
    };
  }
  // How differently the factions play: the smallest difference between any
  // two factions' point splits (sum of absolute percentage differences).
  let distinct = Infinity;
  for (let i = 0; i < FACTIONS.length; i++) for (let j = i + 1; j < FACTIONS.length; j++) {
    const p = profiles[FACTIONS[i]], q = profiles[FACTIONS[j]];
    const d = Math.abs(p.move - q.move) + Math.abs(p.fire - q.fire) + Math.abs(p.dodge - q.dodge) + Math.abs(p.overwatch - q.overwatch);
    distinct = Math.min(distinct, d);
  }
  return {
    shares, profiles,
    worst: Math.max(...shares.map((x) => Math.abs(x - 50))),
    turns: +(turns / games).toFixed(1),
    atLimit: Math.round((100 * limit) / games),
    inCover: Math.round((100 * inCover) / tt),
    distinct,
  };
}

const results = [];
for (const params of combos(axes)) results.push({ params, ...evaluate(params) });
results.sort((a, b) => a.worst - b.worst || b.distinct - a.distinct);

console.table(results.map((r) => ({
  settings: Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ') || 'defaults',
  'O v C': r.shares[0], 'V v C': r.shares[1], 'O v V': r.shares[2], worst: r.worst,
  turns: r.turns, atLimit: r.atLimit, inCover: r.inCover, distinct: r.distinct,
})));
for (const r of results.slice(0, top)) {
  console.log(`\n${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ') || 'defaults'}`);
  console.table(r.profiles);
}
console.log(`\n${perSide * 2} games per pairing (about ±${Math.round(100 / Math.sqrt(perSide * 2))} points). Shares are the first-named faction's wins, draws excluded.`);
console.log('distinct = smallest difference between two factions\' point splits; low means the factions play alike.');
