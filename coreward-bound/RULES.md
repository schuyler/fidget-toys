# Coreward Bound — Rules (draft)

Two civilizations spread across a spiral galaxy by jumping their fleets
from star to star. Jumps are instant but inaccurate: the farther you
jump, the more likely you are to land somewhere you didn't mean to go,
and a fleet that strays too far from home can be lost for good. At the
centre of the galaxy lie relics of some older civilization. Bring three
of them home, or wipe out your rival, to win.

Turn-based. You play one civ; the CPU plays the other. Built so that more
civs and network play can be added later.

> **Draft.** Every number here is a starting guess, to be tuned with
> headless CPU-vs-CPU games. Questions still open are marked **(open)**.

## The galaxy

- A scrollable hex map shaped like a two-armed spiral galaxy. The layout
  is point-symmetric (rotated 180° about the centre), so neither civ has
  an advantage. Each civ starts at the outer end of one arm.
- Every hex is one of:
  - **Arm core:** rich. Potential value 3–5.
  - **Arm edge:** middling. Potential value 1–3.
  - **Void:** the space between arms. Potential value 0–1.
  - **Nucleus:** the dense centre. Can't be settled. A jump into or out
    of the nucleus that scatters destroys the stack.
  - **Core:** the three hexes at the very centre. Nucleus rules apply,
    and each one holds a relic.
- **Beacons:** a few very bright stars, marked on the map. Jumps aimed at
  a beacon hex are more accurate.
- **Dust:** some hex edges are dust lanes. Dust blocks line of sight, and
  you can only jump across a dust edge to an adjacent hex or from one of
  your own (or an allied) settlements to another.
- **Potential values are hidden.** A hex's value is revealed to you the
  first time one of your stacks lands in it. Your rival learns it only by
  going there too.

## Pieces

- **Fleets** are the basic unit: ships, but also people. You spend them
  to found and grow settlements and to do research, so every fleet is a
  choice between strength and growth.
  - Fleets in the same hex form one **stack**.
  - You see your rival's stacks, but not their exact size. A stack shows
    as one of: 1, 2–3, 4–6, 7+.
- **Settlements** are permanent. They're never moved or destroyed, but
  they can change hands.
  - A settlement's **value** starts at 0 and can be raised to the hex's
    potential.
  - Each turn it produces resources (RP) equal to its value.
  - It anchors your jumps (see below).

## Jumping

On your turn you can jump each stack once. A jump goes straight to the
target hex without crossing the space in between.

- **Safe range** = 2 + your Reach techs, in hexes.
- **Chaining:** a stack that lands *on target* within safe range at one
  of your own (or an allied) settlements may jump again. Inside a
  connected network of settlements a stack can travel any distance in
  one turn.
- **Over-range jumps** are allowed only *from* your own settlement. They
  scatter more often and more severely, and always end the stack's move.
- Landing anywhere else ends the stack's move.
- **Splitting:** before jumping, you can split off part of a stack. The
  part that stays behind can't jump this turn.

### Scatter

A jump of 1 hex never scatters. For longer jumps, roll a die:

```
roll = d6 + Focus techs
          + 1 if the target is your own or an allied settlement
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
  map, in the nucleus, or somewhere with no clear line of sight to any
  of your settlements. **Exception:** a jump aimed at your own
  settlement is never lost, though it can still scatter.
- **Preview:** before you confirm a jump, the game shows the exact odds
  of landing on target and the ring of hexes you might scatter to,
  marking any where you'd be lost. Scatter is a risk you choose, never a
  surprise.

## Contact and stances

- Two civs are **in contact** when any of their stacks or settlements
  share a hex or sit next to each other.
- Each civ holds a **stance** toward each other civ: **Cooperate**,
  **Neutral** or **Hostile**. Everyone starts Neutral.
- You can change your stance only while you're in contact. Changes are
  chosen secretly and revealed together, and they last until changed
  again.
- The pair of stances decides what each side may do:

| You | Them | Effect |
|---|---|---|
| Cooperate | Cooperate | **Allied.** Each can chain-jump through the other's settlements and gets the settlement bonus when aiming at them. Neither can attack the other. Tech sharing is open. |
| Cooperate | Neutral | They can use your settlements as if allied; you can't use theirs. Neither can attack. |
| Neutral | Neutral | Either side may attack the other. |
| Hostile | Neutral | You may attack at +1. |
| Hostile | Cooperate | You may attack at +2, and they can't hit back. Betrayal pays. |
| Hostile | Hostile | Fighting is mandatory wherever you meet. |

## Combat

Combat happens in a hex holding stacks of two civs, when one is allowed
to attack (see the table) and chooses to.

```
strength = fleets + Force techs (+1 when defending at your own settlement)
hits     = floor(strength * (d6 + stance bonus) / 10), minimum 1
```

- Both sides roll and deal hits at the same time, unless the defender
  was Cooperating against a Hostile attacker, in which case only the
  attacker deals hits.
- Each hit destroys one fleet.

### Taking settlements

- An enemy settlement with no defending fleets can be **flipped** by a
  stack that's allowed to attack its owner.
- The attempt succeeds if `d6 + fleets + Force techs >= settlement value + 4`.
- A flipped settlement becomes yours, with its value lowered by 1
  (minimum 0).
- **Conquest roll:** each successful flip also rolls for a tech. On a 5
  or 6 you copy one random tech of the loser's that you don't already
  have. Relics can't be taken this way.

## Techs

Each tech has a name and belongs to one of four types. A tech's only
effect is +1 to its type, and techs of the same type stack.

| Type | Effect of each tech |
|---|---|
| **Reach** | +1 safe range |
| **Focus** | +1 to scatter rolls |
| **Industry** | +1 fleet you can build per settlement per turn |
| **Force** | +1 strength in combat and when flipping settlements |

There's no tech tree and no prerequisites.

- **Research:** spend fleets at one of your settlements, and the cost
  rises as you learn more:

  ```
  cost = 2 + floor(techs known / 3) fleets
         - 1 if your rival already knows the tech
  ```

  You draw two named techs you don't know and keep one.
- **Sharing:** allied civs in contact can share techs. Sharing copies
  the tech, so both sides keep it. Trades can be uneven: a tech for a
  tech, or a tech for RP.
- The names are pure flavour, about 6 per type, drawn from the setting's
  idea of jumping by trained clairvoyance: *Choral Navigation*,
  *Anchor Songs*, *Long Sight*, *Borrowed Memory*, *Lattice Dreaming*,
  *The Patient Map*, and so on.

## Relics

- Each core hex holds one relic. A stack that lands in a core hex picks
  up its relic straight away.
- A stack carrying a relic must reach one of your settlements to deliver
  it.
  - If the stack is destroyed in combat, the relic drops in that hex for
    anyone to pick up.
  - If the stack is lost in space, the relic returns to its core hex.
- A **delivered relic** counts as a tech that gives +1 to all four types,
  and it counts toward a relic win.
- Delivered relics can't be shared, traded or taken by conquest.
- Three turns after a relic leaves its core hex, a new one appears there.

## A turn

Turn order alternates: civs take turns going first.

1. **Jumps:** each civ in turn order jumps any of its stacks.
2. **Reserve jump:** in reverse turn order, each civ may jump one stack
   that didn't move this turn, within safe range. Use it as a reaction
   force. **(open: cut this if it feels like one phase too many)**
3. **Stances:** civs in contact may change stances, secretly and all at
   once.
4. **Combat**, then **taking settlements**.
5. **Income and upkeep:**
   - Gain RP equal to the total value of your settlements.
   - Pay 1 RP for each fleet beyond the first in any one hex. Fleets you
     can't pay for are lost.
6. **Build**, using fleets that began this phase in the hex where
   they're spent:
   - **New fleet:** 3 RP, at a settlement of value 1 or more. You can
     build up to 1 + Industry per settlement per turn.
   - **Found a settlement:** spend 2 fleets in a hex whose potential
     you've seen and that has no settlement. The new settlement has
     value 0.
   - **Grow:** spend 1 fleet per +1 value, up to the hex's potential.
     You can't grow a settlement in the turn it was founded, and you
     can't build fleets there in a turn you grow it.
   - **Research:** see Techs.
7. **Win check.**

## Winning

- **Relic win:** deliver three relics.
- **Elimination:** a civ with no settlements is out, along with all its
  fleets. The last civ standing wins.

The relic win rewards both the risky dash to the core and the patient
build-out of a settlement network that makes the trip safe.

## Start

- Each civ starts with:
  - one home settlement of value 3, at the end of its arm;
  - 3 fleets and 3 RP;
  - no techs.
- Home hexes and the hexes around them are revealed to their owner.

## Controls

- **Pan** by dragging, **pinch** to zoom, and **double-tap** to recenter
  on home.
- **Jumping:** tap a stack, tap a target, and the scatter preview
  appears; tap again to confirm.
- **Settlement actions:** tap one of your settlements to build, grow or
  research there.
- An **End turn** button.
- During the CPU's turn the camera visits each place where something
  happened. Arrows at the screen edge point to threats you can't see.

## Notes

- **Deterministic core.** As in Dot Army, the game logic uses integer
  state and a seeded random generator, and nothing else. That gives
  replays and headless tuning, and later lockstep network play.
- **What changed from the 1976 game that inspired this:**
  - Tech comes from choices, not a random roll every turn.
  - Each tech does one small thing, instead of one "level" feeding every
    system.
  - Relics are the only big prize.
  - There are no random disasters.
  - Scatter odds are always shown before you commit.
- **(open)** Map size, number of beacons, and how much dust.
