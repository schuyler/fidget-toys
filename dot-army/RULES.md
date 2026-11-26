# Dot Army — Rules

Two players, blue and red, each command a swarm of dots. Dots stream out of
spawn points and march toward their player's target. Nobody controls individual
dots: you drag your target, and the swarm follows. Fights are decided by which
way each dot is facing.

## The field

- The field is a rectangle of hexagonal cells (default **60 × 40**).
- Each cell holds at most one thing: a dot, part of a spawn point, or an
  obstacle. Dots never overlap.
- Obstacles are impassable cells. The MVP has none. The pathfinding already
  routes around them, so adding layouts later only means designing maps.

## Spawn points

- A spawn point is a blob of **7 cells**: a centre cell plus the six around
  it. Dots can't enter it.
- Its **exits** are the 12 free cells in the ring just outside the blob.
- Each spawn point is neutral, blue, or red, and has a **control meter**
  from 0 up to `meterMax` (default 20).
- At the start, each player owns one home spawn at full meter. There are
  `neutralSpawns` neutral spawns (default 6), each starting at
  `neutralMeter` (default 5). The layout is mirrored, rotated 180° about
  the centre, so neither side has an advantage.

## Dots

- A dot belongs to one player and has a **facing**: one of the six hex
  directions.
- A dot **faces** a neighbouring cell when that cell is directly ahead
  (`facingArc = 1`, the default). See open question 1.
- A dot that moves turns to face the direction it moved.

## Targets

- Each player has one target marker, which they drag around the field.
- Dots path toward their own player's target.
- If the target sits on a spawn point, the whole spawn blob counts as the
  target, and dots swarm to its edge.

## A tick

The game runs in discrete ticks (default **8 per second**, `tickRate`).
Each tick runs these phases in order:

### 1. Input
Each player's target position is updated from their drag.

### 2. Pathfinding
For each player, a breadth-first search outward from the target gives
every passable cell its distance from that target. This is a **flow
field**. Obstacles and spawn blobs block the search. Dots do not. That's
deliberate: dots can stand in the way, but the route still goes through
them, so crowds pile up and jostle instead of taking huge detours.

### 3. Movement
Each dot does at most one step:

- **Locked dots don't move.** A dot is locked when it's in a
  *stalemate*: an adjacent enemy and the dot face each other. It stays
  locked, without moving or turning, until that enemy dies or moves off.
- Otherwise the dot steps into the free neighbouring cell with the
  **lowest distance**, as long as that's strictly lower than the distance
  of the cell it's standing on. If several cells tie, it picks the one
  nearest its current facing, which gives dots some momentum, and breaks
  any remaining tie with a seeded random choice.
- **Clustering:** if the dot can't get closer because friendly dots fill
  every closer cell, it turns to **face directly away from its target**
  and stays put. A clump at the target ends up as an outward-facing
  hedgehog.
- Any other dot that can't move this tick (for example, it lost a race
  for a cell) just waits and tries again next tick.
- **Movement order:** dots closest to their own target move first, and
  ties are broken by a seeded shuffle. That way a column flows forward as
  a unit instead of moving like an accordion (see Notes).

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
a single tick, and can be destroyed in the same tick it destroys
something else.

### 5. Spawn attacks
For each dot that survived combat and faces a spawn cell:

- **Enemy spawn** (neutral, or owned by the other player): the dot is
  used up, and the meter drops by 1.
- **Friendly spawn** below `meterMax`: the dot is used up, and the meter
  rises by 1. A full friendly spawn ignores it.

All changes in a tick are applied together. When an **owned** spawn's
meter hits 0, it flips straight to the attacker at meter 1, without going
neutral first. When a **neutral** spawn's meter hits 0, it goes to the
player who used up more dots on it this tick, at meter 1. If both used up
the same number, it stays neutral at 0 and the next tick decides.

### 6. Spawning
Every `spawnInterval` ticks (default 1), each owned spawn emits **one
dot** at its free exit closest to the owner's target, using the flow
field. The new dot faces outward, away from the spawn's centre. If every
exit is blocked, nothing comes out. If `maxDotsPerPlayer` is set and the
player is at the cap, nothing comes out either.

### 7. Win check
If one player owns **every** spawn point, they win immediately. Dots the
loser still has on the field don't matter.

## Controls (MVP)

- Two humans share one touch screen. Each player drags their own colour's
  marker, and multitouch lets both drag at once. A mouse also works, one
  marker at a time.
- A pause/reset control, and a settings panel for the parameters below.

## Parameters

| Name | Default | Meaning |
|---|---|---|
| `width` × `height` | 60 × 40 | Field size in hexes |
| `tickRate` | 8 | Ticks per second |
| `spawnInterval` | 1 | Ticks between emissions from each spawn |
| `neutralSpawns` | 6 | Neutral spawn points |
| `meterMax` | 20 | Control meter cap |
| `neutralMeter` | 5 | Starting meter of neutral spawns |
| `facingArc` | 1 | Neighbours a dot faces: 1 = dead ahead, 3 = front three |
| `maxDotsPerPlayer` | none | Optional cap on each player's dots |
| `seed` | random | Random seed (same seed and same inputs = same game) |

## Notes

- **Deterministic core.** The simulation uses only a seeded random
  generator and a list of input commands, each stamped with its tick.
  Rendering and input sit on top. That's what makes AI opponents and
  lockstep network play straightforward to add later.
- **Movement isn't purely simultaneous.** We agreed earlier that two dots
  wanting the same cell would be settled by a random winner. With a purely
  simultaneous move, though, a dot can only step into a cell that was
  empty at the start of the tick. A packed column would then advance one
  gap at a time, at about half speed. Moving front-first fixes that.
  Combat is still fully simultaneous.

## Open questions

1. **Facing arc.** On a hex grid the neighbours sit at exactly 0°, 60°,
   120° and so on from a dot's facing. So "< 60°" means **dead ahead
   only**, while "≤ 60°" means the **front three**. These play very
   differently. With dead ahead only, flanking is easy and stalemates are
   rare. With the front three, dots are deadlier and lock up in
   stalemates much more often. The default is dead ahead, it's available
   as `facingArc`, and we can tune it by playing.
2. **Spawn attacks by accident.** Under rule 5, a dot marching past an
   enemy spawn and happening to face it will throw itself at it. That
   might be fine, since spawns attract fights, or attacks might need to
   be limited to dots whose target is that spawn.
3. **Board size, layout, defaults.** These are first guesses, to be tuned
   in play.
