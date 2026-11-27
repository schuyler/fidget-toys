# Coreward Bound

Two civilizations jump fleets across a spiral galaxy, racing to bring three relics home from its core.

Jumps are instant but inaccurate. Tap a stack, tap a hex, and before you commit the game shows the odds of landing on target and every hex you might scatter to, with a red ✕ on the ones where you'd be lost. The longer the jump, the worse the miss. Settle hexes to make resources, build fleets, and research techs that stretch your range or steady your aim. A chain of settlements lets a stack cross half the galaxy in one turn. Grab a relic by holding a core hex through the CPU's turn, then run it home before the CPU catches you. Taking every one of its settlements also wins.

You play the CPU (Easy or Hard) on a small, medium or large galaxy. The [full rules](RULES.md) cover the numbers.

## Running it

No build step, but browsers won't load ES modules from `file://`, so serve the repo:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/coreward-bound/>.

## Tests

```
npm test                                    # rules, headless (node:test)
npm run typecheck                           # sim.js, hex.js, rng.js, ai.js
node coreward-bound/tools/headless.js 40    # CPU-vs-CPU games, for tuning
node coreward-bound/tools/e2e.cjs           # in a browser; needs the repo served on port 8765
```

`headless.js` takes any sim parameter as `key=value`, and a comma list sweeps it: `galaxy=small,medium,large`, `level0=hard level1=easy`.

## Rough edges

This is the first playable version. Things I know about:

- Games are short: about 11 rounds between two CPUs. Whoever reaches the core first usually wins, and a delivered relic (+1 to everything) snowballs.
- The CPU rarely picks a fight it isn't sure of, so CPU-vs-CPU games average less than one battle. It also leaves its settlements thinly guarded, which a person can punish.
- Hard is better than Easy, but not by a lot: Hard wins about 70% of games against it.
- Stances (cooperate, neutral, hostile), tech trading and network play are in the draft rules but not in the game yet. See [RULES.md](RULES.md).
- No sound.
