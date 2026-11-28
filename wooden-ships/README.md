# Wooden Ships

A two-ship sailing duel, against the CPU or another person online. You steer; the wind sets your speed. Line up a broadside before your rival does, cross her bow or stern if you can, and don't get caught head to wind with no way on.

Play it at <https://schuyler.info/fidget-toys/wooden-ships/>, or serve the repo (`python3 -m http.server 8000`) and open <http://localhost:8000/wooden-ships/>. The rules are in [RULES.md](RULES.md).

## Playing

- Drag sideways anywhere to steer: drag the way you want the bow to swing. Let go and the rudder centres.
- Or pick the wheel in Settings (Steering): turn it clockwise and the ship turns clockwise, whichever way she's heading. A quarter turn is full rudder, and it spins back to centre when you let go.
- The two buttons along the bottom fire the broadside facing that way on screen. The arrow (a cannon, with the wheel) shows where the guns point; the ring is the reload.
- Waves roll downwind across the sea. Point your bow too close to where they're coming from and you stop: that's the no-go zone, 45° either side of the wind.
- The sea is bigger than the screen and the view follows you. An arrow on the edge points at the enemy when she's out of sight.
- Play online / Join with code works as in Dot Army: the host sails blue and picks the settings, the guest sails red.
- Keyboard: → turns clockwise (to starboard) and ← anticlockwise, whichever way she's heading; Z and X fire.

## How it's built

Plain ES modules, no build step, same layout as Dot Army.

- `src/sim.js` is the whole game: deterministic, seeded, fixed 30 ticks a second. State is floats, but only `+ − × ÷` and `sqrt` touch it; headings are integers and sines come from a table built with `+` and `×`. That's what lets network play run lockstep: both devices compute the same game from the same inputs.
- `src/ai.js` is the CPU. It plays through the same inputs you do: rudder and two fire buttons.
- `src/net.js` is the network glue: `PROTOCOL`, the input delay, and the adapter for the shared lockstep in `multiplayer/lockstep.js`.
- `src/render.js`, `src/main.js`, `src/audio.js` are presentation: canvas, input, Web Audio. `main.js` also holds the online session (lobby, handshake, rematches), copied from Dot Army's.
- `test/sim.test.js` covers the sailing model (no-go zone, keel, rudder), gunnery (raking, reloads), striking, the island generator and determinism. `npm test` runs it with the rest of the repo's tests.
- `tools/headless.js` runs CPU-vs-CPU games for tuning: `node wooden-ships/tools/headless.js 40 islands=many wind=gusty`.
- `tools/e2e-local.cjs` drives a real browser (Playwright) through a game. It needs the repo served on port 8765.
- `tools/e2e-two-tab.cjs` plays online between two tabs (`?relay=bc`) and checks both compute the same game. With `RELAY=ws://127.0.0.1:8788` and `node multiplayer/server.js` running, it goes through the relay and checks leaving too.

## Rough edges

- The sea is about 3 km square. CPU-vs-CPU games still finish in a minute or two, but nothing stops a person from running away; there's no time limit yet.
- The camera zoom (450 m across the screen's short side) is a first guess. Gun range is 300 m, two thirds of that, so the CPU can fire at you from just past the short edges of the screen. Its arrow shows the distance: under 300 m, it's in range.
- Upwind is slow (about 2 knots made good against 14 downwind), which makes the weather gauge matter a lot. Whether that's fun is still to be found out.
- The CPU doesn't play the weather gauge. Easy is a lot weaker than hard in CPU-vs-CPU games (hard wins 93% on the big sea), but how it fares against people is untested.
- Online play has only been tried between two tabs and through a relay on the same machine, not between two phones over the internet. The 133 ms input delay is a guess at what the deployed relay needs; `?delay=N` (in ticks) tries others.
- Online, the guest sees the sea the same way up as the host, so red starts at the top of the screen sailing down it. Dot Army turns the board round for its guest; Wooden Ships doesn't yet.
- Drag steering flips when your ship heads down the screen (drag the way the bow should swing), and you hold the button through a turn. The wheel is the alternative, but hasn't been playtested yet, and neither has a phone. [IDEAS.md](IDEAS.md) has the ideas waiting their turn.

## Art

The ship sprites and terrain tiles come from the 2022 prototype ([schuyler/wooden-ships](https://github.com/schuyler/wooden-ships)). Their names match Kenney's [Pirate Pack](https://kenney.nl/assets/pirate-pack), which is CC0, but the files haven't been checked against the pack itself yet.
