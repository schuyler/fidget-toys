// @ts-check
// The online lobby, shared by the games: "Your room" (code, link, Share) for
// the host and "Join a game" (type a code) for the guest. It fills a <dialog>
// the game provides and styles, using only these class names: pills, pill,
// primary, hint. It knows nothing about relays or URLs; the game builds the link.

/** A short, unambiguous room code (no 0/O, 1/I/L). */
export function roomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/** Room codes as typed: upper case, letters and digits only, at most 8. */
export const cleanCode = (/** @type {string} */ s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

/**
 * @param {string} tag @param {Record<string, string>} [attrs] @param {string} [text]
 */
function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {HTMLDialogElement} dialog  empty; the lobby owns its contents
 * @param {{ onJoin(code: string): void, onBack(): void }} o
 */
export function createLobby(dialog, o) {
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); o.onBack(); });

  function show(/** @type {HTMLElement[]} */ children) {
    dialog.replaceChildren(...children);
    if (!dialog.open) dialog.showModal();
  }
  const back = () => {
    const b = el('button', { class: 'pill', 'data-lobby': 'back' }, 'Back');
    b.addEventListener('click', () => o.onBack());
    return b;
  };

  return {
    /** @param {string} code @param {string} link */
    openHosting(code, link) {
      const canShare = typeof navigator.share === 'function';
      const share = el('button', { class: 'pill primary', 'data-lobby': 'share' }, canShare ? 'Share link' : 'Copy link');
      share.addEventListener('click', async () => {
        try {
          if (canShare) await navigator.share({ url: link });
          else { await navigator.clipboard?.writeText(link); share.textContent = 'Copied'; }
        } catch { /* share sheet dismissed, or no clipboard (plain http) */ }
      });
      const pills = el('div', { class: 'pills' });
      pills.append(share, back());
      show([
        el('h1', {}, 'Your room'),
        el('p', { 'data-lobby': 'code', style: 'font-size: 44px; font-weight: 800; letter-spacing: 6px; margin: 0 0 8px' }, code),
        el('p', { class: 'hint', 'data-lobby': 'link', style: 'word-break: break-all; margin: 0 0 14px' }, link),
        pills,
        el('p', { class: 'hint' }, 'Send the link, or have them choose Join with code. The game starts when they arrive.'),
      ]);
    },

    openJoin() {
      const input = /** @type {HTMLInputElement} */ (el('input', {
        'data-lobby': 'input', placeholder: 'Room code', maxlength: '8',
        autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
        style: 'font-size: 24px; letter-spacing: 4px; text-align: center; margin: 0 0 12px',
      }));
      const join = /** @type {HTMLButtonElement} */ (el('button', { class: 'pill primary', 'data-lobby': 'join' }, 'Join'));
      join.disabled = true;
      const submit = () => { const c = cleanCode(input.value); if (c) o.onJoin(c); };
      input.addEventListener('input', () => {
        input.value = cleanCode(input.value);
        join.disabled = !input.value;
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      join.addEventListener('click', submit);
      const pills = el('div', { class: 'pills' });
      pills.append(join, back());
      show([el('h1', {}, 'Join a game'), input, pills]);
      input.focus();
    },

    close() {
      if (dialog.open) dialog.close();
    },
  };
}
