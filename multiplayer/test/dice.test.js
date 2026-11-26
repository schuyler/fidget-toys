import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDice } from '../dice.js';

/** n seats with anchors exchanged. */
async function table(n, length = 16) {
  const dice = [];
  for (let s = 0; s < n; s++) dice.push(await createDice({ seats: n, local: s, length }));
  for (const d of dice) for (let s = 0; s < n; s++) if (dice[s] !== d) assert.equal(d.setAnchor(s, dice[s].anchor), true);
  return dice;
}

/** Every seat reveals roll k and delivers it to every other seat. */
async function roll(dice, k) {
  const reveals = dice.map((d) => d.reveal(k));
  for (let to = 0; to < dice.length; to++)
    for (let from = 0; from < dice.length; from++)
      if (to !== from) assert.equal(await dice[to].receive(from, k, reveals[from]), true);
  return Promise.all(dice.map((d) => d.seed(k)));
}

for (const n of [2, 3]) {
  test(`R9a (${n} seats): every seat derives the same seed for each roll, and seeds vary between rolls`, async () => {
    const dice = await table(n);
    const firsts = [];
    for (let k = 1; k <= 5; k++) {
      const seeds = await roll(dice, k);
      for (const s of seeds) { assert.equal(s, seeds[0]); assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32); }
      firsts.push(seeds[0]);
    }
    assert.ok(new Set(firsts).size > 1);
  });

  test(`R9b (${n} seats): a seed is not available until every seat's reveal for that roll is in`, async () => {
    const dice = await table(n);
    const [me, ...others] = dice;
    assert.equal(me.ready(1), false);
    await assert.rejects(me.seed(1));
    for (let s = 1; s < n; s++) {
      assert.equal(await me.receive(s, 1, others[s - 1].reveal(1)), true);
      assert.equal(me.ready(1), false);        // still missing the local reveal (and maybe others)
      await assert.rejects(me.seed(1));
    }
    me.reveal(1);
    assert.equal(me.ready(1), true);
    await me.seed(1);
  });

  test(`R9c (${n} seats): a reveal that doesn't match the seat's commitment is rejected`, async () => {
    const dice = await table(n);
    const forged = 'ab'.repeat(32);
    assert.equal(await dice[0].receive(1, 1, forged), false);
    // ...and a value from someone else's chain doesn't pass either
    if (n === 3) assert.equal(await dice[0].receive(1, 1, dice[2].reveal(1)), false);
    dice[0].reveal(1);
    assert.equal(dice[0].ready(1), false);
    // the honest value is still accepted afterwards
    assert.equal(await dice[0].receive(1, 1, dice[1].reveal(1)), true);
  });

  test(`R9d (${n} seats): an element valid for a different roll index is rejected`, async () => {
    const [a, b] = await table(n);
    const b1 = b.reveal(1), b2 = b.reveal(2);
    assert.equal(await a.receive(1, 1, b2), false);   // roll 2's element offered for roll 1
    assert.equal(await a.receive(1, 1, b1), true);
    assert.equal(await a.receive(1, 2, b1), false);   // roll 1's element replayed for roll 2
    assert.equal(await a.receive(1, 2, b2), true);
  });

  test(`R9e (${n} seats): a seat's anchor can't be replaced once set`, async () => {
    const [a, b] = await table(n);
    const imposter = await createDice({ seats: n, local: 1, length: 16 });
    assert.equal(a.setAnchor(1, imposter.anchor), false);
    assert.equal(a.setAnchor(0, imposter.anchor), false);          // nor the local one
    assert.equal(await a.receive(1, 1, imposter.reveal(1)), false); // imposter chain doesn't verify
    assert.equal(await a.receive(1, 1, b.reveal(1)), true);         // the original still does
  });
}

