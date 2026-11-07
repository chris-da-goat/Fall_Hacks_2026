import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, lastNDayKeys, emptyDay, addTime, topDomains, focusScore, formatDuration, formatClock, normalizeDay } from '../extension/lib/stats.js';
import { mergeSettings, splitList, DEFAULT_SETTINGS } from '../extension/lib/defaults.js';
import { fillLine, pickLine } from '../extension/lib/lines.js';

test('dayKey uses local date parts', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('lastNDayKeys ends with today and crosses month boundaries', () => {
  const keys = lastNDayKeys(3, new Date(2026, 2, 1));
  assert.deepEqual(keys, ['2026-02-27', '2026-02-28', '2026-03-01']);
});

test('addTime accumulates per category and per domain', () => {
  const day = emptyDay();
  addTime(day, { domain: 'youtube.com', category: 'slack', seconds: 30, title: 'cats' });
  addTime(day, { domain: 'youtube.com', category: 'work', seconds: 10 });
  addTime(day, { domain: 'github.com', category: 'work', seconds: 100 });
  addTime(day, { domain: 'github.com', category: 'work', seconds: 0 });
  assert.deepEqual(day.totals, { work: 110, slack: 30, neutral: 0 });
  assert.equal(day.domains['youtube.com'].slack, 30);
  assert.equal(day.domains['youtube.com'].lastCategory, 'work');
  assert.equal(day.domains['youtube.com'].lastTitle, 'cats');
  assert.deepEqual(topDomains(day).map((d) => d.domain), ['github.com', 'youtube.com']);
});

test('normalizeDay fills missing fields from older data', () => {
  const day = normalizeDay({ totals: { work: 5 } });
  assert.deepEqual(day.totals, { work: 5, slack: 0, neutral: 0 });
  assert.equal(day.events.whips, 0);
});

test('focusScore needs a minute of data', () => {
  assert.equal(focusScore({ work: 20, slack: 20 }), null);
  assert.equal(focusScore({ work: 90, slack: 30 }), 75);
});

test('duration formatting', () => {
  assert.equal(formatDuration(42), '42s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(125, { compact: true }), '2m');
  assert.equal(formatDuration(3725), '1h 2m');
  assert.equal(formatClock(192), '3:12');
  assert.equal(formatClock(3725), '1:02:05');
});

test('mergeSettings deep-merges stored values over defaults without mutating defaults', () => {
  const s = mergeSettings({ thresholds: { nudgeAfterMin: 1 }, slackSites: ['a.com'] });
  assert.equal(s.thresholds.nudgeAfterMin, 1);
  assert.equal(s.thresholds.whipAfterMin, DEFAULT_SETTINGS.thresholds.whipAfterMin);
  assert.deepEqual(s.slackSites, ['a.com']);
  s.slackSites.push('b.com');
  assert.notDeepEqual(DEFAULT_SETTINGS.slackSites, s.slackSites);
});

test('splitList handles commas and newlines', () => {
  assert.deepEqual(splitList(' a, b\n\n c ,'), ['a', 'b', 'c']);
});

test('Hackie lines fill in their placeholders', () => {
  assert.equal(fillLine('{minutes} on {site} instead of {task}', { minutes: '6 minutes', site: 'YouTube', task: 'math' }), '6 minutes on YouTube instead of math');
  const line = pickLine(2, { minutes: '6 minutes', site: 'YouTube', task: 'math' }, () => 0);
  assert.ok(line.startsWith('*CRACK*'));
  assert.ok(!/\{\w+\}/.test(line));
});
