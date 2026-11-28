import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, step, applyInput, stateHash, isin, icos, angleOf, angleDiff, deg, TURN, KTS,
  forwardSpeed, aimGun, terrainAt, LAND, SHALLOW, DEEP, PORT, STARBOARD, BLUE, RED, DRAW,
} from '../src/sim.js';
import { createAI } from '../src/ai.js';

/**
 * Open sea, steady wind from `windDir` (degrees) at `kts`, one ship (or two)
 * placed by hand. Ship 1 is parked far away unless `two` is set.
 */
function sea({ windDir = 0, kts = 14, two = false, ...params } = {}) {
  const game = createGame({ islands: 'none', wind: 'steady', shadow: false, width: 120, height: 120, ...params });
  const d = deg(windDir);
  Object.assign(game.wind, { dir: d, fromDir: d, toDir: d, speed: kts, fromSpeed: kts, toSpeed: kts });
  for (const s of game.ships) Object.assign(s, { vx: 0, vy: 0 });
  Object.assign(game.ships[0], { x: 1300, y: 1300, heading: 0 });
  Object.assign(game.ships[1], { x: two ? 1300 : 200, y: two ? 1150 : 200, heading: 0 });
  return game;
}
const run = (game, ticks) => { for (let i = 0; i < ticks; i++) step(game); };
const speed = (s) => Math.hypot(s.vx, s.vy);

test('sine table matches Math.sin, and angleOf inverts it', () => {
  for (let a = 0; a < TURN; a += 97) {
    assert.ok(Math.abs(isin(a) - Math.sin((a / TURN) * 2 * Math.PI)) < 1e-12, `sin ${a}`);
    assert.ok(Math.abs(icos(a) - Math.cos((a / TURN) * 2 * Math.PI)) < 1e-12, `cos ${a}`);
    const back = angleOf(icos(a) * 50, isin(a) * 50);
    assert.ok(Math.abs(angleDiff(a, back)) <= 1, `angleOf ${a} → ${back}`);
  }
  assert.equal(angleOf(0, 1), TURN / 4); // y down: south is a quarter turn clockwise from east
  assert.ok(Math.abs(angleDiff(deg(350), deg(10)) - deg(20)) <= 1);
  assert.ok(Math.abs(angleDiff(deg(10), deg(350)) + deg(20)) <= 1);
});

test('same seed and inputs give the same game; another seed gives another', () => {
  const play = (seed) => {
    const g = createGame({ seed, islands: 'many' });
    for (let t = 0; t < 900; t++) {
      if (t % 40 === 0) applyInput(g, 0, { type: 'rudder', value: ((t / 40) % 3 - 1) * 70 });
      if (t % 200 === 10) applyInput(g, 1, { type: 'fire', battery: t % 400 < 200 ? PORT : STARBOARD });
      step(g);
    }
    return stateHash(g);
  };
  assert.equal(play(7), play(7));
  assert.notEqual(play(7), play(8));
});

test('no drive inside the no-go zone: a ship pointing into the wind drifts backwards', () => {
  const g = sea({ windDir: 0 });
  g.ships[0].heading = deg(30); // bow 30° off the wind
  run(g, 120);
  assert.ok(forwardSpeed(g.ships[0]) < 0, `forward speed ${forwardSpeed(g.ships[0])}`);
});

test('a broad reach is faster than dead downwind, and both are slower than a beat is impossible', () => {
  const top = (off) => {
    const g = sea({ windDir: 0 });
    g.ships[0].heading = deg(off);
    run(g, 900);
    return forwardSpeed(g.ships[0]);
  };
  const reach = top(135), run_ = top(180), beam = top(90), close = top(60);
  assert.ok(reach > run_ && run_ > 0, `reach ${reach} run ${run_}`);
  assert.ok(beam > close && close > 0, `beam ${beam} close-hauled ${close}`);
  assert.ok(reach < 14 * KTS * 1.2, 'no faster than about the wind');
});

test('the rudder needs water flowing past it: a stopped ship cannot turn, a reversing one turns the other way', () => {
  const g = sea({ kts: 0 });
  const s = g.ships[0];
  s.heading = deg(90);
  applyInput(g, 0, { type: 'rudder', value: 100 });
  run(g, 30);
  assert.equal(s.heading, deg(90));
  s.vx = 0; s.vy = -1; // moving backwards (stern first, bow south)
  run(g, 5);
  assert.ok(angleDiff(deg(90), s.heading) < 0, 'full starboard rudder going astern swings the bow to port');
});

test('the keel kills sideways motion much faster than forward motion', () => {
  const fwd = sea({ kts: 0 }), side = sea({ kts: 0 });
  fwd.ships[0].vx = 4; // heading east, moving east
  side.ships[0].vy = 4; // heading east, moving south: pure leeway
  run(fwd, 60); run(side, 60);
  const leeway = (s) => -s.vx * isin(s.heading) + s.vy * icos(s.heading);
  assert.ok(Math.abs(leeway(side.ships[0])) < forwardSpeed(fwd.ships[0]) / 4, `${leeway(side.ships[0])} vs ${forwardSpeed(fwd.ships[0])}`);
});

test('a hard turn is a brake', () => {
  const straight = sea({ kts: 0 }), turning = sea({ kts: 0 });
  for (const g of [straight, turning]) g.ships[0].vx = 4;
  applyInput(turning, 0, { type: 'rudder', value: 100 });
  run(straight, 60); run(turning, 60);
  assert.ok(speed(turning.ships[0]) < speed(straight.ships[0]) * 0.9, `${speed(turning.ships[0])} vs ${speed(straight.ships[0])}`);
});

/** Ship 0 heading east; target placed relative to ship 0 by (ahead, starboard) metres. */
function gunnery(ahead, starboard, targetHeading = 0, params = {}) {
  const g = sea({ kts: 0, two: true, spread: 0, ...params });
  const [a, b] = g.ships;
  Object.assign(b, { x: a.x + ahead, y: a.y + starboard, heading: deg(targetHeading) });
  return g;
}

test('a broadside lands every ball on a target abeam', () => {
  const g = gunnery(0, 150, 0);
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  run(g, 90);
  assert.equal(g.ships[1].crew, 24 - 4);
  assert.equal(g.stats.fired[BLUE], 4);
});

test('guns cannot bear on a ship dead ahead', () => {
  const g = gunnery(150, 0, 90);
  const aim = aimGun(g, g.ships[0], STARBOARD, 0);
  assert.ok(aim.dy > 0.9, 'clamped to the arc, nearly square to the hull');
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  run(g, 90);
  assert.equal(g.ships[1].crew, 24);
});

test('crossing the T: traverse lands a whole broadside on a narrow end-on target', () => {
  // Target bow-on to us, 120 m off our starboard beam: only 12 m wide from here.
  const g = gunnery(0, 120, 270);
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  run(g, 90);
  assert.equal(g.ships[1].crew, 24 - 4);
  // And she can't reply: we're dead ahead of her.
  const back = aimGun(g, g.ships[1], PORT, 0);
  const tx = g.ships[0].x - back.x, ty = g.ships[0].y - back.y;
  const cos = (back.dx * tx + back.dy * ty) / Math.hypot(tx, ty);
  assert.ok(cos < Math.cos((40 * Math.PI) / 180), 'her guns point well away from us');
});

test('a side reloads on its own; the other side is ready at once', () => {
  const g = gunnery(0, 150, 0);
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  run(g, 20);
  applyInput(g, 0, { type: 'fire', battery: STARBOARD }); // still reloading: ignored
  applyInput(g, 0, { type: 'fire', battery: PORT });
  run(g, 20);
  assert.equal(g.stats.fired[BLUE], 8);
  run(g, 150 - 40);
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  run(g, 15);
  assert.equal(g.stats.fired[BLUE], 12);
});

test('a ship with no crew strikes and the other side wins; both at once is a draw', () => {
  const g = gunnery(0, 150, 0);
  g.ships[1].crew = 2;
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  run(g, 90);
  assert.equal(g.ships[1].crew, 0);
  assert.ok(g.ships[1].struck);
  assert.equal(g.winner, -1, 'decided, but not over until the sea is quiet');
  run(g, 3 * 30 + 30);
  assert.equal(g.winner, BLUE);

  const d = gunnery(0, 150, 0);
  d.ships[0].crew = 1; d.ships[1].crew = 1;
  applyInput(d, 0, { type: 'fire', battery: STARBOARD });
  applyInput(d, 1, { type: 'fire', battery: STARBOARD }); // heading east too, so her starboard faces away…
  d.ships[1].heading = deg(180); // …turn her round so her starboard faces us
  run(d, 90 + 3 * 30);
  assert.equal(d.winner, DRAW);
});

test('the game ends 3 s after the last ball lands, not when the last crew dies', () => {
  const g = gunnery(0, 150, 0);
  g.ships[1].crew = 1; // the first ball of the ripple strikes her; three more are still on their way
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  let landed = -1;
  while (g.winner < 0 && g.tick < 600) {
    step(g);
    if (g.ending >= 0 && !g.balls.length && landed < 0) landed = g.tick;
  }
  assert.ok(g.ending >= 0 && landed > g.ending, 'balls were still in the air after she struck');
  assert.equal(g.winner, BLUE);
  assert.ok(Math.abs(g.tick - (landed + 90)) <= 1, `over at ${g.tick}, last ball landed at ${landed}`);
});

test('a ball already in the air when she strikes can strike the winner too: a draw', () => {
  const g = gunnery(0, 150, 0);
  g.ships[0].crew = 1; g.ships[1].crew = 1;
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  g.ships[1].heading = deg(180);
  run(g, 3); // her ball is away before ours lands
  applyInput(g, 1, { type: 'fire', battery: STARBOARD });
  run(g, 600);
  assert.ok(g.ships[0].struck && g.ships[1].struck);
  assert.equal(g.winner, DRAW);
});

test('after the fight is decided the loser drifts rudderless, the winner steers on, and nobody fires', () => {
  const g = gunnery(0, 150, 0, { kts: 14 });
  g.ships[1].crew = 1;
  applyInput(g, 1, { type: 'rudder', value: 100 });
  applyInput(g, 0, { type: 'fire', battery: STARBOARD });
  while (g.ending < 0 && g.tick < 300) step(g);
  assert.ok(g.ending >= 0 && g.winner < 0);
  const [win, lose] = g.ships;
  assert.ok(lose.struck);
  assert.equal(lose.rudder, 0);
  applyInput(g, 1, { type: 'rudder', value: 100 }); // ignored: she has struck
  assert.equal(lose.rudder, 0);
  applyInput(g, 0, { type: 'rudder', value: 40 }); // the winner can still steer
  assert.equal(win.rudder, 40);
  win.batteries[PORT].reloadLeft = 0;
  applyInput(g, 0, { type: 'fire', battery: PORT });
  run(g, 3);
  assert.equal(win.batteries[PORT].firing, 0, 'no new shots once the fight is decided');
  const h = lose.heading, x = lose.x, y = lose.y;
  run(g, 60);
  assert.equal(lose.heading, h, 'a struck ship does not turn');
  assert.ok(Math.hypot(lose.x - x, lose.y - y) > 0, 'but she keeps drifting');
});

test('islands are point-symmetric, ringed by shallows, clear of the starts, with no diagonal-only tiles', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const g = createGame({ seed, islands: 'many', width: 45, height: 90 });
    const N = g.corners.length, cw = g.W + 1;
    let land = 0;
    for (let i = 0; i < N; i++) {
      assert.equal(g.corners[i], g.corners[N - 1 - i], `symmetry at ${i}`);
      if (g.corners[i] === LAND) land++;
    }
    assert.ok(land > 0, 'many islands means some land');
    for (let j = 0; j <= g.H; j++) {
      for (let i = 0; i <= g.W; i++) {
        if (g.corners[j * cw + i] !== LAND) continue;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii <= g.W && jj <= g.H) assert.notEqual(g.corners[jj * cw + ii], DEEP, 'land next to deep water');
        }
      }
    }
    for (const level of [SHALLOW, LAND]) {
      for (let j = 0; j < g.H; j++) for (let i = 0; i < g.W; i++) {
        const up = (k) => g.corners[k] >= level;
        const tl = j * cw + i, tr = tl + 1, bl = tl + cw, br = bl + 1;
        assert.ok(!(up(tl) && up(br) && !up(tr) && !up(bl)) && !(up(tr) && up(bl) && !up(tl) && !up(br)), `diagonal at ${i},${j}`);
      }
    }
    for (const s of g.ships) {
      for (let a = 0; a < TURN; a += TURN / 16) {
        assert.notEqual(terrainAt(g, s.x + icos(a) * 150, s.y + isin(a) * 150), LAND, 'land near a start');
      }
    }
  }
});

test('touching an island stops a ship dead without losing crew; shallows slow her down', () => {
  const g = sea({ windDir: 180 }); // wind from the west: sail east
  const s = g.ships[0];
  const cw = g.W + 1, i0 = Math.round(s.x / g.params.tile) + 6, j0 = Math.round(s.y / g.params.tile);
  for (let j = j0 - 3; j <= j0 + 3; j++) for (let i = i0; i <= i0 + 3; i++) g.corners[j * cw + i] = LAND;
  s.vx = 4;
  let bumped = false;
  for (let t = 0; t < 300 && !bumped; t++) bumped = step(g).bumps.length > 0;
  assert.ok(bumped);
  assert.ok(speed(s) <= g.params.bounce + 1e-9, `speed after bump ${speed(s)}`);
  assert.equal(s.crew, 24);

  const deep = sea({ windDir: 180 }), shoal = sea({ windDir: 180 });
  shoal.corners.fill(SHALLOW);
  run(deep, 600); run(shoal, 600);
  assert.ok(speed(shoal.ships[0]) < speed(deep.ships[0]) * 0.85, `${speed(shoal.ships[0])} vs ${speed(deep.ships[0])}`);
});

test('wind shadow: a ship just downwind of another gets less wind', () => {
  const make = (shadow) => {
    const g = sea({ windDir: 270, two: true, shadow }); // wind from the north, blowing south
    Object.assign(g.ships[1], { x: 1300, y: 1200, heading: deg(90) });
    Object.assign(g.ships[0], { x: 1300, y: 1300, heading: deg(90) }); // 100 m downwind, running
    run(g, 60);
    return g;
  };
  const on = make(true), off = make(false);
  assert.ok(on.ships[0].shadowed);
  assert.ok(speed(on.ships[0]) < speed(off.ships[0]));
});

test('the wind starts across the line between the ships, and shifts on schedule', () => {
  const g = createGame({ seed: 3, width: 45, height: 80, wind: 'gusty' });
  const [a, b] = g.ships;
  const from = { x: icos(g.wind.dir), y: isin(g.wind.dir) };
  assert.ok(Math.abs((a.x - b.x) * from.x + (a.y - b.y) * from.y) < 130, 'neither ship well upwind of the other');
  const start = g.wind.dir;
  let shifts = 0;
  for (let t = 0; t < 30 * 60; t++) if (step(g).shift) shifts++;
  assert.ok(shifts >= 3 && shifts <= 6, `${shifts} shifts in a minute of gusty wind`);
  assert.notEqual(g.wind.dir, start);
  const s = createGame({ seed: 3, wind: 'steady' });
  for (let t = 0; t < 30 * 120; t++) assert.equal(step(s).shift, false);
});

test('CPU vs CPU games finish, and the CPU only acts through inputs', () => {
  for (const seed of [11, 12]) {
    const g = createGame({ seed });
    const ais = [createAI(0, seed), createAI(1, seed + 1, { level: 'easy' })];
    while (g.winner < 0 && g.tick < 30 * 360) {
      for (const ai of ais) for (const input of ai.think(g)) {
        assert.ok(input.type === 'rudder' || input.type === 'fire');
        applyInput(g, ai.ship, input);
      }
      step(g);
    }
    assert.ok(g.winner === BLUE || g.winner === RED || g.winner === DRAW, `seed ${seed} unfinished`);
  }
});
