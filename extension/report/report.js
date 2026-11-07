import { formatDuration, focusScore } from '../lib/stats.js';

const Hackie = globalThis.Hackie;
const $ = (id) => document.getElementById(id);
const fmt = (s) => formatDuration(s, { compact: true });

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function sum(days, pick) {
  return days.reduce((acc, d) => acc + pick(d), 0);
}

function verdictFor(score) {
  if (score == null) return { mood: 'stern', text: 'Not enough data yet. Browse a little and Hackie will have opinions.' };
  if (score >= 80) return { mood: 'happy', text: `${score}% focus. Hackie is almost proud of you. Almost.` };
  if (score >= 60) return { mood: 'stern', text: `${score}% focus. Decent, recruit. Hackie has seen worse.` };
  if (score >= 40) return { mood: 'angry', text: `${score}% focus. Hackie's whip servo is overheating.` };
  return { mood: 'furious', text: `${score}% focus. Hackie is filing a formal bug report.` };
}

function rankSites(days, category) {
  const totals = {};
  for (const day of days) {
    for (const [domain, entry] of Object.entries(day.domains)) {
      if (entry[category] > 0) totals[domain] = (totals[domain] || 0) + entry[category];
    }
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function renderRank(listEl, rows, color) {
  if (!rows.length) {
    listEl.replaceChildren(el('li', { className: 'empty', textContent: 'Nothing yet.' }));
    return;
  }
  const max = rows[0][1];
  listEl.replaceChildren(
    ...rows.map(([domain, secs]) => {
      const fill = el('i');
      fill.style.width = `${(secs / max) * 100}%`;
      fill.style.background = color;
      return el('li', {}, [
        el('span', { className: 'name', textContent: domain === '(private site)' ? 'Private sites (not named)' : domain }),
        el('span', { className: 't', textContent: fmt(secs) }),
        el('span', { className: 'track' }, [fill]),
      ]);
    }),
  );
}

function renderChart(days) {
  const max = Math.max(3600, ...days.map((d) => d.totals.work + d.totals.slack + d.totals.neutral));
  const todayKey = days[days.length - 1].key;
  $('chart').replaceChildren(
    ...days.map((d) => {
      const { work, slack, neutral } = d.totals;
      const total = work + slack + neutral;
      const col = el('div', { className: 'stackcol' });
      col.style.height = `${Math.max(1, (total / max) * 100)}%`;
      for (const [v, cls] of [
        [work, 'w'],
        [slack, 's'],
        [neutral, 'n'],
      ]) {
        if (!v) continue;
        const seg = el('i', { className: `seg ${cls}` });
        seg.style.height = `${(v / total) * 100}%`;
        col.appendChild(seg);
      }
      const date = new Date(`${d.key}T12:00:00`);
      col.title = `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}\nWork ${fmt(work)} · Slacking ${fmt(slack)} · Neutral ${fmt(neutral)}`;
      const label = date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
      return el('div', { className: `bar${d.key === todayKey ? ' today' : ''}` }, [col, el('span', { className: 'lbl', textContent: label })]);
    }),
  );
}

function renderLog(days) {
  const rows = [...days].reverse().map((d) => {
    const { work, slack } = d.totals;
    const e = d.events;
    const score = focusScore(d.totals);
    const blank = work + slack + d.totals.neutral < 1;
    const date = new Date(`${d.key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const cells = [date, fmt(work), fmt(slack), score == null ? '–' : `${score}%`, e.nudges, e.whips, e.blocks, e.comebacks];
    return el('tr', { className: blank ? 'blank' : '' }, cells.map((c) => el('td', { textContent: String(c) })));
  });
  $('log').replaceChildren(...rows);
}

async function init() {
  const report = await chrome.runtime.sendMessage({ type: 'report:get', days: 14 });
  const days = report.days;
  const last7 = days.slice(-7);

  const work7 = sum(last7, (d) => d.totals.work);
  const slack7 = sum(last7, (d) => d.totals.slack);
  const score7 = focusScore({ work: work7, slack: slack7 });
  const whips = sum(days, (d) => d.events.whips + d.events.blocks);
  const comebacks = sum(days, (d) => d.events.comebacks);

  const v = verdictFor(score7);
  $('hackie').innerHTML = Hackie.html({ mood: v.mood, whip: v.mood === 'angry' || v.mood === 'furious' });
  $('verdict').textContent = report.task?.title ? `${v.text} Task: ${report.task.title}.` : v.text;

  const kpi = (cls, label, value, note) =>
    el('div', { className: `card kpi ${cls}` }, [el('span', { textContent: label }), el('b', { textContent: value }), el('small', { textContent: note })]);
  $('kpis').replaceChildren(
    kpi('work', 'Working', fmt(work7), 'last 7 days'),
    kpi('slack', 'Slacking', fmt(slack7), 'last 7 days'),
    kpi('', 'Focus score', score7 == null ? '–' : `${score7}%`, 'work ÷ (work + slack)'),
    kpi('', 'Whips & lockdowns', String(whips), 'last 14 days'),
    kpi('', 'Comebacks', String(comebacks), 'times you went back to work'),
  );

  renderChart(days);
  renderRank($('slackSites'), rankSites(days, 'slack'), 'var(--tomato)');
  renderRank($('workSites'), rankSites(days, 'work'), 'var(--leaf)');
  renderLog(days);
}

init();
