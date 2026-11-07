import { formatDuration, formatClock, focusScore, topDomains } from '../lib/stats.js';
import { CATEGORY_LABEL } from '../lib/defaults.js';

const Hackie = globalThis.Hackie; // shared/mascot.js (classic script, loaded before this module)
const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const NEXT_CATEGORY = { work: 'slack', slack: 'neutral', neutral: 'work' };
const SOURCE_LABEL = {
  rule: 'your site lists',
  keywords: 'keywords on the page',
  ai: 'the AI judge',
  override: 'your manual choice',
  unknown: 'nothing yet',
};

// Chrome caps extension popups at 600px tall; the Ask Hackie log shrinks to keep the body inside it.
const POPUP_MAX_PX = 600;
const CHAT_MIN_PX = 72;
const CHAT_MAX_PX = 220;
const PANEL_MIN_PX = 96;
const ASK_META = 'Hackie can read your stats, settings and debug log.';
const TEST_LABEL = { 1: 'nudge', 2: 'whip', 3: 'lockdown' };

// Clicks an angry Hackie can refuse. The service worker answers {ok: false, denied: true, message}
// (angry: the AI decides, which takes a few seconds; furious: refused outright). Resuming tracking
// and ending a break are never refused, so they skip this.
const REFUSABLE = {
  break: { asking: 'whether you get a 15-min break', refused: 'Break refused' },
  pause: { asking: 'whether you can pause tracking', refused: 'Pause refused' },
  resetMood: { asking: 'whether you can reset his mood', refused: 'Mood reset refused' },
  restore: { asking: 'whether you get your tabs back', refused: 'Restore refused' },
  relabel: { asking: 'whether that label is fair', refused: 'Relabel refused' },
};
const MOOD_RANK = ['happy', 'stern', 'worried', 'angry', 'furious'];
const DECIDING_DELAY_MS = 250; // a calm Hackie answers at once; only show "deciding" when it takes a while
const VERDICT_MS = 7000;

let data = null;
let receivedAt = 0;
let scope = 'site';
let lastMood = '';
let toastTimer = 0;
let nudgeSaving = false;
let nudgeNoteUntil = 0; // keeps "Saved" / an error visible for a moment across the 5s refresh
let restoreNote = { text: '', isError: false, until: 0 }; // "Restored 3 tabs", shown in place of the restore line for a moment
// A refusable click waiting for Hackie's verdict ({action, shown}); every refusable control is disabled meanwhile.
let pending = null;
const verdict = { timer: 0, endsAt: 0, left: 0 }; // the refusal card's auto-hide (paused while hovered)
// Ask Hackie state. `pending` is the question waiting for an answer; error bubbles live only here.
const chat = { messages: [], configured: true, loaded: false, busy: false, pending: '', starters: '' };
let chatSeq = 0; // bumped when the log changes locally, so a slower agent:history reply can't overwrite it

async function load() {
  try {
    data = await send('popup:getState');
  } catch (err) {
    $('status').textContent = `Couldn't reach Hackie: ${err.message}`;
    return;
  }
  if (!data || data.ok === false) return;
  receivedAt = Date.now();
  render();
}

function liveStreak() {
  if (!data?.current || data.current.category !== 'slack') return data?.streak?.slack || 0;
  return data.streak.slack + (Date.now() - receivedAt) / 1000;
}

// Hackie's anger (lib/anger.js via popup:getState): 0 calm, 1 annoyed, 2 angry, 3 furious.
function angerState() {
  const a = data?.anger;
  const level = Math.max(0, Math.min(3, Math.floor(Number(a?.level) || 0)));
  const reasons = Array.isArray(a?.reasons) ? a.reasons.map(String).filter(Boolean) : [];
  return { level, reasons: reasons.reverse() }; // the worst reason first
}

// settings.ai.actions.overrideClicks (default on). popup:getState may leave settings.ai out.
const overridesOn = () => data?.settings?.ai?.actions?.overrideClicks !== false;

// The title suffix for a click Hackie may refuse right now ('' when he won't).
function refuseNote() {
  const { level } = angerState();
  if (level < 2 || !overridesOn()) return '';
  return level >= 3 ? "Hackie will refuse this. He's furious." : "Hackie may refuse this. He's angry, so the AI decides.";
}

function markRefusable(el, base, note) {
  el.classList.toggle('may-refuse', Boolean(note));
  el.title = [base, note].filter(Boolean).join('\n');
}

function renderAvatar() {
  const cur = data.current;
  let mood = 'happy'; // working or idle
  if (cur?.tracked && cur.category === 'slack') mood = Hackie.moodForLevel(Math.max(1, data.decision.level));
  else if (cur?.tracked && cur.category === 'neutral') mood = 'stern';
  if ((data.snoozeCount || 0) > 3) mood = 'furious'; // until the snooze run ends or "Reset mood"
  const { level } = angerState();
  const angerMood = level >= 3 ? 'furious' : level >= 2 ? 'angry' : '';
  if (MOOD_RANK.indexOf(angerMood) > MOOD_RANK.indexOf(mood)) mood = angerMood;
  const whip = level >= 3;
  const key = `${mood}${whip ? '+whip' : ''}`;
  if (key === lastMood) return;
  lastMood = key;
  const avatar = $('avatar');
  avatar.innerHTML = Hackie.html({ mood, whip }); // trusted markup from mascot.js, no page data
  avatar.title = `Hackie is ${mood}${whip ? ' and has his whip out' : ''}`;
}

// "Hackie is angry" / "Hackie is FURIOUS" under the task line (only at anger 2+), reasons in the title.
function renderAnger() {
  const { level, reasons } = angerState();
  const show = level >= 2;
  $('anger').hidden = !show;
  document.querySelector('.top').classList.toggle('has-anger', show);
  if (!show) return;
  const furious = level >= 3;
  const pill = $('angerPill');
  pill.textContent = furious ? 'Hackie is FURIOUS' : 'Hackie is angry';
  pill.classList.toggle('furious', furious);
  const what = overridesOn()
    ? furious
      ? 'He refuses breaks, pausing, Reset mood and Restore outright.'
      : 'He may refuse breaks, pausing, Reset mood and Restore. The AI decides.'
    : '';
  const title = [`${furious ? 'Hackie is furious' : 'Hackie is angry'}${reasons.length ? `: ${reasons.join('; ')}` : ''}.`, what].filter(Boolean).join('\n');
  pill.title = title;
  const why = $('angerWhy');
  why.textContent = reasons.join(', ');
  why.title = title;
}

function renderStatus() {
  const { current, settings, breakUntil } = data;
  const now = Date.now();
  let text;
  if (!settings.trackingEnabled) text = 'Tracking paused. Hackie is napping.';
  else if (breakUntil > now) text = `On a break · ${formatClock((breakUntil - now) / 1000)} left`;
  else if (!current) text = 'Not tracking (idle or unfocused)';
  else if (!current.tracked) text = 'Browser page, not tracked';
  else if (current.category === 'work') text = `Working on ${current.siteName}`;
  else if (current.category === 'slack') text = `Slacking on ${current.siteName} · ${formatClock(liveStreak())}`;
  else text = `On ${current.siteName}`;
  $('status').textContent = text;
  $('status').title = text;
}

function renderTask() {
  const title = data.settings.task.title?.trim();
  const el = $('taskTitle');
  el.textContent = title || 'not set. Tell Hackie!';
  el.title = title ? `${title} (click to edit)` : 'Set your task';
  el.classList.toggle('unset', !title);
}

function renderNow() {
  const cur = data.current;
  const pill = $('nowPill');
  const classify = $('classify');
  if (!cur || !cur.tracked) {
    $('nowDomain').textContent = cur ? 'Browser page' : 'Nothing tracked right now';
    $('nowTitle').textContent = cur?.title || '';
    pill.className = 'pill idle';
    pill.textContent = 'Idle';
    $('nowReason').textContent = cur ? cur.reason : 'Hackie only counts time while you are actively using the browser.';
    $('nowReason').title = $('nowReason').textContent;
    $('streak').hidden = true;
    classify.hidden = true;
    return;
  }
  $('nowDomain').textContent = cur.siteName;
  $('nowTitle').textContent = cur.sensitive ? 'Details hidden' : cur.title;
  $('nowTitle').title = cur.sensitive ? '' : cur.title;
  pill.className = `pill ${cur.category}`;
  pill.textContent = CATEGORY_LABEL[cur.category];
  $('nowReason').textContent = cur.reason;
  $('nowReason').title = cur.reason || ''; // the full text when body.tight cuts it to one line
  renderStreak();

  // Sensitive pages can't be reclassified here (edit the sensitive list in settings instead).
  classify.hidden = Boolean(cur.sensitive);
  if (cur.sensitive) return;
  const active = scope === 'page' ? data.pageOverride || '' : cur.category;
  document.querySelectorAll('.seg button').forEach((b) => {
    const on = b.dataset.cat === active;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = scope === 'page' && on ? 'Click again to clear the override for this page' : `Mark ${scope === 'page' ? 'this page' : `all of ${cur.domain}`} as ${CATEGORY_LABEL[b.dataset.cat]}`;
  });
  $('scopeLabel').textContent = scope === 'page' ? 'for just this page' : `for all of ${cur.domain}`;
  $('scopeToggle').textContent = scope === 'page' ? 'whole site' : 'just this page';

  const ctx = data.ctx;
  const rows = [];
  if (ctx) {
    if (ctx.title) rows.push(['Title', ctx.title]);
    if (ctx.videoTitle) rows.push(['Video', ctx.videoTitle]);
    if (ctx.channel) rows.push(['Channel', ctx.channel]);
    if (ctx.format) rows.push(['Format', ctx.format]);
    if (ctx.description) rows.push(['About', ctx.description.slice(0, 160)]);
    rows.push(['Media', ctx.mediaPlaying ? 'Playing' : 'Not playing']);
  }
  rows.push(['Decided by', SOURCE_LABEL[cur.source] || cur.source]);
  $('seesList').replaceChildren(
    ...rows.flatMap(([k, v]) => [
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: v }),
    ]),
  );
}

// Debug mode only (data.debug is null otherwise): TRACKING / NOT TRACKING + why.
function renderDebug() {
  const dbg = data.debug;
  const line = $('dbgLine');
  line.hidden = !dbg;
  if (!dbg) return;
  const last = dbg.last;
  const badge = $('dbgBadge');
  badge.className = `dbg-badge${last ? (last.tracked ? ' on' : ' off') : ''}`;
  badge.textContent = last ? (last.tracked ? 'TRACKING' : 'NOT TRACKING') : 'DEBUG';
  const why = last?.why || 'No decision recorded yet.';
  $('dbgWhy').textContent = why;
  const recent = (dbg.lines || []).slice(0, 6);
  line.title = [why, ...(recent.length ? ['', 'Recent decisions:', ...recent] : []), ...(dbg.version ? ['', `TaskWhip v${dbg.version}`] : [])].join('\n');
}

function renderStreak() {
  const cur = data.current;
  const el = $('streak');
  if (!cur || cur.category !== 'slack') {
    el.hidden = true;
    return;
  }
  const now = Date.now();
  const streak = liveStreak();
  const pausedUntil = Math.max(data.snoozeUntil || 0, data.breakUntil || 0);
  let text = `Slack streak ${formatClock(streak)}`;
  if (pausedUntil > now) text += ` · Hackie snoozed for ${formatClock((pausedUntil - now) / 1000)}`;
  else if (data.decision.nextLevelAtSec) text += ` · next warning in ${formatClock(Math.max(0, data.decision.nextLevelAtSec - streak))}`;
  el.textContent = text;
  // Habit sites (memory) get their thresholds scaled down, so say why warnings come early.
  const habit = data.habit;
  if (habit?.level === 'habit' || habit?.level === 'strong') {
    const pct = Number.isFinite(habit.factor) ? Math.round(habit.factor * 100) : 0;
    el.append(
      ' ', // a break opportunity before the note, so it wraps as one piece
      Object.assign(document.createElement('span'), {
        className: 'habit-note',
        textContent: `· ${habit.level === 'strong' ? 'strong habit' : 'habit site'}, warnings come sooner`,
        title: `You slack here a lot, so Hackie warns you ${pct ? `at ${pct}% of the usual time` : 'sooner'}. Manage this in settings under Hackie's memory.`,
      }),
    );
  }
  el.hidden = false;
}

// Consecutive snoozes (the team's rule: each one is shorter, and Hackie gets angrier), plus how many
// of them were begs for more time during a lockdown (enough begs and Hackie may close slacking tabs).
function renderSnoozes() {
  const n = data.snoozeCount || 0;
  const begs = data.lockdownBegs || 0;
  $('snoozeLine').hidden = !(n > 0 || begs > 0);
  $('snoozeText').textContent = n > 0 ? `${n} ${n === 1 ? 'snooze' : 'snoozes'} in a row${n > 3 ? ', Hackie is furious' : ''}` : '';
  const beg = $('begText');
  beg.hidden = !(begs > 0);
  if (!(begs > 0)) return;
  beg.textContent = `${n > 0 ? ' · ' : ''}${begs} ${begs === 1 ? 'beg' : 'begs'}`;
  const actions = data.settings?.ai?.actions;
  const limit = Number(actions?.closeAfterBegs) || 0;
  beg.title = `Times you begged for more time during a lockdown.${actions?.closeTabs && limit ? ` After ${limit}, Hackie may close slacking tabs.` : ''}`;
}

// The Reset mood link (it lives in the snooze line): disabled while Hackie decides, flagged when he may refuse.
function renderResetMood() {
  const btn = $('resetMood');
  btn.disabled = Boolean(pending);
  btn.setAttribute('aria-busy', String(pending?.action === 'resetMood'));
  markRefusable(btn, '', refuseNote());
}

// Seconds until Restore unlocks (Hackie locks it for a while after closing tabs, whatever his mood).
function restoreLockLeft() {
  if (!overridesOn()) return 0;
  const ms = (Number(data?.restoreLockedUntil) || 0) - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

// "Hackie closed 3 tabs · Restore" (tabs Hackie closed in the last 24h), "· Restore locked 9:42"
// while the lock runs, or the result of a restore.
function renderRestore() {
  const n = data.closedRecently || 0;
  const noting = Date.now() < restoreNote.until;
  const line = $('restoreLine');
  const wasHidden = line.hidden;
  line.hidden = !(n > 0 || noting);
  if (!line.hidden) {
    $('restoreText').textContent = noting ? restoreNote.text : `Hackie closed ${n} ${n === 1 ? 'tab' : 'tabs'}`;
    line.classList.toggle('err', noting && restoreNote.isError);
    $('restoreAct').hidden = noting;
    const btn = $('restoreBtn');
    const left = restoreLockLeft();
    btn.disabled = left > 0 || Boolean(pending);
    btn.classList.toggle('locked', left > 0);
    btn.setAttribute('aria-busy', String(pending?.action === 'restore'));
    if (left > 0) {
      btn.textContent = `Restore locked ${formatClock(left)}`;
      btn.setAttribute('aria-label', 'Restore is locked'); // the line is a live region; don't announce every tick
      markRefusable(btn, `Hackie locked Restore after closing your tabs. It unlocks in ${formatClock(left)}.`, '');
    } else {
      btn.textContent = 'Restore';
      btn.removeAttribute('aria-label');
      markRefusable(btn, 'Reopen the tabs Hackie closed', refuseNote());
    }
  }
  if (wasHidden !== line.hidden) fitPopup();
}

async function restoreTabs() {
  if (restoreLockLeft() > 0) return;
  const res = await askHackie('restore', 'closed:restore');
  if (res === null) return; // another click is still waiting for Hackie
  if (res?.denied) {
    load();
    return;
  }
  const n = Number(res?.restored) || 0;
  restoreNote = res?.ok
    ? { text: n > 0 ? `Restored ${n} ${n === 1 ? 'tab' : 'tabs'}` : 'Nothing left to restore', isError: false, until: Date.now() + 4000 }
    : { text: res?.error || "Couldn't restore the tabs.", isError: true, until: Date.now() + 6000 };
  if (data) renderRestore();
  load();
}

function renderToday() {
  const { today, settings } = data;
  const t = today.totals;
  $('kWork').textContent = formatDuration(t.work, { compact: true });
  $('kSlack').textContent = formatDuration(t.slack, { compact: true });
  const score = focusScore(t);
  $('kFocus').textContent = score == null ? '–' : `${score}%`;
  const exercises = today.events.exercises || 0; // missing on days saved before exercise breaks existed
  $('kBreaks').textContent = String(exercises);

  const budgetMin = settings.thresholds.dailySlackBudgetMin;
  $('budget').hidden = !(budgetMin > 0);
  if (budgetMin > 0) {
    const pct = Math.min(100, (t.slack / (budgetMin * 60)) * 100);
    $('budgetText').textContent = `${formatDuration(t.slack, { compact: true })} of ${budgetMin}m`;
    const fill = $('budgetFill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('over', t.slack >= budgetMin * 60);
  }

  const e = today.events;
  const parts = [
    [e.nudges, 'nudge', 'nudges'],
    [e.whips, 'whip', 'whips'],
    [e.blocks, 'lockdown', 'lockdowns'],
    [e.snoozes, 'snooze', 'snoozes'],
    [e.comebacks, 'comeback', 'comebacks'],
    [exercises, 'exercise break', 'exercise breaks'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  $('events').textContent = parts.length ? `Hackie today: ${parts.join(' · ')}` : "Hackie hasn't had to say a word today.";

  renderNudge();
}

// "Nudge me after [N] min of slacking" (settings.thresholds.nudgeAfterMin; 0 = off).
function renderNudge() {
  const input = $('nudgeInput');
  const current = data.settings.thresholds.nudgeAfterMin;
  // Don't overwrite the field while someone is typing in it or a save is in flight.
  if (document.activeElement !== input && !nudgeSaving) input.value = current == null ? '' : String(current);
  if (Date.now() < nudgeNoteUntil) return;
  const msg = $('nudgeMsg');
  msg.className = 'nudge-msg';
  msg.textContent = Number(current) === 0 ? '(off)' : '';
}

function nudgeNote(text, isError = false) {
  const msg = $('nudgeMsg');
  msg.className = `nudge-msg${isError ? ' err' : ''}`;
  msg.textContent = text;
  nudgeNoteUntil = Date.now() + (isError ? 6000 : 2500);
  fitPopup(); // a long error can wrap the row
}

async function saveNudge() {
  const input = $('nudgeInput');
  const value = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(value) || value < 0) {
    nudgeNote('Use 0 or more minutes (0 = off).', true);
    return;
  }
  nudgeSaving = true;
  let res;
  try {
    res = await send('popup:setThreshold', { key: 'nudgeAfterMin', value });
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  nudgeSaving = false;
  if (res?.ok) {
    nudgeNote(value === 0 ? 'Off' : 'Saved');
    load();
  } else {
    nudgeNote(res?.error || "Couldn't save that.", true);
  }
}

function renderSites() {
  const list = $('sites');
  const sites = topDomains(data.today, 5);
  if (!sites.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No browsing tracked yet today.' }));
    return;
  }
  const max = sites[0].total;
  list.replaceChildren(
    ...sites.map((s) => {
      const li = document.createElement('li');
      li.className = 'site';
      const name = Object.assign(document.createElement('span'), { className: 'name', textContent: s.domain, title: s.lastTitle || s.domain });
      if (s.domain === '(private site)') {
        name.textContent = 'Private sites';
        name.title = 'Sites on your sensitive list are grouped and never named';
      }
      const cat = Object.assign(document.createElement(s.domain === '(private site)' ? 'span' : 'button'), {
        className: `pill ${s.lastCategory} cat-btn`,
        textContent: CATEGORY_LABEL[s.lastCategory],
        title: `Click to mark ${s.domain} as ${CATEGORY_LABEL[NEXT_CATEGORY[s.lastCategory]]}`,
      });
      if (cat.tagName === 'SPAN') cat.title = '';
      else cat.addEventListener('click', async () => {
        await askHackie('relabel', 'popup:setCategory', { scope: 'site', category: NEXT_CATEGORY[s.lastCategory], url: `https://${s.domain}/` });
        load();
      });
      const time = Object.assign(document.createElement('span'), { className: 'time num', textContent: formatDuration(s.total, { compact: true }) });
      const stack = document.createElement('div');
      stack.className = 'stack';
      stack.style.width = `${Math.max(4, (s.total / max) * 100)}%`;
      for (const [k, cls] of [
        ['work', 'w'],
        ['slack', 's'],
        ['neutral', 'n'],
      ]) {
        if (!s[k]) continue;
        const i = document.createElement('i');
        i.className = cls;
        i.style.width = `${(s[k] / s.total) * 100}%`;
        stack.appendChild(i);
      }
      li.append(name, cat, time, stack);
      return li;
    }),
  );
}

function renderWeek() {
  const max = Math.max(3600, ...data.week.map((d) => d.totals.work + d.totals.slack));
  const todayKey = data.week[data.week.length - 1].key;
  $('week').replaceChildren(
    ...data.week.map((d) => {
      const { work, slack } = d.totals;
      const wrap = document.createElement('div');
      wrap.className = `day${d.key === todayKey ? ' today' : ''}`;
      const col = document.createElement('div');
      col.className = 'col';
      col.style.height = `${Math.max(3, ((work + slack) / max) * 100)}%`;
      const date = new Date(`${d.key}T12:00:00`);
      col.title = `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}\nWork ${formatDuration(work, { compact: true })} · Slacking ${formatDuration(slack, { compact: true })}`;
      if (work + slack > 0) {
        const w = Object.assign(document.createElement('i'), { className: 'w' });
        w.style.height = `${(work / (work + slack)) * 100}%`;
        const s = Object.assign(document.createElement('i'), { className: 's' });
        s.style.height = `${(slack / (work + slack)) * 100}%`;
        col.append(w, s);
      }
      const label = Object.assign(document.createElement('span'), { className: 'd', textContent: date.toLocaleDateString(undefined, { weekday: 'narrow' }) });
      wrap.append(col, label);
      return wrap;
    }),
  );
}

function renderFooter() {
  const now = Date.now();
  const note = refuseNote();
  const breakBtn = $('breakBtn');
  const onBreak = data.breakUntil > now;
  const deciding = pending?.action === 'break' && pending.shown;
  breakBtn.textContent = deciding ? 'Hackie is deciding…' : onBreak ? `End break (${formatClock((data.breakUntil - now) / 1000)} left)` : 'Take a 15-min break';
  breakBtn.classList.toggle('active', onBreak && !deciding);
  breakBtn.disabled = Boolean(pending);
  breakBtn.setAttribute('aria-busy', String(pending?.action === 'break'));
  markRefusable(breakBtn, '', onBreak ? '' : note); // ending a break is never refused
  const trackBtn = $('trackBtn');
  const tracking = data.settings.trackingEnabled;
  trackBtn.textContent = tracking ? 'Pause' : 'Resume';
  trackBtn.disabled = Boolean(pending);
  trackBtn.setAttribute('aria-busy', String(pending?.action === 'pause'));
  markRefusable(trackBtn, tracking ? 'Stop tracking until you resume' : 'Start tracking again', tracking ? note : ''); // resuming is never refused
}

function render() {
  renderAvatar();
  renderAnger();
  renderStatus();
  renderTask();
  renderNow();
  renderSnoozes();
  renderResetMood();
  renderDebug();
  renderToday();
  renderSites();
  renderWeek();
  renderFooter();
  renderRestore();
  // The empty chat's starter prompts depend on whether the current page is tracked.
  if (chat.starters && chat.starters !== starterPrompts().join('|')) renderChat();
  fitPopup();
}

// Keep the body within Chrome's 600px popup cap: the Ask tab shrinks its chat log; the other
// tabs only get capped (and scroll inside) when long text (2-line reasons etc.) would overflow.
function fitPopup() {
  const panel = document.querySelector('main > .panel:not([hidden])');
  if (!panel) return;
  if (panel.id === 'panel-ask') {
    fitChat();
    return;
  }
  document.body.classList.remove('tight'); // only the Ask tab condenses the now-card
  const rest =document.body.getBoundingClientRect().height - panel.getBoundingClientRect().height;
  const room = Math.floor(POPUP_MAX_PX - rest) - 1;
  const natural = panel.scrollHeight + (panel.offsetHeight - panel.clientHeight); // content + borders
  const capped = natural > room;
  panel.style.maxHeight = capped ? `${Math.max(PANEL_MIN_PX, room)}px` : '';
  panel.style.minHeight = capped ? '0' : '';
  panel.style.overflowY = capped ? 'auto' : '';
}

// ---------------------------------------------------------------------------
// Ask Hackie

const prettyTool = (name) => String(name).replace(/^get_/, '').replace(/_/g, ' ');
// Answers are plain text, but models still sprinkle **bold** and `code`; drop the markers.
const plainText = (text) =>
  String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');

function chatBubble(role, text, { tools, at, pending = false } = {}) {
  const kind = role === 'user' ? 'me' : role === 'error' ? 'err' : 'bot';
  const msg = document.createElement('div');
  msg.className = `msg ${kind}${pending ? ' pending' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const who = Object.assign(document.createElement('span'), { className: 'sr-only', textContent: kind === 'me' ? 'You: ' : 'Hackie: ' });
  bubble.append(who, document.createTextNode(role === 'assistant' ? plainText(text) : String(text ?? '')));
  if (at) bubble.title = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  msg.append(bubble);
  const used = [...new Set(tools || [])];
  if (role === 'assistant' && used.length) {
    msg.append(Object.assign(document.createElement('div'), { className: 'tools', textContent: `Used ${used.map(prettyTool).join(', ')}`, title: used.join(', ') }));
  }
  return msg;
}

function starterPrompts() {
  const cur = data?.current;
  return ['How am I doing today?', cur?.tracked ? `Why does this count as ${CATEGORY_LABEL[cur.category] || cur.category}?` : "Why aren't you tracking?", 'What did I slack on this week?'];
}

function chatStarters(prompts) {
  const wrap = document.createElement('div');
  wrap.className = 'starters';
  for (const q of prompts) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'starter', textContent: q });
    b.addEventListener('click', () => {
      $('askInput').value = q;
      askQuestion(q);
    });
    wrap.append(b);
  }
  return wrap;
}

function renderChat() {
  const log = $('chatLog');
  const nodes = chat.messages.map((m) => chatBubble(m.role, m.text, m));
  if (chat.pending) nodes.push(chatBubble('user', chat.pending), chatBubble('assistant', 'Hackie is checking…', { pending: true }));
  chat.starters = '';
  if (!nodes.length && chat.loaded && chat.configured) {
    const prompts = starterPrompts();
    chat.starters = prompts.join('|');
    nodes.push(chatBubble('assistant', "Ask me about your day. I'll check your tracking data before I answer."), chatStarters(prompts));
  }
  log.replaceChildren(...nodes);
  log.hidden = !nodes.length;
  $('askHead').hidden = !chat.configured && !chat.messages.length;
  $('askSetup').hidden = chat.configured;
  const input = $('askInput');
  input.disabled = !chat.configured || chat.busy;
  input.placeholder = chat.configured ? 'Ask Hackie about your time…' : 'Needs an AI key in settings';
  $('askBtn').disabled = input.disabled;
  $('askClear').hidden = !chat.messages.length;
  $('askClear').disabled = chat.busy;
  fitChat();
  log.scrollTop = log.scrollHeight;
}

// Give the log whatever height is left under the 600px popup cap (within CHAT_MIN_PX..CHAT_MAX_PX).
// When even the smallest log doesn't fit (debug mode + a long reason + snoozes + habit + closed tabs),
// body.tight condenses the now-card's reason and debug lines to one line each (full text in tooltips).
function fitChat() {
  if ($('panel-ask').hidden) return;
  const log = $('chatLog');
  const body = document.body;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  body.classList.remove('tight');
  if (!log.hidden) log.style.maxHeight = `${CHAT_MIN_PX}px`;
  if (body.getBoundingClientRect().height > POPUP_MAX_PX) body.classList.add('tight');
  if (log.hidden) return;
  const rest = body.getBoundingClientRect().height - log.getBoundingClientRect().height;
  const room = Math.floor(POPUP_MAX_PX - rest) - 2;
  log.style.maxHeight = `${Math.max(CHAT_MIN_PX, Math.min(CHAT_MAX_PX, room))}px`;
  if (atBottom) log.scrollTop = log.scrollHeight; // stay pinned to the newest message
}

async function loadChat() {
  const seq = chatSeq;
  let res;
  try {
    res = await send('agent:history');
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (seq !== chatSeq) return;
  chat.loaded = true;
  if (res?.ok) {
    chat.messages = Array.isArray(res.messages) ? res.messages : [];
    chat.configured = res.configured !== false;
  } else {
    chat.messages.push({ role: 'error', text: `Couldn't load the chat: ${res?.error || 'no answer from Hackie'}`, at: Date.now() });
  }
  renderChat();
}

async function askQuestion(text) {
  const question = String(text || '').trim();
  if (!question || chat.busy || !chat.configured) return;
  const at = Date.now();
  chatSeq += 1;
  chat.busy = true;
  chat.pending = question;
  $('askInput').value = '';
  renderChat();
  let res;
  try {
    res = await send('agent:ask', { question });
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  chatSeq += 1;
  chat.busy = false;
  chat.pending = '';
  chat.messages.push({ role: 'user', text: question, at });
  const meta = $('askMeta');
  if (res?.ok) {
    chat.messages.push({ role: 'assistant', text: res.answer, at: Date.now(), tools: (res.steps || []).map((s) => s.tool) });
    meta.textContent = [res.model, Number.isFinite(res.ms) ? `${(res.ms / 1000).toFixed(1)}s` : ''].filter(Boolean).join(' · ') || ASK_META;
    meta.title = meta.textContent;
    load(); // a tool may have changed a category or started a break
  } else {
    chat.messages.push({ role: 'error', text: res?.error || "Hackie didn't answer. Try again in a moment.", at: Date.now() });
    if (!$('askInput').value) $('askInput').value = question; // easy retry
  }
  renderChat();
  if (!$('panel-ask').hidden) $('askInput').focus();
}

function selectTab(name) {
  document.querySelectorAll('.tabs [role="tab"]').forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    $(`panel-${tab.dataset.tab}`).hidden = !on;
  });
  try {
    localStorage.setItem('taskwhip.tab', name);
  } catch {
    /* storage unavailable */
  }
  if (name === 'ask') {
    renderChat();
    loadChat();
  } else {
    fitPopup();
  }
}

// ---------------------------------------------------------------------------
// Test mode (footer): fire a nudge / whip / lockdown at the current tab.

function showToast(text, isError = false) {
  const el = $('testMsg');
  el.textContent = text;
  el.className = `toast${isError ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 7000 : 3500);
}

function setTestMode(on) {
  $('footMain').hidden = on;
  $('testRow').hidden = !on;
  $('testBtn').setAttribute('aria-expanded', String(on));
  (on ? $('testNudge') : $('testBtn')).focus();
}

async function testFire(level) {
  const buttons = $('testRow').querySelectorAll('[data-level]');
  buttons.forEach((b) => (b.disabled = true));
  let res;
  try {
    res = await send('test:fire', { level });
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  buttons.forEach((b) => (b.disabled = false));
  if (res?.ok) showToast(`Sent a test ${TEST_LABEL[level]} to the current tab.`);
  else showToast(res?.error || `Couldn't send the ${TEST_LABEL[level]}.`, true);
}

function setSees(open) {
  $('seesList').hidden = !open;
  $('seesToggle').setAttribute('aria-expanded', String(open));
}

// ---------------------------------------------------------------------------
// Refusable clicks (break, pause, Reset mood, Restore): "Hackie is deciding…" while the service
// worker (maybe the AI) decides, then Hackie's angry speech if he says no. State is left alone on a refusal.

// Sends one refusable click. Returns the response, or null if another click is still waiting for a verdict.
async function askHackie(action, type, payload = {}) {
  if (pending) return null;
  const mine = { action, shown: false };
  pending = mine;
  renderPending();
  const slow = setTimeout(() => {
    mine.shown = true;
    renderPending();
  }, DECIDING_DELAY_MS);
  let res;
  try {
    res = await send(type, payload);
  } catch (err) {
    res = { ok: false, error: `Couldn't reach Hackie: ${err.message}` };
  }
  clearTimeout(slow);
  pending = null;
  renderPending();
  if (res?.denied) showVerdict(action, res.message);
  return res;
}

function renderPending() {
  const box = $('deciding');
  const show = Boolean(pending?.shown);
  if (show && box.hidden) {
    $('decidingHackie').innerHTML = Hackie.html({ mood: 'curious', whip: false });
    $('testMsg').hidden = true;
  }
  box.hidden = !show;
  $('decidingWhat').textContent = show ? REFUSABLE[pending.action]?.asking || '' : '';
  if (!data) return;
  renderFooter();
  renderResetMood();
  renderRestore();
}

// The refusal: furious Hackie (whip out) and his speech, in a card floating above the footer for ~7s.
function showVerdict(action, message) {
  const box = $('verdict');
  $('testMsg').hidden = true;
  $('verdictHackie').innerHTML = Hackie.html({ mood: 'furious', whip: true });
  $('verdictTitle').textContent = REFUSABLE[action]?.refused || 'Refused';
  const text = String(message || '').trim() || 'DENIED.';
  $('verdictMsg').textContent = text; // AI-written: text only
  $('verdictMsg').title = text; // the whole speech if the card clamps it
  box.hidden = false;
  box.classList.remove('show');
  void box.offsetWidth; // restart the entrance shake and the countdown bar
  box.classList.add('show');
  crack($('verdictHackie'));
  armVerdict(VERDICT_MS);
}

function armVerdict(ms) {
  clearTimeout(verdict.timer);
  verdict.endsAt = Date.now() + ms;
  verdict.timer = setTimeout(hideVerdict, ms);
}

function hideVerdict() {
  clearTimeout(verdict.timer);
  $('verdict').hidden = true;
  $('verdict').classList.remove('show');
}

// The options page hero's whip crack: the refusal card's Hackie lashes out once.
function crack(container) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const whip = container.querySelector('.hk-whip');
  if (!whip?.animate) return;
  whip.style.transformBox = 'view-box';
  whip.style.transformOrigin = '15px 64px';
  whip.animate(
    [{ transform: 'rotate(40deg)' }, { transform: 'rotate(-38deg)', offset: 0.45 }, { transform: 'rotate(12deg)', offset: 0.7 }, { transform: 'rotate(0)' }],
    { duration: 540, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  container.querySelector('.hk-burst')?.animate(
    [
      { opacity: 0, transform: 'translate(-104px, 50px) scale(.2)' },
      { opacity: 1, transform: 'translate(-104px, 50px) scale(1.35)', offset: 0.3 },
      { opacity: 0, transform: 'translate(-104px, 50px) scale(1.7)' },
    ],
    { duration: 600, delay: 220 },
  );
}

// ---------------------------------------------------------------------------

document.querySelectorAll('.seg button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!data?.current?.url) return;
    let category = btn.dataset.cat;
    if (scope === 'page' && data.pageOverride === category) category = 'auto';
    await askHackie('relabel', 'popup:setCategory', { scope, category, url: data.current.url });
    load();
  });
});

$('scopeToggle').addEventListener('click', () => {
  scope = scope === 'page' ? 'site' : 'page';
  renderNow();
  fitPopup();
});

// "What Hackie read" is a popover: the link toggles it; Escape or a click elsewhere closes it.
$('seesToggle').addEventListener('click', () => setSees($('seesList').hidden));
document.addEventListener('click', (e) => {
  if (!$('seesList').hidden && !e.target.closest('#seesList, #seesToggle')) setSees(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('seesList').hidden) return;
  e.preventDefault();
  setSees(false);
  $('seesToggle').focus();
});

$('resetMood').addEventListener('click', async () => {
  const res = await askHackie('resetMood', 'popup:resetMood');
  if (res === null) return;
  if (res?.ok === false && !res.denied) showToast(res.error || "Couldn't reset Hackie's mood.", true);
  load();
});

$('verdictClose').addEventListener('click', hideVerdict);
// Hovering the refusal card holds it (its countdown bar pauses in CSS too).
$('verdict').addEventListener('mouseenter', () => {
  verdict.left = Math.max(0, verdict.endsAt - Date.now());
  clearTimeout(verdict.timer);
});
$('verdict').addEventListener('mouseleave', () => {
  if (!$('verdict').hidden) armVerdict(Math.max(1500, verdict.left));
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('verdict').hidden) return;
  e.preventDefault();
  hideVerdict();
});

$('nudgeInput').addEventListener('change', saveNudge);
$('restoreBtn').addEventListener('click', restoreTabs);

$('testBtn').addEventListener('click', () => setTestMode(true));
$('testDone').addEventListener('click', () => setTestMode(false));
$('testRow')
  .querySelectorAll('[data-level]')
  .forEach((btn) => btn.addEventListener('click', () => testFire(Number(btn.dataset.level))));

document.querySelectorAll('.tabs [role="tab"]').forEach((tab) =>
  tab.addEventListener('click', () => {
    selectTab(tab.dataset.tab);
    if (tab.dataset.tab === 'ask' && !$('askInput').disabled) $('askInput').focus();
  }),
);

$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  askQuestion($('askInput').value);
});

$('askClear').addEventListener('click', async () => {
  chatSeq += 1;
  chat.messages = [];
  $('askMeta').textContent = ASK_META;
  $('askMeta').title = '';
  renderChat();
  try {
    await send('agent:clear');
  } catch {
    /* the service worker will be back next time; the log is already empty here */
  }
});

$('askSetupBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

try {
  const saved = localStorage.getItem('taskwhip.tab');
  if (saved && $(`panel-${saved}`)) selectTab(saved);
} catch {
  /* storage unavailable */
}

$('breakBtn').addEventListener('click', async () => {
  if (!data) return;
  if (data.breakUntil > Date.now()) {
    await send('popup:break', { minutes: 0 }); // ending a break early is never refused
    load();
    return;
  }
  const res = await askHackie('break', 'popup:break', { minutes: 15 });
  if (res === null) return;
  if (res?.ok === false && !res.denied) showToast(res.error || "Couldn't start the break.", true);
  load();
});

$('trackBtn').addEventListener('click', async () => {
  if (!data) return;
  if (!data.settings.trackingEnabled) {
    await send('popup:setTracking', { enabled: true }); // resuming is never refused
    load();
    return;
  }
  const res = await askHackie('pause', 'popup:setTracking', { enabled: false });
  if (res === null) return;
  if (res?.ok === false && !res.denied) showToast(res.error || "Couldn't pause tracking.", true);
  load();
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('taskTitle').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('reportBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') }));

load();
setInterval(() => {
  if (!data) return;
  renderStatus();
  renderStreak();
  renderFooter();
  renderRestore(); // the "Restored 3 tabs" note expires
  fitPopup(); // the ticking streak text can wrap onto a second line
}, 1000);
setInterval(load, 5000);
