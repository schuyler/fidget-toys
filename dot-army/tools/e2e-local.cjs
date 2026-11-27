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
    await p.waitForTimeout(5000);
    const b = await p.evaluate(() => dotArmyDebug());
    check(b.tick > a.tick, `${vp.width}x${vp.height}: game advances (${a.tick} → ${b.tick})`);
    check(Array.isArray(b.targets) && a.targets[1] !== b.targets[1], `${vp.width}x${vp.height}: CPU moves red's target`);
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

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures.length ? 'FAIL' : 'PASS');
  process.exit(failures.length ? 1 : 0);
})();
