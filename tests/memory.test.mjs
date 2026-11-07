import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_DOMAIN,
  HABITS,
  emptyMemory,
  normalizeMemory,
  recordTime,
  pageScore,
  habitFor,
  flagSite,
  addFact,
  addProject,
  addIncident,
  forget,
  topSlackSites,
  topWorkPages,
  workTargets,
  memoryForPrompt,
} from '../extension/lib/memory.js';
import { PRIVATE_DOMAIN as SENSITIVE_PRIVATE_DOMAIN } from '../extension/lib/sensitive.js';
import { pageKey } from '../extension/lib/classify.js';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Records a work page in one call.
function work(mem, pageKey, seconds, { url = `https://example.com/${pageKey}`, title = pageKey, now = NOW, domain = 'example.com' } = {}) {
  return recordTime(mem, { domain, category: 'work', seconds, pageKey, url, title, now });
}

// ---------------------------------------------------------------------------
// Constants and shape

test('emptyMemory returns a fresh, empty store each time', () => {
  const a = emptyMemory();
  assert.deepEqual(a, { version: 1, sites: {}, workPages: {}, projects: [], facts: [], incidents: [] });
  const b = emptyMemory();
  assert.notEqual(a.sites, b.sites);
  assert.notEqual(a.facts, b.facts);
});

test('PRIVATE_DOMAIN matches the one sensitive.js uses, and HABITS lists the strongest level first', () => {
  assert.equal(PRIVATE_DOMAIN, SENSITIVE_PRIVATE_DOMAIN);
  assert.deepEqual(HABITS, [
    { level: 'strong', minSlackSec: 2 * 3600, factor: 0.4 },
    { level: 'habit', minSlackSec: 30 * 60, factor: 0.6 },
  ]);
});

// ---------------------------------------------------------------------------
// recordTime

test('recordTime accumulates slack, work and neutral seconds per domain and returns the same object', () => {
  const mem = emptyMemory();
  assert.equal(recordTime(mem, { domain: 'youtube.com', category: 'slack', seconds: 30, newVisit: true, now: NOW }), mem);
  recordTime(mem, { domain: 'youtube.com', category: 'slack', seconds: 45, now: NOW + 1000 });
  recordTime(mem, { domain: 'youtube.com', category: 'work', seconds: 10, now: NOW + 2000 });
  recordTime(mem, { domain: 'youtube.com', category: 'neutral', seconds: 5, now: NOW + 3000 });
  recordTime(mem, { domain: 'youtube.com', category: 'something-else', seconds: 2, now: NOW + 4000 });
  recordTime(mem, { domain: 'github.com', category: 'work', seconds: 60, newVisit: true, now: NOW + 5000 });

  assert.deepEqual(mem.sites['youtube.com'], { slackSec: 75, workSec: 10, neutralSec: 7, visits: 1, lastSeen: NOW + 4000 }, 'unknown categories count as neutral');
  assert.deepEqual(mem.sites['github.com'], { slackSec: 0, workSec: 60, neutralSec: 0, visits: 1, lastSeen: NOW + 5000 });
});

test('recordTime counts a visit only when newVisit is set', () => {
  const mem = emptyMemory();
  recordTime(mem, { domain: 'reddit.com', category: 'slack', seconds: 20, now: NOW });
  recordTime(mem, { domain: 'reddit.com', category: 'slack', seconds: 20, now: NOW });
  assert.equal(mem.sites['reddit.com'].visits, 0);

  recordTime(mem, { domain: 'reddit.com', category: 'slack', seconds: 0, newVisit: true, now: NOW + 1000 });
  assert.deepEqual(mem.sites['reddit.com'], { slackSec: 40, workSec: 0, neutralSec: 0, visits: 1, lastSeen: NOW + 1000 }, 'a visit with no time yet still counts');
  recordTime(mem, { domain: 'reddit.com', category: 'slack', seconds: 5, newVisit: true, now: NOW + 2000 });
  assert.equal(mem.sites['reddit.com'].visits, 2);
});

test('recordTime ignores calls with no domain, or with no time and no new visit', () => {
  const mem = emptyMemory();
  recordTime(mem, { domain: '', category: 'slack', seconds: 30, newVisit: true, now: NOW });
  recordTime(mem, { domain: undefined, category: 'slack', seconds: 30, now: NOW });
  recordTime(mem, { domain: 'a.com', category: 'slack', seconds: 0, now: NOW });
  recordTime(mem, { domain: 'a.com', category: 'slack', seconds: -5, now: NOW });
  recordTime(mem, { domain: 'a.com', category: 'slack', seconds: NaN, now: NOW });
  assert.deepEqual(mem, emptyMemory());
});

test('work pages are remembered with url and title, accumulating time', () => {
  const mem = emptyMemory();
  work(mem, 'gh:repo', 30, { url: 'https://github.com/me/repo', title: 'me/repo' });
  work(mem, 'gh:repo', 45, { url: 'https://github.com/me/repo/tree/main', title: '', now: NOW + 1000 });
  assert.deepEqual(mem.workPages['gh:repo'], { url: 'https://github.com/me/repo/tree/main', title: 'me/repo', seconds: 75, lastSeen: NOW + 1000 }, 'url follows redirects, title kept when none is given');

  work(mem, 'gh:repo', 5, { url: 'https://github.com/me/repo', title: 'T'.repeat(200), now: NOW + 2000 });
  assert.equal(mem.workPages['gh:repo'].title, 'T'.repeat(140), 'titles are capped at 140 characters');
  assert.equal(mem.workPages['gh:repo'].seconds, 80);

  work(mem, 'plain-http', 10, { url: 'http://localhost:3000/app', title: 'Local app' });
  assert.equal(mem.workPages['plain-http'].url, 'http://localhost:3000/app');
});

test('work pages are only remembered for work, http(s), non-sensitive pages with a pageKey and time', () => {
  const mem = emptyMemory();
  const page = { domain: 'example.com', seconds: 30, pageKey: 'k', url: 'https://example.com/k', title: 'K', now: NOW };
  recordTime(mem, { ...page, category: 'slack' });
  recordTime(mem, { ...page, category: 'neutral' });
  recordTime(mem, { ...page, category: 'work', pageKey: undefined });
  recordTime(mem, { ...page, category: 'work', pageKey: '' });
  recordTime(mem, { ...page, category: 'work', url: undefined });
  recordTime(mem, { ...page, category: 'work', url: 'chrome://extensions' });
  recordTime(mem, { ...page, category: 'work', url: 'file:///C:/notes.txt' });
  recordTime(mem, { ...page, category: 'work', url: 'javascript:alert(1)' });
  recordTime(mem, { ...page, category: 'work', seconds: 0, newVisit: true });
  recordTime(mem, { ...page, category: 'work', sensitive: true });
  assert.deepEqual(mem.workPages, {});
  assert.ok(mem.sites['example.com'], 'the time is still recorded against the site');
});

test('work time on a search results page counts for the site but is never a work page', () => {
  const mem = emptyMemory();
  const searches = [
    ['google.com', 'https://www.google.com/search?q=c%2B%2B+linked+list&sxsrf=abc'],
    ['google.co.uk', 'https://www.google.co.uk/search?q=c%2B%2B+docs'],
    ['bing.com', 'https://www.bing.com/search?q=linked+list'],
    ['duckduckgo.com', 'https://duckduckgo.com/?q=c%2B%2B+pointers'],
    ['youtube.com', 'https://www.youtube.com/results?search_query=linked+list+tutorial'],
  ];
  for (const [domain, url] of searches) {
    recordTime(mem, { domain, category: 'work', seconds: 40, newVisit: true, pageKey: pageKey(url), url, title: 'c++ linked list - Search', now: NOW });
  }
  assert.deepEqual(mem.workPages, {});
  for (const [domain] of searches) {
    assert.deepEqual(mem.sites[domain], { slackSec: 0, workSec: 40, neutralSec: 0, visits: 1, lastSeen: NOW }, domain);
  }
});

test('a normal work page is still remembered next to a search', () => {
  const mem = emptyMemory();
  const search = 'https://www.google.com/search?q=c%2B%2B+docs';
  const docs = 'https://en.cppreference.com/w/cpp/container/list';
  const video = 'https://www.youtube.com/watch?v=ll123';
  const maps = 'https://www.google.com/maps?q=library';
  recordTime(mem, { domain: 'google.com', category: 'work', seconds: 20, pageKey: pageKey(search), url: search, title: 'c++ docs - Google Search', now: NOW });
  recordTime(mem, { domain: 'en.cppreference.com', category: 'work', seconds: 90, pageKey: pageKey(docs), url: docs, title: 'std::list', now: NOW });
  recordTime(mem, { domain: 'youtube.com', category: 'work', seconds: 60, pageKey: pageKey(video), url: video, title: 'Linked lists in C++', now: NOW });
  recordTime(mem, { domain: 'google.com', category: 'work', seconds: 15, pageKey: pageKey(maps), url: maps, title: 'Library - Google Maps', now: NOW });
  assert.deepEqual(Object.keys(mem.workPages).sort(), ['en.cppreference.com/w/cpp/container/list', 'google.com/maps', 'youtube.com/watch?v=ll123']);
  assert.deepEqual(mem.workPages['en.cppreference.com/w/cpp/container/list'], { url: docs, title: 'std::list', seconds: 90, lastSeen: NOW });
  assert.equal(mem.sites['google.com'].workSec, 35, 'search and non-search time both count for the site');
});

test('sensitive pages are stored under PRIVATE_DOMAIN with no URL or title anywhere', () => {
  const mem = emptyMemory();
  recordTime(mem, {
    domain: 'mybank.example',
    category: 'work',
    seconds: 120,
    newVisit: true,
    pageKey: 'https://mybank.example/account',
    url: 'https://mybank.example/account?id=SECRET-4417',
    title: 'Checking account SECRET-4417',
    sensitive: true,
    now: NOW,
  });
  recordTime(mem, {
    domain: 'clinic.example',
    category: 'slack',
    seconds: 300,
    newVisit: true,
    pageKey: 'clinic',
    url: 'https://clinic.example/results',
    title: 'Lab results for Jordan',
    sensitive: true,
    now: NOW + 1000,
  });

  assert.deepEqual(Object.keys(mem.sites), [PRIVATE_DOMAIN]);
  assert.deepEqual(mem.sites[PRIVATE_DOMAIN], { slackSec: 300, workSec: 120, neutralSec: 0, visits: 2, lastSeen: NOW + 1000 });
  assert.deepEqual(mem.workPages, {});

  const json = JSON.stringify(mem);
  for (const leak of ['mybank', 'SECRET', 'Checking account', 'clinic', 'Lab results', 'Jordan', 'https://']) {
    assert.ok(!json.includes(leak), `memory must not contain "${leak}"`);
  }
  const prompt = JSON.stringify(memoryForPrompt(mem));
  for (const leak of ['mybank', 'SECRET', 'clinic', 'Jordan', PRIVATE_DOMAIN]) {
    assert.ok(!prompt.includes(leak), `prompt memory must not contain "${leak}"`);
  }
  assert.match(prompt, /"site":"Private site"/);
});

// ---------------------------------------------------------------------------
// Eviction

test('eviction keeps at most 60 work pages, dropping the least used', () => {
  const mem = emptyMemory();
  for (let i = 0; i < 70; i++) work(mem, `p${i}`, (i + 1) * 10);
  const keys = Object.keys(mem.workPages);
  assert.equal(keys.length, 60);
  assert.deepEqual(keys.sort(), Array.from({ length: 60 }, (_, i) => `p${i + 10}`).sort());
});

test('eviction prefers recent pages over stale ones with more total time', () => {
  const mem = emptyMemory();
  work(mem, 'stale', 5000, { now: NOW - 60 * DAY }); // score 5000 / (1 + 60/3) ~ 238
  for (let i = 0; i < 59; i++) work(mem, `p${i}`, 1000);
  assert.equal(Object.keys(mem.workPages).length, 60);

  work(mem, 'fresh', 300); // score 300
  assert.equal(Object.keys(mem.workPages).length, 60);
  assert.equal(mem.workPages.stale, undefined, 'the stale page goes first');
  assert.ok(mem.workPages.fresh);
});

test('the work page being recorded is never evicted, so time on it accumulates when memory is full', () => {
  const mem = emptyMemory();
  for (let i = 0; i < 60; i++) work(mem, `p${i}`, 600, { now: NOW - HOUR });
  // The service worker records time in small ticks; a page the user works on now must still be learned.
  for (let t = 0; t < 20; t++) work(mem, 'current', 15, { now: NOW + t * 15000 });
  assert.equal(Object.keys(mem.workPages).length, 60);
  assert.ok(mem.workPages.current, 'the current page is remembered');
  assert.equal(mem.workPages.current.seconds, 300, 'its time was not reset by eviction');
});

test('site eviction keeps at most 300 sites, never evicts the site being recorded, and keeps flagged sites', () => {
  const mem = emptyMemory();
  for (let i = 0; i < 300; i++) recordTime(mem, { domain: `s${i}.com`, category: 'slack', seconds: (i + 1) * 60, now: NOW - DAY });
  flagSite(mem, 's0.com');
  assert.equal(Object.keys(mem.sites).length, 300);

  recordTime(mem, { domain: 'new.com', category: 'neutral', seconds: 0, newVisit: true, now: NOW });
  assert.equal(Object.keys(mem.sites).length, 300);
  assert.equal(mem.sites['new.com']?.visits, 1, 'the site just visited is kept');
  assert.ok(mem.sites['s0.com'], 'flagged sites outlive busier unflagged ones');
  assert.equal(mem.sites['s1.com'], undefined, 'the least used unflagged site is evicted');
});

// ---------------------------------------------------------------------------
// pageScore, habitFor, flagSite

test('pageScore weighs time by recency', () => {
  assert.equal(pageScore({ seconds: 300, lastSeen: NOW }, NOW), 300);
  assert.equal(pageScore({ seconds: 300, lastSeen: NOW - 3 * DAY }, NOW), 150);
  assert.equal(pageScore({ seconds: 300, lastSeen: NOW + DAY }, NOW), 300, 'future timestamps get no boost');
  assert.equal(pageScore({}, NOW), 0);
});

test('habitFor thresholds: 30 min is a habit, 2 h is strong', () => {
  const mem = emptyMemory();
  const slack = (domain, seconds) => recordTime(mem, { domain, category: 'slack', seconds, now: NOW });
  slack('under.com', 30 * 60 - 1);
  slack('habit.com', 30 * 60);
  slack('almost.com', 2 * 3600 - 1);
  slack('strong.com', 2 * 3600);
  recordTime(mem, { domain: 'work.com', category: 'work', seconds: 10 * 3600, now: NOW });

  assert.deepEqual(habitFor(mem, 'under.com'), { level: 'none', factor: 1, slackSec: 1799, flagged: false });
  assert.deepEqual(habitFor(mem, 'habit.com'), { level: 'habit', factor: 0.6, slackSec: 1800, flagged: false });
  assert.deepEqual(habitFor(mem, 'almost.com'), { level: 'habit', factor: 0.6, slackSec: 7199, flagged: false });
  assert.deepEqual(habitFor(mem, 'strong.com'), { level: 'strong', factor: 0.4, slackSec: 7200, flagged: false });
  assert.equal(habitFor(mem, 'work.com').level, 'none', 'only slack time counts');
});

test('habitFor: a flagged site with no time is a habit; unknown sites are not', () => {
  const mem = emptyMemory();
  flagSite(mem, 'tiktok.com');
  assert.deepEqual(habitFor(mem, 'tiktok.com'), { level: 'habit', factor: 0.6, slackSec: 0, flagged: true });

  recordTime(mem, { domain: 'tiktok.com', category: 'slack', seconds: 2 * 3600, now: NOW });
  assert.deepEqual(habitFor(mem, 'tiktok.com'), { level: 'strong', factor: 0.4, slackSec: 7200, flagged: true });

  const none = { level: 'none', factor: 1, slackSec: 0, flagged: false };
  assert.deepEqual(habitFor(mem, 'unknown.com'), none);
  assert.deepEqual(habitFor(emptyMemory(), 'youtube.com'), none);
  assert.deepEqual(habitFor(undefined, 'youtube.com'), none);
  assert.deepEqual(habitFor({}, 'youtube.com'), none);
});

test('flagSite flags and unflags, keeps existing time, and ignores PRIVATE_DOMAIN', () => {
  const mem = emptyMemory();
  assert.equal(flagSite(mem, 'reddit.com'), mem);
  assert.equal(mem.sites['reddit.com'].flagged, true);
  assert.deepEqual(
    { ...mem.sites['reddit.com'], lastSeen: 0 },
    { slackSec: 0, workSec: 0, neutralSec: 0, visits: 0, lastSeen: 0, flagged: true },
    'a new entry starts with no time',
  );

  recordTime(mem, { domain: 'youtube.com', category: 'slack', seconds: 90, now: NOW });
  flagSite(mem, 'youtube.com');
  assert.equal(mem.sites['youtube.com'].slackSec, 90);
  flagSite(mem, 'youtube.com', false);
  assert.equal(mem.sites['youtube.com'].flagged, false);

  recordTime(mem, { domain: 'secret.example', category: 'slack', seconds: 90, sensitive: true, now: NOW });
  const before = structuredClone(mem);
  flagSite(mem, PRIVATE_DOMAIN);
  flagSite(mem, '');
  flagSite(mem, undefined);
  assert.deepEqual(mem, before);
  assert.equal(mem.sites[PRIVATE_DOMAIN].flagged, undefined);
});

// ---------------------------------------------------------------------------
// Facts, projects, incidents

test('addFact trims, caps at 240 characters and dedups case-insensitively', () => {
  const mem = emptyMemory();
  const fact = addFact(mem, '  Binges Shorts after 10pm  ', NOW);
  assert.match(fact.id, /^fact_/);
  assert.deepEqual(fact, { id: fact.id, text: 'Binges Shorts after 10pm', at: NOW });
  assert.equal(addFact(mem, 'BINGES SHORTS AFTER 10PM'), null);
  assert.equal(addFact(mem, '  binges shorts after 10pm'), null);
  assert.equal(addFact(mem, ''), null);
  assert.equal(addFact(mem, '   '), null);
  assert.equal(addFact(mem, undefined), null);

  const long = addFact(mem, 'x'.repeat(300), NOW);
  assert.equal(long.text.length, 240);
  assert.equal(addFact(mem, 'X'.repeat(250)), null, 'compared after trimming to 240');
  assert.deepEqual(mem.facts.map((f) => f.text.length), [24, 240]);
});

test('addFact keeps only the newest 40 facts', () => {
  const mem = emptyMemory();
  for (let i = 0; i < 45; i++) addFact(mem, `fact ${i}`, NOW + i);
  assert.equal(mem.facts.length, 40);
  assert.equal(mem.facts[0].text, 'fact 5');
  assert.equal(mem.facts.at(-1).text, 'fact 44');
  assert.equal(new Set(mem.facts.map((f) => f.id)).size, 40, 'ids are unique');
});

test('addProject keeps only http(s) URLs, deduplicated, trimmed and capped to 8', () => {
  const mem = emptyMemory();
  const p = addProject(
    mem,
    {
      name: '  TaskWhip  ',
      urls: ['https://github.com/me/tw', ' http://localhost:3000 ', 'HTTPS://DEVPOST.COM/x', 'ftp://files.example', 'javascript:alert(1)', 'github.com/no-scheme', '', null, 'https://github.com/me/tw'],
      notes: 'Hackathon',
    },
    NOW,
  );
  assert.match(p.id, /^proj_/);
  assert.deepEqual(p, { id: p.id, name: 'TaskWhip', urls: ['https://github.com/me/tw', 'http://localhost:3000', 'HTTPS://DEVPOST.COM/x'], notes: 'Hackathon', at: NOW });

  const many = addProject(mem, { name: 'Many', urls: Array.from({ length: 12 }, (_, i) => `https://e.com/${i}`) });
  assert.deepEqual(many.urls, Array.from({ length: 8 }, (_, i) => `https://e.com/${i}`));

  const bare = addProject(mem, { name: 'Bare' });
  assert.deepEqual(bare.urls, []);
  assert.equal(bare.notes, '');

  assert.equal(addProject(mem, { name: '' }), null);
  assert.equal(addProject(mem, { name: '   ', urls: ['https://x.com'] }), null);
  assert.equal(addProject(mem, { name: 'N'.repeat(100) }).name, 'N'.repeat(80));
});

test('addProject merges by name, case-insensitively', () => {
  const mem = emptyMemory();
  const p = addProject(mem, { name: 'TaskWhip', urls: ['https://github.com/me/tw'], notes: 'Hackathon' }, NOW);
  const merged = addProject(mem, { name: 'taskwhip', urls: ['https://github.com/me/tw', 'https://devpost.com/tw', 'not a url'] }, NOW + 1);
  assert.equal(merged, p, 'returns the existing project');
  assert.equal(mem.projects.length, 1);
  assert.deepEqual(merged, { id: p.id, name: 'TaskWhip', urls: ['https://github.com/me/tw', 'https://devpost.com/tw'], notes: 'Hackathon', at: NOW + 1 }, 'notes are kept when none are given');

  addProject(mem, { name: 'TASKWHIP', notes: 'Due Sunday' }, NOW + 2);
  assert.equal(p.notes, 'Due Sunday');

  addProject(mem, { name: 'TaskWhip', urls: Array.from({ length: 10 }, (_, i) => `https://more.com/${i}`) });
  assert.equal(p.urls.length, 8, 'merged URLs are capped to 8');
  assert.deepEqual(p.urls.slice(0, 2), ['https://github.com/me/tw', 'https://devpost.com/tw'], 'existing URLs come first');
});

test('addProject keeps only the newest 20 projects', () => {
  const mem = emptyMemory();
  for (let i = 0; i < 25; i++) addProject(mem, { name: `P${i}` });
  assert.equal(mem.projects.length, 20);
  assert.equal(mem.projects[0].name, 'P5');
  assert.equal(mem.projects.at(-1).name, 'P24');
});

test('addIncident stamps id and time, caps the summary and keeps only the newest 60', () => {
  const mem = emptyMemory();
  const inc = addIncident(mem, { type: 'lockdown', site: 'youtube.com', summary: 's'.repeat(300) }, NOW);
  assert.match(inc.id, /^inc_/);
  assert.deepEqual(inc, { id: inc.id, at: NOW, type: 'lockdown', site: 'youtube.com', summary: 's'.repeat(240) });
  assert.equal(addIncident(mem, { type: 'beg' }, NOW).summary, undefined);

  for (let i = 0; i < 65; i++) addIncident(mem, { type: 'closed_tabs', n: i }, NOW + i);
  assert.equal(mem.incidents.length, 60);
  assert.equal(mem.incidents[0].n, 5);
  assert.equal(mem.incidents.at(-1).n, 64);
});

// ---------------------------------------------------------------------------
// forget

test('forget removes one item of each kind; "all" returns an empty memory', () => {
  const mem = emptyMemory();
  recordTime(mem, { domain: 'a.com', category: 'slack', seconds: 10, now: NOW });
  recordTime(mem, { domain: 'b.com', category: 'slack', seconds: 10, now: NOW });
  work(mem, 'k1', 10);
  work(mem, 'k2', 10);
  const [p1, p2] = [addProject(mem, { name: 'One' }), addProject(mem, { name: 'Two' })];
  const [f1, f2] = [addFact(mem, 'first'), addFact(mem, 'second')];
  const [i1, i2] = [addIncident(mem, { type: 'beg' }), addIncident(mem, { type: 'lockdown' })];

  assert.equal(forget(mem, 'site', 'a.com'), mem);
  assert.deepEqual(Object.keys(mem.sites), ['b.com', 'example.com']);
  forget(mem, 'workPage', 'k1');
  assert.deepEqual(Object.keys(mem.workPages), ['k2']);
  forget(mem, 'project', p1.id);
  assert.deepEqual(mem.projects, [p2]);
  forget(mem, 'fact', f1.id);
  assert.deepEqual(mem.facts, [f2]);
  forget(mem, 'incident', i1.id);
  assert.deepEqual(mem.incidents, [i2]);

  const snapshot = structuredClone(mem);
  forget(mem, 'site', 'missing.com');
  forget(mem, 'project', 'proj_missing');
  forget(mem, 'nonsense', 'b.com');
  assert.deepEqual(mem, snapshot, 'unknown ids and kinds change nothing');

  const cleared = forget(mem, 'all');
  assert.deepEqual(cleared, emptyMemory());
  assert.notEqual(cleared, mem);
});

// ---------------------------------------------------------------------------
// Rankings and work targets

test('topSlackSites ranks by slack time, includes flagged sites and respects the limit', () => {
  const mem = emptyMemory();
  recordTime(mem, { domain: 'reddit.com', category: 'slack', seconds: 1800, now: NOW });
  recordTime(mem, { domain: 'youtube.com', category: 'slack', seconds: 7200, newVisit: true, now: NOW });
  recordTime(mem, { domain: 'github.com', category: 'work', seconds: 9000, now: NOW });
  flagSite(mem, 'x.com');

  const top = topSlackSites(mem);
  assert.deepEqual(top.map((s) => [s.domain, s.habit]), [
    ['youtube.com', 'strong'],
    ['reddit.com', 'habit'],
    ['x.com', 'habit'],
  ]);
  assert.equal(top[0].visits, 1);
  assert.deepEqual(topSlackSites(mem, 2).map((s) => s.domain), ['youtube.com', 'reddit.com']);
});

test('topWorkPages ranks by recency-weighted time and includes the page key', () => {
  const mem = emptyMemory();
  work(mem, 'old', 1000, { now: NOW - 30 * DAY }); // ~91
  work(mem, 'mid', 200); // 200
  work(mem, 'big', 900); // 900
  const top = topWorkPages(mem, 8, NOW);
  assert.deepEqual(top.map((p) => p.key), ['big', 'mid', 'old']);
  assert.equal(top[0].url, 'https://example.com/big');
  assert.deepEqual(topWorkPages(mem, 1, NOW).map((p) => p.key), ['big']);
});

test('workTargets: task link first, then project links, then work pages; deduplicated', () => {
  const now = Date.now();
  const mem = emptyMemory();
  addProject(mem, { name: 'TaskWhip', urls: ['https://github.com/me/taskwhip', 'https://github.com/me/repo'] });
  addProject(mem, { name: 'Essay', urls: ['https://docs.google.com/document/d/1'] });
  work(mem, 'repo', 600, { url: 'https://github.com/me/repo', title: 'repo page', now });
  work(mem, 'so', 300, { url: 'https://stackoverflow.com/q/1', title: 'SO question', now });
  work(mem, 'mdn', 900, { url: 'https://developer.mozilla.org/x', title: 'MDN', now });

  const settings = { task: { title: 'Ship TaskWhip', url: '  github.com/me/repo  ' } };
  assert.deepEqual(workTargets(mem, settings, 10), [
    { url: 'https://github.com/me/repo', title: 'Ship TaskWhip', source: 'task' },
    { url: 'https://github.com/me/taskwhip', title: 'TaskWhip', source: 'project' },
    { url: 'https://docs.google.com/document/d/1', title: 'Essay', source: 'project' },
    { url: 'https://developer.mozilla.org/x', title: 'MDN', source: 'history' },
    { url: 'https://stackoverflow.com/q/1', title: 'SO question', source: 'history' },
  ]);
  assert.deepEqual(workTargets(mem, settings, 2).map((t) => t.source), ['task', 'project']);
  assert.equal(workTargets(mem, settings).length, 5);
});

test('workTargets: default limit is 6, a task URL with a scheme is kept, and no task is fine', () => {
  const mem = emptyMemory();
  addProject(mem, { name: 'Many', urls: Array.from({ length: 8 }, (_, i) => `https://e.com/${i}`) });

  const withTask = workTargets(mem, { task: { url: 'http://localhost:3000/app' } });
  assert.equal(withTask.length, 6);
  assert.deepEqual(withTask[0], { url: 'http://localhost:3000/app', title: 'Your task link', source: 'task' });

  for (const settings of [undefined, {}, { task: {} }, { task: { title: 'No link', url: '   ' } }]) {
    const targets = workTargets(mem, settings);
    assert.equal(targets[0].url, 'https://e.com/0');
    assert.equal(targets[0].source, 'project');
  }
  assert.deepEqual(workTargets(emptyMemory(), {}), []);
});

test('workTargets drops non-http links from the task, projects and history', () => {
  const mem = emptyMemory();
  mem.projects.push({ id: 'p', name: 'Odd', urls: ['ftp://files.example/x', 'chrome://settings', 'https://ok.example/'], notes: '', at: NOW });
  mem.workPages.bad = { url: 'file:///C:/notes.txt', title: 'Notes', seconds: 9999, lastSeen: Date.now() };
  mem.workPages.good = { url: 'https://good.example/', title: 'Good', seconds: 10, lastSeen: Date.now() };

  const targets = workTargets(mem, { task: { title: 'Evil', url: 'javascript:alert(1)' } });
  assert.deepEqual(targets, [
    { url: 'https://ok.example/', title: 'Odd', source: 'project' },
    { url: 'https://good.example/', title: 'Good', source: 'history' },
  ]);
});

// ---------------------------------------------------------------------------
// memoryForPrompt

test('memoryForPrompt is compact: minutes, private site label, no ids or timestamps', () => {
  const mem = emptyMemory();
  recordTime(mem, { domain: 'youtube.com', category: 'slack', seconds: 7230, newVisit: true, now: NOW });
  recordTime(mem, { domain: 'secret.example', category: 'slack', seconds: 1800, newVisit: true, sensitive: true, now: NOW });
  work(mem, 'repo', 1290, { url: 'https://github.com/me/repo', title: 'me/repo' });
  addProject(mem, { name: 'TaskWhip', urls: ['https://github.com/me/repo'], notes: 'Hackathon' }, NOW);
  addFact(mem, 'Binges Shorts after 10pm', NOW);
  addIncident(mem, { type: 'lockdown', site: 'youtube.com', summary: 'Locked down after 3 snoozes' }, NOW);

  const p = memoryForPrompt(mem);
  assert.deepEqual(p.habitualSlackSites, [
    { site: 'youtube.com', slackMin: 121, visits: 1, habit: 'strong' },
    { site: 'Private site', slackMin: 30, visits: 1, habit: 'habit' },
  ]);
  assert.deepEqual(p.workPages, [{ title: 'me/repo', url: 'https://github.com/me/repo', workMin: 22 }]);
  assert.deepEqual(p.projects, [{ name: 'TaskWhip', urls: ['https://github.com/me/repo'], notes: 'Hackathon' }]);
  assert.deepEqual(p.facts, ['Binges Shorts after 10pm']);

  const [inc] = p.recentIncidents;
  assert.equal(inc.id, undefined);
  assert.equal(inc.at, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(p.recentIncidents)), [
    { when: new Date(NOW).toLocaleString(), type: 'lockdown', site: 'youtube.com', summary: 'Locked down after 3 snoozes' },
  ]);

  const json = JSON.stringify(p);
  assert.doesNotMatch(json, /"id"|"at"|lastSeen|proj_|fact_|inc_/);
  assert.ok(!json.includes(PRIVATE_DOMAIN));
});

test('memoryForPrompt keeps only the latest 12 facts and 8 incidents', () => {
  const mem = emptyMemory();
  for (let i = 0; i < 20; i++) addFact(mem, `fact ${i}`, NOW);
  for (let i = 0; i < 20; i++) addIncident(mem, { n: i }, NOW);
  const p = memoryForPrompt(mem);
  assert.deepEqual(p.facts, Array.from({ length: 12 }, (_, i) => `fact ${i + 8}`));
  assert.deepEqual(p.recentIncidents.map((x) => x.n), Array.from({ length: 8 }, (_, i) => i + 12));
  assert.deepEqual(memoryForPrompt(emptyMemory()), { habitualSlackSites: [], workPages: [], projects: [], facts: [], recentIncidents: [] });
});

// ---------------------------------------------------------------------------
// normalizeMemory

test('normalizeMemory turns garbage into an empty memory', () => {
  for (const junk of [null, undefined, 0, 42, '', 'memory', true, [], [1, 2], () => {}]) {
    assert.deepEqual(normalizeMemory(junk), emptyMemory(), `input: ${String(junk)}`);
  }
});

test('normalizeMemory resets fields of the wrong type and drops unknown keys', () => {
  const n = normalizeMemory({ version: 7, sites: 'youtube.com', workPages: ['x'], projects: { name: 'p' }, facts: 'fact', incidents: 5, extra: 'drop me' });
  assert.deepEqual(n, emptyMemory());
  assert.deepEqual(normalizeMemory({ sites: null, workPages: 12, projects: null }), emptyMemory());

  const partial = normalizeMemory({ facts: [{ id: 'fact_1', text: 'kept', at: 1 }] });
  assert.deepEqual(partial, { ...emptyMemory(), facts: [{ id: 'fact_1', text: 'kept', at: 1 }] });

  // The result is usable by everything else.
  const mem = normalizeMemory({ sites: 'junk', projects: 'junk' });
  recordTime(mem, { domain: 'youtube.com', category: 'slack', seconds: 60, now: NOW });
  addFact(mem, 'works');
  addProject(mem, { name: 'P', urls: ['https://p.example'] });
  assert.deepEqual(Object.keys(mem.sites), ['youtube.com']);
  assert.equal(workTargets(mem, {}).length, 1);
  assert.doesNotThrow(() => memoryForPrompt(mem));
});

test('normalizeMemory keeps valid data but copies it', () => {
  const stored = {
    version: 1,
    sites: { 'youtube.com': { slackSec: 60, workSec: 0, neutralSec: 0, visits: 1, lastSeen: NOW } },
    workPages: { k: { url: 'https://example.com', title: 'Ex', seconds: 10, lastSeen: NOW } },
    projects: [{ id: 'proj_1', name: 'P', urls: [], notes: '', at: NOW }],
    facts: [{ id: 'fact_1', text: 'f', at: NOW }],
    incidents: [{ id: 'inc_1', at: NOW, type: 'beg' }],
  };
  const original = structuredClone(stored);
  const n = normalizeMemory(stored);
  assert.deepEqual(n, stored);
  for (const k of ['sites', 'workPages', 'projects', 'facts', 'incidents']) assert.notEqual(n[k], stored[k], k);

  recordTime(n, { domain: 'reddit.com', category: 'slack', seconds: 5, now: NOW });
  addFact(n, 'another');
  forget(n, 'incident', 'inc_1');
  assert.deepEqual(stored, original, 'the input is not mutated');
});

test('workTargets adds https:// to scheme-less task links, including host:port ones', () => {
  const mem = emptyMemory();
  assert.equal(workTargets(mem, { task: { title: 't', url: 'localhost:3000/app' } })[0].url, 'https://localhost:3000/app');
  assert.equal(workTargets(mem, { task: { title: 't', url: 'github.com/me/repo' } })[0].url, 'https://github.com/me/repo');
  assert.deepEqual(workTargets(mem, { task: { title: 't', url: 'mailto:me@example.com' } }), []);
});

test('normalizeMemory drops damaged entries and addProject accepts a string of links', () => {
  const mem = normalizeMemory({ facts: [null, { text: 'ok' }, 5], projects: [null, { name: 'P', urls: 'nope' }], incidents: [null, 'x', { kind: 'beg', at: 1 }] });
  assert.equal(mem.facts.length, 1);
  assert.deepEqual(mem.projects[0].urls, []);
  assert.equal(mem.incidents.length, 1);
  addProject(mem, { name: 'Q', urls: 'https://a.example, https://b.example\nhttps://c.example' });
  assert.deepEqual(mem.projects.find((p) => p.name === 'Q').urls, ['https://a.example', 'https://b.example', 'https://c.example']);
  const prompt = memoryForPrompt(mem);
  assert.ok(!('id' in prompt.recentIncidents[0]) && !('at' in prompt.recentIncidents[0]));
});
