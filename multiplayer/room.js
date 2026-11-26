// @ts-check
// The room relay's core: seats, forwarding and limits, with no I/O of its own.
// server.js (Node) and worker.js (Cloudflare) wrap it around real sockets.
//
// Wire protocol, all JSON text frames:
//   client → server  { to?: seat, msg }        msg goes to every other seat, or only to `to`
//   server → client  { from: seat, msg }       from -1 is the server: { k: 'peer-left', seat }
// The server never looks inside `msg`.

export const MAX_SEATS = 8;
/** Largest frame accepted, in characters (the JSON on the wire is ASCII). */
export const MAX_BYTES = 4096;
/** Frames a socket may send in any one-second window. */
export const MAX_PER_SECOND = 60;

export const DEFAULT_ORIGINS = ['https://schuyler.info', 'http://localhost:*', 'http://127.0.0.1:*'];

/**
 * The host's own socket object (ws on Node, a WebSocketPair end on Cloudflare).
 * Both have these methods, and the room uses the object's identity as the key.
 * @typedef {{ send(text: string): void, close(code: number, reason: string): void }} Conn
 */

const PATH = /^\/room\/([a-z0-9-]{1,32})\/([A-Z0-9]{1,8})$/;

/**
 * `/room/<game>/<code>?seat=<n>` → its parts, or null if it doesn't match.
 * @param {URL} url
 * @returns {{ game: string, code: string, seat: number } | null}
 */
export function parseRequest(url) {
  const m = PATH.exec(url.pathname);
  const s = url.searchParams.get('seat');
  if (!m || s === null || !/^[0-9]$/.test(s)) return null;
  const seat = Number(s);
  if (seat >= MAX_SEATS) return null;
  return { game: m[1], code: m[2], seat };
}

/**
 * Entries are exact origins, or `scheme://host:*` for any port on that host.
 * @param {string | null} origin
 * @param {string[]} allowlist
 */
export function originAllowed(origin, allowlist) {
  if (!origin) return false;
  return allowlist.some((entry) => entry.endsWith(':*')
    ? origin.startsWith(entry.slice(0, -1)) && /^[0-9]+$/.test(origin.slice(entry.length - 1))
    : origin === entry);
}

/** `ALLOWED_ORIGINS` env value → allowlist; unset or empty means the default. */
export function parseOrigins(/** @type {string | undefined} */ value) {
  const list = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

/**
 * @param {{ now?: () => number }} [opts]  now() in ms; injectable for tests
 */
export function createRoom(opts = {}) {
  const now = opts.now ?? Date.now;
  /** @type {Map<number, Conn>} */
  const bySeat = new Map();
  /** @type {Map<Conn, { seat: number, windowStart: number, count: number }>} */
  const byConn = new Map();

  /** One dying socket must not stop a broadcast to the others. */
  function deliver(/** @type {Conn} */ conn, /** @type {string} */ text) {
    try { conn.send(text); } catch { /* closing; its own close event will clean up */ }
  }

  function leave(/** @type {Conn} */ conn) {
    const rec = byConn.get(conn);
    if (!rec) return; // not (or no longer) ours: a late close, error or duplicate
    byConn.delete(conn);
    bySeat.delete(rec.seat);
    const text = JSON.stringify({ from: -1, msg: { k: 'peer-left', seat: rec.seat } });
    for (const other of bySeat.values()) deliver(other, text);
  }

  function kick(/** @type {Conn} */ conn, /** @type {number} */ code, /** @type {string} */ reason) {
    leave(conn); // free the seat now; the host may never report this close
    try { conn.close(code, reason); } catch { /* already closing */ }
  }

  return {
    has: (/** @type {number} */ seat) => bySeat.has(seat),
    size: () => bySeat.size,

    /** @param {number} seat @param {Conn} conn @returns {'ok' | 'taken'} */
    join(seat, conn) {
      if (bySeat.has(seat)) return 'taken';
      bySeat.set(seat, conn);
      byConn.set(conn, { seat, windowStart: now(), count: 0 });
      return 'ok';
    },

    /** @param {Conn} conn @param {string | null} text  null for a binary frame */
    message(conn, text) {
      const rec = byConn.get(conn);
      if (!rec) return; // frames already in flight when this socket was kicked
      const t = now();
      if (t - rec.windowStart >= 1000) { rec.windowStart = t; rec.count = 0; }
      if (++rec.count > MAX_PER_SECOND) return kick(conn, 1008, 'too many messages');
      if (text === null) return; // binary: counted, never relayed
      if (text.length > MAX_BYTES) return kick(conn, 1009, 'message too big');
      let env;
      try { env = JSON.parse(text); } catch { return; }
      if (!env || typeof env !== 'object' || Array.isArray(env) || !('msg' in env)) return;
      const out = JSON.stringify({ from: rec.seat, msg: env.msg });
      if (env.to !== undefined) {
        const target = typeof env.to === 'number' && env.to !== rec.seat ? bySeat.get(env.to) : undefined;
        if (target) deliver(target, out);
        return;
      }
      for (const [seat, other] of bySeat) if (seat !== rec.seat) deliver(other, out);
    },

    leave,
  };
}
