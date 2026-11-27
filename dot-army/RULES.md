# Dot Army — Rules

Two players, blue and red, each command a swarm of dots. Dots stream out of
spawn points and march toward their player's targets. Nobody controls individual
dots: you place and drag up to three targets, and the swarm follows. Fights are decided by which
way each dot is facing. Win by taking all your opponent's spawn points
and destroying their last dot.

## The field

- A rectangle of hexagonal cells, sized to fill the screen. The short side
  is 24, 34 or 46 cells (small, medium, large), and the long side
  stretches to match the screen's shape.
- Each cell holds at most one thing: a dot, part of a spawn point, or a
  rock. Dots never overlap.
- The layout is point-symmetric (rotated 180° about the centre), so
  neither side has an advantage. Blue starts at the bottom (left in
  landscape) and red at the top; online, the guest's board is turned
  180° so red's home is nearest them.
- **Obstacles:** none (the default), some, or many rocks. Rocks are
  impassable, and dots path around them. Every spawn point is always
  reachable.

## Spawn points

- A blob of **7 cells**: a centre cell plus the six around it. Dots can't
  enter it.
- Its **exits** are the 12 cells in the ring just outside the blob.
- Each spawn point is neutral, blue, or red, and has a **control meter**
  from 0 up to `meterMax`.
- At the start, each player owns one home spawn at full meter. There are
  `neutralSpawns` neutral spawns (always an even number, placed in
  mirrored pairs), each starting at `neutralMeter`.

## Dots

- A dot belongs to one player and has a **facing**: one of the six hex
  directions.
- A dot **faces** the neighbouring cell directly ahead of it. A
  `facingArc` setting widens this to the front three neighbours, but
  that version gridlocks: see Notes.
- A dot that moves turns to face the direction it moved.

## Targets

- Each player has between 1 and `maxTargets` target markers (the Targets
  setting: 1, 2 or 3; 3 by default). You always have at least one: the
  last can't be removed.
- Each dot heads for whichever of its own player's targets is nearest **by
  path** (not in a straight line). Two targets split your army: dots on
  one side go to one, dots on the other side to the other.
- If a target sits on a spawn point, the whole spawn blob counts as that
  target, and the spawn counts as *targeted*.
- You never see the opponent's markers, only their dots. You find out
  where they're going when their dots commit.
- **Extra targets trade attack for defence.** New dots come out near your
  spawns, so a second target parked by your spawns is the nearest one for
  every new dot. It catches all of them, and your attack target gets
  nothing until you move or remove the second one. It's a good way to
  hold a spawn and a bad way to win.

## A tick

Each tick runs these phases in order.

### 1. Input
Each player's targets are added, removed or moved, in the order the
inputs were made.

### 2. Pathfinding
For each player, one breadth-first search outward from all their targets
at once gives every passable cell its distance to the nearest target, and
labels it with which target that is. This is a **flow field**. Where two
targets are equally near, the label goes to whichever search wave got
there first (lower-numbered targets start first), which is deterministic. Rocks and spawn blobs block the search. Dots do not. That's
deliberate: dots can stand in the way, but the route still goes through
them, so crowds pile up and jostle instead of taking huge detours.

### 3. Movement
Dots closest to their own target move first, with ties broken by a seeded
shuffle. "The target" below always means the dot's own target: the one
its cell is labelled with in phase 2. For each dot:

1. **Locked dots don't move.** A dot is locked when it's in a stalemate:
   an adjacent enemy and the dot face each other. It stays locked, without
   moving or turning, until that enemy dies.
2. **Advance:** step into the free neighbouring cell with the lowest
   distance, as long as that's strictly lower than the distance of the
   cell it's on. If several cells tie, it picks the one nearest its
   current facing (momentum). Any remaining tie is a seeded random pick.
3. **Sidestep:** if the dot can't advance and every closer cell is held
   by a *friendly* dot, it may step sideways to a free cell at the same
   distance, but only if that cell is nearer the target in a straight
   line and is labelled with the same target. Crowds then spread around
   the target instead of queueing back along the path. The straight-line
   distance falls with every sidestep, so dots can't oscillate. (Without
   the same-target condition, a dot on the boundary between two targets'
   regions could step toward one, then back toward the other, forever.)
   A dot held up by an *enemy* holds its ground.
4. **Blocked by an enemy:** if the dot can't advance and an enemy holds a
   closer cell, it turns to face that enemy. That's how a crowd finishes
   off a straggler that's locked head-on with one of its dots: the others
   turn on it from the side.
5. **Touching the spawn it's targeting:** if the spawn is enemy or
   neutral, or is friendly with a meter below max, the dot turns to face
   it (to attack or reinforce it). If it's friendly and full, the dot
   turns to face away from it, to guard it.
6. **Clustering:** a dot that has reached its target is *settled*. So is
   a dot whose every closer cell is held by settled friends; such a dot
   turns to face directly away from the target. Because dots are
   processed nearest-first, "settled" spreads outward from the target,
   and a group that arrives becomes an outward-facing hedgehog, one at
   each target. A column
   held up by a fight up front isn't settled, because its leader is
   locked, not settled, so it keeps facing forward. A settled dot that
   touches an enemy or neutral spawn turns to face it instead, so a
   hedgehog parked beside a spawn grows until it reaches the blob and
   then starts eating it.
7. Otherwise the dot waits and tries again next tick.

### 4. Combat
Combat is judged from a single snapshot of the board after movement, and
every loser is removed at the same time. For each pair of adjacent enemy
dots A and B:

| A faces B? | B faces A? | Result |
|---|---|---|
| yes | no  | **B is destroyed** |
| no  | yes | **A is destroyed** |
| yes | yes | Stalemate: both are locked |
| no  | no  | Nothing |

A dot can only harm what it faces. One dot can destroy several enemies in
a tick, and can be destroyed in the same tick it destroys something else.

### 5. Spawn attacks
A dot that survived combat and faces a spawn blob is **used up** if
either of these is true:

- any of its player's targets is on that spawn, or
- the dot is settled and the spawn is enemy or neutral.

Dots that are just walking past a spawn leave it alone. What happens to
the meter:

- **Enemy or neutral spawn:** the meter drops by 1.
- **Friendly spawn** (only when one of your targets is on it): the meter rises
  by 1. Only as many dots are used up as are needed to refill it.

All changes in a tick are applied together:

- **Owned spawn** reaching 0 or below: it flips to the attacker. Any
  overshoot becomes the new owner's meter (minimum 1). For example,
  5 attackers against a meter of 3 leave the attacker owning it at
  meter 2.
- **Neutral spawn** reaching 0 or below: it goes to whichever player used
  up more dots on it this tick, with the overshoot as its meter. If both
  used up the same number, it stays neutral at 0, and the next hit
  decides.

### 6. Meter regen
Every `meterRegen` ticks, each owned spawn's meter rises by 1, up to max.
A freshly captured spawn is fragile at first, then digs in.

### 7. Spawning
Each player has one **production pool** shared by all their spawns. Every
tick it fills by:

```
rate = (1 + extraSpawnRate% × (spawns owned − 1)) / spawnInterval
       × armyHalfRate / (armyHalfRate + dots on the field)
```

With the defaults, one spawn makes a dot every 2 ticks, each further spawn
adds 65% of that (so four spawns make about 3× as many dots, not 4×), and
an army of 100 dots produces at half speed. Capturing spawns still pays, but
less with each one, and hoarding a huge army slows you down. Spend your
dots.

Each time the pool holds a whole dot, one dot comes out of the **next
owned spawn in turn** (round robin), at its free exit closest (by path) to
the owner's nearest target. The new dot faces outward, away from the spawn's centre.
A spawn with every exit blocked is skipped and the next one gets the dot,
so camping a spawn's exits stops dots coming out *there*, not overall. If
every spawn is blocked, the pool keeps at most one dot's worth waiting.
If `maxDotsPerPlayer` is set, a player at the cap gets nothing.

### 8. Win check
A player who owns **no spawn points and has no dots left** is eliminated,
and the other player wins. Neutral spawns don't count either way: you
never need to capture them.

So losing your last spawn isn't the end. While you still have dots on the
field you're alive, and they can retake a spawn by attacking it. A draw
can't happen: once a spawn has an owner it only ever changes hands and
never goes back to neutral, so at least one player always owns a spawn.

## Controls

- **One player per screen.** The whole board is yours:
  - **Tap empty board** to add a target there.
  - **Tap one of your markers** to remove it (never the last one).
  - **Drag a marker** to move it. A press that moves more than a few
    pixels is a drag, so nudging a marker never removes it.
  - **At the cap,** a tap on empty board moves your nearest marker there
    instead. With Targets = 1 that means a tap jumps your only marker,
    and tapping the marker itself does the same.

  A press near a marker but not on it, released without moving, counts as
  a tap on empty board, so it adds a target rather than grabbing that one.
- **vs CPU** (easy, the default, or hard): you're blue, and the CPU plays
  red through the same inputs a human makes: add, remove and move its own
  targets. It uses at most two, whatever the Targets setting allows
  above that. Its first target attacks and is never removed. When it
  sees any of your dots on an exit of a spawn it owns, it adds a defend
  target on that exit cell (or drags its existing one there), and removes
  it once none of its spawns has an enemy on an exit. With Targets = 1 it
  diverts its only target to the threat instead, most of the time. It
  reconsiders every 16 ticks on easy and every 6 on hard (2 s and
  0.75 s at average speed). Adding or removing is instant, like a tap, but moving isn't: all
  its targets share one drag speed, about 9 cells per second on easy and
  18 on hard, at average speed.
- **Online:** another person plays from their own device. The host is blue
  and their settings apply; the guest's board is turned 180° so their home
  is nearest them. Start one with Play online (share the link or code) or
  Join with code. If the other player leaves, or the room is full, or the
  server can't be reached, the game says so and a tap goes back to the menu.
  Gestures are ignored while the WAITING overlay is up (the other device
  has stalled for more than 600 ms), so nothing piles up while it catches
  up.
  A code nobody is hosting gets "no one here yet" after five seconds; the
  game keeps waiting for the host, and ☰ leaves.
- Every page load opens a start menu (New game, Play online, Join with
  code, Settings, Rules), unless it's a shared link, which joins the game
  directly. The ☰ button in a corner of the HUD pauses and opens a menu
  with Resume, New game, Settings, Rules and Sound; online it has Resume,
  Rules, Sound and Leave game. Settings are remembered between
  visits.
- The board is laid out for the orientation the game starts in. Turning
  the phone mid-game pauses it until you turn it back (not online, where
  the other player would be left waiting).
- A spawn you own that's being drained by the enemy throbs: its meter
  ring swells and glows until the attack stops.
- The win screen shows each side's totals: dots made, kills, losses,
  dots thrown at spawns, spawns captured and biggest army.

## Settings

The settings panel offers six choices. Everything else in the parameter
table below is fixed at its default. Online, the host's settings apply
to both devices.

| Setting | Choices |
|---|---|
| CPU | Easy (default), Hard |
| Board | Small, Medium, Large (24 / 34 / 46 cells across the short side) |
| Speed | Slow, Average, Fast (5 / 8 / 12 ticks per second) |
| Spawns | Few, Some, Many: 4 / 6 / 10 neutral spawns, with `extraSpawnRate` 50 / 65 / 80 |
| Targets | 1, 2, 3 (default): most targets each player may hold |
| Obstacles | None, Some, Many |

Spawns sets `extraSpawnRate` along with the count, so that the
diminishing returns (see Spawning) keep the leader from snowballing at
every spawn count, not just the default.

## Parameters

| Name | Default | Meaning |
|---|---|---|
| field size | medium | Cells across the short side: 24 / 34 / 46 |
| `tickRate` | 8 | Ticks per second |
| `spawnInterval` | 2 | Ticks per dot from a single spawn |
| `extraSpawnRate` | 65 | % of a spawn's output each further spawn adds (100 = linear); set by Spawns |
| `armyHalfRate` | 100 | Army size at which production halves (0 = off) |
| `neutralSpawns` | 6 | Neutral spawn points (even) |
| `meterMax` | 40 | Control meter cap; homes start full |
| `neutralMeter` | 10 | Starting meter of neutral spawns |
| `meterRegen` | 8 | Ticks per +1 meter on owned spawns (0 = off) |
| `facingArc` | 1 | 1 = dead ahead, 3 = front three |
| `maxDotsPerPlayer` | 0 | Optional cap on each player's dots (0 = none) |
| `terrain` | open | `open`, `rocks` or `dense` |
| `maxTargets` | 3 | Most targets each player may hold (clamped to 1..127); set by Targets |
| `seed` | random | Same seed and same inputs = same game |

## Notes

- **Deterministic core.** The simulation uses only integers, a seeded
  random generator and the players' target inputs (add, remove, move). Same seed and
  same inputs give the same game in any browser. That's what makes
  lockstep network play work (each side exchanges only inputs), and it
  would make replays straightforward too.
- **Why movement isn't simultaneous.** If every dot moved at once, a dot
  could only step into a cell that was empty at the start of the tick.
  A packed column would then advance one gap at a time, at about half
  speed. Moving nearest-first lets a column flow as a unit. Combat is
  still fully simultaneous.
- **Why dead-ahead facing.** In CPU-vs-CPU test runs with the front-three
  arc, 9 of 12 games never finished: dots lock into stalemates far too
  easily, and the front line becomes a permanent wall. With dead-ahead
  facing, every game finished, typically in under a minute.
- **Tuning.** `node dot-army/tools/headless.js 20 key=value ...` plays
  CPU-vs-CPU games without a browser and prints how long they took, who
  won, kills, captures, how often the lead in spawns changed hands, and
  how many targets each side held on average. `cpuTargets0=N` and
  `cpuTargets1=N` cap blue's and red's CPU at N targets, and `swap` plays
  every seed twice with the sides swapped and reports wins per
  configuration instead of per colour. Human games run longer than CPU
  ones.
- **Why production has diminishing returns.** When every spawn emitted on
  its own clock, production grew linearly with spawns, so whoever got
  ahead snowballed. In 150 CPU-vs-CPU games on a medium board, the shared
  pool with these defaults stretched games from 41 to 57 seconds on
  average, raised lead changes from 2.1 to 3.3 per game, and cut the peak
  army from about 185 dots to about 87. A steeper 50% gave about as many
  lead changes but smaller armies; 80% and up let the snowball back in.
  Those numbers are for 6 neutral spawns, which is why 65% is the sim
  default and the Some preset; Few and Many use 50% and 80%.
- **Multiple targets and the CPU.** On a medium board, a CPU allowed two
  targets beats one held to a single target about 60–63% of the time,
  so the extra target is worth having but doesn't run away with it.
  Every game still finished, in about 56 seconds on average. Lead changes
  in CPU-vs-CPU games are about 2.8 per game at Targets = 3 and 2.4 at
  Targets = 1, down from 3.3 before the CPU started defending at the first
  enemy dot on a spawn's exits (it used to wait for 2 at its home and 4
  elsewhere). Whether that makes human games duller is still to be found
  out by playing.
  An earlier version also parked a "guard" target by its spawns; that
  caught every new dot, starved its own attack, and CPU-vs-CPU games at
  Targets = 3 never finished, so it went.
