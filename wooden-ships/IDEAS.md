# Wooden Ships — Ideas

Designs that have been talked about but not built. Some come from
playtests, some from working on the code. None of them is a rule until it
moves into [RULES.md](RULES.md). Bigger plans for the game (a campaign,
boarding, running aground, charged shots) are in RULES.md's last
sections; this file is for the smaller interface and gameplay ideas.

## The look: expressive, not technical

The game should tell you what's happening with things that belong at
sea, not with gauges and overlays. Show the wind as waves rather than a
vector, the rudder as a wheel rather than a slider, a broadside as a
cannon rather than a round button with a reload ring. When there's a
choice between a new HUD element and making something already on screen
say more, make the existing thing say more.

The reason is partly looks and partly legibility. A chart-like overlay
asks you to read it and translate it into the world. The first playtest
showed that: the faint no-go wedge ahead of the bow read as a line of
sight, not as "the wind is pushing against you here", so it was taken
out and the wind went into the waves instead. Text and numbers are a
last resort, kept short where they're needed at all.

This doesn't rule out a compass or a crew count. It's a tiebreaker:
when two designs work equally well, pick the one that looks like it
belongs on a ship.

## Steering and firing

From the first playtest, on a laptop with a mouse. The game felt
balanced on easy, but the controls got in the way: the ship ended up in
irons and the fight went static, and the fire buttons were too far apart.

- **A ship's wheel for the rudder.** A wheel at the bottom of the screen
  that you turn by dragging. It stays where you leave it, as a real one
  does, so you don't hold the mouse button through a turn, and the
  wheel's position *is* the rudder gauge.
  - Turning to starboard is always clockwise on screen, whatever the
    heading, if you look down from above. So turning the wheel clockwise
    turns the ship clockwise every time. That removes the left/right flip
    that today's drag-to-steer needs when the ship heads down the screen.
  - Needs: a marked king spoke so you can find centre, and some easy way
    to centre it (snap near the middle, or a double-click).
  - No wheel sprite in the sheet: it'd be drawn on the canvas.
- **Cannons (or cannonballs) as fire buttons.** Two cannons either side
  of the wheel, muzzles out, using the sheet's `cannon` sprites, or a
  `cannonBall` per side if a cannon reads as too busy. Each swings to show
  where that broadside points, as the arrows do now. Reloading could show
  as the gun running in and out again, or a glowing slow match, instead
  of a ring. That also brings the buttons in from the screen's corners.
- **Phone layout (open).** Not yet playtested on a phone. A wheel and two
  cannons at bottom-centre would put steering and firing under one thumb,
  so a phone may need the cannons kept in the corners, or drag-anywhere
  steering kept for touch. Decide after a phone playtest.
- **Rotational keys.** ← and → could follow the wheel's rule: → is always
  clockwise (starboard), with no flip. Today they swing the bow toward
  that side of the screen, which flips when the ship heads down it.
- **Set a course instead of a rudder** (set aside). Click where you want
  to go and a helmsman steers there. It's friendlier for a mouse, but it
  turns sailing into giving orders, and the wheel keeps more of the feel.
  Worth another look only if the wheel doesn't work out.

## The wind

- **Bow wave.** A wave at your bow that shrinks as you lose way, so
  slowing toward irons shows on the ship itself rather than on a speed
  readout.
- **Wind shifts you can see.** Shifts come without warning, and that
  should stay. But when one happens, something at sea could show it: the
  sails flog for a moment, or the crests turn visibly, rather than a text
  notice.

- **Calmer water in a wind shadow.** With wind shadow on, a ship just
  downwind of another gets half the wind, but the crests there look the
  same as everywhere else. They could shrink or fade inside the shadow,
  so you can see whose wind is being stolen.

## Crew

- **Quieter crew meters.** Take the text out of the crew pills ("You: 24
  crew"), or leave just the number.
- **Later:** vertical pills, or a row of small crew figures that drop out
  as they're lost, in the spirit of Star Control's crew display. The
  sheet has `crew (1)` to `crew (6)` sprites that might do.

## Not decided

- Whether the fight is still static once the controls are easier. The
  first playtest's standoff looked like a result of the controls, not the
  rules, so the rules stay as they are until a playtest with better
  controls says otherwise.
