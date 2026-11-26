# multiplayer

A room relay for this repo's network games, plus networked dice that no
player can predict or steer. The same relay runs as a Node server at home or
as a Cloudflare Worker.

Status: **step 1 of the plan below.** The relay works: Dot Army plays
through it with `?relay=`. Peer-to-peer comes next, so for now every game
message goes through the relay. The dice are built and unit-tested but no
game uses them yet. Nothing here is on `main`.

## Try it

```
npm install                                  # once, from the repo root: installs ws
node multiplayer/server.js                   # relay on ws://127.0.0.1:8788
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open these two, ideally on different browsers or devices:

```
http://127.0.0.1:8765/dot-army/?room=TEST&host&relay=ws://127.0.0.1:8788
http://127.0.0.1:8765/dot-army/?room=TEST&relay=ws://127.0.0.1:8788
```

Leave out `relay=` and Dot Army falls back to talking between tabs of one
browser, as before.

Checks: `npm test` covers the room logic, the Node server and the dice.
`RELAY=ws://127.0.0.1:8788 node multiplayer/tools/e2e-relay.cjs` plays a
game between two isolated browser contexts and compares their state; it
needs the static server above and a running relay.

## Hosting it

**At home.** `server.js` speaks plain `ws://`; put it behind a reverse
proxy that holds the TLS certificate and forwards the WebSocket upgrade,
because a page served over https can only open `wss://`.

```
PORT=8788 HOST=127.0.0.1 ALLOWED_ORIGINS=https://schuyler.info node multiplayer/server.js
```

`HOST=0.0.0.0` if the proxy runs on another machine. `ALLOWED_ORIGINS` is
comma-separated; an entry ending in `:*` allows any port. Unset, it allows
`https://schuyler.info` plus `http://localhost` and `http://127.0.0.1` on
any port.

**On Cloudflare.** From `multiplayer/`:

```
npx wrangler@4.158.0 dev       # local, ws://localhost:8787
npx wrangler@4.158.0 deploy
```

One Durable Object per room, using the hibernation API, so an idle room
costs nothing. The free plan only offers SQLite-backed objects; the relay
doesn't store anything, but `wrangler.toml` declares the class that way. To
change the allowed origins, set `ALLOWED_ORIGINS` under `[vars]`.

Then point the game at it: `?relay=wss://your-host`.

## The protocol

Connect to `/room/<game>/<code>?seat=<n>`: game is `[a-z0-9-]`, 1–32
characters; code is `[A-Z0-9]`, 1–8 characters; seat 0–7. A bad path gets
400, a request that isn't a WebSocket upgrade 426, a disallowed Origin 403,
a taken seat 409.

```
client → relay   { to?: seat, msg }   to every other seat, or just `to`
relay → client   { from: seat, msg }
relay → client   { from: -1, msg: { k: 'peer-left', seat } }
```

The relay never looks inside `msg`. Frames over 4 KB close the socket (1009),
and so do more than 60 in a second (1008). Those limits and the Origin check
are all that stop a public relay from being used by strangers, and a script
can fake an Origin. Fine among friends; not a security boundary.

`relay.js` is the browser side: `relayTransport(url, game, code, seat)` with
the same `send` / `onMessage` / `close` as Dot Army's transports. It doesn't
reconnect, and if the relay refuses it the game just keeps waiting for the
other player, with no error.

## Dice

```js
import { createDice } from './dice.js';
const dice = await createDice({ seats: 2, local: mySeat });
send({ anchor: dice.anchor });          // once, before play
dice.setAnchor(theirSeat, theirAnchor); // once per other seat
// rolls are numbered 1, 2, 3…; each seat's must be received in order
// for roll k: everyone reveals, everyone delivers to everyone
send({ die: k, v: dice.reveal(k) });
await dice.receive(theirSeat, k, theirValue); // false if it doesn't check out
if (dice.ready(k)) rng = createRng(await dice.seed(k)); // the game's own seeded RNG
```

Each seat commits to a hash chain before play starts and reveals one link
per roll (4096 rolls by default; `createDice({ length })` changes it). A
link can't be swapped, because it has to hash to the previous
one. The seed hashes every seat's link together, so nobody knows it until
the last seat reveals. A roll costs one round trip: the roller sends its
link with its move, and the others answer with theirs.

The hole: the last seat to reveal can work out the result first and
refuse to send. Nothing short of a trusted server prevents that, so a game
should treat a stall as leaving. The dice also need Web Crypto, which
browsers only provide on https and localhost; a page on plain http at a LAN
address won't have it.

# The plan

This is the design for the whole layer. It builds on Dot Army's
deterministic lockstep (`dot-army/src/lockstep.js`) and replaces the relay
design in `dot-army/NETWORK.md`.

## Goals

- Works for Dot Army (real-time, 8 ticks/s), Coreward Bound (turn-based,
  dice, hidden information), and whatever comes next that looks like either.
- Runs on the Cloudflare Workers free plan, which fails rather than bills
  when you go over, or on a home server.
- Players connect directly to each other wherever they can.
- No accounts and no strangers: you join by link, QR code or room code, as
  NETWORK.md already decided.

## Why peer-to-peer

The relay in NETWORK.md forwards every message through a Durable Object. It
estimates about **170 ten-minute games a day** before hitting the free limit.
The limit is Durable Object *duration*, not requests. A Dot Army room gets a
message every 125 ms, so it never goes idle long enough to hibernate, and
it's billed for the whole game (128 MB × 600 s ≈ 77 GB-s, against 13,000
GB-s a day).

With WebRTC, the Durable Object only handles connection setup: an offer, an
answer, and a handful of network candidates. That takes a few seconds and a
dozen or so messages, after which both sockets close. That's under 1 GB-s a
game. By my arithmetic, not a measurement, the daily cap moves from
about 170 games into the thousands. After setup, game traffic goes directly
between devices over a DataChannel, which is reliable and ordered by
default. That's the delivery guarantee lockstep already assumes.

STUN (`stun.cloudflare.com`) is free and unlimited.

### When P2P fails

Some pairs can't connect directly, mostly phones behind carrier NAT. I
don't have a trustworthy number for how many, but it's enough to need a
fallback. Two options:

1. **Relay through the Durable Object (recommended).** This is the relay
   NETWORK.md already designed, now used only as a fallback, so only failed
   games pay its duration cost. It stays inside the Workers free plan.
2. **Cloudflare Realtime TURN.** $0.05/GB after 1,000 GB free per month,
   shared with the Realtime SFU. Dot Army's traffic is small enough that
   this is effectively unlimited. But the Worker has to mint short-lived
   credentials with an API token, and it's a second product that can bill.
   I haven't checked whether it needs a payment method on file.

## Layers

| Layer | Shared? | What it does |
|---|---|---|
| Worker | yes | Connection setup and fallback relay. Optionally stores a command log |
| Transport | yes | Moves messages: P2P, relay, or BroadcastChannel for local dev |
| Session | yes | Handshake, protocol version, seats, pause, peer-left, reconnect |
| Sync | two models | Tick lockstep (real-time) or turn lockstep (turn-based) |
| Game adapter | per game | The game's deterministic simulation, behind a small interface |

### Worker

- `GET /room/<game>/<CODE>`, upgraded to a WebSocket, goes to the Durable
  Object `idFromName('<game>/<CODE>')`. The game in the path keeps rooms of
  different games apart and could let the relay check a per-game seat limit (today it's a global 8).
- **Seats** numbered 0..N-1 instead of host/guest. Seat 0 is the host,
  whose settings apply (as in NETWORK.md).
- It forwards messages unread, tagged with the sender's seat: `{from, msg}`.
  A `to` field sends to one seat, which setup needs; without one, a message
  goes to everyone.
- Hibernation API throughout (`ctx.acceptWebSocket`, `webSocketMessage`,
  `webSocketClose`), so an idle room costs nothing.
- On close, it tells the others `{k:'peer-left', seat}`.
- Hygiene, carried over from NETWORK.md: reject extra connections, check
  `Origin`, and cap message size and rate.
- **Optional command log** for turn-based games, in the object's SQLite
  storage (free plan: 1 GB per object, 5 GB per account). That allows
  reconnecting from any device and play-by-mail-style async games. Real-time
  games don't need it.

### Self-hosting

The room logic in `room.js` does no I/O, so it runs on both hosts:
`worker.js` wraps it in a Durable Object, and `server.js` in a Node
process with a `ws` server and a `Map` of rooms (see Hosting it, above).
The Node server holds sockets open the whole time. Hibernation only exists
to save money on Cloudflare; on your own machine idle sockets cost nothing.
Neither host stores anything yet. The optional command log (above) would
go in the Durable Object's SQLite storage on Cloudflare and a local SQLite
file at home.

Cloudflare's runtime, `workerd`, is open source and runs Durable Objects on
one machine, so it could run `worker.js` unchanged. I haven't confirmed
that the hibernation API behaves the same when self-hosted, and a plain
Node server is less to keep running, which is why `server.js` exists.

On a home server:

- **TLS:** the game is served over HTTPS from GitHub Pages, so browsers
  will only open `wss://`. Put a reverse proxy holding the Let's Encrypt
  certificate in front of `server.js` and forward the WebSocket upgrade.
- **TURN** (with step 1b): run [coturn](https://github.com/coturn/coturn) next to it as the
  fallback when P2P fails, instead of relaying game traffic through
  `server.js`. Use its time-limited credentials (`use-auth-secret`):
  `server.js` would mint a username and password for each room, so the TURN
  server isn't an open relay. coturn needs a range of UDP ports forwarded
  through the router as well as its listening port. The relay path in
  `server.js` stays as a last resort.
- **Exposure:** the Origin check and the size and rate caps are the only
  protection, and `server.js` enforces them itself.
- **Uptime:** if the server is down, nobody can start a game. Games already
  connected P2P keep going.
- The client is pointed at either host with `?relay=wss://...`, so one
  build works with both.

Turn-based games barely need P2P. Their messages are sparse, so even a
relayed room hibernates between moves and costs almost nothing. P2P is
mostly for the real-time games.

### Transport

All transports share the interface that `net.js` already defines:
`send(msg)`, `onMessage(cb)`, `close()`.

- `p2pTransport`: a WebRTC DataChannel, set up through the Worker. One
  connection to each other seat (a full mesh), fine up to about 4–6 players.
- `relayTransport`: a WebSocket to the relay (either host), which stays open. Built.
- `broadcastTransport`: two tabs in one browser, for development. Already
  exists.

The session tries P2P first and falls back to the relay if no channel opens
within a few seconds. A query parameter will force one, for testing; today
`?relay=` picks the relay and leaving it out picks BroadcastChannel.

### Session

This will be Dot Army's network code, moved out of its `main.js` and made
game-agnostic:

- `hello` / `start` / `bye` handshake. `PROTOCOL` belongs to each game's
  adapter, not to a shared constant, so bumping one game doesn't lock out
  another.
- A game number on every message, so stragglers from a finished game are
  ignored after a rematch.
- Shared pause, peer-left with a grace period, and **reconnect by replay**:
  the host sends the seed plus the input log, and the rejoining device
  simulates up to the current point.

### Sync model 1: tick lockstep

Today's `lockstep.js`, with two changes:

- It imports `setTarget`, `step` and `stateHash` from Dot Army's `sim.js`.
  Those become adapter functions passed in.
- It assumes two players (`remote = 1 - localPlayer`). It becomes N seats:
  a tick is ready when every seat's input for it has arrived.

Input delay, hash checks every few ticks, and the replay log stay as they are.

### Sync model 2: turn lockstep

For turn-based games:

- One shared, ordered command log. During a seat's turn, only that seat
  adds commands. Everyone applies them in order.
- **Simultaneous phases** (Coreward's stance changes) collect one command
  from every seat, then apply them in seat order.
- The state hash is checked after every turn instead of every N ticks.

### Game adapter

```js
export default {
  PROTOCOL: 1,
  seats: { min: 2, max: 2 },
  create(seed, config) { /* → state */ },
  applyInput(state, seat, input) { /* mutate state */ },
  step(state) { /* tick games only */ },
  hash(state) { /* → 32-bit integer */ },
  activeSeat(state) { /* turn games only: whose move is it */ },
};
```

The simulation has to be deterministic: integers and a seeded RNG only,
like Dot Army's `sim.js`.

## Problems specific to turn-based games

Every device runs the whole game from a shared seed. That's fine for Dot
Army, but it breaks two things Coreward Bound relies on.

### Dice can be predicted

Each device holds the seed and the full state, so a player can copy the
state in devtools, try jumps, and find the ones that won't scatter.
Coreward's scatter preview ("exact odds") would become a known outcome.

The fix is the dice in `dice.js` (see Dice, above): every seat contributes
to every roll from a hash chain it committed to before play, so no single
seat can predict or steer a roll. An earlier version of this plan used a
fresh commit-reveal for each roll; hash chains give the same guarantees at
one round trip per roll instead of one and a half.

**Secret simultaneous stances** need a commit-reveal of the choices
themselves. That waits for turn lockstep.

### Fog of war leaks

Hidden hex values and the fuzzy stack sizes are all in each device's
memory. The only real fix is a server that runs the game and hides
information, which gives up both P2P and the near-zero cost. Among friends
I'd accept the leak. **(open: owner's call)**

## Things that will go wrong

- **Switching transport mid-game.** If P2P drops and the relay takes over,
  messages can be lost or arrive twice. Every message needs a sequence
  number, plus a "resend everything since N" request. The input log
  already holds what's needed.
- **A mesh with more seats** means every seat must reach every other. If
  any pair can't, the simplest answer is for the whole room to fall back to
  the relay.
- **A host who drops** ends the game, unless the command log lives in the
  Durable Object, in which case any seat can recover it.
- **Version skew** between a cached old client and a new one: the
  per-game `PROTOCOL` check, with an error that says to reload.

## Order of work

1. **Relay (done):** `room.js` behind `server.js` and `worker.js`, the
   `relay.js` transport, and the dice. Peer-to-peer connection setup is
   step 1b. Before writing it, try [Trystero](https://github.com/dmotz/trystero),
   which does WebRTC introductions over public trackers with no server of
   ours. [PeerJS](https://peerjs.com/) is the self-hostable alternative.
2. **Shared client:** transports, session, tick lockstep, in
   `multiplayer/`. Move Dot Army onto them and keep its two-tab e2e test
   passing.
3. **Turn lockstep**, once Coreward Bound has a simulation to sync.
   Look hard at [boardgame.io](https://github.com/boardgameio/boardgame.io) first. Its game
   structure fits Coreward well, but its randomness and secret state rely
   on a server that runs the game.

The owner deploys the Worker (`npx wrangler@4.158.0 deploy` from `multiplayer/`). The custom-domain
caveat in NETWORK.md still applies: if `schuyler.info`'s DNS moves to
Cloudflare, the GitHub Pages records must stay DNS-only.

## References

Other libraries in this space: [PartyKit / partyserver](https://github.com/cloudflare/partykit)
(rooms on Durable Objects, Workers only), [Colyseus](https://colyseus.io/) (a Node
server that runs the game), boardgame.io, Trystero and PeerJS (above).
None of them does dice without a trusted server.

Cloudflare docs, checked November 2026:

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/):
  100,000 requests and 13,000 GB-s a day on the free plan. Incoming
  WebSocket messages count as 1/20 of a request, outgoing ones are free,
  and hibernating objects aren't billed for duration.
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Objects on the Workers Free plan](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/):
  SQLite-backed classes only.
- [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
  and [TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
