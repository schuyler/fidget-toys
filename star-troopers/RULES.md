# Star Troopers — Rules (draft)

Two small squads fight over a patch of a colony world, one soldier at a
time. Every trooper has a pool of task points per turn to spend on
moving, shooting, dodging and keeping watch, and every hit it takes comes
out of that same pool. Both sides plan their orders in secret, then the
whole turn plays out at once.

Turn-based. You pick a faction and command its squad; the CPU picks
another. The first version is you against the CPU only. Playing another
person comes later, over the network (see Later).

An homage to Tom Walczyk's *StarSoldier* (SPI, 1977). The factions'
numbers are the original species' numbers. See the notes at the end for
what it borrows and what it changes.

> **Draft.** *Star Troopers* is a working title. Apart from the faction
> numbers, every number here is a starting guess, to be tuned with
> headless CPU-vs-CPU games. Questions still open are marked **(open)**.

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
  | **Building** | 2 | 3 | blocks, even from high ground |

- Some cells are **victory hexes** (see Scenarios). Every victory hex
  is a building: a depot, a relay station, something worth holding.
  Holding an objective means holding the best cover on the map, as
  urban terrain was the strongest cover in the original.
- Maps are mirror images top to bottom, reflected across the centre
  row, so in Meeting games neither side has an advantage. (Not rotated
  180°: on this grid a rotated map has no cell at its centre, so it
  couldn't have three victory hexes on its centre line.) Assault maps
  use the same mirrored terrain, but have a defender's half and an
  attacker's half.
- Each squad starts in a deployment zone along its own edge (the three
  rows nearest it). Troopers are placed automatically, mirrored where the
  map is. **(open: let the player place them)**

## Troopers

- Each side fields a squad of troopers from one faction.
- A trooper has:
  - a **pool** of task points, set by its faction;
  - **shock**, starting at 0. Hits add shock. A trooper's usable points
    each turn are `pool − shock`. A trooper whose shock reaches its
    pool is **down** and out of the game;
  - its faction's **Aim** and **Recovery**.
- Each cell holds at most one trooper.

### Factions

Each player picks one at game start. Any pairing is allowed, including
mirror matches.

| Faction | Homage to | Pool | Aim | Recovery | Value |
|---|---|---|---|---|---|
| **Compact** | Humans | 9 | 2 | 3 | 14 |
| **Orrin** | L'Chal Dah | 12 | 2 | 1 | 15 |
| **Vell** | Rame | 6 | 4 | 2 | 14 |

- **The Compact** are middling at everything except bouncing back.
  Recovery 3 is a third of their pool, so a trooper that gets out of
  the line of fire is soon back in the fight.
- **The Orrin** have the deepest pool, so they can do more in a turn
  and take more punishment. But they barely recover, so every hit they
  take sticks around.
- **The Vell** have the smallest pool, and the best Aim by far, which
  makes both their shots and their dodging count double. A Vell that's
  seen and isn't dodging is in trouble.

**Value** is pool + Aim + Recovery, and it's how forces are measured
against each other. A standard squad is **4 troopers**.

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
No single shot can use more than **6 points**, after the original's
limit of 6 points per stage of a turn.

## Shooting

```
attack  = fire points × Aim
defence = cover            (of the cell the target is in when shot)
        + floor(range / 2)
        + floor(cells the target plotted to move / 2)
        + dodge points × Aim
        + 1 if the target is dug in (see Assault)
```

- If `attack < defence`, the shot misses.
- Otherwise it deals `floor((attack − defence) / 3)` shock.
- **Noise (setting, off by default):** when it's on, a shot that didn't
  miss also adds one of −1, 0, 0 or +1 to its shock, chosen at random
  (minimum 0). The average stays the same. Near-threshold shots
  sometimes land and marginal ones sometimes don't, so a dug-in trooper
  is never entirely safe.
- There's no combined fire: every shot is worked out on its own, and
  their shock adds up.

For example, a Compact trooper puts 6 points into a shot (attack 12)
at another standing in the open 4 cells away (range 2). With no dodge,
that's `floor(10 / 3) = 3` shock. If the target had put 2 points into
dodging (+4), it would have taken `floor(6 / 3) = 2`.

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
     points that hasn't fired yet shoots the nearest enemy that moved
     that step and ended it in its line of sight, within 6 cells.
     Enemies standing still don't set it off. All overwatch in a
     step resolves together, at `overwatch points × Aim`, against the
     usual defence. Each trooper's overwatch fires once per turn.
   - **Pinned:** a trooper that takes shock from overwatch stops where
     it is.
   - A trooper that goes down stops and is removed at the end of the
     step.
4. **Recovery:** every trooper still standing removes shock equal to
   its Recovery, hit this turn or not. Over a few turns, a hurt trooper
   that gets out of the line of fire is back in the fight, and the
   Compact, at Recovery 3, bounce back fastest.
5. **Control:** victory hexes change hands (see below).
6. **Win check.**

## Scenarios

### Victory hexes

- A victory hex becomes yours at the end of a turn if one of your
  troopers is on it and no enemy trooper is next to it.
- It stays yours after you leave, until the enemy takes it the same way.
  Holding a hex means taking it and keeping it, not standing on it at
  the right moment.

### Meeting

Equal squads, symmetric map. Three victory hexes on the centre line,
starting neutral.

- Hold all three at the end of a turn to win.
- At the end of turn 12, whoever holds more wins. Equal holdings are a
  draw.

### Assault

One side attacks and the other defends. Either faction can take either
role; you pick yours in settings.

- **The defender** fields a standard squad and starts holding three
  victory hexes in its half. Its troopers start **dug in**: +1 defence
  while they're still in their deployment zone and haven't left it.
- **The attacker** fields the fewest troopers whose total value is at
  least **1.2 ×** the defender's. For example, against 4 Compact (56),
  that's 5 Compact (70) or 5 Orrin (75).
- The attacker wins at the end of any turn in which it holds **two** of
  the three victory hexes. It doesn't need to be stronger everywhere,
  just in the right two places, so the defender has to guess where the
  push is coming.
- The defender wins if turn 12 ends without that.
- **(open: the surplus, somewhere around 1.2–1.5 ×, and the turn
  limit, around 10–14, both tuned headlessly)**

### Elimination

In any scenario, a side with no troopers left loses at once.

## Controls

- **Plotting:** tap one of your troopers. Its pool appears as a row of
  pips, with lost points shown as shock.
  - Drag from the trooper to plot a path. Its cost fills pips as you go.
  - Tap an enemy to aim at it, then use + and − to set fire points. The
    preview sits beside the target.
  - + and − set dodge and overwatch.
- A **Commit** button ends plotting.
- **Watching:** the turn plays back as shots first, then movement step
  by step, with overwatch shots as they happen. A **Replay** button runs
  the last turn again.
- Victory hexes show their owner's colour. The turn counter shows how
  many turns are left.
- Everything on the field is visible, including enemy shock. Only
  orders are secret. **(open: fog of war)**
- Pan by dragging and pinch to zoom, as in Coreward Bound.

## Settings

| Setting | Choices |
|---|---|
| Your faction | Compact, Orrin, Vell |
| Enemy faction | Compact, Orrin, Vell |
| Scenario | Meeting, Assault |
| Your role (Assault) | Attacker, Defender |
| CPU | Easy, Hard |
| Map | Small, Medium, Large |
| Terrain | Open, Some, Dense |
| Noise | Off, On |

## Parameters

| Name | Default | Meaning |
|---|---|---|
| `squad` | 4 | Troopers in a standard squad |
| `rangeStep` | 2 | Cells per +1 defence from range |
| `motionStep` | 2 | Plotted cells moved per +1 defence |
| `damageDivisor` | 3 | Shock = margin ÷ this, rounded down |
| `maxShot` | 6 | Most points in one shot (0 = no cap) |
| `overwatchRange` | 6 | How far overwatch reaches |
| `surplusPct` | 120 | Attacker's value as a percentage of the defender's |
| `holdToWin` | 2 | Victory hexes the attacker needs in Assault |
| `turnLimit` | 12 | Turns before a scenario is decided |
| `noise` | 0 | 0 = off, 1 = ±1 on shots that land |
| `coverScale` | 1 | Tuning: multiplies every cover value |
| `recoverWhenHit` | 1 | Tuning: 0 = only troopers that weren't hit recover |
| `hexTerrain` | building | Tuning: what victory hexes stand on (`building`, `ruins`, `brush`, `open`) |
| `dodgeAimCap` | 0 | Tuning: dodge counts at most this much per point (0 = full Aim) |
| `seed` | random | Same seed and same orders = same game |

## Later

None of this is in the first version, but it's the plan.

- **The Xenos**, homage to the Xenophobes: pool 9, Aim 1, Recovery 1,
  value 11. Bad at everything, and they make up for it with neutron
  bombs and numbers.
- **Neutron bombs** (Xenos only): plot a target cell. The bomb lands at
  the end of movement, may scatter a cell or two, and wrecks whatever it
  hits, leaving a crater. The only defence is not being there.
  **(open: numbers)**
- **Killer Swarm** (Vell only): up to three adjacent Vell merge into a
  single piece that pools their points and acts as one trooper, as in
  the original, where three Rame made a soldier with a pool of 18. It
  can also split again. **(open: how merging and splitting work)**
- **Orbital support.** An Assault attacker has a ship overhead, but only
  on a schedule, when its orbit brings it past:
  - The ship is overhead for 2 turns out of every 5. The first pass
    falls on turn 2, 3 or 4, chosen by the seed, and the whole schedule
    is shown on a turn strip from the start. Both sides know when it's
    coming.
  - During a pass, the attacker can call **one strike**. A trooper
    spends 3 points and picks a target cell in its line of sight.
  - The strike lands at the end of movement, on the target cell and
    the six around it, so anyone who saw it coming has had the turn to
    get clear. It hits every trooper there, the attacker's included, at
    attack 12, against the usual defence without the range term.
  - The game then has a rhythm: the defender spreads out and digs in
    before a pass, and the attacker times its push for one.
- **Breakthrough:** an attacker that must get troopers off the far
  edge.
- **Wildlife:** a neutral predator that attacks whoever's nearest.
- **Fog of war.**
- **Network play against another person,** using the shared network
  play support being built for this repo. Each player is on their own
  device; Fidget Toys games never put two players on one screen, so
  there's no pass-and-play. Simultaneous orders suit this well: each
  side sends only its committed orders for the turn, and both devices
  run the same deterministic turn from them. Neither side sees the
  other's orders until both have committed. **(open: what happens when
  one player is slow to commit, such as a plotting timer)**

## Notes

- **Deterministic core.** As in Dot Army and Coreward Bound, the game
  logic uses integer state and a seeded random generator, and nothing
  else. With simultaneous orders this pays off twice: each side only
  ever needs to send its orders, which makes lockstep network play
  simple, and the headless tuner can run thousands of turns.
- **Tuning.** `node star-troopers/tools/headless.js 100 key=value ...`
  plays CPU-vs-CPU games without a browser and prints win rates, game
  length, how often a single shot takes down an unhurt trooper, how
  often shots can't beat defence, and how often games stall. A comma
  list sweeps a parameter, so `faction0=compact,orrin,vell
  faction1=compact,orrin,vell` plays every pairing. The CPU is crude,
  so these numbers find broken settings, not good ones.
- **Tune the formulas, not the factions.** The faction numbers are the
  original's and stay put. What the original turned into damage with
  dice and a results table, this game does with a fixed formula, and
  that changes the balance. The first draft made everything kill
  everything: a Vell's 6 points at Aim 4 took down a fresh Compact
  trooper in one shot, and games were over by turn 5. Headless runs
  pointed at four changes: the 6-point shot cap and recovery every
  turn (both closer to the original than the first draft was),
  damage divided by 3 rather than 2, and range counting every 2 cells
  rather than 3. That same Vell shot now deals 7, and games run to
  about turn 11.
- **Where balance stands (open).** Measured over 200 CPU-vs-CPU games
  per pairing, half from each side of the map, so each figure is good
  to about ±7 points:
  - With victory hexes as buildings (the default), troopers stand in
    cover 38% of the time instead of 11%. The Orrin beat the Compact
    57% of the time, which is close to even. But the Vell beat the
    Compact 80% of the time, and the Orrin beat the Vell 61%.
  - The Vell problem is dodging. The shot cap limits how hard anyone
    can hit, but nothing limits dodging, and Aim 4 doubles every dodge
    point. A Vell in a building dodging with 3 points is out of reach
    of a Compact's or Orrin's biggest shot (attack 12). The original
    had an answer: the Rame's countermeasures were halved on the
    ground. `dodgeAimCap=2` (dodge counts at most ×2) is the nearest
    thing here, and it brings Vell against Compact to 43%, but then
    the Orrin beat the Vell 85% of the time. At `dodgeAimCap=3` it's
    Orrin 57% against Compact, Vell 58% against Compact and Orrin 73%
    against Vell.
  - Whatever else moves, the Orrin come out on top. Their 12-point
    pool is more of everything, every turn.
  - 80–93% of games run to the turn limit and are settled by hexes
    held. Raising the limit to 16 doesn't change that much.
  - Earlier, the CPU hardly used cover. That wasn't a bug in how it
    judged danger: it was piling onto victory hexes in open ground.
    Victory hexes as buildings, and giving troopers taker and support
    roles, fixed that.
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
- **Homage.** Tom Walczyk's *StarSoldier* (SPI, 1977; developed by
  B.E. Hessel, art by Redmond A. Simonsen) was the tactical volume of
  SPI's StarForce trilogy, alongside StarForce and Outreach. Outreach is
  also what inspired Coreward Bound. Its one big idea, and the reason
  this game exists, is that a soldier's actions and its health are the
  same pool of points. Get hit, and you can do less. Hessel's
  developer's notes, as quoted in a 2018 review: "We do not believe
  that combat results have been expressed in movement costs before."
- **What it borrows:**
  - the task-point pool, with each species rated for Efficiency (our
    Aim) and Recovery;
  - the species' numbers. Humans 9 / 2 / 3, L'Chal Dah 12 / 2 / 1,
    Rame 6 / 4 / 2 and Xenophobes 9 / 1 / 1, as given in Steve List's
    "StarSoldier: Doctrine, Tactics, and Capabilities" (*Moves* #32).
    As List put it, each species "has some weakness, but most have a
    particular strength to make up for it";
  - List's "Specific Tactical Value" (pool + Efficiency + Recovery) as
    the measure of a force, and his 120-to-100 split between the two
    sides of a first-contact scenario as the starting attacker surplus;
  - attack as points spent times Efficiency, against a defence built
    from terrain, range, movement and countermeasures;
  - pre-plotted, simultaneous orders, with opportunity fire;
  - the four-species lineup, under our own names, with the Rame's
    Killer Swarm and the Xenophobes' neutron bombs planned for later.
- **What changed from the 1977 game:**
  - The computer does the bookkeeping. Tracking points and writing
    orders was what reviewers complained about most.
  - Four tasks instead of the original's longer list (grounding,
    altitude, launched weapons, search and so on).
  - Damage is a third of the margin by which attack beats defence,
    with optional ±1 noise, instead of dice and a results table.
  - Single-stage turns, with a 6-point cap per shot in place of the
    original's 6 points per stage.
  - Shots happen before anyone moves, from where everyone starts.
    Overwatch is the only fire during movement, and a hit pins.
  - No heavy-weapons troopers, androids or support platforms.
  - Victory hexes held at a deadline, instead of the original's
    victory points for casualties inflicted.
  - Orbital support, when it arrives, belongs to the attacker's role
    and only works when the ship is overhead.
