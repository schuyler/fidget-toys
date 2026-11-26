// Plays a network game between two tabs (BroadcastChannel transport) and
// checks that both devices compute the same game.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1)
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: node dot-army/tools/e2e-two-tab.cjs
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/dot-army/';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const errors = [];
  const host = await ctx.newPage();
  const guest = await ctx.newPage();
  for (const p of [host, guest]) p.on('pageerror', (e) => errors.push(e.message));
  const room = 'T' + Math.floor(Math.random() * 1000);
  await host.goto(`${BASE}?room=${room}&host&debug`);
  await host.waitForTimeout(500);
  await guest.goto(`${BASE}?room=${room}&debug`);
  await host.waitForTimeout(4500); // countdown

  // Each player drags their own marker (bottom of their own screen) upward.
  const drag = (page) => page.evaluate(async () => {
    const c = document.getElementById('game');
    const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, pointerType: 'touch', bubbles: true }));
    fire('pointerdown', 205, 670);
    for (let i = 1; i <= 12; i++) { fire('pointermove', 205 - i * 4, 670 - i * 22); await new Promise((r) => setTimeout(r, 16)); }
    fire('pointerup', 157, 406);
  });
  await drag(host);
  await drag(guest);

  let failures = 0;
  for (let i = 0; i < 6; i++) {
    await host.waitForTimeout(2500);
    let a, b, tries = 0;
    do {
      [a, b] = await Promise.all([host.evaluate(() => dotArmyDebug()), guest.evaluate(() => dotArmyDebug())]);
    } while (a.tick !== b.tick && ++tries < 50);
    const verdict = a.tick !== b.tick ? 'ticks differ' : a.hash === b.hash ? 'MATCH' : 'DIFFERENT';
    if (verdict === 'DIFFERENT' || a.desync >= 0 || b.desync >= 0) failures++;
    console.log(`tick ${a.tick}/${b.tick}  ${verdict}  status ${a.status}/${b.status}  desync ${a.desync}/${b.desync}`);
  }
  const out = (f) => path.join(os.tmpdir(), f);
  await host.screenshot({ path: out('dot-army-net-host.png') });
  await guest.screenshot({ path: out('dot-army-net-guest.png') });
  console.log(`screenshots in ${os.tmpdir()}`);
  console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
  await browser.close();
  process.exit(failures || errors.length ? 1 : 0);
})();
