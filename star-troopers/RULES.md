# Star Troopers — Rules (draft)

Two small squads fight over a patch of a colony world, one soldier at a
time. Every trooper has a pool of nine task points per turn to spend on
moving, shooting, dodging and keeping watch, and every hit it takes comes
out of that same pool. Both sides plan their orders in secret, then the
whole turn plays out at once.

Turn-based. You command one squad; the CPU commands the other. Built so
that pass-and-play and network play can be added later.

> **Draft.** *Star Troopers* is a working title. Every number here is a
> starting guess, to be tuned with headless CPU-vs-CPU games. Questions
> still open are marked **(open)**.

## The field

- A hex map, about 13 cells across and 19 tall in portrait **(open:
  sizes)**. Generated from the game's seed.
- Every cell is one of:

  | Terrain | Move cost | Cover | Line of sight |
  |---|---|---|---|
  | **Open** | 1 | 0 | clear |
  | **Brush** | 2 | 1 | clear |
  | **Ruins** | 2 | 2 | blocks |
  | **High ground** | 2 to climb onto, 1 along or off | 1 | clear; see below |
  | **Rock** | impassable | — | blocks |

- In scenarios where both sides have the same goal, the map is
  point-symmetric (rotated 180° about the centre), so neither squad has
  an advantage. Other scenarios have their own layouts.
- Each squad starts in a deployment zone along its own edge (the three
  rows nearest it). Troopers are placed automatically, mirrored where the
  map is. **(open: let the player place them)**

## Troopers

- Each side fields one squad of troopers, all of one species.
- A trooper has:
  - a **pool** of 9 task points;
  - **shock**, starting at 0. Hits add shock. A trooper's usable points
    each turn are `9 − shock`. A trooper whose shock reaches 9 is
    **down** and out of the game;
  - its species' **Aim** and **Recovery** (below).
- Each cell holds at most one trooper.

### Species

| Species | Squad | Aim | Recovery | Special |
|---|---|---|---|---|
| **Troopers** (human) | 4 | 2 | 3 | — |
| **Vell** | 6 | 1 | 1 | Every cell costs 1 to enter (except rock) |

Troopers shoot and dodge twice as well and shake off hits quickly. The
Vell are worse at both, but there are more of them and they ignore rough
ground. Mirror matches (Troopers against Troopers) are the default.
**(open: whether 6 Vell are a fair match for 4 Troopers)**

## Orders

At the start of each turn both sides plot orders for every trooper, in
secret. The CPU plots without seeing yours. A trooper's usable points are
split between four tasks, and points left unspent are wasted:

- **Move:** plot a path, paying each cell's move cost.
- **Fire:** pick one enemy in line of sight and put any number of points
  into a shot at it.
- **Dodge:** points put into staying low and moving unpredictably. They
  make every shot at this trooper harder this turn.
- **Overwatch:** points held back to shoot the first enemy that shows
  itself during movement (see A turn).

A trooper can do all four in one turn, as long as the points add up.

## Shooting

```
attack  = fire points × Aim
defence = cover            (of the cell the target is in when shot)
        + floor(range / 3)
        + floor(cells the target plotted to move / 2)
        + dodge points × Aim
```

- If `attack < defence`, the shot misses.
- Otherwise it deals `floor((attack − defence) / 2)` shock.
- **Noise (setting, off by default):** when it's on, a shot that didn't
  miss also adds one of −1, 0, 0 or +1 to its shock, chosen at random
  (minimum 0). The average stays the same. Near-threshold shots
  sometimes land and marginal ones sometimes don't, so a dug-in trooper
  is never entirely safe.
- There's no combined fire: every shot is worked out on its own, and
  their shock adds up.

For example, a fresh Trooper puts 5 points into a shot (attack 10) at a
Trooper standing in the open 4 cells away (range 1). With no dodge,
that's `floor(9 / 2) = 4` shock. If the target had put 3 points into
dodging (+6), it would have taken `floor(3 / 2) = 1`.

### Line of sight

- Trace a straight line between the centres of the two cells. Rock and
  ruins block it, unless they're the cell at either end. A line running
  exactly along an edge between two cells is blocked only if both cells
  block.
- A trooper on high ground sees over ruins (but not rock), and so can
  be seen over them.
- Troopers never block line of sight. **(open)**

### Preview

When you plot a shot, the game shows what it would deal if the target
neither dodges nor moves, and how many dodge points would cancel it
completely. You know the arithmetic; what you don't know is their
orders.

## A turn

1. **Plot:** both sides plot orders, then commit.
2. **Fire:** every shot is resolved from where everyone starts the turn,
   all at the same time. Shock is applied together afterwards, so a
   trooper that goes down this phase still fires. Defence uses the
   target's plotted movement and dodge, because they're already on the
   move.
3. **Move:** troopers move along their paths one cell per step, all at
   once.
   - A move that would put two troopers in one cell, or swap two
     troopers, is blocked, and that trooper stops for the rest of the
     turn. Following right behind a moving friend is fine.
   - **Overwatch:** after each step, every trooper with overwatch
     points that hasn't fired yet shoots the nearest enemy that ended
     that step in its line of sight, within 6 cells. All overwatch in a
     step resolves together, at `overwatch points × Aim`, against the
     usual defence. Each trooper's overwatch fires once per turn.
   - **Pinned:** a trooper that takes shock from overwatch stops where
     it is.
   - A trooper that goes down stops and is removed at the end of the
     step.
4. **Recovery:** every trooper that took no shock this turn removes
   shock equal to its Recovery. A hurt trooper that gets into cover and
   keeps its head down will get back into the fight; one that's still
   being shot at won't.
5. **Win check.**

## Scenarios

- **Skirmish:** last squad standing. Symmetric map.
- **Hold:** three objective cells across the middle of a symmetric map.
  From turn 4, at the end of each turn, each side scores 1 point per
  objective it holds a trooper on. First to 8 points wins.
- **Breakthrough:** one squad attacks and must get half its starting
  troopers (rounded up) off the defender's edge. The defender wins by
  stopping it. Asymmetric map. **(open: whether you can pick the side)**

Any scenario also ends after **12 turns**. Unless the scenario says
otherwise, the side with more troopers left standing wins, and equal
numbers is a draw.

## Controls

- **Plotting:** tap one of your troopers. Its pool appears as nine pips,
  with lost points shown as shock.
  - Drag from the trooper to plot a path. Its cost fills pips as you go.
  - Tap an enemy to aim at it, then use + and − to set fire points. The
    preview sits beside the target.
  - + and − set dodge and overwatch.
- A **Commit** button ends plotting.
- **Watching:** the turn plays back as shots first, then movement step
  by step, with overwatch shots as they happen. A **Replay** button runs
  the last turn again.
- Everything on the field is visible, including enemy shock. Only
  orders are secret. **(open: fog of war)**
- Pan by dragging and pinch to zoom, as in Coreward Bound.

## Settings

| Setting | Choices |
|---|---|
| Your squad | Troopers, Vell |
| Enemy squad | Troopers, Vell |
| Scenario | Skirmish, Hold, Breakthrough |
| CPU | Easy, Hard |
| Map | Small, Medium, Large |
| Terrain | Open, Some, Dense |
| Noise | Off, On |

## Parameters

| Name | Default | Meaning |
|---|---|---|
| `pool` | 9 | Task points per trooper; shock at this level is down |
| `rangeStep` | 3 | Cells per +1 defence from range |
| `motionStep` | 2 | Plotted cells moved per +1 defence |
| `damageDivisor` | 2 | Shock = margin ÷ this, rounded down |
| `overwatchRange` | 6 | How far overwatch reaches |
| `noise` | 0 | 0 = off, 1 = ±1 on shots that land |
| `turnLimit` | 12 | Turns before a scenario is decided on troopers left |
| `seed` | random | Same seed and same orders = same game |

## Notes

- **Deterministic core.** As in Dot Army and Coreward Bound, the game
  logic uses integer state and a seeded random generator, and nothing
  else. With simultaneous orders this pays off twice: each side only
  ever needs to send its orders, which makes lockstep network play
  simple, and the headless tuner can run thousands of turns.
- **Why noise starts off.** Not knowing the other side's orders is
  already plenty of uncertainty, and the interesting kind. The worry
  with pure arithmetic is that defence can become absolute: two squads
  in cover, dodging, unable to hurt each other. That's a guess. Dot
  Army's front-three facing produced exactly that kind of wall, but
  recovery and objectives may be enough to break it here. Headless
  games will tell: how often nobody deals shock for several turns
  running, how long games last, and how often the side ahead at
  half-time loses. If noise 0 doesn't stall, it stays off.
- **The CPU varies its own orders.** It weighs a few candidate orders
  against what you're likely to do, then picks among the good ones at
  random (from the seeded generator), rather than always making the
  single best reply. A CPU that always makes the best reply to its
  prediction is easy to bait.
- **Pass-and-play,** when it comes, needs a cover screen between the
  two players' plotting.
- **What changed from the 1977 game that inspired this** (SPI's
  StarSoldier). I couldn't get hold of its rulebook, so this is built
  from reviews and published play reports:
  - The computer does the bookkeeping. Tracking points and writing
    orders was what reviewers complained about most.
  - Four tasks instead of the original's longer list.
  - Damage is half the margin by which attack beats defence, with
    optional ±1 noise.
  - Recovery only happens in a turn the trooper wasn't hit.
  - Shots happen before anyone moves, from where everyone starts.
    Overwatch is the only fire during movement, and a hit pins.
  - Single-stage turns only.
  - Its own species and scenarios. No orbital bombardment, homing
    missiles or wildlife. **(open: any of these as later additions,
    for example a one-shot orbital strike, or a neutral predator that
    attacks whoever's nearest)**
