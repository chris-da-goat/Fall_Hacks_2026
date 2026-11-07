// Plain-English explanations of Hackie's tracking decisions, for the debug console, the popup
// and the agent's get_debug_log tool. Pure module, covered by tests/debug.test.mjs.

const CATEGORY = { work: 'work', slack: 'slacking', neutral: 'neutral' };
const SOURCE = {
  rule: 'your site lists',
  keywords: 'page keywords',
  ai: 'the AI judge',
  override: 'your manual choice',
  unknown: 'no rule matched',
  sensitive: 'the sensitive-site list',
};

function clock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * @param {object} d  A decision snapshot recorded by the service worker on every refresh.
 * @returns {string}
 */
export function explainDecision(d) {
  if (!d) return 'No decision recorded yet.';
  if (d.trackingEnabled === false) return 'Tracking is paused (the Pause button in the popup).';
  if (!d.window) return "Couldn't find a Chrome window.";
  if (!d.tab) return 'No active tab in the focused window.';
  if (!d.window.focused) return "Chrome isn't the focused window, so Hackie assumes you're in another app and pauses the clock.";
  if (d.window.idle === 'locked') return 'The screen is locked, so nothing counts.';
  if (d.window.idle === 'idle' && !d.playing) return 'No mouse or keyboard input for 60 seconds and nothing is playing, so you count as away.';
  if (!d.tracked) return 'Browser page (new tab, settings, extensions), not tracked.';
  let s = `Tracking ${d.site} as ${CATEGORY[d.category] || d.category} (decided by ${SOURCE[d.source] || d.source}).`;
  if (d.window.idle === 'idle' && d.playing) s += ' No input for 60 seconds, but media is playing, so it still counts.';
  if (d.category === 'slack') {
    if (d.snoozed) s += ' Warnings are snoozed or you are on a break.';
    else if (d.nextLevelAtSec) s += ` Slack streak ${clock(d.streakSec)}; next warning at ${clock(d.nextLevelAtSec)}.`;
    else if (d.level > 0) s += ` Slack streak ${clock(d.streakSec)}; at warning level ${d.level}.`;
  }
  if (d.fire) s += ` Hackie fired a level ${d.level} warning.`;
  return s;
}

// One compact line for the on-page log.
export function decisionLine(d) {
  const t = new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let what;
  if (d.tracked) what = `${d.category} ${d.site}`;
  else if (d.trackingEnabled === false) what = 'paused';
  else if (d.window && !d.window.focused) what = 'off (unfocused)';
  else if (d.window?.idle === 'locked') what = 'off (locked)';
  else if (d.window?.idle === 'idle' && !d.playing) what = 'off (idle)';
  else what = 'off (browser page)';
  return `${t} ${d.trigger} → ${what}${d.fire ? ` · FIRED L${d.level}` : ''}`;
}
