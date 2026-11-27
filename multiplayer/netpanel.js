// @ts-check
// A small corner readout of a transport's stats, for testing over real
// networks (?debug in the games). Brings its own styling.

/**
 * @param {() => import('./relay.js').TransportStats | null} getStats
 */
export function createNetPanel(getStats) {
  const div = document.createElement('div');
  div.setAttribute('data-netpanel', '');
  div.style.cssText = 'position:fixed;top:4px;left:4px;z-index:10;pointer-events:none;'
    + 'font:11px/1.3 ui-monospace,monospace;color:#cfd6e6;background:rgba(0,0,0,0.55);padding:3px 6px;border-radius:4px';
  document.body.append(div);
  const update = () => {
    const s = getStats();
    div.textContent = !s ? 'offline'
      : `relay ${s.state} · rtt ${s.rtt === null ? '–' : s.rtt + ' ms'} · out ${s.sent} / in ${s.received}`
        + ` · last close ${s.close ? `${s.close.code}${s.close.reason ? ' ' + s.close.reason : ''}` : '–'}`;
  };
  update();
  const timer = setInterval(update, 500);
  return { remove() { clearInterval(timer); div.remove(); } };
}
