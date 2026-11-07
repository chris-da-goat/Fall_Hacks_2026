// Tools Hackie's agent can call. The service worker supplies `api` (the implementations), so
// this module stays pure and testable. Read-only tools are also used to build a snapshot for
// providers that can't call tools.

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

function clampInt(v, min, max, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function createAgentTools(api) {
  return [
    {
      name: 'get_current_activity',
      description:
        'What the user is looking at right now: the site and page title, whether Hackie counts it as work, slack or neutral and why, whether time is being tracked at all, the current slack streak in seconds, the warning level (0 none, 1 nudge, 2 whip, 3 lockdown) and when the next warning is due.',
      input_schema: NO_INPUT,
      readOnly: true,
      run: () => api.currentActivity(),
    },
    {
      name: 'get_today_summary',
      description:
        "Today's totals in seconds (work, slack, neutral), the focus score (percent of work out of work + slack), the daily slack budget, Hackie's events today (nudges, whips, lockdowns, snoozes, comebacks) and the top sites with time per category.",
      input_schema: NO_INPUT,
      readOnly: true,
      run: () => api.todaySummary(),
    },
    {
      name: 'get_history',
      description: 'Daily totals in seconds for the last N days (oldest first), plus the top work and slacking sites over that period.',
      input_schema: {
        type: 'object',
        properties: { days: { type: 'integer', description: 'How many days, 1 to 14.' } },
        required: ['days'],
        additionalProperties: false,
      },
      readOnly: true,
      defaultInput: { days: 7 },
      run: ({ days }) => api.history(clampInt(days, 1, 14, 7)),
    },
    {
      name: 'get_settings',
      description:
        "The user's task and keywords, work and slacking site lists, slacking keywords, escalation thresholds in minutes, effects, and which AI provider and model are set. API keys are never included.",
      input_schema: NO_INPUT,
      readOnly: true,
      run: () => api.settingsSummary(),
    },
    {
      name: 'get_debug_log',
      description:
        "Hackie's most recent tracking decisions, newest first. Each has the trigger, whether Chrome's window was focused, the idle state, whether media was playing, whether the page was tracked, its category and source, the slack streak, the warning level, whether a warning fired, and a plain-English 'why'. Use it to explain why Hackie is or isn't tracking or reacting.",
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'How many decisions, 1 to 50.' } },
        required: ['limit'],
        additionalProperties: false,
      },
      readOnly: true,
      defaultInput: { limit: 12 },
      run: ({ limit }) => api.debugLog(clampInt(limit, 1, 50, 12)),
    },
    {
      name: 'get_memory',
      description:
        "What Hackie remembers about the user across days: their habitual slacking sites (with minutes and habit level), the work pages they actually use, their projects, facts learned about them, and recent incidents (lockdowns, begging, tabs Hackie closed).",
      input_schema: NO_INPUT,
      readOnly: true,
      run: () => api.memory(),
    },
    {
      name: 'remember',
      description:
        "Save something to Hackie's memory when the user tells you about their work or asks you to remember it. kind 'project' (name + links), 'fact' (a short note), or 'slack_site' (flag a domain as a slacking habit so warnings come sooner).",
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'project', 'slack_site'] },
          text: { type: 'string', description: "For 'fact': the note. For 'project': notes. Otherwise ''." },
          name: { type: 'string', description: "For 'project': its name. Otherwise ''." },
          urls: { type: 'array', items: { type: 'string' }, description: "For 'project': its links. Otherwise []." },
          domain: { type: 'string', description: "For 'slack_site': e.g. 'reddit.com'. Otherwise ''." },
        },
        required: ['kind', 'text', 'name', 'urls', 'domain'],
        additionalProperties: false,
      },
      run: (input) => api.remember(input || {}),
    },
    {
      name: 'mark_site',
      description: 'Change how a whole site is classified from now on. Only use when the user explicitly asks.',
      input_schema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Bare domain, e.g. "youtube.com".' },
          category: { type: 'string', enum: ['work', 'slack', 'neutral'] },
        },
        required: ['domain', 'category'],
        additionalProperties: false,
      },
      run: ({ domain, category }) => api.markSite(String(domain || ''), category),
    },
    {
      name: 'take_break',
      description: "Start a break (minutes > 0) during which Hackie won't nag, or end the current break (minutes = 0). Only use when the user explicitly asks.",
      input_schema: {
        type: 'object',
        properties: { minutes: { type: 'integer', description: '0 to 120.' } },
        required: ['minutes'],
        additionalProperties: false,
      },
      run: ({ minutes }) => api.takeBreak(clampInt(minutes, 0, 120, 0)),
    },
  ];
}
