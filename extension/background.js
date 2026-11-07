// Hackie service worker.
//
// Every time something changes (tab switch, navigation, focus, idle, 30s alarm) we:
//   1. bank the seconds spent on the previous page into today's stats,
//   2. classify what the user is looking at now (work / slack / neutral),
//   3. update the "slack streak" and decide whether Hackie should nudge, whip or lock the page,
//   4. push the status (and any whip) to the page's content script.
//
// Volatile state lives in chrome.storage.session (the worker can be killed at any time);
// settings, overrides, stats and the AI cache live in chrome.storage.local.

import './shared/mascot.js'; // globalThis.Hackie.ART_FILES: the list of Hackie's art in assets/
import { mergeSettings, aiConfig, aiReady, aiConfigured } from './lib/defaults.js';
import { classifyPage, pageKey, parseRule, PRIVATE_KEY } from './lib/classify.js';
import { findSensitive, PRIVATE_DOMAIN } from './lib/sensitive.js';
import { dayKey, lastNDayKeys, normalizeDay, addTime, topDomains, focusScore } from './lib/stats.js';
import { pickLine, LEVEL_NAME, pickExercise, snoozeMinutes, snoozeRemark, moodForSnoozes, lockdownStaysLine, fakeComebackLine, zeroSlackLine } from './lib/lines.js';
import { judgePage, listModels } from './lib/ai.js';
import { runAgent, buildAgentSystem } from './lib/agent.js';
import { createAgentTools } from './lib/agent-tools.js';
import { explainDecision, decisionLine } from './lib/debug.js';
import {
  normalizeMemory,
  recordTime,
  habitFor,
  flagSite,
  addFact,
  addProject,
  addIncident,
  forget as forgetMemory,
  topWorkPages,
  workTargets,
  memoryForPrompt, memoryForAgent,
} from './lib/memory.js';
import { buildEnforcerSystem, buildEnforcerMessage, createEnforcerTools, cleanBubble, LIMITS as ENFORCER_LIMITS } from './lib/enforcer.js';
import { angerLevel, policyVerdict, denialLine, OVERRIDABLE } from './lib/anger.js';
import { arbitrate } from './lib/arbiter.js';
import { appeal, MAX_APPEALS, APPEAL_WINDOW_MS } from './lib/appeal.js';
import { reviewLabel, loosens } from './lib/review.js';

const TICK_ALARM = 'taskwhip-tick';
const IDLE_SECONDS = 60;
const MAX_FLUSH_SECONDS = 90; // never bank more than this per refresh (sleep, crashes)
const AI_CACHE_MS = 24 * 3600e3;
const AI_ERROR_BACKOFF_MS = 10 * 60e3;
const AI_CACHE_MAX = 300;
const KEEP_DAYS = 60;
const BEG_DELAY_SEC = 20;

const SITE_NAMES = {
  'youtube.com': 'YouTube',
  'instagram.com': 'Instagram',
  'tiktok.com': 'TikTok',
  'reddit.com': 'Reddit',
  'x.com': 'X',
  'twitter.com': 'Twitter',
  'facebook.com': 'Facebook',
  'netflix.com': 'Netflix',
  'twitch.tv': 'Twitch',
  'pinterest.com': 'Pinterest',
  'tumblr.com': 'Tumblr',
  'github.com': 'GitHub',
  'stackoverflow.com': 'Stack Overflow',
  'docs.google.com': 'Google Docs',
};

// ---------------------------------------------------------------------------
// Serialize all state mutations so concurrent events can't clobber each other.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(() => fn());
  queue = run.catch((err) => console.error('[TaskWhip]', err));
  return run;
}

// ---------------------------------------------------------------------------
// Storage helpers

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

async function loadOverrides() {
  const { overrides } = await chrome.storage.local.get('overrides');
  return { pages: {}, sites: {}, ...(overrides || {}) };
}

function freshState() {
  return {
    current: null,
    streak: { slack: 0, calm: 0 },
    pausedAt: null,
    snoozeUntil: 0,
    breakUntil: 0,
    lastFire: { level: 0, at: 0 },
    lastWorkTab: null,
    snoozeCount: 0, // consecutive "N more min" clicks; shrinks the next snooze and angers Hackie
    lockdownBegs: 0, // "beg for more time" clicks on lockdowns; enough of them and Hackie closes tabs
    lastExerciseAt: 0,
    lastEnforcedAt: 0, // when Hackie last closed tabs (keeps him angry for a while)
    level: 0, // the current warning level, for anger
    overBudget: false,
    lockdown: null, // {at}: a lockdown stays on every slacking page until real work (or exercise) ends it
    comeback: null, // {at, left, level}: "Back to work" was clicked; Hackie waits for real work
    fakeComebacks: 0, // "Back to work" clicks followed straight by more slacking
    zeroOpened: {}, // zero-slack mode: pages we already opened the task page for {pageKey: at}
  };
}

async function loadState() {
  const { state } = await chrome.storage.session.get('state');
  return { ...freshState(), ...(state || {}) };
}

async function saveState(state) {
  await chrome.storage.session.set({ state });
}

async function loadDay(key = dayKey()) {
  const k = `day:${key}`;
  const r = await chrome.storage.local.get(k);
  return normalizeDay(r[k]);
}

async function saveDay(day, key = dayKey()) {
  await chrome.storage.local.set({ [`day:${key}`]: day });
}

async function loadCtx(tabId) {
  const k = `ctx:${tabId}`;
  const r = await chrome.storage.session.get(k);
  return r[k] || null;
}

// ---------------------------------------------------------------------------
// Small helpers

function siteName(domain) {
  if (domain === PRIVATE_DOMAIN) return 'Private site';
  return SITE_NAMES[domain] || domain || 'this site';
}

// The task as it reads mid-sentence: "Finish the essay" -> "finish the essay" (acronyms kept).
function taskLabel(settings) {
  const t = settings.task.title?.trim();
  if (!t) return 'your actual work';
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

function humanMinutes(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 1) return 'almost a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}`;
}

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  // "localhost:3000/app" has no scheme (the colon is a port), so it gets https:// too.
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(u) ? u : `https://${u}`;
}

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function taskSignature(settings) {
  return hashString(`${settings.task.title}|${(settings.task.keywords || []).join(',')}`.toLowerCase());
}

function clampStr(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

function sanitizeCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return {
    url: clampStr(ctx.url, 2000),
    title: clampStr(ctx.title, 300),
    description: clampStr(ctx.description, 400),
    keywords: clampStr(ctx.keywords, 300),
    siteName: clampStr(ctx.siteName, 100),
    h1: clampStr(ctx.h1, 300),
    videoTitle: clampStr(ctx.videoTitle, 300),
    channel: clampStr(ctx.channel, 120),
    format: clampStr(ctx.format, 40),
    excerpt: clampStr(ctx.excerpt, 800),
    canonical: clampStr(ctx.canonical, 2000),
    ogUrl: clampStr(ctx.ogUrl, 2000),
    baseHref: clampStr(ctx.baseHref, 2000),
    mediaPlaying: Boolean(ctx.mediaPlaying),
    readAt: Date.now(),
  };
}

// Hackie calms down completely: after real work (see applyStreak), an exercise break, or a reset.
function resetStreak(state) {
  state.streak = { slack: 0, calm: 0 };
  state.lastFire = { level: 0, at: 0 };
  state.snoozeCount = 0;
  state.lockdownBegs = 0;
  state.lockdown = null;
  state.comeback = null;
  state.fakeComebacks = 0;
}

// While a lockdown or a "Back to work" promise is open, only work time calms Hackie down.
const strictCalm = (state) => Boolean(state.lockdown || state.comeback || state.fakeComebacks > 0);

function applyStreak(state, category, seconds, settings) {
  if (category === 'slack') {
    state.streak.slack += seconds;
    state.streak.calm = 0;
  } else {
    if (category === 'work' || !strictCalm(state)) state.streak.calm += seconds;
    if (state.streak.calm >= settings.thresholds.streakResetMin * 60) resetStreak(state);
  }
}

// Moves the seconds since the last refresh into today's stats and the streak.
// Returns true if anything was recorded.
function bankTime(state, day, settings, now) {
  const prev = state.current;
  if (!prev?.tracked || !prev.since) return false;
  const elapsed = Math.min((now - prev.since) / 1000, MAX_FLUSH_SECONDS);
  prev.since = now;
  if (elapsed <= 0) return false;
  addTime(day, { domain: prev.domain, category: prev.category, seconds: elapsed, title: prev.title });
  applyStreak(state, prev.category, elapsed, settings);
  return { domain: prev.domain, category: prev.category, seconds: elapsed, pageKey: prev.pageKey, url: prev.url, title: prev.title, sensitive: Boolean(prev.sensitive) };
}

// Runs a state change with time already banked, so a reset isn't undone by the next refresh.
async function mutate(fn) {
  const now = Date.now();
  const [settings, state, day] = await Promise.all([loadSettings(), loadState(), loadDay()]);
  bankTime(state, day, settings, now);
  const result = await fn({ settings, state, day, now });
  await saveDay(day);
  await saveState(state);
  return result;
}

// ---------------------------------------------------------------------------
// What is the user looking at?

async function getActive(settings) {
  let win;
  try {
    win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  } catch {
    return null;
  }
  if (!win) return null;
  let focused = Boolean(win.focused);
  let popupOpen = false;
  // Opening Hackie's toolbar popup takes focus away from the browser window, but the
  // user is obviously still here.
  if (!focused && chrome.runtime.getContexts) {
    try {
      popupOpen = (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length > 0;
    } catch {
      /* older Chrome */
    }
    if (popupOpen) focused = true;
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  // Debug mode's testing switch (settings) or the e2e hook (globalThis) ignore focus and idleness.
  const forced = Boolean(settings?.debug?.enabled && settings.debug.ignoreFocus);
  const assumeActive = forced || globalThis.taskwhip?.debug?.assumeActive;
  const idle = assumeActive ? 'active' : await chrome.idle.queryState(IDLE_SECONDS);
  return { tab: tab || null, focused: focused || forced, popupOpen, idle, forced };
}

// ---------------------------------------------------------------------------
// Escalation

// `factor` < 1 for sites that are a slacking habit (from memory): warnings come sooner.
function thresholdsInSeconds(settings, factor = 1) {
  const t = settings.thresholds;
  const f = factor > 0 ? factor : 1;
  const blockOn = t.blockAfterMin > 0 && settings.effects.blockScreen;
  return [
    t.nudgeAfterMin > 0 ? t.nudgeAfterMin * 60 * f : null,
    t.whipAfterMin > 0 ? t.whipAfterMin * 60 * f : null,
    blockOn ? t.blockAfterMin * 60 * f : null,
  ];
}

function decide(state, settings, day, now) {
  const result = { level: 0, fire: false, snoozed: false, overBudget: false, nextLevelAtSec: null };
  const cur = state.current;
  if (!cur || cur.category !== 'slack') return result;

  const t = settings.thresholds;
  const streak = state.streak.slack;
  const marks = thresholdsInSeconds(settings, cur.habit?.factor ?? 1);
  let level = 0;
  marks.forEach((sec, i) => {
    if (sec != null && streak >= sec) level = Math.max(level, i + 1);
  });
  const maxLevel = marks[2] != null ? 3 : marks[1] != null ? 2 : 1;

  result.overBudget = t.dailySlackBudgetMin > 0 && day.totals.slack >= t.dailySlackBudgetMin * 60;
  if (result.overBudget && streak >= 30) level = Math.min(maxLevel, Math.max(1, level + 1));

  result.level = level;
  result.nextLevelAtSec = marks.find((sec) => sec != null && sec > streak) ?? null;

  const pausedUntil = Math.max(state.snoozeUntil || 0, state.breakUntil || 0);
  if (now < pausedUntil) {
    result.snoozed = true;
    return result;
  }
  const repeatMs = Math.max(0.25, t.repeatEveryMin || 3) * 60e3;
  result.fire = level > 0 && (level > state.lastFire.level || now - state.lastFire.at >= repeatMs);
  return result;
}

function buildStatus(state, settings, decision, now, day) {
  const cur = state.current;
  const pausedUntil = Math.max(state.snoozeUntil || 0, state.breakUntil || 0);
  return {
    category: cur.category,
    domain: cur.domain,
    site: siteName(cur.domain),
    streakSec: state.streak.slack,
    at: now,
    level: decision.level,
    snoozedUntil: pausedUntil > now ? pausedUntil : 0,
    onBreak: state.breakUntil > now,
    nextLevelAtSec: decision.nextLevelAtSec,
    chip: settings.effects.timerChip,
    sensitive: Boolean(cur.sensitive),
    task: taskLabel(settings),
    snoozeCount: state.snoozeCount || 0,
    anger: computeAnger(state, settings, now),
    calmAfterMin: settings.thresholds.streakResetMin,
    canReply: aiConfigured(settings) && !cur.sensitive,
    lockdownActive: Boolean(state.lockdown),
    comebackPending: Boolean(state.comeback),
    nextSnoozeMin: snoozeMinutes(state.snoozeCount || 0, settings.thresholds.snoozeMin),
    mood: moodForSnoozes(state.snoozeCount || 0),
    marks: thresholdsInSeconds(settings, cur.habit?.factor ?? 1),
    habit: cur.habit?.level || null,
    today: day ? { work: day.totals.work, slack: day.totals.slack, exercises: day.events.exercises || 0 } : null,
  };
}

function buildFire(state, settings, decision, day) {
  const cur = state.current;
  const vars = {
    site: cur.sensitive ? 'this private site' : cur.search ? `"${cur.search.query}" on ${cur.search.engine}` : siteName(cur.domain),
    minutes: humanMinutes(state.streak.slack),
    task: taskLabel(settings),
  };
  let message = pickLine(decision.level, vars);
  if (cur.nudge && decision.level <= 2 && Math.random() < 0.7) {
    message = decision.level === 2 ? `*CRACK* ${cur.nudge}` : cur.nudge;
  }
  const snoozeCount = state.snoozeCount || 0;
  const nextSnooze = snoozeMinutes(snoozeCount, settings.thresholds.snoozeMin);
  const exercise = pickExercise();
  const remark = snoozeRemark(snoozeCount, { count: snoozeCount, exercise, snoozeMin: nextSnooze });
  if (remark && decision.level < 3) message = `${message} ${remark}`;
  // Mood: the warning level, or the team's snooze anger, whichever is worse.
  const ladder = ['happy', 'stern', 'worried', 'angry', 'furious'];
  const levelMood = ['stern', 'worried', 'angry', 'furious'][decision.level] || 'stern';
  const snoozeMood = snoozeCount > 3 ? 'furious' : moodForSnoozes(snoozeCount);
  const mood = ladder[Math.max(ladder.indexOf(levelMood), ladder.indexOf(snoozeMood))];
  return {
    type: 'pomo:fire',
    fireId: `f${Date.now().toString(36)}`,
    habit: cur.habit?.level || null,
    level: decision.level,
    levelName: LEVEL_NAME[decision.level],
    message,
    site: vars.site,
    minutesText: vars.minutes,
    streakSec: state.streak.slack,
    task: vars.task,
    effects: settings.effects,
    snoozeMin: nextSnooze,
    snoozeCount,
    exercise,
    mood,
    begDelaySec: BEG_DELAY_SEC,
    overBudget: decision.overBudget,
    sensitive: Boolean(cur.sensitive),
    canReply: aiConfigured(settings) && !cur.sensitive,
    zeroSlack: Boolean(settings.zeroSlack) && decision.level >= 3,
    today: { work: day.totals.work, slack: day.totals.slack },
  };
}

// ---------------------------------------------------------------------------
// Talking to tabs

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch {
    return false;
  }
}

async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/mascot.js', 'content/content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function deliverFire(current, msg) {
  let ok = await sendToTab(current.tabId, msg);
  if (!ok && (await injectContent(current.tabId))) ok = await sendToTab(current.tabId, msg);
  if (!ok) {
    // Content script can't run here (e.g. Chrome Web Store); fall back to a system notification.
    chrome.notifications.create(`taskwhip-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Hackie: ${msg.levelName}`,
      message: msg.message.replace(/^\*CRACK\*\s*/, ''),
      priority: 2,
    });
  }
}

async function updateBadge(state, decision) {
  const cur = state.current;
  let text = '';
  let color = '#8b8d98';
  let title = 'Hackie: not tracking right now';
  if (cur?.category === 'slack') {
    const mins = Math.floor(state.streak.slack / 60);
    text = decision.snoozed ? 'zz' : `${mins}m`;
    color = decision.snoozed ? '#8b8d98' : decision.level >= 2 ? '#c4271e' : '#e5484d';
    title = `Hackie: slacking on ${siteName(cur.domain)} for ${mins} min`;
  } else if (cur?.category === 'work') {
    title = `Hackie: working on ${siteName(cur.domain)}`;
  } else if (cur) {
    title = `Hackie: ${siteName(cur.domain)} (neutral)`;
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title });
}

// ---------------------------------------------------------------------------
// The core loop

async function refresh(trigger = 'tick') {
  const now = Date.now();
  const [settings, overrides, state] = await Promise.all([loadSettings(), loadOverrides(), loadState()]);
  const day = await loadDay();
  let dayDirty = false;
  const mem = settings.memory?.enabled ? await loadMemory() : null;
  let memDirty = false;

  // 1) Bank time on whatever was active since the last refresh (stats, streak and memory).
  const prev = state.current;
  const banked = bankTime(state, day, settings, now);
  if (banked) {
    dayDirty = true;
    if (mem) {
      recordTime(mem, { ...banked, now });
      memDirty = true;
    }
  }

  // 2) Work out what the user is looking at right now.
  let current = null;
  let playing = false;
  // Looked up even while paused, so the debug console still shows what the browser is doing.
  const active = await getActive(settings);
  if (settings.trackingEnabled) {
    // A tab mid-navigation is credited to where it's going, not the page it's leaving.
    const url = active?.tab ? active.tab.pendingUrl || active.tab.url : '';
    if (url) {
      const { tab } = active;
      const rawCtx = await loadCtx(tab.id);
      const ctx = rawCtx && pageKey(rawCtx.url) === pageKey(url) ? rawCtx : null;
      const sensitive =
        findSensitive({ url, ctx, list: settings.sensitiveSites }) || (ctx?.sensitive ? { domain: '', via: 'proxy' } : null);
      playing = Boolean(tab.audible || ctx?.mediaPlaying);
      const present = active.focused && (active.idle === 'active' || (active.idle === 'idle' && playing));
      if (present) {
        const key = sensitive ? PRIVATE_KEY : pageKey(url);
        const aiVerdict = aiReady(settings) ? await cachedVerdict(settings, key) : null;
        const verdict = classifyPage({ url, ctx: sensitive ? null : ctx, settings, overrides, aiVerdict, sensitive });
        current = {
          ...verdict,
          tabId: tab.id,
          windowId: tab.windowId,
          url,
          title: sensitive ? '' : ctx?.title || (tab.pendingUrl ? '' : tab.title) || '',
          since: now,
        };
        if (verdict.needsAI && (ctx || sensitive) && aiReady(settings)) {
          // Sensitive pages only ever reach the AI as a fixed "content blocked" notice.
          askAI(settings, key, sensitive ? { redacted: true } : ctx); // fire-and-forget; triggers its own refresh
        }
      }
    }
  }

  // 3) Being away for a while resets the slack streak.
  if (!current) {
    // During a lockdown, a new-tab or settings page in a focused Chrome isn't "away".
    const parkedInChrome = strictCalm(state) && active?.focused && active?.idle === 'active';
    if (!state.pausedAt && !parkedInChrome) state.pausedAt = now;
  } else {
    if (state.pausedAt && now - state.pausedAt >= settings.thresholds.streakResetMin * 60e3) resetStreak(state);
    state.pausedAt = null;
  }
  if (current?.category === 'work') {
    state.lastWorkTab = { tabId: current.tabId, windowId: current.windowId, url: current.url, title: current.title };
  }
  if (current && mem) {
    if (current.domain !== prev?.domain) {
      recordTime(mem, { domain: current.domain, category: current.category, seconds: 0, newVisit: true, sensitive: current.sensitive, now });
      memDirty = true;
    }
    current.habit = settings.memory.habitSensitivity && current.category === 'slack' ? habitFor(mem, current.domain) : null;
  }
  state.current = current;

  // A "Back to work" click is a promise. Coming back to slacking before real work is a fake comeback:
  // Hackie gets angrier and the warning (or lockdown) comes back at once.
  let fakeComeback = null;
  if (state.comeback && current) {
    if (current.category !== 'slack') state.comeback.left = true;
    else if (state.comeback.left || now - state.comeback.at > 20e3) {
      fakeComeback = { awaySec: Math.max(1, Math.round((now - state.comeback.at) / 1000)) };
      state.fakeComebacks = (state.fakeComebacks || 0) + 1;
      state.comeback = null;
      state.lastFire = { level: 0, at: 0 }; // warn again right away
      state.snoozeUntil = 0;
      day.events.fakeComebacks = (day.events.fakeComebacks || 0) + 1;
      dayDirty = true;
      if (mem) {
        addIncident(mem, { kind: 'fake-comeback', site: siteName(current.domain), level: state.level || 0, summary: `Clicked "Back to work", then came back to ${siteName(current.domain)} ${fakeComeback.awaySec}s later.` });
        memDirty = true;
      }
    }
  }

  // 4) Decide whether Hackie acts.
  const decision = decide(state, settings, day, now);
  let zeroLock = false;
  if (settings.zeroSlack && current?.category === 'slack' && !decision.snoozed) {
    // Wait for the AI's verdict on this page if it's still coming (a lecture on YouTube isn't slacking).
    const pendingAI = current.needsAI && !current.sensitive && current.source !== 'ai' && aiInflight.has(`${taskSignature(settings)}|${current.pageKey}`);
    if (!pendingAI) {
      zeroLock = true;
      decision.level = 3;
      decision.zeroSlack = true;
      if (state.lastFire.level < 3 || !state.lockdown) decision.fire = true;
    }
  }
  state.level = decision.level;
  state.overBudget = decision.overBudget;
  let fireMsg = null;
  if (decision.fire) {
    state.lastFire = { level: decision.level, at: now };
    const evKey = decision.level >= 3 ? 'blocks' : decision.level === 2 ? 'whips' : 'nudges';
    day.events[evKey] += 1;
    dayDirty = true;
    fireMsg = buildFire(state, settings, decision, day);
    if (decision.level >= 3) state.lockdown = { at: state.lockdown?.at || now };
    if (decision.zeroSlack) {
      fireMsg.message = zeroSlackLine({ site: fireMsg.site, task: fireMsg.task });
      fireMsg.mood = 'furious';
    }
    if (fakeComeback) {
      const away = fakeComeback.awaySec < 90 ? `${fakeComeback.awaySec} seconds` : humanMinutes(fakeComeback.awaySec);
      fireMsg.fakeComeback = fakeComeback;
      fireMsg.message = fakeComebackLine({ site: fireMsg.site, task: fireMsg.task, away });
      fireMsg.mood = state.fakeComebacks >= 2 ? 'furious' : decision.level >= 3 ? 'furious' : 'angry';
    }
    fireMsg.aiPending = decision.zeroSlack ? false : wantsEventAI(settings, state, 'fire', decision.level); // zero-slack opens the task page itself
    if (mem && decision.level >= 3) {
      addIncident(mem, { kind: 'lockdown', site: siteName(current.domain), level: 3, begs: state.lockdownBegs || 0, summary: `Lockdown after ${humanMinutes(state.streak.slack)}.` });
      memDirty = true;
    }
  }
  let openTask = false;
  if (zeroLock && current?.tracked) {
    state.zeroOpened = Object.fromEntries(Object.entries(state.zeroOpened || {}).filter(([, at]) => now - at < 30 * 60e3));
    if (!state.zeroOpened[current.pageKey]) {
      state.zeroOpened[current.pageKey] = now;
      openTask = true;
    }
  }
  if (dayDirty) await saveDay(day);
  if (memDirty) await saveMemory(mem);
  await saveState(state);
  await updateBadge(state, decision);

  // 5) Tell the pages.
  if (prev?.tabId != null && prev.tabId !== current?.tabId) {
    sendToTab(prev.tabId, { type: 'pomo:status', status: { category: 'inactive' } });
  }
  if (current?.tracked) {
    const status = buildStatus(state, settings, decision, now, day);
    const paused = now < Math.max(state.snoozeUntil || 0, state.breakUntil || 0);
    if (state.lockdown && current.category === 'slack' && !paused && !(fireMsg && fireMsg.level >= 3)) {
      // Navigating away and back (or opening a new slacking tab) doesn't escape a lockdown.
      const again = buildFire(state, settings, { ...decision, level: 3 }, day);
      status.lockdown = { ...again, resumed: true, aiPending: false, mood: 'furious', message: settings.zeroSlack ? zeroSlackLine({ site: again.site, task: again.task }) : lockdownStaysLine({ site: again.site, task: again.task }) };
    }
    await sendToTab(current.tabId, { type: 'pomo:status', status });
    if (openTask) openTaskBeside(current, settings).catch((err) => console.warn('[TaskWhip] could not open the task page', err)); // not awaited: tab events refresh again
    if (fireMsg) {
      await deliverFire(current, fireMsg);
      if (fireMsg.aiPending) runEventAI('fire', { fire: fireMsg }); // fire-and-forget: AI bubble + tab actions
    }
  }

  // 6) Record the decision for debug mode and the agent's get_debug_log tool.
  const snapshot = {
    at: now,
    trigger,
    trackingEnabled: settings.trackingEnabled,
    window: active ? { focused: active.focused, popupOpen: active.popupOpen, idle: active.idle, forced: active.forced } : null,
    tab: active?.tab ? { id: active.tab.id, audible: Boolean(active.tab.audible) } : null,
    playing,
    tracked: Boolean(current?.tracked),
    site: current ? siteName(current.domain) : '',
    category: current?.category || null,
    source: current?.source || null,
    reason: current?.reason || '',
    sensitive: Boolean(current?.sensitive),
    habit: current?.habit?.level || null,
    streakSec: Math.round(state.streak.slack),
    level: decision.level,
    nextLevelAtSec: decision.nextLevelAtSec,
    fire: decision.fire,
    snoozed: decision.snoozed,
    overBudget: decision.overBudget,
  };
  snapshot.why = explainDecision(snapshot);
  await recordDecision(snapshot);
  if (active?.tab?.id != null) {
    // {enabled: false} makes a page drop its console after debug mode is turned off.
    const debug = settings.debug?.enabled ? await debugPayload(settings) : { enabled: false };
    sendToTab(active.tab.id, { type: 'pomo:debug', debug });
  }
  return { state, decision, trigger, snapshot };
}

// ---------------------------------------------------------------------------
// Optional Claude judge

// A long provider back-off (e.g. Gemini's free tier: 20 requests/day per model, "retry in 12h")
// pauses the automatic AI features until it expires; Ask Hackie (user-initiated) still tries.
async function noteAiFailure(err) {
  const pauseMs = err?.status === 429 && err.retryAfterMs > 120e3 ? Math.min(err.retryAfterMs, 26 * 3600e3) : 0;
  const until = pauseMs ? Date.now() + pauseMs : 0;
  const note = until ? ` (automatic AI paused until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '';
  await chrome.storage.local.set({
    aiStatus: { ok: false, at: Date.now(), error: `${err?.message || err}${note}`, pausedUntil: until },
    ...(until ? { aiPauseUntil: until } : {}),
  });
}

async function aiPaused() {
  const { aiPauseUntil = 0 } = await chrome.storage.local.get('aiPauseUntil');
  return aiPauseUntil > Date.now() ? aiPauseUntil : 0;
}

const aiInflight = new Set();

async function cachedVerdict(settings, key) {
  const { aiCache = {} } = await chrome.storage.local.get('aiCache');
  const hit = aiCache[`${taskSignature(settings)}|${key}`];
  if (!hit || hit.error || Date.now() - hit.at > AI_CACHE_MS) return null;
  return hit;
}

async function writeAiCache(cacheKey, value) {
  const { aiCache = {} } = await chrome.storage.local.get('aiCache');
  aiCache[cacheKey] = value;
  const entries = Object.entries(aiCache);
  if (entries.length > AI_CACHE_MAX) {
    entries.sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, entries.length - AI_CACHE_MAX)) delete aiCache[k];
  }
  await chrome.storage.local.set({ aiCache });
}

async function askAI(settings, key, ctx) {
  const cacheKey = `${taskSignature(settings)}|${key}`;
  if (aiInflight.has(cacheKey)) return;
  aiInflight.add(cacheKey);
  try {
    if (await aiPaused()) return;
    const now = Date.now();
    const { aiCache = {}, aiCalls = [] } = await chrome.storage.local.get(['aiCache', 'aiCalls']);
    const hit = aiCache[cacheKey];
    if (hit && !hit.error && now - hit.at < AI_CACHE_MS) return;
    if (hit?.error && now - hit.at < AI_ERROR_BACKOFF_MS) return;
    const recent = aiCalls.filter((t) => now - t < 3600e3);
    if (recent.length >= settings.ai.maxCallsPerHour) {
      await chrome.storage.local.set({ aiStatus: { ok: false, at: now, error: 'Hourly AI call limit reached.' } });
      return;
    }
    recent.push(now);
    await chrome.storage.local.set({ aiCalls: recent });

    try {
      const verdict = await judgePage({ config: aiConfig(settings), task: settings.task, page: ctx });
      await writeAiCache(cacheKey, { ...verdict, at: Date.now() });
      await chrome.storage.local.set({ aiPauseUntil: 0, aiStatus: { ok: true, at: Date.now(), model: verdict.model } });
      serial(() => refresh('ai'));
    } catch (err) {
      await writeAiCache(cacheKey, { error: err.message, at: Date.now() });
      await noteAiFailure(err);
    }
  } finally {
    aiInflight.delete(cacheKey);
  }
}

// ---------------------------------------------------------------------------
// User actions (from Hackie's buttons and the popup)


async function handleAction(action, tab) {
  if (!['back', 'snooze', 'isWork', 'exercise', 'resetMood'].includes(action)) return { ok: true };
  const goBack = await mutate(async ({ settings, state, day, now }) => {
    if (action === 'back') {
      day.events.comebacks += 1;
      // A promise, not a reset: the streak, snoozes, begs and any lockdown stay until real work
      // (thresholds.streakResetMin of work time). Coming straight back is a fake comeback.
      state.comeback = { at: now, left: false, level: Math.max(state.lastFire?.level || 0, state.level || 0) };
      state.snoozeUntil = 0;
      state.current = null; // we're leaving this page; don't bank any more of it
      return { state, settings };
    }
    if (action === 'snooze') {
      // The team's rule: each consecutive snooze is shorter (5 -> 3 -> 2 min by default).
      const minutes = snoozeMinutes(state.snoozeCount || 0, settings.thresholds.snoozeMin);
      state.snoozeUntil = now + minutes * 60e3;
      state.snoozeCount = (state.snoozeCount || 0) + 1;
      day.events.snoozes += 1;
      // A snooze from a lockdown is begging. Enough begging and Hackie starts closing tabs.
      if (state.lastFire?.level >= 3 && now - (state.lastFire.at || 0) < 30 * 60e3) {
        state.lockdownBegs = (state.lockdownBegs || 0) + 1;
        return { beg: state.lockdownBegs, settings };
      }
    }
    if (action === 'exercise') {
      // "I did it!": an exercise break counts like getting back on track.
      day.events.exercises = (day.events.exercises || 0) + 1;
      state.lastExerciseAt = now;
      resetStreak(state);
      state.snoozeUntil = 0;
    }
    if (action === 'resetMood') {
      resetStreak(state);
      state.snoozeUntil = 0;
    }
    if (action === 'isWork') {
      const overrides = await loadOverrides();
      if (tab?.url) overrides.pages[pageKey(tab.url)] = 'work';
      await chrome.storage.local.set({ overrides });
      resetStreak(state);
    }
    return null;
  });
  if (goBack?.state) backToWork(tab, goBack.state, goBack.settings); // async: the AI may pick the destination
  if (goBack?.beg) triggerEnforcement(tab, goBack.settings);
  await refresh(`action:${action}`);
  return { ok: true };
}

async function setCategory({ scope, category, url }) {
  if (!url) return { ok: false, error: 'No page.' };
  if (category === 'work') await mutate(({ state }) => resetStreak(state));
  const [settings, overrides] = await Promise.all([loadSettings(), loadOverrides()]);
  if (scope === 'page') {
    const key = pageKey(url);
    if (category === 'auto') delete overrides.pages[key];
    else overrides.pages[key] = category;
    await chrome.storage.local.set({ overrides });
  } else {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const keep = (rule) => {
      const parsed = parseRule(rule);
      return !(parsed && !parsed.path && (parsed.host === host || host.endsWith('.' + parsed.host)));
    };
    settings.workSites = settings.workSites.filter(keep);
    settings.slackSites = settings.slackSites.filter(keep);
    const bare = host.replace(/^m\./, '');
    for (const h of Object.keys(overrides.sites)) if (h === bare || h === host) delete overrides.sites[h];
    // Work/neutral site labels are judged page by page (see classifyPage); slacking is a plain rule.
    if (category === 'work' || category === 'neutral') overrides.sites[bare] = category;
    if (category === 'slack') settings.slackSites.push(bare);
    await chrome.storage.local.set({ settings, overrides });
  }
  await refresh('setCategory');
  return { ok: true };
}

async function setBreak(minutes) {
  await mutate(({ state, now }) => {
    state.breakUntil = minutes > 0 ? now + minutes * 60e3 : 0;
    if (minutes <= 0) state.snoozeUntil = 0;
  });
  await refresh('break');
  return { ok: true };
}

async function buildPopupState() {
  const now = Date.now();
  const [settings, state, overrides, day] = await Promise.all([loadSettings(), loadState(), loadOverrides(), loadDay()]);
  const weekKeys = lastNDayKeys(7);
  const weekRaw = await chrome.storage.local.get(weekKeys.map((k) => `day:${k}`));
  const week = weekKeys.map((key) => ({ key, totals: normalizeDay(weekRaw[`day:${key}`]).totals }));
  const { aiStatus = null } = await chrome.storage.local.get('aiStatus');
  const cur = state.current;
  const ctx = cur ? await loadCtx(cur.tabId) : null;
  const decision = decide(state, settings, day, now);
  return {
    now,
    settings: {
      task: settings.task,
      thresholds: settings.thresholds,
      effects: settings.effects,
      trackingEnabled: settings.trackingEnabled,
      aiEnabled: aiReady(settings),
      ai: { actions: settings.ai.actions },
    },
    current: cur ? { ...cur, siteName: siteName(cur.domain) } : null,
    ctx: ctx && cur && !cur.sensitive && pageKey(ctx.url) === pageKey(cur.url) ? ctx : null,
    pageOverride: cur ? overrides.pages[cur.pageKey] || null : null,
    streak: state.streak,
    snoozeUntil: state.snoozeUntil,
    snoozeCount: state.snoozeCount || 0,
    lockdownBegs: state.lockdownBegs || 0,
    habit: cur?.habit ? { level: cur.habit.level, factor: cur.habit.factor } : null,
    closedRecently: await closedInLastDay(),
    anger: computeAnger(state, settings, now),
    restoreLockedUntil: await restoreLockedUntil(settings),
    breakUntil: state.breakUntil,
    decision: { level: decision.level, snoozed: decision.snoozed, overBudget: decision.overBudget, nextLevelAtSec: decision.nextLevelAtSec },
    today: day,
    week,
    aiStatus,
    debug: settings.debug?.enabled ? await debugPayload(settings) : null,
  };
}

async function buildReport(days = 14) {
  const keys = lastNDayKeys(days);
  const raw = await chrome.storage.local.get(keys.map((k) => `day:${k}`));
  const settings = await loadSettings();
  return {
    task: settings.task,
    days: keys.map((key) => ({ key, ...normalizeDay(raw[`day:${key}`]) })),
  };
}

async function testAI(page) {
  const settings = await loadSettings();
  const sample = page || {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Top 10 funniest cat fails compilation - YouTube',
    videoTitle: 'Top 10 funniest cat fails compilation',
    channel: 'Cat Chaos',
    description: 'Cats being cats. Try not to laugh!',
  };
  try {
    const verdict = await judgePage({ config: aiConfig(settings), task: settings.task, page: sample });
    await chrome.storage.local.set({ aiPauseUntil: 0, aiStatus: { ok: true, at: Date.now(), model: verdict.model } });
    return { ok: true, verdict, sample };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pruneOldDays() {
  const all = await chrome.storage.local.get(null);
  const keep = new Set(lastNDayKeys(KEEP_DAYS).map((k) => `day:${k}`));
  const stale = Object.keys(all).filter((k) => k.startsWith('day:') && !keep.has(k));
  if (stale.length) await chrome.storage.local.remove(stale);
}

async function resetStats() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('day:')));
  const state = await loadState();
  resetStreak(state);
  await saveState(state);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Debug log

const DEBUG_LOG_MAX = 150;

async function recordDecision(snapshot) {
  const { debugLog = [] } = await chrome.storage.session.get('debugLog');
  debugLog.push(snapshot);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
  await chrome.storage.session.set({ debugLog, lastDecision: snapshot });
}

// What the on-page debug console and the popup show.
async function debugPayload(settings) {
  const [{ debugLog = [] }, { aiStatus = null }] = await Promise.all([
    chrome.storage.session.get('debugLog'),
    chrome.storage.local.get('aiStatus'),
  ]);
  const config = aiConfig(settings);
  return {
    enabled: Boolean(settings.debug?.enabled),
    last: debugLog[debugLog.length - 1] || null,
    lines: debugLog.slice(-12).reverse().map(decisionLine),
    ai: {
      provider: config.label,
      model: config.model,
      configured: aiConfigured(settings),
      judgeOn: aiReady(settings),
      status: aiStatus,
    },
    version: chrome.runtime.getManifest().version,
  };
}

// ---------------------------------------------------------------------------
// Ask Hackie (agent)

function siteLabel(domain) {
  return domain === PRIVATE_DOMAIN ? 'Private site' : domain;
}

const agentApi = {
  async currentActivity() {
    const { snapshot, state } = await serial(() => refresh('agent'));
    const now = Date.now();
    const cur = state.current;
    return {
      tracking: snapshot.tracked,
      why: snapshot.why,
      site: snapshot.site || null,
      pageTitle: cur && !cur.sensitive ? cur.title || null : null,
      category: snapshot.category,
      decidedBy: snapshot.source,
      reason: snapshot.reason || null,
      slackStreakSec: snapshot.streakSec,
      warningLevel: snapshot.level,
      nextWarningAtStreakSec: snapshot.nextLevelAtSec,
      snoozedForSec: state.snoozeUntil > now ? Math.round((state.snoozeUntil - now) / 1000) : 0,
      onBreakForSec: state.breakUntil > now ? Math.round((state.breakUntil - now) / 1000) : 0,
    };
  },
  async todaySummary() {
    const [day, settings] = await Promise.all([loadDay(), loadSettings()]);
    return {
      date: dayKey(),
      totalsSec: day.totals,
      focusScorePercent: focusScore(day.totals),
      dailySlackBudgetMin: settings.thresholds.dailySlackBudgetMin,
      events: day.events,
      topSites: topDomains(day, 8).map((d) => ({
        site: siteLabel(d.domain),
        workSec: Math.round(d.work),
        slackSec: Math.round(d.slack),
        neutralSec: Math.round(d.neutral),
      })),
    };
  },
  async history(days) {
    const keys = lastNDayKeys(days);
    const raw = await chrome.storage.local.get(keys.map((k) => `day:${k}`));
    const sums = { work: {}, slack: {} };
    const daily = keys.map((key) => {
      const d = normalizeDay(raw[`day:${key}`]);
      for (const [domain, e] of Object.entries(d.domains)) {
        for (const cat of ['work', 'slack']) {
          if (e[cat] > 0) sums[cat][siteLabel(domain)] = (sums[cat][siteLabel(domain)] || 0) + e[cat];
        }
      }
      return {
        date: key,
        workSec: Math.round(d.totals.work),
        slackSec: Math.round(d.totals.slack),
        neutralSec: Math.round(d.totals.neutral),
        focusScorePercent: focusScore(d.totals),
        events: d.events,
      };
    });
    const top = (cat) =>
      Object.entries(sums[cat])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([site, sec]) => ({ site, sec: Math.round(sec) }));
    return { days: daily, topWorkSites: top('work'), topSlackSites: top('slack') };
  },
  async settingsSummary() {
    const s = await loadSettings();
    const config = aiConfig(s);
    return {
      task: s.task.title || null,
      taskKeywords: s.task.keywords,
      backToWorkUrl: s.task.url || null,
      workSites: s.workSites,
      slackSites: s.slackSites,
      slackKeywords: s.slackKeywords,
      sensitiveSitesCount: s.sensitiveSites.length,
      thresholdsMin: s.thresholds,
      effects: s.effects,
      trackingEnabled: s.trackingEnabled,
      debugMode: Boolean(s.debug?.enabled),
      ai: { provider: config.label, model: config.model, judgeEnabled: aiReady(s) },
    };
  },
  async debugLog(limit) {
    const { debugLog = [] } = await chrome.storage.session.get('debugLog');
    return debugLog
      .slice(-limit)
      .reverse()
      .map(({ tab, ...d }) => ({ ...d, at: new Date(d.at).toLocaleTimeString(), tabAudible: tab?.audible ?? null }));
  },
  async markSite(domain, category) {
    const host = domain
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '');
    if (!['work', 'slack', 'neutral'].includes(category)) return { ok: false, error: 'Category must be work, slack or neutral.' };
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { ok: false, error: 'That does not look like a domain.' };
    const settings = await loadSettings();
    if (findSensitive({ url: `https://${host}/`, list: settings.sensitiveSites })) {
      return { ok: false, error: 'That site is on the sensitive list; change it in settings instead.' };
    }
    const review = await reviewLabelChange({ url: `https://${host}/`, scope: 'site', category });
    if (!review.allow) return { ok: false, denied: true, error: `Hackie's review refused that label: ${review.message}` };
    await serial(() => setCategory({ scope: 'site', category, url: `https://${host}/` }));
    return { ok: true, site: host, category, ...(review.message ? { review: review.message } : {}), note: category === 'slack' ? undefined : 'Each page of the site is still judged on its own.' };
  },
  async takeBreak(minutes) {
    await serial(() => setBreak(minutes));
    return { ok: true, breakMinutes: minutes };
  },
  async memory() {
    const settings = await loadSettings();
    if (!settings.memory?.enabled) return { memoryEnabled: false };
    return memoryForPrompt(await loadMemory());
  },
  async remember(input) {
    const [settings, overrides] = await Promise.all([loadSettings(), loadOverrides()]);
    // Reuse the enforcer's validated memory writes (no tab permissions needed).
    const api = makeTabApi({ settings, overrides, reason: 'ask', sourceTabId: null, permissions: {}, memoryEnabled: Boolean(settings.memory?.enabled) });
    return api.remember(input);
  },
};

const AGENT_CHAT_MAX = 30;

// Ask Hackie's view of the user: all of memory (when on) and his mood right now.
async function agentContext(settings) {
  const now = Date.now();
  const [state, day] = await Promise.all([loadState(), loadDay()]);
  const anger = computeAnger(state, settings, now);
  const cur = state.current;
  const lockUntil = await restoreLockedUntil(settings);
  const mood = {
    mood: anger.label,
    why: anger.reasons,
    onPage: cur ? { site: cur.sensitive ? 'Private site' : siteName(cur.domain), category: cur.category, habit: cur.habit?.level || 'none' } : null,
    slackStreakMin: Math.round((state.streak?.slack || 0) / 60),
    lastWarning: state.lastFire?.level ? LEVEL_NAME[state.lastFire.level] : null,
    snoozesInARow: state.snoozeCount || 0,
    lockdownBegs: state.lockdownBegs || 0,
    fakeComebacks: state.fakeComebacks || 0,
    lockdownActive: Boolean(state.lockdown),
    backToWorkPending: Boolean(state.comeback),
    todayMin: { work: Math.round(day.totals.work / 60), slack: Math.round(day.totals.slack / 60) },
    refusedToday: day.events.denials || 0,
    exercisesToday: day.events.exercises || 0,
    onBreak: state.breakUntil > now,
    ...(lockUntil ? { restoreLockedForMin: Math.ceil((lockUntil - now) / 60e3) } : {}),
  };
  const memory = settings.memory?.enabled ? memoryForAgent(await loadMemory(), { now }) : null;
  return { memory, mood };
}

async function askHackie(question) {
  const settings = await loadSettings();
  if (!aiConfigured(settings)) {
    return { ok: false, error: "Set up an AI provider and key in Hackie's settings (AI section) to chat with him." };
  }
  const { agentChat = [] } = await chrome.storage.session.get('agentChat');
  const started = Date.now();
  try {
    const result = await runAgent({
      config: aiConfig(settings),
      system: buildAgentSystem({ task: settings.task, ...(await agentContext(settings)) }),
      history: agentChat,
      question,
      tools: createAgentTools(agentApi),
    });
    agentChat.push({ role: 'user', text: String(question).slice(0, 2000), at: started });
    agentChat.push({ role: 'assistant', text: result.answer, at: Date.now(), tools: result.steps.map((st) => st.tool) });
    await chrome.storage.session.set({ agentChat: agentChat.slice(-AGENT_CHAT_MAX) });
    await chrome.storage.local.set({ aiPauseUntil: 0, aiStatus: { ok: true, at: Date.now(), model: result.model } });
    return { ok: true, answer: result.answer, steps: result.steps, model: result.model, ms: Date.now() - started };
  } catch (err) {
    await noteAiFailure(err);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Demo triggers: the team's "Run" button and "time since last break" slider.

async function testFire(level) {
  const lvl = Math.min(3, Math.max(1, Math.round(Number(level) || 1)));
  const { state } = await refresh('test');
  const [settings, day] = await Promise.all([loadSettings(), loadDay()]);
  const active = await getActive(settings);
  if (!active?.tab?.id || !/^https?:/.test(active.tab.pendingUrl || active.tab.url || '')) {
    return { ok: false, error: 'Open a normal web page (e.g. YouTube) in the current tab first.' };
  }
  const cur = state.current?.tabId === active.tab.id ? state.current : null;
  const fake = {
    ...state,
    current: cur || { domain: new URL(active.tab.pendingUrl || active.tab.url).hostname.replace(/^www\./, ''), category: 'slack' },
    streak: { ...state.streak, slack: Math.max(state.streak.slack, 60 * [0, 5, 10, 20][lvl]) },
  };
  const msg = buildFire(fake, settings, { level: lvl, overBudget: false }, day);
  const testMsg = { ...msg, test: true, aiPending: wantsEventAI(settings, state, 'fire', lvl) };
  await deliverFire({ tabId: active.tab.id }, testMsg);
  if (testMsg.aiPending) runEventAI('fire', { fire: testMsg, tab: active.tab, force: true }); // demo shows the AI bubble too
  return { ok: true };
}

async function setStreakDemo(seconds) {
  await mutate(({ state }) => {
    state.streak = { slack: Math.max(0, Number(seconds) || 0), calm: 0 };
    state.lastFire = { level: 0, at: 0 };
  });
  const { decision } = await refresh('demo-slider');
  return { ok: true, level: decision.level };
}

async function setThreshold(key, value) {
  if (!['nudgeAfterMin', 'whipAfterMin', 'blockAfterMin', 'dailySlackBudgetMin', 'snoozeMin'].includes(key)) return { ok: false, error: 'Unknown setting.' };
  const settings = await loadSettings();
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Enter a number of minutes.' };
  settings.thresholds[key] = key === 'snoozeMin' ? Math.max(1, n) : n;
  await chrome.storage.local.set({ settings });
  await refresh('setThreshold');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Memory (lib/memory.js): habits, work pages, projects, facts, incidents.

async function loadMemory() {
  const { memory } = await chrome.storage.local.get('memory');
  return normalizeMemory(memory);
}

async function saveMemory(mem) {
  await chrome.storage.local.set({ memory: mem });
}

// Load-modify-save under the serial queue (never call from inside a serial() task).
function updateMemory(fn) {
  return serial(async () => {
    const mem = await loadMemory();
    const result = await fn(mem);
    await saveMemory(mem);
    return result;
  });
}

async function memoryView() {
  const mem = await loadMemory();
  const now = Date.now();
  return {
    sites: Object.entries(mem.sites)
      .map(([domain, s]) => ({ domain, ...s, habit: habitFor(mem, domain).level }))
      .sort((a, b) => b.slackSec - a.slackSec || b.workSec - a.workSec),
    workPages: topWorkPages(mem, 60, now),
    projects: [...mem.projects].sort((a, b) => b.at - a.at),
    facts: [...mem.facts].sort((a, b) => b.at - a.at),
    incidents: [...mem.incidents].sort((a, b) => b.at - a.at),
  };
}

// ---------------------------------------------------------------------------
// Tabs Hackie closed (restorable from the popup).

const CLOSED_MAX = 20;

async function rememberClosed(entries) {
  const { closedByHackie = [] } = await chrome.storage.local.get('closedByHackie');
  const next = [...entries, ...closedByHackie].slice(0, CLOSED_MAX);
  await chrome.storage.local.set({ closedByHackie: next });
}

async function restoreClosed(index) {
  const { closedByHackie = [] } = await chrome.storage.local.get('closedByHackie');
  const picked = Number.isInteger(index) ? closedByHackie.filter((_, i) => i === index) : closedByHackie;
  for (const t of picked) await chrome.tabs.create({ url: t.url, active: false });
  const rest = Number.isInteger(index) ? closedByHackie.filter((_, i) => i !== index) : [];
  await chrome.storage.local.set({ closedByHackie: rest });
  return { ok: true, restored: picked.length };
}

// ---------------------------------------------------------------------------
// Toasts for tabs that are still loading (e.g. a work tab Hackie just opened).

const pendingToasts = new Map(); // tabId -> text

async function toastTab(tabId, text) {
  if (tabId == null || !text) return;
  const ok = await sendToTab(tabId, { type: 'pomo:toast', text });
  if (!ok) pendingToasts.set(tabId, text);
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && pendingToasts.has(tabId)) {
    const text = pendingToasts.get(tabId);
    pendingToasts.delete(tabId);
    setTimeout(() => sendToTab(tabId, { type: 'pomo:toast', text }), 600);
  }
});

// ---------------------------------------------------------------------------
// The per-event AI ("enforcer"): targeted speech bubbles plus tab actions, with every action
// re-checked here so the model can't close work tabs or open slacking sites.

async function classifyTab(tab, settings, overrides) {
  const url = tab.pendingUrl || tab.url || '';
  if (!/^https?:/.test(url)) return { category: 'neutral', domain: '', sensitive: false, internal: true };
  const rawCtx = await loadCtx(tab.id);
  const ctx = rawCtx && pageKey(rawCtx.url) === pageKey(url) ? rawCtx : null;
  const sensitive = findSensitive({ url, ctx, list: settings.sensitiveSites }) || (ctx?.sensitive ? { domain: '', via: 'proxy' } : null);
  const key = sensitive ? PRIVATE_KEY : pageKey(url);
  const aiVerdict = aiReady(settings) ? await cachedVerdict(settings, key) : null;
  const v = classifyPage({ url, ctx: sensitive ? null : ctx, settings, overrides, aiVerdict, sensitive });
  return { category: v.category, domain: v.domain, sensitive: Boolean(v.sensitive), internal: !v.tracked };
}

function makeTabApi({ settings, overrides, reason, sourceTabId, permissions, memoryEnabled }) {
  const log = { closed: [], opened: [], focused: null, remembered: [] };
  let workInFront = false;

  async function windowFor() {
    try {
      return (await chrome.tabs.get(sourceTabId)).windowId;
    } catch {
      return undefined;
    }
  }

  async function openUrl(url, why) {
    if (log.opened.length >= ENFORCER_LIMITS.maxOpen) return { ok: false, error: `At most ${ENFORCER_LIMITS.maxOpen} tabs per event.` };
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: 'Only full http(s) URLs can be opened.' };
    const verdict = await classifyTab({ id: -1, url }, settings, overrides);
    if (verdict.category === 'slack' || verdict.sensitive) return { ok: false, error: 'Refused: that page counts as slacking.' };
    let tab;
    let reused = false;
    if (reason === 'back' && !log.opened.length) {
      // "Back to work": turn the slacking tab into the work page instead of piling up tabs.
      try {
        tab = await chrome.tabs.update(sourceTabId, { url, active: true });
        reused = true;
      } catch {
        /* source tab gone */
      }
    }
    if (!tab) tab = await chrome.tabs.create({ url, active: true, windowId: await windowFor() });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    log.opened.push({ url, why, tabId: tab.id, reused });
    workInFront = true;
    return { ok: true, tab_id: tab.id };
  }

  return {
    log,
    async listTabs() {
      const tabs = await chrome.tabs.query({});
      const out = [];
      for (const t of tabs.slice(0, 60)) {
        const v = await classifyTab(t, settings, overrides);
        if (v.internal) continue;
        out.push({
          id: t.id,
          site: v.sensitive ? 'Private site' : v.domain,
          title: v.sensitive ? '' : String(t.title || '').slice(0, 100),
          category: v.category,
          active: t.active,
          current: t.id === sourceTabId,
          pinned: t.pinned,
          audible: Boolean(t.audible),
        });
      }
      return out;
    },
    async focusTab(id) {
      if (!permissions.mayOpen) return { ok: false, error: 'Not allowed right now.' };
      let tab;
      try {
        tab = await chrome.tabs.get(id);
      } catch {
        return { ok: false, error: 'No such tab.' };
      }
      const v = await classifyTab(tab, settings, overrides);
      if (v.internal || v.category === 'slack') return { ok: false, error: 'Refused: only work or neutral tabs can be focused.' };
      await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      log.focused = id;
      workInFront = true;
      return { ok: true };
    },
    async openTab(url, why) {
      if (!permissions.mayOpen) return { ok: false, error: 'Not allowed right now.' };
      return openUrl(url.trim(), why);
    },
    async closeTabs(ids, why) {
      if (!permissions.mayClose) return { ok: false, error: 'Not allowed right now.' };
      const closed = [];
      const refused = [];
      // Put a work page in front first, so closing never leaves the user with nothing (or closes a window).
      if (!workInFront && permissions.mayOpen) {
        // Prefer a work tab that's already open (no duplicates); otherwise open the best remembered page.
        let existing = null;
        for (const t of await chrome.tabs.query({})) {
          // (Work tabs are never closed, so one on the close list still counts.)
          if (!/^https?:/.test(t.url || '')) continue;
          if ((await classifyTab(t, settings, overrides)).category === 'work') {
            existing = t;
            break;
          }
        }
        if (existing) {
          await chrome.tabs.update(existing.id, { active: true });
          await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
          log.focused = existing.id;
          workInFront = true;
        } else {
          const target = workTargets(await loadMemory(), settings, 1)[0];
          if (target) await openUrl(target.url, 'work tab before closing slacking tabs');
        }
      }
      for (const id of ids.slice(0, ENFORCER_LIMITS.maxClose - log.closed.length)) {
        let tab;
        try {
          tab = await chrome.tabs.get(id);
        } catch {
          refused.push({ id, why: 'no such tab' });
          continue;
        }
        const v = await classifyTab(tab, settings, overrides);
        if (tab.pinned || v.internal || v.category !== 'slack') {
          refused.push({ id, why: tab.pinned ? 'pinned' : `not a slacking tab (${v.category})` });
          continue;
        }
        const siblings = await chrome.tabs.query({ windowId: tab.windowId });
        if (siblings.length <= 1) await chrome.tabs.create({ windowId: tab.windowId, active: true });
        closed.push({ url: tab.url, title: v.sensitive ? 'Private site' : String(tab.title || '').slice(0, 120), site: v.sensitive ? 'Private site' : v.domain, sensitive: v.sensitive, at: Date.now() });
        await chrome.tabs.remove(id);
      }
      if (closed.length) {
        await rememberClosed(closed);
        await noteEnforced(settings);
      }
      log.closed.push(...closed);
      return { ok: closed.length > 0, closed: closed.map((c) => c.site), refused, why };
    },
    async remember({ kind, text, name, urls, domain }) {
      if (!memoryEnabled) return { ok: false, error: 'Memory is off.' };
      const res = await updateMemory((mem) => {
        if (kind === 'fact') return addFact(mem, text) ? { ok: true } : { ok: false, error: 'Empty or already known.' };
        if (kind === 'project') return addProject(mem, { name, urls, notes: text }) ? { ok: true } : { ok: false, error: 'A project needs a name.' };
        if (kind === 'slack_site') {
          const d = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ok: false, error: 'Not a domain.' };
          if (findSensitive({ url: `https://${d}/`, list: settings.sensitiveSites })) return { ok: false, error: 'Sensitive sites are not stored by name.' };
          flagSite(mem, d, true);
          return { ok: true };
        }
        return { ok: false, error: 'Unknown kind.' };
      });
      if (res.ok) log.remembered.push(kind);
      return res;
    },
  };
}

let lastEventAI = 0;

// What the per-event AI may do for this event.
function eventPermissions(settings, state, reason, level) {
  const actions = settings.ai.actions || {};
  const begs = state.lockdownBegs || 0;
  const angryMom = (state.snoozeCount || 0) > 3;
  return {
    mayOpen: Boolean(actions.openTabs) && (reason === 'back' || reason === 'beg' || level >= 1),
    mayClose:
      Boolean(actions.closeTabs) && reason !== 'back' && (begs >= Math.max(1, actions.closeAfterBegs || 2) || (angryMom && level >= 2)),
  };
}

function wantsEventAI(settings, state, reason, level) {
  if (!aiConfigured(settings)) return false;
  const p = eventPermissions(settings, state, reason, level);
  return Boolean(settings.ai.eventMessages || p.mayOpen || p.mayClose);
}

/**
 * Runs the per-event AI. reason: 'fire' (nudge/whip/lockdown), 'beg', or 'back'.
 * Never call from inside a serial() task (its tools use serial()).
 * @returns {Promise<{bubble: string, log: object}|null>}
 */
async function runEventAI(reason, { fire = null, tab = null, force = false } = {}) {
  const [settings, state, day, overrides] = await Promise.all([loadSettings(), loadState(), loadDay(), loadOverrides()]);
  const level = fire?.level ?? (reason === 'beg' ? 3 : 0);
  if (!wantsEventAI(settings, state, reason, level)) return null;
  if (await aiPaused()) return null;
  const now = Date.now();
  if (reason === 'fire' && !force && now - lastEventAI < 20e3) return null; // don't stack calls on rapid repeats
  lastEventAI = now;

  const memoryEnabled = Boolean(settings.memory?.enabled);
  const mem = await loadMemory();
  const cur = state.current;
  const sourceTabId = tab?.id ?? cur?.tabId ?? null;
  const sensitive = Boolean(cur?.sensitive);
  const rawCtx = sourceTabId != null ? await loadCtx(sourceTabId) : null;
  const page = !sensitive && rawCtx && cur && pageKey(rawCtx.url) === pageKey(cur.url) ? rawCtx : null;
  const permissions = eventPermissions(settings, state, reason, level);
  const api = makeTabApi({ settings, overrides, reason, sourceTabId, permissions, memoryEnabled });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25e3);

  let bubble = '';
  try {
    const result = await runAgent({
      config: aiConfig(settings),
      system: buildEnforcerSystem({ task: settings.task, reason, permissions, memoryEnabled }),
      question: buildEnforcerMessage({
        reason,
        level,
        levelName: fire?.levelName || LEVEL_NAME[level] || 'Nudge',
        site: cur ? siteName(cur.domain) : '',
        minutes: Math.round((state.streak?.slack || 0) / 60),
        snoozeCount: state.snoozeCount || 0,
        lockdownBegs: state.lockdownBegs || 0,
        habit: cur?.habit || null,
        overBudget: fire?.overBudget,
        today: day.totals,
        page,
        sensitive,
        memory: memoryEnabled ? memoryForPrompt(mem) : {},
        permissions,
        note: fire?.fakeComeback ? `The user clicked "Back to work", then came back to slacking ${fire.fakeComeback.awaySec}s later (fake comeback #${state.fakeComebacks || 1}). Call it out.` : '',
      }),
      tools: createEnforcerTools(api, { ...permissions, memoryEnabled }),
      maxTurns: 5,
      signal: controller.signal,
    });
    bubble = cleanBubble(result.answer);
    await chrome.storage.local.set({ aiPauseUntil: 0, aiStatus: { ok: true, at: Date.now(), model: result.model } });
  } catch (err) {
    await noteAiFailure(err);
  } finally {
    clearTimeout(timer);
  }

  const { closed, opened, focused } = api.log;
  if (memoryEnabled && (closed.length || opened.length || focused != null || reason === 'beg')) {
    await updateMemory((m) =>
      addIncident(m, {
        kind: closed.length ? 'enforced' : reason,
        site: cur ? (sensitive ? 'Private site' : siteName(cur.domain)) : '',
        level,
        begs: state.lockdownBegs || 0,
        closed: closed.length,
        opened: opened.length,
        summary: bubble || (closed.length ? `Closed ${closed.length} slacking tab(s).` : ''),
      }),
    );
  }

  // Deliver the bubble: on the page it was written for, or wherever Hackie sent the user.
  const sourceAlive = sourceTabId != null && (await chrome.tabs.get(sourceTabId).then(() => true, () => false));
  const destination = opened.length ? opened[opened.length - 1].tabId : focused;
  if (bubble) {
    if (reason === 'fire' && sourceAlive && destination == null) {
      await sendToTab(sourceTabId, { type: 'pomo:say', fireId: fire?.fireId, text: bubble });
    } else {
      await toastTab(destination ?? (sourceAlive ? sourceTabId : null), bubble);
    }
  }
  return { bubble, log: api.log };
}

// No AI (or the AI did nothing): close the current slacking site's tabs and open the best work page.
async function enforceFallback(tab) {
  const [settings, overrides, mem, state] = await Promise.all([loadSettings(), loadOverrides(), loadMemory(), loadState()]);
  const permissions = eventPermissions(settings, state, 'beg', 3);
  if (!permissions.mayClose) return null;
  const api = makeTabApi({ settings, overrides, reason: 'beg', sourceTabId: tab?.id, permissions, memoryEnabled: false });
  const domain = state.current?.domain;
  const tabs = (await api.listTabs()).filter((t) => t.category === 'slack' && (t.current || (domain && t.site === siteName(domain)) || t.site === domain));
  await api.closeTabs(tabs.map((t) => t.id), 'begged too many times');
  const target = api.log.opened[0]?.url || workTargets(mem, settings, 1)[0]?.url;
  const text = api.log.closed.length
    ? `That's it. I closed ${api.log.closed.length} slacking tab${api.log.closed.length > 1 ? 's' : ''}${target ? ' and opened your work' : ''}. Restore them from the popup if you must.`
    : '';
  if (text) await toastTab(api.log.opened[0]?.tabId ?? null, text);
  if (settings.memory?.enabled && api.log.closed.length) {
    await updateMemory((m) => addIncident(m, { kind: 'enforced', site: siteName(domain), level: 3, begs: state.lockdownBegs, closed: api.log.closed.length, opened: api.log.opened.length, summary: text }));
  }
  return api.log;
}

// "Back to work": the AI picks the destination from memory and open tabs; deterministic fallback.
async function backToWork(tab, state, settings) {
  const ai = aiConfigured(settings) && settings.ai.actions?.openTabs ? await runEventAI('back', { tab }).catch(() => null) : null;
  if (ai && (ai.log.opened.length || ai.log.focused != null)) return;
  const target = state.lastWorkTab;
  if (target && target.tabId !== tab?.id) {
    try {
      const t = await chrome.tabs.get(target.tabId);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return;
    } catch {
      /* tab is gone; fall through */
    }
  }
  if (tab?.id != null) {
    const remembered = settings.memory?.enabled ? workTargets(await loadMemory(), settings, 1)[0]?.url : '';
    const url = normalizeUrl(settings.task.url) || remembered || 'chrome://newtab/';
    await chrome.tabs.update(tab.id, { url });
  }
}

async function closedInLastDay() {
  const { closedByHackie = [] } = await chrome.storage.local.get('closedByHackie');
  return closedByHackie.filter((t) => Date.now() - (t.at || 0) < 864e5).length;
}

// ---------------------------------------------------------------------------
// Angry Hackie: refusing the user's clicks (lib/anger.js + lib/arbiter.js).

function computeAnger(state, settings, now = Date.now()) {
  return angerLevel({
    snoozeCount: state.snoozeCount || 0,
    lockdownBegs: state.lockdownBegs || 0,
    level: state.level || 0,
    habit: state.current?.habit?.level || 'none',
    overBudget: Boolean(state.overBudget),
    lastEnforcedAt: state.lastEnforcedAt || 0,
    fakeComebacks: state.fakeComebacks || 0,
    closeAfterBegs: settings.ai.actions?.closeAfterBegs || 2,
    now,
  });
}

async function restoreLockedUntil(settings) {
  settings = settings || (await loadSettings());
  if (settings.ai.actions?.overrideClicks === false) return 0;
  const { restoreLockedUntil: until = 0 } = await chrome.storage.local.get('restoreLockedUntil');
  return until > Date.now() ? until : 0;
}

// Tabs were just closed: lock "Restore" for a while and stay angry.
async function noteEnforced(settings) {
  const lockMin = Math.max(0, Number(settings.ai.actions?.restoreLockMin ?? 10));
  if (lockMin > 0) await chrome.storage.local.set({ restoreLockedUntil: Date.now() + lockMin * 60e3 });
  await serial(async () => {
    const st = await loadState();
    st.lastEnforcedAt = Date.now();
    await saveState(st);
  });
}

// Enough begging (allowed or refused): the per-event AI, or the rules, close slacking tabs.
function triggerEnforcement(tab, settings) {
  const run = aiConfigured(settings)
    ? runEventAI('beg', { tab }).then((r) => (r && r.log.closed.length ? r : enforceFallback(tab)))
    : enforceFallback(tab);
  run.catch((err) => console.error('[TaskWhip] enforcement failed', err));
}

/**
 * Should Hackie let this click through? Calm/annoyed: yes. Angry: the AI arbiter decides.
 * Furious (or the restore lock): no, and the AI only writes the angry speech.
 * Never call from inside a serial() task.
 * @returns {Promise<{allow: boolean, message: string, anger: object}>}
 */
async function judgeClick(action, tab) {
  const now = Date.now();
  const [settings, state] = await Promise.all([loadSettings(), loadState()]);
  const anger = computeAnger(state, settings, now);
  const enabled = settings.ai.actions?.overrideClicks !== false;
  const aiAvailable = aiConfigured(settings) && !(await aiPaused());
  const verdict = policyVerdict(action, anger, {
    lastExerciseAt: state.lastExerciseAt || 0,
    restoreLockedUntil: await restoreLockedUntil(settings),
    now,
    aiAvailable,
    enabled,
  });
  if (verdict.allow === true) return { allow: true, message: '', anger };

  let allow = verdict.allow;
  let message = '';
  if (aiAvailable) {
    try {
      const cur = state.current;
      const sensitive = Boolean(cur?.sensitive);
      const tabId = tab?.id ?? cur?.tabId;
      const rawCtx = tabId != null ? await loadCtx(tabId) : null;
      const page = !sensitive && rawCtx && cur && pageKey(rawCtx.url) === pageKey(cur.url) ? rawCtx : null;
      const day = await loadDay();
      const r = await arbitrate({
        config: aiConfig(settings),
        task: settings.task,
        action,
        anger,
        situation: {
          site: cur ? siteName(cur.domain) : null,
          slackingForMin: Math.round((state.streak?.slack || 0) / 60),
          snoozesInARow: state.snoozeCount || 0,
          lockdownBegs: state.lockdownBegs || 0,
          todayMin: { work: Math.round(day.totals.work / 60), slack: Math.round(day.totals.slack / 60) },
          minutesSinceLastExercise: state.lastExerciseAt ? Math.round((now - state.lastExerciseAt) / 60e3) : null,
          restoreLockedForMin: verdict.rule === 'restore-locked' ? Math.ceil(((await restoreLockedUntil(settings)) - now) / 60e3) : undefined,
        },
        page,
        sensitive,
        memory: settings.memory?.enabled ? memoryForPrompt(await loadMemory()) : {},
        decided: verdict.needsAI ? null : false,
        signal: AbortSignal.timeout(9000),
      });
      if (verdict.needsAI) allow = r.allow;
      message = r.message;
    } catch (err) {
      await noteAiFailure(err);
    }
  }
  if (allow === null || allow === undefined) {
    allow = policyVerdict(action, anger, { lastExerciseAt: state.lastExerciseAt || 0, now, aiAvailable: false, enabled }).allow;
  }
  if (allow) return { allow: true, message, anger };
  if (!message) message = denialLine(action);

  // Refused. Begging still counts (and can get tabs closed); everything is logged.
  const begs = await serial(() =>
    mutate(({ state: st, day }) => {
      day.events.denials = (day.events.denials || 0) + 1;
      if (action === 'beg') st.lockdownBegs = (st.lockdownBegs || 0) + 1;
      return st.lockdownBegs || 0;
    }),
  );
  if (settings.memory?.enabled) {
    await updateMemory((m) => addIncident(m, { kind: 'denied', action, site: state.current ? siteName(state.current.domain) : '', level: state.level || 0, begs, summary: message }));
  }
  if (action === 'beg' && begs >= Math.max(1, settings.ai.actions?.closeAfterBegs || 2)) triggerEnforcement(tab, settings);
  return { allow: false, message, anger };
}

// ---------------------------------------------------------------------------
// Zero-slack mode: put the task page right next to the locked slacking tab (or bring it forward).

async function openTaskBeside(slack, settings) {
  const mem = settings.memory?.enabled ? await loadMemory() : null;
  const st = await loadState();
  const target = (mem ? workTargets(mem, settings, 1)[0]?.url : '') || workTargets({ projects: [], workPages: {} }, settings, 1)[0]?.url || st.lastWorkTab?.url;
  if (!target) return null;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.id !== slack.tabId && pageKey(t.url) === pageKey(target));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return existing;
  }
  const tab = await chrome.tabs.get(slack.tabId).catch(() => null);
  return chrome.tabs.create({ url: target, active: true, ...(tab ? { windowId: tab.windowId, index: tab.index + 1 } : {}) });
}

// ---------------------------------------------------------------------------
// Label changes that let the user off the hook (slack → work/neutral, neutral → work) go past the
// AI reviewer (lib/review.js), page by page. Stricter labels always go through. Never call from
// inside a serial() task.

const REVIEW_MAX = 3; // attempts per page or site, per 10 minutes

async function reviewLabelChange({ url, scope = 'page', category, tab = null }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: true, message: '' };
  }
  const settings = await loadSettings();
  if (!aiConfigured(settings)) return { allow: true, message: '' }; // nobody to review it
  const now = Date.now();
  const [state, overrides, day] = await Promise.all([loadState(), loadOverrides(), loadDay()]);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const key = pageKey(url);
  // The page the user is looking at, if it's this page (or, for a site label, on this site).
  const cur = state.current;
  const tabId = tab?.id ?? cur?.tabId;
  const rawCtx = tabId != null ? await loadCtx(tabId) : null;
  let page = null;
  if (rawCtx) {
    const ctxHost = new URL(rawCtx.url).hostname.toLowerCase().replace(/^www\./, '');
    if (pageKey(rawCtx.url) === key || (scope === 'site' && (ctxHost === host || ctxHost.endsWith('.' + host)))) page = rawCtx;
  }
  const target = page?.url || url;
  const sensitive = findSensitive({ url: target, ctx: page, list: settings.sensitiveSites });
  const aiVerdict = await cachedVerdict(settings, pageKey(target));
  // A page's label is what Hackie has it as now; a site's label is the site's own rule.
  const from = sensitive
    ? 'slack'
    : scope === 'site'
    ? classifyPage({ url: `${u.protocol}//${u.host}/`, ctx: null, settings, overrides, aiVerdict: null }).category
    : classifyPage({ url: target, ctx: page, settings, overrides, aiVerdict }).category;
  if (!loosens(from, category)) return { allow: true, message: '', from };
  if (await aiPaused()) return { allow: false, message: "Hackie's AI is resting (rate limit), so he can't review label changes right now. Try later." };

  const reviewKey = `${scope}:${scope === 'site' ? host : key}`;
  const { labelReviews = {} } = await chrome.storage.session.get('labelReviews');
  const recent = (labelReviews[reviewKey] || []).filter((r) => now - r.at < 10 * 60e3);
  if (recent.length >= REVIEW_MAX && !recent.some((r) => r.approve)) {
    return { allow: false, message: `You've asked three times. The label stays. Back to ${taskLabel(settings)}.` };
  }
  const anger = computeAnger(state, settings, now);
  let r;
  try {
    r = await reviewLabel({
      config: aiConfig(settings),
      task: settings.task,
      mood: anger.label,
      from,
      to: category,
      scope,
      domain: host,
      url: target,
      page: sensitive ? null : page,
      sensitive: Boolean(sensitive),
      memory: settings.memory?.enabled ? memoryForPrompt(await loadMemory()) : {},
      situation: {
        mood: anger.label,
        why: anger.reasons,
        slackingForMin: Math.round((state.streak?.slack || 0) / 60),
        snoozesInARow: state.snoozeCount || 0,
        lockdownActive: Boolean(state.lockdown),
        todayMin: { work: Math.round(day.totals.work / 60), slack: Math.round(day.totals.slack / 60) },
      },
      signal: AbortSignal.timeout(20000),
    });
    if (r.model) await chrome.storage.local.set({ aiPauseUntil: 0, aiStatus: { ok: true, at: Date.now(), model: r.model } });
  } catch (err) {
    await noteAiFailure(err);
    return { allow: false, message: `Hackie couldn't review that change right now (${err.message}). Try again in a moment.` };
  }
  labelReviews[reviewKey] = [...recent, { at: now, approve: r.approve }];
  await chrome.storage.session.set({ labelReviews });
  if (settings.memory?.enabled) {
    await updateMemory((m) =>
      addIncident(m, { kind: 'relabel', site: sensitive ? 'Private site' : host, from, to: category, scope, outcome: r.approve ? 'approved' : 'denied', summary: r.message }),
    );
  }
  if (!r.approve) {
    await serial(() =>
      mutate(({ day: d }) => {
        d.events.relabelsDenied = (d.events.relabelsDenied || 0) + 1;
      }),
    );
  }
  return { allow: r.approve, message: r.message, from };
}

// ---------------------------------------------------------------------------
// Replies in Hackie's speech bubble: the AI judge hears the user out and may reconsider
// (lib/appeal.js). Never call from inside a serial() task.

async function handleAppeal(msg, tab) {
  const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return { ok: false, error: 'Say something first.' };
  const settings = await loadSettings();
  if (!aiConfigured(settings)) return { ok: false, error: 'Hackie needs an AI provider and key (Settings → AI) to hear replies.' };
  if (await aiPaused()) return { ok: false, error: "Hackie's AI is resting (rate limit). Try again later." };
  const now = Date.now();
  const state = await loadState();
  const cur = state.current;
  if (!cur || (tab?.id != null && cur.tabId !== tab.id)) return { ok: false, error: 'Hackie is looking at another tab right now.' };
  if (cur.sensitive) return { ok: false, error: "Hackie doesn't discuss private sites. If it's really work, remove it from the sensitive list." };

  const kind = msg.kind === 'refusal' && OVERRIDABLE[msg.action] ? 'refusal' : 'warning';
  const action = kind === 'refusal' ? msg.action : null;
  const key = pageKey(cur.url);
  const { appeals = {} } = await chrome.storage.session.get('appeals');
  for (const k of Object.keys(appeals)) {
    appeals[k] = appeals[k].filter((a) => now - a.at < APPEAL_WINDOW_MS);
    if (!appeals[k].length) delete appeals[k];
  }
  const recent = appeals[key] || [];
  if (recent.length >= MAX_APPEALS) {
    return { ok: true, verdict: 'slack', allow: false, reconsidered: false, final: true, message: `I've heard enough about this page. Back to ${taskLabel(settings)}.` };
  }

  const anger = computeAnger(state, settings, now);
  const rawCtx = await loadCtx(cur.tabId);
  const page = rawCtx && pageKey(rawCtx.url) === key ? rawCtx : null;
  const day = await loadDay();
  let result;
  try {
    result = await appeal({
      config: aiConfig(settings),
      task: settings.task,
      mood: anger.label,
      kind,
      action,
      reply: text,
      previous: { category: cur.category, reason: cur.reason, source: cur.source, said: msg.said },
      situation: {
        site: siteName(cur.domain),
        slackingForMin: Math.round((state.streak?.slack || 0) / 60),
        snoozesInARow: state.snoozeCount || 0,
        lockdownBegs: state.lockdownBegs || 0,
        fakeComebacks: state.fakeComebacks || 0,
        lockdownActive: Boolean(state.lockdown),
        todayMin: { work: Math.round(day.totals.work / 60), slack: Math.round(day.totals.slack / 60) },
        mood: anger.label,
        why: anger.reasons,
      },
      page,
      memory: settings.memory?.enabled ? memoryForPrompt(await loadMemory()) : {},
      history: recent.map((a) => ({ user: a.text, hackie: a.reply })),
      signal: AbortSignal.timeout(20000),
    });
    await chrome.storage.local.set({ aiPauseUntil: 0, aiStatus: { ok: true, at: Date.now(), model: result.model } });
  } catch (err) {
    await noteAiFailure(err);
    return { ok: false, error: `Hackie couldn't think that through (${err.message}). Try again.` };
  }

  appeals[key] = [...recent, { at: now, text, reply: result.message, verdict: result.verdict, allow: result.allow }];
  await chrome.storage.session.set({ appeals });
  const outcome = result.verdict === 'work' ? 'reclassified' : result.allow ? 'allowed' : 'denied';
  if (settings.memory?.enabled) {
    await updateMemory((m) => addIncident(m, { kind: 'reply', action: action || 'warning', site: siteName(cur.domain), outcome, summary: `"${text.slice(0, 100)}" → ${result.message}` }));
  }

  if (result.verdict === 'work') {
    // Convinced: this page is work from now on (like an accepted "It's for my task").
    await serial(() => handleAction('isWork', tab || { id: cur.tabId, url: cur.url }));
  } else if (result.allow && action === 'beg') {
    // A granted beg is a plain snooze; it was already counted as a beg when refused.
    await serial(() => mutate(({ state: st, settings: s, day: d, now: t }) => {
      const minutes = snoozeMinutes(st.snoozeCount || 0, s.thresholds.snoozeMin);
      st.snoozeUntil = t + minutes * 60e3;
      st.snoozeCount = (st.snoozeCount || 0) + 1;
      d.events.snoozes += 1;
    }));
  } else if (result.allow && ['snooze', 'isWork', 'exercise', 'resetMood'].includes(action)) {
    await serial(() => handleAction(action, tab || { id: cur.tabId, url: cur.url }));
  } else if (!result.allow) {
    await serial(() => mutate(({ day: d }) => {
      d.events.repliesDenied = (d.events.repliesDenied || 0) + 1;
    }));
  }
  kick('reply');
  return {
    ok: true,
    verdict: result.verdict,
    allow: result.allow,
    action,
    reconsidered: outcome !== 'denied',
    message: result.message,
    left: MAX_APPEALS - appeals[key].length,
    final: outcome === 'denied' && appeals[key].length >= MAX_APPEALS,
  };
}

// ---------------------------------------------------------------------------
// Messages

// Hackie's art for web pages, as data: URLs. Pages never load chrome-extension:// files themselves
// (YouTube's service worker logs those as "Unsafe attempt to load URL"), and the extension doesn't
// expose any web-accessible resources that sites could probe for.
let artPromise = null;
function loadArt() {
  artPromise ||= Promise.all(
    [...globalThis.Hackie.ART_FILES, globalThis.Hackie.FONT].map(async (path) => {
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const type = path.endsWith('.gif') ? 'image/gif' : path.endsWith('.woff2') ? 'font/woff2' : 'image/png';
      return [path, `data:${type};base64,${btoa(bin)}`];
    }),
  )
    .then(Object.fromEntries)
    .catch((err) => {
      artPromise = null;
      throw err;
    });
  return artPromise;
}

const HANDLERS = {
  'hackie:art': () => loadArt(),
  'page:context': async (msg, sender) => {
    const tab = sender.tab;
    if (tab?.id == null) return { ok: false };
    let ctx = sanitizeCtx(msg.ctx);
    if (ctx) {
      // Don't keep anything readable about sensitive pages, not even locally.
      const settings = await loadSettings();
      if (findSensitive({ url: tab.url || ctx.url, ctx, list: settings.sensitiveSites })) {
        ctx = { url: ctx.url, mediaPlaying: ctx.mediaPlaying, sensitive: true, readAt: ctx.readAt };
      }
    }
    await chrome.storage.session.set({ [`ctx:${tab.id}`]: ctx });
    if (tab.active) serial(() => refresh('ctx'));
    return { ok: true };
  },
  'pomo:action': async (msg, sender) => {
    const action = msg.action;
    let judged = null;
    if (['snooze', 'isWork', 'dismiss', 'exercise', 'resetMood'].includes(action)) {
      const st = await loadState();
      const isBeg = action === 'snooze' && st.lastFire?.level >= 3 && Date.now() - (st.lastFire.at || 0) < 30 * 60e3;
      judged = await judgeClick(isBeg ? 'beg' : action, sender.tab);
      if (!judged.allow) return { ok: false, denied: true, action: isBeg ? 'beg' : action, message: judged.message };
    }
    if (action === 'isWork' && !(judged?.anger?.level >= 2 && judged.message)) {
      const review = await reviewLabelChange({ url: sender.tab?.url, scope: 'page', category: 'work', tab: sender.tab });
      if (!review.allow) return { ok: false, denied: true, action, message: review.message };
      if (review.message) judged = { ...(judged || {}), message: review.message };
    }
    const res = await serial(() => handleAction(action, sender.tab));
    return { ...res, message: judged?.message || '' };
  },
  'popup:getState': () =>
    serial(async () => {
      await refresh('popup');
      return buildPopupState();
    }),
  'popup:setCategory': async (msg) => {
    const review = await reviewLabelChange({ url: msg.url, scope: msg.scope === 'page' ? 'page' : 'site', category: msg.category });
    if (!review.allow) return { ok: false, denied: true, action: 'relabel', message: review.message };
    const res = await serial(() => setCategory(msg));
    return { ...res, message: review.message };
  },
  'popup:break': async (msg) => {
    const minutes = Number(msg.minutes) || 0;
    if (minutes > 0) {
      const judged = await judgeClick('break', null);
      if (!judged.allow) return { ok: false, denied: true, message: judged.message };
    }
    return serial(() => setBreak(minutes));
  },
  'popup:setTracking': async (msg) => {
    if (!msg.enabled) {
      const judged = await judgeClick('pause', null);
      if (!judged.allow) return { ok: false, denied: true, message: judged.message };
    }
    return serial(async () => {
      const settings = await loadSettings();
      settings.trackingEnabled = Boolean(msg.enabled);
      await chrome.storage.local.set({ settings });
      await refresh('tracking');
      return { ok: true };
    });
  },
  'report:get': (msg) => buildReport(msg.days || 14),
  'options:testAI': (msg) => testAI(msg.page),
  'options:resetStats': () => serial(resetStats),
  'options:listModels': async () => {
    const settings = await loadSettings();
    try {
      return { ok: true, models: await listModels(aiConfig(settings)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  'test:fire': (msg) => serial(() => testFire(msg.level)),
  'test:setStreak': async (msg) => {
    const st = await loadState();
    if (Number(msg.seconds) < (st.streak?.slack || 0)) {
      const judged = await judgeClick('demoLower', null);
      if (!judged.allow) return { ok: false, denied: true, message: judged.message };
    }
    return serial(() => setStreakDemo(msg.seconds));
  },
  'popup:resetMood': async () => {
    const judged = await judgeClick('resetMood', null);
    if (!judged.allow) return { ok: false, denied: true, message: judged.message };
    return serial(() => handleAction('resetMood', null));
  },
  'popup:setThreshold': (msg) => serial(() => setThreshold(msg.key, msg.value)),
  'memory:get': async () => ({ ok: true, memory: await memoryView() }),
  'memory:forget': async (msg) => {
    await updateMemory(async (mem) => {
      const next = forgetMemory(mem, msg.kind, msg.id);
      if (msg.kind === 'all') Object.assign(mem, next);
    });
    return { ok: true };
  },
  'memory:flagSite': async (msg) => {
    await updateMemory((mem) => flagSite(mem, String(msg.domain || ''), Boolean(msg.flagged)));
    return { ok: true };
  },
  'memory:addProject': async (msg) => {
    const project = await updateMemory((mem) => addProject(mem, { name: msg.name, urls: msg.urls, notes: msg.notes }));
    return project ? { ok: true, project } : { ok: false, error: 'A project needs a name.' };
  },
  'memory:addFact': async (msg) => {
    const fact = await updateMemory((mem) => addFact(mem, msg.text));
    return fact ? { ok: true, fact } : { ok: false, error: 'Empty or already known.' };
  },
  'closed:list': async () => {
    const { closedByHackie = [] } = await chrome.storage.local.get('closedByHackie');
    return { ok: true, tabs: closedByHackie.map(({ url, title, at, sensitive }) => ({ url, title: sensitive ? 'Private site' : title, at })) };
  },
  'closed:restore': async (msg) => {
    const judged = await judgeClick('restore', null);
    if (!judged.allow) return { ok: false, denied: true, message: judged.message };
    return restoreClosed(Number.isInteger(msg.index) ? msg.index : undefined);
  },
  'agent:ask': (msg) => askHackie(msg.question),
  'appeal:send': (msg, sender) => handleAppeal(msg, sender.tab),
  'agent:history': async () => {
    const { agentChat = [] } = await chrome.storage.session.get('agentChat');
    const settings = await loadSettings();
    return { ok: true, messages: agentChat, configured: aiConfigured(settings) };
  },
  'agent:clear': async () => {
    await chrome.storage.session.remove('agentChat');
    return { ok: true };
  },
  'debug:get': async () => {
    const settings = await loadSettings();
    return settings.debug?.enabled ? debugPayload(settings) : { enabled: false };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (result) => sendResponse(result ?? { ok: true }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
  return true;
});

// ---------------------------------------------------------------------------
// Browser events

const kick = (trigger) => serial(() => refresh(trigger));

chrome.tabs.onActivated.addListener(() => kick('tab-activated'));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.active) return;
  if (info.url || info.status === 'complete' || 'audible' in info) kick('tab-updated');
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`ctx:${tabId}`);
});
chrome.windows.onFocusChanged.addListener(() => kick('focus'));
chrome.idle.onStateChanged.addListener(() => kick('idle'));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) kick('tick');
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('settings' in changes || 'overrides' in changes)) kick('settings');
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarm();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  // Put Hackie on tabs that were open before the extension was installed/reloaded.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => injectContent(t.id)));
  await pruneOldDays();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await pruneOldDays();
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
ensureAlarm();

// Handy from the service worker DevTools console: `await taskwhip.refresh()`.
globalThis.taskwhip = {
  refresh: (trigger = 'debug') => serial(() => refresh(trigger)),
  state: loadState,
  settings: loadSettings,
  popupState: () => serial(buildPopupState),
  ask: (question) => askHackie(question),
  action: (name) => serial(() => handleAction(name, null)),
  fire: (level = 1) => serial(() => testFire(level)),
  setStreak: (seconds) => serial(() => setStreakDemo(seconds)),
  eventAI: (reason, opts) => runEventAI(reason, opts),
  memory: loadMemory,
  judge: (action, tab) => judgeClick(action, tab),
  relabel: (msg) => HANDLERS['popup:setCategory'](msg),
  anger: async () => computeAnger(await loadState(), await loadSettings()),
  restore: (index) => restoreClosed(index),
  flagSite: (domain, flagged = true) => updateMemory((mem) => flagSite(mem, domain, flagged)),
  tools: agentApi,
  debug: { assumeActive: false },
};
