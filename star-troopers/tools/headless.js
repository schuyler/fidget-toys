// Runs CPU-vs-CPU games without a browser, to tune the shared formulas.
//
// Usage: node star-troopers/tools/headless.js [games] [key=value ...] [-v]
//
// Any sim parameter can be set, and a comma list sweeps it: every
// combination of the listed values gets its own row. `level=easy|hard`
// sets both CPUs. For example, every pairing in both scenarios:
//
//   node star-troopers/tools/headless.js 40 faction0=compact,orrin,vell \
//     faction1=compact,orrin,vell scenario=meeting,assault
import { createGame, resolveTurn, living, DRAW } from '../src/sim.js';
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

const STALL = 3; // turns in a row with no shock dealt

const rows = [];
for (const combo of combos(axes)) {
  const { level = 'hard', ...params } = combo;
  const label = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(' ') || 'defaults';
  const tally = { wins: [0, 0], draws: 0, attackerWins: 0, turns: 0, limit: 0, firstDown: 0, firstDownN: 0,
    shots: 0, misses: 0, oneShots: 0, freshShots: 0, stallGames: 0, longestQuiet: 0, survivors: 0 };
  let assault = false;
  const perGame = [];
  for (let n = 0; n < games; n++) {
    const seed = 1000 + n;
    const game = createGame({ ...params, seed });
    assault = game.params.scenario === 'assault';
    const ais = [createAI(0, seed * 3 + 1, { level }), createAI(1, seed * 7 + 2, { level })];
    let quiet = 0, longestQuiet = 0, firstDown = 0;
    while (game.winner < 0) {
      const a = ais[0].plan(game), b = ais[1].plan(game);
      const orders = game.troopers.map((t) => (t.side === 0 ? a[t.id] : b[t.id]));
      const ev = resolveTurn(game, orders);
      let dealt = 0;
      for (const s of ev.shots) {
        tally.shots++;
        if (s.miss) tally.misses++;
        dealt += s.shock;
        if (s.shockBefore === 0) {
          tally.freshShots++;
          if (s.shock >= game.troopers[s.to].pool) tally.oneShots++;
        }
      }
      if (!firstDown && ev.downs.length) firstDown = ev.turn;
      quiet = dealt === 0 ? quiet + 1 : 0;
      longestQuiet = Math.max(longestQuiet, quiet);
    }
    if (game.winner === DRAW) tally.draws++;
    else tally.wins[game.winner]++;
    if (assault && game.winner === game.params.attacker) tally.attackerWins++;
    const turns = game.last?.turn ?? 0;
    tally.turns += turns;
    if (turns >= game.params.turnLimit) tally.limit++;
    if (firstDown) { tally.firstDown += firstDown; tally.firstDownN++; }
    if (longestQuiet >= STALL) tally.stallGames++;
    tally.longestQuiet += longestQuiet;
    tally.survivors += living(game).length;
    if (verbose) perGame.push({ seed, winner: game.winner === DRAW ? 'draw' : game.winner, turns, firstDown, longestQuiet,
      left0: living(game, 0).length, left1: living(game, 1).length });
  }
  if (verbose) { console.log(label); console.table(perGame); }
  const pct = (/** @type {number} */ x, /** @type {number} */ of) => (of ? Math.round((100 * x) / of) : 0);
  rows.push({
    config: label,
    win0: pct(tally.wins[0], games),
    win1: pct(tally.wins[1], games),
    draw: pct(tally.draws, games),
    attWin: assault ? pct(tally.attackerWins, games) : '-',
    turns: +(tally.turns / games).toFixed(1),
    atLimit: pct(tally.limit, games),
    firstDown: tally.firstDownN ? +(tally.firstDown / tally.firstDownN).toFixed(1) : '-',
    oneShot: pct(tally.oneShots, tally.freshShots),
    miss: pct(tally.misses, tally.shots),
    stalls: pct(tally.stallGames, games),
  });
}
console.table(rows);
console.log(`${games} games per row. Percentages except turns/firstDown. oneShot = shots at an unhurt trooper that took it down;`);
console.log(`miss = shots where attack < defence; stalls = games with ${STALL}+ turns in a row of no damage.`);
