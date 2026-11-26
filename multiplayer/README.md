# multiplayer

A plan for one network layer that every game in this repo can share: a
Cloudflare Worker introduces the players, then they talk to each other directly.

Status: **design only, no code yet.** It builds on the Dot Army networking on
the `claude/dot-army-fidget-game-47u0tu` branch. That branch has
deterministic lockstep (`dot-army/src/lockstep.js`), a two-tab transport, and
`dot-army/NETWORK.md`, a design for a relay that hasn't been written. This
plan replaces that relay design. Once the shared code exists, `dot-army/NETWORK.md`
should shrink to the Dot Army-specific parts.

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
it's billed for the whole game (128 MB × 600 s ≈ 75 GB-s, against 13,000
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
  different games apart and lets the Worker check a per-game seat limit.
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

The room logic is written against a small interface, so it can run on
Cloudflare or on a home server:

```js
// One room. The host calls these and supplies send() and storage.
export function createRoom({ game, code, send, storage }) {
  return {
    onJoin(seat) {},
    onMessage(seat, msg) {},   // forward to msg.to, or to everyone else
    onLeave(seat) {},          // tell the others: {k:'peer-left', seat}
  };
}
```

There are two entry points around it:

- **`worker.js`:** the Durable Object class. It uses the hibernation API
  and passes the object's SQLite storage as `storage`.
- **`server.js`:** a Node process with a `ws` server and a `Map` of rooms,
  plus a local SQLite file for the optional log. It holds sockets open the
  whole time. Hibernation only exists to save money on Cloudflare, and on
  your own machine idle sockets cost nothing.

Cloudflare's runtime, `workerd`, is open source and runs Durable Objects on
one machine, so it could run `worker.js` unchanged. I haven't confirmed
that the hibernation API behaves the same when self-hosted, and a plain Node
server is less to keep running, so `server.js` is the plan.

On a home server:

- **TLS:** the game is served over HTTPS from GitHub Pages, so browsers
  will only open `wss://`. Put a reverse proxy holding the Let's Encrypt
  certificate in front of `server.js` and forward the WebSocket upgrade.
- **TURN:** run [coturn](https://github.com/coturn/coturn) next to it as the
  fallback when P2P fails, instead of relaying game traffic through
  `server.js`. Use its time-limited credentials (`use-auth-secret`):
  `server.js` mints a username and password for each room, so the TURN
  server isn't an open relay. coturn needs a range of UDP ports forwarded
  through the router as well as its listening port. The relay path in
  `server.js` stays as a last resort.
- **Exposure:** the Origin check and the size and rate caps are the only
  protection, so `server.js` must enforce them itself.
- **Uptime:** if the server is down, nobody can start a game. Games already
  connected P2P keep going.
- The client picks the server from a constant in `net.js`, overridable
  with `?relay=wss://...`, so the same build works with either host.

Turn-based games barely need P2P. Their messages are sparse, so even a
relayed room hibernates between moves and costs almost nothing. P2P is
mostly for the real-time games.

### Transport

All transports share the interface that `net.js` already defines:
`send(msg)`, `onMessage(cb)`, `close()`.

- `p2pTransport`: a WebRTC DataChannel, set up through the Worker. One
  connection to each other seat (a full mesh), fine up to about 4–6 players.
- `relayTransport`: a WebSocket to the Durable Object, which stays open.
- `broadcastTransport`: two tabs in one browser, for development. Already
  exists.

The session tries P2P first and falls back to the relay if no channel opens
within a few seconds. `?via=p2p|relay|bc` forces one, for testing.

### Session

This is Dot Army's network code, moved out of its `main.js` and made
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

The fix is **commit-reveal randomness** for each random event:

1. The jumping seat sends the jump along with `hash(a)`, a commitment to a
   secret random value `a`.
2. The other seat replies with its own random value `b`.
3. The jumping seat reveals `a`. Everyone checks it against the commitment
   and seeds the roll from `H(a, b)`.

Neither side can steer the roll: `a` is fixed before anyone sees `b`, and
`b` is chosen without knowing `a`. It costs one round trip per random event,
which a turn-based game can afford. The opponent can't supply the
randomness alone: they know the state, so they could pick a `b` that
makes you scatter.

**Secret simultaneous stances** use the same tool: every seat commits a
hash, then every seat reveals. So the shared code should have a
`commitReveal` helper, not two separate mechanisms.

With more than two seats, every seat contributes a value, and the roll is
seeded from all of them.

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

1. **Server:** the room logic behind the `createRoom` interface (game
   namespace, seats, connection setup, fallback relay), then `server.js`
   and `worker.js` around it. Test locally with `node server.js` and
   `npx wrangler dev`, pointing the client at each with
   `?relay=ws://localhost:<port>`.
2. **Shared client:** transports, session, tick lockstep, in
   `multiplayer/`. Move Dot Army onto them and keep its two-tab e2e test
   passing.
3. **Turn lockstep and `commitReveal`**, once Coreward Bound has a
   simulation to sync.

The owner deploys the Worker (`npx wrangler deploy`). The custom-domain
caveat in NETWORK.md still applies: if `schuyler.info`'s DNS moves to
Cloudflare, the GitHub Pages records must stay DNS-only.

## References

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
