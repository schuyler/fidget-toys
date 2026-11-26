// Plays a Dot Army network game between two pages that can only reach each
// other through a relay server, and checks both compute the same game.
// The pages are in separate browser contexts, so they share no
// BroadcastChannel: if they stay in sync, the relay carried every message.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1),
// a relay running (node multiplayer/server.js, or wrangler dev in multiplayer/),
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: RELAY=ws://127.0.0.1:8788 node multiplayer/tools/e2e-relay.cjs
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/dot-army/';
const RELAY = process.env.RELAY ?? 'ws://127.0.0.1:8788';

(async () => {
  const browser = await chromium.launch();
  const opts = { viewport: { width: 390, height: 780 } };
  const [hostCtx, guestCtx] = [await browser.newContext(opts), await browser.newContext(opts)];
  const errors = [];
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  for (const p of [host, guest]) {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`console: ${m.text()}`); });
  }
  const room = 'R' + Math.floor(Math.random() * 10000);
  const relay = encodeURIComponent(RELAY);
  await host.goto(`${BASE}?room=${room}&host&debug&relay=${relay}`);
  await host.waitForTimeout(500);
  await guest.goto(`${BASE}?room=${room}&debug&relay=${relay}`);
  await host.waitForTimeout(4500); // countdown

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
    if (verdict !== 'MATCH' || a.status !== 'playing' || b.status !== 'playing' || a.desync >= 0 || b.desync >= 0 || a.tick < 20) failures++;
    console.log(`tick ${a.tick}/${b.tick}  ${verdict}  status ${a.status}/${b.status}  desync ${a.desync}/${b.desync}`);
  }
  console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
  await browser.close();
  console.log(failures || errors.length ? 'FAIL' : 'PASS');
  process.exit(failures || errors.length ? 1 : 0);
})();
