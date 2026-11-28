// Plays an online Wooden Ships game between two tabs and checks that both
// devices compute the same game: each steers and fires only its own ship,
// a pause on one makes the other wait, and the state hashes match.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1)
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: node wooden-ships/tools/e2e-two-tab.cjs
//   Two tabs talk over a BroadcastChannel (?relay=bc). With RELAY=ws://127.0.0.1:8788
//   (node multiplayer/server.js running) they go through that relay instead, in
//   separate browser contexts, and the test also checks that leaving tells the other side.
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/wooden-ships/';
const RELAY = process.env.RELAY ?? 'bc';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const ctxB = RELAY === 'bc' ? ctxA : await browser.newContext({ viewport: { width: 390, height: 780 } });
  const host = await ctxA.newPage();
  const guest = await ctxB.newPage();
  for (const p of [host, guest]) {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  }
  const room = 'W' + Math.floor(Math.random() * 1000);
  const q = `&debug&relay=${encodeURIComponent(RELAY)}`;
  await host.goto(`${BASE}?room=${room}&host${q}`);
  await host.waitForFunction(() => typeof woodenShipsDebug === 'function');
  await guest.goto(`${BASE}?room=${room}${q}`);
  const dbg = (p) => p.evaluate(() => woodenShipsDebug());

  // The countdown says which ship is yours.
  await guest.waitForFunction(() => woodenShipsDebug().phase === 'countdown', null, { timeout: 8000 });
  const [hc, gc] = await Promise.all([dbg(host), dbg(guest)]);
  check(/you are blue/.test(hc.overlay?.sub ?? ''), `host's countdown says blue (${hc.overlay?.sub})`);
  check(/you are red/.test(gc.overlay?.sub ?? ''), `guest's countdown says red (${gc.overlay?.sub})`);
  check(hc.status === 'playing' && gc.status === 'playing', `both sessions playing (${hc.status}/${gc.status})`);
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => woodenShipsDebug().phase === 'play', null, { timeout: 8000 })));

  // Each steers its own ship: host hard to starboard, guest hard to port.
  // Both tabs must see both rudders, and neither tab's key may move the other ship.
  await host.keyboard.down('ArrowRight');
  await guest.keyboard.down('ArrowLeft');
  let a, b;
  for (let i = 0; i < 40; i++) {
    await host.waitForTimeout(100);
    [a, b] = await Promise.all([dbg(host), dbg(guest)]);
    if ([a, b].every((d) => d.ships[0].rudder === 100 && d.ships[1].rudder === -100)) break;
  }
  check(a.ships[0].rudder === 100 && b.ships[0].rudder === 100, `blue's rudder is the host's, on both tabs (${a.ships[0].rudder}/${b.ships[0].rudder})`);
  check(a.ships[1].rudder === -100 && b.ships[1].rudder === -100, `red's rudder is the guest's, on both tabs (${a.ships[1].rudder}/${b.ships[1].rudder})`);
  await host.keyboard.up('ArrowRight');
  await guest.keyboard.up('ArrowLeft');

  // Each fires a broadside (Z): both tabs count a shot for each side.
  await host.keyboard.press('z');
  await host.waitForTimeout(300);
  for (let i = 0; i < 40; i++) {
    await host.waitForTimeout(100);
    [a, b] = await Promise.all([dbg(host), dbg(guest)]);
    if (a.fired[0] > 0 && b.fired[0] > 0) break;
  }
  check(a.fired[0] > 0 && b.fired[0] > 0 && a.fired[1] === 0 && b.fired[1] === 0, `host's Z fires blue's guns only, on both tabs (fired ${a.fired}/${b.fired})`);
  await guest.keyboard.press('z');
  for (let i = 0; i < 40; i++) {
    await host.waitForTimeout(100);
    [a, b] = await Promise.all([dbg(host), dbg(guest)]);
    if (a.fired[1] > 0 && b.fired[1] > 0) break;
  }
  check(a.fired[1] > 0 && b.fired[1] > 0, `guest's Z fires red's guns, on both tabs (fired ${a.fired}/${b.fired})`);

  // A pause on the host stops the guest too, with WAITING; resuming carries on.
  await host.click('#btn-menu');
  await host.waitForTimeout(1200);
  const g1 = await dbg(guest);
  await host.waitForTimeout(500);
  const g2 = await dbg(guest);
  check(g2.tick === g1.tick, `guest stalls while the host is paused (tick ${g1.tick} → ${g2.tick})`);
  check(g2.overlay?.lines?.[0] === 'WAITING', `guest shows WAITING (${JSON.stringify(g2.overlay?.lines)})`);
  const hp = await host.evaluate(() => ({ leave: !document.getElementById('pause-leave').hidden, settings: !document.getElementById('pause-settings').hidden }));
  check(hp.leave && !hp.settings, `host's pause menu offers Leave game, not Settings (${JSON.stringify(hp)})`);
  await host.click('#pause-resume');
  await host.waitForTimeout(800);
  const g3 = await dbg(guest);
  check(g3.tick > g2.tick && g3.overlay === null, `guest carries on after the host resumes (tick ${g2.tick} → ${g3.tick})`);

  // Same game on both devices: compare state hashes at the same ticks (the
  // two tabs run a few ticks apart, up to the input delay).
  for (let i = 0; i < 4; i++) {
    await host.waitForTimeout(1500);
    [a, b] = await Promise.all([dbg(host), dbg(guest)]);
    const shared = Object.keys(a.hashes).filter((t) => t in b.hashes);
    const differ = shared.filter((t) => a.hashes[t] !== b.hashes[t]);
    check(shared.length > 20 && differ.length === 0 && a.desync < 0 && b.desync < 0,
      `ticks ${a.tick}/${b.tick}: ${shared.length} shared ticks, ${differ.length} differ${differ.length ? ` (first ${differ[0]})` : ''}, desync ${a.desync}/${b.desync}`);
  }

  const out = (f) => path.join(os.tmpdir(), f);
  await host.screenshot({ path: out('wooden-ships-net-host.png') });
  await guest.screenshot({ path: out('wooden-ships-net-guest.png') });
  console.log(`screenshots in ${os.tmpdir()}`);

  // Through a relay: leaving tells the other side (BroadcastChannel has no such event).
  if (RELAY !== 'bc') {
    await guest.click('#btn-menu');
    await guest.click('#pause-leave');
    await host.waitForTimeout(1500);
    const h = await dbg(host);
    check(h.status === 'left' && h.overlay?.lines?.[0] === 'OPPONENT LEFT', `host sees OPPONENT LEFT (${h.status}, ${JSON.stringify(h.overlay?.lines)})`);
    const g = await guest.evaluate(() => !!document.querySelector('#start[open]'));
    check(g, 'guest is back at the start menu');
  }

  console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
  await browser.close();
  console.log(failures || errors.length ? 'FAIL' : 'PASS');
  process.exit(failures || errors.length ? 1 : 0);
})();
