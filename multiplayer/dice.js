// @ts-check
// Networked die rolls that no seat can predict or steer.
//
// Each seat picks a secret s and builds a hash chain: c[L] = s, c[i-1] = SHA-256(c[i]).
// It publishes c[0] (the anchor) before play. Roll k uses every seat's c[k], each checked
// against the seat's previous element, so a value can't be chosen after the anchor is
// out. The seed for roll k hashes everyone's c[k] together, so nobody knows it until the
// last seat reveals.
//
// Caveat: the last seat to reveal can work out the result first and refuse to reveal.
// A game should treat a seat that stalls as having left.
//
// Needs Web Crypto: browsers on https or localhost, and Node 20+.

const toHex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** @param {string} hex @returns {Uint8Array | null} 32 bytes, or null if malformed */
function fromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

const sha256 = async (/** @type {Uint8Array} */ b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

const equal = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * @param {{ seats: number, local: number, length?: number }} o  length: rolls available (default 4096)
 */
export async function createDice({ seats, local, length = 4096 }) {
  /** chain[i] = c[i]; chain[length] is the secret. */
  const chain = new Array(length + 1);
  chain[length] = crypto.getRandomValues(new Uint8Array(32));
  for (let i = length; i > 0; i--) chain[i - 1] = await sha256(chain[i]);

  /** Per seat: the last verified element and its index (0 = the anchor). */
  /** @type {({ k: number, c: Uint8Array } | null)[]} */
  const last = Array.from({ length: seats }, () => null);
  last[local] = { k: 0, c: chain[0] };
  /** revealed.get(k)[seat] = c[k] */
  /** @type {Map<number, (Uint8Array | undefined)[]>} */
  const revealed = new Map();

  const record = (/** @type {number} */ seat, /** @type {number} */ k, /** @type {Uint8Array} */ c) => {
    let row = revealed.get(k);
    if (!row) revealed.set(k, row = new Array(seats));
    row[seat] = c;
  };

  const ready = (/** @type {number} */ k) => {
    const row = revealed.get(k);
    if (!row) return false;
    for (let s = 0; s < seats; s++) if (!row[s]) return false;
    return true;
  };

  return {
    /** Publish this before the first roll. */
    anchor: toHex(chain[0]),

    /** One-shot per seat: a replaced anchor would let a seat pick its rolls. */
    setAnchor(/** @type {number} */ seat, /** @type {string} */ hex) {
      const c = fromHex(hex);
      if (!c || last[seat] !== null) return false;
      last[seat] = { k: 0, c };
      return true;
    },

    /** The local element for roll k, to send to the other seats. */
    reveal(/** @type {number} */ k) {
      if (!(k >= 1 && k <= length)) throw new RangeError(`roll ${k} out of range 1..${length}`);
      record(local, k, chain[k]);
      return toHex(chain[k]);
    },

    /**
     * Another seat's element for roll k. Rolls must arrive in order per seat
     * (await each call). Returns false, recording nothing, if it doesn't verify.
     */
    async receive(/** @type {number} */ seat, /** @type {number} */ k, /** @type {string} */ hex) {
      const prev = last[seat];
      const c = fromHex(hex);
      if (seat === local || !prev || !c || k !== prev.k + 1) return false;
      if (!equal(await sha256(c), prev.c)) return false;
      last[seat] = { k, c };
      record(seat, k, c);
      return true;
    },

    ready,

    /** uint32 seed for roll k, for the game's own seeded RNG. */
    async seed(/** @type {number} */ k) {
      if (!ready(k)) throw new Error(`roll ${k} isn't ready`);
      const row = /** @type {Uint8Array[]} */ (revealed.get(k));
      const buf = new Uint8Array(4 + 32 * seats);
      new DataView(buf.buffer).setUint32(0, k);
      row.forEach((c, s) => buf.set(c, 4 + 32 * s));
      return new DataView((await sha256(buf)).buffer).getUint32(0);
    },
  };
}
