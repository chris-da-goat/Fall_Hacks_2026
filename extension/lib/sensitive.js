// Detects pages on "sensitive" sites (the user's editable list), including pages that
// proxy one of them: ?url=… parameters (plain, URL-encoded or base64), path-embedded URLs
// (web.archive.org/web/…/https://site), Google Translate proxies (site-com.translate.goog),
// and proxied pages whose canonical / og:url / <base> still point at the original site.
//
// Pure module, covered by tests/sensitive.test.mjs.

export const PRIVATE_DOMAIN = '(private site)';

const DOMAIN_TOKEN = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}/g;
const B64_SEGMENT = /^[A-Za-z0-9+/_-]{12,}={0,2}$/;

let cached = { source: null, set: new Set() };

function normalize(entry) {
  return String(entry || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#:].*$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '');
}

// Builds (and memoizes by content) a lookup set for a list of domains.
export function sensitiveSet(list) {
  const key = (list || []).join('\n');
  if (cached.source === key) return cached.set;
  const set = new Set();
  for (const entry of list || []) {
    const d = normalize(entry);
    if (d && d.includes('.')) set.add(d);
  }
  cached = { source: key, set };
  return set;
}

// "a.b.example.com" matches "example.com" or "b.example.com" in the set.
export function hostInSet(host, set) {
  let h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  while (h.includes('.')) {
    if (set.has(h)) return h;
    h = h.slice(h.indexOf('.') + 1);
  }
  return null;
}

// Google Translate proxy hosts encode the original: "www-site-com.translate.goog" -> "www.site.com"
function translateGoogHost(host) {
  const m = /^([a-z0-9-]+)\.translate\.goog$/i.exec(host);
  if (!m) return null;
  return m[1].replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function base64Decode(segment) {
  if (!B64_SEGMENT.test(segment)) return '';
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const text = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    return /^[\x20-\x7e]+$/.test(text) ? text : '';
  } catch {
    return '';
  }
}

function scanText(text, set) {
  for (const token of String(text || '').toLowerCase().match(DOMAIN_TOKEN) || []) {
    const hit = hostInSet(token, set);
    if (hit) return hit;
  }
  return null;
}

// Checks one URL: its own host, then any site it carries inside it.
export function urlSensitive(rawUrl, set) {
  if (!rawUrl || !set.size) return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const own = hostInSet(u.hostname, set);
  if (own) return { domain: own, via: 'site' };

  const translated = translateGoogHost(u.hostname);
  const viaTranslate = translated && hostInSet(translated, set);
  if (viaTranslate) return { domain: viaTranslate, via: 'proxy' };

  const rest = u.pathname + u.search + u.hash;
  const once = safeDecode(rest);
  const candidates = [rest, once, safeDecode(once)];
  for (const segment of rest.split(/[/?&=#]+/)) {
    const decoded = base64Decode(safeDecode(segment));
    if (decoded) candidates.push(decoded);
  }
  for (const text of candidates) {
    const hit = scanText(text, set);
    if (hit) return { domain: hit, via: 'proxy' };
  }
  return null;
}

/**
 * @param {object} p
 * @param {string} p.url            The tab's URL.
 * @param {object|null} [p.ctx]     Page context; canonical / ogUrl / baseHref are checked too.
 * @param {string[]} p.list         The user's sensitive-site list.
 * @returns {{domain: string, via: string}|null}
 */
export function findSensitive({ url, ctx = null, list }) {
  const set = sensitiveSet(list);
  if (!set.size) return null;
  const direct = urlSensitive(url, set);
  if (direct) return direct;
  for (const extra of [ctx?.canonical, ctx?.ogUrl, ctx?.baseHref]) {
    const hit = urlSensitive(extra, set);
    if (hit) return { domain: hit.domain, via: 'proxy' };
  }
  return null;
}
