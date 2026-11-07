import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, pageKey, parseRule, bestRuleMatch, findHits, taskKeywords } from '../extension/lib/classify.js';
import { mergeSettings } from '../extension/lib/defaults.js';

const settings = mergeSettings({
  task: { title: 'Finish the linked list assignment', keywords: ['c++', 'pointers'], url: '' },
});

test('pageKey keeps the YouTube video id and drops other query params', () => {
  assert.equal(pageKey('https://www.youtube.com/watch?v=abc123&t=42s'), 'youtube.com/watch?v=abc123');
  assert.equal(pageKey('https://github.com/foo/bar/?tab=readme#x'), 'github.com/foo/bar');
});

test('parseRule strips scheme and www, keeps path', () => {
  assert.deepEqual(parseRule('https://www.YouTube.com/shorts'), { raw: 'https://www.YouTube.com/shorts', host: 'youtube.com', path: '/shorts' });
  assert.equal(parseRule('   '), null);
});

test('bestRuleMatch prefers the more specific rule and matches subdomains', () => {
  const m = bestRuleMatch('https://m.youtube.com/shorts/xyz', ['youtube.com', 'youtube.com/shorts']);
  assert.equal(m.raw, 'youtube.com/shorts');
  assert.equal(bestRuleMatch('https://notyoutube.com/', ['youtube.com']), null);
});

test('findHits matches whole words only', () => {
  assert.deepEqual(findHits('React hooks tutorial', ['react']), ['react']);
  assert.deepEqual(findHits('Funny reaction video', ['react']), []);
  assert.deepEqual(findHits('Learn C++ pointers fast', ['c++']), ['c++']);
});

test('taskKeywords combines explicit keywords with meaningful title words', () => {
  const kws = taskKeywords(settings.task);
  assert.ok(kws.includes('linked'));
  assert.ok(kws.includes('list'));
  assert.ok(kws.includes('c++'));
  assert.ok(!kws.includes('finish'), 'stopwords are dropped');
  assert.ok(!kws.includes('assignment'), 'stopwords are dropped');
});

test('a funny YouTube video is slacking and asks the AI for a second opinion', () => {
  const r = classifyPage({
    url: 'https://www.youtube.com/watch?v=cats',
    ctx: { url: 'https://www.youtube.com/watch?v=cats', title: 'Funny cat compilation - YouTube' },
    settings,
  });
  assert.equal(r.category, 'slack');
  assert.equal(r.domain, 'youtube.com');
  assert.equal(r.needsAI, true);
});

test('a YouTube tutorial that matches the task counts as work', () => {
  const r = classifyPage({
    url: 'https://www.youtube.com/watch?v=ll',
    ctx: { url: 'https://www.youtube.com/watch?v=ll', title: 'Linked list in C++ explained', videoTitle: 'Linked list in C++ explained' },
    settings,
  });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'keywords');
});

test('work-listed sites are always work, even with slack keywords', () => {
  const r = classifyPage({ url: 'https://github.com/memes/funny', ctx: { title: 'funny memes repo' }, settings });
  assert.equal(r.category, 'work');
  assert.equal(r.needsAI, false);
});

test('per-page overrides beat everything', () => {
  const r = classifyPage({
    url: 'https://www.youtube.com/watch?v=cats',
    ctx: null,
    settings,
    overrides: { pages: { 'youtube.com/watch?v=cats': 'work' } },
  });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'override');
});

test('a cached AI verdict decides ambiguous pages', () => {
  const r = classifyPage({
    url: 'https://www.youtube.com/watch?v=lecture',
    ctx: { title: 'MIT 6.006 Lecture 4' },
    settings,
    aiVerdict: { category: 'work', reason: 'An algorithms lecture.', nudge: '' },
  });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'ai');
});

test('unknown sites are neutral; slack keywords make them slack', () => {
  assert.equal(classifyPage({ url: 'https://example.com/', ctx: { title: 'Example Domain' }, settings }).category, 'neutral');
  assert.equal(classifyPage({ url: 'https://example.com/x', ctx: { title: 'Top 10 prank fails' }, settings }).category, 'slack');
});

test('browser-internal pages are not tracked', () => {
  const r = classifyPage({ url: 'chrome://newtab/', settings });
  assert.equal(r.tracked, false);
});
