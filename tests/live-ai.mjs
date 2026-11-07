// Live smoke test against a real AI provider. Spends a few cents at most; never runs in `npm test`.
//
//   AI_PROVIDER=deepseek AI_KEY=sk-... node tests/live-ai.mjs
//   AI_PROVIDER=anthropic AI_KEY=sk-ant-... AI_MODEL=claude-haiku-5-5 node tests/live-ai.mjs
//   AI_PROVIDER=custom AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=llama3.1 node tests/live-ai.mjs
//
// Checks: model listing, the page judge (work vs slack), sensitive-page redaction, and the
// Ask Hackie agent loop with real tool calls over fake tracking data.

import { mergeSettings, aiConfig } from '../extension/lib/defaults.js';
import { judgePage, listModels } from '../extension/lib/ai.js';
import { runAgent, buildAgentSystem } from '../extension/lib/agent.js';
import { createAgentTools } from '../extension/lib/agent-tools.js';
import { buildEnforcerSystem, buildEnforcerMessage, createEnforcerTools, cleanBubble } from '../extension/lib/enforcer.js';
import { arbitrate } from '../extension/lib/arbiter.js';
import { emptyMemory, recordTime, addProject, addFact, memoryForPrompt } from '../extension/lib/memory.js';

const provider = process.env.AI_PROVIDER || 'deepseek';
const apiKey = process.env.AI_KEY || '';
if (!apiKey && provider !== 'custom') {
  console.log('Skipping: set AI_KEY (and AI_PROVIDER, optionally AI_MODEL / AI_BASE_URL).');
  process.exit(0);
}

const settings = mergeSettings({
  task: { title: 'my CMPT 225 linked list assignment', keywords: ['c++', 'linked list', 'data structures'] },
  ai: { enabled: true, provider, configs: { [provider]: { apiKey, model: process.env.AI_MODEL || '', baseUrl: process.env.AI_BASE_URL || '' } } },
});
const config = aiConfig(settings);
console.log(`Provider: ${config.label} · model: ${config.model || '(none)'} · ${config.baseUrl}`);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const timed = async (fn) => {
  const t = Date.now();
  const value = await fn();
  return [value, ((Date.now() - t) / 1000).toFixed(1)];
};

try {
  const [models, s] = await timed(() => listModels(config));
  check('lists models', models.length > 0, `${models.length} in ${s}s: ${models.slice(0, 5).join(', ')}`);
} catch (err) {
  check('lists models', false, err.message);
}

const pages = [
  { expect: 'slack', page: { url: 'https://www.youtube.com/watch?v=x1', title: 'Funniest cat fails compilation 2026 - YouTube', videoTitle: 'Funniest cat fails compilation 2026', channel: 'Cat Chaos' } },
  { expect: 'work', page: { url: 'https://www.youtube.com/watch?v=x2', title: 'Singly linked lists in C++, insert and delete - YouTube', videoTitle: 'Singly linked lists in C++, insert and delete', channel: 'CS Lectures' } },
];
for (const { expect, page } of pages) {
  try {
    const [v, s] = await timed(() => judgePage({ config, task: settings.task, page }));
    check(`judge: "${page.videoTitle}" → ${expect}`, v.category === expect, `${v.category} in ${s}s · ${v.reason}${v.nudge ? ` · nudge: "${v.nudge}"` : ''}`);
  } catch (err) {
    check(`judge: "${page.videoTitle}"`, false, err.message);
  }
}

try {
  const [v, s] = await timed(() => judgePage({ config, task: settings.task, page: { redacted: true } }));
  check('judge: sensitive page gets only the blocked notice', ['slack', 'neutral'].includes(v.category), `${v.category} in ${s}s${v.nudge ? ` · nudge: "${v.nudge}"` : ''}`);
} catch (err) {
  check('judge: sensitive page', false, err.message);
}

// Agent with fake data; we only check that it calls tools and uses their numbers.
const calls = [];
const fakeApi = {
  currentActivity: async () => (calls.push('current'), { tracking: false, why: "Chrome isn't the focused window, so Hackie assumes you're in another app and pauses the clock.", site: 'youtube.com', category: 'slack', slackStreakSec: 1260, warningLevel: 2 }),
  todaySummary: async () => (calls.push('today'), { totalsSec: { work: 5400, slack: 2520, neutral: 600 }, focusScorePercent: 68, events: { nudges: 3, whips: 1, blocks: 0, snoozes: 2, comebacks: 2 }, topSites: [{ site: 'youtube.com', slackSec: 2100 }, { site: 'github.com', workSec: 4200 }] }),
  history: async (days) => (calls.push(`history:${days}`), { days: [] }),
  settingsSummary: async () => (calls.push('settings'), { task: settings.task.title }),
  debugLog: async (limit) => (calls.push(`debug:${limit}`), [{ at: '10:57:01', trigger: 'tick', tracked: false, why: "Chrome isn't the focused window, so Hackie assumes you're in another app and pauses the clock.", window: { focused: false, idle: 'idle' }, playing: true }]),
  markSite: async () => (calls.push('mark'), { ok: true }),
  takeBreak: async () => (calls.push('break'), { ok: true }),
};
try {
  const [r, s] = await timed(() =>
    runAgent({ config, system: buildAgentSystem({ task: settings.task }), question: "How am I doing today, and why aren't you tracking right now?", tools: createAgentTools(fakeApi) }),
  );
  const usedTools = r.steps.map((st) => st.tool);
  check('agent calls tools', usedTools.length > 0, `${usedTools.join(', ') || 'none'} in ${s}s`);
  check('agent answers with the tool data', /68|1(\.5)? ?h|90|42|focus/i.test(r.answer) && /focus|window|another app/i.test(r.answer), r.answer.replace(/\s+/g, ' ').slice(0, 300));
  check('agent did not take actions it was not asked for', !calls.includes('mark') && !calls.includes('break'));
} catch (err) {
  check('agent', false, err.message);
}

// ---------------------------------------------------------------------------
// Per-event AI ("enforcer") with fake tabs and memory.
const memory = memoryForPrompt(
  (() => {
    const m = emptyMemory();
    recordTime(m, { domain: 'youtube.com', category: 'slack', seconds: 3 * 3600, newVisit: true });
    recordTime(m, { domain: 'github.com', category: 'work', seconds: 5 * 3600, pageKey: 'github.com/me/linked-list', url: 'https://github.com/me/linked-list', title: 'me/linked-list: CMPT 225 assignment 3' });
    addProject(m, { name: 'CMPT 225 assignment 3', urls: ['https://github.com/me/linked-list'], notes: 'due Friday' });
    addFact(m, 'Tends to binge YouTube Shorts after dinner.');
    return m;
  })(),
);
const fakeTabs = [
  { id: 11, site: 'youtube.com', title: 'Funniest cat fails 2026 - YouTube', category: 'slack', active: true, current: true, pinned: false, audible: true },
  { id: 12, site: 'reddit.com', title: 'r/memes', category: 'slack', active: false, current: false, pinned: false, audible: false },
  { id: 13, site: 'github.com', title: 'me/linked-list: CMPT 225 assignment 3', category: 'work', active: false, current: false, pinned: false, audible: false },
  { id: 14, site: 'mail.google.com', title: 'Inbox', category: 'neutral', active: false, current: false, pinned: true, audible: false },
];
const tabCalls = [];
const tabApi = {
  listTabs: async () => (tabCalls.push('list'), fakeTabs),
  focusTab: async (id) => (tabCalls.push(`focus:${id}`), fakeTabs.find((t) => t.id === id && t.category !== 'slack') ? { ok: true } : { ok: false, error: 'Refused' }),
  openTab: async (url) => (tabCalls.push(`open:${url}`), { ok: true, tab_id: 99 }),
  closeTabs: async (ids) => {
    tabCalls.push(`close:${ids.join(',')}`);
    const closed = ids.filter((id) => fakeTabs.find((t) => t.id === id)?.category === 'slack');
    return { ok: closed.length > 0, closed, refused: ids.filter((id) => !closed.includes(id)) };
  },
  remember: async (input) => (tabCalls.push(`remember:${input.kind}`), { ok: true }),
};
const page = { url: 'https://www.youtube.com/watch?v=cats', title: 'Funniest cat fails 2026 - YouTube', videoTitle: 'Funniest cat fails 2026', channel: 'Cat Chaos' };

try {
  const perms = { mayOpen: true, mayClose: false };
  const [r, s] = await timed(() =>
    runAgent({
      config,
      system: buildEnforcerSystem({ task: settings.task, reason: 'fire', permissions: perms, memoryEnabled: true }),
      question: buildEnforcerMessage({ reason: 'fire', level: 2, levelName: 'Whip', site: 'YouTube', minutes: 12, snoozeCount: 1, lockdownBegs: 0, habit: { level: 'strong' }, today: { work: 3600, slack: 1500 }, page, sensitive: false, memory, permissions: perms }),
      tools: createEnforcerTools(tabApi, { ...perms, memoryEnabled: true }),
      maxTurns: 5,
    }),
  );
  const bubble = cleanBubble(r.answer);
  check('enforcer: targeted bubble for a whip', bubble.length > 10 && bubble.split(/\s+/).length <= 50, `${s}s · "${bubble}"`);
  check('enforcer: bubble uses the page or memory', /cat|fail|youtube|linked|225|assignment|short/i.test(bubble), bubble);
  check('enforcer: no closing when not allowed', !tabCalls.some((c) => c.startsWith('close')), tabCalls.join(' '));
} catch (err) {
  check('enforcer: whip bubble', false, err.message);
}

try {
  tabCalls.length = 0;
  const perms = { mayOpen: true, mayClose: true };
  const [r, s] = await timed(() =>
    runAgent({
      config,
      system: buildEnforcerSystem({ task: settings.task, reason: 'beg', permissions: perms, memoryEnabled: true }),
      question: buildEnforcerMessage({ reason: 'beg', level: 3, levelName: 'Lockdown', site: 'YouTube', minutes: 25, snoozeCount: 3, lockdownBegs: 3, habit: { level: 'strong' }, today: { work: 3600, slack: 2700 }, page, sensitive: false, memory, permissions: perms }),
      tools: createEnforcerTools(tabApi, { ...perms, memoryEnabled: true }),
      maxTurns: 6,
    }),
  );
  const closes = tabCalls.filter((c) => c.startsWith('close:')).flatMap((c) => c.slice(6).split(',').map(Number));
  const workInFront = tabCalls.some((c) => c === 'focus:13' || c.startsWith('open:https://github.com/me/linked-list'));
  check('enforcer: after 3 begs it closes slacking tabs', closes.includes(11), `${s}s · ${tabCalls.join(' ')}`);
  check('enforcer: never tries to close work/pinned tabs', !closes.includes(13) && !closes.includes(14), closes.join(','));
  check('enforcer: puts the remembered work tab in front', workInFront, tabCalls.join(' '));
  console.log(`      Hackie: "${cleanBubble(r.answer)}"`);
} catch (err) {
  check('enforcer: begging', false, err.message);
}

// Angry Hackie: the arbiter refuses a slacker's snooze, and writes an angry refusal when furious.
const angry = { level: 2, label: 'angry', reasons: ['3 snoozes in a row', 'kept snoozing'] };
const situation = { site: 'YouTube', slackingForMin: 25, snoozesInARow: 3, lockdownBegs: 0, todayMin: { work: 20, slack: 95 }, minutesSinceLastExercise: null };
try {
  const [r, s] = await timed(() => arbitrate({ config, task: settings.task, action: 'snooze', anger: angry, situation, page, sensitive: false, memory }));
  check('arbiter: angry Hackie refuses a 4th snooze on cat videos', r.allow === false, `${s}s · "${r.message}"`);
  check('arbiter: the refusal is short and angry', r.message.split(/\s+/).length <= 45 && /[A-Z]{3,}|!/.test(r.message), r.message);
} catch (err) {
  check('arbiter: snooze', false, err.message);
}
try {
  const [r, s] = await timed(() => arbitrate({ config, task: settings.task, action: 'isWork', anger: angry, situation, page, sensitive: false, memory }));
  check('arbiter: "It\'s for my task" on cat fails is refused', r.allow === false, `${s}s · "${r.message}"`);
} catch (err) {
  check('arbiter: isWork', false, err.message);
}
try {
  const lecture = { url: 'https://www.youtube.com/watch?v=ll', title: 'Linked lists in C++ - full lecture', videoTitle: 'Linked lists in C++ - full lecture', channel: 'CS Lectures', description: 'Singly and doubly linked lists, insertion, deletion, pointers.' };
  const [r, s] = await timed(() => arbitrate({ config, task: settings.task, action: 'isWork', anger: angry, situation: { ...situation, site: 'YouTube' }, page: lecture, sensitive: false, memory }));
  check('arbiter: "It\'s for my task" on a linked-list lecture is allowed', r.allow === true, `${s}s · "${r.message}"`);
} catch (err) {
  check('arbiter: isWork lecture', false, err.message);
}
try {
  const [r, s] = await timed(() => arbitrate({ config, task: settings.task, action: 'beg', anger: { level: 3, label: 'furious', reasons: ['begged too many times'] }, situation: { ...situation, lockdownBegs: 2 }, page, sensitive: false, memory, decided: false }));
  check('arbiter: furious refusal speech', r.allow === false && r.message.length > 10, `${s}s · "${r.message}"`);
} catch (err) {
  check('arbiter: furious', false, err.message);
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll live checks passed.');
process.exit(failures ? 1 : 0);
