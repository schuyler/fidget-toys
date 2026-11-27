// Tiny synthesised sound effects (Web Audio, no assets). The audio context
// can only start after a user gesture, so call unlock() from a pointer handler.

export function createAudio() {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {GainNode|null} */
  let master = null;
  /** @type {AudioBuffer|null} */
  let noise = null;
  let muted = false;
  try { muted = localStorage.getItem('wooden-ships-muted') === '1'; } catch { /* storage unavailable */ }

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  /**
   * A burst of filtered noise.
   * @param {number} freq low-pass cutoff @param {number} dur seconds @param {number} vol @param {number} [delay]
   */
  function burst(freq, dur, vol, delay = 0) {
    if (!ctx || !master || !noise || muted) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
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
      try { localStorage.setItem('wooden-ships-muted', m ? '1' : '0'); } catch { /* ignore */ }
    },
    /** A gun. Quieter when it's the other ship's (further away, usually). @param {boolean} mine */
    boom(mine) {
      burst(mine ? 900 : 600, 0.5, mine ? 0.5 : 0.3);
      tone('sine', 90, 40, 0.25, mine ? 0.25 : 0.15);
    },
    hit() {
      burst(3000, 0.12, 0.35);
      tone('square', 220, 80, 0.08, 0.04);
    },
    splash() {
      burst(1800, 0.25, 0.06);
    },
    bump() {
      tone('triangle', 120, 70, 0.15, 0.08);
    },
    /** @param {boolean} won */
    end(won) {
      const root = won ? 392 : 311.13;
      const steps = won ? [1, 1.26, 1.5, 2, 1.5, 2, 2.52] : [1.5, 1.26, 1.19, 1];
      steps.forEach((m, i) => tone('triangle', root * m, root * m, 0.3, 0.1, i * 0.12));
    },
    go() { tone('sine', 660, 880, 0.15, 0.08); },
    count() { tone('sine', 440, 440, 0.08, 0.05); },
  };
}
