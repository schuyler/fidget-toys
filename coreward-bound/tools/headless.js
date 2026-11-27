// Runs CPU-vs-CPU games without a browser, to tune the rules' numbers.
//
// Usage: node coreward-bound/tools/headless.js [games] [key=value ...] [-v]
//
// Any sim parameter can be set, and a comma list sweeps it: every
// combination of the listed values gets its own row. `level=easy|hard`
// sets both CPUs; `level0=` and `level1=` set one each. For example:
//
//   node coreward-bound/tools/headless.js 40 galaxy=small,medium,large
//   node coreward-bound/tools/headless.js 40 level0=hard level1=easy
import { createGame, act, DRAW, score } from '../src/sim.js';
import { createAI } from '../src/ai.js';

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const rest = args.filter((a) => a !== '-v');
const games = Number(rest[0] ?? 20);
/** @type {Record<string, (string|number)[]>} */
const axes = {};
for (const kv of rest.slice(1)) {
  const [k, v] = kv.split('=');
  axes[k] = v.split(',').map((x) => (isNaN(Number(x)) ? x : Number(x)));
}

/** Every combination of the swept values. */
function combos(/** @type {Record<string, (string|number)[]>} */ ax) {
  /** @type {Record<string, string|number>[]} */
  let out = [{}];
  for (const [k, vs] of Object.entries(ax)) out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })));
  return out;
}

const rows = [];
for (const combo of combos(axes)) {
  const { level = 'hard', level0, level1, ...params } = combo;
  const label = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(' ') || 'defaults';
  const t = { wins: [0, 0], draws: 0, relic: 0, elim: 0, score: 0, rounds: 0, firstRelic: 0, firstRelicN: 0,
    jumps: 0, scatters: 0, lost: 0, combats: 0, flips: 0, settlements: 0, techs: 0, ms: 0 };
  const perGame = [];
  for (let n = 0; n < games; n++) {
    const seed = 1000 + n;
    const started = Date.now();
    const game = createGame({ ...params, seed });
    const ais = [createAI(0, seed * 3 + 1, { level: /** @type {any} */ (level0 ?? level) }),
      createAI(1, seed * 7 + 2, { level: /** @type {any} */ (level1 ?? level) })];
    let firstRelic = 0;
    while (game.winner < 0) {
      const a = ais[game.current].next(game);
      const ev = act(game, a);
      if ('error' in ev) { console.error('refused', a, ev.error); act(game, { kind: 'end' }); continue; }
      for (const e of ev) {
        if (e.type === 'jump') { t.jumps++; if (e.scatter) t.scatters++; if (e.lost) t.lost++; }
        if (e.type === 'combat') t.combats++;
        if (e.type === 'flip' && e.ok) t.flips++;
        if (e.type === 'deliver' && !firstRelic) firstRelic = game.turn >> 1;
      }
    }
    t.ms += Date.now() - started;
    if (game.winner === DRAW) t.draws++;
    else t.wins[game.winner]++;
    if (game.winBy === 'relics') t.relic++;
    if (game.winBy === 'elimination') t.elim++;
    if (game.winBy === 'score') t.score++;
    const rounds = game.turn >> 1;
    t.rounds += rounds;
    if (firstRelic) { t.firstRelic += firstRelic; t.firstRelicN++; }
    const towns = [0, 1].map((c) => game.owner.filter((o) => o === c).length);
    t.settlements += towns[0] + towns[1];
    t.techs += game.civs[0].techs.length + game.civs[1].techs.length;
    if (verbose) perGame.push({ seed, winner: game.winner === DRAW ? 'draw' : game.winner, by: game.winBy, rounds,
      towns: towns.join('/'), relics: game.civs.map((c) => c.relics).join('/'), techs: game.civs.map((c) => c.techs.length).join('/'),
      score: [score(game, 0), score(game, 1)].join('/'), fleets: [0, 1].map((c) => game.stacks.filter((s) => s.owner === c).reduce((a, s) => a + s.fleets, 0)).join('/') });
  }
  if (verbose) { console.log(label); console.table(perGame); }
  const pct = (/** @type {number} */ x, /** @type {number} */ of) => (of ? Math.round((100 * x) / of) : 0);
  rows.push({
    config: label,
    win0: pct(t.wins[0], games), win1: pct(t.wins[1], games), draw: pct(t.draws, games),
    relic: pct(t.relic, games), elim: pct(t.elim, games), score: pct(t.score, games),
    rounds: +(t.rounds / games).toFixed(1),
    relic1: t.firstRelicN ? +(t.firstRelic / t.firstRelicN).toFixed(1) : '-',
    scatter: pct(t.scatters, t.jumps), lost: pct(t.lost, t.jumps),
    fights: +(t.combats / games).toFixed(1), flips: +(t.flips / games).toFixed(1),
    towns: +(t.settlements / games).toFixed(1), techs: +(t.techs / games).toFixed(1),
    ms: Math.round(t.ms / games),
  });
}
console.table(rows);
console.log(`${games} games per row. win/relic/elim/score are % of games (how they ended); rounds = game length;`);
console.log('relic1 = round of the first relic delivered; scatter/lost = % of jumps; fights, flips, towns (at the end), techs per game.');
