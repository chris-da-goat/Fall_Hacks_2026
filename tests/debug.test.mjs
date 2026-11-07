import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDecision, decisionLine } from '../extension/lib/debug.js';

const AT = new Date(2026, 10, 7, 9, 5, 7).getTime();

// A tracked, focused, active work page, shaped like the service worker's snapshot.
function snap(over = {}) {
  return {
    at: AT,
    trigger: 'tick',
    trackingEnabled: true,
    window: { focused: true, popupOpen: false, idle: 'active' },
    tab: { id: 7, audible: false },
    playing: false,
    tracked: true,
    site: 'github.com',
    category: 'work',
    source: 'rule',
    reason: '',
    sensitive: false,
    streakSec: 0,
    level: 0,
    nextLevelAtSec: null,
    fire: false,
    snoozed: false,
    overBudget: false,
    ...over,
  };
}

const win = (over) => ({ focused: true, popupOpen: false, idle: 'active', ...over });
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------------------------------------------------------------------------
// explainDecision

test('explainDecision: no snapshot', () => {
  assert.equal(explainDecision(null), 'No decision recorded yet.');
  assert.equal(explainDecision(undefined), 'No decision recorded yet.');
});

test('explainDecision: paused when trackingEnabled is false (before any other check)', () => {
  assert.equal(explainDecision(snap({ trackingEnabled: false })), 'Tracking is paused (the Pause button in the popup).');
  assert.equal(explainDecision(snap({ trackingEnabled: false, window: null, tab: null, tracked: false })), 'Tracking is paused (the Pause button in the popup).');
});

test('explainDecision: no window', () => {
  assert.equal(explainDecision(snap({ window: null, tab: null, tracked: false })), "Couldn't find a Chrome window.");
});

test('explainDecision: no tab', () => {
  assert.equal(explainDecision(snap({ tab: null, tracked: false })), 'No active tab in the focused window.');
});

test('explainDecision: Chrome not focused', () => {
  const s = explainDecision(snap({ window: win({ focused: false }), tracked: false }));
  assert.match(s, /^Chrome isn't the focused window/);
  assert.match(s, /pauses the clock/);
});

test('explainDecision: screen locked (even with media playing)', () => {
  assert.equal(explainDecision(snap({ window: win({ idle: 'locked' }), tracked: false })), 'The screen is locked, so nothing counts.');
  assert.equal(explainDecision(snap({ window: win({ idle: 'locked' }), playing: true, tracked: false })), 'The screen is locked, so nothing counts.');
});

test('explainDecision: idle with nothing playing counts as away', () => {
  assert.equal(
    explainDecision(snap({ window: win({ idle: 'idle' }), playing: false, tracked: false })),
    'No mouse or keyboard input for 60 seconds and nothing is playing, so you count as away.',
  );
});

test('explainDecision: idle but playing media is still tracked', () => {
  assert.equal(
    explainDecision(snap({ window: win({ idle: 'idle' }), playing: true, site: 'youtube.com', category: 'neutral', source: 'ai' })),
    'Tracking youtube.com as neutral (decided by the AI judge). No input for 60 seconds, but media is playing, so it still counts.',
  );
});

test('explainDecision: untracked browser page', () => {
  assert.equal(explainDecision(snap({ tracked: false, site: '', category: null, source: null })), 'Browser page (new tab, settings, extensions), not tracked.');
});

test('explainDecision: tracked work page names the category and source', () => {
  assert.equal(explainDecision(snap()), 'Tracking github.com as work (decided by your site lists).');
  assert.equal(explainDecision(snap({ source: 'keywords' })), 'Tracking github.com as work (decided by page keywords).');
  assert.equal(explainDecision(snap({ source: 'override' })), 'Tracking github.com as work (decided by your manual choice).');
  assert.equal(explainDecision(snap({ source: 'unknown', category: 'neutral' })), 'Tracking github.com as neutral (decided by no rule matched).');
  assert.equal(
    explainDecision(snap({ site: 'Private site', source: 'sensitive', category: 'slack' })),
    'Tracking Private site as slacking (decided by the sensitive-site list).',
  );
  assert.equal(explainDecision(snap({ category: 'mystery', source: 'magic' })), 'Tracking github.com as mystery (decided by magic).', 'unknown values pass through');
});

test('explainDecision: slack streak with the next warning due', () => {
  assert.equal(
    explainDecision(snap({ site: 'reddit.com', category: 'slack', streakSec: 125, level: 0, nextLevelAtSec: 300 })),
    'Tracking reddit.com as slacking (decided by your site lists). Slack streak 2:05; next warning at 5:00.',
  );
});

test('explainDecision: slack at the last warning level (no next warning)', () => {
  assert.equal(
    explainDecision(snap({ site: 'reddit.com', category: 'slack', streakSec: 1500.7, level: 3, nextLevelAtSec: null })),
    'Tracking reddit.com as slacking (decided by your site lists). Slack streak 25:00; at warning level 3.',
  );
});

test('explainDecision: slack with no warnings yet and nothing scheduled adds nothing', () => {
  assert.equal(
    explainDecision(snap({ site: 'reddit.com', category: 'slack', streakSec: 30, level: 0, nextLevelAtSec: null })),
    'Tracking reddit.com as slacking (decided by your site lists).',
  );
});

test('explainDecision: slack while snoozed or on a break', () => {
  assert.equal(
    explainDecision(snap({ site: 'reddit.com', category: 'slack', streakSec: 400, level: 1, nextLevelAtSec: 600, snoozed: true })),
    'Tracking reddit.com as slacking (decided by your site lists). Warnings are snoozed or you are on a break.',
  );
});

test('explainDecision: streak details only appear for slack pages', () => {
  assert.equal(explainDecision(snap({ category: 'work', streakSec: 125, nextLevelAtSec: 300, snoozed: true })), 'Tracking github.com as work (decided by your site lists).');
});

test('explainDecision: a fired warning is reported', () => {
  assert.equal(
    explainDecision(snap({ site: 'youtube.com', category: 'slack', streakSec: 600, level: 2, nextLevelAtSec: 1200, fire: true })),
    'Tracking youtube.com as slacking (decided by your site lists). Slack streak 10:00; next warning at 20:00. Hackie fired a level 2 warning.',
  );
});

// ---------------------------------------------------------------------------
// decisionLine

test('decisionLine: tracked page shows category and site', () => {
  assert.equal(decisionLine(snap()), `${time(AT)} tick → work github.com`);
  assert.equal(decisionLine(snap({ trigger: 'tab-activated', site: 'reddit.com', category: 'slack' })), `${time(AT)} tab-activated → slack reddit.com`);
});

test('decisionLine: unfocused window', () => {
  assert.equal(decisionLine(snap({ trigger: 'focus', window: win({ focused: false }), tracked: false })), `${time(AT)} focus → off (unfocused)`);
});

test('decisionLine: idle, and idle-but-playing', () => {
  assert.equal(decisionLine(snap({ trigger: 'idle', window: win({ idle: 'idle' }), tracked: false })), `${time(AT)} idle → off (idle)`);
  assert.equal(
    decisionLine(snap({ trigger: 'idle', window: win({ idle: 'idle' }), playing: true, site: 'youtube.com', category: 'slack' })),
    `${time(AT)} idle → slack youtube.com`,
  );
});

test('decisionLine: paused, locked and browser pages', () => {
  assert.equal(decisionLine(snap({ trackingEnabled: false, tracked: false })), `${time(AT)} tick → paused`);
  assert.equal(decisionLine(snap({ window: win({ idle: 'locked' }), tracked: false })), `${time(AT)} tick → off (locked)`);
  assert.equal(decisionLine(snap({ tracked: false, site: '', category: null })), `${time(AT)} tick → off (browser page)`);
});

test('decisionLine: a fired warning is flagged with its level', () => {
  assert.equal(
    decisionLine(snap({ site: 'youtube.com', category: 'slack', level: 3, fire: true })),
    `${time(AT)} tick → slack youtube.com · FIRED L3`,
  );
  assert.doesNotMatch(decisionLine(snap({ level: 2, fire: false })), /FIRED/);
});
