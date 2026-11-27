# Coreward Bound — Rules

Two civilizations spread across a spiral galaxy by jumping their fleets
from star to star. Jumps are instant but inaccurate: the farther you
jump, the more likely you are to land somewhere you didn't mean to go,
and a fleet that strays too far from home can be lost for good. At the
centre of the galaxy lie relics of some older civilization. Carry three
of them back to your settlements, or take every one of your rival's
settlements, to win.

Turn-based. You play one civ; the CPU plays the other. Built so that more
civs and network play can be added later (see Later).

> **First version.** Every number here is a starting guess, tuned only
> with headless CPU-vs-CPU games (`tools/headless.js`). The tuning knobs
> live in `DEFAULTS` in `src/sim.js`. Questions still open are marked
> **(open)**.

## The galaxy

- A hex map shaped like a two-armed spiral galaxy, generated from the
  game's seed. Small, medium and large galaxies have a radius of 10, 12
  and 14 hexes.
- The layout is point-symmetric (turned 180° about the centre), so
  neither civ has an advantage. Each civ starts at the outer end of one
  arm.
- Every hex is one of:
  - **Arm:** rich. Potential value 3–5.
  - **Periphery:** the arm's fringe. Potential value 1–3.
  - **Void:** the space between arms. Worth nothing and can't be
    settled, though stacks can jump through it and stand in it.
  - **Core:** every hex within 2 of the centre. Can't be settled. A
    jump into or out of the core that scatters destroys the stack, and
    the core's glare destroys fleets that end a turn there (see The
    core). Relics appear on the centre hex and the six around it.
- **Beacons:** two very bright stars on each arm. Jumps aimed at a
  beacon hex get +1.
- **Dust lanes** run along stretches of the periphery, between the arm
  and the void. Dust blocks line of sight. A jump whose straight line
  crosses a dust edge is allowed only if it's one hex long, or goes from
  one of your settlements to another.
- **Potential values are hidden.** A hex's value is revealed to you the
  first time one of your stacks lands in it. Your rival learns it only by
  going there too.
- The core blocks line of sight through it (not into or out of it).

## Pieces

- **Fleets** are the basic unit: ships, but also people. You spend them
  to found and grow settlements and to do research, so every fleet is a
  choice between strength and growth.
  - Fleets in the same hex form one **stack**.
  - You see your rival's stacks, but not their exact size. A stack shows
    as one of: 1, 2–3, 4–6, 7+. The CPU sees yours the same way.
- **Settlements** are permanent. They're never moved or destroyed, but
  they can change hands.
  - A settlement's **value** can be raised to the hex's potential.
  - Each turn it produces resources (RP) equal to its value.
  - It anchors your jumps (see below).

## Jumping

On your turn each fleet can jump once. A jump goes straight to the target
hex without crossing the space in between. You can split a stack and
send its fleets to different places.

- **Safe range** = 2 + Reach, in hexes.
- **Chaining:** fleets that land *on target*, within safe range, at one
  of your own settlements may jump again. A settlement founded or taken
  this turn doesn't count until your next turn. Inside a connected network of
  settlements a stack can travel any distance in one turn.
- **Over-range jumps** are allowed only *from* your own settlement (not
  one founded or taken this turn). They
  scatter more often and more severely, and always end the move.
- Landing anywhere else ends the move.
- A stack carrying a relic never chains.

### Scatter

A jump of 1 hex never scatters. For longer jumps, roll a die:

```
roll = d6 + Focus
          + 1 if the target is your own settlement
          + 1 if the target is a beacon
          - 2 if the jump is over range

need = 2 + floor(distance / 3)
```

- If `roll >= need`, the stack lands on target.
- Otherwise it **scatters**:
  - It lands `need - roll` hexes away from the target, in one of six
    random directions.
  - It loses one fleet for every 2 hexes of scatter (rounded down).
    Losses double on an over-range jump.
- **Lost in space:** a scattered stack is destroyed if it lands off the
  map, in the core, or somewhere not in sight of any of your
  settlements. In sight means within **sight range** (5 + Reach) and with
  a clear line of sight. A stack whose losses use up all its fleets is
  gone too.
- **Exception:** a jump aimed at your own settlement is never lost to
  the map edge, the core or sight. It falls short of the edge or the
  core instead. It can still lose fleets. (A jump out of the core that
  scatters is fatal regardless.)
- **Preview:** before you confirm a jump, the game shows the exact odds
  of landing on target and every hex you might scatter to, marking any
  where you'd be lost. Scatter is a risk you choose, never a surprise.

## Combat

Combat happens when a stack lands in a hex holding a rival stack, on
target or by scattering. It's fought to the finish:

```
strength = fleets + Force (+1 when defending at your own settlement)
hits     = floor(strength * d6 / 10), minimum 1
```

- Both sides roll and deal hits at the same time, round after round,
  until one side (or both) is gone. Each hit destroys one fleet.
- A stack carrying a relic that's destroyed drops it in that hex.

### Taking settlements

- A stack in a rival settlement with no defending fleets tries to
  **take** it: when it arrives, and again at the start of each of its
  owner's turns while it stays.
- The attempt succeeds if `d6 + fleets + Force >= settlement value + 4`.
- A settlement with a rival stack in it is **besieged**: it produces no
  RP and nothing can be built there.
- A taken settlement becomes yours, with its value lowered by 1
  (minimum 0). Like a new one, it isn't working until your next turn:
  it can't build or grow, anchor chain or over-range jumps, or take
  delivery of a relic.
- **Conquest roll:** each successful take also rolls for a tech. On a 5
  or 6 you copy one random tech of the loser's that you don't already
  have. Relics can't be taken this way.

## Techs

Each tech has a name and belongs to one of four types. A tech's only
effect is +1 to its type, and techs of the same type stack.

| Type | Effect of each tech |
|---|---|
| **Reach** | +1 safe range and +1 sight range |
| **Focus** | +1 to scatter rolls |
| **Industry** | +1 fleet you can build per settlement per turn |
| **Force** | +1 strength in combat and when taking settlements |

There's no tech tree and no prerequisites.

- **Research:** two named techs you don't know are on offer. They stay
  on offer until you research one; then a new one is drawn. Pay in
  fleets at one of your settlements:

  ```
  cost = 2 + floor(techs known / 3) fleets
         - 1 if your rival already knows the tech
  ```

- The names are pure flavour, six per type, drawn from the setting's
  idea of jumping by trained clairvoyance: *Choral Navigation*, *Anchor
  Songs*, *Long Sight*, *Borrowed Memory*, *Lattice Dreaming*, *The
  Patient Map*, and so on.

## The core

- At the end of your turn, every one of your fleets in the core rolls a
  d6 and is destroyed on a 1, whether it moved this turn or not.
- A stack wiped out this way drops its relic where it stood.
- The danger of getting there is separate: a jump into or out of the
  core that scatters destroys the stack.

## Relics

- Three relics are on the board at the start: on the centre hex and on
  two opposite hexes next to it.
- A stack that lands in a hex with a relic and **holds it through the
  rival's turn** picks it up at the start of its owner's next turn. The
  rival gets one turn to knock it out.
- **A stack carries one relic at most.** It picks up one at a time and
  leaves any others lying there, and a stack already carrying one can't
  pick up another. Whoever jumps carries the relic with them. A jump that
  would put two of your relics in one hex isn't allowed, unless it's into
  one of your settlements (not one founded or taken this turn), where the
  relic is delivered on arrival.
- A stack carrying a relic must reach one of your settlements (that
  isn't besieged, and wasn't founded or taken this turn) to deliver it.
  - Founding a settlement where the carrier stands, or taking one, works
    too: the relic is delivered at the start of your next turn if the
    carrier is still there. Founding or researching can't spend a
    carrier's last fleets.
  - If the stack is destroyed in combat or by the core's glare, the
    relic drops in that hex. Anyone can pick it up the same way: hold the
    hex for a turn.
  - If the stack is lost in space, the relic goes back to a free hex at
    the centre, or waits for one to come free.
- A **delivered relic** counts as a tech that gives +1 to all four types,
  and it counts toward a relic win.
- Delivered relics can't be shared, traded or taken by conquest.
- **Respawns.** Three rounds after a relic is picked up, a new one
  appears on a random hex among the centre and the six around it, never
  where a stack stands or a relic already lies. If none is free, it waits
  for one. A relic that comes back onto the board (dropped, or lost in
  space) cancels a pending respawn, so there are normally three relics
  out there.

## A turn

Civs take whole turns, one after the other. You go first; the CPU starts
with 1 extra RP to make up for it.

At the start of your turn:

1. Pending relics appear (once per round).
2. Carriers at your settlements deliver their relics.
3. **Income and upkeep:** gain RP equal to the total value of your
   settlements that aren't besieged. Pay 1 RP for each fleet beyond the
   third in any one hex. Fleets you can't pay for are lost, from your
   biggest stacks.
4. Stacks holding a relic's hex pick one up.
5. Stacks in rival settlements try again to take them.

Then, in any order:

- **Jump** fleets.
- **Build**, using only fleets that began the turn in the hex (fleets
  that jumped in this turn have to wait until next turn):
  - **New fleet:** 3 RP, at a settlement of value 1 or more, not founded
    or taken this turn. Up to
    1 + Industry per settlement per turn. A new fleet can't jump until
    next turn.
  - **Found a settlement:** spend 2 fleets in a hex whose potential
    you've seen and that has no settlement, outside the void and the
    core. Fleets that jumped in this turn can found it straight away. The new settlement has value
    1 (or 0 if that's the hex's potential).
  - **Grow:** spend 1 fleet for +1 value, up to the hex's potential. You
    can't grow a settlement in the turn it was founded, and you can't
    build fleets at a settlement in a turn you grow it (or grow it in a
    turn you built there).
  - **Research:** see Techs.

Then end your turn. Your fleets in the core roll for the glare.

## Winning

- **Relic win:** deliver three relics.
- **Elimination:** a civ with no settlements is out, along with all its
  fleets. The last civ standing wins.
- **Time:** after 60 rounds, the civ with more relics wins, then the one
  with more total settlement value. Equal is a draw. CPU games never get
  near this.

## Start

- Each civ starts with:
  - one home settlement of value 3 (potential 5), at the end of its arm;
  - 4 fleets and 3 RP;
  - no techs, and two on offer.
- Home hexes and the hexes around them are revealed to their owner.

## Controls

- **Pan** by dragging, **pinch** or scroll to zoom. At the start of your
  turn the map fits your settlements and stacks. **Home** recentres on
  your home. **Next** visits each stack and settlement that can still do
  something (jump, settle, build, grow, research) that you haven't looked
  at this turn; it goes grey, and End turn pulses, once you've seen them
  all.
- **Jumping:** tap a stack (blue hexes are in safe range, gold ones over
  range), use − and + to choose how many fleets to send, tap a target
  to see the odds and scatter preview, then press Jump. Tapping the
  target again cancels the aim. Selecting a stack moves the map just
  enough to show where it can reach; aiming never moves it.
- **Settlement actions:** tap one of your settlements to build, grow or
  research there. Tap a stack on an empty hex to settle it.
- **Status bar:** for each side, banked RP (coin), techs researched
  (flask) and relics delivered (◆ n/3). Tap either side to compare the
  two civs' tech levels.
- **End turn.** It pulses when you've seen everything that can still act.
- During the CPU's turn the camera follows its jumps if they're off
  screen. Arrows at the screen edge point to rival stacks near your
  settlements that you can't see.

## Changes from the draft

What the first playable version does differently from the draft rules,
and why:

- **Whole turns, one civ after the other**, instead of both civs
  jumping in one shared phase and then building together. Against a CPU
  that's simpler to follow and needs one button, not two. The **reserve
  jump** (marked open in the draft) is gone: with whole turns there's no
  phase for it to react in.
- **Stances and tech sharing aren't in yet.** With two civs and no
  diplomacy, it plays as Neutral/Neutral: either side can attack. See
  Later.
- **Relics must be held through the rival's turn.** In CPU tests,
  instant pickup let whoever reached the core first deliver all three
  relics in two rounds while the other side watched. Holding the hex
  gives the rival one turn to strike. Relic carriers also can't chain:
  otherwise one stack delivered and dashed back to the core every turn.
- **Combat is fought to the finish**, rather than one exchange a turn.
  With whole turns, a fight left half done would leave both stacks
  sharing a hex until someone's next turn.
- **Lost in space needs a sight range.** The draft's line-of-sight-only
  rule meant almost nothing was out of sight. "Strays too far from home"
  now means more than 5 hexes (+ Reach) from your nearest settlement.
- **Upkeep starts after the third fleet in a hex**, not the first. As
  drafted, the 3 starting fleets cost 2 of the home's 3 RP, and nothing
  grew.
- **New settlements have value 1, and you start with 4 fleets.** A
  value-0 settlement needed another fleet and another turn before it did
  anything.
- **Splitting doesn't freeze the fleets left behind.** Each fleet jumps
  once (or chains), so sending two to settle and three to scout is
  allowed.
- **The research offer persists**, and the cost discount applies per
  tech, so you see both costs before choosing and can't re-roll the
  offer by backing out.
- **Taking a settlement** happens on arrival and then each turn you stay,
  rather than in a separate phase.
- **Turn limit** of 60 rounds, so a stalemate ends.

After the first playtests:

- **The core is dangerous to stay in.** The CPU won early by sitting in
  the core and carrying relics out, and the player won by doing the same.
  Fleets that end a turn there now risk the glare, moved or not (a rule
  only for stacks that stayed put could be dodged by hopping one hex,
  which never scatters).
- **Relics appear around the centre, never under a stack.** The old three
  fixed relic hexes let a stack wait for a relic to reappear under it.
- **One relic per stack.** The player won by carrying two out at once.
- **Settle on arrival.** Waiting a turn to found was tedium with little
  point. To keep a new settlement from becoming an instant road or
  delivery point, it doesn't work until your next turn.
- **Voids can't be settled.**
- **Names.** Nucleus is now the core, arm core is the arm, arm edge is
  the periphery; the old "core" relic hexes are gone.

## Later

Ideas that came up and were set aside, including stances, tech sharing,
network play and more civs, are in [IDEAS.md](IDEAS.md).

## Notes

- **Deterministic core.** As in Dot Army, the game logic uses integer
  state and a seeded random generator, and nothing else. The spiral is
  drawn by an integer turtle walk, not trigonometry, so every device
  builds the same galaxy from the same seed. That gives replays and
  headless tuning, and later lockstep network play.
- The CPU sees what a player sees: potentials only where it has been,
  your stacks only as bands. It acts only through the same actions you
  do.
- **What changed from the 1976 game that inspired this:**
  - Tech comes from choices, not a random roll every turn.
  - Each tech does one small thing, instead of one "level" feeding every
    system.
  - Relics are the only big prize.
  - There are no random disasters.
  - Scatter odds are always shown before you commit.
