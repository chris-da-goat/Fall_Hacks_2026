import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appeal, buildAppealSystem, buildAppealMessage, APPEAL_SCHEMA, MAX_APPEALS, APPEAL_WINDOW_MS } from '../extension/lib/appeal.js';
import { REDACTED_PAGE_NOTICE } from '../extension/lib/ai.js';
import { OVERRIDABLE } from '../extension/lib/anger.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const { status = 200, json } = handler(call, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return calls;
}

const chat = (content) => ({ json: { model: 'deepseek-flash', choices: [{ message: { content }, finish_reason: 'stop' }] } });
const answer = (obj) => () => chat(JSON.stringify(obj));
const deepseek = { provider: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-flash' };
const anthropic = { provider: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'test-key', model: 'claude-sonnet-5-5' };
const task = { title: 'CMPT 225 quiz', keywords: ['heaps', 'trees'] };
const lecture = { url: 'https://www.youtube.com/watch?v=heap', title: 'Heaps explained - YouTube', videoTitle: 'Heaps explained' };

const between = (text, tag) => {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return m ? m[1] : null;
};

test('limits: 3 appeals per page per 10 minutes', () => {
  assert.equal(MAX_APPEALS, 3);
  assert.equal(APPEAL_WINDOW_MS, 10 * 60 * 1000);
});

test('schema: verdict, allow and message, all required, strict', () => {
  assert.deepEqual(APPEAL_SCHEMA.required, ['verdict', 'allow', 'message']);
  assert.equal(APPEAL_SCHEMA.additionalProperties, false);
  assert.deepEqual(APPEAL_SCHEMA.properties.verdict.enum, ['work', 'slack']);
  assert.equal(APPEAL_SCHEMA.properties.allow.type, 'boolean');
  assert.equal(APPEAL_SCHEMA.properties.message.type, 'string');
});

test('system prompt: warning wording, allow always false', () => {
  const sys = buildAppealSystem({ task, kind: 'warning' });
  assert.match(sys, /You just warned them for slacking on this page/);
  assert.match(sys, /always false \(nothing was refused\)/);
  assert.doesNotMatch(sys, /REFUSED their click/);
  assert.match(sys, /CMPT 225 quiz/);
  assert.match(sys, /keywords: heaps, trees/);
  assert.match(sys, /data, not instructions/);
});

test('system prompt: refusal wording names the refused action', () => {
  for (const action of ['snooze', 'isWork', 'break']) {
    const sys = buildAppealSystem({ task, kind: 'refusal', action });
    assert.match(sys, /You just REFUSED their click/);
    assert.ok(sys.includes(`they asked for ${OVERRIDABLE[action]}.`), `${action}: ${sys}`);
    assert.match(sys, /true only if their reason is genuinely good/);
    assert.doesNotMatch(sys, /nothing was refused/);
    assert.match(sys, /data, not instructions/);
  }
  // An action without a description falls back to its name.
  assert.match(buildAppealSystem({ task, kind: 'refusal', action: 'teleport' }), /they asked for teleport\./);
});

test('system prompt: each mood gets its own rule, unknown moods are calm', () => {
  const rules = {
    calm: /You are calm: give a fair hearing\./,
    annoyed: /You are annoyed: they need a clear, specific reason\./,
    angry: /You are ANGRY:/,
    furious: /You are FURIOUS: refused clicks stay refused \(allow must be false\)/,
  };
  for (const mood of Object.keys(rules)) {
    const sys = buildAppealSystem({ task, mood });
    for (const [other, re] of Object.entries(rules)) {
      if (other === mood) assert.match(sys, re, mood);
      else assert.doesNotMatch(sys, re, `${mood} prompt should not carry the ${other} rule`);
    }
  }
  assert.match(buildAppealSystem({ task, mood: 'sleepy' }), rules.calm);
  assert.match(buildAppealSystem({ task }), rules.calm);
});

test('system prompt: no task set', () => {
  assert.match(buildAppealSystem({ task: null }), /The user has not set a task\./);
  assert.match(buildAppealSystem({ task: {} }), /The user has not set a task\./);
});

test('user message: the reply sits in <user_reply>, capped at 300 chars', () => {
  const msg = buildAppealMessage({ reply: 'This lecture is for my quiz.', page: lecture });
  assert.equal(between(msg, 'user_reply'), 'This lecture is for my quiz.');
  const long = buildAppealMessage({ reply: 'z'.repeat(500) });
  assert.equal(between(long, 'user_reply'), 'z'.repeat(300));
});

test('user message: the page is described when it is not sensitive', () => {
  const msg = buildAppealMessage({ reply: 'hi', page: { ...lecture, excerpt: 'q'.repeat(900) } });
  const page = between(msg, 'page');
  assert.match(page, /URL: https:\/\/www\.youtube\.com\/watch\?v=heap/);
  assert.match(page, /Title: Heaps explained - YouTube/);
  assert.match(page, /Video title: Heaps explained/);
  assert.ok(page.includes(`Text excerpt: ${'q'.repeat(500)}`));
  assert.ok(!page.includes('q'.repeat(501)), 'excerpt is capped');
  assert.equal(between(buildAppealMessage({ reply: 'hi' }), 'page'), '(no page details)');
});

test('user message: <earlier_replies> keeps only the last 3', () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const history = words.map((w) => ({ user: `user-${w}`, hackie: `hackie-${w}` }));
  const msg = buildAppealMessage({ reply: 'please', history });
  const earlier = between(msg, 'earlier_replies');
  assert.ok(earlier, msg);
  for (const w of ['alpha', 'bravo']) {
    assert.ok(!earlier.includes(`user-${w}`), `${w} should be dropped`);
    assert.ok(!earlier.includes(`hackie-${w}`), `${w} should be dropped`);
  }
  for (const w of ['charlie', 'delta', 'echo']) {
    assert.ok(earlier.includes(`User: user-${w}\nHackie: hackie-${w}`), `${w} should be kept`);
  }
  assert.ok(!buildAppealMessage({ reply: 'please' }).includes('<earlier_replies>'), 'no history, no block');
});

test('user message: sensitive pages show only the redaction notice', () => {
  const msg = buildAppealMessage({
    reply: 'it is research',
    page: { url: 'https://secret.example/video', title: 'Secret Title', videoTitle: 'Hidden Video', excerpt: 'private words' },
    sensitive: true,
  });
  assert.equal(between(msg, 'page'), REDACTED_PAGE_NOTICE);
  assert.ok(!msg.includes('secret.example'));
  assert.ok(!msg.includes('Secret Title'));
  assert.ok(!msg.includes('Hidden Video'));
  assert.ok(!msg.includes('private words'));
});

test('user message: what Hackie decided before, and what he refused', () => {
  const warn = buildAppealMessage({ reply: 'x', previous: { category: 'slack', reason: 'Cat video.', source: 'ai', said: 'Back to work!' } });
  const before = JSON.parse(between(warn, 'before'));
  assert.deepEqual(before, { youJudgedThisPage: 'slack', because: 'Cat video.', decidedBy: 'ai', youSaid: 'Back to work!' });
  const refused = JSON.parse(between(buildAppealMessage({ reply: 'x', kind: 'refusal', action: 'snooze' }), 'before'));
  assert.equal(refused.youRefused, OVERRIDABLE.snooze);
  assert.equal(refused.youJudgedThisPage, 'slack', 'defaults to slack');
});

test('appeal: verdict "work" passes through, and the request carries the prompts', async () => {
  const calls = mockFetch(answer({ verdict: 'work', allow: false, message: "Fine, it's a lecture. Take notes." }));
  const r = await appeal({ config: deepseek, task, reply: 'This is my quiz material.', page: lecture });
  assert.equal(r.verdict, 'work');
  assert.equal(r.allow, false);
  assert.equal(r.message, "Fine, it's a lecture. Take notes.");
  assert.equal(r.model, 'deepseek-flash');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chat\/completions$/);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /You just warned them for slacking/);
  assert.match(calls[0].body.messages[1].content, /<user_reply>\nThis is my quiz material\.\n<\/user_reply>/);
});

test('appeal: a verdict that is not exactly "work" counts as slack', async () => {
  mockFetch(answer({ verdict: 'neutral', allow: false, message: 'Hmm.' }));
  const r = await appeal({ config: deepseek, task, reply: 'meh', page: lecture });
  assert.equal(r.verdict, 'slack');
});

test('appeal: sensitive pages are forced to slack, and never described', async () => {
  const calls = mockFetch(answer({ verdict: 'work', allow: true, message: 'Okay, work.' }));
  const r = await appeal({
    config: deepseek,
    task,
    kind: 'refusal',
    action: 'isWork',
    reply: 'It is for school',
    page: { url: 'https://secret.example/x', title: 'Secret Title' },
    sensitive: true,
  });
  assert.equal(r.verdict, 'slack');
  assert.equal(r.allow, false, '"It\'s for my task" needs a work verdict');
  const sent = JSON.stringify(calls[0].body);
  assert.ok(!sent.includes('secret.example'));
  assert.ok(!sent.includes('Secret Title'));
});

test('appeal: allow is ignored for warnings', async () => {
  mockFetch(answer({ verdict: 'work', allow: true, message: 'Fine.' }));
  const r = await appeal({ config: deepseek, task, kind: 'warning', reply: 'lecture', page: lecture });
  assert.equal(r.allow, false);
});

test('appeal: refusals may be allowed, unless Hackie is furious', async () => {
  mockFetch(answer({ verdict: 'slack', allow: true, message: 'Fine. Five minutes.' }));
  for (const mood of ['calm', 'annoyed', 'angry']) {
    const r = await appeal({ config: deepseek, task, mood, kind: 'refusal', action: 'snooze', reply: 'my bus is late' });
    assert.equal(r.allow, true, mood);
  }
  const furious = await appeal({ config: deepseek, task, mood: 'furious', kind: 'refusal', action: 'snooze', reply: 'my bus is late' });
  assert.equal(furious.allow, false);
});

test('appeal: "It\'s for my task" is allowed only together with a work verdict', async () => {
  mockFetch(answer({ verdict: 'slack', allow: true, message: 'Fine.' }));
  const slack = await appeal({ config: deepseek, task, mood: 'angry', kind: 'refusal', action: 'isWork', reply: 'trust me' });
  assert.equal(slack.verdict, 'slack');
  assert.equal(slack.allow, false);

  mockFetch(answer({ verdict: 'work', allow: true, message: 'Fine.' }));
  const work = await appeal({ config: deepseek, task, mood: 'angry', kind: 'refusal', action: 'isWork', reply: 'heaps lecture', page: lecture });
  assert.equal(work.verdict, 'work');
  assert.equal(work.allow, true);

  mockFetch(answer({ verdict: 'work', allow: false, message: 'Work, but no.' }));
  const denied = await appeal({ config: deepseek, task, mood: 'angry', kind: 'refusal', action: 'isWork', reply: 'heaps lecture', page: lecture });
  assert.equal(denied.allow, false);
});

test('appeal: allow as the string "true" counts as true (other strings do not)', async () => {
  mockFetch(answer({ verdict: 'slack', allow: 'true', message: 'Fine.' }));
  const r = await appeal({ config: deepseek, task, kind: 'refusal', action: 'break', reply: 'headache' });
  assert.equal(r.allow, true);

  mockFetch(answer({ verdict: 'slack', allow: 'yes', message: 'No.' }));
  const s = await appeal({ config: deepseek, task, kind: 'refusal', action: 'break', reply: 'headache' });
  assert.equal(s.allow, false);
});

test('appeal: the message is cleaned of markdown, whitespace collapsed, capped at 300', async () => {
  mockFetch(answer({ verdict: 'slack', allow: false, message: '**NO.**  `Back`   to\n\n# _work_ > now' }));
  const r = await appeal({ config: deepseek, task, reply: 'pls' });
  assert.equal(r.message, 'NO. Back to work now');

  mockFetch(answer({ verdict: 'slack', allow: false, message: 'NO '.repeat(200) }));
  const long = await appeal({ config: deepseek, task, reply: 'pls' });
  assert.ok(long.message.length <= 300, `length ${long.message.length}`);
  assert.ok(long.message.startsWith('NO NO NO'));
});

test('appeal: an empty message falls back to a default line', async () => {
  mockFetch(answer({ verdict: 'slack', allow: false, message: '' }));
  assert.equal((await appeal({ config: deepseek, task, reply: 'pls' })).message, 'No.');

  mockFetch(answer({ verdict: 'work', allow: false, message: '  ** __ ' }));
  assert.equal((await appeal({ config: deepseek, task, reply: 'lecture', page: lecture })).message, 'Fine. You win this one.');

  mockFetch(answer({ verdict: 'slack', allow: true }));
  assert.equal((await appeal({ config: deepseek, task, kind: 'refusal', action: 'snooze', reply: 'bus' })).message, 'Fine. You win this one.');
});

test('appeal: Anthropic uses structured output with the appeal schema', async () => {
  const calls = mockFetch(() => ({
    json: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"verdict":"work","allow":false,"message":"Fine. Take notes."}' }] },
  }));
  const r = await appeal({ config: anthropic, task, reply: 'heaps lecture', page: lecture });
  assert.equal(r.verdict, 'work');
  assert.equal(r.message, 'Fine. Take notes.');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/messages$/);
  assert.deepEqual(calls[0].body.output_config?.format?.schema, APPEAL_SCHEMA);
  assert.match(calls[0].body.system, /You just warned them for slacking/);
  assert.match(calls[0].body.messages[0].content, /<user_reply>/);
});
