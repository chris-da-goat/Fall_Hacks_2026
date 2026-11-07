// Default settings and helpers shared by the service worker, popup and options page.
// Pure module: no chrome.* access at import time, so Node tests can import it.

import { SENSITIVE_DOMAINS } from '../data/sensitive-sites.js';

export const CATEGORIES = ['work', 'slack', 'neutral'];

export const CATEGORY_LABEL = {
  work: 'Work',
  slack: 'Slacking',
  neutral: 'Neutral',
};

// Escalation presets. A threshold of 0 means "never".
export const PRESETS = {
  gentle: { nudgeAfterMin: 10, whipAfterMin: 0, blockAfterMin: 0, repeatEveryMin: 5 },
  normal: { nudgeAfterMin: 5, whipAfterMin: 10, blockAfterMin: 20, repeatEveryMin: 3 },
  drill: { nudgeAfterMin: 2, whipAfterMin: 4, blockAfterMin: 8, repeatEveryMin: 1 },
};

// AI judge providers. `kind` picks the wire format: Anthropic's Messages API, or the
// OpenAI-style Chat Completions API that most other providers (and local servers) speak.
// Model names change often; `models` are only suggestions shown in the options page.
export const AI_PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    keyHint: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    modelHint: 'e.g. gpt-4o-mini',
    models: [],
    keyHint: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    models: ['openrouter/auto'],
    keyHint: 'sk-or-…',
    keysUrl: 'https://openrouter.ai/keys',
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'],
    keyHint: 'sk-…',
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  gemini: {
    // Google's official OpenAI-compatible endpoint (Bearer auth with a Gemini API key).
    label: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Measured 2026-11-07: 3.5 Flash answered in ~1.8 s; newer Flash models were overloaded or
    // slow, and 2.5 Flash is closed to new users. "Load models" lists what a key can use.
    defaultModel: 'gemini-3.5-flash',
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-pro-latest'],
    keyHint: 'AIza…',
    keysUrl: 'https://aistudio.google.com/apikey',
    // Gemini 3 thinks at length by default (a one-word reply took ~47 s); "low" keeps nudges snappy.
    // ("minimal" is rejected by Gemini 3 models.)
    chatExtras: { reasoning_effort: 'low' },
  },
  custom: {
    label: 'Other (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
    modelHint: 'model name',
    models: [],
    keyHint: 'optional for local servers',
    keyOptional: true,
  },
};

// The active provider's settings with provider defaults filled in.
export function aiConfig(settings) {
  const ai = settings?.ai || {};
  const id = AI_PROVIDERS[ai.provider] ? ai.provider : 'anthropic';
  const preset = AI_PROVIDERS[id];
  const own = ai.configs?.[id] || {};
  return {
    provider: id,
    kind: preset.kind,
    label: preset.label,
    apiKey: String(own.apiKey || '').trim(),
    model: String(own.model || '').trim() || preset.defaultModel,
    baseUrl: (String(own.baseUrl || '').trim() || preset.baseUrl).replace(/\/+$/, ''),
    keyOptional: Boolean(preset.keyOptional),
    // Extra Chat Completions fields this provider needs (e.g. Gemini's reasoning_effort).
    chatExtras: { ...(preset.chatExtras || {}) },
  };
}

// True when the active provider has what it needs to make a call (key, model, URL).
// "Ask Hackie" only needs this; the automatic page judge also needs the toggle on.
export function aiConfigured(settings) {
  const c = aiConfig(settings);
  return Boolean(c.model && c.baseUrl && (c.apiKey || c.keyOptional));
}

// True when the AI judge is switched on and has what it needs to make a call.
export function aiReady(settings) {
  return Boolean(settings?.ai?.enabled) && aiConfigured(settings);
}

export const DEFAULT_SETTINGS = {
  version: 1,
  trackingEnabled: true,
  zeroSlack: false, // every slacking page locks down at once (Settings → How strict is Hackie?)
  task: {
    title: '',
    keywords: [],
    url: '',
  },
  workSites: [
    'github.com',
    'gitlab.com',
    'stackoverflow.com',
    'docs.google.com',
    'drive.google.com',
    'developer.mozilla.org',
    'notion.so',
    'figma.com',
    'overleaf.com',
    'leetcode.com',
    'claude.ai',
    'canvas.instructure.com',
  ],
  slackSites: [
    'youtube.com',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'x.com',
    'twitter.com',
    'facebook.com',
    'netflix.com',
    'twitch.tv',
    'pinterest.com',
    'tumblr.com',
    '9gag.com',
    'primevideo.com',
    'disneyplus.com',
    'hulu.com',
  ],
  slackKeywords: [
    'funny',
    'meme',
    'memes',
    'prank',
    'compilation',
    'reaction',
    'fails',
    'try not to laugh',
    'asmr',
    'gameplay',
    'highlights',
    'trailer',
    'unboxing',
    'drama',
    'gossip',
    'shorts',
    'reels',
  ],
  // Sites whose pages are never described to the AI judge (also catches proxies to them).
  // Defaults to the South Korea blocked-sites list; the user can edit it freely.
  sensitiveSites: SENSITIVE_DOMAINS,
  intensity: 'normal',
  thresholds: {
    ...PRESETS.normal,
    streakResetMin: 2,
    snoozeMin: 5,
    dailySlackBudgetMin: 30,
  },
  effects: {
    sound: true,
    shake: true,
    pauseVideo: true,
    timerChip: true,
    blockScreen: true,
  },
  ai: {
    enabled: false,
    provider: 'anthropic',
    // Per-provider { apiKey, model, baseUrl } so switching providers doesn't lose keys.
    configs: {},
    maxCallsPerHour: 30,
    // Per event (nudge, whip, lockdown, beg, "Back to work"), the AI reads the page and Hackie's
    // memory and writes a targeted speech bubble. Needs a configured provider.
    eventMessages: true,
    // What the per-event AI may do to tabs. Closing only happens once the user has begged for
    // more time `closeAfterBegs` times during lockdowns (or Hackie is in full angry-mom mode).
    actions: {
      openTabs: true,
      closeTabs: true,
      closeAfterBegs: 2,
      // When Hackie is angry he can refuse snoozes, begging, breaks, pausing, "It's for my task",
      // dismissing and Reset mood (angry: the AI decides; furious: refused outright).
      overrideClicks: true,
      // After Hackie closes tabs, "Restore" stays locked this many minutes.
      restoreLockMin: 10,
    },
  },
  memory: {
    // Remember slacking habits, work pages, projects and incidents (stored only in this browser).
    enabled: true,
    // Warn sooner on sites that are a known slacking habit.
    habitSensitivity: true,
  },
  debug: {
    // Shows the on-page Hackie debug console (live tracking decisions + Ask Hackie).
    enabled: false,
    // Testing only (needs debug mode): count time even when Chrome isn't focused or the user
    // is idle, so a browser agent can drive a test while the user sits in another app.
    ignoreFocus: false,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge stored settings over defaults so new fields appear after upgrades.
export function mergeSettings(stored) {
  return mergeInto(structuredClone(DEFAULT_SETTINGS), stored || {});
}

function mergeInto(base, extra) {
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      mergeInto(base[key], value);
    } else if (value !== undefined) {
      base[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return base;
}

// "a, b\n c" -> ['a', 'b', 'c']
export function splitList(text) {
  return String(text || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
