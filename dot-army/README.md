# Dot Army

Two swarms of little arrowheads fight over spawn points, and all you control is where they're headed.

Drag your marker and your dots stream after it. A dot destroys any enemy it's facing, unless that enemy is facing it back, in which case they're stuck glaring at each other until someone circles round behind. Park your marker on a spawn point and your dots throw themselves at it until it's yours. Take all of your opponent's spawn points and mop up their last dots to win.

You play the CPU, or another person on their own device online. For now, online play starts from a link (see [NETWORK.md](NETWORK.md)). The [full rules](RULES.md) are short and worth a skim, because the facing rule is the whole game.

## Running it

There's no build step, but browsers won't load ES modules from `file://`, so serve the repo:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/dot-army/>. To play on a phone, use your computer's LAN address instead of `localhost`.

## Online play

Half built. Two tabs in one browser can already play each other in perfect sync (`?room=TEST&host` in one, `?room=TEST` in the other), but there's no relay server yet, so two phones can't. [NETWORK.md](NETWORK.md) has the design and the plan.

## Tests

```
npm test            # simulation rules, headless (node:test, no dependencies)
npm run typecheck   # optional; fetches TypeScript via npx
node dot-army/tools/headless.js 20   # CPU-vs-CPU games, for tuning
```

## How it works

The simulation in `src/sim.js` is deterministic: integer state, a seeded RNG, and nothing else. Rendering, input, sound and the CPU player all sit on top and never feed back in. Pathfinding is one breadth-first search per player per tick (a flow field), which costs well under a millisecond, and the hex grid uses a precomputed neighbour table, so it's no more expensive than a square grid would be.

Claude wrote most of the code from a rules discussion with me. The tests in `test/sim.test.js` pin down the combat and movement rules, if you want to check its work.

It's MIT licensed, like the rest of the repo. See [LICENSE](../LICENSE).
