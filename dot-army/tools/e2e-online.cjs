// Plays Dot Army online the way a person would: Play online, share the link,
// join by code or by link, leave, and the error screens.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1),
// a relay, and Playwright (preinstalled in Claude Code cloud sessions).
// Usage:
//   RELAY=ws://127.0.0.1:8788 node dot-army/tools/e2e-online.cjs   # local relay (the default)
//   RELAY=default node dot-army/tools/e2e-online.cjs               # the game's built-in relay
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/dot-army/';
const RELAY = process.env.RELAY ?? 'ws://127.0.0.1:8788';
const relayParam = RELAY === 'default' ? '' : `&relay=${encodeURIComponent(RELAY)}`;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const origin = new URL(BASE).origin;
  async function page(url = `${BASE}?debug${relayParam}`) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    return p;
  }
  const dbg = (p) => p.evaluate(() => dotArmyDebug());
  async function waitStatus(p, status, ms = 8000) {
    const end = Date.now() + ms;
    let d;
    while (Date.now() < end) { d = await dbg(p); if (d.status === status) return true; await sleep(100); }
    return false;
  }
  /** Polls until `playing`; true if the no-host message showed up on the way. */
  async function sawNoHost(p, ms = 8000) {
    const end = Date.now() + ms;
    let seen = false, d;
    while (Date.now() < end) {
      d = await dbg(p);
      if (d.overlay?.lines?.[0] === 'NO ONE') seen = true;
      if (d.status === 'playing') break;
      await sleep(100);
    }
    return seen;
  }
  const startMenuOpen = (p) => p.evaluate(() => document.getElementById('start').open);
  async function hostRoom() {
    const host = await page();
    await host.click('#start-online');
    await host.waitForSelector('[data-lobby=code]', { state: 'visible' });
    const code = (await host.textContent('[data-lobby=code]')).trim();
    const link = (await host.textContent('[data-lobby=link]')).trim();
    return { host, code, link };
  }
  async function joinByCode(code) {
    const p = await page();
    await p.click('#start-join');
    await p.fill('[data-lobby=input]', code);
    await p.click('[data-lobby=join]');
    return p;
  }

  // R1: Play online shows a code and a link; Share copies the link (no share sheet headless).
  const { host, code, link } = await hostRoom();
  check(/^[A-Z0-9]{4}$/.test(code), `R1: room code shown (${code})`);
  check(link.includes(`room=${code}`), `R1: link contains the code (${link})`);
  await host.click('[data-lobby=share]');
  await sleep(300);
  const copied = await host.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check(copied === link, 'R1: Share copies the link');

  // R2: the guest joins by typing the code; both play the same game.
  const guest = await joinByCode(code);
  check(!(await sawNoHost(guest)), 'J2: no "no host" message when the host is there (join by code)');
  check(await waitStatus(host, 'playing') && await waitStatus(guest, 'playing'), 'R2: both reach playing after join by code');
  check(!(await host.evaluate(() => document.getElementById('lobby').open)), 'R2: the lobby closes when the game starts');
  await sleep(5000); // countdown plus some play, and more than two ping intervals
  let same = 0, a, b;
  for (let i = 0; i < 4; i++) { // a few samples at equal ticks
    let tries = 0;
    do { [a, b] = await Promise.all([dbg(host), dbg(guest)]); } while (a.tick !== b.tick && ++tries < 100);
    if (a.tick === b.tick && a.tick > 0 && a.hash === b.hash) same++;
    else if (a.tick === b.tick) break; // a real mismatch
    await sleep(500);
  }
  check(same >= 3, `R2: same game on both (${same}/4 samples matched, last tick ${a.tick}/${b.tick})`);

  // R7: the debug panel and the transport stats.
  const panel = await host.textContent('[data-netpanel]').catch(() => null);
  check(!!panel && /relay open/.test(panel) && /rtt (\d+ ms|–)/.test(panel) && /out \d+ \/ in \d+/.test(panel) && /last close/.test(panel),
    `R7: panel shows state, rtt, counts and last close (${panel})`);
  const s1 = (await dbg(host)).net;
  await sleep(2500);
  const s2 = (await dbg(host)).net;
  check(s2 && Number.isFinite(s2.rtt), `R7: round-trip time measured (${s2?.rtt})`);
  check(s1 && s2 && s2.sent > s1.sent && s2.received > s1.received, 'R7: message counts grow');

  // R5: a third device joining a full room is told so.
  const third = await joinByCode(code);
  check(await waitStatus(third, 'full'), 'R5: third device sees ROOM FULL');
  check((await dbg(host)).status === 'playing', 'R5: the host is undisturbed by the refused third device');

  // R4: the guest leaves; the host is told and can get back to the menu.
  await guest.close();
  check(await waitStatus(host, 'left'), 'R4: host sees OPPONENT LEFT');
  await sleep(1000);
  await host.mouse.click(195, 400);
  await sleep(300);
  check(await startMenuOpen(host) && (await dbg(host)).status === undefined, 'R4: a tap returns to the start menu');

  // R6 (and R1's link): a guest who opened the shared link leaves from the pause menu.
  const r2 = await hostRoom();
  const linkGuest = await page(`${r2.link}${r2.link.includes('?') ? '&' : '?'}debug`);
  check(!(await sawNoHost(linkGuest)), 'J2: no "no host" message when the host is there (join by link)');
  check(await waitStatus(linkGuest, 'playing') && await waitStatus(r2.host, 'playing'), 'R1: the shared link joins as guest');
  await linkGuest.click('#btn-menu');
  await linkGuest.click('#pause-leave');
  await sleep(300);
  check(await startMenuOpen(linkGuest), 'R6: Leave game returns to the start menu');
  check(await waitStatus(r2.host, 'left'), 'R6: the other player sees OPPONENT LEFT');

  // J1: a guest who joins a code nobody is hosting is told so within a few
  // seconds, and keeps waiting: a host who opens the room later still starts it.
  {
    const orphanCode = 'N' + Math.floor(100 + Math.random() * 900);
    const lone = await joinByCode(orphanCode);
    const clicked = Date.now();
    let d;
    do { d = await dbg(lone); if (d.overlay?.lines?.[0] === 'NO ONE') break; await sleep(100); } while (Date.now() - clicked < 6000);
    check(JSON.stringify(d.overlay?.lines) === JSON.stringify(['NO ONE', 'HERE YET']) && d.status === 'lobby',
      `J1: NO ONE HERE YET within 6 s of joining (${JSON.stringify(d.overlay)}, ${d.status})`);
    check(!!d.overlay?.sub?.includes(orphanCode) && /☰/.test(d.overlay?.sub ?? ''), `J1: the message names room ${orphanCode} and how to leave`);
    const lateHost = await page(`${BASE}?room=${orphanCode}&host&debug${relayParam}`);
    check(await waitStatus(lone, 'playing') && await waitStatus(lateHost, 'playing'), 'J1: a host who arrives later still starts the game');
    await lone.close();
    await lateHost.close();
  }

  // R5: an unreachable relay is reported.
  const lost = await page(`${BASE}?room=ZZZZ&debug&relay=${encodeURIComponent('ws://127.0.0.1:1')}`);
  check(await waitStatus(lost, 'unreachable'), "R5: unreachable relay shows CAN'T REACH THE SERVER");

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures.length ? 'FAIL' : 'PASS');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e.message); console.log('FAIL'); process.exit(1); });
