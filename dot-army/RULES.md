# Dot Army — Rules

Two players, blue and red, each command a swarm of dots. Dots stream out of
spawn points and march toward their player's target. Nobody controls individual
dots: you drag your target, and the swarm follows. Fights are decided by which
way each dot is facing. Capture every spawn point to win.

## The field

- A rectangle of hexagonal cells, sized to fill the screen. The short side
  is 24, 34 or 46 cells (small, medium, large), and the long side
  stretches to match the screen's shape.
- Each cell holds at most one thing: a dot, part of a spawn point, or a
  rock. Dots never overlap.
- The layout is point-symmetric (rotated 180° about the centre), so
  neither side has an advantage. In portrait, blue is at the bottom and
  red at the top, so two people can face each other across a phone.
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

- Each player has one target marker, which they drag around the field.
- Dots path toward their own player's target.
- If the target sits on a spawn point, the whole spawn blob counts as the
  target.

## A tick

Each tick runs these phases in order.

### 1. Input
Each player's target position is updated from their drag.

### 2. Pathfinding
For each player, a breadth-first search outward from the target gives
every passable cell its distance from that target. This is a **flow
field**. Rocks and spawn blobs block the search. Dots do not. That's
deliberate: dots can stand in the way, but the route still goes through
them, so crowds pile up and jostle instead of taking huge detours.

### 3. Movement
Dots closest to their own target move first, with ties broken by a seeded
shuffle. For each dot:

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
   line. Crowds then spread around the target instead of queueing back
   along the path. The straight-line distance falls with every sidestep,
   so dots can't oscillate. A dot held up by an *enemy* holds its ground.
4. **Touching the spawn it's targeting:** if the spawn is enemy or
   neutral, or is friendly with a meter below max, the dot turns to face
   it (to attack or reinforce it). If it's friendly and full, the dot
   turns to face away from it, to guard it.
5. **Clustering:** a dot that has reached its target is *settled*. So is
   a dot whose every closer cell is held by settled friends; such a dot
   turns to face directly away from the target. Because dots are
   processed nearest-first, "settled" spreads outward from the target,
   and a group that arrives becomes an outward-facing hedgehog. A column
   held up by a fight up front isn't settled, because its leader is
   locked, not settled, so it keeps facing forward. A settled dot that
   touches an enemy or neutral spawn turns to face it instead, so a
   hedgehog parked beside a spawn grows until it reaches the blob and
   then starts eating it.
6. Otherwise the dot waits and tries again next tick.

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

- its player's target is on that spawn, or
- the dot is settled and the spawn is enemy or neutral.

Dots that are just walking past a spawn leave it alone. What happens to
the meter:

- **Enemy or neutral spawn:** the meter drops by 1.
- **Friendly spawn** (only when your target is on it): the meter rises
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
Every `spawnInterval` ticks, each owned spawn emits **one dot** at its free
exit closest to the owner's target. The new dot faces outward, away from
the spawn's centre. If every exit is blocked, nothing comes out, so you
can choke a spawn by camping on its exits. If `maxDotsPerPlayer` is set,
a player at the cap gets nothing either.

### 8. Win check
If one player owns **every** spawn point, they win immediately. Dots the
loser still has on the field don't matter.

## Controls

- **Two players, one screen** (the default): each player drags their own
  colour's marker, and multitouch lets both drag at once. Tapping empty
  space in your own half of the screen jumps your marker there. Halves
  are bottom and top in portrait, left and right in landscape.
- **vs CPU** (easy or hard): you're blue, and the CPU moves red's
  marker under the same rules a human does. It drags the marker at a
  limited speed rather than jumping it: about 9 cells per second on
  easy and 18 on hard, at average speed.
- Pause, new game, mute and settings buttons are at the edge of the
  screen. Settings are remembered between visits.

## Settings

The settings panel offers five choices. Everything else in the parameter
table below is fixed at its default.

| Setting | Choices |
|---|---|
| Opponent | Human, Easy CPU, Hard CPU |
| Board | Small, Medium, Large (24 / 34 / 46 cells across the short side) |
| Speed | Slow, Average, Fast (5 / 8 / 12 ticks per second) |
| Spawns | Few, Some, Many (4 / 6 / 10 neutral spawns) |
| Obstacles | None, Some, Many |

## Parameters

| Name | Default | Meaning |
|---|---|---|
| field size | medium | Cells across the short side: 24 / 34 / 46 |
| `tickRate` | 8 | Ticks per second |
| `spawnInterval` | 2 | Ticks between emissions from each spawn |
| `neutralSpawns` | 6 | Neutral spawn points (even) |
| `meterMax` | 40 | Control meter cap; homes start full |
| `neutralMeter` | 10 | Starting meter of neutral spawns |
| `meterRegen` | 8 | Ticks per +1 meter on owned spawns (0 = off) |
| `facingArc` | 1 | 1 = dead ahead, 3 = front three |
| `maxDotsPerPlayer` | 0 | Optional cap on each player's dots (0 = none) |
| `terrain` | open | `open`, `rocks` or `dense` |
| `seed` | random | Same seed and same inputs = same game |

## Notes

- **Deterministic core.** The simulation uses only integers, a seeded
  random generator and the players' target positions. Same seed and
  same inputs give the same game in any browser. That's what will make
  lockstep network play (each side exchanging only inputs) and replays
  straightforward later.
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
  won, kills and captures. Human games run longer than CPU ones.
