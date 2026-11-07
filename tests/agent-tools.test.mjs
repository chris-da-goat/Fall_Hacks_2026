import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from '../extension/lib/agent-tools.js';

// A fake service-worker api that records every call and returns a tagged result.
function fakeApi() {
  const calls = [];
  const method = (name) => (...args) => {
    calls.push([name, ...args]);
    return { from: name, args };
  };
  const api = {
    currentActivity: method('currentActivity'),
    todaySummary: method('todaySummary'),
    history: method('history'),
    settingsSummary: method('settingsSummary'),
    debugLog: method('debugLog'),
    markSite: method('markSite'),
    takeBreak: method('takeBreak'),
  };
  return { api, calls };
}

function setup() {
  const { api, calls } = fakeApi();
  const tools = createAgentTools(api);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, calls, tool: (name) => byName.get(name) };
}

test('tool names are unique and the expected tools exist', () => {
  const { tools } = setup();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['get_current_activity', 'get_today_summary', 'get_history', 'get_settings', 'get_debug_log', 'mark_site', 'take_break']) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(typeof t.run, 'function');
  }
});

test('every input_schema is a closed object whose required list names every property', () => {
  const { tools } = setup();
  for (const t of tools) {
    const s = t.input_schema;
    assert.equal(s.type, 'object', t.name);
    assert.equal(s.additionalProperties, false, t.name);
    assert.ok(s.properties && typeof s.properties === 'object', t.name);
    const props = Object.keys(s.properties).sort();
    assert.deepEqual([...(s.required ?? [])].sort(), props, `${t.name}: required must list every property`);
    for (const [key, prop] of Object.entries(s.properties)) assert.ok(prop.type, `${t.name}.${key} has a type`);
  }
});

test('readOnly is true exactly for the get_* tools, and their defaultInput fits the schema', () => {
  const { tools } = setup();
  for (const t of tools) {
    assert.equal(t.readOnly === true, t.name.startsWith('get_'), `${t.name} readOnly`);
    if (!t.name.startsWith('get_')) assert.equal(t.readOnly, undefined);
    if (t.defaultInput) {
      assert.equal(t.readOnly, true, `${t.name}: only read-only tools need a defaultInput`);
      assert.deepEqual(Object.keys(t.defaultInput).sort(), Object.keys(t.input_schema.properties).sort(), `${t.name} defaultInput`);
    } else if (t.readOnly) {
      assert.deepEqual(t.input_schema.properties, {}, `${t.name} takes input, so it needs a defaultInput for the toolless fallback`);
    }
  }
});

test('get_current_activity, get_today_summary and get_settings call their api methods and return the result', async () => {
  const { tool, calls } = setup();
  assert.deepEqual(await tool('get_current_activity').run({}), { from: 'currentActivity', args: [] });
  assert.deepEqual(await tool('get_today_summary').run({}), { from: 'todaySummary', args: [] });
  assert.deepEqual(await tool('get_settings').run({}), { from: 'settingsSummary', args: [] });
  assert.deepEqual(calls, [['currentActivity'], ['todaySummary'], ['settingsSummary']]);
});

test('get_history clamps days to 1..14 and defaults to 7', async () => {
  const { tool, calls } = setup();
  const run = tool('get_history').run;
  const cases = [
    [99, 14],
    [0, 1],
    [-3, 1],
    ['abc', 7],
    [undefined, 7],
    [3, 3],
    ['5', 5],
    [2.6, 3],
  ];
  for (const [days] of cases) await run({ days });
  assert.deepEqual(
    calls.map(([name, days]) => [name, days]),
    cases.map(([, want]) => ['history', want]),
  );
  calls.length = 0;
  await run(tool('get_history').defaultInput);
  assert.deepEqual(calls, [['history', 7]]);
});

test('get_debug_log clamps limit to 1..50 and defaults to 12', async () => {
  const { tool, calls } = setup();
  const run = tool('get_debug_log').run;
  for (const limit of [0, 500, 20, 'lots', undefined]) await run({ limit });
  assert.deepEqual(calls, [
    ['debugLog', 1],
    ['debugLog', 50],
    ['debugLog', 20],
    ['debugLog', 12],
    ['debugLog', 12],
  ]);
  calls.length = 0;
  await run(tool('get_debug_log').defaultInput);
  assert.deepEqual(calls, [['debugLog', 12]]);
});

test('take_break clamps minutes to 0..120', async () => {
  const { tool, calls } = setup();
  const run = tool('take_break').run;
  for (const minutes of [-5, 0, 25, 120, 500, 'later']) await run({ minutes });
  assert.deepEqual(calls, [
    ['takeBreak', 0],
    ['takeBreak', 0],
    ['takeBreak', 25],
    ['takeBreak', 120],
    ['takeBreak', 120],
    ['takeBreak', 0],
  ]);
});

test('mark_site passes domain and category through', async () => {
  const { tool, calls } = setup();
  const result = await tool('mark_site').run({ domain: 'youtube.com', category: 'work' });
  assert.deepEqual(result, { from: 'markSite', args: ['youtube.com', 'work'] });
  await tool('mark_site').run({ domain: 'reddit.com', category: 'slack' });
  await tool('mark_site').run({ category: 'neutral' });
  assert.deepEqual(calls, [
    ['markSite', 'youtube.com', 'work'],
    ['markSite', 'reddit.com', 'slack'],
    ['markSite', '', 'neutral'],
  ]);
  assert.deepEqual(tool('mark_site').input_schema.properties.category.enum, ['work', 'slack', 'neutral']);
});
