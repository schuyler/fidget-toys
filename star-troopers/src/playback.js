// @ts-check
// Turns one stage's events into beats to play back, in the order things
// happened (RULES.md, "A turn"): fire (troopers in command first, when
// Command is on), launches, movement step by step with overwatch, bombs,
// then recovery and captures. Pure: no DOM, no game state.

/** @typedef {import('./sim.js').TurnEvents} TurnEvents */
/** @typedef {import('./sim.js').Shot} Shot */

/**
 * The state playback starts from, taken just before resolveTurn.
 * @typedef {{ cell: number[], shock: number[], down: boolean[], pool: number[], owner: number[], victoryCells: number[] }} Before
 */

/**
 * @typedef {{ kind: 'fire', wave: 'command'|'rest'|'all', shots: Shot[] }
 *   | { kind: 'launch', launches: TurnEvents['launches'] }
 *   | { kind: 'step', index: number, moves: TurnEvents['steps'][number], shots: Shot[], blocked: TurnEvents['blocked'], pinned: number[] }
 *   | { kind: 'blast', launches: TurnEvents['launches'], shots: Shot[] }
 *   | { kind: 'end', recovered: TurnEvents['recovered'], captures: TurnEvents['captures'] }} Beat
 */

/**
 * @param {Before} before
 * @param {TurnEvents} ev
 * @param {Set<number> | null} commandIds  troopers in command at the start of the stage, or null with Command off
 * @returns {Beat[]}
 */
export function buildTimeline(before, ev, commandIds) {
  /** @type {Beat[]} */
  const beats = [];
  const fire = ev.shots.filter((s) => s.kind === 'fire');
  if (commandIds) {
    // The sim resolves the command part first, so its shots come first.
    const first = fire.filter((s) => commandIds.has(s.from));
    const rest = fire.filter((s) => !commandIds.has(s.from));
    if (first.length) beats.push({ kind: 'fire', wave: 'command', shots: first });
    if (rest.length) beats.push({ kind: 'fire', wave: 'rest', shots: rest });
  } else if (fire.length) {
    beats.push({ kind: 'fire', wave: 'all', shots: fire });
  }
  if (ev.launches.length) beats.push({ kind: 'launch', launches: ev.launches });
  ev.steps.forEach((moves, index) => {
    const shots = ev.shots.filter((s) => s.kind === 'overwatch' && s.step === index);
    const blocked = ev.blocked.filter((b) => b.step === index);
    // ev.pinned has no step: a trooper is pinned by the overwatch that hurt it.
    const pinned = [...new Set(shots.filter((s) => s.shock > 0).map((s) => s.to))];
    if (moves.length || shots.length || blocked.length) beats.push({ kind: 'step', index, moves, shots, blocked, pinned });
  });
  if (ev.launches.length) beats.push({ kind: 'blast', launches: ev.launches, shots: ev.shots.filter((s) => s.kind === 'blast') });
  if (ev.recovered.length || ev.captures.length) beats.push({ kind: 'end', recovered: ev.recovered, captures: ev.captures });
  return beats;
}

/**
 * The board after beat k (k = -1: before the stage).
 * @param {Before} before @param {Beat[]} beats @param {number} k
 */
export function stateAfter(before, beats, k) {
  const cell = before.cell.slice(), shock = before.shock.slice(), down = before.down.slice(), owner = before.owner.slice();
  /** @param {Shot[]} shots */
  const hurt = (shots) => {
    for (const s of shots) {
      if (s.shock <= 0 || down[s.to]) continue;
      shock[s.to] = Math.min(before.pool[s.to], shock[s.to] + s.shock);
      if (shock[s.to] >= before.pool[s.to]) down[s.to] = true;
    }
  };
  for (let i = 0; i <= k && i < beats.length; i++) {
    const b = beats[i];
    if (b.kind === 'fire' || b.kind === 'blast') hurt(b.shots);
    else if (b.kind === 'step') {
      for (const m of b.moves) cell[m.id] = m.to;
      hurt(b.shots);
    } else if (b.kind === 'end') {
      for (const r of b.recovered) shock[r.id] -= r.amount;
      for (const c of b.captures) owner[before.victoryCells.indexOf(c.cell)] = c.to;
    }
  }
  return { cell, shock, down, owner };
}
