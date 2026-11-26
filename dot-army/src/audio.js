// Tiny synthesised sound effects (Web Audio, no assets). The audio context
// can only start after a user gesture, so call unlock() from a pointer handler.

export function createAudio() {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {GainNode|null} */
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem('dot-army-muted') === '1'; } catch { /* storage unavailable */ }

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
  }

  /**
   * @param {OscillatorType} type @param {number} f0 @param {number} f1
   * @param {number} dur seconds @param {number} vol @param {number} [delay]
   */
  function tone(type, f0, f1, dur, vol, delay = 0) {
    if (!ctx || !master || muted) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  return {
    unlock,
    get muted() { return muted; },
    setMuted(/** @type {boolean} */ m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.6;
      try { localStorage.setItem('dot-army-muted', m ? '1' : '0'); } catch { /* ignore */ }
    },
    /** @param {number} n kills this tick */
    kills(n) {
      const plays = Math.min(n, 3);
      for (let i = 0; i < plays; i++) {
        const f = 520 + Math.random() * 500;
        tone('triangle', f, f * 0.35, 0.07, 0.05 + Math.min(0.06, n * 0.004), i * 0.018);
      }
    },
    hit(/** @type {number} */ player) {
      tone('square', player === 0 ? 210 : 170, 90, 0.05, 0.025);
    },
    capture(/** @type {number} */ player) {
      const root = player === 0 ? 523.25 : 440;
      [1, 1.26, 1.5, 2].forEach((m, i) => tone('sine', root * m, root * m, 0.18, 0.09, i * 0.06));
    },
    win(/** @type {number} */ player) {
      const root = player === 0 ? 392 : 349.23;
      [1, 1.26, 1.5, 2, 1.5, 2, 2.52].forEach((m, i) => tone('triangle', root * m, root * m, 0.3, 0.1, i * 0.11));
    },
    go() {
      tone('sine', 660, 880, 0.15, 0.08);
    },
    count() {
      tone('sine', 440, 440, 0.08, 0.05);
    },
  };
}
