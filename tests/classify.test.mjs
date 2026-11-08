import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, pageKey, parseRule, bestRuleMatch, findHits, taskKeywords, siteLabel, PRIVATE_KEY } from '../extension/lib/classify.js';
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

test('siteLabel matches the host, www-stripped hosts and subdomains', () => {
  const overrides = { sites: { 'youtube.com': 'work' } };
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'WWW.YouTube.com']) {
    assert.deepEqual(siteLabel(overrides, host), { host: 'youtube.com', category: 'work' }, host);
  }
  assert.equal(siteLabel(overrides, 'notyoutube.com'), null);
  assert.equal(siteLabel(overrides, 'youtube.com.evil.example'), null);
  assert.equal(siteLabel(overrides, ''), null);
  assert.equal(siteLabel({}, 'youtube.com'), null);
  assert.equal(siteLabel(undefined, 'youtube.com'), null);
});

test('siteLabel picks the longest matching site', () => {
  const overrides = { sites: { 'google.com': 'neutral', 'docs.google.com': 'work' } };
  assert.deepEqual(siteLabel(overrides, 'docs.google.com'), { host: 'docs.google.com', category: 'work' });
  assert.deepEqual(siteLabel(overrides, 'a.docs.google.com'), { host: 'docs.google.com', category: 'work' });
  assert.deepEqual(siteLabel(overrides, 'mail.google.com'), { host: 'google.com', category: 'neutral' });
  // Order in the object doesn't matter.
  const reversed = { sites: { 'docs.google.com': 'work', 'google.com': 'neutral' } };
  assert.deepEqual(siteLabel(reversed, 'docs.google.com'), { host: 'docs.google.com', category: 'work' });
});

test('siteLabel ignores invalid categories', () => {
  assert.equal(siteLabel({ sites: { 'youtube.com': 'auto' } }, 'youtube.com'), null);
  assert.equal(siteLabel({ sites: { 'youtube.com': 'bogus' } }, 'youtube.com'), null);
  assert.equal(siteLabel({ sites: { 'youtube.com': '' } }, 'youtube.com'), null);
  // An invalid longer match doesn't hide a valid shorter one.
  const overrides = { sites: { 'google.com': 'work', 'docs.google.com': 'bogus' } };
  assert.deepEqual(siteLabel(overrides, 'docs.google.com'), { host: 'google.com', category: 'work' });
});

const siteWork = { sites: { 'youtube.com': 'work' } };
const catsUrl = 'https://www.youtube.com/watch?v=cats';

test('a site label with no AI verdict yet applies, and asks the AI when the page was read', () => {
  const withCtx = classifyPage({ url: catsUrl, ctx: { title: 'Funny cat compilation - YouTube' }, settings, overrides: siteWork });
  assert.equal(withCtx.category, 'work');
  assert.equal(withCtx.source, 'site-label');
  assert.equal(withCtx.needsAI, true);
  assert.equal(withCtx.domain, 'youtube.com');
  assert.match(withCtx.reason, /youtube\.com/);
  assert.match(withCtx.reason, /still checks each page/);

  const noCtx = classifyPage({ url: catsUrl, ctx: null, settings, overrides: siteWork });
  assert.equal(noCtx.category, 'work');
  assert.equal(noCtx.source, 'site-label');
  assert.equal(noCtx.needsAI, false);
});

test('a site label beats the slack list, but the AI verdict on the page still wins', () => {
  const slack = classifyPage({
    url: catsUrl,
    ctx: { title: 'Funny cat compilation - YouTube' },
    settings,
    overrides: siteWork,
    aiVerdict: { category: 'slack', reason: 'A cat compilation.', nudge: 'Back to the linked list!' },
  });
  assert.equal(slack.category, 'slack');
  assert.equal(slack.source, 'ai');
  assert.match(slack.reason, /judges each page/);
  assert.match(slack.reason, /A cat compilation\./);
  assert.equal(slack.nudge, 'Back to the linked list!');
  assert.equal(slack.needsAI, false);

  const agrees = classifyPage({
    url: 'https://www.youtube.com/watch?v=ll',
    ctx: { title: 'Linked lists' },
    settings,
    overrides: siteWork,
    aiVerdict: { category: 'work', reason: 'A data structures lecture.', nudge: '' },
  });
  assert.equal(agrees.category, 'work');
  assert.equal(agrees.source, 'ai');
  assert.equal(agrees.reason, 'A data structures lecture.');
});

test('a site label ignores an AI verdict with an invalid category', () => {
  const r = classifyPage({ url: catsUrl, ctx: null, settings, overrides: siteWork, aiVerdict: { category: 'bogus', reason: 'x' } });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'site-label');
});

test('a page override still beats a site label', () => {
  const r = classifyPage({
    url: catsUrl,
    ctx: { title: 'Funny cat compilation - YouTube' },
    settings,
    overrides: { ...siteWork, pages: { 'youtube.com/watch?v=cats': 'slack' } },
    aiVerdict: { category: 'work', reason: 'x', nudge: '' },
  });
  assert.equal(r.category, 'slack');
  assert.equal(r.source, 'override');
});

test('sensitive pages win over a site label', () => {
  const r = classifyPage({
    url: catsUrl,
    ctx: { title: 'Funny cat compilation - YouTube' },
    settings,
    overrides: { ...siteWork, pages: { 'youtube.com/watch?v=cats': 'work' } },
    aiVerdict: { category: 'work', reason: 'x', nudge: '' },
    sensitive: { domain: 'x', via: 'host' },
  });
  assert.equal(r.category, 'slack');
  assert.equal(r.source, 'sensitive');
  assert.equal(r.sensitive, true);
  assert.equal(r.pageKey, PRIVATE_KEY);
  assert.notEqual(r.domain, 'youtube.com');
});

// ---------------------------------------------------------------------------
// Search result pages: judged by the query, never by the search engine.

const searchSettings = mergeSettings({ task: { title: 'C++ linked list assignment', keywords: ['c++', 'linked list'] } });
const gsearch = (q, extra = '') => `https://www.google.com/search?q=${encodeURIComponent(q)}${extra}`;
const cppUrl = gsearch('c++ docs');
const catsSearchUrl = gsearch('funny cat videos');
const weatherUrl = gsearch('weather tomorrow');
const searchCtx = (url) => ({ url, title: 'Google Search' });

test('pageKey gives each search query its own key', () => {
  assert.equal(pageKey(cppUrl), 'google.com/search?q=c++ docs');
  assert.notEqual(pageKey(cppUrl), pageKey(catsSearchUrl));
  assert.notEqual(pageKey(gsearch('linked list')), pageKey(gsearch('linked lists')));
  assert.notEqual(pageKey(cppUrl), pageKey('https://www.google.com/search'), 'a search is not the bare results path');
});

test('pageKey is the same however the query was typed', () => {
  const key = pageKey(cppUrl);
  assert.equal(pageKey('https://www.google.com/search?q=C%2B%2B++DOCS'), key);
  assert.equal(pageKey('https://www.google.com/search?q=%20c%2B%2B%20%20%20Docs%20'), key);
  assert.equal(pageKey('https://google.com/search/?q=c%2B%2B%09docs'), key, 'www and a trailing slash are dropped too');
});

test('pageKey ignores tracking params on a search', () => {
  const key = pageKey(cppUrl);
  assert.equal(pageKey(gsearch('c++ docs', '&sxsrf=AB5stBg%3A1699&ei=xyz&oq=c%2B%2B&sourceid=chrome&ie=UTF-8')), key);
  assert.equal(pageKey('https://www.google.com/search?sca_esv=123&q=c%2B%2B+docs#ip=1'), key);
  assert.equal(pageKey('https://www.bing.com/search?q=c%2B%2B+docs&form=QBLH&sp=-1'), pageKey('https://www.bing.com/search?q=c%2B%2B+docs'));
});

test('pageKey for searches on other engines and YouTube results', () => {
  assert.equal(pageKey('https://duckduckgo.com/?q=Funny+Cats&ia=web'), 'duckduckgo.com?q=funny cats');
  assert.equal(pageKey('https://www.youtube.com/results?search_query=Linked+List'), 'youtube.com/results?q=linked list');
  assert.notEqual(pageKey('https://www.bing.com/search?q=c%2B%2B+docs'), pageKey(cppUrl), 'each engine keeps its own key');
});

test('pageKey leaves YouTube videos and non-search pages as they were', () => {
  assert.equal(pageKey('https://www.youtube.com/watch?v=abc123&t=42s&list=PL1'), 'youtube.com/watch?v=abc123');
  assert.equal(pageKey('https://www.google.com/maps?q=coffee'), 'google.com/maps');
  assert.equal(pageKey('https://docs.google.com/document/d/x/edit?tab=t.0'), 'docs.google.com/document/d/x/edit');
  assert.equal(pageKey('https://www.google.com/search'), 'google.com/search', 'no query, no query in the key');
  assert.equal(pageKey('https://github.com/search?q=linked+list'), 'github.com/search', 'site search is not a search engine');
});

test('a search for the task is work, judged by the query', () => {
  const r = classifyPage({ url: cppUrl, ctx: searchCtx(cppUrl), settings: searchSettings });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'search');
  assert.equal(r.domain, 'google.com');
  assert.equal(r.pageKey, 'google.com/search?q=c++ docs');
  assert.deepEqual(r.search, { engine: 'Google', query: 'c++ docs', param: 'q' });
  assert.match(r.reason, /"c\+\+ docs"/);
  assert.equal(r.needsAI, true);
});

test('a search for entertainment is slack via the slack keywords', () => {
  assert.ok(searchSettings.slackKeywords.includes('funny'));
  const r = classifyPage({ url: catsSearchUrl, ctx: searchCtx(catsSearchUrl), settings: searchSettings });
  assert.equal(r.category, 'slack');
  assert.equal(r.source, 'search');
  assert.deepEqual(r.search, { engine: 'Google', query: 'funny cat videos', param: 'q' });
  assert.match(r.reason, /funny/);
  assert.equal(r.needsAI, true);
});

test('a search unrelated to the task or to slacking is neutral and asks the AI when the page was read', () => {
  const r = classifyPage({ url: weatherUrl, ctx: searchCtx(weatherUrl), settings: searchSettings });
  assert.equal(r.category, 'neutral');
  assert.equal(r.source, 'search');
  assert.equal(r.needsAI, true);
  assert.deepEqual(r.search, { engine: 'Google', query: 'weather tomorrow', param: 'q' });
  assert.match(r.reason, /Google search for "weather tomorrow"/);

  const noCtx = classifyPage({ url: weatherUrl, ctx: null, settings: searchSettings });
  assert.equal(noCtx.category, 'neutral');
  assert.equal(noCtx.needsAI, true, 'the phrase is in the URL, so the AI can judge it right away');
});

test('task keywords beat slack keywords in a search only when there are more of them', () => {
  const more = classifyPage({ url: gsearch('funny c++ linked list bug'), ctx: null, settings: searchSettings });
  assert.equal(more.category, 'work');
  const fewer = classifyPage({ url: gsearch('funny c++ memes'), ctx: null, settings: searchSettings });
  assert.equal(fewer.category, 'slack', 'one task hit vs two slack hits');
});

test('searches on other engines, and YouTube searches, are judged by the query too', () => {
  const bing = classifyPage({ url: 'https://www.bing.com/search?q=linked+list+in+c%2B%2B', ctx: null, settings: searchSettings });
  assert.equal(bing.category, 'work');
  assert.equal(bing.search.engine, 'Bing');
  const ddg = classifyPage({ url: 'https://duckduckgo.com/?q=funny+cat+videos', ctx: null, settings: searchSettings });
  assert.equal(ddg.category, 'slack');
  assert.equal(ddg.search.engine, 'DuckDuckGo');
  const yt = classifyPage({ url: 'https://www.youtube.com/results?search_query=c%2B%2B+linked+list+tutorial', ctx: null, settings: searchSettings });
  assert.equal(yt.category, 'work', 'youtube.com on the slack list does not decide a YouTube search');
  assert.equal(yt.source, 'search');
});

test('an AI verdict on a search wins over the query keywords', () => {
  const r = classifyPage({
    url: catsSearchUrl,
    ctx: searchCtx(catsSearchUrl),
    settings: searchSettings,
    aiVerdict: { category: 'work', reason: 'Cat videos for a pet-care task.', nudge: '' },
  });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'ai');
  assert.equal(r.reason, 'Cat videos for a pet-care task.');
  assert.equal(r.needsAI, false);
  assert.deepEqual(r.search, { engine: 'Google', query: 'funny cat videos', param: 'q' });

  const slack = classifyPage({ url: cppUrl, ctx: null, settings: searchSettings, aiVerdict: { category: 'slack', reason: '', nudge: 'Docs later!' } });
  assert.equal(slack.category, 'slack');
  assert.equal(slack.source, 'ai');
  assert.match(slack.reason, /"c\+\+ docs"/, 'falls back to a reason naming the search');
  assert.equal(slack.nudge, 'Docs later!');
});

test('an AI verdict with an invalid category is ignored on a search', () => {
  const r = classifyPage({ url: catsSearchUrl, ctx: null, settings: searchSettings, aiVerdict: { category: 'bogus', reason: 'x' } });
  assert.equal(r.category, 'slack');
  assert.equal(r.source, 'search');
});

test('a page override on a search applies to that query only', () => {
  const overrides = { pages: { [pageKey(catsSearchUrl)]: 'work' } };
  const same = classifyPage({ url: catsSearchUrl, ctx: searchCtx(catsSearchUrl), settings: searchSettings, overrides });
  assert.equal(same.category, 'work');
  assert.equal(same.source, 'override');

  const retyped = classifyPage({ url: 'https://www.google.com/search?q=Funny++Cat+Videos&ei=abc', ctx: null, settings: searchSettings, overrides });
  assert.equal(retyped.source, 'override', 'the same query typed differently is the same page');

  const other = classifyPage({ url: gsearch('funny dog videos'), ctx: null, settings: searchSettings, overrides });
  assert.equal(other.category, 'slack');
  assert.equal(other.source, 'search');
  const work = classifyPage({ url: cppUrl, ctx: null, settings: searchSettings, overrides: { pages: { [pageKey(catsSearchUrl)]: 'slack' } } });
  assert.equal(work.category, 'work', 'an override on one search does not touch another');
  assert.equal(work.source, 'search');
});

test('a page override beats an AI verdict on a search', () => {
  const r = classifyPage({
    url: cppUrl,
    ctx: null,
    settings: searchSettings,
    overrides: { pages: { [pageKey(cppUrl)]: 'neutral' } },
    aiVerdict: { category: 'work', reason: 'x', nudge: '' },
  });
  assert.equal(r.category, 'neutral');
  assert.equal(r.source, 'override');
});

test('the slack list does not decide a search, even with the search engine on it', () => {
  const s = mergeSettings({ ...searchSettings, slackSites: [...searchSettings.slackSites, 'google.com'] });
  const work = classifyPage({ url: cppUrl, ctx: searchCtx(cppUrl), settings: s });
  assert.equal(work.category, 'work');
  assert.equal(work.source, 'search');
  const neutral = classifyPage({ url: weatherUrl, ctx: searchCtx(weatherUrl), settings: s });
  assert.equal(neutral.category, 'neutral');
  assert.equal(neutral.source, 'search');
  // The rule still applies to Google's non-search pages.
  assert.equal(classifyPage({ url: 'https://www.google.com/maps/place/x', ctx: null, settings: s }).category, 'slack');
});

test('the work list does not decide a search, even with the search engine on it', () => {
  const s = mergeSettings({ ...searchSettings, workSites: [...searchSettings.workSites, 'google.com', 'google.com/search'] });
  const slack = classifyPage({ url: catsSearchUrl, ctx: searchCtx(catsSearchUrl), settings: s });
  assert.equal(slack.category, 'slack');
  assert.equal(slack.source, 'search');
  const neutral = classifyPage({ url: weatherUrl, ctx: searchCtx(weatherUrl), settings: s });
  assert.equal(neutral.category, 'neutral');
  assert.equal(neutral.source, 'search');
  // The rule still applies to Google's non-search pages.
  const maps = classifyPage({ url: 'https://www.google.com/maps/place/x', ctx: null, settings: s });
  assert.equal(maps.category, 'work');
  assert.equal(maps.source, 'rule');
});

test('a whole-site label on the search engine does not decide a search either', () => {
  const r = classifyPage({ url: catsSearchUrl, ctx: null, settings: searchSettings, overrides: { sites: { 'google.com': 'work' } } });
  assert.equal(r.category, 'slack');
  assert.equal(r.source, 'search');
});

test('sensitive input still wins on a search page, and the query never leaks', () => {
  const r = classifyPage({
    url: cppUrl,
    ctx: searchCtx(cppUrl),
    settings: searchSettings,
    overrides: { pages: { [pageKey(cppUrl)]: 'work' } },
    aiVerdict: { category: 'work', reason: 'x', nudge: '' },
    sensitive: { domain: 'x', via: 'proxy' },
  });
  assert.equal(r.category, 'slack');
  assert.equal(r.source, 'sensitive');
  assert.equal(r.sensitive, true);
  assert.equal(r.pageKey, PRIVATE_KEY);
  assert.equal(r.search, undefined);
  assert.ok(!JSON.stringify(r).includes('c++ docs'), 'the query is not in the verdict');
  assert.ok(!JSON.stringify(r).includes('google'), 'nor the engine');
});

test('non-search Google pages still use the work list', () => {
  const r = classifyPage({ url: 'https://docs.google.com/document/d/x', ctx: { title: 'Funny memes doc' }, settings: searchSettings });
  assert.equal(r.category, 'work');
  assert.equal(r.source, 'rule');
  assert.equal(r.search, undefined);
  assert.equal(r.pageKey, 'docs.google.com/document/d/x');
});

test('a search engine home page with no query falls back to normal classification', () => {
  const r = classifyPage({ url: 'https://www.google.com/', ctx: { title: 'Google' }, settings: searchSettings });
  assert.equal(r.search, undefined);
  assert.equal(r.source, 'unknown');
  assert.equal(r.category, 'neutral');
});
