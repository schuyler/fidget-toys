// Checks Dot Army's local (vs CPU) play after the removal of the shared-screen
// two-player mode.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1)
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: node dot-army/tools/e2e-local.cjs
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/dot-army/';
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = async (viewport, init) => {
    const ctx = await browser.newContext({ viewport });
    if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}?debug`);
    return p;
  };

  // 1. Settings offers only CPU opponents.
  {
    const p = await page({ width: 390, height: 780 });
    const modes = await p.$$eval('input[name="mode"]', (els) => els.map((e) => e.value));
    check(JSON.stringify(modes) === JSON.stringify(['cpu-easy', 'cpu']), `settings opponents are cpu-easy, cpu (got ${modes})`);
  }

  // 2. A stored shared-screen setting falls back to Easy CPU.
  {
    const p = await page({ width: 390, height: 780 }, () => {
      localStorage.setItem('dot-army-settings-v2', JSON.stringify({ mode: '2p', size: 'medium', speed: 'average', spawns: 'some', obstacles: 'none' }));
    });
    await p.click('#start-settings');
    const checked = await p.$eval('input[name="mode"]:checked', (e) => e.value).catch(() => null);
    check(checked === 'cpu-easy', `stored mode 2p shows as cpu-easy (got ${checked})`);
  }

  // 3. A CPU game runs in portrait and landscape, and the CPU moves red's marker.
  for (const vp of [{ width: 390, height: 780 }, { width: 900, height: 500 }]) {
    const p = await page(vp);
    await p.click('#start-new');
    await p.waitForTimeout(4000); // countdown
    const a = await p.evaluate(() => dotArmyDebug());
    let b = a, moved = false;
    for (let i = 0; i < 25 && !moved; i++) { // poll up to 5 s for the CPU to move
      await p.waitForTimeout(200);
      b = await p.evaluate(() => dotArmyDebug());
      moved = Array.isArray(b.targets) && b.targets[1] !== a.targets?.[1];
    }
    if (moved) { await p.waitForTimeout(500); b = await p.evaluate(() => dotArmyDebug()); }
    check(b.tick > a.tick, `${vp.width}x${vp.height}: game advances (${a.tick} → ${b.tick})`);
    check(moved, `${vp.width}x${vp.height}: CPU moves red's target`);
  }

  // 4. In portrait, a tap in the top half moves your (blue) marker: the top half no longer belongs to red.
  {
    const p = await page({ width: 390, height: 780 });
    await p.click('#start-new');
    await p.waitForTimeout(3500);
    const before = await p.evaluate(() => dotArmyDebug().targets?.[0]);
    await p.evaluate(() => {
      const c = document.getElementById('game');
      const fire = (type) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: 300, clientY: 150, pointerType: 'touch', bubbles: true }));
      fire('pointerdown'); fire('pointerup');
    });
    await p.waitForTimeout(300);
    const after = await p.evaluate(() => dotArmyDebug().targets?.[0]);
    check(before !== after && after !== undefined, `top-half tap moves blue's target (${before} → ${after})`);
  }

  // 5. Layout: in portrait the board starts near the top (no empty band where a
  // second HUD used to be) and ends above the HUD and ☰; landscape is unchanged.
  {
    const p = await page({ width: 390, height: 844 });
    await p.click('#start-new');
    await p.waitForTimeout(500);
    const b = await p.evaluate(() => dotArmyDebug().board);
    const menuTop = await p.evaluate(() => document.getElementById('btn-menu').getBoundingClientRect().top);
    check(!!b && b.y <= 12, `portrait: board top ${b?.y?.toFixed(1)} is at most 12 px (was ~34)`);
    check(!!b && b.y + b.h <= menuTop, `portrait: board bottom ${(b?.y + b?.h)?.toFixed(1)} is above ☰ (${menuTop})`);
  }
  {
    const cw = 844, ch = 390;
    const p = await page({ width: cw, height: ch });
    await p.click('#start-new');
    await p.waitForTimeout(500);
    const b = await p.evaluate(() => dotArmyDebug().board);
    const near = (x, y) => Math.abs(x - y) < 0.01;
    // Before: fitted into (cw - 20) × (ch - 56), centred horizontally, and
    // vertically in the space below the 38 px HUD strip.
    const fits = !!b && b.w <= cw - 20 + 0.01 && b.h <= ch - 56 + 0.01 && (near(b.w, cw - 20) || near(b.h, ch - 56));
    const placed = !!b && near(b.x, (cw - b.w) / 2) && near(b.y, 38 + (ch - 38 - b.h) / 2);
    check(fits && placed, `landscape: board placed as before (${JSON.stringify(b)})`);
  }

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures.length ? 'FAIL' : 'PASS');
  process.exit(failures.length ? 1 : 0);
})();
