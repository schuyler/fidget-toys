// Checks Wooden Ships in a browser: menus, a CPU game in portrait and
// landscape, steering, the screen-relative fire buttons, the camera and its
// off-screen arrow, and the end screen.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1)
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: node wooden-ships/tools/e2e-local.cjs
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/wooden-ships/';
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = async (viewport, query = '', settings = null) => {
    const ctx = await browser.newContext({ viewport });
    if (settings) await ctx.addInitScript((s) => localStorage.setItem('wooden-ships-settings-v1', s), JSON.stringify(settings));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(`${BASE}?debug${query}`);
    await p.waitForFunction(() => typeof woodenShipsDebug === 'function' && document.querySelector('#start[open]'));
    return p;
  };
  const dbg = (p) => p.evaluate(() => woodenShipsDebug());

  // 1. Settings offer the five presets.
  {
    const p = await page({ width: 390, height: 780 });
    await p.click('#start-settings');
    const groups = await p.$$eval('#settings-form .opts', (els) => els.map((e) => [...e.querySelectorAll('input')].map((i) => `${i.name}=${i.value}`).join(',')));
    check(groups.length === 5, `five settings rows (got ${groups.length})`);
    check(groups[0] === 'mode=cpu-easy,mode=cpu', `opponents are CPU easy and hard (got ${groups[0]})`);
  }

  // 2. A game runs in portrait and landscape, on the same sea.
  for (const vp of [{ width: 390, height: 780 }, { width: 900, height: 480 }]) {
    const p = await page(vp, '&seed=42');
    await p.click('#start-new');
    await p.waitForFunction(() => woodenShipsDebug().phase === 'play', null, { timeout: 6000 });
    const a = await dbg(p);
    await p.waitForTimeout(1500);
    let b = await dbg(p);
    // Easy steers in coarse steps, so heading straight for its goal it can hold the helm still for a while.
    const acted = (d) => d.ships[1].rudder !== 0 || d.ships[1].heading !== a.ships[1].heading || d.fired[1] > 0;
    for (let i = 0; i < 150 && !acted(b); i++) { // up to 30 s more: they start bow-on, so the guns can't bear until they meet
      await p.waitForTimeout(200);
      b = await dbg(p);
    }
    check(a.sea[0] === 2992 && a.sea[1] === 2992, `${vp.width}x${vp.height}: sea is 136 × 136 tiles whatever the screen (got ${a.sea.join('×')} m)`);
    check(b.tick > a.tick + 30, `${vp.width}x${vp.height}: game advances (${a.tick} → ${b.tick})`);
    check(acted(b), `${vp.width}x${vp.height}: CPU steers or fires`);

    // Steering: drag right swings the bow toward screen right (heading up the screen at the start in portrait).
    const before = await dbg(p);
    await p.mouse.move(vp.width / 2, vp.height / 2);
    await p.mouse.down();
    await p.mouse.move(vp.width / 2 + 60, vp.height / 2, { steps: 5 });
    await p.waitForTimeout(250);
    const mid = await dbg(p);
    await p.mouse.up();
    await p.waitForTimeout(150);
    const after = await dbg(p);
    const expect = before.leftIsStarboard ? -100 : 100;
    check(mid.ships[0].rudder === expect, `${vp.width}x${vp.height}: drag right sets rudder ${expect} (got ${mid.ships[0].rudder})`);
    check(after.ships[0].rudder === 0, `${vp.width}x${vp.height}: letting go centres the rudder`);

    // Left fire button fires the battery facing screen left.
    const pre = await dbg(p);
    await p.mouse.click(50, vp.height - 70);
    await p.waitForTimeout(200);
    const post = await dbg(p);
    const bat = pre.leftIsStarboard ? 1 : 0;
    check(post.ships[0].reload[bat] > 0 && post.ships[0].reload[1 - bat] === pre.ships[0].reload[1 - bat], `${vp.width}x${vp.height}: left button fires the ${bat ? 'starboard' : 'port'} side (facing screen left)`);
  }

  // 3. The camera follows your ship; an arrow points at the CPU when it's off screen.
  {
    const p = await page({ width: 390, height: 844 }, '&seed=5');
    await p.click('#start-new');
    await p.waitForFunction(() => woodenShipsDebug().phase === 'play', null, { timeout: 6000 });
    const inView = (d, s) => s.x > d.view.x && s.x < d.view.x + d.view.w && s.y > d.view.y && s.y < d.view.y + d.view.h;
    let d = await dbg(p);
    check(Math.abs(d.view.w - 450) < 1, `zoomed: 450 m across the short side (got ${Math.round(d.view.w)})`);
    check(d.view.w < d.sea[0] || d.view.h < d.sea[1], 'the sea is bigger than the screen');
    await p.evaluate(() => { const s = woodenShipsDebug().sea; woodenShipsDebugSet(1, { x: 150, y: 150 }); woodenShipsDebugSet(0, { x: s[0] - 200, y: s[1] - 300 }); });
    await p.waitForTimeout(2500);
    d = await dbg(p);
    check(inView(d, d.ships[0]), 'camera has followed your ship across the sea');
    check(!inView(d, d.ships[1]) && !!d.view.arrow, `arrow shows the off-screen CPU (${d.view.arrow && d.view.arrow.dist} m)`);
    await p.evaluate(() => { const s = woodenShipsDebug().ships[0]; woodenShipsDebugSet(1, { x: s.x - 120, y: s.y - 150 }); });
    await p.waitForTimeout(1500);
    d = await dbg(p);
    check(inView(d, d.ships[1]) && !d.view.arrow, 'no arrow once the CPU is on screen');
  }

  // 4. Pause menu pauses and resumes.
  {
    const p = await page({ width: 390, height: 780 }, '&seed=3');
    await p.click('#start-new');
    await p.waitForFunction(() => woodenShipsDebug().phase === 'play', null, { timeout: 6000 });
    await p.click('#btn-menu');
    const t0 = (await dbg(p)).tick;
    await p.waitForTimeout(600);
    const t1 = (await dbg(p)).tick;
    check(t0 === t1, `paused game holds still (${t0} → ${t1})`);
    await p.click('#pause-resume');
    await p.waitForTimeout(600);
    check((await dbg(p)).tick > t1, 'resumed game moves again');
  }

  // 5. A game ends with a winner and the end screen. Blue is down to 2 crew and
  // the CPU alongside on the same course: on the big sea, a blue ship nobody
  // steers can otherwise sail away from it for minutes (see RULES.md, Notes).
  {
    const p = await page({ width: 390, height: 780 }, '&seed=9', { mode: 'cpu', islands: 'some', wind: 'shifty', shadow: 'on', crew: '3' });
    await p.click('#start-new');
    await p.waitForFunction(() => woodenShipsDebug().phase === 'play', null, { timeout: 6000 });
    await p.evaluate(() => {
      const s = woodenShipsDebug().ships[0];
      woodenShipsDebugSet(0, { crew: 2, vx: 0, vy: -3 });
      woodenShipsDebugSet(1, { x: s.x + 150, y: s.y, heading: s.heading, vx: 0, vy: -3 });
    });
    const done = await p.waitForFunction(() => woodenShipsDebug().phase === 'over', null, { timeout: 60000 }).then(() => true, () => false);
    const d = await dbg(p);
    check(done && d.winner >= 0, `game finishes against the hard CPU with nobody steering blue (winner ${d.winner}, ${Math.round(d.tick / 30)} s)`);
  }

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})();
