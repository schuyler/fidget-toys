# Coreward Bound — Ideas not in the game yet

Rules and features that came up in playtesting and were set aside, so they
don't get lost or re-argued from scratch. None of this is in the game.
Each entry says what it would fix and what we know about it, which is
often not much: most of these are untested. The rules that are in the game
are in [RULES.md](RULES.md).

The playtest that started this list: the CPU raced for the core, the
player raced back, and nobody fought. In 40 headless CPU games before
these changes, 100% ended by relics in about 10 rounds, the civ that
delivered the first relic won 95% of them, and only 7% of arm and
periphery hexes were ever visited.

## Economy

- **Supply upkeep.** Fleets standing in your own settlements are free
  (up to the usual 3 per hex); every fleet anywhere else costs 1 RP a
  turn. If you can't pay, fleets out of supply are lost first. Makes core
  runs and long expeditions cost money while garrisons and a network that
  creeps coreward don't. This is the upkeep rule the owner had in mind;
  postponed to measure the core hazard on its own first.
- **Flat upkeep, 1 RP per fleet.** Rejected for now. With a value-3 home
  and 4 starting fleets you'd be short from the first turn (the draft had
  nearly this rule and nothing grew). It also taxes big stacks, which are
  what fighting needs, more than it taxes a race, which needs few fleets.
- **An economic win.** The first civ to reach some total settlement value
  wins. A second road to victory rather than a tax on the first. Needs a
  number, and a CPU that knows to chase it.

## Relics

- **Homeward carrier chain.** Relics can only be delivered at your home,
  but a carrier may chain-jump through your settlements. A connected
  network from the core to your home delivers in one turn; without one
  you walk. Taking a settlement in the middle of a rival's chain cuts
  their road. Rewards exactly the expansion the race skips, and gives
  fights a point. Pairs well with supply upkeep.
- **Delivery only at your home, with no chaining.** Considered and
  rejected: carriers can't chain, so the trip from the core to the end
  of an arm is 4–6 risky single jumps.
- **Relics don't give techs.** Today a delivered relic is +1 to all four
  tech types, so the leader gets stronger and, through Focus, safer in
  the core. That 95% first-deliverer win rate is the snowball. Easy to
  measure: add a switch to `DEFAULTS` and sweep it with `tools/headless.js`.
- **Relics give everything except Focus.** A milder version: the core
  stays dangerous for the leader.
- **One relic on the board at a time.** Should slow the race a lot
  (untested). The game keeps three at once for now.
- **Are games long enough?** Still about 11 rounds in CPU games, almost
  all ended by relics.
- **Floor relics at your own settlement deliver themselves.** A relic
  lying in one of your working settlements (dropped by a carrier killed
  attacking it, or by the core hazard during a siege) is delivered at
  the start of your turn. Today a stack has to arrive and hold the hex.
- **Respawn timing.** A relic picked up by the second player comes back
  after about 2.5 rounds, by the first player after 3, because the timer
  ticks at the start of each round. Old quirk; harmless so far.
- **A cap on relic supply.** A relic that comes back to the board when
  no respawn is pending can make four in play. A cap would need its own
  bookkeeping.
- **The respawn pause.** A relic's countdown pauses while a stack sits
  on its hex. Superseded by "never appears on an occupied hex", which
  does the same job without a timer that stops.
- **More starting layouts.** Relics start on the centre and an opposite
  pair of its neighbours, to keep the galaxy fair; that's only three
  layouts.

## The core

- **Hazard: a third of the stack on a 1–2.** The first version proposed.
  Averages a ninth of a stack a turn, but swings harder than the per-fleet
  roll the game uses.
- **Hazard only for stacks that didn't move.** Rejected: a camper hops one
  hex to the next core hex each turn, which can't scatter, and never pays.

## Settlements

- **Taken settlements work at once.** Only newly founded settlements
  would wait a turn. Today a settlement taken this turn waits too: no
  building, chaining or delivery until its new owner's next turn.
- **No research at a new settlement.** Research is still allowed with
  fleets that began the turn there.
- **CPU research pace.** The CPU researches on a schedule: one more tech
  every 4 rounds on Hard, every 7 on Easy. Easy can look like it isn't
  researching at all.

## Neutrals

- **Autonomous forces.** Borrowed from Outreach, which is also where the
  stance table under "More players" came from. Exploring a hex nobody has seen
  can turn up a neutral force: a few star gates and fleets placed in and
  around that hex. It sits still until it meets someone. Its stance
  toward each civ is rolled at first contact, not chosen; attacking it
  makes it Hostile toward you; while Hostile it grows (in Outreach, one
  fleet for every two star gates it holds). An allied neutral lets you chain
  through its hexes, as allied settlements do. Would put risk and reward
  in the arms, which today are empty, and give fights a reason to happen
  away from the core.

  What Outreach does, from the one copy of the rules found (a third-party
  reproduction of rules 1.0–19.0 on
  [RulesPal](https://rulespal.com/outreach/rulebook); the charts are
  missing, so none of the odds are known):
  - Neutrals come from the Fate Table, rolled when a hex is explored:
    results G–J make one of 2–5 star gates and 5–12 fleets, face down.
    At most four are on the board at once. That's the random "disasters"
    table this game left out (RULES.md).
  - A neutral never moves, attacks or raises fleets until it has had
    contact with a player.
  - With no CPU, the first player to reach one moves it, as its
    "caretaker".
  - When you change your stance toward anyone, neutrals in contact with
    you may re-roll theirs toward you (the "domino effect").
  - The rules don't say what defeating one gives you. They mention
    "neutral settled hexes" whose allegiance can be won, but never
    explain them.

  What this game would need of its own: a small routine to run neutrals
  (there's no human caretaker against the CPU), odds for finding one, a
  reward for beating one (its settlements? RP? a tech?), and the stances,
  which aren't in the game yet either, unless neutrals get a simpler
  friendly/hostile switch.

## More players

- **Three or six civs.** A hex grid only maps onto itself under
  rotations by 60°, so a spiral with three arms (120°) or six (60°) gives
  every civ the same arm. Four can't be exactly fair. More civs would put
  rivals on neighbouring arms and make the core a crowd.
- **Network play** through the `multiplayer/` library, which already runs
  Dot Army online by lockstep. The simulation is deterministic and every
  move is an action (`act` in `src/sim.js`), so a turn can be sent as its
  list of actions.
- **A CPU for more than one rival.** `src/ai.js` assumes exactly one
  (`1 - civ` throughout).
- **Stances.** Each civ holds a stance toward each other civ:
  **Cooperate**, **Neutral** or **Hostile**. Everyone starts Neutral. You
  can change your stance only while in contact (stacks or settlements in
  the same or neighbouring hexes). Changes are chosen secretly and
  revealed together.

  | You | Them | Effect |
  |---|---|---|
  | Cooperate | Cooperate | **Allied.** Each can chain-jump through the other's settlements and gets the settlement bonus when aiming at them. Neither can attack the other. Tech sharing is open. |
  | Cooperate | Neutral | They can use your settlements as if allied; you can't use theirs. Neither can attack. |
  | Neutral | Neutral | Either side may attack the other. |
  | Hostile | Neutral | You may attack at +1 to your combat rolls. |
  | Hostile | Cooperate | You may attack at +2, and they can't hit back. Betrayal pays. |
  | Hostile | Hostile | Fighting is mandatory wherever you meet. |

- **Tech sharing.** Allied civs in contact can share techs. Sharing
  copies the tech, so both sides keep it. Trades can be uneven: a tech
  for a tech, or a tech for RP.

## The map

- **Map size, number of beacons, and how much dust.** Still guesses,
  carried over from RULES.md's open questions. Worth revisiting once
  games stop being a straight race, since then the middle of the arms
  matters.

## Interface

- **Next counts only what's easy to forget** (jumping, settling, building
  with banked RP), ignoring growing and research. Simpler than "visited
  counts as handled", but a fleet you meant to grow with can slip past.
- **Techs spelled out in the status bar** ("Focus 1"). Fits now; won't
  fit at phone width once each side has a few tech types.
- **Income and settlement count in the status bar.** Left out: both can
  be read off the map. Banked RP can't, so that's what the bar shows.
- **"Lost!" where the stack was lost.** The label appears over the hex
  you aimed at, not where the stack went.
