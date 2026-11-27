# fidget-toys

Small browser games, one per directory. No build step: plain ES modules,
served as static files. The toys are `dot-army/` and `wooden-ships/`; read
a toy's `RULES.md` before touching its game logic, and Dot Army's
`NETWORK.md` for online play.

## Running and checking

```
python3 -m http.server 8000      # then http://localhost:8000/dot-army/
npm install                       # once: the relay's one dependency (ws)
npm test                          # node:test
npm run typecheck                 # tsc --checkJs on files marked // @ts-check
node dot-army/tools/headless.js 20 [key=value ...]   # CPU-vs-CPU balance runs
node wooden-ships/tools/headless.js 40 [key=value ...]
```

Browser checks use the preinstalled Playwright (`require('playwright')`).
Browser checks need the static server on port 8765:
`dot-army/tools/e2e-local.cjs` (CPU play), `dot-army/tools/e2e-two-tab.cjs`
(two tabs, `?relay=bc`), `dot-army/tools/e2e-online.cjs` (lobby, leaving,
errors) and `multiplayer/tools/e2e-relay.cjs` (a game through a relay). The
last two also need a relay: `node multiplayer/server.js`. Wooden Ships has
`wooden-ships/tools/e2e-local.cjs` (a CPU game, steering, fire buttons).

## Rules for wooden-ships code

The same determinism rule as Dot Army, with one difference: `sim.js` state
is floats, so it may only use `+ − × ÷`, `sqrt`, `abs`, `min`, `max` and
`Math.round` on them. No `Math.sin`, `atan2`, `hypot` or `**`: use `isin`,
`icos` and `angleOf`, which work on integer headings (65,536 to a turn).
The CPU (`ai.js`) follows the same rule and acts only through
`applyInput`. A rule change means updating `sim.js`, `test/sim.test.js`,
`RULES.md` and the How to play card in `index.html` together, then running
the headless tool. Settings the player sees are the five presets in
`main.js` (`CHOICES`); tuning parameters are `DEFAULTS` and `SHIP_TYPES` in
`sim.js`.

## Rules for dot-army code

- **The simulation must stay deterministic.** `src/sim.js` (and anything it
  calls) uses integers and the seeded RNG in `src/rng.js` only: no
  `Math.random`, no `Date`, no floats that affect state. Network play depends
  on two devices computing identical games. Presentation code (`render.js`,
  `audio.js`, `main.js`) may use floats and `Math.random` freely.
- The CPU (`src/ai.js`) has its own RNG and only ever changes its own
  targets, through the same inputs a human sends (add, remove, move). It must
  never touch game state directly.
- `// @ts-check` files: `sim.js`, `hex.js`, `rng.js`, `ai.js`, `lockstep.js`,
  `net.js`, and `multiplayer/room.js`, `relay.js`, `dice.js`, `lobby.js`, `netpanel.js`;
  in Wooden Ships, `sim.js`, `ai.js` and `rng.js`. Keep them type-clean.
- A rule change means updating, together: `sim.js`, a test in
  `test/sim.test.js`, `RULES.md`, and the How to play card in `index.html`.
  Then run the headless balance tool to check games still finish.
- Settings the player sees are six presets in `main.js` (`CHOICES`: CPU,
  Board, Speed, Spawns, Targets, Obstacles); the
  tuning parameters live in `DEFAULTS` in `sim.js` and are not exposed.

## Deploying

- `main` deploys automatically to GitHub Pages at
  <https://schuyler.info/fidget-toys/> (the custom domain comes from the
  `schuyler/schuyler.github.io` repo's `CNAME`). `.nojekyll` keeps Pages from
  processing files. Browsers may cache for ~10 minutes.
- Work happens on a `claude/...` branch. The owner approves each change, then
  it is **squash-merged** to `main` via a pull request.
- After a squash merge the branch and `main` have the same content but
  different history, and force-pushing the branch is not allowed. Before the
  next PR, confirm `git diff origin/main HEAD` is empty for already-merged
  work, then record main in the branch with
  `git merge -s ours origin/main` so the next PR doesn't conflict.
- The network relay lives in `multiplayer/` (see its README): a Node server
  for the owner's home host, or a Cloudflare Worker the owner deploys with
  `npx wrangler@4.158.0 deploy` from `multiplayer/`. Games stay dependency-free in the browser;
  `ws` is only for the Node server.

## Writing

READMEs and user-facing docs follow the `schuyler-docs` style: lead with what
the thing does, no marketing language, honest about rough edges. The repo is
MIT licensed (`LICENSE`).
