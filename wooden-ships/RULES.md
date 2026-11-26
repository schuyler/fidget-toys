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
- **Islands:** none, some (the default), or many. Generated from the
  game's seed, point-symmetric (rotated 180° about the centre), and kept
  clear of the start positions.
- **Shallows** ring every island (see Hazards).
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
- Damage changes nothing until it sinks you. **(open: damage slows the
  ship, or knocks out guns. Both make a lead harder to come back from)**

## Hazards

- **Shallows:** `bowDrag` and `keelDrag` are tripled. You can sail
  through, slowly.
- **Islands:** a ship that touches an island stops dead, takes 1 damage
  (at most once a second), and is pushed clear. Balls hit islands and
  stop.
- **Collision:** ships that touch bounce apart, and each takes damage
  equal to their closing speed ÷ 4 kts, rounded down. **(open:
  boarding instead, when ships touch at low speed)**

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
  a thumb's width. Let go and the rudder centres. **(open: a rudder that
  stays where you leave it)**
- **Fire:** two buttons in your half's corners, port on the left and
  starboard on the right, *as the ship faces*. The labels swap when your
  bow points toward you, so the button on the side of your guns always
  fires them. **(open: whether swapping labels confuses more than it
  helps)**
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
- **Art.** The prototype used Kenney's pirate sprite sheet (CC0, I
  believe; worth checking before reuse). This version draws its ships,
  sails and islands on a canvas instead, which suits the other toys and
  means sails can be drawn at their actual trim angle.
