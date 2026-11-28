// @ts-check
// The settings a player sees, and the game parameters they map onto. Six
// simple choices; everything else stays at the sim's defaults or is fixed
// for playtesting.

/**
 * Squad sizes for Meeting, by faction. Not settled yet: these are the two
 * best-measured candidates under the 1977 tables (see RULES.md, Notes).
 * Change them here.
 */
export const FORCES = {
  lighter: { orrin: 4, terrans: 6, vell: 6 },
  standard: { orrin: 6, terrans: 8, vell: 8 },
};

/** Fixed for playtesting: the original rules, in the Meeting scenario. */
export const FIXED = /** @type {const} */ ({ scenario: 'meeting', combat: 'dice', defence: 'original', command: 1 });

const FACTION_KEYS = ['terrans', 'orrin', 'vell'];

/** The choices for each setting. */
export const CHOICES = {
  you: FACTION_KEYS,
  enemy: FACTION_KEYS,
  cpu: ['easy', 'hard'],
  forces: Object.keys(FORCES),
  terrain: ['open', 'some', 'dense'],
  swarms: ['off', 'on'],
};

/** @typedef {{ you: string, enemy: string, cpu: string, forces: string, terrain: string, swarms: string }} Settings */

/** @type {Settings} */
export const DEFAULT_SETTINGS = { you: 'terrans', enemy: 'orrin', cpu: 'easy', forces: 'lighter', terrain: 'some', swarms: 'off' };

/**
 * Settings from storage (or a form), with anything unknown replaced by the
 * default.
 * @param {any} raw
 * @returns {Settings}
 */
export function sanitize(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of /** @type {(keyof Settings)[]} */ (Object.keys(CHOICES))) {
    if (typeof raw[k] === 'string' && CHOICES[k].includes(raw[k])) out[k] = raw[k];
  }
  return out;
}

/**
 * Game parameters for these settings. The player is side 0.
 * @param {Settings} s @param {number} seed
 */
export function paramsFor(s, seed) {
  const forces = FORCES[/** @type {keyof typeof FORCES} */ (s.forces)];
  return {
    ...FIXED,
    faction0: s.you,
    faction1: s.enemy,
    squad0: forces[/** @type {keyof typeof forces} */ (s.you)],
    squad1: forces[/** @type {keyof typeof forces} */ (s.enemy)],
    terrain: s.terrain,
    swarm: s.swarms === 'on' ? 1 : 0,
    seed,
  };
}
