# fidget-toys

Small browser games, one per directory. No build step: plain ES modules,
served as static files. The first toy is `dot-army/`; read its `RULES.md`
before touching game logic, and `NETWORK.md` for online play.
`coreward-bound/` (turn-based, vs the CPU) and `star-troopers/` (sim only,
no UI yet) follow the same rules below; each has its own `RULES.md`.

## Running and checking

```
python3 -m http.server 8000      # then http://localhost:8000/dot-army/
npm install                       # once: the relay's one dependency (ws)
npm test                          # node:test
npm run typecheck                 # tsc --checkJs on files marked // @ts-check
node dot-army/tools/headless.js 20 [key=value ...]   # CPU-vs-CPU balance runs
node coreward-bound/tools/headless.js 40 [key=value ...]
```

Browser checks use the preinstalled Playwright (`require('playwright')`).
Browser checks need the static server on port 8765:
`dot-army/tools/e2e-local.cjs` (CPU play), `dot-army/tools/e2e-two-tab.cjs`
(two tabs, `?relay=bc`), `dot-army/tools/e2e-online.cjs` (lobby, leaving,
errors) and `multiplayer/tools/e2e-relay.cjs` (a game through a relay). The
last two also need a relay: `node multiplayer/server.js`.
`coreward-bound/tools/e2e.cjs` plays Coreward Bound turns and a whole game.

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
  `net.js`, and `multiplayer/room.js`, `relay.js`, `dice.js`, `lobby.js`, `netpanel.js`.
  Keep them type-clean. In `coreward-bound/` and `star-troopers/`,
  `sim.js`, `hex.js`, `rng.js` and `ai.js` are checked too.
- Coreward Bound: a rule change updates `src/sim.js`, `test/sim.test.js`,
  `RULES.md` and the How to play card in its `index.html`, then a headless
  run. Its player settings are `CHOICES` in `main.js` (CPU, Galaxy).
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
