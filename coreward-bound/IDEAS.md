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

- **Neutral systems.** Settlements nobody owns, sitting in the arms with
  a garrison. Meant to put risk and reward in the arms, which today are
  empty, and to give fights a reason to happen away from the core. The
  design so far, all numbers untested:
  - **Placement.** Two mirrored pairs per galaxy, fixed when the map is
    made, so both civs face the same neutrals. Hidden until one of your
    stacks lands on the hex, like potential values. In arm hexes, none
    within about 3 hexes of a home (so no home starts inside one's
    territory). Value equal to the hex's potential; garrison about
    value + 1 fleets.
  - **Attitude.** Each neutral holds one toward each civ, on a ladder:
    Hostile ← Indifferent → Friendly → annexed. All start Indifferent.
    Nothing is rolled; attitudes change only through what players do.
  - **Territory.** Every hex within 2 of the neutral (19 hexes). Nobody
    can found a settlement on the neutral's own hex, since it already
    is one.
  - **Infringement.** Attacking a neutral, or founding a settlement in
    its territory, makes it Hostile toward that civ. Jumping through or
    standing in its territory doesn't count, and neither does growing a
    settlement that was there before.
  - **Indifferent:** does nothing, but blocks its hex.
  - **Hostile:** at the start of each round, gains a fleet if below a
    cap (value + 3?). With 3 or more fleets, sends all but one at the
    weakest settlement or stack of the offending civ inside its
    territory, using the ordinary jump, scatter and combat rules. A
    small routine in `sim.js` on the seeded RNG, so it stays
    deterministic.
  - **Friendly:** works like your own settlement for jumping (chaining,
    +1 to aim at it, sight), but pays no RP, builds nothing and takes no
    relic deliveries. You may found settlements in its territory without
    offence, and if your rival founds one there, it turns Hostile toward
    them: a Friendly neutral guards your frontier.
  - **Courting.** Indifferent → Friendly: spend fleets equal to its
    value, from fleets that began the turn in or next to it. Friendly →
    annexed: pay RP equal to its value with one of your fleets present.
    Fixed prices, no roll, like research.
  - **Attacking.** Beat the garrison (it gets +1 defending, as at any
    settlement), then the usual take roll. You get it at value − 1, not
    working until your next turn, as with any taken settlement.

  Courting should pay at least as well as attacking, because attacking
  destroys what courting buys:

  | | Attack and take | Court and annex |
  |---|---|---|
  | Cost | Fleets lost fighting the garrison, then the take roll | Fleets equal to its value, then RP equal to its value |
  | Speed | A turn or two | At least two turns, in the open |
  | Settlement | Value − 1, waits a turn | Full value, working at once |
  | Garrison | Destroyed | Joins you |
  | Its tech (if neutrals hold one) | Only on the conquest roll (5–6) | Yours for certain |
  | Its territory | Nothing | Yours to settle |

  For a value-4 neutral, courting costs about 5 fleets' worth (4 fleets
  plus 4 RP) and returns a 5-fleet garrison, a value-4 settlement and its
  territory. That may be too generous; what balances it is that courting
  is slow and exposed. Attacking stays right for speed, for denial (your
  rival is courting it, or it guards their border or carries their chain
  coreward), and for a Hostile neutral you'd rather not pay off. So
  courting is the way to grow and attacking is the way to interfere,
  which makes neutrals something to fight over.

  Open questions:
  - **Winning back a Hostile neutral.** Perhaps hostility from founding
    can be bought off (Hostile → Indifferent for twice its value in
    fleets) while hostility from an attack is permanent. Otherwise one
    careless settlement locks a neutral out for the game.
  - **Your rival attacks a neutral that's Friendly to you.** Simplest:
    an ordinary fight, it turns Hostile toward them, and if they take it
    your courting is lost. Courting is a stake your rival can burn.
  - **Friendly neutrals as a road to the core.** A Friendly link midway
    up an arm is a free chain toward the core, which could feed the race.
    Fixes: keep neutrals out of the inner third of the arms, or don't let
    a relic carrier chain through one.
  - **Reputation.** Attacking one neutral could make the others less
    friendly toward you (Outreach's "domino effect", loosely). Probably
    unnecessary with annexation already this much better; leave it out
    at first.
  - **The CPU** has to understand territory (don't found inside an
    unfriendly one), court neutrals near its path, and attack the
    rival's Friendly ones. Without that, headless runs measure nothing.
    This is the biggest piece of work.
  - **Interface:** each neutral needs a marker for its attitude toward
    you. Its attitude toward your rival should probably stay hidden, as
    stack sizes are.

- **Dissolution, as one settlement breaking away.** Each turn, one of
  your settlements may break away and become an Indifferent neutral (as
  above), keeping its value, with the chance rising with distance from
  your home. Anyone can win it back by courting. An anti-snowball tax
  that bites hardest on long reaches, including the road to the core,
  and turns where to settle into a risk you can see on the map. Problems:
  a single roll that costs you a settlement you could do nothing about is
  the luck complaint again, so show each settlement's chance on the map
  and let a fleet stationed there, or RP, lower it. "Distance" needs
  defining: hexes from home is simplest; jumps through your network would
  reward the connected chain from the homeward-carrier entry. Too strong
  and nobody expands.

- **What Outreach does.** Both entries above come from Outreach, as did
  the stance table under "More players". Sources: a reproduction of rules
  1.0–19.0 on [RulesPal](https://rulespal.com/outreach/rulebook), and
  fan-made revised rules, rules summary and Fate Table, freely
  downloadable from the game's files on BoardGameGeek. The fan table may
  differ from SPI's original chart.
  - **The Fate Table.** Every turn each player rolls a d6 against their
    total SP (the summed value of their star gates, which is also their
    income). Low rolls are bad. +1 per X result on that turn's
    exploration rolls (capped at 6), +1 per 50 RP spent (capped at 8),
    and 5 RP shifts one column left. Results A–F are Dissolution (10%,
    30%, 50%, 70%, 80%, 90% of your SP; E and F also cost a
    Civilization Level), G–J create an autonomous force, K and L raise
    your Civilization Level if you've spent Wisdom Chits. Below 20 SP
    nothing happens; at 60–69 SP, five unmodified rolls in six are
    Dissolution; at 70+, all six.
  - **Dissolution** neutralizes your star gates worth that share of your
    SP; you choose which. Each result can hit you only once a game, and
    B (30%) makes you immune to the rest. Neutralized gates stay on the
    board, and any player can win one back by paying RP equal to its
    value plus fleets equal to its value minus their Civilization Level.
  - **Autonomous forces** (2–5 star gates, 5–12 fleets) are placed
    around a hex the rolling player explored that turn; no exploration,
    no force. At most four on the board. They never move, attack or
    build until contacted. The first player to contact one runs it, as
    "caretaker". Their stance toward each player is rolled on the
    Random Interaction Option Table at first contact and may be
    re-rolled later; attacking one makes it hostile toward you. A
    hostile force keeps one fleet per star gate at home and sends the
    rest at the nearest of your star gates in sight.

## More players

- **Three or six civs.** A hex grid only maps onto itself under
  rotations by 60°, so a spiral with three arms (120°) or six (60°) gives
  every civ the same arm. Four can't be exactly fair. More civs would put
  rivals on neighbouring arms and make the core a crowd.
- **Network play** through the `multiplayer/` library, which already runs
  Dot Army online by lockstep. The simulation is deterministic and every
  move is an action (`act` in `src/sim.js`), so a turn can be sent as its
  list of actions. Two problems first, both in "Problems specific to
  turn-based games" in [multiplayer/README.md](../multiplayer/README.md):
  with a shared seed, the scatter odds a jump shows become a known
  outcome, so jumps need the networked dice in `multiplayer/dice.js`;
  and every device holds the hidden potentials and true stack sizes, so
  fog of war leaks to anyone who opens devtools. Whether to accept that
  leak among friends is still open.
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
