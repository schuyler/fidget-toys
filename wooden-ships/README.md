# Wooden Ships

A two-ship sailing duel. You steer; the wind sets your speed. Line up a broadside before the CPU does, cross its bow or stern if you can, and don't get caught head to wind with no way on.

Play it at <https://schuyler.info/fidget-toys/wooden-ships/>, or serve the repo (`python3 -m http.server 8000`) and open <http://localhost:8000/wooden-ships/>. The rules are in [RULES.md](RULES.md).

## Playing

- Drag sideways anywhere to steer: drag the way you want the bow to swing. Let go and the rudder centres.
- Or pick the wheel in Settings (Steering): turn it clockwise and the ship turns clockwise, whichever way she's heading. A quarter turn is full rudder, and it spins back to centre when you let go.
- The two buttons along the bottom fire the broadside facing that way on screen. The arrow (a cannon, with the wheel) shows where the guns point; the ring is the reload.
- Waves roll downwind across the sea. Point your bow too close to where they're coming from and you stop: that's the no-go zone, 45° either side of the wind.
- The sea is bigger than the screen and the view follows you. An arrow on the edge points at the CPU when it's out of sight.
- Keyboard: → turns clockwise (to starboard) and ← anticlockwise, whichever way she's heading; Z and X fire.

## How it's built

Plain ES modules, no build step, same layout as Dot Army.

- `src/sim.js` is the whole game: deterministic, seeded, fixed 30 ticks a second. State is floats, but only `+ − × ÷` and `sqrt` touch it; headings are integers and sines come from a table built with `+` and `×`. That's so network play can run lockstep later.
- `src/ai.js` is the CPU. It plays through the same inputs you do: rudder and two fire buttons.
- `src/render.js`, `src/main.js`, `src/audio.js` are presentation: canvas, input, Web Audio.
- `test/sim.test.js` covers the sailing model (no-go zone, keel, rudder), gunnery (raking, reloads), striking, the island generator and determinism. `npm test` runs it with the rest of the repo's tests.
- `tools/headless.js` runs CPU-vs-CPU games for tuning: `node wooden-ships/tools/headless.js 40 islands=many wind=gusty`.
- `tools/e2e-local.cjs` drives a real browser (Playwright) through a game. It needs the repo served on port 8765.

## Rough edges

- The sea is about 3 km square. CPU-vs-CPU games still finish in a minute or two, but nothing stops a person from running away; there's no time limit yet.
- The camera zoom (450 m across the screen's short side) is a first guess. Gun range is 300 m, two thirds of that, so the CPU can fire at you from just past the short edges of the screen. Its arrow shows the distance: under 300 m, it's in range.
- Upwind is slow (about 2 knots made good against 14 downwind), which makes the weather gauge matter a lot. Whether that's fun is still to be found out.
- The CPU doesn't play the weather gauge. Easy is a lot weaker than hard in CPU-vs-CPU games (hard wins 93% on the big sea), but how it fares against people is untested.
- No network play yet.
- Drag steering flips when your ship heads down the screen (drag the way the bow should swing), and you hold the button through a turn. The wheel is the alternative, but hasn't been playtested yet, and neither has a phone. [IDEAS.md](IDEAS.md) has the ideas waiting their turn.

## Art

The ship sprites and terrain tiles come from the 2022 prototype ([schuyler/wooden-ships](https://github.com/schuyler/wooden-ships)). Their names match Kenney's [Pirate Pack](https://kenney.nl/assets/pirate-pack), which is CC0, but the files haven't been checked against the pack itself yet.
