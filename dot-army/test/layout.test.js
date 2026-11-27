import test from 'node:test';
import assert from 'node:assert/strict';
import { boardArea } from '../src/render.js';

const top = (a) => a.cy - a.h / 2;
const bottom = (a) => a.cy + a.h / 2;
const none = { top: 0, bottom: 0 };

test('landscape: the board area is what it was before, insets or not', () => {
  for (const safe of [none, { top: 40, bottom: 20 }]) {
    assert.deepEqual(boardArea(844, 390, safe), { w: 824, h: 334, cx: 422, cy: 214 });
  }
});

test('portrait: no empty band on top, so the board gets more height than before', () => {
  const a = boardArea(390, 844, none);
  assert.ok(a.h > 844 - 68, `height ${a.h} should exceed the old ${844 - 68}`);
  assert.equal(top(a), 10);
  assert.equal(a.w, 370);
  assert.equal(a.cx, 195);
});

test('portrait: the board starts below the notch, with the side margin on top', () => {
  const a = boardArea(390, 844, { top: 47, bottom: 0 });
  assert.equal(top(a), 57);
});

test('portrait: the board ends above the HUD bar and the menu button', () => {
  const a = boardArea(390, 844, none);
  assert.ok(bottom(a) <= 844 - 34, `bottom ${bottom(a)} should leave 34 px for the HUD and ☰`);
  // With a home indicator, ☰ moves up by the inset (bottom: max(3px, inset)), 30 px tall.
  const inset = 34;
  const b = boardArea(390, 844, { top: 0, bottom: inset });
  assert.ok(bottom(b) <= 844 - inset - 30, `bottom ${bottom(b)} should clear ☰ at ${844 - inset - 30}`);
});
