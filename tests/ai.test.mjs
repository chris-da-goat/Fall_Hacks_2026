import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { judgePage, extractJson, AIError, parseRetryAfter, httpError, buildUserMessage, SYSTEM_PROMPT, REDACTED_PAGE_NOTICE } from '../extension/lib/ai.js';
import { aiConfig, aiReady, mergeSettings } from '../extension/lib/defaults.js';

const task = { title: 'Finish the linked list assignment', keywords: ['c++'] };
const page = { url: 'https://www.youtube.com/watch?v=x', title: 'Funny cat fails' };
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

test('aiConfig fills provider defaults and keeps per-provider keys', () => {
  const s = mergeSettings({ ai: { enabled: true, provider: 'deepseek', configs: { deepseek: { apiKey: ' sk-1 ' }, openai: { apiKey: 'sk-2' } } } });
  const c = aiConfig(s);
  assert.equal(c.provider, 'deepseek');
  assert.equal(c.kind, 'openai');
  assert.equal(c.apiKey, 'sk-1');
  assert.equal(c.model, 'deepseek-flash');
  assert.equal(c.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(aiReady(s), true);
});

test('aiReady needs a key, except for custom local servers', () => {
  assert.equal(aiReady(mergeSettings({ ai: { enabled: true, provider: 'anthropic' } })), false);
  assert.equal(aiReady(mergeSettings({ ai: { enabled: false, provider: 'anthropic', configs: { anthropic: { apiKey: 'k' } } } })), false);
  assert.equal(aiReady(mergeSettings({ ai: { enabled: true, provider: 'openai', configs: { openai: { apiKey: 'k' } } } })), false, 'OpenAI needs a model name');
  assert.equal(aiReady(mergeSettings({ ai: { enabled: true, provider: 'custom', configs: { custom: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3' } } } })), true);
});

test('extractJson tolerates code fences and prose', () => {
  assert.deepEqual(extractJson('```json\n{"category":"slack"}\n```'), { category: 'slack' });
  assert.deepEqual(extractJson('Sure! {"category":"work","reason":"ok"} Hope that helps'), { category: 'work', reason: 'ok' });
  assert.throws(() => extractJson('no json here'), AIError);
});

test('Anthropic: Messages API with structured output, version header and fallbacks', async () => {
  const calls = mockFetch(() => ({
    json: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"category":"slack","reason":"Cats.","nudge":"Drop the cats."}' }] },
  }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'anthropic', configs: { anthropic: { apiKey: 'sk-ant-x' } } } }));
  const v = await judgePage({ config, task, page });
  assert.deepEqual(v, { category: 'slack', reason: 'Cats.', nudge: 'Drop the cats.', model: 'claude-opus-5-5', provider: 'anthropic' });
  const [call] = calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-x');
  assert.equal(call.headers['anthropic-version'], '2026-10-21');
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.match(call.body.messages[0].content, /Funny cat fails/);
});

test('Anthropic Haiku gets no fallbacks parameter', async () => {
  const calls = mockFetch(() => ({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"category":"work","reason":"r","nudge":""}' }] } }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'anthropic', configs: { anthropic: { apiKey: 'k', model: 'claude-haiku-5-5' } } } }));
  await judgePage({ config, task, page });
  assert.equal(calls[0].body.fallbacks, undefined);
  assert.equal(calls[0].headers['anthropic-beta'], undefined);
});

test('Anthropic refusal surfaces as an error', async () => {
  mockFetch(() => ({ json: { stop_reason: 'refusal', content: [] } }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'anthropic', configs: { anthropic: { apiKey: 'k' } } } }));
  await assert.rejects(judgePage({ config, task, page }), /declined/);
});

test('OpenAI-compatible: chat completions with bearer auth and JSON mode', async () => {
  const calls = mockFetch(() => ({
    json: { model: 'deepseek-chat', choices: [{ finish_reason: 'stop', message: { content: '{"category":"SLACK","reason":"Cats.","nudge":"Move it."}' } }] },
  }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'deepseek', configs: { deepseek: { apiKey: 'sk-ds' } } } }));
  const v = await judgePage({ config, task, page });
  assert.equal(v.category, 'slack');
  assert.equal(v.provider, 'deepseek');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-ds');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.messages[0].role, 'system');
});

test('OpenAI-compatible: retries without JSON mode when the server rejects it', async () => {
  const calls = mockFetch((call, n) =>
    n === 1
      ? { status: 400, json: { error: { message: 'response_format not supported' } } }
      : { json: { choices: [{ message: { content: 'Here you go: {"category":"work","reason":"Lecture.","nudge":"ignored"}' } }] } },
  );
  const config = aiConfig(mergeSettings({ ai: { provider: 'custom', configs: { custom: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3' } } } }));
  const v = await judgePage({ config, task, page });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.response_format, undefined);
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, undefined, 'no key, no auth header');
  assert.equal(v.category, 'work');
  assert.equal(v.nudge, '', 'nudges only kept for slack verdicts');
});

test('HTTP errors name the provider and the problem', async () => {
  mockFetch(() => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'openai', configs: { openai: { apiKey: 'bad', model: 'some-model' } } } }));
  await assert.rejects(judgePage({ config, task, page }), /OpenAI: API key was rejected\. Incorrect API key provided/);
});

test('parseRetryAfter reads Gemini RetryInfo and "retry in" text', () => {
  assert.equal(parseRetryAfter({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43527s' }] } }), 43527000);
  assert.equal(parseRetryAfter({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.5s' }] } }), 1500);
  assert.equal(parseRetryAfter({}, 'Please retry in 12h5m27.397763066s.'), 12 * 3600e3 + 5 * 60e3 + 27398);
  assert.equal(parseRetryAfter({}, 'no hint here'), 0);
});

test("httpError handles Gemini's array-wrapped quota error", async () => {
  const body = [
    {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message:
          'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\nPlease retry in 12h5m27.39s.',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43527s' }],
      },
    },
  ];
  const err = await httpError({ status: 429, json: async () => body, headers: { get: () => null } }, 'Google Gemini');
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterMs, 43527000);
  assert.match(err.message, /^Google Gemini: Rate limited or out of credits\. Quota exceeded for metric: .*limit: 20/);
});

// Search result pages: the AI judges the query, never the search engine.
const searchPage = { url: 'https://www.google.com/search?q=C%2B%2B++Linked+List+docs&sxsrf=abc', title: 'C++ linked list docs - Google Search' };

test('buildUserMessage judges a search by its phrase only', () => {
  const msg = buildUserMessage(task, searchPage);
  assert.match(msg, /^A Google search results page\.$/m);
  assert.match(msg, /^Search query: "c\+\+ linked list docs"$/m);
  assert.match(msg, /Judge only what the user searched for\./);
  const pagePart = msg.slice(msg.indexOf('<page>'), msg.indexOf('</page>'));
  assert.doesNotMatch(pagePart, /Title:|URL:|Text excerpt|Main heading/, 'nothing scraped from the page');

  assert.match(buildUserMessage(task, { url: 'https://duckduckgo.com/?q=funny+cats', title: 'x' }), /^Search query: "funny cats"$/m);
  assert.match(buildUserMessage(task, { url: 'https://www.youtube.com/results?search_query=cats', title: 'x' }), /^A YouTube search results page\.$/m);
});

test('a stale results page never leaks into a search judgment (Google swapping queries in place)', () => {
  // The URL already says "porn", but the page still shows the previous search's results.
  const stale = {
    url: 'https://www.google.com/search?q=porn',
    title: 'mathematical induction - Google Search',
    h1: 'Mathematical induction',
    excerpt: 'Mathematical induction is a method for proving that a statement is true for every natural number',
  };
  const msg = buildUserMessage(task, stale);
  assert.match(msg, /^Search query: "porn"$/m);
  assert.doesNotMatch(msg, /induction/i);
});

test('buildUserMessage has no search query line for other pages', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=x',
    'https://github.com/search?q=linked+list',
    'https://www.google.com/maps?q=coffee',
    'https://www.google.com/',
    'https://www.google.com/search',
    'https://docs.google.com/document/d/x',
  ]) {
    const msg = buildUserMessage(task, { url, title: 'Some page' });
    assert.ok(!msg.includes('Search query'), url);
    assert.ok(msg.includes(`URL: ${url}`), url);
  }
});

test('SYSTEM_PROMPT tells the judge to judge what was searched for, not the engine', () => {
  assert.match(SYSTEM_PROMPT, /search results page/);
  assert.match(SYSTEM_PROMPT, /judge what the user searched for, never the search engine/);
});

test('the redacted message for a sensitive search page never includes the query', () => {
  const secret = { ...searchPage, url: 'https://www.google.com/search?q=secret+diagnosis+xyz', title: 'secret diagnosis xyz - Google Search', redacted: true };
  const msg = buildUserMessage(task, secret);
  assert.ok(msg.includes(REDACTED_PAGE_NOTICE));
  for (const leak of ['secret', 'diagnosis', 'Search query', 'google', 'URL:']) assert.ok(!msg.includes(leak), `leaked ${leak}`);
});

test('judgePage sends a sensitive search page as the notice only, with no query', async () => {
  const calls = mockFetch(() => ({ json: { choices: [{ message: { content: '{"category":"slack","reason":"r","nudge":"Go."}' } }] } }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'deepseek', configs: { deepseek: { apiKey: 'k' } } } }));
  await judgePage({ config, task, page: { url: 'https://www.google.com/search?q=secret+diagnosis+xyz', title: 'secret diagnosis xyz', sensitive: true } });
  const sent = JSON.stringify(calls[0].body);
  assert.ok(sent.includes('Page information blocked'));
  for (const leak of ['secret', 'diagnosis', 'Search query', 'google.com/search']) assert.ok(!sent.includes(leak), `leaked ${leak}`);
});

test('judgePage sends the search query line for a normal search page', async () => {
  const calls = mockFetch(() => ({ json: { choices: [{ message: { content: '{"category":"work","reason":"Docs.","nudge":""}' } }] } }));
  const config = aiConfig(mergeSettings({ ai: { provider: 'deepseek', configs: { deepseek: { apiKey: 'k' } } } }));
  await judgePage({ config, task, page: searchPage });
  assert.match(calls[0].body.messages[1].content, /Search query: "c\+\+ linked list docs"/);
  assert.match(calls[0].body.messages[0].content, /judge what the user searched for/);
});
