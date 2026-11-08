import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findSensitive, urlSensitive, sensitiveSet, hostInSet, PRIVATE_DOMAIN } from '../extension/lib/sensitive.js';
import { classifyPage, PRIVATE_KEY } from '../extension/lib/classify.js';
import { buildUserMessage, judgePage, REDACTED_PAGE_NOTICE } from '../extension/lib/ai.js';
import { mergeSettings, aiConfig, DEFAULT_SETTINGS } from '../extension/lib/defaults.js';
import { SENSITIVE_DOMAINS } from '../extension/data/sensitive-sites.js';

const list = ['blocked.example', 'WWW.Naughty.test', 'https://another.test/some/path', '  '];
const set = sensitiveSet(list);
const check = (url, ctx) => findSensitive({ url, ctx, list });

test('the bundled default list is loaded into settings (blank entries dropped) and editable', () => {
  assert.ok(Array.isArray(SENSITIVE_DOMAINS));
  assert.deepEqual(DEFAULT_SETTINGS.sensitiveSites, SENSITIVE_DOMAINS.filter(Boolean));
  assert.ok(DEFAULT_SETTINGS.sensitiveSites.every((d) => typeof d === 'string' && d.trim()), 'no blank entries');
  assert.deepEqual(mergeSettings({ sensitiveSites: ['mine.test'] }).sensitiveSites, ['mine.test']);
  assert.deepEqual(mergeSettings({ sensitiveSites: [] }).sensitiveSites, [], 'user can empty the list');
});

test('list entries are normalized', () => {
  assert.deepEqual([...set].sort(), ['another.test', 'blocked.example', 'naughty.test']);
});

test('direct visits, subdomains and www match; look-alikes do not', () => {
  assert.equal(check('https://blocked.example/video/1').via, 'site');
  assert.equal(check('https://www.blocked.example/').domain, 'blocked.example');
  assert.equal(check('https://cdn.eu.naughty.test/x').domain, 'naughty.test');
  assert.equal(check('https://notblocked.example/'), null);
  assert.equal(check('https://blocked.example.evil.com/'), null);
  assert.equal(check('https://github.com/example/blocked-sites/blob/main/list.txt'), null);
});

test('web proxies carrying the site in the URL are caught', () => {
  const target = 'https://blocked.example/watch?id=7';
  assert.equal(check(`https://proxysite.example/browse.php?u=${encodeURIComponent(target)}`).via, 'proxy');
  assert.equal(check(`https://p.example/?url=${encodeURIComponent(encodeURIComponent(target))}`).via, 'proxy', 'double-encoded');
  assert.equal(check(`https://p.example/go/${btoa(target)}`).via, 'proxy', 'base64 path segment');
  assert.equal(check(`https://p.example/?q=${btoa(target).replace(/\+/g, '-').replace(/\//g, '_')}`).via, 'proxy', 'url-safe base64');
  assert.equal(check('https://web.archive.org/web/2020/https://naughty.test/').via, 'proxy');
  assert.equal(check('https://www-blocked-example.translate.goog/?_x_tr_sl=auto').via, 'proxy', 'Google Translate proxy');
});

test("proxied pages are caught by their canonical / og:url even when the URL hides the site", () => {
  assert.equal(check('https://unblock.example/abc123', { canonical: 'https://blocked.example/v/1' }).via, 'proxy');
  assert.equal(check('https://unblock.example/abc123', { ogUrl: 'https://www.naughty.test/' }).via, 'proxy');
  assert.equal(check('https://unblock.example/abc123', { canonical: 'https://fine.example/' }), null);
});

test('an empty list never matches', () => {
  assert.equal(findSensitive({ url: 'https://blocked.example/', list: [] }), null);
  assert.equal(urlSensitive('https://blocked.example/', new Set()), null);
  assert.equal(hostInSet('example', set), null);
});

test('sensitive pages classify as anonymous slacking and ignore page text', () => {
  const settings = mergeSettings({ workSites: ['blocked.example'] });
  const r = classifyPage({
    url: 'https://blocked.example/x',
    ctx: { title: 'should not matter' },
    settings,
    sensitive: { domain: 'blocked.example', via: 'site' },
    aiVerdict: { category: 'work', reason: 'nope', nudge: 'Back to work!' },
  });
  assert.equal(r.category, 'slack', 'even a work-list rule or AI verdict cannot flip it');
  assert.equal(r.source, 'sensitive');
  assert.equal(r.domain, PRIVATE_DOMAIN);
  assert.equal(r.pageKey, PRIVATE_KEY);
  assert.equal(r.nudge, 'Back to work!');
  assert.ok(!JSON.stringify(r).includes('blocked.example'), 'no domain leaks into the verdict');
});

test('the AI only ever receives the blocked-content notice for sensitive pages', () => {
  const msg = buildUserMessage({ title: 'Essay' }, { redacted: true });
  assert.ok(msg.includes(REDACTED_PAGE_NOTICE));
  assert.ok(!/URL:|Title: (?!Essay)/.test(msg));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('judgePage strips a sensitive page down to the notice before sending', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = init.body;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"category":"slack","reason":"r","nudge":"Go."}' } }] }) };
  };
  const config = aiConfig(mergeSettings({ ai: { provider: 'deepseek', configs: { deepseek: { apiKey: 'k' } } } }));
  await judgePage({
    config,
    task: { title: 'Essay' },
    page: { sensitive: true, url: 'https://blocked.example/secret', title: 'Secret title', excerpt: 'secret text' },
  });
  assert.ok(sent.includes('Page information blocked'));
  for (const leak of ['blocked.example', 'Secret title', 'secret text']) assert.ok(!sent.includes(leak), `leaked ${leak}`);
});

test('blank entries in the list never match anything', () => {
  for (const url of ['https://github.com/me/repo', 'https://www.google.com/search?q=x', 'https://www.youtube.com/watch?v=1']) {
    assert.equal(findSensitive({ url, ctx: null, list: ['', '   '] }), null, url);
  }
});
