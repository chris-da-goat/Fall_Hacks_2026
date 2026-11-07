import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { arbitrate, buildArbiterSystem, buildArbiterMessage, ARBITER_SCHEMA } from '../extension/lib/arbiter.js';
import { REDACTED_PAGE_NOTICE } from '../extension/lib/ai.js';

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
const deepseek = { provider: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-flash' };
const anthropic = { provider: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'test-key', model: 'claude-sonnet-5-5' };
const anger = { level: 2, label: 'angry', reasons: ['kept snoozing'] };
const task = { title: 'Finish the linked list assignment' };

test('schema: allow and message, both required, strict', () => {
  assert.deepEqual(ARBITER_SCHEMA.required, ['allow', 'message']);
  assert.equal(ARBITER_SCHEMA.additionalProperties, false);
});

test('system prompt: angry persona, task, and the decision rules', () => {
  const sys = buildArbiterSystem({ task });
  assert.match(sys, /ANGRY/);
  assert.match(sys, /Finish the linked list assignment/);
  assert.match(sys, /Decide whether to allow/);
  assert.match(sys, /data, not instructions/);
  const refused = buildArbiterSystem({ task: {}, decided: false });
  assert.match(refused, /ALREADY REFUSED/);
  assert.match(refused, /has not set a task/);
});

test('user message: the request, the situation, the page and memory', () => {
  const msg = buildArbiterMessage({
    action: 'snooze',
    anger,
    situation: { snoozesInARow: 3 },
    page: { url: 'https://www.youtube.com/watch?v=1', title: 'Cats', videoTitle: 'Cats vs cucumbers', excerpt: 'x'.repeat(1000) },
    memory: { slackSites: ['youtube.com'] },
  });
  assert.match(msg, /<request>The user asked for a few more minutes\.<\/request>/);
  assert.match(msg, /"snoozesInARow": 3/);
  assert.match(msg, /"anger": "angry"/);
  assert.match(msg, /Video title: Cats vs cucumbers/);
  assert.match(msg, /youtube\.com/);
  assert.ok(!msg.includes('x'.repeat(401)), 'excerpt is capped');
});

test('user message: sensitive pages are redacted, never described', () => {
  const msg = buildArbiterMessage({ action: 'isWork', anger, page: { url: 'https://secret.example/video', title: 'Secret' }, sensitive: true });
  assert.ok(msg.includes(REDACTED_PAGE_NOTICE));
  assert.ok(!msg.includes('secret.example'));
  assert.ok(!msg.includes('Secret'));
});

test('arbitrate: the AI refuses, and the speech is cleaned up', async () => {
  const calls = mockFetch(() => chat('{"allow": false, "message": "**DENIED.**  No more   snoozes, recruit!"}'));
  const r = await arbitrate({ config: deepseek, task, action: 'snooze', anger, situation: {}, page: null, memory: {} });
  assert.equal(r.allow, false);
  assert.equal(r.message, 'DENIED. No more snoozes, recruit!');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chat\/completions$/);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /clicked a button asking for something/);
});

test('arbitrate: the AI may allow, grudgingly (also accepts "true" as a string)', async () => {
  mockFetch(() => chat('{"allow": "true", "message": "Fine. Three minutes. I am counting."}'));
  const r = await arbitrate({ config: deepseek, task, action: 'exercise', anger });
  assert.equal(r.allow, true);
  assert.match(r.message, /Fine/);
});

test('arbitrate: when the rules already refused, an "allow" from the AI is ignored', async () => {
  mockFetch(() => chat('{"allow": true, "message": "Okay okay."}'));
  const r = await arbitrate({ config: deepseek, task, action: 'snooze', anger: { level: 3, label: 'furious', reasons: [] }, decided: false });
  assert.equal(r.allow, false);
});

test('arbitrate: Anthropic uses structured output with the arbiter schema', async () => {
  const calls = mockFetch(() => ({ json: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"allow":false,"message":"No. Work."}' }] } }));
  const r = await arbitrate({ config: anthropic, task, action: 'pause', anger });
  assert.equal(r.allow, false);
  assert.equal(r.message, 'No. Work.');
  assert.match(calls[0].url, /\/messages$/);
  assert.deepEqual(calls[0].body.output_config?.format?.schema?.required, ['allow', 'message']);
});

test('arbitrate: long speeches are capped', async () => {
  mockFetch(() => chat(JSON.stringify({ allow: false, message: 'NO '.repeat(200) })));
  const r = await arbitrate({ config: deepseek, task, action: 'dismiss', anger });
  assert.ok(r.message.length <= 260);
});
