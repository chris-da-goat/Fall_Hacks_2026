// Search result pages are judged by what the user searched for, never by the search engine:
// "c++ docs" on Google is work for a C++ task, "funny cat videos" isn't. Each query gets its own
// page key (and its own AI verdict). Pure module, covered by tests/search.test.mjs.

// host test, result-page path test, query parameter(s), display name
const ENGINES = [
  { name: 'Google', host: /(^|\.)google\.[a-z.]{2,6}$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Bing', host: /(^|\.)bing\.com$/, path: /^\/((images|videos|news|shop)\/)?search\/?$/, params: ['q'] },
  { name: 'DuckDuckGo', host: /(^|\.)duckduckgo\.com$/, path: /^\/(html\/?|lite\/?)?$/, params: ['q'] },
  { name: 'Yahoo', host: /(^|\.)search\.yahoo\.com$/, path: /^\/search/, params: ['p', 'q'] },
  { name: 'Baidu', host: /(^|\.)baidu\.com$/, path: /^\/s\/?$/, params: ['wd', 'word'] },
  { name: 'Yandex', host: /(^|\.)yandex\.[a-z.]{2,6}$/, path: /^\/((images|video|news)\/)?search\/?$/, params: ['text'] },
  { name: 'Ecosia', host: /(^|\.)ecosia\.org$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Brave Search', host: /(^|\.)search\.brave\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Startpage', host: /(^|\.)startpage\.com$/, path: /^\/(do|sp)\/search\/?$/, params: ['query', 'q'] },
  { name: 'Kagi', host: /(^|\.)kagi\.com$/, path: /^\/search\/?$/, params: ['q'] },
  { name: 'Naver', host: /(^|\.)search\.naver\.com$/, path: /^\/search\.naver$/, params: ['query'] },
  { name: 'YouTube', host: /(^|\.)youtube\.com$/, path: /^\/results\/?$/, params: ['search_query', 'q'] },
];

export const MAX_QUERY_CHARS = 120;

/** Collapse whitespace, lowercase, cap the length: one key per query, however it was typed. */
export function normalizeQuery(q) {
  return String(q || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_QUERY_CHARS);
}

/**
 * If `url` is a search results page, what was searched for.
 * @returns {{engine: string, query: string, param: string} | null}  query is normalized; null for
 *   non-search pages and for a search page without a query (the engine's home page).
 */
export function searchQuery(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const e of ENGINES) {
    if (!e.host.test(host) || !e.path.test(u.pathname)) continue;
    for (const param of e.params) {
      const query = normalizeQuery(u.searchParams.get(param));
      if (query) return { engine: e.name, query, param };
    }
    return null;
  }
  return null;
}

/** Is this host a search engine (any page on it)? */
export function isSearchEngine(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return ENGINES.some((e) => e.name !== 'YouTube' && e.host.test(host));
}

/**
 * The AI verdict key for a search: the phrase itself, shared by every engine, so an already
 * judged phrase is reused and every new phrase gets its own judgment. null for non-search pages.
 */
export function searchVerdictKey(url) {
  const s = searchQuery(url);
  return s ? `search:${s.query}` : null;
}

/**
 * What the AI judge sees for a search: the phrase and the engine, nothing scraped from the page.
 * (Results pages can show stale or unrelated text, e.g. the previous search's results while
 * Google swaps in a new query without reloading.)
 */
export function searchSnapshot(url) {
  const s = searchQuery(url);
  if (!s) return null;
  return { url: String(url), title: `"${s.query}" - ${s.engine} search`, search: s };
}
