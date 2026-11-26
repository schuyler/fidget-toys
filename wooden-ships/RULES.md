# Wooden Ships — Rules (draft)

Two sailing ships fight a duel on a small patch of sea. You don't control
your speed, only your rudder: the wind does the rest, and it doesn't care
which way you'd like to go. Line up a broadside before your rival does,
rake them from astern if you can, and don't get caught head-to-wind with
no way on.

Real time. Two players on one phone, or you vs the CPU, as in Dot Army.

> **Draft.** The sailing model comes from my 2022 Phaser prototype
> ([schuyler/wooden-ships](https://github.com/schuyler/wooden-ships)),
> which had the physics and no game. Every number here is a starting
> guess, to be tuned with headless CPU-vs-CPU games. Questions still open
> are marked **(open)**.

## The sea

- A rectangle that fills the screen, with no scrolling, so both players
  can always see both ships. In portrait, blue starts at the bottom and
  red at the top.
- The short side is 1,000 m of sea. The long side stretches to match the
  screen's shape. A ship is 40 m long, so the sea is 25 ship lengths
  across.
- The sea is laid out on a grid of square tiles, 22 m on a side, drawn
  with the prototype's terrain tiles (see Art).
- **Islands:** none, some (the default), or many. Generated from the
  game's seed, point-symmetric (rotated 180° about the centre), and kept
  clear of the start positions.
- **Shallows** ring every island, one tile wide (see Hazards).
- **How islands are generated:** terrain is decided at tile *corners*,
  not tiles. Each corner is deep water, shallows or land, and each tile
  is drawn with the piece that matches its four corners. The prototype's
  Tiled map already labels which piece goes with which corners: a
  two-level "corner" terrain set, shallows over open water and beach over
  shallows. Each level has 14 of the 16 possible pieces. The missing two
  are the diagonals (two opposite corners set, the other two not), so the
  generator smooths those away before tiles are picked: any tile with
  only a diagonal pair gets one more corner raised to match.
- The edge of the sea is a wall: a ship that reaches it stops dead, as
  if it had hit an island, but takes no damage. **(open: wrap around
  instead)**

## The wind

- One wind for the whole sea, with a direction and a speed (8–20 kts).
- At the start it blows across the line between the two ships, so
  neither starts upwind of the other (the *weather gauge*, which matters
  a lot; see Notes).
- **Shifts:** every 20–40 s (chosen at random), the wind turns by up to
  30° either way and changes speed, easing to its new value over 5 s.
  The next shift is never announced.
- Streaks drift across the sea to show the wind, and a small compass in
  the corner shows its direction and speed.

## Sailing

Each ship has a position, a velocity, a heading (the way the bow
points) and a rudder setting from −1 (hard to port) to +1 (hard to
starboard). Sails trim themselves: you never set them.

Every tick (30 per second, `dt` = 1/30 s):

1. **Apparent wind** = true wind − ship velocity. This is the wind the
   sails actually feel. It's why a fast ship sailing across the wind
   feels it coming from further ahead than it really is.
2. **Angle of attack** `a` = the angle between the bow and the direction
   the apparent wind blows *from*. 0° is head to wind, 180° is dead
   downwind.
3. **Drive** (forward push, along the heading only):
   ```
   drive = max(0, lift × |sin a| − drag × cos a) × |apparent wind|
   ```
   With `lift` = `drag` = 1 this is zero until the apparent wind is more
   than 45° off the bow, the **no-go zone**. It peaks around 135° (a
   broad reach) and is 1 dead downwind.
4. **Hull drag.** Split the velocity into a forward part `vf` (along the
   heading) and a sideways part `vs`:
   ```
   forward drag  = bowDrag  × vf × |vf|
   sideways drag = keelDrag × vs × |vs|
   ```
   `keelDrag` is much bigger than `bowDrag`, so the keel holds the ship
   on course. Sideways motion dies quickly. Forward motion carries on.
5. **Turning:**
   ```
   heading += rudder × turnRate × clamp(vf / steerSpeed, −1, 1) × dt
   ```
   The rudder only works with water flowing past it. A stopped ship
   can't turn, and a ship moving backwards steers the wrong way.
6. **Windage:** the hull and rigging catch a little wind whatever the
   sails are doing: `windage × apparent wind`, pushing the way the
   apparent wind blows.
7. velocity += (drive + windage − drags) × dt; position += velocity × dt.

None of this is coded as a special rule, but it all comes out of the
model:

- **Beating:** you can't sail straight upwind. To get somewhere upwind
  you zigzag, tacking through the no-go zone.
- **In irons:** tack too slowly and you stop head to wind. With no speed
  the rudder does nothing. The ship gets out only when windage pushes
  it backwards and the reversed rudder swings the bow off: slowly,
  while your rival lines up a broadside.
- **Turning costs speed:** when you turn, the keel kills the sideways
  part of your old velocity. A hard turn is a brake.

**Wind shadow (setting, on by default):** a ship within 4 lengths
directly downwind of the other (inside a 30° cone) gets half the wind.
Getting upwind of your rival lets you steal their wind. **(open)**

## Gunnery

- Each ship carries **4 guns a side** (port and starboard).
- Each player has two fire buttons, port and starboard. A press fires
  that side's loaded guns as a quick ripple, bow to stern, 0.1 s apart.
- A ball leaves the gun at right angles to the hull at `muzzleSpeed`,
  plus the ship's own velocity, with a random spread of up to ±3°. It
  flies straight and flat, and it splashes harmlessly after `gunRange`.
  **(open: elevation, or balls skipping off the water)**
- A side reloads in `reload` seconds after it fires. Each side has its
  own reload, so you can fire one broadside, turn, and fire the other.
  An arc beside each button shows its reload.
- **Hits:** a ball that crosses the other ship's hull (a 40 × 12 m
  capsule) hits it and is removed. A ship can't hit itself.
  - A normal hit does 1 damage.
  - A **raking** hit, from a ball travelling within 30° of the target's
    fore-aft line (from dead ahead or dead astern), does 2. Down the
    length of a ship a ball passes through everything. Crossing your
    rival's bow or stern while they can't reply is the best move in the
    game.
- Damage changes nothing until it sinks you. A battered ship sails and
  shoots as well as a fresh one, so a lead can always be overturned.

## Hazards

- **Shallows:** `bowDrag` and `keelDrag` are tripled. You can sail
  through, slowly.
- **Islands:** a ship that touches an island stops dead, takes 1 damage
  (at most once a second), and is pushed clear. Balls hit islands and
  stop.
- **Collision:** ships that touch bounce apart, and each takes damage
  equal to their closing speed ÷ 4 kts, rounded down. Boarding comes
  later (see Embellishments).

## Winning

- Each ship has **12 hull**. A ship at 0 sinks, and the other side wins.
- If both sink in the same tick, it's a draw.
- No time limit. **(open: one, if headless games show long standoffs
  with both ships running downwind)**

## Controls

The phone is split across the middle. Each player uses their own half,
with multitouch, so both can play at once, as in Dot Army. Blue's half is
the bottom one.

- **Steering:** drag sideways anywhere in your half. How far you drag
  from where you first touched sets the rudder, up to full lock at about
  a thumb's width. Let go and the rudder centres.
- **Fire:** two buttons in your half's corners, **left** and **right**
  as *you* see the screen, not port and starboard. The left button
  fires whichever broadside is facing your left right now. Each button
  shows a small arrow pointing the way its guns point.
  - So you never have to work out port and starboard when your ship is
    coming toward you. That's the mirror-image problem anyone who's
    steered a remote-control car toward themselves knows about.
  - When your bow points straight left or right, one broadside faces
    you and the other faces away, and neither is clearly "left". The
    buttons only swap sides once the bow is 15° past that line, so they
    don't flicker while you sail across the screen.
  - For red, at the top of a shared phone, "left" is red's left, which
    is screen right.
- Each ship shows its no-go wedge as a faint shadow ahead of the bow, so
  you can see when you're about to sail into it.
- Against the CPU you have the whole screen, and the buttons sit at the
  bottom.

## The CPU

- It steers toward a point beside you: on your beam to trade
  broadsides, or across your bow or stern to rake. It picks whichever it
  can reach soonest, given the wind.
- When that point is upwind, it beats, tacking only when it has the
  speed to get through.
- It fires a side when a simulated ripple from that side would hit you,
  predicted a few seconds ahead with your current rudder.
- **Easy** aims with extra spread, reacts 1 s late and never rakes on
  purpose. **Hard** doesn't hold back.

## Settings

| Setting | Choices |
|---|---|
| Opponent | Two players, CPU easy, CPU hard |
| Islands | None, Some, Many |
| Wind | Steady, Shifty (default), Gusty |
| Wind shadow | Off, On |
| Hull | 6, 12, 20 |

*Steady* never shifts. *Gusty* shifts twice as often, by up to 45°.

## Parameters

| Name | Default | Meaning |
|---|---|---|
| `tickRate` | 30 | Ticks per second |
| `timeScale` | 4 | Game seconds per real second |
| `lift`, `drag` | 1.0, 1.0 | Sail coefficients; set the no-go zone and drive |
| `bowDrag` | 0.05 | Hull drag going forward |
| `keelDrag` | 1.0 | Hull drag going sideways |
| `windage` | 0.02 | Push of the apparent wind on hull and rigging |
| `turnRate` | 40°/s | Turn rate at full rudder and full steering speed |
| `steerSpeed` | 3 kts | Forward speed at which the rudder is fully effective |
| `muzzleSpeed` | 150 m/s | Ball speed relative to the ship, on screen |
| `gunRange` | 300 m | Distance before a ball splashes |
| `spread` | ±3° | Random error per ball |
| `reload` | 5 s | Per side, in real seconds |
| `rakeArc` | 30° | Fore-aft cone for double damage |
| `hull` | 12 | Damage to sink |
| `seed` | random | Same seed and same inputs = same game |

**Scale.** At real speed, a ship making 10 kts (5 m/s) would take over
three minutes to cross the sea. So the sea runs at `timeScale` times
real speed. Wind and ship speeds on the compass read like real ones,
but a ship covers its own length in about 2 real seconds. Gunnery is
set on screen instead, in real seconds: a ball crosses `gunRange` in 2
real seconds, so leading a moving target is a skill. That makes balls
far slower than real ones relative to the ships. **(open: whether 4× is
fast enough to feel like a fidget toy)**

## Room for a campaign (not the MVP)

A campaign could come later: run down cargo ships and loot them, escape
from heavier and better-armed ships, bombard enemy ports, refit at
friendly ones, dodge storms. None of that is in the first version, but
the duel shouldn't be built in ways that rule it out:

- **Any number of ships,** each with a side (blue, red, neutral, or
  later more) rather than hardcoded as "blue" and "red".
- **Ship types are data:** length, sail and hull coefficients, guns per
  side, hull, and later cargo and crew. The duel uses one type. The
  prototype already kept its coefficients in a `Specs` record.
- **Guns are batteries** that belong to something. A ship has two (port
  and starboard). A fort at a port would be a battery on land with its
  own arc.
- **Wind is a function of position and time,** not one global value.
  In the duel it's the same everywhere. A storm would be a moving patch
  of strong, shifting wind.
- **The sea can be bigger than the screen.** The duel fits the screen,
  but the renderer goes through a camera (world to screen) from the
  start, so a scrolling sea is a camera change, not a rewrite.
- **The map is data in the sim:** a corner grid with places on it.
  Ports would be special tiles with a side and a battery.
- **The CPU steers by goals** (close to fire, rake, flee, follow a route,
  make for port), so a cargo ship that runs and a frigate that hunts are
  the same machinery with different goals.
- **Hull is state that can persist** between encounters. Damage has no
  effect in the duel, but persistent damage is what would make refitting
  matter. Looting probably needs a way to take a ship rather than sink
  it, such as striking colours at low hull, or boarding (see
  Embellishments).
- **State can be saved:** the whole sim state is plain data plus the
  seed, so a campaign save is a serialised state.

### Embellishments after the MVP

These are for the episodic game, once the duel is built and playable.
Each is a sketch, not a rule yet.

- **Shore batteries.** Guns on land at a port or headland: a battery
  with a fixed arc, longer range than a ship's guns, and its own reload.
  A battery has hull of its own and goes silent at 0, so bombarding a
  port means silencing its guns first. Only a fort can hit you out to
  its full range, so you can't trade broadsides with it. You have to
  run past it or come in from outside its arc. **(open: whether a
  silenced battery comes back after a while)**
- **Boarding.** Ships that touch below a set closing speed grapple
  instead of bouncing. They stay locked together, and neither can fire
  into the other. The fight is decided by crew. Crew becomes a
  ship-type stat, broadsides kill some of it, and the side with more
  crew left wins over a few seconds. The winner takes the ship: that's
  how looting works. Either ship can cut free (a button) while the
  fight is still on. **(open: whether a third ship can fire into a
  grappled pair, hitting both)**
- **Running aground.** In the MVP, shallows only slow you and touching
  an island bounces you off. With grounding, a ship that enters a
  shallows tile faster than a set speed, or touches a beach, goes
  aground. It stops, can't steer, and takes damage depending on its
  speed. Only windage can get it off: it floats free if the apparent
  wind pushes it back toward deeper water for long enough. Otherwise a
  **kedge** button frees it slowly. A grounded ship is a sitting target,
  so the charts suddenly matter. **(open: tides; whether heavier ships
  draw more water and ground on shallows a light ship can cross, which
  would give a small ship somewhere to run)**

## Notes

- **The weather gauge.** In real fleet actions the upwind ship chose
  whether and when to fight, and the downwind ship could only run or
  wait. That should happen here without a special rule: the upwind ship
  can run down on you at any angle, while you have to beat up to reach
  it. Wind shifts keep upsetting it, so it's an edge, not a lock.
  Headless games will show whether it's too strong: if the side that
  starts upwind after the first shift wins much more than half the
  time, shifts should come more often.
- **What carried over from the 2022 prototype,** and what was fixed:
  - Apparent wind, the `|sin| − cos` drive with its 45° no-go zone, and
    drag rising with the square of speed are kept as they were.
  - **Turn rate was per frame,** not per second, so the ship turned
    twice as fast on a 120 Hz screen. It's per tick now, at a fixed
    tick rate.
  - **The ship could turn while stopped.** Turning now scales with
    forward speed, which is what makes being in irons possible.
  - **There was no keel.** The prototype blended one drag coefficient
    between bow and beam values depending on how far the ship was
    slipping sideways, so it crabbed out of turns. Separate forward and
    sideways drag fix that.
  - **The rudder bent the drag vector** (drag pointed along velocity
    minus the turn). That's gone. The rudder only turns the bow.
  - **The two scenes didn't agree where 0° was.** There's one
    convention now: 0 is east, angles increase clockwise (screen y
    points down), and wind direction is where it blows *from*.
  - Drive is still proportional to apparent wind speed, not its square
    as in real life. Linear was easier to tune in 2022, and squaring it
    would make gusts swing too hard. **(open)**
- **Deterministic core.** As in the other toys, `sim.js` runs on a
  seeded random generator and fixed ticks, and nothing else. State is
  in floats, unlike the integer state of Dot Army, because sailing is
  continuous. Floats stay deterministic across browsers as long as the
  sim only uses `+ − × ÷` and `sqrt`, which IEEE 754 defines exactly.
  `Math.sin` and `atan2` aren't defined exactly, so headings are stored
  as integers (65,536 to a full turn), sines come from a lookup table
  that's committed to the repo rather than computed at load, and the
  angle of attack is never computed as an angle: `sin a` and `cos a`
  come straight from the cross and dot products of the bow and the
  apparent wind. That keeps lockstep network play possible later.
- **Art.** This uses the prototype's sprites and terrain, to be copied
  into `wooden-ships/assets/` when the code goes in: the ship sheet
  (`shipsMiscellaneous_sheet`) and the terrain tiles (`tiles_sheet`). The sheet names match Kenney's
  [Pirate Pack](https://kenney.nl/assets/pirate-pack), which is CC0, but
  the files haven't been checked against the pack itself yet. It's
  drawn on a plain canvas to start, reading the sheet's XML atlas
  directly. If the game turns out to be worth polishing, porting to
  Phaser for its particles, tweens and atlas loading only touches
  `render.js` and `main.js`, because the sim never depends on the
  renderer.
  - Ships are drawn as a hull (`hullLarge`) with a separate sail
    (`sailLarge`) on top, rotated to the sail's trim angle, so you can
    see how the ship is set to the wind. The ready-made `ship (n)`
    sprites have their sails fixed fore and aft. The sheet has sails in
    several colours, including blue (`sailLarge (5)`) and red
    (`sailLarge (3)`).
  - `cannonBall`, `explosion1–3` and `fire1–2` cover shots, hits and a
    sinking ship. `wood (n)` can be wreckage.
  - A hull sprite is 108 px long for a 40 m ship. So 64 px terrain
    tiles come out at about 22 m, which sets the tile size above.
