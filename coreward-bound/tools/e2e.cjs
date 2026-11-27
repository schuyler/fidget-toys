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
    await p.waitForTimeout(100);
    await p.mouse.click(vp.width / 2, vp.height / 2);
    await p.waitForTimeout(200);
    const aimed = await p.evaluate(() => window.corewardDebug.view.preview?.to ?? -1);
    check(aimed === target, `${name}: tapping a reachable hex aims there (${aimed} vs ${target})`);
    check(/on target/.test(await p.textContent('#panel')), `${name}: panel shows the odds`);
    if (shots) await p.screenshot({ path: `${shots}/aim-${name}.png` });
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
    const cpuMoved = await p.evaluate(() => window.corewardDebug.game.stacks.some((s) => s.owner === 1 && s.cell !== window.corewardDebug.game.civs[1].home));
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
