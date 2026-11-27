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
  await host.goto(`${BASE}?room=${room}&host&debug&relay=bc`);
  await host.waitForTimeout(500);
  await guest.goto(`${BASE}?room=${room}&debug&relay=bc`);
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
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

  // Each tab ADDs (tap empty board), MOVEs (drag it) and REMOVEs (tap it) a target,
  // and only its own colour's targets may change. Same screen points on both tabs
  // (each view is its own): far from both players' markers, which sit at the top and bottom.
  const targetsOf = (page) => page.evaluate(() => dotArmyDebug().targets);
  const gesture = (page, from, to) => page.evaluate(async ([f, t]) => {
    const c = document.getElementById('game');
    const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 3, clientX: x, clientY: y, pointerType: 'touch', bubbles: true }));
    fire('pointerdown', f[0], f[1]);
    if (t) for (let i = 1; i <= 8; i++) { fire('pointermove', f[0] + (t[0] - f[0]) * i / 8, f[1] + (t[1] - f[1]) * i / 8); await new Promise((r) => setTimeout(r, 16)); }
    fire('pointerup', (t ?? f)[0], (t ?? f)[1]);
  }, [from, to]);
  // Wait until both tabs show the same targets that differ from `before` in colour `own` only.
  const settle = async (before, own, what) => {
    let a, b, prev = '';
    for (let i = 0; i < 40; i++) {
      await host.waitForTimeout(150);
      [a, b] = await Promise.all([targetsOf(host), targetsOf(guest)]);
      const now = JSON.stringify(a);
      // changed, both tabs agree, and unchanged since the last poll (a drag has landed)
      if (JSON.stringify(a[own]) !== JSON.stringify(before[own]) && now === JSON.stringify(b) && now === prev) break;
      prev = now;
    }
    const other = 1 - own;
    check(JSON.stringify(a[own]) !== JSON.stringify(before[own]), `${what}: colour ${own} targets changed (${JSON.stringify(before[own])} -> ${JSON.stringify(a[own])})`);
    check(JSON.stringify(a[other]) === JSON.stringify(before[other]), `${what}: colour ${other} targets untouched`);
    check(JSON.stringify(a) === JSON.stringify(b), `${what}: both tabs agree on targets`);
    return a;
  };
  await host.waitForTimeout(1500); // let the drags above land on both tabs
  for (const [page, own, name] of [[host, 0, 'host'], [guest, 1, 'guest']]) {
    const P1 = [90, 560], P2 = [300, 520];
    let cur = await targetsOf(page);
    await gesture(page, P1);
    cur = await settle(cur, own, `${name} ADD`);
    check(cur[own].length > 1, `${name} ADD: tap on empty board added a target (not moved one)`);
    const before = cur[own];
    await gesture(page, P1, P2);
    cur = await settle(cur, own, `${name} MOVE`);
    const n = cur[own].length;
    check(n === before.length, `${name} MOVE: drag left the target count at ${before.length} (now ${n})`);
    await gesture(page, P2);
    cur = await settle(cur, own, `${name} REMOVE`);
    check(cur[own].length === n - 1, `${name} REMOVE: ${n} -> ${cur[own].length} targets`);
  }

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
