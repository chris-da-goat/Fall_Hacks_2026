// Daily time-accounting helpers. Pure module, covered by tests/stats.test.mjs.

export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function lastNDayKeys(n, from = new Date()) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
}

export function emptyDay() {
  return {
    totals: { work: 0, slack: 0, neutral: 0 },
    domains: {},
    events: { nudges: 0, whips: 0, blocks: 0, snoozes: 0, comebacks: 0, exercises: 0 },
  };
}

export function normalizeDay(day) {
  const base = emptyDay();
  if (!day) return base;
  return {
    totals: { ...base.totals, ...day.totals },
    domains: { ...day.domains },
    events: { ...base.events, ...day.events },
  };
}

// Adds `seconds` of time on `domain` in `category` to a day record (mutates and returns it).
export function addTime(day, { domain, category, seconds, title }) {
  if (!domain || !(seconds > 0)) return day;
  const cat = ['work', 'slack', 'neutral'].includes(category) ? category : 'neutral';
  day.totals[cat] = (day.totals[cat] || 0) + seconds;
  const entry = day.domains[domain] || { work: 0, slack: 0, neutral: 0, lastTitle: '', lastCategory: cat };
  entry[cat] = (entry[cat] || 0) + seconds;
  entry.lastCategory = cat;
  if (title) entry.lastTitle = String(title).slice(0, 140);
  day.domains[domain] = entry;
  return day;
}

export function domainTotal(entry) {
  return (entry.work || 0) + (entry.slack || 0) + (entry.neutral || 0);
}

export function topDomains(day, limit = 8) {
  return Object.entries(day.domains || {})
    .map(([domain, entry]) => ({ domain, ...entry, total: domainTotal(entry) }))
    .filter((d) => d.total >= 1)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// Percentage of productive time out of work + slack. Null until there is a minute of data.
export function focusScore(totals) {
  const work = totals?.work || 0;
  const slack = totals?.slack || 0;
  if (work + slack < 60) return null;
  return Math.round((100 * work) / (work + slack));
}

// 3725 -> "1h 2m", 125 -> "2m 5s", 42 -> "42s"
export function formatDuration(totalSeconds, { compact = false } = {}) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return compact ? `${m}m` : `${m}m ${sec}s`;
  return `${sec}s`;
}

// 192 -> "3:12"
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
