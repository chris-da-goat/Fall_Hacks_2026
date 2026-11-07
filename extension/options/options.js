import { mergeSettings, PRESETS, AI_PROVIDERS, aiConfig, splitList, DEFAULT_SETTINGS } from '../lib/defaults.js';
import { SENSITIVE_DOMAINS } from '../data/sensitive-sites.js';
import { formatDuration } from '../lib/stats.js';

const Hackie = globalThis.Hackie;
const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

let settings = mergeSettings();
let lastSavedJson = '';
let saveTimer = 0;
let shownProvider = 'anthropic';

// ---------------------------------------------------------------------------
// Fill / collect

function fill() {
  $('taskTitle').value = settings.task.title || '';
  $('taskKeywords').value = (settings.task.keywords || []).join(', ');
  $('taskUrl').value = settings.task.url || '';
  $('zeroSlack').checked = Boolean(settings.zeroSlack);
  $('workSites').value = settings.workSites.join('\n');
  $('slackSites').value = settings.slackSites.join('\n');
  $('slackKeywords').value = settings.slackKeywords.join(', ');
  $('sensitiveSites').value = settings.sensitiveSites.join('\n');
  updateSensitiveCount();
  document.querySelectorAll('[data-t]').forEach((input) => {
    input.value = settings.thresholds[input.dataset.t];
  });
  document.querySelectorAll('[data-e]').forEach((input) => {
    input.checked = Boolean(settings.effects[input.dataset.e]);
  });
  $('aiEnabled').checked = settings.ai.enabled;
  $('aiMax').value = settings.ai.maxCallsPerHour;
  $('aiEventMessages').checked = Boolean(settings.ai.eventMessages);
  $('aiOpenTabs').checked = Boolean(settings.ai.actions.openTabs);
  $('aiCloseTabs').checked = Boolean(settings.ai.actions.closeTabs);
  $('aiCloseAfterBegs').value = settings.ai.actions.closeAfterBegs;
  $('aiOverride').checked = Boolean(settings.ai.actions.overrideClicks);
  $('aiRestoreLock').value = settings.ai.actions.restoreLockMin;
  $('memoryEnabled').checked = Boolean(settings.memory.enabled);
  $('memoryHabit').checked = Boolean(settings.memory.habitSensitivity);
  $('debugEnabled').checked = Boolean(settings.debug?.enabled);
  $('debugIgnoreFocus').checked = Boolean(settings.debug?.ignoreFocus);
  fillProvider(aiConfig(settings).provider);
  syncPresets();
  syncAi();
}

function num(value, fallback, min = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function collect() {
  settings.task.title = $('taskTitle').value.trim();
  settings.task.keywords = splitList($('taskKeywords').value);
  settings.task.url = $('taskUrl').value.trim();
  settings.zeroSlack = $('zeroSlack').checked;
  settings.workSites = splitList($('workSites').value.replace(/,/g, '\n'));
  settings.slackSites = splitList($('slackSites').value.replace(/,/g, '\n'));
  settings.slackKeywords = splitList($('slackKeywords').value);
  settings.sensitiveSites = splitList($('sensitiveSites').value.replace(/,/g, '\n'));
  const minimums = { repeatEveryMin: 0.5, snoozeMin: 1, streakResetMin: 0.5 };
  document.querySelectorAll('[data-t]').forEach((input) => {
    const key = input.dataset.t;
    settings.thresholds[key] = num(input.value, DEFAULT_SETTINGS.thresholds[key], minimums[key] || 0);
  });
  document.querySelectorAll('[data-e]').forEach((input) => {
    settings.effects[input.dataset.e] = input.checked;
  });
  settings.ai.enabled = $('aiEnabled').checked;
  settings.ai.provider = shownProvider;
  settings.ai.configs = { ...settings.ai.configs, [shownProvider]: readProviderFields() };
  settings.ai.maxCallsPerHour = Math.round(num($('aiMax').value, 30, 1));
  settings.ai.eventMessages = $('aiEventMessages').checked;
  settings.ai.actions = {
    ...settings.ai.actions,
    openTabs: $('aiOpenTabs').checked,
    closeTabs: $('aiCloseTabs').checked,
    closeAfterBegs: Math.round(num($('aiCloseAfterBegs').value, DEFAULT_SETTINGS.ai.actions.closeAfterBegs, 1)),
    overrideClicks: $('aiOverride').checked,
    restoreLockMin: Math.round(num($('aiRestoreLock').value, DEFAULT_SETTINGS.ai.actions.restoreLockMin, 0)),
  };
  settings.memory = { ...settings.memory, enabled: $('memoryEnabled').checked, habitSensitivity: $('memoryHabit').checked };
  settings.debug ={ ...settings.debug, enabled: $('debugEnabled').checked, ignoreFocus: $('debugIgnoreFocus').checked };
  settings.intensity = matchingPreset() || 'custom';
}

function matchingPreset() {
  return Object.keys(PRESETS).find((name) =>
    Object.entries(PRESETS[name]).every(([k, v]) => Number(settings.thresholds[k]) === v),
  );
}

function syncPresets() {
  const current = matchingPreset();
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.preset === current));
  });
}

function updateSensitiveCount() {
  const n = splitList($('sensitiveSites').value.replace(/,/g, '\n')).length;
  $('sensitiveCount').textContent = `${n.toLocaleString()} site${n === 1 ? '' : 's'}`;
}

// Provider, model and key also drive Ask Hackie, so only the judge's own rate limit dims when the judge is off.
function syncAi() {
  $('aiMax').closest('.field').classList.toggle('off', !$('aiEnabled').checked);
  $('aiCloseAfterBegs').closest('.field').classList.toggle('off', !$('aiCloseTabs').checked);
  // The Restore lock only matters when Hackie can close tabs and may refuse clicks.
  $('aiRestoreLock').closest('.field').classList.toggle('off', !$('aiOverride').checked || !$('aiCloseTabs').checked);
}

// ---------------------------------------------------------------------------
// Save

function flash(text) {
  const span = document.createElement('span');
  span.textContent = text;
  $('savebar').replaceChildren(span);
}

async function save() {
  clearTimeout(saveTimer);
  collect();
  const json = JSON.stringify(settings);
  if (json === lastSavedJson) return;
  lastSavedJson = json;
  await chrome.storage.local.set({ settings });
  syncPresets();
  flash('Saved');
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 450);
}

// ---------------------------------------------------------------------------
// Wire up

function populateProviders() {
  $('aiProvider').replaceChildren(
    ...Object.entries(AI_PROVIDERS).map(([id, p]) => Object.assign(document.createElement('option'), { value: id, textContent: p.label })),
  );
}

function readProviderFields() {
  return {
    apiKey: $('aiKey').value.trim(),
    model: $('aiModel').value.trim(),
    baseUrl: shownProvider === 'custom' ? $('aiBaseUrl').value.trim() : '',
  };
}

function fillModelList(ids) {
  $('aiModelList').replaceChildren(...ids.map((m) => Object.assign(document.createElement('option'), { value: m })));
}

function setModelStatus(text = '', isError = false) {
  const el = $('aiModelStatus');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = !text;
}

// Asks the service worker for the provider's model ids (GET /models) and offers them as suggestions.
async function loadModels() {
  const btn = $('aiModelLoad');
  btn.disabled = true;
  try {
    await save(); // the service worker reads the provider/key from storage
    const provider = shownProvider;
    setModelStatus('Loading models…');
    const res = await send('options:listModels');
    if (provider !== shownProvider) return; // switched providers mid-request; fillProvider() already reset things
    if (!res?.ok) {
      setModelStatus(res?.error || 'Could not load models.', true);
      return;
    }
    const models = [...new Set((res.models || []).map(String).filter(Boolean))];
    if (!models.length) {
      setModelStatus('The provider returned no models. Type a model name instead.', true);
      return;
    }
    fillModelList([...new Set([...(AI_PROVIDERS[provider]?.models || []), ...models])]);
    setModelStatus(`${models.length} model${models.length === 1 ? '' : 's'} available. Pick one from the list (clear the field to see them all).`);
  } catch (err) {
    setModelStatus(err?.message || 'Could not load models.', true);
  } finally {
    btn.disabled = false;
  }
}

// Shows one provider's saved key/model (blank fields fall back to the provider's defaults).
function fillProvider(id) {
  const preset = AI_PROVIDERS[id] || AI_PROVIDERS.anthropic;
  const own = settings.ai.configs?.[id] || {};
  shownProvider = id;
  $('aiProvider').value = id;
  $('aiModel').value = own.model || preset.defaultModel || '';
  $('aiModel').placeholder = preset.modelHint || preset.defaultModel || 'model name';
  fillModelList(preset.models);
  setModelStatus();
  $('aiBaseRow').hidden = id !== 'custom';
  $('aiBaseUrl').value = own.baseUrl || '';
  $('aiKey').value = own.apiKey || '';
  $('aiKey').placeholder = preset.keyHint || '';
  $('aiKeyLabel').textContent = `${preset.label} API key${preset.keyOptional ? ' (optional)' : ''}`;
  let host = 'your provider';
  try {
    host = new URL(own.baseUrl || preset.baseUrl).host || host;
  } catch {
    /* custom URL not set yet */
  }
  $('aiKeyNote').textContent = `Stored only in this browser's extension storage and sent only to ${host}.`;
  const link = $('aiKeysLink');
  link.hidden = !preset.keysUrl;
  if (preset.keysUrl) link.href = preset.keysUrl;
  $('aiResult').replaceChildren();
}

function crack(container) {
  const whip = container.querySelector('.hk-whip');
  if (!whip?.animate) return;
  whip.style.transformBox = 'view-box';
  whip.style.transformOrigin = '15px 64px';
  whip.animate(
    [{ transform: 'rotate(40deg)' }, { transform: 'rotate(-38deg)', offset: 0.45 }, { transform: 'rotate(12deg)', offset: 0.7 }, { transform: 'rotate(0)' }],
    { duration: 540, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  const burst = container.querySelector('.hk-burst');
  burst?.animate(
    [
      { opacity: 0, transform: 'translate(-104px, 50px) scale(.2)' },
      { opacity: 1, transform: 'translate(-104px, 50px) scale(1.35)', offset: 0.3 },
      { opacity: 0, transform: 'translate(-104px, 50px) scale(1.7)' },
    ],
    { duration: 600, delay: 220 },
  );
}

function renderArt() {
  $('heroHackie').innerHTML = Hackie.html({ mood: 'stern' });
  document.querySelectorAll('.preset-hackie').forEach((el) => {
    el.innerHTML = Hackie.html({ mood: el.dataset.mood, whip: false });
  });
}

async function testAi() {
  await save();
  const out = $('aiResult');
  const config = aiConfig(settings);
  const problem = !config.model ? 'Pick a model first.' : !config.baseUrl ? 'Set the API base URL first.' : !config.apiKey && !config.keyOptional ? 'Add an API key first.' : '';
  if (problem) {
    out.replaceChildren(Object.assign(document.createElement('span'), { className: 'err', textContent: problem }));
    return;
  }
  $('aiTest').disabled = true;
  out.textContent = `Asking ${config.label} (${config.model}) about a "funny cat fails" YouTube video…`;
  try {
    const res = await send('options:testAI');
    if (!res?.ok) {
      out.replaceChildren(Object.assign(document.createElement('span'), { className: 'err', textContent: res?.error || 'Failed.' }));
      return;
    }
    const { verdict } = res;
    const pill = Object.assign(document.createElement('span'), { className: `pill ${verdict.category}`, textContent: verdict.category });
    const reason = Object.assign(document.createElement('p'), { textContent: verdict.reason });
    const parts = [pill, reason];
    if (verdict.nudge) parts.push(Object.assign(document.createElement('p'), { className: 'nudge', textContent: `Hackie: "${verdict.nudge}"` }));
    parts.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: `Answered by ${verdict.model}.` }));
    out.replaceChildren(...parts);
  } finally {
    $('aiTest').disabled = false;
  }
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportData() {
  const all = await chrome.storage.local.get(null);
  for (const c of Object.values(all.settings?.ai?.configs || {})) {
    if (c.apiKey) c.apiKey = '(redacted)';
  }
  downloadJson(all, `taskwhip-export-${new Date().toISOString().slice(0, 10)}.json`);
}

async function resetStats() {
  if (!confirm('Reset all TaskWhip time stats? Your settings stay. This cannot be undone.')) return;
  await send('options:resetStats');
  flash('Stats reset');
}

// ---------------------------------------------------------------------------
// Settings file (export / import settings only)

const SETTINGS_KEYS = ['zeroSlack', 'task', 'workSites', 'slackSites', 'thresholds', 'effects', 'ai', 'memory', 'debug', 'sensitiveSites'];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fileMsg(text = '', isError = false) {
  const box = $('settingsFileMsg');
  box.textContent = text;
  box.classList.toggle('err', isError);
  box.hidden = !text;
}

async function exportSettings() {
  await save(); // include edits still waiting for the auto-save
  const copy = structuredClone(settings);
  if (!$('settingsExportKeys').checked) {
    for (const c of Object.values(copy.ai?.configs || {})) if (isPlainObject(c)) c.apiKey = '';
  }
  downloadJson({ app: 'TaskWhip', kind: 'settings', version: 1, exportedAt: new Date().toISOString(), settings: copy }, `taskwhip-settings-${localDay()}.json`);
  fileMsg();
  flash('Exported');
}

// mergeSettings() fills in missing fields but keeps whatever type the file had; put back the default
// wherever the type doesn't match (a string where a list belongs, a negative number, ...).
function conform(value, def) {
  if (Array.isArray(def)) return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [...def];
  if (isPlainObject(def)) {
    if (!isPlainObject(value)) return structuredClone(def);
    const out = { ...value };
    for (const key of Object.keys(def)) out[key] = conform(value[key], def[key]);
    return out;
  }
  if (typeof def === 'number') return Number.isFinite(value) && value >= 0 ? value : def;
  return typeof value === typeof def ? value : def;
}

function importedSettings(incoming) {
  const next = conform(mergeSettings(incoming), DEFAULT_SETTINGS);
  const configs = {};
  for (const [id, c] of Object.entries(next.ai.configs)) {
    if (!AI_PROVIDERS[id] || !isPlainObject(c)) continue;
    const str = (v) => (typeof v === 'string' ? v : '');
    configs[id] = { apiKey: str(c.apiKey), model: str(c.model), baseUrl: str(c.baseUrl) };
  }
  // Keep the keys you already have for providers whose key the file leaves out.
  for (const [id, cur] of Object.entries(settings.ai.configs || {})) {
    if (!cur?.apiKey) continue;
    if (!configs[id]) configs[id] = { ...cur };
    else if (!configs[id].apiKey) configs[id].apiKey = cur.apiKey;
  }
  next.ai.configs = configs;
  if (!AI_PROVIDERS[next.ai.provider]) next.ai.provider = DEFAULT_SETTINGS.ai.provider;
  return next;
}

async function importSettings(file) {
  fileMsg();
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fileMsg(`${file.name} isn't valid JSON.`, true);
    return;
  }
  const incoming = isPlainObject(parsed) && isPlainObject(parsed.settings) ? parsed.settings : parsed;
  if (!isPlainObject(incoming) || !SETTINGS_KEYS.some((k) => Object.hasOwn(incoming, k))) {
    fileMsg(`${file.name} doesn't look like TaskWhip settings (no task, site lists, thresholds or AI settings in it).`, true);
    return;
  }
  const next = importedSettings(incoming);
  const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const summary = [
    `Task: ${next.task.title || '(none)'}`,
    count(next.workSites.length, 'work site'),
    count(next.slackSites.length, 'slacking site'),
    `AI: ${AI_PROVIDERS[next.ai.provider].label}`,
  ].join(' · ');
  if (!confirm(`Replace your settings with the imported ones?\n\n${summary}`)) return;
  clearTimeout(saveTimer);
  settings = next;
  fill();
  collect(); // the same clean-up a normal save does (minimums, list splitting)
  lastSavedJson = JSON.stringify(settings);
  await chrome.storage.local.set({ settings });
  syncPresets();
  flash('Imported');
}

// ---------------------------------------------------------------------------
// Hackie's memory (lists from the service worker; every value goes in via textContent)

const PRIVATE_DOMAIN = '(private site)';
const HABIT_LABEL = { none: 'Not a habit', habit: 'Habit', strong: 'Strong habit' };
const INCIDENT_LABEL = { lockdown: 'Lockdown', beg: 'Begged for time', enforced: 'Closed tabs', back: 'Back to work', nudge: 'Nudge', whip: 'Whip' };
const LIST_LIMIT = 10;
let memory = null;
let showAllWork = false;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const siteLabel = (domain) => (domain === PRIVATE_DOMAIN || domain === 'Private site' ? 'Private site' : String(domain || ''));
const webUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== ''));
  return node;
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.host.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}

function when(at) {
  const d = new Date(at || 0);
  const time = { hour: 'numeric', minute: '2-digit' };
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], time) : d.toLocaleString([], { month: 'short', day: 'numeric', ...time });
}

// "example.com" -> "https://example.com"; anything that isn't a web address -> ''.
function normalizeLink(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : /^[a-z][\w+.-]*:/i.test(s) || /\s/.test(s) || !s.includes('.') ? '' : `https://${s}`;
  try {
    return url && new URL(url).href;
  } catch {
    return '';
  }
}

function memNote(text = '', isError = false) {
  const box = $('memStatus');
  box.textContent = text;
  box.classList.toggle('err', isError);
  box.hidden = !text;
}

async function ask(type, payload) {
  try {
    return (await send(type, payload)) || { ok: false, error: 'No answer from Hackie.' };
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not reach Hackie.' };
  }
}

async function loadMemory() {
  const res = await ask('memory:get');
  if (!res.ok || !res.memory) {
    memNote(`Couldn't load Hackie's memory: ${res.error || 'no answer from Hackie.'}`, true);
    return;
  }
  memory = res.memory;
  renderMemory();
}

// Runs one memory:* message, then reloads the lists.
async function memoryAction(btn, type, payload, done) {
  if (btn) btn.disabled = true;
  const res = await ask(type, payload);
  if (btn) btn.disabled = false;
  if (!res.ok) {
    memNote(res.error || "That didn't work. Try again.", true);
    return res;
  }
  memNote();
  flash(done);
  await loadMemory();
  return res;
}

function miniButton(text, title, onClick) {
  const b = el('button', { type: 'button', className: 'btn mini', textContent: text, title });
  b.addEventListener('click', () => onClick(b));
  return b;
}

function forgetButton(kind, id, what) {
  return miniButton('Forget', `Forget ${what}`, (b) => memoryAction(b, 'memory:forget', { kind, id }, 'Forgotten'));
}

function memItem(main, actions = []) {
  return el('li', { className: 'mem-item' }, el('div', { className: 'mem-main' }, ...main), el('div', { className: 'mem-actions' }, ...actions));
}

const emptyItem = (text) => el('li', { className: 'mem-empty', textContent: text });

function renderList(id, items, empty) {
  $(id).replaceChildren(...(items.length ? items : [emptyItem(empty)]));
}

function siteRow(s) {
  const level = HABIT_LABEL[s.habit] ? s.habit : 'none';
  const name = siteLabel(s.domain);
  const meta = [`${formatDuration(s.slackSec, { compact: true })} slacking`, plural(s.visits || 0, 'visit')];
  if (s.flagged) meta.push('flagged');
  const actions = [];
  if (s.domain !== PRIVATE_DOMAIN) {
    actions.push(
      s.flagged
        ? miniButton('Unflag', 'Stop counting this site as a habit unless its time says so', (b) => memoryAction(b, 'memory:flagSite', { domain: s.domain, flagged: false }, 'Unflagged'))
        : miniButton('Flag', 'Count this site as a slacking habit right away', (b) => memoryAction(b, 'memory:flagSite', { domain: s.domain, flagged: true }, 'Flagged')),
    );
  }
  actions.push(forgetButton('site', s.domain, name));
  return memItem(
    [
      el('div', { className: 'mem-name' }, el('span', { className: 'mem-title', textContent: name }), el('span', { className: `habit-badge ${level}`, textContent: HABIT_LABEL[level] })),
      el('div', { className: 'mem-meta', textContent: meta.join(' · ') }),
    ],
    actions,
  );
}

function workRow(p) {
  const url = webUrl(p.url);
  const host = hostOf(url);
  const label = p.title || shortUrl(url) || 'Untitled page';
  const link = url ? el('a', { className: 'mem-title', href: url, target: '_blank', rel: 'noopener noreferrer', textContent: label, title: url }) : el('span', { className: 'mem-title', textContent: label });
  return memItem(
    [el('div', { className: 'mem-name' }, link), el('div', { className: 'mem-meta', textContent: [formatDuration(p.seconds, { compact: true }), host].filter(Boolean).join(' · ') })],
    [forgetButton('workPage', p.key, 'this page')],
  );
}

function projectRow(p) {
  const links = (p.urls || []).map(webUrl).filter(Boolean);
  return memItem(
    [
      el('div', { className: 'mem-name' }, el('span', { className: 'mem-title', textContent: p.name || 'Untitled project' })),
      links.length ? el('div', { className: 'mem-links' }, ...links.map((u) => el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', textContent: shortUrl(u), title: u }))) : null,
      p.notes ? el('div', { className: 'mem-meta', textContent: p.notes }) : null,
    ],
    [forgetButton('project', p.id, p.name || 'this project')],
  );
}

function factRow(f) {
  return memItem([el('div', { className: 'mem-text', textContent: f.text })], [forgetButton('fact', f.id, 'this fact')]);
}

function incidentRow(i) {
  const kind = INCIDENT_LABEL[i.kind] || String(i.kind || 'Event').replace(/^./, (c) => c.toUpperCase());
  const rest = [i.site ? siteLabel(i.site) : '', i.summary || ''].filter(Boolean);
  const details = [i.level ? `Level ${i.level}` : '', i.begs ? plural(i.begs, 'beg') : '', i.closed ? `closed ${plural(i.closed, 'tab')}` : '', i.opened ? `opened ${plural(i.opened, 'tab')}` : ''].filter(Boolean);
  return el(
    'li',
    { className: 'mem-inc', title: details.join(' · ') },
    el('span', { className: 'inc-time num', textContent: when(i.at) }),
    ' · ',
    el('b', { textContent: kind }),
    rest.length ? ` · ${rest.join(' · ')}` : '',
  );
}

function renderMemory() {
  const m = memory || {};
  const sites = (m.sites || []).filter((s) => s.slackSec > 0 || s.flagged).sort((a, b) => (b.slackSec || 0) - (a.slackSec || 0));
  renderList('memSites', sites.slice(0, LIST_LIMIT).map(siteRow), 'No slacking habits yet. Hackie learns them as you browse.');

  const pages = m.workPages || [];
  renderList('memWorkPages', (showAllWork ? pages : pages.slice(0, LIST_LIMIT)).map(workRow), 'No work pages yet. Pages you spend work time on show up here.');
  const more = $('memWorkMore');
  more.hidden = pages.length <= LIST_LIMIT;
  more.textContent = showAllWork ? 'Show fewer' : `Show all ${pages.length}`;

  renderList('memProjects', (m.projects || []).map(projectRow), 'No projects yet. Add one so "Back to work" knows where to send you.');
  renderList('memFacts', (m.facts || []).map(factRow), 'Nothing yet. The AI adds facts as it learns about you, or add your own.');
  const incidents = [...(m.incidents || [])].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, LIST_LIMIT);
  renderList('memIncidents', incidents.map(incidentRow), 'No lockdowns, begging or closed tabs yet.');

  $('memForgetAll').disabled = !m.sites?.length && !pages.length && !m.projects?.length && !m.facts?.length && !m.incidents?.length;
}

async function addProject(e) {
  e.preventDefault();
  const name = $('memProjectName').value.trim();
  if (!name) {
    memNote('Give the project a name first.', true);
    $('memProjectName').focus();
    return;
  }
  const lines = $('memProjectUrls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const urls = [...new Set(lines.map(normalizeLink).filter(Boolean))];
  const skipped = lines.length - lines.filter((l) => normalizeLink(l)).length;
  const res = await memoryAction($('memProjectAdd'), 'memory:addProject', { name, urls, notes: $('memProjectNotes').value.trim() }, 'Project added');
  if (!res.ok) return;
  $('memProjectForm').reset();
  if (skipped) memNote(`Skipped ${plural(skipped, 'link')} that ${skipped === 1 ? "isn't a web address" : "aren't web addresses"}.`);
}

async function addFact(e) {
  e.preventDefault();
  const text = $('memFactText').value.trim();
  if (!text) {
    $('memFactText').focus();
    return;
  }
  const res = await memoryAction($('memFactAdd'), 'memory:addFact', { text }, 'Fact added');
  if (res.ok) $('memFactText').value = '';
}

async function forgetAll() {
  if (!confirm("Forget everything Hackie remembers about you? Slacking habits, work pages, projects, facts and incidents are deleted. Your settings and time stats stay. This can't be undone.")) return;
  await memoryAction($('memForgetAll'), 'memory:forget', { kind: 'all' }, 'Memory cleared');
}

async function init() {
  populateProviders();
  renderArt();
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = mergeSettings(stored);
  lastSavedJson = JSON.stringify(settings);
  fill();

  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.closest('[data-nosave]')) return; // memory forms and the settings file row aren't settings fields
    el.addEventListener('input', () => {
      if (el.dataset.t) syncPresets();
      scheduleSave();
    });
    el.addEventListener('change', scheduleSave);
  });
  document.querySelectorAll('[data-t]').forEach((el) =>
    el.addEventListener('input', () => {
      collect();
      syncPresets();
    }),
  );
  $('aiEnabled').addEventListener('change', syncAi);
  $('aiCloseTabs').addEventListener('change', syncAi);
  $('aiOverride').addEventListener('change', syncAi);
  $('sensitiveSites').addEventListener('input', updateSensitiveCount);
  $('sensitiveReset').addEventListener('click', () => {
    $('sensitiveSites').value = SENSITIVE_DOMAINS.join('\n');
    updateSensitiveCount();
    save();
  });
  $('aiProvider').addEventListener('change', () => {
    collect(); // keep the provider we're leaving
    fillProvider($('aiProvider').value);
    save();
  });

  document.querySelectorAll('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      Object.assign(settings.thresholds, PRESETS[btn.dataset.preset]);
      if (btn.dataset.preset !== 'gentle') settings.effects.blockScreen = true;
      document.querySelectorAll('[data-t]').forEach((input) => {
        input.value = settings.thresholds[input.dataset.t];
      });
      document.querySelectorAll('[data-e]').forEach((input) => {
        input.checked = Boolean(settings.effects[input.dataset.e]);
      });
      syncPresets();
      save();
    });
  });

  $('aiKeyShow').addEventListener('click', () => {
    const input = $('aiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('aiKeyShow').textContent = show ? 'Hide' : 'Show';
  });
  $('aiModelLoad').addEventListener('click', loadModels);
  $('aiTest').addEventListener('click', testAi);
  $('exportBtn').addEventListener('click', exportData);
  $('resetBtn').addEventListener('click', resetStats);
  $('settingsExport').addEventListener('click', exportSettings);
  $('settingsImport').addEventListener('click', () => $('settingsImportFile').click());
  $('settingsImportFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again should fire another change
    if (file) importSettings(file);
  });
  $('memProjectForm').addEventListener('submit', addProject);
  $('memFactForm').addEventListener('submit', addFact);
  $('memForgetAll').addEventListener('click', forgetAll);
  $('memWorkMore').addEventListener('click', () => {
    showAllWork = !showAllWork;
    renderMemory();
  });
  $('heroHackie').addEventListener('click', () => crack($('heroHackie')));

  // The popup can change site lists while this page is open; pick those changes up.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const incoming = JSON.stringify(mergeSettings(changes.settings.newValue));
    if (incoming === lastSavedJson) return;
    settings = mergeSettings(changes.settings.newValue);
    lastSavedJson = incoming;
    fill();
  });

  if (!settings.task.title) $('taskTitle').focus();
  loadMemory();
}

init();
