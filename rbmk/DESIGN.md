# RBMK — design sketch

A real-time, single-player game. You operate a graphite-moderated,
water-cooled reactor modelled loosely on the RBMK-1000. The grid
dispatcher sends you power orders. Miss them and your rating falls until
you're sacked. Push the reactor too hard and it runs away. You can end
your shift at any time by pressing AZ-5 (scram), but a scram from the
wrong state causes the very excursion it's meant to stop.

The physics is simplified but real in kind: every mechanism here exists
in the actual reactor. The numbers are starting guesses to be tuned with
a headless tool. Where they come from the real plant, that's noted.
Questions still open are marked **(open)**.

> Status: sketch for review. No code yet.

## Alternate names

- **AZ-5**: the scram button, which is also how the game ends.
- **Xenon Pit**: the poisoned low-power state the game is built around.
- **Prompt Critical**: the moment you lose. It may suit the game-over
  screen better than the title.

## What the player controls

| Control | Range | Notes |
|---|---|---|
| Rod bank (target) | 0–60 rods inserted | Rods move one after another toward the target at a fixed speed. A rod's full stroke takes ~18 s on the real plant; 8 s here. |
| Coolant pressure (target) | 55–80 bar | Moves toward the target with a lag of a few seconds. Nominal is 70 bar. |
| AZ-5 | button | Drives all rods in at the normal rod speed (on the real plant scram rods weren't faster) and locks the controls. The game ends when power has fallen, or melts down. |

One bank of 60 instead of 211 individual rods. The number inserted is
the operational reactivity margin (ORM); the real rule was 15 rods
minimum.

## What the player sees

- **Thermal power** (MWt, 3200 nominal) and **electrical output** (MWe,
  which is what orders are given in).
- **Core temperature** (fuel average, °C).
- **Steam fraction** in the channels (%).
- **Pressure**: target and actual.
- **Rod bank**: target and actual depth.
- **Doubling time** (the period meter): "∞", "4 min", "12 s", and so on,
  pinning red when it gets short. It responds the moment reactivity
  changes, before power itself does.
- **Margin printout**: ORM in rods, refreshed only every ~5 game minutes
  and showing the value from when the calculation *started*. That's
  faithful: the real figure came from a slow computer printout.
- **Current order**: target MWe, tolerance band, deadline. Plus the
  **rating** bar.

Hidden: iodine, xenon, and total reactivity.

## State

```
C      precursor level (power-like, normalized: 1.0 = nominal at steady state)
n      power (fraction of nominal), derived from C and reactivity
rods   actual bank depth, 0..1   (rodsTarget)
P      actual pressure, bar      (pTarget)
alpha  steam (void) fraction, 0..~0.7
Tf     fuel temperature, °C
I, X   iodine-135 and xenon-135 (normalized)
damage fuel damage, 0..1
rating 0..100
clock  shift time (game minutes)
```

## Reactivity

Reactivity is kept in **dollars** internally ($1 = prompt critical) and
never shown to the player as a number:

```
r = r_fuel                                  excess reactivity of the core (constant)
  + rodWorth(rods)                          negative; includes the tip effect
  − xenonWorth · X
  + voidWorth  · alpha                      positive: RBMK's flaw
  − dopplerWorth · (Tf − T_ref) / 600       negative: hotter fuel absorbs more
```

Starting guesses, chosen so the traps line up:

| Term | Guess | Why |
|---|---|---|
| Rod bank, full | −$12 (≈ $0.20 per "rod") | 60 rods of margin at the bottom of the scale |
| Xenon at full-power equilibrium | −$4 | Real thermal reactors: ~2.5–3% Δk ≈ $4 |
| Xenon peak after a cut from full power | ≈ −$7 | So a pit costs ~15 extra rods, taking a 30-rod margin below the 15-rod rule |
| Void, full steam | +$5 over the whole range | The 1986 core had a large positive void coefficient. Exact figure **(open)** |
| Doppler, cold to full power | −$1.5 | Small next to the void term on purpose |
| `r_fuel` | set so r = 0 at full power, equilibrium xenon, ~30 rods in | |

### Rod worth and the tip effect

- **Normal operation:** rods move one after another, so the bank's worth
  is linear in the number inserted ($0.20 a rod).
- **On AZ-5,** every withdrawn rod starts moving at once. A single rod's
  reactivity against its own depth x is
  `rodShape(x) = −S(x) + tip · bump(x)`, where:
  - `S(x)` is a smoothstep: a rod does little at the top and bottom of
    its travel.
  - `bump(x)` is positive over the first 30% of travel. That's the
    graphite displacer pushing water out of the bottom of the channel
    before the absorber arrives.
  - So for the first ~1.5 s of a scram, every withdrawn rod is *adding*
    reactivity. The fewer rods were in, the more rods do this.
- **Xenon makes it worse:** `tip` is multiplied by `1 + 2·(X − 1)` when
  xenon is above equilibrium. Xenon poisons the middle of the core, which
  pushes the flux toward the bottom, where the displacers arrive.
- Tuned so a scram from full power with 30 rods in gives a brief ~+$0.16
  bump (power up ~20%, then down). At 6% power the 15-rod rule is about
  where a scram stops being survivable: 16 rods survives at r = $0.985,
  12 rods goes prompt critical.
- **Changed from the first sketch,** which had one bank with an S-shaped
  worth curve and a tip bump in normal operation too. With a single
  depth, "8 rods of margin" meant the bank sat too deep for the tip
  effect to show. Moving the rods in sequence and only together on
  scram matches how the margin is counted, and puts the danger on AZ-5.
  The discoverable "nudging rods in raises power" effect is gone.

## Power (point kinetics, one delayed group, prompt jump)

The standard one-group point-kinetics equations are stiff: the prompt
neutron lifetime is ~1 ms. The prompt-jump approximation removes the
stiffness and gives two lines in dollars:

```
n  = C / (1 − r)
dC/dt = λ · (n − C)          λ ≈ 0.08 /s
```

- When r is steady, power grows as `exp(λ·r/(1−r) · t)`, so
  **doubling time = ln2 · (1 − r) / (λ · r)**. That gives:
  - r = $0.10 → ~78 s
  - r = $0.50 → ~8.7 s
  - r = $0.90 → ~1 s
- **r ≥ $1 means prompt critical**: the formula breaks, and so does the
  reactor. Game over. (The real excursion goes on in milliseconds after
  that; we cut to the explosion.)
- A rod movement changes r, which changes n *at once* (the prompt jump),
  then C follows over seconds. A scram drops power promptly to
  `C/(1 − r)`, then it decays on the delayed-neutron time scale.
- λ is the knob that sets how fast the reactor feels. It can be raised
  for arcade pacing without changing the shape of anything.

## Steam and temperature

```
T_sat(P)  ≈ 270 + 1.0 · (P − 55) °C        steam tables: 55 bar ≈ 270, 70 ≈ 286, 80 ≈ 295
alpha_eq  = alphaMax · (n / flow) / (n / flow + n0) − kP · (P − 70)    clamped to [0, alphaMax]
alpha     → alpha_eq   with τ ≈ 2 s
dTf/dt    = (600 · n − (Tf − T_sat(P)) · h(alpha)) / 5 s
            (steady state: Tf = T_sat + 600 · n / h)
```

- **`flow`** is main-pump flow, fixed at 1.0 in the first version. It's
  there so a later turbine-test order (pumps coasting down → less flow →
  more steam at the same power) needs no change to the physics.
- **Why `n / (n + n0)`:** steam rises steeply with power at low power and
  flattens near full power. Paired with Doppler (linear in power), it
  makes the **power coefficient positive below roughly 25–35% power** and
  negative above. Tune that crossover with n0. The real RBMK had a
  700 MWt (22%) minimum-power rule for this reason. At low power the
  reactor wobbles and has to be ridden; at high power it settles itself.
- **Pressure is a fast, double-edged control:**
  - Lower pressure → more steam → more reactivity, fast. It's a quick way
    to add power, and it destabilizes.
  - Higher pressure → less steam → *less* reactivity. That has to be made
    up by pulling rods, so **steadying the reactor with pressure eats
    your rod margin**. I like this coupling; it's real.
  - At high power and low pressure, steam can rise past a dryout point:
    `h(alpha)` collapses, fuel temperature spikes, and damage builds. That
    sets a floor on pressure at high power.
  - Above ~78 bar the relief valves lift: a rating penalty and a hard cap.
- **Plant efficiency is fixed** at ~31%: MWe = MWt × 0.31. (Real plant
  efficiency does rise with steam pressure. That coupling is left out for
  now because pressure already does three jobs. If playtesting shows
  everyone parks at maximum pressure, it's the first thing to add.)

## Xenon

```
dI/dt = yI · n − λI · I
dX/dt = yX · n + λI · I − λX · X − σ · n · X
```

- λI = ln2 / 6.57 h, λX = ln2 / 9.14 h (real half-lives).
- σ (burnout at full power) ≈ 5 × λX, so burnout dominates at full power.
- Normalize the yields so that X = 1 at full-power equilibrium, which
  makes `xenonWorth` the equilibrium worth.
- What falls out of this:
  - Cut power and xenon *rises* for hours: iodine keeps decaying into it
    and less is burned off. The peak comes ~10 h after a cut from full
    power.
  - Raise power from a pit and the xenon burns off. Reactivity creeps up
    over minutes, and if rods were pulled to compensate, power climbs
    with it.
  - Drop low enough for long enough and you can't restart at all: the
    reactor is subcritical with every rod out until the xenon decays.
    That's a loss by rating, not by meltdown.

## Losing and ending

- **Prompt critical** (r ≥ $1): immediate meltdown. Score 0.
- **Fuel damage**: builds while Tf is over ~1200 °C, faster further over.
  It reaches 1 → meltdown. Score 0. A warning lamp lights as it builds.
  Fuel at 2800 °C melts at once. Heat comes in at a rate set by power
  and leaves at a rate set by the coolant, so a big enough spike melts
  fuel however brief.
- **Sacked**: rating reaches 0. Score = shift time.
- **AZ-5**: rods drive in. If power then falls below ~1% without
  meltdown, the shift ends cleanly. Score = shift time. Scrammed from
  30 rods it's dull and safe. Scrammed from 5 rods in a xenon pit at low
  pressure, the tip effect plus steam can push r past $1.

**Score** = total hours on shift. The rating already punishes time out of
tolerance, so the score doesn't count it a second time.

## Orders and rating

- An order is: target MWe, tolerance (±50 MWe to start), ramp
  allowance (time to reach it), and sometimes a hold duration.
- Kinds:
  - **Load follow**: up or down to a level.
  - **Hold**: stay at a level for N hours, often low ("maintenance",
    "grid has surplus").
  - **Urgent rise**: needed back up quickly.
- **The trap** is a long low hold followed by an urgent rise. Its odds
  grow with time on shift, and tolerances tighten, so a shift can't be
  survived forever by standing still.
- **Rating** starts at 100. It loses points per second while you're
  outside the band past the ramp allowance, gains a few for each order
  met (capped at 100), and loses points for relief-valve lifts.
- **Inspections**: rarely, an inspector checks the true margin. Below 15
  rods costs a big rating hit. They're announced only after the fact on
  the teletype ("Inspector visited 03:40. Margin 11 rods. Reprimand."),
  so their timing can't be gamed. The rule exists but is enforced only
  sometimes, which is also faithful, and it gives the player a reason to
  read the margin printout.
- Orders come from a seeded RNG, so a shift can be replayed exactly.

## Time scales (arcade pacing)

Each subsystem gets its own time scale, plus one global multiplier for
emergencies:

| Subsystem | Real | In game | Effect |
|---|---|---|---|
| Xenon, iodine, shift clock | hours | 1 real s = 2 game min | A 10 h xenon peak takes ~5 real min. A pit forms in 1–2 min |
| Orders | hours | every ~1–3 game h | A new order every 30–90 real s |
| Kinetics, steam, temperature | seconds | ~1:1, maybe λ × 1.5 | The reactor feels live |
| Rods | 18 s stroke | ~8 s stroke | Slow enough that a scram feels slow |

**Slow motion**: when the doubling time drops below ~10 s, the global
multiplier eases from 1 down to ~0.25 (sound drops in pitch, alarms
sound). The player gets a few extra seconds to react near the edge. Past
prompt critical it's over, in slow motion.

## After the game

The sim is deterministic, so the whole shift can be replayed from its
seed and inputs. The end screen charts power, steam, the true ORM,
hidden xenon, and "distance to prompt critical" (a 0–100% gauge, which
is really r in dollars). It marks:

- **the point of no return**: the last moment a scram would have ended
  safely. It's found by re-simulating a scram from snapshots taken
  through the shift. This is the history lesson, so it's worth building.
- when the margin went below 15 rods, and where each order was missed.

## Look

A 1980s control room, with the schematic drawn as a cutaway in the style
of an 80s educational comic (bold ink outlines, flat spot colours,
halftone shading, labelled callouts). Everything is canvas or SVG drawn
in code; no image assets to start with.

- **Mimic board** (top): the schematic. Real plants had wall diagrams of
  the coolant loop with lamps, so it belongs in the room. Shows:
  - the core in cutaway, with graphite stack, the rod bank moving to its
    actual depth, and channels shaded from blue (water) to white (steam)
    by steam fraction, glowing hotter with fuel temperature;
  - drum separators, main circulation pumps (flow pulses along the
    pipes), turbine-generators spinning at a speed matching output,
    condenser and feedwater return;
  - a grid line out to the dispatcher.
  It's for effect only: it shows sim state and takes no input.
- **Round core map**: the RBMK's circular board of lamps, one per channel
  or rod. Here it doubles as the rod-bank readout and flickers with
  local power.
- **Gauges** (below): analogue dials for power (MWt and MWe), core
  temperature, pressure and steam fraction, plus the period meter
  (doubling time), whose needle swings into the red. Lamps for dryout,
  relief valves and fuel damage.
- **Controls**: a rod-bank lever, a pressure knob, and AZ-5 behind a
  flip-up cover.
- **Side**: a teletype for dispatcher orders and inspector notes, and a
  dot-matrix printer for the margin printout. The paper scrolls.
- **Rating** as a "shift supervisor's mood" dial, or a plain bar.
- **Phone**: everything stacks; the mimic board shrinks to a strip.
- **Slow motion**: the panel's hum drops in pitch, lamps flash.
- **Meltdown**: the cutaway shows the lid going up. Then the end screen.

## Code layout (following the repo's other toys)

```
rbmk/
  index.html, style.css     panel UI, How to play card
  RULES.md                  player-facing rules
  DESIGN.md                 this file
  src/sim.js                // @ts-check, pure, fixed step; floats with + − × ÷ only (as Wooden Ships)
  src/rng.js                seeded RNG for orders
  src/orders.js             order generator (pure, seeded)
  src/main.js               loop, input, time scaling, settings
  src/render.js             gauges, period meter, chart
  src/audio.js              hum, alarms, slow-motion pitch
  test/sim.test.js          xenon pit timing, tip effect, prompt-critical threshold, scram outcomes
  tools/headless.js         CPU operators: cautious, greedy, idle
```

- Fixed physics step (e.g. 20 ms of game time), with sub-steps whenever
  `λ·r/(1−r)·dt` would exceed ~0.05. That keeps explicit Euler stable as
  r nears $1.
- The doubling-time readout uses `Math.log`, but that's presentation,
  outside `sim.js`.
- **Headless checks:** the *cautious* operator keeps ≥ 15 rods, refuses
  impossible orders and scrams when deep. It should survive long but be
  sacked eventually. The *greedy* operator meets every order at any
  cost and should melt down sometimes, usually after a pit. The *idle*
  operator should be sacked fast. If the cautious operator dies or the
  greedy one never does, the tuning is off.

## Settings (presets, as in the other toys) (open)

Maybe three: **Pace** (relaxed / standard / brisk: the time scales),
**Dispatcher** (calm / demanding: order frequency and tolerances), and
**Instruments** (full / 1986: whether the margin printout exists at all).

## Two-player co-op (later)

A possible later mode, in the style of Spaceteam: two players on separate
devices, each with half the controls and half the instruments. Nothing is
built for it yet, but steps 2 and 4 should keep it cheap.

- **Networking is the repo's existing lockstep** (`multiplayer/lockstep.js`,
  as Dot Army and Wooden Ships use it). Each device runs the whole
  simulation, including the dispatcher, and only inputs are exchanged. Any
  deterministic dispatcher works, seed-only or state-aware.
- **Splitting the panel is presentation.** The adapter's `applyInput`
  accepts rod inputs only from one seat and pressure inputs only from the
  other. Each client draws only its own gauges.
- **Needs a fixed tick.** `step(s, dt)` takes any dt today. Lockstep needs
  both devices to step the same amount per tick (Wooden Ships uses 30 a
  second), so `main.js` should drive the sim in fixed increments from the
  start.
- **Slow motion has to live in `sim.js`.** If `main.js` worked out the
  slow-motion multiplier from the doubling time and passed a smaller dt,
  two devices could disagree. Computed inside the sim from `r`, it's
  deterministic.
- **Floats are already safe.** The + − × ÷ / min / max rule gives the same
  results on every engine, as in Wooden Ships.
- **The game design is the open part (open).** Spaceteam works because
  what you're told concerns your partner's controls. Here, for example,
  the rod operator could have the dispatcher teletype and the margin
  printout, and the pressure operator the period meter and the steam
  gauge. Rods and pressure are coupled, so the two players have to talk.
  The 1986 control room was also split between operators who each saw
  only part of the picture.

## Order of work

1. `sim.js` with tests: xenon pit timing, prompt-jump power, steam and
   temperature, the tip effect, scram outcomes, prompt-critical cutoff.
2. `orders.js` and the rating, with tests.
3. `tools/headless.js` with the cautious, greedy and idle operators.
   Tune `DEFAULTS` until they behave as described above.
4. A plain playable UI: numbers and sliders, real-time loop, time
   scaling, slow motion. Check the feel in a browser.
5. The control-panel look: gauges, core map, teletype, printer.
6. The cutaway mimic board.
7. End screen: replay chart and point of no return.
8. `RULES.md`, the How to play card, links from the site index and
   `CLAUDE.md`, an e2e script.

Later: the turbine-test order (pump coastdown), two-player co-op (above), and plant efficiency if
pressure needs a reason not to sit at maximum.

## Open questions

- Visual details of the comic style, once there's something to look at.
- Settings presets (see above).
