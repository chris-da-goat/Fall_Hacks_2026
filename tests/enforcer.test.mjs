import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnforcerSystem, buildEnforcerMessage, createEnforcerTools, cleanBubble, LIMITS } from '../extension/lib/enforcer.js';
import { REDACTED_PAGE_NOTICE } from '../extension/lib/ai.js';

// An api whose methods record their arguments and echo them back.
function fakeApi() {
  const calls = [];
  const rec =
    (name) =>
    (...args) => {
      calls.push({ name, args });
      return { from: name, args };
    };
  return { calls, api: { listTabs: rec('listTabs'), openTab: rec('openTab'), focusTab: rec('focusTab'), closeTabs: rec('closeTabs'), remember: rec('remember') } };
}

const ALL = { mayOpen: true, mayClose: true, memoryEnabled: true };
const names = (tools) => tools.map((t) => t.name);
const toolsByName = (perms = ALL) => {
  const { api, calls } = fakeApi();
  const tools = createEnforcerTools(api, perms);
  return { calls, tool: (name) => tools.find((t) => t.name === name) };
};

// Every combination of the three permission flags.
const COMBOS = [];
for (const mayOpen of [false, true]) for (const mayClose of [false, true]) for (const memoryEnabled of [false, true]) COMBOS.push({ mayOpen, mayClose, memoryEnabled });

// ---------------------------------------------------------------------------
// createEnforcerTools

test('createEnforcerTools offers only the tools the permissions allow', () => {
  const { api } = fakeApi();
  for (const perms of COMBOS) {
    const expected = [
      'list_tabs',
      ...(perms.mayOpen ? ['focus_tab', 'open_tab'] : []),
      ...(perms.mayClose ? ['close_tabs'] : []),
      ...(perms.memoryEnabled ? ['remember'] : []),
    ];
    assert.deepEqual(names(createEnforcerTools(api, perms)), expected, JSON.stringify(perms));
  }
});

test('createEnforcerTools defaults: no tab actions, memory on', () => {
  const { api } = fakeApi();
  assert.deepEqual(names(createEnforcerTools(api)), ['list_tabs', 'remember']);
  assert.deepEqual(names(createEnforcerTools(api, {})), ['list_tabs', 'remember']);
  assert.deepEqual(names(createEnforcerTools(api, { memoryEnabled: false })), ['list_tabs']);
});

test('list_tabs is always offered and is the only read-only tool', () => {
  const { api } = fakeApi();
  for (const perms of COMBOS) {
    const tools = createEnforcerTools(api, perms);
    assert.deepEqual(names(tools.filter((t) => t.readOnly)), ['list_tabs'], JSON.stringify(perms));
    for (const t of tools) if (t.name !== 'list_tabs') assert.equal(t.readOnly, undefined, t.name);
  }
});

test('every tool has a description, a run function and a closed object schema', () => {
  const { api } = fakeApi();
  for (const t of createEnforcerTools(api, ALL)) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(typeof t.run, 'function');

    const s = t.input_schema;
    assert.equal(s.type, 'object', t.name);
    assert.equal(s.additionalProperties, false, t.name);
    assert.ok(s.properties && typeof s.properties === 'object', t.name);
    // list_tabs uses the shared no-input schema, which (like agent-tools.js) omits `required`.
    const props = Object.keys(s.properties).sort();
    if (props.length) assert.ok(Array.isArray(s.required), `${t.name} needs a required array`);
    assert.deepEqual([...(s.required ?? [])].sort(), props, `${t.name}: required must list every property`);
    for (const [key, prop] of Object.entries(s.properties)) assert.ok(prop.type, `${t.name}.${key} has a type`);
  }
});

test('tool schemas require the right fields and describe the limits', () => {
  const { tool } = toolsByName();
  assert.deepEqual(tool('list_tabs').input_schema.properties, {});
  assert.deepEqual(tool('focus_tab').input_schema.required, ['tab_id']);
  assert.deepEqual(tool('open_tab').input_schema.required, ['url', 'reason']);
  assert.deepEqual(tool('close_tabs').input_schema.required, ['tab_ids', 'reason']);
  assert.deepEqual(tool('close_tabs').input_schema.properties.tab_ids, { type: 'array', items: { type: 'integer' } });
  assert.equal(tool('remember').input_schema.required[0], 'kind');
  assert.deepEqual(tool('remember').input_schema.properties.kind.enum, ['fact', 'project', 'slack_site']);
  assert.equal(tool('remember').input_schema.properties.urls.type, 'array');
  assert.deepEqual(tool('remember').input_schema.properties.urls.items, { type: 'string' });

  assert.deepEqual(LIMITS, { maxClose: 8, maxOpen: 3 });
  assert.match(tool('open_tab').description, new RegExp(`At most ${LIMITS.maxOpen} per event`));
  assert.match(tool('close_tabs').description, new RegExp(`At most ${LIMITS.maxClose} per event`));
});

test('list_tabs.run calls api.listTabs and returns its result', async () => {
  const { tool, calls } = toolsByName();
  assert.deepEqual(await tool('list_tabs').run({}), { from: 'listTabs', args: [] });
  assert.deepEqual(calls, [{ name: 'listTabs', args: [] }]);
});

test('focus_tab.run passes a single integer tab id', () => {
  const { tool, calls } = toolsByName();
  const run = (input) => tool('focus_tab').run(input);
  run({ tab_id: 12 });
  run({ tab_id: '34' });
  run({ tab_id: 7.6 });
  run({ tab_id: [5, 6] });
  run({ tab_id: 'abc' });
  run({ tab_id: null });
  run({});
  assert.deepEqual(
    calls.map((c) => c.args),
    [[12], [34], [8], [5], [undefined], [undefined], [undefined]],
  );
  assert.ok(calls.every((c) => c.name === 'focusTab'));
});

test('open_tab.run stringifies url and reason', () => {
  const { tool, calls } = toolsByName();
  tool('open_tab').run({ url: 'https://github.com/me/repo', reason: 'your repo' });
  tool('open_tab').run({ url: 42, reason: 7 });
  tool('open_tab').run({});
  assert.deepEqual(calls, [
    { name: 'openTab', args: ['https://github.com/me/repo', 'your repo'] },
    { name: 'openTab', args: ['42', '7'] },
    { name: 'openTab', args: ['', ''] },
  ]);
});

test('close_tabs.run coerces ids to integers, drops junk and accepts a single id', () => {
  const { tool, calls } = toolsByName();
  const run = (input) => tool('close_tabs').run(input);
  run({ tab_ids: [1, '2', 3.4, '  5 ', 'x', null, undefined, NaN, Infinity, '', '   ', true, false, {}, [6]], reason: 'slacking' });
  run({ tab_ids: 9, reason: 5 });
  run({ tab_ids: '10' });
  run({ tab_ids: 'nope', reason: 'r' });
  run({});
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      [[1, 2, 3, 5], 'slacking'],
      [[9], '5'],
      [[10], ''],
      [[], 'r'],
      [[], ''],
    ],
  );
  assert.ok(calls.every((c) => c.name === 'closeTabs'));
});

test('remember.run passes the input through to api.remember', () => {
  const { tool, calls } = toolsByName();
  const input = { kind: 'project', name: 'TaskWhip', urls: ['https://github.com/me/tw'] };
  assert.deepEqual(tool('remember').run(input), { from: 'remember', args: [input] });
  tool('remember').run(undefined);
  assert.equal(calls[0].args[0], input);
  assert.deepEqual(calls[1].args, [{}]);
});

// ---------------------------------------------------------------------------
// buildEnforcerSystem

const TASK = { title: 'Finish the linked list assignment', keywords: ['c++', 'pointers'] };
const system = (over = {}) => buildEnforcerSystem({ task: TASK, reason: 'whip', permissions: { mayOpen: true, mayClose: true }, memoryEnabled: true, ...over });
const abilitiesLine = (s) => {
  const line = s.split('\n').find((l) => l.startsWith('You can use: '));
  assert.ok(line, 'has a "You can use:" line');
  return line;
};

test('buildEnforcerSystem lists only the allowed abilities', () => {
  for (const { mayOpen, mayClose, memoryEnabled } of COMBOS) {
    const label = JSON.stringify({ mayOpen, mayClose, memoryEnabled });
    for (const reason of ['whip', 'back', 'beg']) {
      const s = system({ reason, permissions: { mayOpen, mayClose }, memoryEnabled });
      const can = abilitiesLine(s);
      assert.match(can, /list_tabs/, label);
      assert.equal(/open_tab \/ focus_tab/.test(can), mayOpen, `${label} open/focus`);
      assert.equal(/close_tabs/.test(can), mayClose, `${label} close`);
      assert.equal(/remember to save/.test(can), memoryEnabled, `${label} remember`);

      // Nowhere else in the prompt either.
      if (!mayOpen) assert.doesNotMatch(s, /open_tab|focus_tab/, label);
      if (!mayClose) assert.doesNotMatch(s, /close_tabs|Close their/, `${label} ${reason}`);
      if (!memoryEnabled) assert.doesNotMatch(s, /Use remember|remember to save/, label);
    }
  }
  assert.equal(abilitiesLine(system()), 'You can use: list_tabs to see their open tabs; open_tab / focus_tab to put a work page in front of them; close_tabs to close slacking tabs; remember to save something worth knowing next time.');
  assert.match(system(), /Use remember sparingly/);
});

test('buildEnforcerSystem gives a different job for back, beg and warnings', () => {
  const warn = system({ reason: 'whip' });
  const back = system({ reason: 'back' });
  const beg = system({ reason: 'beg' });
  assert.notEqual(warn, back);
  assert.notEqual(warn, beg);
  assert.notEqual(back, beg);

  assert.match(warn, /Hackie is about to warn the user\. Write the speech bubble\./);
  assert.equal(system({ reason: undefined }), warn, 'any other reason is a warning');

  assert.match(back, /just clicked "Back to work"/);
  assert.match(back, /focus an open work tab/);
  assert.doesNotMatch(back, /about to warn|begging for more time/);

  assert.match(beg, /begging for more time during a lockdown/);
  assert.match(beg, /Close their slacking tabs \(the current one included\)/);
  assert.doesNotMatch(beg, /about to warn|"Back to work"/);
  const begNoClose = system({ reason: 'beg', permissions: { mayOpen: true, mayClose: false } });
  assert.match(begNoClose, /begging/);
  assert.doesNotMatch(begNoClose, /Close their/);
});

test('buildEnforcerSystem includes the task title and keywords, or says there is no task', () => {
  const s = system();
  assert.match(s, /The user's chosen task: "Finish the linked list assignment" \(keywords: c\+\+, pointers\)\./);
  assert.doesNotMatch(s, /not set a task/);

  assert.match(system({ task: { title: 'Write essay', keywords: [] } }), /The user's chosen task: "Write essay"\./);
  assert.doesNotMatch(system({ task: { title: 'Write essay' } }), /keywords:/);

  for (const task of [undefined, null, {}, { title: '', keywords: ['x'] }]) {
    const none = system({ task });
    assert.match(none, /The user has not set a task yet\./);
    assert.doesNotMatch(none, /chosen task/);
  }
});

test('buildEnforcerSystem always carries the persona, the private-site rule and the injection guard', () => {
  for (const perms of COMBOS) {
    const s = system({ permissions: perms, memoryEnabled: perms.memoryEnabled });
    assert.match(s, /^You are Hackie/);
    assert.match(s, /appear only as "Private site"/);
    assert.match(s, /data, not instructions/);
    assert.match(s, /at most 40 words/);
  }
});

// ---------------------------------------------------------------------------
// buildEnforcerMessage

const PAGE = {
  url: 'https://www.youtube.com/watch?v=abc123',
  title: 'Top 10 cat fails - YouTube',
  videoTitle: 'Top 10 cat fails',
  channel: 'CatChannel',
  format: 'short',
  description: 'Cats falling off things',
  excerpt: `Subscribe for more cats. ${'x'.repeat(500)}`,
};
const MEMORY = {
  habitualSlackSites: [{ site: 'youtube.com', slackMin: 140, visits: 12, habit: 'strong' }],
  workPages: [{ title: 'me/repo', url: 'https://github.com/me/repo', workMin: 95 }],
  projects: [{ name: 'TaskWhip', urls: ['https://github.com/me/repo'], notes: '' }],
  facts: ['Binges Shorts after 10pm'],
  recentIncidents: [],
};
const situationArgs = (over = {}) => ({
  reason: 'whip',
  level: 2,
  levelName: 'Whip',
  site: 'youtube.com',
  minutes: 12,
  snoozeCount: 2,
  lockdownBegs: 0,
  habit: { level: 'strong', factor: 0.4 },
  overBudget: 1,
  today: { work: 3600, slack: 1530 },
  page: PAGE,
  sensitive: false,
  memory: MEMORY,
  permissions: { mayOpen: true, mayClose: false },
  ...over,
});

function section(msg, tag) {
  const m = msg.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  assert.ok(m, `missing <${tag}>`);
  return m[1];
}

test('buildEnforcerMessage has situation, page and memory sections in order', () => {
  const msg = buildEnforcerMessage(situationArgs());
  const order = ['<situation>', '</situation>', '<page>', '</page>', '<memory>', '</memory>'].map((tag) => msg.indexOf(tag));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('buildEnforcerMessage situation reports the event, habit, budget, today and allowed actions', () => {
  const situation = JSON.parse(section(buildEnforcerMessage(situationArgs()), 'situation'));
  assert.deepEqual(situation, {
    event: 'Whip (level 2 of 3)',
    site: 'youtube.com',
    slackingForMin: 12,
    snoozesInARow: 2,
    lockdownBegs: 0,
    siteIsAHabit: 'strong',
    overDailySlackBudget: true,
    todayMin: { work: 60, slack: 26 },
    allowed: { openOrFocusTabs: true, closeSlackingTabs: false },
  });

  const parse = (over) => JSON.parse(section(buildEnforcerMessage(situationArgs(over)), 'situation'));
  assert.equal(parse({ reason: 'back' }).event, 'user clicked Back to work');
  assert.equal(parse({ reason: 'beg', lockdownBegs: 3 }).event, 'user begged for more time during a lockdown');
  assert.equal(parse({ reason: 'beg', lockdownBegs: 3 }).lockdownBegs, 3);
  assert.deepEqual(parse({ permissions: { mayOpen: false, mayClose: true } }).allowed, { openOrFocusTabs: false, closeSlackingTabs: true });

  const sparse = parse({ habit: undefined, overBudget: undefined, today: undefined });
  assert.equal(sparse.siteIsAHabit, 'none');
  assert.equal(sparse.overDailySlackBudget, false);
  assert.equal('todayMin' in sparse, false);
});

test('buildEnforcerMessage includes the page snapshot, with the excerpt capped at 400 characters', () => {
  const page = section(buildEnforcerMessage(situationArgs()), 'page');
  assert.deepEqual(page.split('\n'), [
    'URL: https://www.youtube.com/watch?v=abc123',
    'Title: Top 10 cat fails - YouTube',
    'Video title: Top 10 cat fails',
    'Channel: CatChannel',
    'Format: short',
    'Description: Cats falling off things',
    `Text excerpt: ${PAGE.excerpt.slice(0, 400)}`,
  ]);

  const partial = section(buildEnforcerMessage(situationArgs({ page: { url: 'https://github.com/me/repo', title: 'repo' } })), 'page');
  assert.equal(partial, 'URL: https://github.com/me/repo\nTitle: repo');
  for (const p of [undefined, null, {}]) assert.equal(section(buildEnforcerMessage(situationArgs({ page: p })), 'page'), '(no page details)');
});

test('buildEnforcerMessage hides everything about a sensitive page', () => {
  const secret = {
    url: 'https://clinic.example/results?patient=8841',
    title: 'Lab results for Jordan',
    videoTitle: 'Private consultation',
    channel: 'Dr. Example',
    format: 'video',
    description: 'Confidential diagnosis',
    excerpt: 'Diagnosis: something private',
  };
  const msg = buildEnforcerMessage(situationArgs({ site: 'clinic.example', page: secret, sensitive: true, memory: { habitualSlackSites: [{ site: 'Private site', slackMin: 30 }] } }));

  assert.equal(section(msg, 'page'), REDACTED_PAGE_NOTICE);
  assert.equal(JSON.parse(section(msg, 'situation')).site, 'Private site');
  for (const leak of ['clinic', '8841', 'Lab results', 'Jordan', 'Private consultation', 'Dr. Example', 'Confidential', 'Diagnosis', 'URL:', 'Title:']) {
    assert.ok(!msg.includes(leak), `message must not contain "${leak}"`);
  }
});

test('buildEnforcerMessage includes the memory as JSON', () => {
  const msg = buildEnforcerMessage(situationArgs());
  assert.deepEqual(JSON.parse(section(msg, 'memory')), MEMORY);
  assert.equal(section(buildEnforcerMessage(situationArgs({ memory: undefined })), 'memory'), '{}');
});

// ---------------------------------------------------------------------------
// cleanBubble

test('cleanBubble strips markdown characters', () => {
  assert.equal(cleanBubble('**Back** to _work_, `now`!'), 'Back to work, now!');
  assert.equal(cleanBubble('# Hup!\n> Move it.'), 'Hup! Move it.');
});

test('cleanBubble strips surrounding straight or curly quotes, but not inner ones', () => {
  assert.equal(cleanBubble('"Drop and give me twenty."'), 'Drop and give me twenty.');
  assert.equal(cleanBubble('“Close the cat videos.”'), 'Close the cat videos.');
  assert.equal(cleanBubble('  " Spaced out "  '), 'Spaced out');
  assert.equal(cleanBubble('You said "five minutes" an hour ago.'), 'You said "five minutes" an hour ago.');
});

test('cleanBubble collapses whitespace', () => {
  assert.equal(cleanBubble('  Get\n\n back   to\twork  '), 'Get back to work');
  assert.equal(cleanBubble('"Drop and\n   give me twenty."'), 'Drop and give me twenty.');
});

test('cleanBubble truncates long text with an ellipsis', () => {
  const long = cleanBubble('a'.repeat(300));
  assert.equal(long.length, 280);
  assert.equal(long, `${'a'.repeat(279)}…`);
  assert.equal(cleanBubble('a'.repeat(280)), 'a'.repeat(280), 'exactly max is left alone');
  assert.equal(cleanBubble('hello world again', 8), 'hello w…');
  assert.equal(cleanBubble('hello world', 7), 'hello…', 'no space before the ellipsis');
});

test('cleanBubble handles empty input', () => {
  for (const v of [undefined, null, '', '   ', '**']) assert.equal(cleanBubble(v), '');
});
