import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchQuery, normalizeQuery, isSearchEngine, MAX_QUERY_CHARS } from '../extension/lib/search.js';

// ---------------------------------------------------------------------------
// searchQuery: every engine

test('searchQuery reads Google searches on .com and country TLDs', () => {
  assert.deepEqual(searchQuery('https://www.google.com/search?q=c%2B%2B+docs'), { engine: 'Google', query: 'c++ docs', param: 'q' });
  assert.deepEqual(searchQuery('https://www.google.co.uk/search?q=linked+list'), { engine: 'Google', query: 'linked list', param: 'q' });
  assert.deepEqual(searchQuery('https://www.google.com.au/search?q=pointers'), { engine: 'Google', query: 'pointers', param: 'q' });
  assert.deepEqual(searchQuery('https://google.ca/search/?q=x'), { engine: 'Google', query: 'x', param: 'q' }, 'no www, trailing slash');
});

test('searchQuery reads every other engine with its own query parameter', () => {
  const cases = [
    ['https://www.bing.com/search?q=rust+borrow+checker&form=QBLH', 'Bing', 'rust borrow checker', 'q'],
    ['https://duckduckgo.com/?q=funny+cats&ia=web', 'DuckDuckGo', 'funny cats', 'q'],
    ['https://duckduckgo.com/html/?q=funny+cats', 'DuckDuckGo', 'funny cats', 'q'],
    ['https://html.duckduckgo.com/html?q=funny+cats', 'DuckDuckGo', 'funny cats', 'q'],
    ['https://lite.duckduckgo.com/lite/?q=funny+cats', 'DuckDuckGo', 'funny cats', 'q'],
    ['https://search.yahoo.com/search?p=weather+tomorrow&fr=yfp-t', 'Yahoo', 'weather tomorrow', 'p'],
    ['https://uk.search.yahoo.com/search?p=weather', 'Yahoo', 'weather', 'p'],
    ['https://www.baidu.com/s?wd=python+list&rsv_spt=1', 'Baidu', 'python list', 'wd'],
    ['https://yandex.ru/search/?text=kotlin+coroutines&lr=213', 'Yandex', 'kotlin coroutines', 'text'],
    ['https://yandex.com.tr/search/?text=kotlin', 'Yandex', 'kotlin', 'text'],
    ['https://www.ecosia.org/search?method=index&q=trees', 'Ecosia', 'trees', 'q'],
    ['https://search.brave.com/search?q=privacy+browser&source=web', 'Brave Search', 'privacy browser', 'q'],
    ['https://www.startpage.com/do/search?query=encryption', 'Startpage', 'encryption', 'query'],
    ['https://www.startpage.com/sp/search?query=encryption', 'Startpage', 'encryption', 'query'],
    ['https://kagi.com/search?q=lisp+macros', 'Kagi', 'lisp macros', 'q'],
    ['https://search.naver.com/search.naver?where=nexearch&query=kimchi+recipe', 'Naver', 'kimchi recipe', 'query'],
    ['https://www.youtube.com/results?search_query=linked+list+tutorial', 'YouTube', 'linked list tutorial', 'search_query'],
    ['https://m.youtube.com/results?search_query=linked+list+tutorial', 'YouTube', 'linked list tutorial', 'search_query'],
  ];
  for (const [url, engine, query, param] of cases) {
    assert.deepEqual(searchQuery(url), { engine, query, param }, url);
  }
});

test('searchQuery falls back to the secondary parameter when the main one is missing', () => {
  assert.deepEqual(searchQuery('https://search.yahoo.com/search?q=fallback'), { engine: 'Yahoo', query: 'fallback', param: 'q' });
  assert.deepEqual(searchQuery('https://www.baidu.com/s?word=fallback'), { engine: 'Baidu', query: 'fallback', param: 'word' });
  assert.deepEqual(searchQuery('https://www.startpage.com/do/search?q=fallback'), { engine: 'Startpage', query: 'fallback', param: 'q' });
});

test('searchQuery decodes percent-encoding and ignores extra params', () => {
  const plain = searchQuery('https://www.google.com/search?q=c%2B%2B+docs');
  assert.deepEqual(searchQuery('https://www.google.com/search?q=c%2B%2B+docs&sxsrf=AB5stBg123%3A1699&ei=xyz&oq=c%2B%2B&gs_lcrp=EgZj&sourceid=chrome&ie=UTF-8'), plain);
  assert.deepEqual(searchQuery('https://www.google.com/search?sca_esv=1&q=c%2B%2B%20docs#ip=1'), plain, 'param order and hash do not matter');
  assert.equal(searchQuery('https://www.google.com/search?q=%E3%81%8A%E8%8C%B6').query, 'お茶');
});

// ---------------------------------------------------------------------------
// searchQuery: not a search

test('searchQuery returns null for an engine home page or a search with no query', () => {
  for (const url of [
    'https://www.google.com/',
    'https://www.google.com/search',
    'https://www.google.com/search?q=',
    'https://www.google.com/search?q=+++',
    'https://www.google.com/search?tbm=isch',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
    'https://www.youtube.com/results',
    'https://search.naver.com/search.naver?where=nexearch',
  ]) {
    assert.equal(searchQuery(url), null, url);
  }
});

test('searchQuery returns null for non-search pages, even on search engine hosts', () => {
  for (const url of [
    'https://www.google.com/maps?q=x',
    'https://docs.google.com/document/d/x',
    'https://docs.google.com/document/d/x/edit?q=x',
    'https://mail.google.com/mail/u/0/#search/x',
    'https://www.youtube.com/watch?v=abc&q=x',
    'https://www.bing.com/maps?q=x',
    'https://www.yahoo.com/search?p=x',
    'https://github.com/search?q=linked+list',
    'https://example.com/search?q=cats',
    'https://notgoogle.com/search?q=cats',
  ]) {
    assert.equal(searchQuery(url), null, url);
  }
});

test('searchQuery returns null for non-http URLs and garbage', () => {
  for (const url of ['ftp://google.com/search?q=x', 'chrome://history/?q=x', 'file:///C:/search?q=x', 'javascript:alert(1)', 'not a url', 'google.com/search?q=x', '', null, undefined, 42, {}]) {
    assert.equal(searchQuery(url), null, String(url));
  }
});

test('searchQuery accepts a URL object', () => {
  assert.deepEqual(searchQuery(new URL('https://www.google.com/search?q=Linked+List')), { engine: 'Google', query: 'linked list', param: 'q' });
  assert.equal(searchQuery(new URL('https://www.google.com/maps?q=x')), null);
  assert.equal(searchQuery(new URL('chrome://newtab/')), null);
});

test('searchQuery normalizes the query it returns', () => {
  assert.equal(searchQuery('https://www.bing.com/search?q=%20%20Funny%0A%09CATS%20%20').query, 'funny cats');
  assert.equal(searchQuery(`https://www.google.com/search?q=${'a'.repeat(500)}`).query.length, MAX_QUERY_CHARS);
});

// ---------------------------------------------------------------------------
// normalizeQuery

test('normalizeQuery collapses whitespace, trims and lowercases', () => {
  assert.equal(normalizeQuery('  C++   Linked\tList\n\nDocs  '), 'c++ linked list docs');
  assert.equal(normalizeQuery('FUNNY Cats'), 'funny cats');
  assert.equal(normalizeQuery('already normal'), 'already normal');
});

test('normalizeQuery caps the length at MAX_QUERY_CHARS', () => {
  assert.equal(MAX_QUERY_CHARS, 120);
  assert.equal(normalizeQuery('x'.repeat(MAX_QUERY_CHARS + 50)), 'x'.repeat(MAX_QUERY_CHARS));
  assert.equal(normalizeQuery('y'.repeat(MAX_QUERY_CHARS)), 'y'.repeat(MAX_QUERY_CHARS));
  assert.equal(normalizeQuery(`   ${'z'.repeat(MAX_QUERY_CHARS)}`).length, MAX_QUERY_CHARS, 'leading whitespace does not eat into the cap');
});

test('normalizeQuery turns empty input into an empty string', () => {
  for (const q of ['', '   ', '\n\t', null, undefined]) assert.equal(normalizeQuery(q), '', String(q));
  assert.equal(normalizeQuery(42), '42');
});

// ---------------------------------------------------------------------------
// isSearchEngine

test('isSearchEngine is true for search engine hosts', () => {
  for (const host of ['google.ca', 'www.google.com', 'google.co.uk', 'bing.com', 'www.bing.com', 'WWW.Bing.com', 'duckduckgo.com', 'search.yahoo.com', 'kagi.com']) {
    assert.equal(isSearchEngine(host), true, host);
  }
});

test('isSearchEngine is false for YouTube and ordinary sites', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'github.com', 'example.com', 'notgoogle.com', 'yahoo.com', '', null, undefined]) {
    assert.equal(isSearchEngine(host), false, String(host));
  }
});

test('image, video and news search tabs are searches too, each query on its own', async () => {
  const { pageKey } = await import('../extension/lib/classify.js');
  assert.deepEqual(searchQuery('https://www.bing.com/images/search?q=Cat+GIFs&form=HDRSC2'), { engine: 'Bing', query: 'cat gifs', param: 'q' });
  assert.equal(searchQuery('https://www.bing.com/videos/search?q=c%2B%2B+pointers')?.query, 'c++ pointers');
  assert.equal(searchQuery('https://yandex.ru/images/search?text=cats')?.query, 'cats');
  assert.notEqual(pageKey('https://www.bing.com/images/search?q=cats'), pageKey('https://www.bing.com/images/search?q=c%2B%2B+docs'));
});

test("Yahoo's ;_ylt= tracking tokens don't change the search's key", async () => {
  const { pageKey } = await import('../extension/lib/classify.js');
  assert.equal(pageKey('https://search.yahoo.com/search;_ylt=AwrE1;_ylc=X1MD?p=weather'), 'search.yahoo.com/search?q=weather');
  assert.equal(pageKey('https://search.yahoo.com/search;_ylt=Zz9?p=Weather'), pageKey('https://search.yahoo.com/search?p=weather'));
});

test('search verdicts are keyed by the phrase: reused across engines, new phrases judged anew', async () => {
  const { searchVerdictKey, searchSnapshot } = await import('../extension/lib/search.js');
  const { verdictKey, pageKey } = await import('../extension/lib/classify.js');
  const g = 'https://www.google.com/search?q=C%2B%2B+docs&sca_esv=1';
  const b = 'https://www.bing.com/search?q=c%2B%2B++docs&form=QBLH';
  assert.equal(searchVerdictKey(g), 'search:c++ docs');
  assert.equal(searchVerdictKey(g), searchVerdictKey(b), 'an already judged phrase is reused on another engine');
  assert.notEqual(searchVerdictKey(g), searchVerdictKey('https://www.google.com/search?q=minecraft+speedrun'), 'a new phrase gets its own verdict');
  assert.equal(searchVerdictKey('https://www.google.com/'), null);
  assert.equal(searchVerdictKey('https://github.com/search?q=x'), null);
  // verdictKey: the phrase for searches, the page for everything else
  assert.equal(verdictKey(g), 'search:c++ docs');
  assert.equal(verdictKey('https://www.youtube.com/watch?v=abc'), pageKey('https://www.youtube.com/watch?v=abc'));
  // what the judge sees: the phrase and the engine, nothing from the page
  assert.deepEqual(searchSnapshot(g), { url: g, title: '"c++ docs" - Google search', search: { engine: 'Google', query: 'c++ docs', param: 'q' } });
  assert.equal(searchSnapshot('https://example.com/'), null);
});
