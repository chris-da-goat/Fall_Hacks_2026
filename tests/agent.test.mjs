import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, buildAgentSystem, cleanHistory } from '../extension/lib/agent.js';
import { AIError } from '../extension/lib/ai.js';
import { aiConfig, mergeSettings } from '../extension/lib/defaults.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replaces fetch with a scripted server. `responses` is a list consumed in order, or a
// function (call, n) => response. Each response is { status?, json }.
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url, method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    const r = typeof responses === 'function' ? responses(call, calls.length) : responses[calls.length - 1];
    if (!r) throw new Error(`Unexpected request #${calls.length} to ${url}`);
    const { status = 200, json } = r;
    return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(json) };
  };
  return calls;
}

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

// A tool spec that records the input of every run() call.
function fakeTool(name, impl = () => ({ ok: true }), extra = {}) {
  const runs = [];
  return {
    name,
    description: `${name} does things`,
    input_schema: SCHEMA,
    run: async (input) => {
      runs.push(input);
      return impl(input);
    },
    runs,
    ...extra,
  };
}

const deepseekConfig = () => aiConfig(mergeSettings({ ai: { provider: 'deepseek', configs: { deepseek: { apiKey: 'k' } } } }));
const anthropicConfig = (model) =>
  aiConfig(mergeSettings({ ai: { provider: 'anthropic', configs: { anthropic: { apiKey: 'sk-ant', ...(model ? { model } : {}) } } } }));
const SYSTEM = 'You are Hackie (test system prompt).';

// Chat Completions fixtures.
const fnCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const ccToolCalls = (toolCalls, extra = {}) => ({
  json: { model: 'deepseek-flash', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: toolCalls, ...extra } }] },
});
const ccAnswer = (content) => ({ json: { model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] } });

// Anthropic Messages fixtures.
const msgToolUse = (content) => ({ json: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content } });
const msgEnd = (...texts) => ({ json: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: texts.map((text) => ({ type: 'text', text })) } });

// ---------------------------------------------------------------------------
// OpenAI-compatible (Chat Completions)

test('OpenAI-compatible: runs tool_calls, echoes them back without reasoning_content, returns the answer', async () => {
  const history = [
    { role: 'assistant', text: 'Leading greeting that should be dropped' },
    { role: 'user', text: 'How was yesterday?' },
    { role: 'assistant', text: 'Dreadful.' },
  ];
  const historyTool = fakeTool('get_history', ({ days }) => ({ days, slackSec: 7200 }));
  const summaryTool = fakeTool('get_today_summary', () => 'plain string result');
  const toolCalls = [fnCall('call_1', 'get_history', { days: 3 }), fnCall('call_2', 'get_today_summary', {})];
  const calls = mockFetch([ccToolCalls(toolCalls, { reasoning_content: 'The user wants history, so call get_history.' }), ccAnswer('You slacked 2 hours, recruit.')]);
  const ac = new AbortController();

  const result = await runAgent({
    config: deepseekConfig(),
    system: SYSTEM,
    history,
    question: '  How much did I slack this week?  ',
    tools: [historyTool, summaryTool],
    signal: ac.signal,
  });

  assert.equal(result.answer, 'You slacked 2 hours, recruit.');
  assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(historyTool.runs, [{ days: 3 }], 'run() gets the parsed JSON arguments');
  assert.deepEqual(summaryTool.runs, [{}]);
  assert.deepEqual(result.steps, [
    { tool: 'get_history', input: { days: 3 }, ok: true },
    { tool: 'get_today_summary', input: {}, ok: true },
  ]);

  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.equal(first.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.ok(first.url.endsWith('/chat/completions'));
  assert.equal(first.method, 'POST');
  assert.equal(first.headers.authorization, 'Bearer k');
  assert.equal(first.headers['content-type'], 'application/json');
  assert.equal(first.headers['x-api-key'], undefined);
  // fetch gets the caller's signal combined with a request time limit; aborting the caller aborts it.
  assert.ok(first.signal && !first.signal.aborted, 'a signal is passed to fetch');
  ac.abort();
  assert.ok(first.signal.aborted, "aborting the caller's signal aborts the request");
  assert.equal(first.body.model, 'deepseek-flash');
  assert.equal(first.body.tool_choice, 'auto');
  assert.deepEqual(first.body.tools, [
    { type: 'function', function: { name: 'get_history', description: 'get_history does things', parameters: SCHEMA } },
    { type: 'function', function: { name: 'get_today_summary', description: 'get_today_summary does things', parameters: SCHEMA } },
  ]);
  assert.deepEqual(first.body.messages, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'How was yesterday?' },
    { role: 'assistant', content: 'Dreadful.' },
    { role: 'user', content: 'How much did I slack this week?' },
  ]);

  const msgs = second.body.messages;
  assert.equal(msgs.length, 7);
  assert.deepEqual(msgs.slice(0, 4), first.body.messages, 'the conversation so far is resent');
  const assistant = msgs[4];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.tool_calls, toolCalls);
  assert.equal('reasoning_content' in assistant, false, 'reasoning_content is not echoed back');
  assert.deepEqual(msgs[5], { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ days: 3, slackSec: 7200 }) });
  assert.deepEqual(msgs[6], { role: 'tool', tool_call_id: 'call_2', content: 'plain string result' }, 'string results are sent as-is');
  assert.deepEqual(second.body.tools, first.body.tools);
  assert.equal(second.body.tool_choice, 'auto');
});

test('OpenAI-compatible: answer given as content parts is joined', async () => {
  mockFetch([ccAnswer([{ type: 'text', text: 'Back ' }, { type: 'text', text: 'to work.' }])]);
  const result = await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'hi', tools: [] });
  assert.equal(result.answer, 'Back to work.');
  assert.deepEqual(result.steps, []);
});

test('OpenAI-compatible: a tool that throws is reported in the tool message and the loop continues', async () => {
  const broken = fakeTool('get_today_summary', () => {
    throw new Error('storage unavailable');
  });
  const calls = mockFetch([ccToolCalls([fnCall('call_9', 'get_today_summary', {})]), ccAnswer('Hackie could not read your data.')]);
  const result = await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'How am I doing?', tools: [broken] });

  assert.equal(result.answer, 'Hackie could not read your data.');
  assert.deepEqual(result.steps, [{ tool: 'get_today_summary', input: {}, ok: false }]);
  const toolMsg = calls[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_9');
  assert.match(toolMsg.content, /storage unavailable/);
  assert.deepEqual(JSON.parse(toolMsg.content), { error: 'storage unavailable' });
});

test('OpenAI-compatible: unknown tool names and malformed arguments do not crash the loop', async () => {
  const historyTool = fakeTool('get_history');
  const calls = mockFetch([
    ccToolCalls([fnCall('c1', 'delete_everything', { really: true }), fnCall('c2', 'get_history', '{not json')]),
    ccAnswer('Nice try.'),
  ]);
  const result = await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'Wipe it', tools: [historyTool] });

  assert.equal(result.answer, 'Nice try.');
  assert.deepEqual(historyTool.runs, [{}], 'unparseable arguments become {}');
  assert.deepEqual(result.steps, [
    { tool: 'delete_everything', input: { really: true }, ok: false },
    { tool: 'get_history', input: {}, ok: true },
  ]);
  const toolMsgs = calls[1].body.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, 'c1');
  assert.match(JSON.parse(toolMsgs[0].content).error, /Unknown tool "delete_everything"/);
  assert.equal(toolMsgs[1].tool_call_id, 'c2');
});

test('OpenAI-compatible: long tool results are truncated', async () => {
  const big = fakeTool('get_debug_log', () => 'x'.repeat(7000));
  const calls = mockFetch([ccToolCalls([fnCall('c1', 'get_debug_log', { limit: 50 })]), ccAnswer('ok')]);
  await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'Why?', tools: [big] });
  const toolMsg = calls[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content, `${'x'.repeat(6000)}…(truncated)`);
});

test('OpenAI-compatible: running out of turns returns the "ran out of steps" answer', async () => {
  const historyTool = fakeTool('get_history');
  let id = 0;
  const calls = mockFetch(() => ccToolCalls([fnCall(`c${++id}`, 'get_history', { days: 1 })]));
  const result = await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'Loop forever', tools: [historyTool], maxTurns: 3 });

  assert.match(result.answer, /ran out of steps/);
  assert.equal(calls.length, 3);
  assert.equal(historyTool.runs.length, 3);
  assert.equal(result.steps.length, 3);
  assert.equal(result.model, 'deepseek-flash');
});

test('OpenAI-compatible: an empty answer gets a placeholder', async () => {
  mockFetch([ccAnswer('   ')]);
  const result = await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'hi' });
  assert.equal(result.answer, '(Hackie had nothing to say.)');
});

// ---------------------------------------------------------------------------
// Toolless fallback

test('Toolless fallback: a 400 on the first request runs only the read-only tools and answers from a snapshot', async () => {
  const activity = fakeTool('get_current_activity', () => ({ site: 'youtube.com', category: 'slack' }), { readOnly: true });
  const historyTool = fakeTool('get_history', ({ days }) => ({ days, marker: 'HISTORY-OUTPUT' }), { readOnly: true, defaultInput: { days: 7 } });
  const markSite = fakeTool('mark_site', () => ({ ok: true }));
  const takeBreak = fakeTool('take_break', () => ({ ok: true }), { readOnly: false });
  const calls = mockFetch([{ status: 400, json: { error: { message: 'tools are not supported' } } }, ccAnswer('You are on YouTube. Again.')]);

  const result = await runAgent({
    config: deepseekConfig(),
    system: SYSTEM,
    history: [
      { role: 'user', text: 'Earlier question' },
      { role: 'assistant', text: 'Earlier answer' },
    ],
    question: 'What am I doing?',
    tools: [activity, historyTool, markSite, takeBreak],
  });

  assert.equal(result.answer, 'You are on YouTube. Again.');
  assert.deepEqual(activity.runs, [{}]);
  assert.deepEqual(historyTool.runs, [{ days: 7 }], 'defaultInput is used');
  assert.deepEqual(markSite.runs, [], 'non-read-only tools are not executed');
  assert.deepEqual(takeBreak.runs, []);
  assert.deepEqual(result.steps, [
    { tool: 'get_current_activity', input: {}, ok: true },
    { tool: 'get_history', input: { days: 7 }, ok: true },
  ]);

  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.tools, 'the first request offered tools');
  const retry = calls[1];
  assert.equal(retry.url, calls[0].url);
  assert.equal(retry.headers.authorization, 'Bearer k');
  assert.equal(retry.body.tools, undefined);
  assert.equal(retry.body.tool_choice, undefined);
  assert.equal(retry.body.model, 'deepseek-flash');
  const [sys, ...rest] = retry.body.messages;
  assert.equal(sys.role, 'system');
  assert.ok(sys.content.startsWith(SYSTEM));
  assert.match(sys.content, /<get_current_activity>\n\{"site":"youtube\.com","category":"slack"\}\n<\/get_current_activity>/);
  assert.match(sys.content, /<get_history>\n.*HISTORY-OUTPUT.*\n<\/get_history>/);
  assert.doesNotMatch(sys.content, /mark_site|take_break/);
  assert.deepEqual(rest, [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'What am I doing?' },
  ]);
  assert.equal(rest.some((m) => m.role === 'tool' || m.tool_calls), false);
});

test('Toolless fallback: also triggers on 422, and works for a keyless local server', async () => {
  const activity = fakeTool('get_current_activity', () => ({ site: 'github.com' }), { readOnly: true });
  const calls = mockFetch([{ status: 422, json: {} }, ccAnswer('Working. Good.')]);
  const config = aiConfig(mergeSettings({ ai: { provider: 'custom', configs: { custom: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3' } } } }));
  const result = await runAgent({ config, system: SYSTEM, question: 'Status?', tools: [activity] });

  assert.equal(result.answer, 'Working. Good.');
  assert.equal(result.model, 'deepseek-flash', 'model comes from the response when present');
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, undefined, 'no key, no auth header');
  assert.equal(calls[1].body.tools, undefined);
  assert.match(calls[1].body.messages[0].content, /github\.com/);
});

test('Toolless fallback only applies to the first request; later 400s are errors', async () => {
  const historyTool = fakeTool('get_history', () => ({}), { readOnly: true });
  const calls = mockFetch([ccToolCalls([fnCall('c1', 'get_history', { days: 2 })]), { status: 400, json: { error: { message: 'bad tool message' } } }]);
  await assert.rejects(runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'q', tools: [historyTool] }), {
    name: 'AIError',
    status: 400,
    message: /DeepSeek: HTTP 400\. bad tool message/,
  });
  assert.equal(calls.length, 2);
});

test('OpenAI-compatible: other HTTP errors reject with the provider name', async () => {
  mockFetch([{ status: 401, json: { error: { message: 'Invalid key' } } }]);
  await assert.rejects(runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'q', tools: [] }), {
    name: 'AIError',
    status: 401,
    message: /DeepSeek: API key was rejected\. Invalid key/,
  });
});

// ---------------------------------------------------------------------------
// Anthropic (Messages API)

test('Anthropic: tool_use round trip passes the content back unchanged and joins the final text', async () => {
  const historyTool = fakeTool('get_history', ({ days }) => ({ days, workSec: 3600 }));
  const firstContent = [
    { type: 'thinking', thinking: 'They want history. I will call get_history.', signature: 'sig-abc' },
    { type: 'text', text: 'Let me check your record.' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_history', input: { days: 2 } },
  ];
  const calls = mockFetch([
    msgToolUse(firstContent),
    { json: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden', signature: 's2' }, { type: 'text', text: 'Line one.' }, { type: 'text', text: 'Line two.' }] } },
  ]);

  const result = await runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'How did I do?', tools: [historyTool] });

  assert.equal(result.answer, 'Line one.\nLine two.');
  assert.equal(result.model, 'claude-opus-5-5');
  assert.deepEqual(historyTool.runs, [{ days: 2 }]);
  assert.deepEqual(result.steps, [{ tool: 'get_history', input: { days: 2 }, ok: true }]);

  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.equal(first.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(first.headers['x-api-key'], 'sk-ant');
  assert.equal(first.headers['anthropic-version'], '2026-10-21');
  assert.equal(first.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(first.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(first.headers['content-type'], 'application/json');
  assert.equal(first.headers.authorization, undefined);
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.deepEqual(first.body.output_config, { effort: 'low' });
  assert.equal(first.body.system, SYSTEM);
  assert.equal(typeof first.body.max_tokens, 'number');
  assert.deepEqual(first.body.tools, [{ name: 'get_history', description: 'get_history does things', input_schema: SCHEMA }]);
  assert.deepEqual(first.body.messages, [{ role: 'user', content: 'How did I do?' }]);

  assert.deepEqual(second.body.messages, [
    { role: 'user', content: 'How did I do?' },
    { role: 'assistant', content: firstContent },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify({ days: 2, workSec: 3600 }) }] },
  ]);
  assert.equal(second.body.fallbacks, 'default');
  assert.deepEqual(second.body.output_config, { effort: 'low' });
  assert.equal(second.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('Anthropic: history is sent as plain text turns before the question', async () => {
  const calls = mockFetch([msgEnd('Hup!')]);
  await runAgent({
    config: anthropicConfig(),
    system: SYSTEM,
    history: [
      { role: 'user', text: 'Hi Hackie' },
      { role: 'assistant', text: 'Drop and give me twenty.' },
      { role: 'user', text: 'unanswered' },
    ],
    question: 'Again?',
  });
  assert.deepEqual(calls[0].body.messages, [
    { role: 'user', content: 'Hi Hackie' },
    { role: 'assistant', content: 'Drop and give me twenty.' },
    { role: 'user', content: 'Again?' },
  ]);
});

test('Anthropic: models without server-side fallback get no fallbacks parameter or beta header', async () => {
  const calls = mockFetch([msgEnd('ok')]);
  await runAgent({ config: anthropicConfig('claude-haiku-5-5'), system: SYSTEM, question: 'q' });
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.equal(calls[0].body.fallbacks, undefined);
  assert.equal(calls[0].headers['anthropic-beta'], undefined);
  assert.deepEqual(calls[0].body.output_config, { effort: 'low' });
});

test('Anthropic: a tool that throws yields an is_error tool_result and the loop continues', async () => {
  const broken = fakeTool('get_today_summary', () => {
    throw new Error('storage unavailable');
  });
  const ok = fakeTool('get_settings', () => ({ task: 'Essay' }));
  const calls = mockFetch([
    msgToolUse([
      { type: 'tool_use', id: 'toolu_a', name: 'get_today_summary', input: {} },
      { type: 'tool_use', id: 'toolu_b', name: 'get_settings', input: {} },
    ]),
    msgEnd('Your data is unavailable, but your task is the essay.'),
  ]);
  const result = await runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'Report', tools: [broken, ok] });

  assert.equal(result.answer, 'Your data is unavailable, but your task is the essay.');
  assert.deepEqual(result.steps, [
    { tool: 'get_today_summary', input: {}, ok: false },
    { tool: 'get_settings', input: {}, ok: true },
  ]);
  const results = calls[1].body.messages.at(-1).content;
  assert.equal(results.length, 2);
  assert.equal(results[0].type, 'tool_result');
  assert.equal(results[0].tool_use_id, 'toolu_a');
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content, /storage unavailable/);
  assert.deepEqual(results[1], { type: 'tool_result', tool_use_id: 'toolu_b', content: JSON.stringify({ task: 'Essay' }) });
  assert.equal('is_error' in results[1], false);
});

test('Anthropic: an unknown tool name is reported as an error result without crashing', async () => {
  const calls = mockFetch([msgToolUse([{ type: 'tool_use', id: 'toolu_x', name: 'launch_rockets', input: { count: 3 } }]), msgEnd('I cannot do that.')]);
  const result = await runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'Launch', tools: [fakeTool('get_history')] });

  assert.equal(result.answer, 'I cannot do that.');
  assert.deepEqual(result.steps, [{ tool: 'launch_rockets', input: { count: 3 }, ok: false }]);
  const [res] = calls[1].body.messages.at(-1).content;
  assert.equal(res.tool_use_id, 'toolu_x');
  assert.equal(res.is_error, true);
  assert.match(JSON.parse(res.content).error, /Unknown tool "launch_rockets"/);
});

test('Anthropic: running out of turns (default 6) returns the "ran out of steps" answer', async () => {
  const historyTool = fakeTool('get_history');
  let id = 0;
  const calls = mockFetch(() => msgToolUse([{ type: 'tool_use', id: `toolu_${++id}`, name: 'get_history', input: { days: 1 } }]));
  const result = await runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'Loop', tools: [historyTool] });

  assert.match(result.answer, /ran out of steps/);
  assert.equal(calls.length, 6);
  assert.equal(historyTool.runs.length, 6);
  assert.equal(result.steps.length, 6);
});

test('Anthropic: refusal rejects', async () => {
  mockFetch([{ json: { stop_reason: 'refusal', content: [] } }]);
  await assert.rejects(runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'q', tools: [] }), {
    name: 'AIError',
    message: /Anthropic \(Claude\): declined/,
  });
});

test('Anthropic: a reply with no text gets a placeholder', async () => {
  mockFetch([{ json: { stop_reason: 'end_turn', content: [] } }]);
  const result = await runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'q' });
  assert.equal(result.answer, '(Hackie had nothing to say.)');
  assert.equal(result.model, 'claude-opus-5-5', 'falls back to the configured model');
});

test('Anthropic: HTTP errors reject (429s are retried once first)', async () => {
  const calls = mockFetch([
    { status: 429, json: { error: { message: 'slow down' } } },
    { status: 429, json: { error: { message: 'slow down' } } },
  ]);
  await assert.rejects(runAgent({ config: anthropicConfig(), system: SYSTEM, question: 'q' }), {
    name: 'AIError',
    status: 429,
    retryable: true,
    message: /Rate limited or out of credits\. slow down/,
  });
  assert.equal(calls.length, 2);
});

test('A 503 (provider overloaded) is retried once and then succeeds', async () => {
  const calls = mockFetch([
    { status: 503, json: { error: { message: 'This model is currently experiencing high demand.' } } },
    { json: { choices: [{ message: { content: 'Back to work, recruit.' } }] } },
  ]);
  const config = aiConfig(mergeSettings({ ai: { provider: 'gemini', configs: { gemini: { apiKey: 'AIza-test' } } } }));
  const r = await runAgent({ config, system: SYSTEM, question: 'q' });
  assert.equal(r.answer, 'Back to work, recruit.');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.model, 'gemini-3.5-flash');
  assert.equal(calls[0].body.reasoning_effort, 'low', "Gemini gets reasoning_effort 'low'");
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer AIza-test');
});

test("Gemini's thought signature (extra_content) is sent back with the tool call", async () => {
  const sig = { google: { thought_signature: 'abc123' } };
  const calls = mockFetch([
    { json: { choices: [{ finish_reason: 'tool_calls', message: { content: null, extra_content: sig, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } }] } }] } },
    { json: { choices: [{ message: { content: 'done' } }] } },
  ]);
  const config = aiConfig(mergeSettings({ ai: { provider: 'gemini', configs: { gemini: { apiKey: 'k' } } } }));
  await runAgent({ config, system: SYSTEM, question: 'q', tools: [fakeTool('echo')] });
  const assistant = calls[1].body.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.extra_content, sig);
});

// ---------------------------------------------------------------------------
// Validation

test('Validation: missing key, model, base URL or question rejects before any request', async () => {
  const calls = mockFetch(() => {
    throw new Error('should not be called');
  });
  const noKey = aiConfig(mergeSettings({ ai: { provider: 'anthropic' } }));
  await assert.rejects(runAgent({ config: noKey, system: SYSTEM, question: 'q' }), { name: 'AIError', message: /No API key set/ });

  const noModel = aiConfig(mergeSettings({ ai: { provider: 'openai', configs: { openai: { apiKey: 'k' } } } }));
  assert.equal(noModel.model, '');
  await assert.rejects(runAgent({ config: noModel, system: SYSTEM, question: 'q' }), { name: 'AIError', message: /Pick a model first/ });

  const noBase = aiConfig(mergeSettings({ ai: { provider: 'custom', configs: { custom: { model: 'llama3' } } } }));
  await assert.rejects(runAgent({ config: noBase, system: SYSTEM, question: 'q' }), { name: 'AIError', message: /base URL/ });

  for (const question of ['', '   \n ', undefined, null]) {
    await assert.rejects(runAgent({ config: deepseekConfig(), system: SYSTEM, question }), { name: 'AIError', message: /Ask Hackie something/ });
  }
  await assert.rejects(runAgent({ system: SYSTEM, question: 'q' }), AIError);
  assert.equal(calls.length, 0);
});

test('Validation: long questions are capped at 2000 characters', async () => {
  const calls = mockFetch([ccAnswer('ok')]);
  await runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'q'.repeat(3000) });
  assert.equal(calls[0].body.messages.at(-1).content.length, 2000);
});

test('Network failures reject with a retryable AIError', async () => {
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await assert.rejects(runAgent({ config: deepseekConfig(), system: SYSTEM, question: 'q' }), {
    name: 'AIError',
    retryable: true,
    message: /Network error: getaddrinfo ENOTFOUND/,
  });
});

// ---------------------------------------------------------------------------
// cleanHistory

test('cleanHistory drops leading assistant turns', () => {
  assert.deepEqual(
    cleanHistory([
      { role: 'assistant', text: 'Welcome, recruit.' },
      { role: 'assistant', text: 'Still here?' },
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
    ]),
    [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
    ],
  );
});

test('cleanHistory merges consecutive same-role turns into one (the latest wins)', () => {
  assert.deepEqual(
    cleanHistory([
      { role: 'user', text: 'first try' },
      { role: 'user', text: 'second try' },
      { role: 'assistant', text: 'a1' },
      { role: 'assistant', text: 'a1 again' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ]),
    [
      { role: 'user', text: 'second try' },
      { role: 'assistant', text: 'a1 again' },
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
    ],
  );
});

test('cleanHistory drops a trailing user turn', () => {
  assert.deepEqual(
    cleanHistory([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'unanswered' },
    ]),
    [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
    ],
  );
  assert.deepEqual(cleanHistory([{ role: 'user', text: 'only' }]), []);
});

test('cleanHistory respects the limit and still starts with a user turn', () => {
  const history = [];
  for (let i = 1; i <= 10; i++) history.push({ role: 'user', text: `q${i}` }, { role: 'assistant', text: `a${i}` });

  const def = cleanHistory(history);
  assert.equal(def.length, 8, 'default limit is 8');
  assert.deepEqual(def[0], { role: 'user', text: 'q7' });
  assert.deepEqual(def.at(-1), { role: 'assistant', text: 'a10' });

  const four = cleanHistory(history, 4);
  assert.deepEqual(four.map((m) => m.text), ['q9', 'a9', 'q10', 'a10']);

  // An odd limit would start on an assistant turn; that turn is dropped instead.
  const three = cleanHistory(history, 3);
  assert.deepEqual(three.map((m) => m.text), ['q10', 'a10']);
  for (const limit of [1, 2, 3, 4, 5, 8]) assert.ok(cleanHistory(history, limit).length <= limit);
});

test('cleanHistory ignores blank, malformed and non-chat messages', () => {
  assert.deepEqual(
    cleanHistory([
      null,
      undefined,
      { role: 'user', text: '   ' },
      { role: 'system', text: 'ignore me' },
      { role: 'tool', text: 'ignore me too' },
      { text: 'no role' },
      { role: 'user' },
      { role: 'user', text: 'real question', at: 123, tools: ['x'] },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: 'real answer' },
    ]),
    [
      { role: 'user', text: 'real question' },
      { role: 'assistant', text: 'real answer' },
    ],
    'extra fields are stripped too',
  );
  assert.deepEqual(cleanHistory(undefined), []);
  assert.deepEqual(cleanHistory([]), []);
});

// ---------------------------------------------------------------------------
// buildAgentSystem

test('buildAgentSystem includes the task title and keywords', () => {
  const now = new Date(2026, 10, 7, 14, 30);
  const s = buildAgentSystem({ task: { title: 'Finish the linked list assignment', keywords: ['c++', 'pointers'] }, now });
  assert.match(s, /"Finish the linked list assignment"/);
  assert.match(s, /keywords: c\+\+, pointers/);
  assert.ok(s.includes(now.toLocaleString()), 'includes the local time');
  assert.doesNotMatch(s, /hasn't set a task/);
  assert.match(s, /get_debug_log/);
});

test('buildAgentSystem omits keywords when there are none', () => {
  const s = buildAgentSystem({ task: { title: 'Write essay', keywords: [] } });
  assert.match(s, /"Write essay"/);
  assert.doesNotMatch(s, /keywords:/);
});

test('buildAgentSystem says there is no task when unset', () => {
  for (const s of [buildAgentSystem(), buildAgentSystem({}), buildAgentSystem({ task: { title: '', keywords: ['x'] } })]) {
    assert.match(s, /hasn't set a task yet/);
    assert.match(s, /You are Hackie/);
  }
});
