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
//   The host's page asks for a 5-tick input delay (?delay=5) and the guest's doesn't:
//   the guest must play the host's delay, sent in the start message.
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
  await host.goto(`${BASE}?room=${room}&host${q}&delay=5`);
  await host.waitForFunction(() => typeof woodenShipsDebug === 'function');
  await guest.goto(`${BASE}?room=${room}${q}`);
  const dbg = (p) => p.evaluate(() => woodenShipsDebug());

  // The countdown says which ship is yours.
  await guest.waitForFunction(() => woodenShipsDebug().phase === 'countdown', null, { timeout: 8000 });
  const [hc, gc] = await Promise.all([dbg(host), dbg(guest)]);
  check(/you are blue/.test(hc.overlay?.sub ?? ''), `host's countdown says blue (${hc.overlay?.sub})`);
  check(/you are red/.test(gc.overlay?.sub ?? ''), `guest's countdown says red (${gc.overlay?.sub})`);
  check(hc.status === 'playing' && gc.status === 'playing', `both sessions playing (${hc.status}/${gc.status})`);
  check(hc.delay === 5 && gc.delay === 5, `the guest plays the host's ?delay=5 (${hc.delay}/${gc.delay})`);
  let a, b;
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => woodenShipsDebug().phase === 'play', null, { timeout: 8000 })));

  // The guest's view is turned round: each player's ship starts in the
  // lower half of their own screen.
  [a, b] = await Promise.all([dbg(host), dbg(guest)]);
  check(!a.view.flip && b.view.flip, `only the guest's view is turned round (${a.view.flip}/${b.view.flip})`);
  check(a.screen[0].y > a.size[1] / 2, `host's ship starts in the lower half of the host's screen (y ${Math.round(a.screen[0].y)} of ${a.size[1]})`);
  check(b.screen[1].y > b.size[1] / 2, `guest's ship starts in the lower half of the guest's screen (y ${Math.round(b.screen[1].y)} of ${b.size[1]})`);
  check(b.screen[0].y < b.size[1] / 2, `host's ship is in the upper half of the guest's screen (y ${Math.round(b.screen[0].y)})`);
  const out = (f) => path.join(process.env.SHOTS ?? os.tmpdir(), f);
  await host.screenshot({ path: out('wooden-ships-net-host-start.png') });
  await guest.screenshot({ path: out('wooden-ships-net-guest-start.png') });

  // Each of the guest's fire buttons fires the battery that points to its
  // side of the guest's (turned) screen. Red starts heading south, so an
  // unturned button mapping would get this backwards.
  const rad = (h) => (h * Math.PI * 2) / 65536;
  /** The screen x of a battery's direction (port 0, starboard 1) on this screen. */
  const screenDirX = (d, ship, battery) => {
    const x = -Math.sin(rad(d.ships[ship].heading)) * (battery === 1 ? 1 : -1);
    return d.view.flip ? -x : x;
  };
  for (const [btn, sideName] of [[0, 'left'], [1, 'right']]) {
    const before = await dbg(guest);
    const spot = before.buttons[btn];
    await guest.mouse.click(spot.x, spot.y);
    let fired = -1, d;
    for (let i = 0; i < 30 && fired < 0; i++) {
      await guest.waitForTimeout(100);
      d = await dbg(guest);
      fired = d.ships[1].reload.findIndex((r, k) => r > 0 && before.ships[1].reload[k] === 0);
    }
    const dx = fired >= 0 ? screenDirX(d, 1, fired) : NaN;
    check(fired >= 0 && (btn === 0 ? dx < -0.5 : dx > 0.5),
      `guest's ${sideName} button fires the battery facing screen ${sideName} (battery ${fired}, screen x ${dx.toFixed?.(2)})`);
  }

  // Drag right on the guest's screen: the bow swings toward screen right.
  {
    const d0 = await dbg(guest);
    const bowX = (d) => Math.cos(rad(d.ships[1].heading)) * (d.view.flip ? -1 : 1);
    const [w, h] = d0.size;
    await guest.mouse.move(w / 2, h * 0.45);
    await guest.mouse.down();
    await guest.mouse.move(w / 2 + 60, h * 0.45, { steps: 4 });
    await guest.waitForTimeout(1500);
    const d1 = await dbg(guest);
    await guest.mouse.up();
    check(d1.ships[1].rudder > 0 && bowX(d1) > bowX(d0) + 0.05,
      `guest's drag right swings the bow toward screen right (rudder ${d1.ships[1].rudder}, bow screen x ${bowX(d0).toFixed(2)} → ${bowX(d1).toFixed(2)})`);
    for (let i = 0; i < 20 && (await dbg(guest)).ships[1].rudder !== 0; i++) await guest.waitForTimeout(100);
  }

  // Each steers its own ship: host hard to starboard, guest hard to port.
  // Both tabs must see both rudders, and neither tab's key may move the other ship.
  await host.keyboard.down('ArrowRight');
  await guest.keyboard.down('ArrowLeft');
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
  const f0 = (await dbg(host)).fired;
  await host.keyboard.press('z');
  await host.waitForTimeout(300);
  for (let i = 0; i < 40; i++) {
    await host.waitForTimeout(100);
    [a, b] = await Promise.all([dbg(host), dbg(guest)]);
    if (a.fired[0] > f0[0] && b.fired[0] > f0[0]) break;
  }
  check(a.fired[0] > f0[0] && b.fired[0] > f0[0] && a.fired[1] === f0[1] && b.fired[1] === f0[1], `host's Z fires blue's guns only, on both tabs (fired ${f0} → ${a.fired}/${b.fired})`);
  // The guest's buttons fired both sides above: wait out the reload.
  await guest.waitForFunction(() => woodenShipsDebug().ships[1].reload.every((r) => r === 0), null, { timeout: 8000 });
  const f1 = (await dbg(guest)).fired;
  await guest.keyboard.press('z');
  for (let i = 0; i < 40; i++) {
    await host.waitForTimeout(100);
    [a, b] = await Promise.all([dbg(host), dbg(guest)]);
    if (a.fired[1] > f1[1] && b.fired[1] > f1[1]) break;
  }
  check(a.fired[1] > f1[1] && b.fired[1] > f1[1], `guest's Z fires red's guns, on both tabs (fired ${f1} → ${a.fired}/${b.fired})`);

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

  await host.screenshot({ path: out('wooden-ships-net-host.png') });
  await guest.screenshot({ path: out('wooden-ships-net-guest.png') });
  console.log(`screenshots in ${process.env.SHOTS ?? os.tmpdir()}`);

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
