# Dot Army: online play

Status: **phases 1 and 2 done, phase 3 partly.** Two devices play through
the relay in `multiplayer/`, starting from Play online or Join with code.
This document is the design, what exists, and the plan for the rest.

## Decisions already made

- **Host is blue, and the host's settings apply.** The host's screen also
  decides the board's dimensions; the guest fits that board to its screen.
- **Lockstep over a relay.** Devices exchange inputs only, through the relay
  in `multiplayer/`: a Cloudflare Worker with one Durable Object per room, or
  the same room logic as a Node server.
- **The owner deploys the relay** (`npx wrangler@4.158.0 deploy` from
  `multiplayer/`). It's at `wss://fidget-rooms.erle.workers.dev` for now; a
  custom domain is optional.
- **No accounts, no strangers.** You join by link or room code (a QR code is still to do).

## How it works

The simulation is deterministic: same seed plus same inputs gives the same
game, bit for bit (integers and a seeded RNG only; see `CLAUDE.md`). So each
device runs the whole game itself, and the only thing sent is each player's
target inputs (add, remove or move a target), stamped with the tick they take
effect on.

`src/lockstep.js` (Dot Army's adapter for the shared `multiplayer/lockstep.js`):

- **Inputs.** The same `Input` objects the sim takes (`applyInput` in
  `sim.js`), which the CPU also produces:
  `{op:'move', index, cell}`, `{op:'add', cell}` or `{op:'remove', index}`.
  Each device keeps its own copy of its player's targets and validates an
  input against it before sending, so the other device never gets one it
  would refuse. It checks anyway: the sim rejects an add at the cap, a
  remove of the last target, or a bad index or cell.
- **Input delay.** Your inputs are scheduled `delay` ticks ahead (default 3,
  which is 375 ms at the Average speed of 8 ticks/s). Your markers still
  follow your finger instantly; only your dots react a moment later. While a
  tick's inputs wait to be sent, a move replaces an earlier move of the same
  target if no add or remove came between them, so a long drag before the
  first send goes out as one move.
- **No guessing.** A device advances to tick T only once it has both players'
  inputs for T. If the other device goes quiet, this one stalls and the UI
  shows "WAITING" after 600 ms. Taps and drags are ignored while WAITING is
  showing, so a long stall can't pile up a message bigger than the relay's
  4096-byte cap (which would disconnect you).
- **Desync check.** Every 8 ticks each side sends `stateHash(game)`; a
  mismatch stops the game with "OUT OF SYNC". So far it has never fired
  outside the test that corrupts state on purpose.
- **Input log.** Every input the sim accepted is kept as
  `[tick, player, Input]`. That plus the seed replays the whole game, which is
  how reconnection will work.

Bandwidth is tiny: one small JSON message per player per tick, plus a hash
message every 8 ticks.

### Messages

All are plain JSON. Lockstep and hash messages carry `g`, the game number,
so messages from a finished game are ignored after a rematch.

| Message | From | Meaning |
|---|---|---|
| `{k:'hello', v}` | guest | Join request; `v` is `PROTOCOL` from `net.js`. Repeated every 500 ms until answered |
| `{k:'start', g, v, seed, width, height, tickRate, neutralSpawns, extraSpawnRate, maxTargets, terrain}` | host | Deal game `g`. Also used for rematches. The guest plays with exactly these parameters, including the host's Spawns coefficient and Targets cap |
| `{k:'bye', why:'version'}` | host | Protocol mismatch: reload both devices |
| `{k:'in', g, s, t, i}` | both | Seat `s`'s inputs for tick `t`: an `Input[]`, applied in order; `[]` means no change |
| `{k:'h', g, s, t, v}` | both | Seat `s`'s state hash after tick `t` |

Bump `PROTOCOL` in `net.js` whenever the simulation or messages change, so a
cached old client can't play a new one and silently desync. It's 3 now: 2 was
the production-pool rule change, 3 is multiple targets (the `in` message and
the new `start` fields).

### What each player sees

The renderer has a per-player view (`renderer.setView`). In a network game
the guest's board is drawn rotated 180°, so red's home is at the bottom, with
one HUD (own colour on the left) and one copy of each message. Touch input is
mapped back through the same rotation, and every gesture acts on your own
targets only. You never see the other player's markers, only their dots.

## Phase 1: done

- `src/lockstep.js` with tests in `test/lockstep.test.js`. Two devices on a
  laggy fake network stay identical for a whole CPU-vs-CPU game; a device
  that hears nothing stalls after `delay` ticks; corrupting one copy is
  detected.
- `src/net.js`: `PROTOCOL` and a development transport over
  `BroadcastChannel`. (`roomCode()` has since moved to `multiplayer/lobby.js`,
  the transport to `multiplayer/broadcast.js`, and the lockstep itself to
  `multiplayer/lockstep.js`.)
- `src/main.js`: network session (handshake, host deals games, rematches by
  host tap), "You win/You lose", the pause menu hides New game and Settings
  online, and rotating the phone doesn't pause an online game.
- Try it: open `/dot-army/?room=TEST&host&relay=bc` in one tab and
  `/dot-army/?room=TEST&relay=bc` in another tab of the same browser. Add `&debug` to expose
  `window.dotArmyDebug()` (tick, state hash, status) for automated checks.
  `tools/e2e-two-tab.cjs` does exactly that.

## Phase 2: relay and lobby

> **Done.** The relay is in `multiplayer/`, and its README replaces the
> relay design below. The lobby is `multiplayer/lobby.js`: Play online shows
> the code, the link and Share; Join with code takes a typed code. The
> deployed relay is the default; `?relay=` overrides it and `?relay=bc` is
> the two-tab development mode. Still to do from this section: the QR code.

### The relay (superseded: see `multiplayer/README.md`)

A Worker plus a Durable Object class, about 50 lines:

- `GET /room/<CODE>?role=host|guest`, upgraded to a WebSocket, is routed to
  the Durable Object `idFromName(CODE)`.
- The object holds at most one host and one guest socket and forwards each
  message to the other side verbatim. It never parses game messages and
  stores nothing.
- Use the **WebSocket Hibernation API** (`ctx.acceptWebSocket(ws, [role])`,
  `webSocketMessage`, `webSocketClose`) so an idle room costs nothing.
- When a socket closes, tell the other side `{k:'peer-left'}`.
- Hygiene: reject a third connection; check `Origin` (allow
  `https://schuyler.info` and `http://localhost:*`); cap message size (1 KB)
  and rate (say 60 messages/s per socket) to protect the free tier.
- `wrangler.toml`: a Durable Object binding and a migration with
  `new_sqlite_classes`. The free plan only offers SQLite-backed Durable
  Objects; the relay doesn't store anything, but the class still has to be
  declared that way. Check the current docs when writing this.
- Local testing: `npx wrangler dev` serves it at `ws://localhost:8787`, and
  the client should accept a `?relay=ws://localhost:8787` override, so the
  whole stack can be tested here before anything is deployed.

**Free tier budget**, from Cloudflare's docs as of November 2026 (re-check):
100,000 requests and 13,000 GB-s of Durable Object duration per day. Incoming
WebSocket messages count as 1/20 of a request each, and outgoing messages are
free. A 10-minute game at 8 ticks/s is about 9,600 incoming messages (480
requests) and about 77 GB-s of duration (128 MB × 600 s, since a busy room
never hibernates). Duration is the binding limit: **roughly 170 ten-minute
games a day.** Over the limit, new connections fail for the rest of the day;
the free plan doesn't bill. Sources:
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

**Custom domain gotcha.** `schuyler.info` is served by GitHub Pages. If its
DNS moves to Cloudflare so the relay can live at, say, `dots.schuyler.info`,
the existing Pages records (the apex A/AAAA records pointing at GitHub, and
any `www` CNAME) must be recreated in Cloudflare and left **DNS-only (grey
cloud)**, or Pages breaks and its HTTPS certificate fails to renew. The Worker
then gets a custom domain in `wrangler.toml`
(`routes = [{ pattern = "dots.schuyler.info", custom_domain = true }]`). A
`*.workers.dev` address works with no DNS changes at all, if that's simpler.

### Client (superseded: built as `multiplayer/relay.js` and `lobby.js`, without reconnect)

- `net.js`: add `websocketTransport(url, room, role)` with the same interface
  as `broadcastTransport`. It reconnects with backoff, and keeps `bc` as a
  dev option (`?via=bc`). The relay URL is a constant in `net.js` (fill it in
  once deployed), overridable with `?relay=`.
- Start menu: add **Play online**. The host gets a room code and a link
  (`https://schuyler.info/fidget-toys/dot-army/?room=CODE`), shown as text,
  a QR code, and a Share button (`navigator.share` where available). Also add
  a **Join with code** box for typing a code.
- QR code: no build step means either vendoring a small MIT-licensed
  generator as one file (e.g. Kazuhiko Arase's `qrcode-generator`), or
  loading it from a CDN at a pinned version. Vendoring keeps the game working
  offline and avoids a third-party request; that's the recommendation.
- Joining by link skips the start menu (this already works for `?room=`).

## Phase 3: robustness

- **Shared pause.** The ☰ menu or backgrounding the app sends `{k:'pause'}`
  and both devices pause. Right now one side pausing just makes the other
  show "WAITING".
- **Peer left.** Done, without the grace period (there's no reconnect yet):
  OPPONENT LEFT, and a tap goes back to the menu. ROOM FULL, CAN'T REACH THE
  SERVER and CONNECTION LOST work the same way.
- **No host.** Done. A guest still on JOINING after 5 s sees NO ONE HERE YET
  with the room code and "☰ to leave". It keeps sending `hello`, so a host
  who opens the room late still starts the game. The relay doesn't say who
  is in a room, so a host slower than 5 s to answer also gets the message.
- **Reconnect.** A guest who reloads sends `hello` mid-game. The host replies
  with `start` plus the input log and current tick, and the guest replays to
  catch up (the sim runs about 5,000 ticks/s, so a 10-minute game replays in
  about a second). A host who reloads ends the game; that's acceptable.
- **Leave game** in the pause menu online. Done.
- **Version skew.** Already handled by `PROTOCOL` (see Messages); make sure
  the error tells people to reload.

## Other open items (not network)

- **Performance on big boards is unmeasured on real phones.** Headless
  Chromium (no GPU) played only about 25 s of game time per 60 s of wall time
  on the win-screen test; real phones are probably much faster, but check a
  Large board with Many spawns on a phone. If it stutters, make drawing
  cheaper first (territory glow, per-dot shadows) before considering a dot
  cap. Dot caps barely matter for balance at Medium (measured).
- **Snowballing.** In CPU-vs-CPU games, the first side to lead by 2+ spawns
  lost 30% of the time, so not severe. Watch human games; the first lever to
  try is a home-spawn advantage (faster regen or higher meter at homes).
- **The start hint overlaps your home spawn** at game start (cosmetic).
- **iOS Safari audio** may need the first `touchend` rather than
  `pointerdown` to unlock. Untested.
- **Dense obstacles:** before the elimination rule, 1 in 12 CPU games on
  "many" obstacles never finished. With elimination plus the
  turn-on-blocking-enemy rule, every game in the test runs finished; keep an
  eye on it in human play.
