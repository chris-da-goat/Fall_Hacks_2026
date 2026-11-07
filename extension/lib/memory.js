// Hackie's long-term memory of the user: which sites they slack on, which pages and projects are
// their real work, facts the AI learned, and a log of incidents (lockdowns, begging, closed tabs).
// Stored in chrome.storage.local under "memory"; viewable and clearable in settings.
// Pure module (no chrome.*), covered by tests/memory.test.mjs.

import { searchQuery } from './search.js';

export const PRIVATE_DOMAIN = '(private site)';

// Sites the user habitually slacks on get warned sooner: thresholds are multiplied by `factor`.
export const HABITS = [
  { level: 'strong', minSlackSec: 2 * 3600, factor: 0.4 },
  { level: 'habit', minSlackSec: 30 * 60, factor: 0.6 },
];

const MAX_SITES = 300;
const MAX_WORK_PAGES = 60;
const MAX_FACTS = 40;
const MAX_PROJECTS = 20;
const MAX_INCIDENTS = 60;

export function emptyMemory() {
  return { version: 1, sites: {}, workPages: {}, projects: [], facts: [], incidents: [] };
}

export function normalizeMemory(m) {
  const base = emptyMemory();
  if (!m || typeof m !== 'object') return base;
  const map = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});
  return {
    version: 1,
    sites: map(m.sites),
    workPages: map(m.workPages),
    projects: Array.isArray(m.projects)
      ? m.projects.filter((p) => p && typeof p.name === 'string').map((p) => ({ ...p, urls: Array.isArray(p.urls) ? p.urls.filter((u) => typeof u === 'string') : [] }))
      : [],
    facts: Array.isArray(m.facts) ? m.facts.filter((f) => f && typeof f.text === 'string') : [],
    incidents: Array.isArray(m.incidents) ? m.incidents.filter((i) => i && typeof i === 'object') : [],
  };
}

let idCounter = 0;
export function newId(prefix) {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// Drops the lowest-scoring entries; `keep` (the entry just recorded) is never dropped.
function evict(obj, max, score, keep) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  const victims = keys.filter((k) => k !== keep).sort((a, b) => score(obj[a]) - score(obj[b]));
  for (const k of victims.slice(0, keys.length - max)) delete obj[k];
}

/**
 * Record time spent on a page (mutates and returns mem).
 * @param {object} p
 * @param {string} p.domain   Display domain, or PRIVATE_DOMAIN for sensitive sites.
 * @param {string} p.category work | slack | neutral
 * @param {number} p.seconds
 * @param {boolean} [p.newVisit]  True when the user just arrived on this domain.
 * @param {string} [p.pageKey]    Stable page key (work pages are remembered for redirects).
 * @param {string} [p.url]
 * @param {string} [p.title]
 * @param {boolean} [p.sensitive] Never stores URLs or titles for sensitive pages.
 * @param {number} [p.now]
 */
export function recordTime(mem, { domain, category, seconds, newVisit = false, pageKey, url, title, sensitive = false, now = Date.now() }) {
  if (!domain || !(seconds > 0 || newVisit)) return mem;
  const key = sensitive ? PRIVATE_DOMAIN : domain;
  const site = mem.sites[key] || { slackSec: 0, workSec: 0, neutralSec: 0, visits: 0, lastSeen: 0 };
  if (seconds > 0) {
    if (category === 'slack') site.slackSec += seconds;
    else if (category === 'work') site.workSec += seconds;
    else site.neutralSec = (site.neutralSec || 0) + seconds;
  }
  if (newVisit) site.visits += 1;
  site.lastSeen = now;
  mem.sites[key] = site;
  evict(mem.sites, MAX_SITES, (s) => (s.slackSec + s.workSec) / 60 + (s.flagged ? 1e6 : 0) + s.lastSeen / 864e5, key);

  if (category === 'work' && !sensitive && pageKey && /^https?:/.test(url || '') && seconds > 0 && !searchQuery(url)) {
    const page = mem.workPages[pageKey] || { url, title: '', seconds: 0, lastSeen: 0 };
    page.url = url;
    if (title) page.title = String(title).slice(0, 140);
    page.seconds += seconds;
    page.lastSeen = now;
    mem.workPages[pageKey] = page;
    evict(mem.workPages, MAX_WORK_PAGES, (p) => pageScore(p, now), pageKey);
  }
  return mem;
}

// Recent, heavily used work pages rank first.
export function pageScore(page, now = Date.now()) {
  const ageDays = Math.max(0, (now - (page.lastSeen || 0)) / 864e5);
  return (page.seconds || 0) / (1 + ageDays / 3);
}

/**
 * How much of a habit this site is for slacking.
 * @returns {{level: 'none'|'habit'|'strong', factor: number, slackSec: number, flagged: boolean}}
 */
export function habitFor(mem, domain) {
  const site = mem?.sites?.[domain];
  const slackSec = site?.slackSec || 0;
  const flagged = Boolean(site?.flagged);
  for (const h of HABITS) {
    if (slackSec >= h.minSlackSec) return { level: h.level, factor: h.factor, slackSec, flagged };
  }
  if (flagged) return { level: 'habit', factor: HABITS[1].factor, slackSec, flagged };
  return { level: 'none', factor: 1, slackSec, flagged };
}

export function flagSite(mem, domain, flagged = true) {
  if (!domain || domain === PRIVATE_DOMAIN) return mem;
  const site = mem.sites[domain] || { slackSec: 0, workSec: 0, neutralSec: 0, visits: 0, lastSeen: Date.now() };
  site.flagged = Boolean(flagged);
  mem.sites[domain] = site;
  return mem;
}

export function addFact(mem, text, now = Date.now()) {
  const t = String(text || '').trim().slice(0, 240);
  if (!t) return null;
  if (mem.facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) return null;
  const fact = { id: newId('fact'), text: t, at: now };
  mem.facts.push(fact);
  if (mem.facts.length > MAX_FACTS) mem.facts.splice(0, mem.facts.length - MAX_FACTS);
  return fact;
}

export function addProject(mem, { name, urls = [], notes = '' }, now = Date.now()) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) return null;
  // Models sometimes send a single string; accept commas, spaces or newlines between links.
  const list = Array.isArray(urls) ? urls : typeof urls === 'string' ? urls.split(/[\s,]+/) : [];
  const cleanUrls = [...new Set(list.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 8);
  const existing = mem.projects.find((p) => p.name.toLowerCase() === n.toLowerCase());
  if (existing) {
    existing.urls = [...new Set([...existing.urls, ...cleanUrls])].slice(0, 8);
    if (notes) existing.notes = String(notes).slice(0, 300);
    existing.at = now;
    return existing;
  }
  const project = { id: newId('proj'), name: n, urls: cleanUrls, notes: String(notes || '').slice(0, 300), at: now };
  mem.projects.push(project);
  if (mem.projects.length > MAX_PROJECTS) mem.projects.splice(0, mem.projects.length - MAX_PROJECTS);
  return project;
}

export function addIncident(mem, incident, now = Date.now()) {
  const entry = { id: newId('inc'), at: now, ...incident };
  if (entry.summary) entry.summary = String(entry.summary).slice(0, 240);
  mem.incidents.push(entry);
  if (mem.incidents.length > MAX_INCIDENTS) mem.incidents.splice(0, mem.incidents.length - MAX_INCIDENTS);
  return entry;
}

// kind: site | workPage | project | fact | incident | all
export function forget(mem, kind, id) {
  if (kind === 'all') return emptyMemory();
  if (kind === 'site') delete mem.sites[id];
  else if (kind === 'workPage') delete mem.workPages[id];
  else if (kind === 'project') mem.projects = mem.projects.filter((p) => p.id !== id);
  else if (kind === 'fact') mem.facts = mem.facts.filter((f) => f.id !== id);
  else if (kind === 'incident') mem.incidents = mem.incidents.filter((i) => i.id !== id);
  return mem;
}

export function topSlackSites(mem, limit = 8) {
  return Object.entries(mem.sites)
    .filter(([, s]) => s.slackSec > 0 || s.flagged)
    .map(([domain, s]) => ({ domain, ...s, habit: habitFor(mem, domain).level }))
    .sort((a, b) => b.slackSec - a.slackSec)
    .slice(0, limit);
}

export function topWorkPages(mem, limit = 8, now = Date.now()) {
  return Object.entries(mem.workPages)
    .map(([key, p]) => ({ key, ...p }))
    .sort((a, b) => pageScore(b, now) - pageScore(a, now))
    .slice(0, limit);
}

/**
 * Candidate places to send the user back to work, best first: the task link, project links,
 * then the work pages they actually use. Deduplicated by URL.
 */
export function workTargets(mem, settings, limit = 6) {
  const out = [];
  const seen = new Set();
  const push = (url, title, source) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, title: title || '', source });
  };
  const taskUrl = String(settings?.task?.url || '').trim();
  // Add https:// only when there's no scheme ("example.com", or "localhost:3000" where the colon is a port).
  // Other schemes ("javascript:", "ftp://") are kept as-is and then dropped by push().
  if (taskUrl) push(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(taskUrl) ? taskUrl : `https://${taskUrl}`, settings.task.title || 'Your task link', 'task');
  for (const p of mem.projects) for (const u of p.urls) push(u, p.name, 'project');
  for (const p of topWorkPages(mem, 12)) push(p.url, p.title, 'history');
  return out.slice(0, limit);
}

// Compact view of memory for AI prompts. No URLs or titles of sensitive sites ever get here.
export function memoryForPrompt(mem) {
  const min = (s) => Math.round((s || 0) / 60);
  return {
    habitualSlackSites: topSlackSites(mem, 8).map((s) => ({ site: s.domain === PRIVATE_DOMAIN ? 'Private site' : s.domain, slackMin: min(s.slackSec), visits: s.visits, habit: s.habit })),
    workPages: topWorkPages(mem, 8).map((p) => ({ title: p.title, url: p.url, workMin: min(p.seconds) })),
    projects: mem.projects.map((p) => ({ name: p.name, urls: p.urls, notes: p.notes })),
    facts: mem.facts.slice(-12).map((f) => f.text),
    recentIncidents: mem.incidents.slice(-8).map(({ id, at, ...rest }) => ({ when: new Date(at).toLocaleString(), ...rest })),
  };
}

/**
 * Everything Hackie remembers, for Ask Hackie's instructions: all sites (minutes per category,
 * visits, habit), work pages, projects, facts and incidents. Sensitive sites stay "Private site".
 * If it gets big, the oldest and least-used entries are left out first (counted in `omitted`).
 */
export function memoryForAgent(mem, { now = Date.now(), maxChars = 9000 } = {}) {
  const min = (s) => Math.round((s || 0) / 60);
  const date = (t) => (t ? new Date(t).toLocaleDateString() : undefined);
  const out = {
    sites: Object.entries(mem.sites)
      .map(([domain, s]) => ({
        site: domain === PRIVATE_DOMAIN ? 'Private site' : domain,
        slackMin: min(s.slackSec),
        workMin: min(s.workSec),
        neutralMin: min(s.neutralSec),
        visits: s.visits || 0,
        habit: habitFor(mem, domain).level,
        ...(s.flagged ? { flagged: true } : {}),
        lastSeen: date(s.lastSeen),
      }))
      .sort((a, b) => b.slackMin + b.workMin + b.neutralMin - (a.slackMin + a.workMin + a.neutralMin) || b.visits - a.visits),
    workPages: topWorkPages(mem, MAX_WORK_PAGES, now).map((p) => ({ title: p.title, url: p.url, workMin: min(p.seconds), lastSeen: date(p.lastSeen) })),
    projects: [...mem.projects].sort((a, b) => (b.at || 0) - (a.at || 0)).map((p) => ({ name: p.name, urls: p.urls, ...(p.notes ? { notes: p.notes } : {}) })),
    facts: [...mem.facts].sort((a, b) => (b.at || 0) - (a.at || 0)).map((f) => ({ text: f.text, learned: date(f.at) })),
    incidents: [...mem.incidents].sort((a, b) => (b.at || 0) - (a.at || 0)).map(({ id, at, ...rest }) => ({ when: new Date(at).toLocaleString(), ...rest })),
  };
  // Over budget: drop the tail (least used / oldest) of each list in stages, projects last.
  const stages = [['incidents', 15], ['sites', 30], ['workPages', 15], ['incidents', 5], ['sites', 12], ['workPages', 6], ['facts', 15], ['sites', 5], ['incidents', 0], ['workPages', 0], ['facts', 0], ['sites', 0], ['projects', 0]];
  const omitted = {};
  for (const [key, floor] of stages) {
    while (out[key].length > floor && JSON.stringify(out).length > maxChars) {
      out[key].pop();
      omitted[key] = (omitted[key] || 0) + 1;
    }
  }
  if (Object.keys(omitted).length) out.omitted = omitted;
  return out;
}
