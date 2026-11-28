# Wooden Ships — Rules

Two sailing ships fight a duel on a small patch of sea. You don't control
your speed, only your rudder: the wind does the rest, and it doesn't care
which way you'd like to go. Line up a broadside before your rival does,
rake them from astern if you can, and don't get caught head-to-wind with
no way on.

Real time, you vs the CPU. Fidget Toys never puts two players on one
device, so playing another person waits for network play (see Later).

> **Prototype.** The sailing model comes from my 2022 Phaser prototype
> ([schuyler/wooden-ships](https://github.com/schuyler/wooden-ships)),
> which had the physics and no game. The duel below is built and
> playable. Most numbers are still the draft's starting guesses; the ones
> headless CPU-vs-CPU games have checked so far are under Notes. Questions
> still open are marked **(open)**.

## The sea

- A square 136 tiles of 22 m on a side, about 3 km or 75 ship lengths,
  far bigger than the screen and the same on every screen. Blue starts
  south of the centre, red north of it.
- **The camera** shows 450 m across the screen's short side (about 11
  ship lengths) and follows your ship, leading a little the way you're
  moving. When the enemy is near, it pans toward the point between you so
  both fit, but never so far that your ship leaves the middle 60% of the
  screen. It stops at the edges of the sea.
- When the enemy is off screen, an arrow on the screen's edge points at
  her, with how far away she is.
- The sea is laid out on a grid of square tiles, 22 m on a side, drawn
  with the prototype's terrain tiles (see Art).
- The ships start 700 m apart, either side of the centre, each 60 m to its own
  side of the centre line, pointing at each other with a little way on
  (3 m/s), so they pass rather than collide unless someone steers.
- If the phone turns during a game, the camera shows 450 m across the
  new short side.
- **Islands:** none, some (the default), or many. Generated from the
  game's seed, point-symmetric (rotated 180° about the centre), and kept
  clear of the start positions. The number of blobs scales with the
  sea's area: 0.8 per 1,000 tiles for *some* (15 on the default sea,
  each with its mirror image) and 1.6 for *many* (30). Each is 1.5–4
  tiles in radius with a ragged edge,
  kept at least 160 m (plus their radius) from either start and out of
  the middle of the sea.
- **Shallows** ring every island, one tile wide (see Hazards).
- **How islands are generated:** terrain is decided at tile *corners*,
  not tiles. Each corner is deep water, shallows or land, and each tile
  is drawn with the piece that matches its four corners. The prototype's
  Tiled map already labels which piece goes with which corners: a
  two-level "corner" terrain set, shallows over open water and beach over
  shallows. Each level has 14 of the 16 possible pieces. The missing two
  are the diagonals (two opposite corners set, the other two not), so the
  generator smooths those away before tiles are picked: any tile with
  only a diagonal pair gets one more corner raised to match (and so does
  its mirror image, which keeps the map symmetric).
- For ships and balls, the terrain at a point is the terrain of the
  nearest tile corner.
- The edge of the sea is a wall: a ship that reaches it stops dead, as
  if it had hit an island. **(open: wrap around instead)**

## The wind

- One wind for the whole sea, with a direction and a speed (8–20 kts).
- At the start it blows across the line between the two ships, from one
  side or the other at random, so neither starts upwind of the other
  (the *weather gauge*, which matters a lot; see Notes).
- **Shifts:** every 20–40 real seconds (chosen at random), the wind
  turns by up to 30° either way and changes speed by up to 4 kts (kept
  within 8–20), easing to its new value over 5 s. The next shift is
  never announced.
- Wave crests roll downwind across the sea, each a short arc bowed the
  way it's going, bigger in a stronger wind. The view follows your
  ship, so they move past you at roughly the apparent wind: sail into
  the wind and they come at you, run before it and they barely move. A
  small compass in the corner shows the wind's direction and speed.

## Sailing

Each ship has a position, a velocity, a heading (the way the bow
points) and a rudder setting from −100 (hard to port) to +100 (hard to
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
7. velocity += (drive + windage) / `mass` × dt, then the hull drags;
   position += velocity × dt.

Here `dt` is in game seconds (`timeScale` / `tickRate`), except for
turning, where `turnRate` is per real second. The drags are applied in
closed form, `v / (1 + k × |v| × dt / mass)`, which is the exact
solution of `dv/dt = −k × v × |v| / mass` over one tick and so can't
overshoot however strong the keel. `mass` is new since the draft: it
sets how quickly a ship gathers way and loses it (about 2 real seconds
to reach speed), without changing her top speeds.

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
- Each player has two fire buttons, one per broadside (see Controls). A
  press fires that side's loaded guns as a quick ripple, bow to stern,
  0.1 s apart. The guns are spaced along the middle 30 m of the hull.
- **Traverse:** each gun can swing up to `traverse` (20°) forward or aft
  of square to the hull. When it fires, it aims at the centre of the
  nearest enemy ship as it is at that moment, with no lead. If the enemy
  is outside its arc, it aims as close as the arc allows. **(open: in
  the campaign, whether "nearest" is the right enemy to aim at when
  there are several)**
- A ball leaves the gun at `muzzleSpeed` in the direction it's aimed,
  plus the ship's own velocity, with a random spread of up to ±3°. It
  flies straight and flat, and it splashes harmlessly after `gunRange`.
  Elevation comes later (see Embellishments: charged shots).
- A side reloads in `reload` seconds after it fires. Each side has its
  own reload, so you can fire one broadside, turn, and fire the other.
  An arc beside each button shows its reload.
- **Hits:** a ball that crosses another ship's hull (a 40 × 12 m
  capsule, checked twice per tick) hits it and is removed. A ship can't
  hit itself. Every hit kills 1 crew.
- **Crossing the T.** Raking needs no special rule. It comes from the
  geometry:
  - Broadside to broadside, the target is 40 m long across your line of
    fire. Every gun that bears can hit it, but every one of its guns
    can hit you back.
  - Across its bow or stern, the target is only 12 m wide. Guns firing
    parallel, 10 m apart, would mostly miss either side of it. Traverse
    lets all of them converge on it instead, so the whole broadside
    still lands. Meanwhile its own guns can only aim between 70° and
    110° off its bow, so from within 70° of dead ahead or dead astern
    it can't reply at all.
  - So the best move in the game is to cross your rival's bow or stern
    at close range: a full broadside in, nothing back. Range still
    matters, because the ±3° spread is about ±8 m at 150 m but ±16 m at
    300 m, which is wider than an end-on ship.
- **Crew is your hit points,** as in Star Control. A ship's crew is
  `crewPerGun` × its total guns: 3 × 8 = 24 for the duel's ship, so it
  strikes after about six full broadsides land. Losing crew changes
  nothing until you have none: a short-handed ship sails and shoots as
  well as a full one, so a lead can always be overturned. **(future
  option: damage slows a ship. See Notes)**

## Hazards

- **Shallows:** `bowDrag` and `keelDrag` are tripled. You can sail
  through, slowly.
- **Islands:** a ship that touches an island (or the edge of the sea)
  stops dead and is pushed clear: her move that tick is undone (her
  turn isn't, so she can't get pinned) and she's left drifting away
  from where she touched at `bounce` (1 m/s). It loses no crew. The cost is the speed it lost and the time it
  takes to get going again. Balls hit islands and
  stop.
- **Collision:** ships that touch bounce apart and lose most of their
  speed (each keeps a fifth of her velocity, plus a push apart). Neither loses crew. Boarding comes
  later (see Embellishments).

## Winning

- Each ship has **24 crew** (see Gunnery). A ship with none left **strikes her
  colours** (surrenders). Her flag comes down, her rudder is lost and her
  sails are let fly (no drive), so she drifts on windage with her bow
  wherever it was.
- **The game isn't over the moment a ship strikes.** Once one side has no
  ship left afloat, the fight is decided, but the sea plays on: balls
  already in the air still fly, and the end screen waits until nothing has
  been in the air or firing for `endDelay` (3) seconds. Until then the
  loser drifts and the winner can still steer, but nobody can fire.
- The winner is whoever still has a ship afloat when the end screen
  comes. A ball already in the air when a ship strikes can finish off the
  other one too, so both ships strike and it's a draw. That, or both
  striking on the same tick, is the only way to draw.
- No time limit. **(open: one, if headless games show long standoffs
  with both ships running downwind)**

## Controls

You're blue, and you have the whole screen.

- **Steering** is one of two ways, picked in Settings. Either way, let go
  and the rudder centres.
- **Drag** (the default): drag sideways anywhere. How far you drag from
  where you first touched sets the rudder, up to full lock at about a
  thumb's width (48 px).
  - Drag the way you want the **bow to swing on screen**. With your ship
    heading up the screen, dragging right is starboard rudder; heading
    down toward you, dragging right is port rudder. Like the fire
    buttons, this is so you never have to work out port and starboard.
  - It uses the same 15° rule as the buttons for when it swaps, and it's
    fixed for as long as your finger stays down, so a turn across the
    screen doesn't reverse halfway through.
- **Wheel:** a ship's wheel at the bottom of the screen. Drag round it:
  a quarter turn either way is full rudder, and turning past that does
  nothing more. Let go and it spins back to centre, so you never have to
  remember to straighten up. Dragging the open sea doesn't steer.
  - Clockwise on the wheel is starboard rudder, and starboard rudder
    turns the ship clockwise on screen whatever her heading, so there's
    nothing to flip. The king spoke (straight up when centred) has a pale
    handle so you can see where centre is.
  - The fire buttons sit either side of it, drawn as cannons that point
    where that side's guns point, run in when they fire, and run out
    again as they reload.
- **Fire:** two buttons along the bottom, **left** and **right**
  as *you* see the screen, not port and starboard. On a narrow screen
  they're in the corners; on a wide one they come in to no more than
  240 px either side of the middle, so they're never a long reach apart. The left button
  fires whichever broadside is facing your left right now. Each button
  shows a small arrow pointing the way its guns point.
  - So you never have to work out port and starboard when your ship is
    coming toward you. That's the mirror-image problem anyone who's
    steered a remote-control car toward themselves knows about.
  - When your bow points straight left or right, one broadside faces
    you and the other faces away, and neither is clearly "left". The
    buttons only swap sides once the bow is 15° past that line, so they
    don't flicker while you sail across the screen.
- There's no marker for the no-go zone. The waves show it: point your
  bow within 45° of where they're coming from and you lose way. See
  [IDEAS.md](IDEAS.md) for the look the interface is aiming for.
- On a keyboard: → (or D) is always starboard rudder (clockwise) and ←
  (or A) port, as on the wheel, in either steering mode; Z (or Q) and X
  (or E) are the left and right buttons.
- The camera keeps your own ship above the controls along the bottom.

## The CPU

- It steers toward a point 120 m beside you: on your beam to trade
  broadsides, or across your bow or stern to rake. It picks whichever it
  can reach soonest, given the wind, leading you by its time to get
  there. Close to the point, it lies alongside (beam) or crosses your
  line (rake).
- When that point is upwind, it beats close-hauled (65° off the wind),
  tacking only when it has the speed to get through (1.2 m/s). If it's
  too slow to tack for long, it wears instead (turns away, round through
  downwind).
- It looks a few lengths ahead and turns away from land (hard also from
  shallows when it can), and gets itself out of irons.
- It fires a side when a simulated ripple from that side would hit you,
  assuming you hold your course: hard wants two predicted hits, easy
  one.
- **Easy** reacts 1 s late, judges your position ±25 m, steers in coarse
  steps and never rakes on purpose. **Hard** doesn't hold back.

## Settings

| Setting | Choices |
|---|---|
| CPU | Easy (default), Hard |
| Islands | None, Some, Many |
| Wind | Steady, Shifty (default), Gusty |
| Wind shadow | Off, On |
| Crew per gun | 2, 3 (default), 5 |
| Steering | Drag (default), Wheel |

*Steady* never shifts. *Gusty* shifts twice as often, by up to 45° and
6 kts.

## Parameters

| Name | Default | Meaning |
|---|---|---|
| `tickRate` | 30 | Ticks per second |
| `timeScale` | 4 | Game seconds per real second |
| `lift`, `drag` | 1.0, 1.0 | Sail coefficients; set the no-go zone and drive |
| `mass` | 6 | Divides every force: how quickly a ship gathers and loses way |
| `bowDrag` | 0.05 | Hull drag going forward |
| `keelDrag` | 1.0 | Hull drag going sideways |
| `windage` | 0.02 | Push of the apparent wind on hull and rigging |
| `turnRate` | 40°/s | Turn rate at full rudder and full steering speed |
| `steerSpeed` | 3 kts | Forward speed at which the rudder is fully effective |
| `muzzleSpeed` | 150 m/s | Ball speed relative to the ship, on screen |
| `gunRange` | 300 m | Distance before a ball splashes |
| `spread` | ±3° | Random error per ball |
| `reload` | 5 s | Per side, in real seconds |
| `traverse` | 20° | How far each gun can swing forward or aft of square |
| `crewPerGun` | 3 | Crew = this × total guns; at 0 she strikes |
| `endDelay` | 3 s | Real seconds with no ball in the air or gun firing, after the fight is decided, before the end screen |
| `shallowsDrag` | 3 | Hull drags are multiplied by this in shallows |
| `shadowRange`, `shadowCone`, `shadowFactor` | 160 m, 30°, 0.5 | Wind shadow: how far downwind, how wide, how much wind is left |
| `startGap`, `startOffset`, `startSpeed` | 700 m, 60 m, 3 m/s | Where and how the ships start |
| `bounce` | 1 m/s | How hard land, the edge or another ship pushes a ship off |
| `width`, `height` | 136, 136 tiles | Size of the sea (22 m tiles) |
| `islandsSome`, `islandsMany` | 0.8, 1.6 | Island blobs per 1,000 tiles of sea |
| `seed` | random | Same seed and same inputs = same game |

The ship's coefficients (`lift` to `steerSpeed`, guns, length) live in a
ship type in `sim.js` (`SHIP_TYPES`); the rest in `DEFAULTS`.

**Scale.** At real speed, a ship making 10 kts (5 m/s) would take over
three minutes to cross the sea. So the sea runs at `timeScale` times
real speed. Wind and ship speeds on the compass read like real ones,
but a ship covers its own length in about 2 real seconds. Gunnery is
set on screen instead, in real seconds: a ball crosses `gunRange` in 2
real seconds, so leading a moving target is a skill. That makes balls
far slower than real ones relative to the ships. **(open: whether 4× is
fast enough to feel like a fidget toy)**

## Later

- **Network play** against another person, through the repo's shared
  relay and lockstep (as in Dot Army). The sim was built for it:
  deterministic, inputs only, rudder as an integer.

## Room for a campaign (not the MVP)

A campaign could come later: run down cargo ships and loot them, escape
from heavier and better-armed ships, bombard enemy ports, refit at
friendly ones, dodge storms. None of that is in the first version, but
the duel shouldn't be built in ways that rule it out:

- **Any number of ships,** each with a side (blue, red, neutral, or
  later more) rather than hardcoded as "blue" and "red".
- **Ship types are data:** length, sail and hull coefficients, guns per
  side, crew, and later cargo. The duel uses one type. The
  prototype already kept its coefficients in a `Specs` record.
- **Guns are batteries** that belong to something. A ship has two (port
  and starboard). A fort at a port would be a battery on land with its
  own arc.
- **Wind is a function of position and time,** not one global value.
  In the duel it's the same everywhere. A storm would be a moving patch
  of strong, shifting wind.
- **The sea can be bigger than the screen.** It already is, and the
  islands are drawn in chunks as they come into view, so a bigger sea
  still is a parameter change.
- **The map is data in the sim:** a corner grid with places on it.
  Ports would be special tiles with a side and a battery.
- **The CPU steers by goals** (close to fire, rake, flee, follow a route,
  make for port), so a cargo ship that runs and a frigate that hunts are
  the same machinery with different goals.
- **Crew is state that can persist** between encounters. A refit at a
  friendly port is mostly recruiting.
- **Prize crews.** A ship that strikes can be taken instead of left
  adrift: come alongside, and move some of your crew across to sail her
  home or loot her. Those crew come out of your own hit points, so every
  prize makes you weaker until you reach port. That trade is the point
  of using crew as hit points: taking a prize is a real cost. Captains in
  the age of sail really did run short of men this way.
- **State can be saved:** the whole sim state is plain data plus the
  seed, so a campaign save is a serialised state.

### Embellishments after the MVP

These are for the episodic game, once the duel is built and playable.
Each is a sketch, not a rule yet.

- **Shore batteries.** Guns on land at a port or headland: a battery
  with a fixed arc, longer range than a ship's guns, and its own reload.
  A battery has its own gun crew and goes silent when it has none left,
  so bombarding a port means silencing its guns first. Only a fort can hit you out to
  its full range, so you can't trade broadsides with it. You have to
  run past it or come in from outside its arc. **(open: whether a
  silenced battery comes back after a while)**
- **Boarding.** Ships that touch below a set closing speed grapple
  instead of bouncing. They stay locked together, and neither can fire
  into the other. Each second, both sides lose crew in proportion to
  the other side's crew, until one side has none and strikes. Because
  crew is also hit points, softening a ship with broadsides first and
  then boarding comes naturally: you're judging when they're weak
  enough to grapple. The winner takes the ship as a prize. Either ship
  can cut free (a button) while the fight is still on. **(open: whether a third ship can fire into a
  grappled pair, hitting both)**
- **Running aground.** In the MVP, shallows only slow you and touching
  an island bounces you off. With grounding, a ship that enters a
  shallows tile faster than a set speed, or touches a beach, goes
  aground. It stops and can't steer. It loses no crew: the cost is
  time. Only windage can get it off: it floats free if the apparent
  wind pushes it back toward deeper water for long enough. Otherwise a
  **kedge** button frees it slowly. A grounded ship is a sitting target,
  so the charts suddenly matter. **(open: tides; whether heavier ships
  draw more water and ground on shallows a light ship can cross, which
  would give a small ship somewhere to run)**

- **Charged shots (elevation).** Holding a fire button raises the guns.
  The longer you hold, the higher the arc and the longer the range, up
  to a maximum. Let go to fire.
  - Each ball flies a real arc (a parabola, which keeps the sim to plain
    arithmetic) and can only hit a ship where it's low enough to strike
    the hull. That means along most of a short, flat shot, but only
    near the end of a long, lofted one. So a broadside can overshoot
    (sail clean over the target) or undershoot (splash short), and
    judging the range becomes the gunner's skill. Traverse still
    handles direction automatically, so the player decides only *when*
    and *how far*.
  - A tap fires the flattest arc, which is the MVP's flat shot. Charging
    is something you choose to do, not a step every shot needs.
  - Holding the button costs time. A ship you're about to rake may get
    out of your arc while you charge.
  - Lofted shots could clear low islands, and later could be how chain
    shot reaches rigging.
  - The ball's height shows as its shadow on the water pulling away
    from it. While charging, a gauge shows how far you've charged.
  - **Targeting lines** (later): showing where the shots will land
    while you charge. Deferred until the MVP has shown whether the game
    is playable and fun. A landing line makes range easy to judge, and
    may take the skill out.
- **Magazine explosions** (optional): a hit that kills the last of a
  ship's crew has a small chance of blowing her up instead of making her
  strike. That brings back a dramatic sinking without a second damage
  track. It also destroys the prize. **(open)**

## Notes

- **Damage slows a ship (future option).** Fewer crew means sails
  handled more slowly, so less drive and slower turns. That would feel
  more realistic, but it risks unbalancing the game: whoever lands the
  first broadside gets faster relative to their rival, so the gap keeps
  growing. It's out of the MVP. If it's tried, the headless games should
  show how often the side that kills crew first goes on to win, with and
  without it.

- **Headless results** (`node wooden-ships/tools/headless.js 40`,
  hard CPU vs hard CPU, 40 games per row, draft numbers). This table is
  from the first prototype's screen-shaped sea of about 1 × 2 km; on the
  3 km sea, defaults finish 100% (mean 89 s), many islands 100% (102 s),
  no islands 100% (78 s), and easy vs hard 100% (70 s, hard wins 93%).
  CPUs always close on each other, so those runs don't show running
  away. A blue ship that just holds her starting course does: the easy
  CPU took 80–534 s to beat her over 12 seeds (one still going after 10
  minutes), the hard one 63–288 s, often only once she'd pinned herself
  on the edge of the sea. A stern chase between equal ships barely
  closes. **(open: how to stop a person simply running away: a time
  limit, a smaller sea, or something else)**

  | Settings | Finished in 6 min | Mean length | Blue / red wins |
  |---|---|---|---|
  | Defaults | 100% | 81 s | 43% / 58% |
  | No islands | 100% | 86 s | 53% / 48% |
  | Many islands | 100% | 95 s | 53% / 48% |
  | Steady wind | 100% | 81 s | 48% / 53% |
  | Gusty wind | 100% | 96 s | 58% / 40% (1 draw) |
  | Wind shadow off | 100% | 88 s | 48% / 53% |
  | 5 crew per gun | 100% | 128 s | 40% / 60% |
  | Easy (blue) vs hard | 98% | 82 s | 28% / 70% |
  | Square sea (45 × 45) | 100% | 87 s | 60% / 40% |

  - Games finish: no long standoffs, so no time limit yet.
  - Lengths are to the moment the fight is decided, not the end screen,
    which comes 3 s or more later. With balls allowed to land after a ship
    strikes, a run of 40 hard-vs-hard games at the defaults had 5% draws.
  - The CPUs land about two thirds of their balls, because they fight
    at close range. People will do worse.
  - The side upwind at the first shift won only 30–43% of games, so the
    CPU doesn't exploit the weather gauge (see below). That says more
    about the CPU than the gauge.
  - Measured polar at 14 kts of wind: 0.9 kt at 50° off the wind, 3.9 at
    60°, 10.3 abeam, 14.0 at 135° (a broad reach), 11.0 dead downwind.
    Best progress upwind is about 2.2 kts, at 65°. A tack from 65°
    carries through in 14 and 20 kts of wind, but not in 8: in light air
    you wear or you end up in irons. **(open: whether upwind is too slow
    to be fun)**
  - **Ships were small on a phone:** with the whole sea on screen, 25
    lengths across a 390 px screen made a ship about 16 px long. The
    camera now zooms in to 450 m across (about 35 px per ship) and an
    arrow points at the enemy when she's off screen. **(open: whether
    450 m is the right zoom, and whether gun range, 300 m, should still
    fit comfortably on screen)**

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
  as integers (65,536 to a full turn), sines come from a lookup table,
  and the angle of attack is never computed as an angle: `sin a` and
  `cos a` come straight from the cross and dot products of the bow and
  the apparent wind. That keeps lockstep network play possible later.
  - The draft said the table would be committed to the repo. It's built
    at load instead, from a Taylor series that uses only `+` and `×`, so
    every engine builds the same table without shipping a megabyte of
    numbers. The CPU finds headings from vectors by binary search on the
    same table, never `atan2`.
- **Art.** This uses the prototype's sprites and terrain, copied into
  `wooden-ships/assets/`: the ship sheet
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
    see how the ship is set to the wind. The four hull pictures show
    damage: (1) above two-thirds crew, (2), (3), and (4) once she
    strikes. The palm and rock tiles aren't used: at this size they
    read as arrows. The ready-made `ship (n)`
    sprites have their sails fixed fore and aft. The sheet has sails in
    several colours, including blue (`sailLarge (5)`) and red
    (`sailLarge (3)`).
  - `cannonBall`, `explosion1–3` and `fire1–2` cover shots and hits.
    `flag (n)` can be lowered when a ship strikes. `wood (n)` can be
    wreckage from a magazine explosion.
  - A hull sprite is 108 px long for a 40 m ship. So 64 px terrain
    tiles come out at about 22 m, which sets the tile size above.
