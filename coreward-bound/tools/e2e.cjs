// Plays Coreward Bound in a browser: taps a stack, aims, jumps, ends turns
// and watches the CPU move, in portrait and landscape. Then plays a whole
// game with a CPU at your seat, to check nothing breaks on the way to a win.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1)
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: node coreward-bound/tools/e2e.cjs [screenshot-dir]
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/coreward-bound/';
const shots = process.argv[2];
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const open = async (viewport) => {
    const p = await browser.newPage({ viewport });
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(`${BASE}?debug&fast`);
    await p.click('#start-new');
    await p.waitForTimeout(300);
    return p;
  };
  /** Screen position of a cell, by asking the page. */
  const cellXY = (p, cell) => p.evaluate((c) => {
    const d = window.corewardDebug;
    d.renderer.centerOn(c, { dur: 1 });
    return { x: innerWidth / 2, y: innerHeight / 2 };
  }, cell);

  for (const [name, vp] of [['portrait', { width: 390, height: 780 }], ['landscape', { width: 1000, height: 640 }]]) {
    const p = await open(vp);
    const home = await p.evaluate(() => window.corewardDebug.game.civs[0].home);
    let xy = await cellXY(p, home);
    await p.waitForTimeout(100);
    await p.mouse.click(xy.x, xy.y);
    await p.waitForTimeout(200);
    check(await p.isVisible('#panel'), `${name}: tapping home opens the panel`);
    const text = await p.textContent('#panel');
    check(/Your home/.test(text) && /4 ready/.test(text), `${name}: panel shows home and 4 ready fleets`);
    // aim at a reachable hex two away
    const target = await p.evaluate(() => {
      const d = window.corewardDebug;
      return [...d.view.reach].find((c) => d.game.terrain[c] !== 0) ?? [...d.view.reach][0];
    });
    check(target !== undefined, `${name}: there are hexes in reach`);
    await p.evaluate((t) => { window.corewardDebug.renderer.centerOn(t, { dur: 1 }); }, target);
    await p.waitForTimeout(600);
    const probe = () => p.evaluate(() => { const r = window.corewardDebug.renderer; return [[40, 90], [innerWidth - 40, 90], [innerWidth / 2, innerHeight / 3]].map(([x, y]) => r.cellAtScreen(x, y)).join(); });
    const beforeAim = await probe();
    await p.mouse.click(vp.width / 2, vp.height / 2);
    await p.waitForTimeout(600);
    check(await probe() === beforeAim, `${name}: aiming doesn't move the map`);
    const aimed = await p.evaluate(() => window.corewardDebug.view.preview?.to ?? -1);
    check(aimed === target, `${name}: tapping a reachable hex aims there (${aimed} vs ${target})`);
    check(/on target/.test(await p.textContent('#panel')), `${name}: panel shows the odds`);
    if (shots) await p.screenshot({ path: `${shots}/aim-${name}.png` });
    // tapping the aimed hex again cancels the aim; nothing jumps and the map stays put
    // find a spot on the aimed hex that the panel isn't covering
    await p.evaluate((t) => window.corewardDebug.renderer.reveal([t], document.getElementById('panel').getBoundingClientRect().top - 12), target);
    await p.waitForTimeout(500);
    const spot = await p.evaluate(async (t) => {
      const d = window.corewardDebug;
      const top = document.getElementById('panel').getBoundingClientRect().top;
      for (let y = 60; y < top - 4; y += 6) for (let x = 10; x < innerWidth - 10; x += 6) if (d.renderer.cellAtScreen(x, y) === t) return { x, y };
      return null;
    }, target);
    check(spot !== null, `${name}: the aimed hex is visible above the panel`);
    await p.mouse.click(spot.x, spot.y);
    await p.waitForTimeout(200);
    const cancelled = await p.evaluate(() => {
      const d = window.corewardDebug, g = d.game;
      return { preview: d.view.preview, moved: g.stacks.filter((s) => s.owner === 0).length !== 1 || g.stacks.find((s) => s.owner === 0).fleets !== 4 };
    });
    check(cancelled.preview === null && !cancelled.moved, `${name}: tapping the aimed hex again cancels, no jump`);
    await p.mouse.click(spot.x, spot.y);
    await p.waitForTimeout(200);
    // send two, by the stepper
    await p.click('[data-act="less"]');
    await p.click('[data-act="less"]');
    await p.click('[data-act="jump"]');
    await p.waitForTimeout(300);
    const after = await p.evaluate(() => {
      const g = window.corewardDebug.game;
      return { atHome: g.stacks.find((s) => s.owner === 0 && s.cell === g.civs[0].home)?.fleets ?? 0, stacks: g.stacks.filter((s) => s.owner === 0).length };
    });
    check(after.atHome === 2, `${name}: two fleets stayed home (${after.atHome})`);
    // end turn, CPU moves, back to us
    await p.click('#btn-end');
    await p.waitForFunction(() => { const g = window.corewardDebug.game; return g.current === 0 && !document.querySelector('#btn-end').disabled; }, null, { timeout: 15000 });
    const round = await p.textContent('#hud-turn');
    check(/Round 2/.test(round), `${name}: back to you in round 2 (${round})`);
    await p.waitForTimeout(700); // the fit glide
    const unseen = await p.evaluate(() => {
      const d = window.corewardDebug, g = d.game, seen = new Set();
      for (let y = 50; y < innerHeight - 70; y += 5) for (let x = 5; x < innerWidth - 5; x += 5) seen.add(d.renderer.cellAtScreen(x, y));
      const mine = [...g.stacks.filter((s) => s.owner === 0).map((s) => s.cell), ...[...g.owner.keys()].filter((i) => g.owner[i] === 0)];
      return mine.filter((c) => !seen.has(c)).length;
    });
    check(unseen === 0, `${name}: your turn starts with all your settlements and stacks on screen (${unseen} off screen)`);
    check(await p.locator('#hud .ico.coin').count() === 2 && await p.locator('#hud .ico.flask').count() === 2, `${name}: the top bar shows the coin and flask for both sides`);
    // it may have settled on arrival or lost fleets in space, so: not "four fleets at home, nothing else"
    const cpuMoved = await p.evaluate(() => {
      const g = window.corewardDebug.game;
      const st = g.stacks.filter((s) => s.owner === 1);
      return st.some((s) => s.cell !== g.civs[1].home) || st.reduce((n, s) => n + s.fleets, 0) < 4 || g.owner.some((o, i) => o === 1 && i !== g.civs[1].home);
    });
    check(cpuMoved, `${name}: the CPU moved out from home`);
    if (shots) await p.screenshot({ path: `${shots}/round2-${name}.png` });
    // settings and rules open
    await p.click('#btn-menu');
    await p.click('#pause-rules');
    check(await p.isVisible('#rules'), `${name}: rules open from the menu`);
    await p.click('#rules button[value="back"]');
    await p.click('#pause-resume');
    await p.close();
  }

  // Next: visits everything open, then greys out while End turn pulses
  {
    const p = await open({ width: 800, height: 700 });
    check(!(await p.isDisabled('#btn-next')), 'Next is enabled at the start of the turn');
    const seen = new Set();
    for (let i = 0; i < 30 && !(await p.isDisabled('#btn-next')); i++) {
      await p.click('#btn-next');
      await p.waitForTimeout(50);
      seen.add(await p.evaluate(() => window.corewardDebug.view.selected));
    }
    check(seen.size >= 1 && await p.isDisabled('#btn-next'), `Next greys out after visiting everything (${seen.size} cells)`);
    check(await p.evaluate(() => document.querySelector('#btn-end').classList.contains('pulse')), 'End turn pulses when all is handled');
    await p.click('#btn-end');
    await p.waitForFunction(() => window.corewardDebug.game.current === 0 && !document.querySelector('#btn-end').disabled, null, { timeout: 15000 });
    check(!(await p.isDisabled('#btn-next')), 'Next is enabled again on the next turn');
    await p.close();
  }

  // How to play: every page fits without scrolling; the compare card opens from the HUD
  for (const vp of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const p = await open(vp);
    await p.click('#btn-menu');
    await p.click('#pause-rules');
    const total = await p.locator('#rules .page').count();
    check(/^1 \//.test(await p.textContent('#page-num')) && total >= 3, `${vp.width}x${vp.height}: rules open at page 1 of ${total}`);
    const heights = [];
    for (let i = 0; i < total; i++) {
      const m = await p.evaluate(() => { const d = document.getElementById('rules'); return [d.scrollHeight, d.clientHeight]; });
      heights.push(`${m[0]}/${m[1]}`);
      check(m[0] <= m[1], `${vp.width}x${vp.height}: rules page ${i + 1} fits (${m[0]} <= ${m[1]})`);
      if (i < total - 1) await p.click('[aria-label="Next page"]');
    }
    await p.click('#rules button[value="back"]');
    await p.click('#pause-resume');
    await p.click('#civ-cpu');
    check(await p.isVisible('#compare') && /Banked RP/.test(await p.textContent('#compare')), `${vp.width}x${vp.height}: tapping the HUD opens the compare card`);
    await p.click('#compare button[value="close"]');
    if (shots) await p.screenshot({ path: `${shots}/hud-${vp.width}.png` });
    await p.close();
  }

  // a whole game, with the CPU's own brain playing your side through the page's actions
  {
    const p = await open({ width: 800, height: 700 });
    await p.addScriptTag({ type: 'module', content: `
      import { createAI } from './src/ai.js';
      window.__me = createAI(0, 99, { level: 'hard' });
    ` });
    await p.waitForFunction(() => window.__me);
    const result = await p.evaluate(async () => {
      const d = window.corewardDebug;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let guard = 0; guard < 4000 && d.game.winner < 0; guard++) {
        if (d.game.current !== 0 || document.querySelector('#btn-end').disabled) { await wait(20); continue; }
        const a = window.__me.next(d.game);
        if (a.kind === 'end') d.endTurn();
        else d.act(a);
        await wait(2);
      }
      return { winner: d.game.winner, by: d.game.winBy, rounds: d.game.turn >> 1 };
    });
    check(result.winner >= 0, `a full game finishes (winner ${result.winner} by ${result.by} in ${result.rounds} rounds)`);
    await p.waitForTimeout(400);
    check(await p.isVisible('#over'), 'the game-over card shows');
    if (shots) await p.screenshot({ path: `${shots}/over.png` });
    await p.close();
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
  if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
})();
