# Coreward Bound — Rules

Two civilizations spread across a spiral galaxy by jumping their fleets
from star to star. Jumps are instant but inaccurate: the farther you
jump, the more likely you are to land somewhere you didn't mean to go,
and a fleet that strays too far from home can be lost for good. At the
centre of the galaxy lie relics of some older civilization. Bring three
of them home, or take every one of your rival's settlements, to win.

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
  - **Arm core:** rich. Potential value 3–5.
  - **Arm edge:** middling. Potential value 1–3.
  - **Void:** the space between arms. Potential value 0–1.
  - **Nucleus:** every hex within 2 of the centre. Can't be settled. A
    jump into or out of the nucleus that scatters destroys the stack.
  - **Core:** three hexes in a line through the centre. Nucleus rules
    apply, and each one holds a relic.
- **Beacons:** two very bright stars on each arm. Jumps aimed at a
  beacon hex get +1.
- **Dust lanes** run along stretches of the arms' edges, between the arm
  and the void. Dust blocks line of sight. A jump whose straight line
  crosses a dust edge is allowed only if it's one hex long, or goes from
  one of your settlements to another.
- **Potential values are hidden.** A hex's value is revealed to you the
  first time one of your stacks lands in it. Your rival learns it only by
  going there too.
- The nucleus blocks line of sight through it (not into or out of it).

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
  of your own settlements may jump again. Inside a connected network of
  settlements a stack can travel any distance in one turn.
- **Over-range jumps** are allowed only *from* your own settlement. They
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
  map, in the nucleus, or somewhere not in sight of any of your
  settlements. In sight means within **sight range** (5 + Reach) and with
  a clear line of sight. A stack whose losses use up all its fleets is
  gone too.
- **Exception:** a jump aimed at your own settlement is never lost to
  the map edge, the nucleus or sight. It falls short of the edge or the
  nucleus instead. It can still lose fleets. (A jump out of the nucleus
  that scatters is fatal regardless.)
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
- A stack carrying relics that's destroyed drops them in that hex.

### Taking settlements

- A stack in a rival settlement with no defending fleets tries to
  **take** it: when it arrives, and again at the start of each of its
  owner's turns while it stays.
- The attempt succeeds if `d6 + fleets + Force >= settlement value + 4`.
- A settlement with a rival stack in it is **besieged**: it produces no
  RP and nothing can be built there.
- A taken settlement becomes yours, with its value lowered by 1
  (minimum 0).
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

## Relics

- Each core hex starts with one relic.
- A stack that lands in a hex with a relic and **holds it through the
  rival's turn** picks it up at the start of its owner's next turn. The
  rival gets one turn to knock it out.
- A stack carrying a relic must reach one of your settlements (that
  isn't besieged) to deliver it. Founding a settlement where the carrier
  stands counts.
  - If the stack is destroyed in combat, the relic drops in that hex.
    Anyone can pick it up the same way: hold the hex for a turn.
  - If the stack is lost in space, the relic returns to the core.
- A **delivered relic** counts as a tech that gives +1 to all four types,
  and it counts toward a relic win.
- Delivered relics can't be shared, traded or taken by conquest.
- Three rounds after a core hex's relic is picked up, a new one appears
  there.

## A turn

Civs take whole turns, one after the other. You go first; the CPU starts
with 1 extra RP to make up for it.

At the start of your turn:

1. Relics in core hexes appear (once per round).
2. **Income and upkeep:** gain RP equal to the total value of your
   settlements that aren't besieged. Pay 1 RP for each fleet beyond the
   third in any one hex. Fleets you can't pay for are lost, from your
   biggest stacks.
3. Stacks holding a relic's hex pick it up.
4. Stacks in rival settlements try again to take them.

Then, in any order:

- **Jump** fleets.
- **Build**, using only fleets that began the turn in the hex (fleets
  that jumped in this turn have to wait until next turn):
  - **New fleet:** 3 RP, at a settlement of value 1 or more. Up to
    1 + Industry per settlement per turn. A new fleet can't jump until
    next turn.
  - **Found a settlement:** spend 2 fleets in a hex whose potential
    you've seen and that has no settlement. The new settlement has value
    1 (or 0 if that's the hex's potential).
  - **Grow:** spend 1 fleet for +1 value, up to the hex's potential. You
    can't grow a settlement in the turn it was founded, and you can't
    build fleets at a settlement in a turn you grow it (or grow it in a
    turn you built there).
  - **Research:** see Techs.

Then end your turn.

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

- **Pan** by dragging, **pinch** or scroll to zoom. **Home** recentres
  on your home; **Next stack** cycles through stacks that can still
  jump.
- **Jumping:** tap a stack (blue hexes are in safe range, gold ones over
  range), use − and + to choose how many fleets to send, tap a target
  to see the odds and scatter preview, then tap it again or press Jump.
- **Settlement actions:** tap one of your settlements to build, grow or
  research there. Tap a stack on an empty hex to settle it.
- **End turn.** It pulses when every stack has moved.
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

## Later

- **Stances** (more civs, or network play, make these matter): each civ
  holds a stance toward each other civ, **Cooperate**, **Neutral** or
  **Hostile**. Everyone starts Neutral. You can change your stance only
  while in contact (stacks or settlements in the same or neighbouring
  hexes). Changes are chosen secretly and revealed together.

  | You | Them | Effect |
  |---|---|---|
  | Cooperate | Cooperate | **Allied.** Each can chain-jump through the other's settlements and gets the settlement bonus when aiming at them. Neither can attack the other. Tech sharing is open. |
  | Cooperate | Neutral | They can use your settlements as if allied; you can't use theirs. Neither can attack. |
  | Neutral | Neutral | Either side may attack the other. |
  | Hostile | Neutral | You may attack at +1 to your combat rolls. |
  | Hostile | Cooperate | You may attack at +2, and they can't hit back. Betrayal pays. |
  | Hostile | Hostile | Fighting is mandatory wherever you meet. |

- **Tech sharing:** allied civs in contact can share techs. Sharing
  copies the tech, so both sides keep it. Trades can be uneven: a tech
  for a tech, or a tech for RP.
- **Network play**, by lockstep as in Dot Army. The simulation is
  already deterministic and every move is an action (`act` in
  `src/sim.js`), so a turn can be sent as its list of actions.
- **(open)** Whether the relic snowball (+1 to everything) needs a
  brake, and whether games are long enough. CPU games end in about 11
  rounds.
- **(open)** Map size, number of beacons, and how much dust.

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
