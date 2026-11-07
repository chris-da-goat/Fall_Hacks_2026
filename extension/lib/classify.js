// Decides whether a page is "work", "slack" or "neutral" for the user's task.
// Pure module (no chrome.*), covered by tests/classify.test.mjs.

import { CATEGORY_LABEL } from './defaults.js';
import { PRIVATE_DOMAIN } from './sensitive.js';
import { searchQuery } from './search.js';

// Every sensitive page shares one key, so nothing about it is stored or cached per-URL.
export const PRIVATE_KEY = '(private)';

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'assignment', 'before', 'build', 'building', 'class', 'course',
  'doing', 'done', 'finish', 'finishing', 'from', 'have', 'homework', 'into', 'just', 'make', 'making',
  'more', 'need', 'project', 'really', 'some', 'stuff', 'study', 'studying', 'task', 'that', 'their',
  'them', 'then', 'there', 'these', 'thing', 'things', 'this', 'today', 'tomorrow', 'want', 'week',
  'what', 'when', 'will', 'with', 'work', 'working', 'write', 'writing', 'your',
]);

export function displayDomain(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^m\./, '');
}

// A stable key for "this specific page" (used for per-page overrides and the AI cache).
export function pageKey(input) {
  const u = toUrl(input);
  if (!u) return '';
  const host = displayDomain(u.hostname);
  // Each search gets its own key (and its own verdict): "c++ docs" and "funny cats" aren't the same page.
  const search = searchQuery(u);
  if (search) return `${host}${u.pathname.replace(/;.*$/, '').replace(/\/+$/, '')}?q=${search.query}`; // drop ;_ylt= style tracking tokens
  if (/(^|\.)youtube\.com$/.test(host) && u.pathname === '/watch' && u.searchParams.get('v')) {
    return `${host}/watch?v=${u.searchParams.get('v')}`;
  }
  const path = u.pathname.replace(/\/+$/, '');
  return host + path;
}

function toUrl(input) {
  if (input instanceof URL) return input;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

// "https://www.youtube.com/shorts" -> { host: 'youtube.com', path: '/shorts' }
export function parseRule(rule) {
  const raw = String(rule || '').trim();
  let r = raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '');
  if (!r) return null;
  const slash = r.indexOf('/');
  const host = (slash === -1 ? r : r.slice(0, slash)).replace(/:\d+$/, '');
  let path = slash === -1 ? '' : r.slice(slash);
  if (path === '/') path = '';
  if (!host) return null;
  return { raw, host, path };
}

export function hostMatches(host, ruleHost) {
  return host === ruleHost || host.endsWith('.' + ruleHost);
}

// Most specific matching rule from a list, or null.
export function bestRuleMatch(input, rules) {
  const u = toUrl(input);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const target = (u.pathname + u.search).toLowerCase();
  let best = null;
  for (const rule of rules || []) {
    const parsed = parseRule(rule);
    if (!parsed || !hostMatches(host, parsed.host)) continue;
    if (parsed.path && !target.startsWith(parsed.path)) continue;
    const specificity = parsed.host.length + parsed.path.length * 2;
    if (!best || specificity > best.specificity) best = { ...parsed, specificity };
  }
  return best;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word(ish) keyword matches: "react" matches "React hooks" but not "reaction".
export function findHits(text, keywords) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return [];
  const hits = [];
  for (const kw of keywords || []) {
    const k = String(kw || '').trim().toLowerCase();
    if (!k || hits.includes(k)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(k)}(?=$|[^\\p{L}\\p{N}])`, 'u');
    if (re.test(haystack)) hits.push(k);
  }
  return hits;
}

// Explicit task keywords plus meaningful words from the task title.
export function taskKeywords(task) {
  const explicit = (task?.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  const fromTitle = String(task?.title || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set([...explicit, ...fromTitle])];
}

function headlineText(ctx) {
  if (!ctx) return '';
  return [ctx.title, ctx.videoTitle, ctx.h1, ctx.channel, ctx.description, ctx.keywords]
    .filter(Boolean)
    .join(' \n ');
}

/** A label the user put on a whole site (overrides.sites), matching subdomains too. */
export function siteLabel(overrides, hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  let best = null;
  for (const [h, category] of Object.entries(overrides?.sites || {})) {
    if (!CATEGORY_LABEL[category]) continue;
    if ((host === h || host.endsWith('.' + h)) && (!best || h.length > best.host.length)) best = { host: h, category };
  }
  return best;
}

/**
 * Classify a page.
 * @param {object} p
 * @param {string} p.url
 * @param {object|null} p.ctx        What the content script read from the page.
 * @param {object} p.settings        Merged settings.
 * @param {object} [p.overrides]     { pages: { [pageKey]: category }, sites: { [host]: category } }
 * @param {object|null} [p.aiVerdict] Cached AI verdict { category, reason, nudge }.
 * @param {object|null} [p.sensitive] From findSensitive(): the page is on (or proxies) a sensitive site.
 */
export function classifyPage({ url, ctx = null, settings, overrides = {}, aiVerdict = null, sensitive = null }) {
  const u = toUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) {
    return { tracked: false, category: 'neutral', source: 'internal', reason: 'Browser page, not tracked.' };
  }

  // Sensitive sites: always slacking, recorded anonymously, and never described to the AI.
  if (sensitive) {
    return {
      tracked: true,
      sensitive: true,
      domain: PRIVATE_DOMAIN,
      pageKey: PRIVATE_KEY,
      category: 'slack',
      source: 'sensitive',
      reason:
        sensitive.via === 'proxy'
          ? 'This looks like a proxy to a site on your sensitive list. Hackie keeps the details private, even from the AI.'
          : 'This site is on your sensitive list. Hackie keeps the details private, even from the AI.',
      nudge: aiVerdict?.nudge || '',
      needsAI: true,
    };
  }

  const domain = displayDomain(u.hostname);
  const key = pageKey(u);
  const base = { tracked: true, domain, pageKey: key, needsAI: false };

  const override = overrides?.pages?.[key];
  if (override) {
    return { ...base, category: override, source: 'override', reason: `You marked this page as ${CATEGORY_LABEL[override]}.` };
  }

  // Search results are judged by the query, never by the search engine or its site rules.
  const search = searchQuery(u);
  if (search) {
    const sbase = { ...base, search };
    if (aiVerdict && CATEGORY_LABEL[aiVerdict.category]) {
      return { ...sbase, category: aiVerdict.category, source: 'ai', reason: aiVerdict.reason || `Claude judged the search "${search.query}".`, nudge: aiVerdict.nudge || '' };
    }
    const taskHits = findHits(search.query, taskKeywords(settings.task));
    const slackHits = findHits(search.query, settings.slackKeywords);
    if (taskHits.length > slackHits.length) {
      return { ...sbase, category: 'work', source: 'search', reason: `Your search "${search.query}" matches your task (${taskHits.join(', ')}).`, needsAI: Boolean(ctx) };
    }
    if (slackHits.length) {
      return { ...sbase, category: 'slack', source: 'search', reason: `Your search "${search.query}" looks like slacking (${slackHits.join(', ')}).`, needsAI: Boolean(ctx) };
    }
    return { ...sbase, category: 'neutral', source: 'search', reason: `A ${search.engine} search for "${search.query}". Hackie judges each search on its own.`, needsAI: Boolean(ctx) };
  }

  // A whole-site label still gets judged page by page: the AI's verdict on this exact page wins.
  const claim = siteLabel(overrides, u.hostname);
  if (claim) {
    if (aiVerdict && CATEGORY_LABEL[aiVerdict.category]) {
      return {
        ...base,
        category: aiVerdict.category,
        source: 'ai',
        reason: aiVerdict.category === claim.category ? aiVerdict.reason || 'Claude judged this page.' : `You labeled ${claim.host} as ${CATEGORY_LABEL[claim.category]}, but Hackie judges each page: ${aiVerdict.reason || 'this one isn\'t.'}`,
        nudge: aiVerdict.nudge || '',
      };
    }
    return { ...base, category: claim.category, source: 'site-label', reason: `You labeled ${claim.host} as ${CATEGORY_LABEL[claim.category]}. Hackie still checks each page.`, needsAI: Boolean(ctx) };
  }

  const workRule = bestRuleMatch(u, settings.workSites);
  const slackRule = bestRuleMatch(u, settings.slackSites);
  let rule = null;
  let ruleCategory = null;
  if (workRule && (!slackRule || workRule.specificity > slackRule.specificity)) {
    rule = workRule;
    ruleCategory = 'work';
  } else if (slackRule) {
    rule = slackRule;
    ruleCategory = 'slack';
  }

  // Trust the user's own work list completely.
  if (ruleCategory === 'work') {
    return { ...base, category: 'work', source: 'rule', reason: `${rule.raw} is on your work list.` };
  }

  // Claude has read this exact page before: use its judgment.
  if (aiVerdict && CATEGORY_LABEL[aiVerdict.category]) {
    return {
      ...base,
      category: aiVerdict.category,
      source: 'ai',
      reason: aiVerdict.reason || 'Claude judged this page.',
      nudge: aiVerdict.nudge || '',
    };
  }

  const headline = headlineText(ctx);
  const taskHits = findHits(headline, taskKeywords(settings.task));
  const slackHits = findHits(headline, settings.slackKeywords);
  const canAskAI = Boolean(ctx);

  if (ruleCategory === 'slack') {
    if (taskHits.length > slackHits.length) {
      return {
        ...base,
        category: 'work',
        source: 'keywords',
        reason: `${rule.raw} is a slack site, but this page mentions "${taskHits[0]}", so it looks like it's for your task.`,
      };
    }
    const extra = slackHits.length ? ` (and "${slackHits[0]}" in the title doesn't help)` : '';
    return {
      ...base,
      category: 'slack',
      source: 'rule',
      reason: `${rule.raw} is on your slack list${extra}.`,
      needsAI: canAskAI,
    };
  }

  if (taskHits.length && taskHits.length >= slackHits.length) {
    return { ...base, category: 'work', source: 'keywords', reason: `Mentions "${taskHits[0]}", which matches your task.` };
  }
  if (slackHits.length) {
    return {
      ...base,
      category: 'slack',
      source: 'keywords',
      reason: `The page mentions "${slackHits[0]}". That's slacking.`,
      needsAI: canAskAI,
    };
  }
  return {
    ...base,
    category: 'neutral',
    source: 'unknown',
    reason: "Hackie isn't sure about this site yet. Mark it as work or slacking in the popup.",
    needsAI: canAskAI,
  };
}
