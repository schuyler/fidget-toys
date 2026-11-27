// Plays Star Troopers in a browser through taps and drags only, against the
// CPU, and checks the interface along the way.
//
// Needs: the repo served on port 8765 (python3 -m http.server 8765 --bind 127.0.0.1)
// and Playwright (preinstalled in Claude Code cloud sessions).
// Usage: node star-troopers/tools/e2e-local.cjs [screenshot-dir]
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8765/star-troopers/';
const shots = process.argv[2];
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const open = async (viewport, query = '') => {
    const ctx = await browser.newContext({ viewport, hasTouch: false });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(`${BASE}?debug${query}`);
    return { p, ctx };
  };
  const dbg = (p) => p.evaluate(() => starTroopersDebug());
  const at = (p, cell) => p.evaluate((c) => starTroopersCell(c), cell);
  const onScreen = (vp, [x, y]) => x > 20 && x < vp.width - 20 && y > 60 && y < vp.height - 140;

  // 1. Settings are remembered between visits (R3).
  {
    const { p, ctx } = await open({ width: 390, height: 780 });
    await p.click('#start-settings');
    await p.click('label:has(input[name="you"][value="vell"])');
    await p.click('label:has(input[name="forces"][value="standard"])');
    await p.click('#settings button[value="apply"]');
    await p.waitForTimeout(200);
    const s = await dbg(p);
    check(s.phase === 'plot' && s.units.length === 8, `Vell, Standard forces: 8 units to plot (got ${s.units.length})`);
    await p.reload();
    await p.click('#start-settings');
    const you = await p.$eval('input[name="you"]:checked', (e) => e.value);
    const forces = await p.$eval('input[name="forces"]:checked', (e) => e.value);
    check(you === 'vell' && forces === 'standard', `settings survive a reload (${you}, ${forces})`);
    await p.click('#settings button[value="reset"]');
    await p.waitForTimeout(100);
    await p.click('#settings button[value="apply"]');
    await ctx.close();
  }

  // 2. The map scrolls by dragging empty ground, and zooms out to the whole board (R4).
  {
    const vp = { width: 390, height: 780 };
    const { p, ctx } = await open(vp, '&seed=11');
    await p.click('#start-new');
    await p.waitForTimeout(200);
    const before = await at(p, 0);
    // drag from the middle of the screen (empty ground or not, a press there that moves pans, unless it's on our trooper)
    const from = [195, 300];
    await p.mouse.move(from[0], from[1]);
    await p.mouse.down();
    await p.mouse.move(from[0] + 30, from[1] + 120, { steps: 6 });
    await p.mouse.up();
    const after = await at(p, 0);
    check(Math.abs(after[1] - before[1]) > 50, `dragging empty ground scrolls the map (${before[1].toFixed(0)} → ${after[1].toFixed(0)})`);
    for (let i = 0; i < 20; i++) await p.mouse.wheel(0, 400);
    await p.waitForTimeout(100);
    const s = await dbg(p);
    const corners = await Promise.all([0, 12, 18 * 13, 18 * 13 + 12].map((c) => at(p, c)));
    check(corners.every(([x, y]) => x > 0 && x < vp.width && y > 0 && y < vp.height), `zoomed out (hex ${s.size.toFixed(1)} px), the whole board is on screen`);
    if (shots) await p.screenshot({ path: `${shots}/zoomed-out.png` });
    for (let i = 0; i < 20; i++) await p.mouse.wheel(0, -400);
    await ctx.close();
  }

  // 3. A whole game, through taps and drags only (R1, R5, R6, R8, R9, R11, R13, R15).
  {
    const vp = { width: 390, height: 780 };
    const { p, ctx } = await open(vp, '&seed=21');
    await p.click('#start-new');
    await p.waitForTimeout(200);
    let stages = 0, moved = 0, fired = 0, popovers = 0, presets = 0, selectedOk = 0;
    while (stages < 40) {
      let s = await dbg(p);
      if (s.phase === 'over') break;
      if (s.phase !== 'plot') { await p.waitForTimeout(150); continue; }
      for (const u of s.units) {
        // select by its chip (which also scrolls it into view), then by tapping it
        await p.click(`.unit-chip[data-lead="${u.lead}"]`);
        await p.waitForTimeout(30);
        s = await dbg(p);
        if (s.selected === u.lead && s.reach.length > 0) selectedOk++;
        const here = await at(p, u.cell);
        // even units: drag to the reachable cell nearest the centre row; odd units: a quick order
        if (u.lead % 2 === 0) {
          let best = null, bestScore = Infinity;
          for (const c of s.reach) {
            if (c === u.cell) continue;
            const pos = await at(p, c);
            if (!onScreen(vp, pos)) continue;
            const score = Math.abs(Math.floor(c / 13) - 9) * 10 + Math.abs((c % 13) - 6);
            if (score < bestScore) { bestScore = score; best = pos; }
          }
          if (best) {
            await p.mouse.move(here[0], here[1]);
            await p.mouse.down();
            await p.mouse.move(best[0], best[1], { steps: 8 });
            await p.mouse.up();
            await p.waitForTimeout(30);
            if ((await dbg(p)).units.find((x) => x.lead === u.lead).done) moved++;
          }
        } else {
          await p.mouse.click(here[0], here[1]); // second tap: its popover
          await p.waitForTimeout(30);
          if ((await dbg(p)).pop === 'unit') {
            popovers++;
            const preset = await p.$('#popover button[data-preset="hold"]:not([disabled])');
            if (preset) { await preset.click(); presets++; }
          }
        }
        // shoot at the first enemy it can see
        s = await dbg(p);
        if (s.selected !== u.lead) { await p.click(`.unit-chip[data-lead="${u.lead}"]`); s = await dbg(p); }
        const foe = s.enemies.find((e) => e.visible);
        if (foe) {
          const pos = await at(p, foe.cell);
          if (onScreen(vp, pos)) {
            await p.mouse.click(pos[0], pos[1]);
            await p.waitForTimeout(30);
            if ((await dbg(p)).pop === 'fire') {
              fired++;
              if (shots && fired === 1) await p.screenshot({ path: `${shots}/fire-popover.png` });
              await p.click('#popover button[data-act="done"]');
            }
          }
        }
      }
      if (shots && stages === 2) await p.screenshot({ path: `${shots}/plotted.png` });
      await p.click('#btn-commit');
      await p.waitForTimeout(50);
      if (await p.$('#confirm[open]')) await p.click('#confirm button[value="idle"]');
      stages++;
      // watch the first stage play out; skip the rest with a tap
      if (stages === 1) {
        await p.waitForTimeout(400);
        if (shots) await p.screenshot({ path: `${shots}/playback.png` });
        for (let i = 0; i < 100 && (await dbg(p)).phase === 'playback'; i++) await p.waitForTimeout(100);
        // Replay from the log plays the stage again and comes back to plotting
        await p.click('#btn-log');
        await p.click('#log-replay');
        await p.waitForTimeout(100);
        const replaying = (await dbg(p)).phase === 'playback';
        await p.mouse.click(195, 300); // skip
        await p.waitForTimeout(100);
        const back = await dbg(p);
        check(replaying && back.phase === 'plot' && back.turn === 1 && back.stage === 2, `Replay plays the stage again and returns to plotting (${back.phase}, turn ${back.turn}.${back.stage})`);
      } else {
        await p.waitForTimeout(100);
        if ((await dbg(p)).phase === 'playback') await p.mouse.click(195, 300);
      }
    }
    const s = await dbg(p);
    check(selectedOk > 0, `tapping a chip selects its unit and shows its move range (${selectedOk})`);
    check(moved > 0, `dragging a trooper plots a move (${moved})`);
    check(popovers > 0 && presets > 0, `tapping the selected trooper opens its popover; quick orders work (${popovers}, ${presets})`);
    check(fired > 0, `tapping a visible enemy opens the fire popover (${fired})`);
    check(s.phase === 'over' && s.winner >= 0, `the game reaches a result (phase ${s.phase}, winner ${s.winner}, ${stages} stages)`);
    const over = await p.$('#over[open]');
    const statsText = over ? await p.$eval('#over-stats', (e) => e.textContent) : '';
    check(!!over && /Seconds per plot/.test(statsText) && /Taps per plot/.test(statsText), 'the end screen shows plotting stats');
    if (shots) await p.screenshot({ path: `${shots}/over.png` });
    // the log has the last stage, with rolls
    await p.click('#over-log');
    const log = await p.$eval('#log-body', (e) => e.textContent);
    check(/CPU's orders/.test(log), 'the log shows the last stage and the CPU\'s orders');
    await ctx.close();
  }

  // 4. Landscape works too.
  {
    const vp = { width: 900, height: 500 };
    const { p, ctx } = await open(vp, '&seed=3');
    await p.click('#start-new');
    await p.waitForTimeout(200);
    const s = await dbg(p);
    check(s.phase === 'plot' && s.units.length > 0, 'a game starts in landscape');
    if (shots) await p.screenshot({ path: `${shots}/landscape.png` });
    await ctx.close();
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
  if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
  console.log('\nall passed');
})();
