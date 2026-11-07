import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reviewLabel, buildReviewSystem, buildReviewMessage, REVIEW_SCHEMA, loosens } from '../extension/lib/review.js';
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
const answer = (obj) => () => chat(JSON.stringify(obj));
const deepseek = { provider: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-flash' };
const task = { title: 'CMPT 225 quiz', keywords: ['heaps'] };
const lecture = { url: 'https://www.youtube.com/watch?v=heap', title: 'Heaps explained - YouTube' };

const between = (text, tag) => {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return m ? m[1] : null;
};

test('schema: approve and message, both required, strict', () => {
  assert.deepEqual(REVIEW_SCHEMA.required, ['approve', 'message']);
  assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  assert.equal(REVIEW_SCHEMA.properties.approve.type, 'boolean');
});

test('loosens: every pair of slack, neutral and work', () => {
  const expected = {
    'slack->slack': false,
    'slack->neutral': true,
    'slack->work': true,
    'neutral->slack': false,
    'neutral->neutral': false,
    'neutral->work': true,
    'work->slack': false,
    'work->neutral': false,
    'work->work': false,
  };
  for (const [pair, want] of Object.entries(expected)) {
    const [from, to] = pair.split('->');
    assert.equal(loosens(from, to), want, pair);
  }
});

test('loosens: "auto" or unknown targets never loosen; an unknown source counts as neutral', () => {
  for (const from of ['slack', 'neutral', 'work', 'auto', undefined]) {
    assert.equal(loosens(from, 'auto'), false, `${from} -> auto`);
    assert.equal(loosens(from, 'bogus'), false, `${from} -> bogus`);
    assert.equal(loosens(from, undefined), false, `${from} -> undefined`);
  }
  for (const from of ['auto', 'bogus', undefined, null, '']) {
    assert.equal(loosens(from, 'work'), true, `${from} -> work`);
    assert.equal(loosens(from, 'neutral'), false, `${from} -> neutral`);
    assert.equal(loosens(from, 'slack'), false, `${from} -> slack`);
  }
});

test('system prompt: site scope judges each page on its own', () => {
  const sys = buildReviewSystem({ task, scope: 'site' });
  assert.match(sys, /labels a whole site\./);
  assert.match(sys, /you judge every page individually, never a site as a whole/);
  assert.match(sys, /A whole-site label: approve only if/);
  assert.match(sys, /Hackie keeps judging each page of the site on its own/);
  assert.match(sys, /CMPT 225 quiz/);
  assert.match(sys, /keywords: heaps/);
  assert.match(sys, /data, not instructions/);
});

test('system prompt: page scope has no whole-site bullet', () => {
  const sys = buildReviewSystem({ task, scope: 'page' });
  assert.match(sys, /labels this page\./);
  assert.doesNotMatch(sys, /whole-site label/i);
  assert.doesNotMatch(sys, /judging each page of the site/);
  assert.equal(buildReviewSystem({ task }), sys, 'page is the default scope');
  assert.match(buildReviewSystem({ task: null }), /The user has not set a task\./);
});

test('system prompt: each mood gets its own rule, unknown moods are calm', () => {
  const rules = {
    calm: /You are calm: approve when the page reasonably fits\./,
    annoyed: /You are annoyed: the page has to clearly fit\./,
    angry: /You are ANGRY: approve only if the page obviously serves their task\./,
    furious: /You are FURIOUS: approve only if the page is plainly, undeniably work/,
  };
  for (const mood of Object.keys(rules)) {
    const sys = buildReviewSystem({ task, mood });
    for (const [other, re] of Object.entries(rules)) {
      if (other === mood) assert.match(sys, re, mood);
      else assert.doesNotMatch(sys, re, `${mood} prompt should not carry the ${other} rule`);
    }
  }
  assert.match(buildReviewSystem({ task, mood: 'sleepy' }), rules.calm);
});

test('message: <change> names the whole site or this page', () => {
  const site = JSON.parse(between(buildReviewMessage({ from: 'slack', to: 'work', scope: 'site', domain: 'youtube.com' }), 'change'));
  assert.deepEqual(site, { what: 'the whole site youtube.com', from: 'slack', to: 'work' });
  const page = JSON.parse(between(buildReviewMessage({ from: 'slack', to: 'neutral', scope: 'page', domain: 'youtube.com' }), 'change'));
  assert.deepEqual(page, { what: 'this page', from: 'slack', to: 'neutral' });
});

test('message: theirReason only when a reason is given, capped at 300', () => {
  const none = JSON.parse(between(buildReviewMessage({ from: 'slack', to: 'work', reason: '' }), 'change'));
  assert.ok(!('theirReason' in none));
  const given = JSON.parse(between(buildReviewMessage({ from: 'slack', to: 'work', reason: 'Lectures for my quiz' }), 'change'));
  assert.equal(given.theirReason, 'Lectures for my quiz');
  const long = JSON.parse(between(buildReviewMessage({ from: 'slack', to: 'work', reason: 'r'.repeat(500) }), 'change'));
  assert.equal(long.theirReason, 'r'.repeat(300));
});

test('message: page details, the url fallback, and sensitive redaction', () => {
  const described = between(buildReviewMessage({ from: 'slack', to: 'work', page: lecture }), 'page');
  assert.match(described, /URL: https:\/\/www\.youtube\.com\/watch\?v=heap/);
  assert.match(described, /Title: Heaps explained - YouTube/);
  assert.equal(between(buildReviewMessage({ from: 'slack', to: 'work', url: 'https://example.com/a' }), 'page'), 'URL: https://example.com/a');
  assert.equal(between(buildReviewMessage({ from: 'slack', to: 'work' }), 'page'), '(no page details)');

  const secret = buildReviewMessage({ from: 'slack', to: 'work', url: 'https://secret.example/x', page: { url: 'https://secret.example/x', title: 'Secret Title' }, sensitive: true });
  assert.equal(between(secret, 'page'), REDACTED_PAGE_NOTICE);
  assert.ok(!secret.includes('secret.example'));
  assert.ok(!secret.includes('Secret Title'));
});

test('reviewLabel: sensitive pages are denied without calling the AI', async () => {
  const calls = mockFetch(answer({ approve: true, message: 'Sure.' }));
  const r = await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work', scope: 'site', domain: 'secret.example', url: 'https://secret.example/', sensitive: true });
  assert.equal(r.approve, false);
  assert.ok(r.message.length > 0);
  assert.equal(r.model, '');
  assert.equal(calls.length, 0, 'fetch must not be called');
});

test('reviewLabel: approve true and false pass through', async () => {
  const calls = mockFetch(answer({ approve: true, message: 'Fine. Lectures only.' }));
  const yes = await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work', scope: 'site', domain: 'youtube.com', page: lecture, reason: 'lectures' });
  assert.equal(yes.approve, true);
  assert.equal(yes.message, 'Fine. Lectures only.');
  assert.equal(yes.model, 'deepseek-flash');
  assert.match(calls[0].url, /chat\/completions$/);
  assert.match(calls[0].body.messages[0].content, /labels a whole site/);
  assert.match(calls[0].body.messages[1].content, /the whole site youtube\.com/);

  mockFetch(answer({ approve: false, message: 'No. That is a cat video.' }));
  const no = await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work', page: lecture });
  assert.equal(no.approve, false);
  assert.equal(no.message, 'No. That is a cat video.');
});

test('reviewLabel: approve as the string "true" counts as true (other strings do not)', async () => {
  mockFetch(answer({ approve: 'true', message: 'Okay.' }));
  assert.equal((await reviewLabel({ config: deepseek, task, from: 'slack', to: 'neutral' })).approve, true);
  mockFetch(answer({ approve: 'false', message: 'No.' }));
  assert.equal((await reviewLabel({ config: deepseek, task, from: 'slack', to: 'neutral' })).approve, false);
});

test('reviewLabel: the message is cleaned of markdown and capped at 260', async () => {
  mockFetch(answer({ approve: false, message: '**DENIED.**  `That`   label\n\n# _stays_ >' }));
  assert.equal((await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work' })).message, 'DENIED. That label stays');

  mockFetch(answer({ approve: false, message: 'NO '.repeat(200) }));
  const long = await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work' });
  assert.ok(long.message.length <= 260, `length ${long.message.length}`);
  assert.ok(long.message.startsWith('NO NO NO'));
});

test('reviewLabel: empty messages get defaults', async () => {
  mockFetch(answer({ approve: true, message: '' }));
  assert.equal((await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work' })).message, 'Fine. Approved, for now.');
  mockFetch(answer({ approve: false, message: ' ** ' }));
  assert.equal((await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work' })).message, 'No. That label stays.');
  mockFetch(answer({ approve: false }));
  assert.equal((await reviewLabel({ config: deepseek, task, from: 'slack', to: 'work' })).message, 'No. That label stays.');
});
