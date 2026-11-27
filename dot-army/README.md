# Dot Army

Two swarms of little arrowheads fight over spawn points, and all you control is where they're headed.

Drag a marker and your dots stream after it. A dot destroys any enemy it's facing, unless that enemy is facing it back, in which case they're stuck glaring at each other until someone circles round behind. Park a marker on a spawn point and your dots throw themselves at it until it's yours. Take all of your opponent's spawn points and mop up their last dots to win.

You can have up to three markers (the Targets setting can lower that): tap empty board to add one, tap a marker to remove it, drag to move it. Each dot goes to whichever of your markers is nearest, so a second marker parked by your spawns soaks up every new dot and your attack goes hungry. Extra markers buy defence with attack. You can't see your opponent's markers, only where their dots are going.

You play the CPU, or another person on their own device online. To play someone online, one of you chooses Play online and sends the link (or the code), and the other opens it or chooses Join with code. [NETWORK.md](NETWORK.md) has the details. The [full rules](RULES.md) are short and worth a skim, because the facing rule is the whole game.

## Running it

There's no build step, but browsers won't load ES modules from `file://`, so serve the repo:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/dot-army/>. To play on a phone, use your computer's LAN address instead of `localhost`.

## Online play

Works between two devices through the relay in [`multiplayer/`](../multiplayer/), deployed on Cloudflare. Start from Play online or Join with code. Join a code nobody is hosting and after five seconds the game says so, then keeps waiting in case the host is just late. Not there yet: a QR code, reconnecting after a reload, and a pause that pauses both sides. For development, `?room=TEST&host&relay=bc` and `?room=TEST&relay=bc` in two tabs of one browser play each other with no server. [NETWORK.md](NETWORK.md) has the design and what's left.

## Tests

```
npm test            # simulation rules and the relay, headless (node:test; run npm install once)
npm run typecheck   # optional; fetches TypeScript via npx
node dot-army/tools/headless.js 20   # CPU-vs-CPU games, for tuning
```

## How it works

The simulation in `src/sim.js` is deterministic: integer state, a seeded RNG, and nothing else. Rendering, input, sound and the CPU player all sit on top and never feed back in. Pathfinding is one breadth-first search per player per tick (a flow field), which costs well under a millisecond, and the hex grid uses a precomputed neighbour table, so it's no more expensive than a square grid would be.

Claude wrote most of the code from a rules discussion with me. The tests in `test/sim.test.js` pin down the combat and movement rules, if you want to check its work.

It's MIT licensed, like the rest of the repo. See [LICENSE](../LICENSE).
