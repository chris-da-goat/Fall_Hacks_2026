// End-to-end test: loads the unpacked extension into a throwaway, headless Chrome profile
// (Chrome DevTools Protocol over --remote-debugging-pipe + Extensions.loadUnpacked), serves
// fake "video" and "work" pages on *.localhost, and walks Hackie through every escalation level.
//
//   node tests/e2e.mjs                  # uses the default Chrome install
//   CHROME_PATH=... E2E_OUT=... node tests/e2e.mjs
//
// Screenshots land in E2E_OUT (default: <os tmp>/taskwhip-e2e).

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const OUT = process.env.E2E_OUT || join(tmpdir(), 'taskwhip-e2e');
const HEADLESS = process.env.HEADLESS !== '0';
mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH.');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake sites

function page(title, body, { dark = false } = {}) {
  const bg = dark ? '#0f0f0f' : '#f7f7f8';
  const fg = dark ? '#f1f1f1' : '#1d1d1f';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${title}">
<style>body{margin:0;font-family:system-ui,sans-serif;background:${bg};color:${fg}}
header{height:56px;display:flex;align-items:center;padding:0 24px;font-weight:800;font-size:20px;border-bottom:1px solid #8883}
main{padding:24px;max-width:1000px}.player{aspect-ratio:16/9;max-height:460px;border-radius:14px;background:linear-gradient(135deg,#4b3b6b,#16121f);display:grid;place-items:center;color:#fff;font-size:28px;font-weight:700}
h1{font-size:22px;margin:16px 0 4px}p{opacity:.7;margin:0}</style></head><body>${body}</body></html>`;
}

const PAGES = {
  '/cats': page(
    'Funny cat compilation #47 - VidTube',
    `<header>VidTube</header><main><div class="player">&#9654; cat video playing</div><h1>Funny cat compilation #47</h1><p>CatChaos · 2.1M views · Try not to laugh</p><video muted></video></main>`,
    { dark: true },
  ),
  '/cats2': page(
    'Cats vs cucumbers (part 9) - VidTube',
    `<header>VidTube</header><main><div class="player">&#9654; more cats</div><h1>Cats vs cucumbers (part 9)</h1><p>CatChaos · 900K views</p></main>`,
    { dark: true },
  ),
  '/tutorial': page(
    'Linked list in C++ explained - VidTube',
    `<header>VidTube</header><main><div class="player">&#9654; lecture</div><h1>Linked list in C++ explained</h1><p>CS Prof · Data structures</p></main>`,
    { dark: true },
  ),
  '/lecture': page(
    'Graph algorithms lecture 7 - OpenCourse',
    `<header>OpenCourse</header><main><h1>Lecture 7: graph traversal</h1><p>BFS, DFS and adjacency lists.</p></main>`,
  ),
  '/gossip': page(
    'Who wore it better? Red carpet roundup - StarBuzz',
    `<header>StarBuzz</header><main><h1>Who wore it better?</h1><p>Our red carpet roundup.</p></main>`,
  ),
  '/proxy': page(
    'Secret proxied title - Unblocker',
    `<header>Unblocker</header><main><h1>Secret proxied heading</h1><p>secret proxied text</p></main>`,
  ),
  '/p/abc123': page(
    'Another secret title',
    `<link rel="canonical" href="http://private.localhost/hidden"><main><h1>secret canonical text</h1></main>`,
  ),
  '/work': page(
    'Linked list implementation - WorkDocs',
    `<header>WorkDocs</header><main><h1>Linked list implementation</h1><p>struct Node { int value; Node* next; };</p></main>`,
  ),
};

const aiRequests = [];

// A fake OpenAI-compatible LLM so the AI judge path can be tested without a real key.
function fakeLlm(req, res) {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    aiRequests.push({ auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    const reply = (message, finish = 'stop') => res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }] }));

    // Per-event AI ("enforcer"): writes a bubble; when allowed to close tabs, closes the slacking ones.
    const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t.function?.name) : [];
    if (toolNames.includes('list_tabs')) {
      const toolMsgs = body.messages.filter((m) => m.role === 'tool');
      const userText = body.messages.find((m) => m.role === 'user')?.content || '';
      if (!toolNames.includes('close_tabs')) {
        const title = (userText.match(/Video title: (.*)|Title: (.*)/) || [])[0] || 'this page';
        return reply({ content: `AI-BUBBLE: I can see ${title.replace(/^(Video title|Title): /, '')}. Back to work!` });
      }
      if (!toolMsgs.length) {
        return reply({ content: null, tool_calls: [{ id: 'call_list', type: 'function', function: { name: 'list_tabs', arguments: '{}' } }] }, 'tool_calls');
      }
      if (toolMsgs.length === 1) {
        const tabs = JSON.parse(toolMsgs[0].content);
        const slack = tabs.filter((t) => t.category === 'slack').map((t) => t.id);
        const work = tabs.find((t) => t.category === 'work');
        const calls = [{ id: 'call_close', type: 'function', function: { name: 'close_tabs', arguments: JSON.stringify({ tab_ids: [...slack, ...(work ? [work.id] : [])], reason: 'begged twice' }) } }];
        if (work) calls.push({ id: 'call_focus', type: 'function', function: { name: 'focus_tab', arguments: JSON.stringify({ tab_id: work.id }) } });
        return reply({ content: null, tool_calls: calls }, 'tool_calls');
      }
      return reply({ content: 'AI-ENFORCED: I closed your slacking tabs and put your work in front.' });
    }

    // Ask Hackie agent: call two tools first, then answer from their results.
    if (Array.isArray(body.tools)) {
      const toolMsgs = body.messages.filter((m) => m.role === 'tool');
      if (!toolMsgs.length) {
        return reply(
          {
            content: null,
            tool_calls: [
              { id: 'call_today', type: 'function', function: { name: 'get_today_summary', arguments: '{}' } },
              { id: 'call_debug', type: 'function', function: { name: 'get_debug_log', arguments: '{"limit": 3}' } },
            ],
          },
          'tool_calls',
        );
      }
      const today = JSON.parse(toolMsgs.find((m) => m.tool_call_id === 'call_today').content);
      const debug = JSON.parse(toolMsgs.find((m) => m.tool_call_id === 'call_debug').content);
      return reply({ content: `Slacked ${Math.round(today.totalsSec.slack)}s today, recruit. Latest check: ${debug[0]?.why}` });
    }

    // Angry-Hackie arbiter: refuses everything except exercise breaks.
    const sys = body.messages.find((m) => m.role === 'system')?.content || '';
    if (/clicked a button asking for something/.test(sys)) {
      const req = (body.messages.find((m) => m.role === 'user')?.content || '').match(/<request>(.*)<\/request>/)?.[1] || '';
      const allow = /exercise/i.test(req) && !/ALREADY REFUSED/.test(sys);
      return reply({ content: JSON.stringify({ allow, message: allow ? 'Fine. ONE exercise break.' : `DENIED-BY-AI: no ${req.replace(/^The user asked for /, '').replace(/\.$/, '')}.` }) });
    }

    const user = body.messages.find((m) => m.role === 'user')?.content || '';
    const verdict = /Page information blocked/.test(user)
      ? { category: 'slack', reason: 'Sensitive content.', nudge: 'Whatever that was, close it, recruit.' }
      : /lecture/i.test(user)
      ? { category: 'work', reason: 'A graph algorithms lecture fits your data structures task.', nudge: '' }
      : { category: 'slack', reason: 'Celebrity gossip has nothing to do with linked lists.', nudge: 'Gossip later, pointers now, recruit!' };
    reply({ content: JSON.stringify(verdict) });
  });
}

function startServer() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && path === '/v1/chat/completions') return fakeLlm(req, res);
    const html = PAGES[path];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html || 'not found');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---------------------------------------------------------------------------
// Minimal CDP client over the debugging pipe (fd 3 = to Chrome, fd 4 = from Chrome)

class Cdp {
  constructor(proc) {
    this.out = proc.stdio[3];
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    let buf = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) >= 0) {
        const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
        buf = buf.subarray(i + 1);
        this.dispatch(msg);
      }
    });
  }
  dispatch(msg) {
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else {
      for (const fn of this.listeners) fn(msg);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.out.write(JSON.stringify(msg) + '\0');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
}

// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const profile = mkdtempSync(join(tmpdir(), 'taskwhip-profile-'));
  const chrome = findChrome();
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--window-size=1280,800',
    '--autoplay-policy=no-user-gesture-required',
    ...(HEADLESS ? ['--headless=new'] : []),
    'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const cdp = new Cdp(proc);

  const evalIn = async (sessionId, expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  try {
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    check('extension loads', Boolean(extId), extId);

    // Find and attach to the service worker.
    let sw = null;
    for (let i = 0; i < 50 && !sw; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
      if (!sw) await sleep(100);
    }
    check('service worker starts', Boolean(sw));
    const { sessionId: swS } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const bg = (expr) => evalIn(swS, expr);
    // The worker can be attached before its script has finished evaluating.
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      ready = await bg(`typeof chrome !== 'undefined' && typeof globalThis.taskwhip === 'object'`).catch(() => false);
      if (!ready) await sleep(100);
    }
    check('service worker is ready', ready);
    await bg('taskwhip.debug.assumeActive = true'); // don't depend on whether someone is touching the machine

    const base = `http://videos.localhost:${port}`;
    const workUrl = `http://work.localhost:${port}/work`;
    const testSettings = {
      task: { title: 'Finish the linked list assignment', keywords: ['c++', 'data structures'], url: workUrl },
      workSites: ['work.localhost'],
      slackSites: ['videos.localhost'],
      thresholds: { nudgeAfterMin: 0.1, whipAfterMin: 0.25, blockAfterMin: 0.4, repeatEveryMin: 0.25, streakResetMin: 0.5, snoozeMin: 5, dailySlackBudgetMin: 30 },
    };
    await bg(`chrome.storage.local.set({ settings: ${JSON.stringify(testSettings)} })`);

    // Open the slacking page in a fresh tab and attach to it.
    const { targetId: pageId } = await cdp.send('Target.createTarget', { url: `${base}/cats` });
    const { sessionId: pg } = await cdp.send('Target.attachToTarget', { targetId: pageId, flatten: true });
    await cdp.send('Page.enable', {}, pg);
    // Pages must never load extension files (YouTube logs them as "Unsafe attempt to load URL").
    const extLoadLogs = [];
    cdp.listeners.add((m) => {
      if (m.method === 'Log.entryAdded' && /chrome-extension:\/\/|Unsafe attempt to load/.test(m.params.entry.text)) extLoadLogs.push(m.params.entry.text.trim());
    });
    await cdp.send('Log.enable', {}, pg);
    const inPage = (expr) => evalIn(pg, expr);
    const shot = async (name, sessionId = pg, params = {}) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...params }, sessionId);
      const file = join(OUT, `${name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    };
    const ui = (sel) =>
      inPage(`(() => { const r = document.querySelector('taskwhip-hackie')?.shadowRoot; const el = r?.querySelector(${JSON.stringify(sel)}); return el ? { hidden: el.hidden, cls: el.className, text: el.textContent.trim().slice(0, 240) } : null; })()`);
    const clickUi = (sel) => inPage(`document.querySelector('taskwhip-hackie').shadowRoot.querySelector(${JSON.stringify(sel)}).click()`);
    const bgState = () => bg('taskwhip.refresh("e2e").then(({ state, decision }) => ({ current: state.current, streak: state.streak, decision }))');

    // Make sure this tab is the active one, then wait for the content script to report.
    await bg(`chrome.tabs.query({ url: '${base}/*' }).then(([t]) => chrome.tabs.update(t.id, { active: true }))`);
    await sleep(2500);
    const env = await bg(`(async () => { const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); return { focused: w.focused, idle: await chrome.idle.queryState(60) }; })()`);
    console.log('      browser env:', JSON.stringify(env));

    let s = await bgState();
    check('cat video is classified as slacking', s.current?.category === 'slack', s.current ? `${s.current.category}: ${s.current.reason}` : 'not tracked');
    check('page context was read', /Funny cat compilation/.test(s.current?.title || ''), s.current?.title);

    await sleep(1200);
    const chip = await ui('.pill');
    check('Hackie walks in with the slack timer', chip && /videos\.localhost\s*0:0\d/.test(chip.text), chip?.text);
    const walker = await inPage(`(() => { const w = document.querySelector('taskwhip-hackie').shadowRoot.querySelector('.walker'); const img = w.querySelector('.hk-box img'); return { hidden: w.hidden, transform: w.style.transform, gif: img && img.complete && img.naturalWidth }; })()`);
    check('Hackie (the team GIF) is drawn and positioned', walker && !walker.hidden && /translate/.test(walker.transform) && walker.gif === 64, JSON.stringify(walker));
    const srcs = await inPage(`[...document.querySelector('taskwhip-hackie').shadowRoot.querySelectorAll('img')].map((i) => i.src.slice(0, 11))`);
    check("Hackie's art arrives as data: URLs (the page never loads extension files)", srcs.length > 0 && srcs.every((x) => x === 'data:image/'), srcs.join(','));
    const war = await bg('chrome.runtime.getManifest().web_accessible_resources || null');
    check('no web-accessible files for sites to load or probe', war === null, JSON.stringify(war));
    const at = await inPage(`(() => { const m = document.querySelector('taskwhip-hackie').shadowRoot.querySelector('.walker').style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/); return m ? [Number(m[1]), Number(m[2])] : null; })()`);
    let eyes = null;
    if (at) {
      for (let i = 0; i < 6 && !(eyes && eyes.left && eyes.left !== 'translate(0%, 0%)'); i++) {
        const cur = await inPage(`(() => { const m = document.querySelector('taskwhip-hackie').shadowRoot.querySelector('.walker').style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/); return [Number(m[1]), Number(m[2])]; })()`);
        const x = cur[0] + 50 + (cur[0] > 640 ? -95 : 95);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: cur[1] + 40 }, pg);
        await sleep(400);
        eyes = await inPage(`(() => { const r = document.querySelector('taskwhip-hackie').shadowRoot; const l = r.querySelector('.hk-box .hk-eye-l'); return l ? { left: l.style.transform, right: r.querySelector('.hk-box .hk-eye-r').style.transform } : null; })()`);
      }
    }
    check("hover: curious Hackie (the team's hover sprite) looks at the mouse", eyes && eyes.left && eyes.left !== 'translate(0%, 0%)', JSON.stringify(eyes));
    await shot('1b-curious');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 400 }, pg);
    await sleep(300);

    const waitFor = async (sel, pred, timeoutMs) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        await bgState();
        const el = await ui(sel);
        if (el && pred(el)) return el;
        await sleep(700);
      }
      return null;
    };

    const nudge = await waitFor('.bubble', (el) => el.cls.includes('lvl-1'), 15000);
    check('level 1: Hackie nudges, offering an exercise break', Boolean(nudge) && /Or get up and do/.test(nudge.text) && /I did it!/.test(nudge.text), nudge?.text);
    await sleep(500);
    await shot('1-nudge');

    const whip = await waitFor('.bubble', (el) => el.cls.includes('lvl-2'), 20000);
    check('level 2: Hackie cracks the whip', Boolean(whip) && /CRACK!/.test(whip.text), whip?.text);
    await sleep(380);
    await shot('2-whip');

    const block = await waitFor('.block', (el) => !el.hidden, 20000);
    check('level 3: lockdown blocks the page', Boolean(block) && /Lockdown/i.test(block.text), block?.text?.slice(0, 120));
    const begDisabled = await inPage(`document.querySelector('taskwhip-hackie').shadowRoot.querySelector('[data-act="snooze"]').disabled`);
    check('"beg for more time" starts disabled', begDisabled === true);
    await sleep(500);
    await shot('3-arrest');

    const today = await bg(`(async () => { const k = 'day:' + new Date().toLocaleDateString('sv'); return (await chrome.storage.local.get(k))[k]; })()`);
    check('stats recorded slack time', today?.totals?.slack > 20, `${Math.round(today?.totals?.slack)}s slack`);
    check('events counted', today?.events?.nudges >= 1 && today?.events?.whips >= 1 && today?.events?.blocks >= 1, JSON.stringify(today?.events));

    // Back to work.
    await clickUi('[data-act="back"]');
    await sleep(2500);
    s = await bgState();
    check('"Back to work" opens the task link', s.current?.url === workUrl, s.current?.url);
    check('work page is classified as work', s.current?.category === 'work', s.current?.reason);
    check('slack streak resets', s.streak.slack === 0, JSON.stringify(s.streak));

    // A relevant tutorial on the "slacking" site counts as work.
    await cdp.send('Page.navigate', { url: `${base}/tutorial` }, pg);
    await sleep(2500);
    s = await bgState();
    check('task-related video counts as work', s.current?.category === 'work', s.current?.reason);

    // Honor system: "It's for my task" from the watch card.
    await cdp.send('Page.navigate', { url: `${base}/cats` }, pg);
    await sleep(2500);
    s = await bgState();
    check('back on the cat video: slacking again, no immediate whip', s.current?.category === 'slack' && s.decision.level === 0, `level ${s.decision.level}`);
    await clickUi('.hk-box');
    await sleep(400);
    const report = await ui('.panel');
    check("clicking Hackie opens Hackie's report", report && /Hackie's report/.test(report.text) && /Exercise breaks/.test(report.text) && /Next snooze: 5 min/.test(report.text), report?.text);
    await shot('4-hackie-report');
    await clickUi('.panel [data-act="isWork"]');
    await sleep(1500);
    s = await bgState();
    check('"It\'s for my task" overrides the page', s.current?.category === 'work' && s.current?.source === 'override', s.current?.reason);


    // The team's features: shrinking snoozes, the angry mom, exercise breaks, reset mood, test triggers.
    await cdp.send('Page.navigate', { url: `${base}/cats2` }, pg);
    await sleep(2500);
    await bgState();
    const snoozeLens = [];
    for (let i = 0; i < 5; i++) {
      await bg(`taskwhip.action('snooze')`);
      const st = await bg('taskwhip.state()');
      snoozeLens.push(Math.round((st.snoozeUntil - Date.now()) / 60000));
    }
    check('snoozes shrink 5 → 3 → 2 min', snoozeLens.slice(0, 3).join(',') === '5,3,2' && snoozeLens[4] === 2, snoozeLens.join(','));
    let st2 = await bg('taskwhip.state()');
    check('snooze count tracked', st2.snoozeCount === 5, String(st2.snoozeCount));
    await bg('taskwhip.fire(1)');
    await sleep(600);
    const angry = await ui('.bubble');
    check('5 snoozes: the angry mom appears', angry && /angry/.test(angry.cls) && /5 snoozes/.test(angry.text), `${angry?.cls} · ${angry?.text}`);
    await shot('5-angry-mom');
    await clickUi('[data-act="exercise"]');
    await sleep(1200);
    const cheerBubble = await ui('.bubble');
    check('"I did it!" shows a cheer', cheerBubble && /cheer/.test(cheerBubble.cls), cheerBubble?.text);
    st2 = await bg('taskwhip.state()');
    const dayEx = await bg(`(async () => { const k = 'day:' + new Date().toLocaleDateString('sv'); return (await chrome.storage.local.get(k))[k].events.exercises; })()`);
    check('exercise break counted and Hackie calms down', dayEx === 1 && st2.snoozeCount === 0 && st2.streak.slack < 5, `exercises ${dayEx}, snoozes ${st2.snoozeCount}`);
    await bg('taskwhip.fire(2)');
    await sleep(700);
    const testWhip = await ui('.bubble');
    check('test trigger fires a whip on demand', testWhip && /lvl-2/.test(testWhip.cls), testWhip?.cls);
    const angryArt = await inPage(`(() => { const box = document.querySelector('taskwhip-hackie').shadowRoot.querySelector('.hk-box'); const f = [...box.querySelectorAll('.hk-af')]; return { mood: box.querySelector('.hk')?.className, frames: f.length, showing: f.filter((i) => getComputedStyle(i).opacity === '1').length }; })()`);
    check("angry Hackie flips through the team's 6 angry pictures", /hk-(angry|furious)/.test(angryArt.mood) ? angryArt.frames === 6 && angryArt.showing === 1 : false, JSON.stringify(angryArt));
    await clickUi('[data-act="dismiss"]');

    // AI judge, via the "custom OpenAI-compatible" provider pointed at the fake LLM.
    await bg(`chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, ai: { enabled: true, provider: 'custom', maxCallsPerHour: 30, configs: { custom: { baseUrl: 'http://127.0.0.1:${port}/v1', model: 'fake-judge', apiKey: 'test-key' } } } } }))`);
    const misc = `http://misc.localhost:${port}`;
    await cdp.send('Page.navigate', { url: `${misc}/lecture` }, pg);
    await sleep(3000);
    s = await bgState();
    check('AI judge: unknown lecture page becomes work', s.current?.category === 'work' && s.current?.source === 'ai', `${s.current?.category}/${s.current?.source}: ${s.current?.reason}`);
    await cdp.send('Page.navigate', { url: `${misc}/gossip` }, pg);
    await sleep(3000);
    s = await bgState();
    check('AI judge: gossip page is slacking with a custom nudge', s.current?.category === 'slack' && s.current?.source === 'ai' && /pointers now/.test(s.current?.nudge || ''), `${s.current?.category}/${s.current?.source}: ${s.current?.nudge}`);
    const req = aiRequests[0];
    check('AI judge: request used the key, model and page snapshot', req?.auth === 'Bearer test-key' && req?.body?.model === 'fake-judge' && /Graph algorithms lecture/.test(JSON.stringify(req?.body)), `${aiRequests.length} calls`);
    const before = aiRequests.length;
    await cdp.send('Page.navigate', { url: `${misc}/lecture` }, pg);
    await sleep(2500);
    await bgState();
    check('AI judge: verdicts are cached', aiRequests.length === before, `${aiRequests.length - before} new calls`);

    // Sensitive sites: a proxy URL and a canonical-only proxy. The AI must see nothing.
    await bg(`chrome.storage.local.get('settings').then(({ settings }) => { settings.sensitiveSites = ['private.localhost', 'other-private.test']; return chrome.storage.local.set({ settings }); })`);
    const aiBefore = aiRequests.length;
    await cdp.send('Page.navigate', { url: `${misc}/proxy?u=${encodeURIComponent('http://private.localhost/secret-video')}` }, pg);
    await sleep(3000);
    s = await bgState();
    check('sensitive: proxy page is anonymous slacking', s.current?.category === 'slack' && s.current?.source === 'sensitive' && s.current?.domain === '(private site)' && !s.current?.title, `${s.current?.source}: ${s.current?.reason}`);
    const sentToAi = JSON.stringify(aiRequests.slice(aiBefore).filter((r) => !Array.isArray(r.body.tools)).map((r) => r.body));
    check('sensitive: AI got only the blocked notice', aiRequests.length > aiBefore && sentToAi.includes('Page information blocked') && !/secret|private.localhost|Unblocker|misc.localhost/i.test(sentToAi), `${aiRequests.length - aiBefore} call(s)`);
    check('sensitive: AI nudge still used', /close it, recruit/.test(s.current?.nudge || ''), s.current?.nudge);
    const storedCtx = await bg(`chrome.storage.session.get(null).then((all) => Object.entries(all).filter(([k]) => k.startsWith('ctx:')).map(([, v]) => v).filter((v) => v && v.sensitive))`);
    check('sensitive: no readable page context stored', storedCtx.length > 0 && storedCtx.every((c) => !c.title && !c.excerpt && !c.description), JSON.stringify(storedCtx[0]));
    await cdp.send('Page.navigate', { url: `${misc}/p/abc123` }, pg);
    await sleep(3000);
    s = await bgState();
    check('sensitive: canonical link reveals a proxied page', s.current?.source === 'sensitive', s.current?.reason);
    const chipSite = await ui('.pill');
    check('sensitive: on-page chip does not name the site', chipSite && /Private site/.test(chipSite.text) && !/private.localhost/.test(chipSite.text), chipSite?.text);
    const aiAfterSensitive = aiRequests.length;
    await cdp.send('Page.navigate', { url: `${misc}/proxy?u=${encodeURIComponent('http://other-private.test/')}` }, pg);
    await sleep(2500);
    await bgState();
    check('sensitive: one shared AI cache entry for all sensitive pages', aiRequests.length === aiAfterSensitive, `${aiRequests.length - aiAfterSensitive} new calls`);

    // Debug mode: decisions are recorded with a plain-English "why", and pages get the console.
    await bg(`chrome.storage.local.get('settings').then(({ settings }) => { settings.debug = { enabled: true }; return chrome.storage.local.set({ settings }); })`);
    await cdp.send('Page.navigate', { url: `${base}/cats2` }, pg);
    await sleep(3000);
    await bgState();
    await sleep(500);
    const dbgPayload = await bg(`chrome.storage.session.get('debugLog').then(({ debugLog }) => debugLog.slice(-1)[0])`);
    check('debug: decision snapshot explains itself', dbgPayload?.tracked && /Tracking videos\.localhost as slacking/.test(dbgPayload.why), dbgPayload?.why);
    const consoleHost = await inPage(`(() => { const h = document.querySelector('taskwhip-console'); return h ? { closed: h.shadowRoot === null, rect: h.getBoundingClientRect().height >= 0 } : null; })()`);
    check('debug: console is on the page in a closed shadow root', consoleHost?.closed === true, JSON.stringify(consoleHost));
    await shot('8-debug-console');

    // Ask Hackie: the agent calls tools through the real service worker and answers with their data.
    const asked = await bg(`taskwhip.ask('How am I doing today?')`);
    const usedTools = (asked?.steps || []).map((st) => st.tool);
    check('agent: tool loop runs in the extension', asked?.ok && usedTools.includes('get_today_summary') && usedTools.includes('get_debug_log'), usedTools.join(', ') || asked?.error);
    check('agent: answer uses the tool results', /Slacked \d+s today/.test(asked?.answer || '') && /Tracking/.test(asked?.answer || ''), asked?.answer);
    const lastAgentReq = aiRequests.filter((r) => Array.isArray(r.body.tools) && r.body.tools.some((t) => t.function?.name === 'get_today_summary')).pop();
    check('agent: tool results went back to the model', lastAgentReq?.body.messages.filter((m) => m.role === 'tool').length === 2);
    const agentSystem = lastAgentReq?.body.messages.find((m) => m.role === 'system')?.content || '';
    check("Ask Hackie gets all of Hackie's memory", /<memory>[\s\S]*videos\.localhost[\s\S]*<\/memory>/.test(agentSystem), (agentSystem.match(/<memory>[\s\S]{0,140}/) || [''])[0]);
    check('Ask Hackie knows his mood, which sets his tone', /mood right now is (CALM|ANNOYED|ANGRY|FURIOUS)/.test(agentSystem) && /<mood>[\s\S]*"snoozesInARow"[\s\S]*<\/mood>/.test(agentSystem) && /Let the mood set your tone/.test(agentSystem), (agentSystem.match(/mood right now is \w+/) || [''])[0]);
    const chat = await bg(`chrome.storage.session.get('agentChat').then(({ agentChat }) => agentChat.length)`);
    check('agent: conversation saved for the popup', chat === 2, `${chat} messages`);

    // Memory: time on sites and the work pages actually used are remembered.
    const mem1 = await bg('taskwhip.memory()');
    check('memory: slacking time per site is remembered', mem1.sites['videos.localhost']?.slackSec > 10, `${Math.round(mem1.sites['videos.localhost']?.slackSec || 0)}s`);
    check('memory: work pages are remembered for redirects', Boolean(mem1.workPages['work.localhost/work']?.url), Object.keys(mem1.workPages).join(', '));
    check('memory: sensitive sites only appear anonymously', !JSON.stringify(mem1).includes('private.localhost') && !JSON.stringify(mem1).includes('secret'), Object.keys(mem1.sites).join(', '));

    // Habit sensitivity: a flagged slacking site gets warnings sooner.
    await bg(`taskwhip.action('resetMood')`);
    await bg(`taskwhip.flagSite('videos.localhost')`);
    await cdp.send('Page.navigate', { url: `${base}/cats2?h=1` }, pg);
    await sleep(2500);
    const habitState = await bg(`taskwhip.refresh('e2e').then(({ state, decision }) => ({ habit: state.current && state.current.habit, next: decision.nextLevelAtSec }))`);
    check('habit: flagged site warns sooner', habitState.habit?.level === 'habit' && [3.6, 9, 14.4].some((v) => Math.abs(habitState.next - v) < 0.01), JSON.stringify(habitState));

    // Per-event AI bubble: the demo nudge gets a targeted line from the (fake) model.
    await bg(`chrome.storage.local.get('settings').then(({ settings }) => { settings.ai.eventMessages = true; settings.ai.actions = { openTabs: true, closeTabs: true, closeAfterBegs: 2 }; return chrome.storage.local.set({ settings }); })`);
    await bg(`taskwhip.fire(1)`);
    let aiBubble = null;
    for (let i = 0; i < 10 && !(aiBubble && /AI-BUBBLE/.test(aiBubble.text)); i++) {
      await sleep(500);
      aiBubble = await ui('.bubble');
    }
    check('event AI: targeted line replaces the template', aiBubble && /AI-BUBBLE: I can see Cats vs cucumbers/.test(aiBubble.text), aiBubble?.text);
    await shot('9-ai-bubble');
    await clickUi('[data-act="dismiss"]');

    // Begging during lockdowns: after 2 begs Hackie closes slacking tabs and puts work in front.
    await cdp.send('Page.navigate', { url: workUrl }, pg);
    await sleep(1500);
    await cdp.send('Target.createTarget', { url: `${base}/cats2?beg=2`, background: true });
    await cdp.send('Target.createTarget', { url: `${base}/cats2?beg=1` });
    await sleep(2500);
    await bg(`chrome.tabs.query({}).then((ts) => chrome.tabs.update(ts.find((t) => t.url.includes('beg=1')).id, { active: true }))`);
    await sleep(1500);
    await bg('taskwhip.setStreak(30)');
    await sleep(1200);
    const lockState = await bg('taskwhip.state()');
    check('beg test: lockdown fired', lockState.lastFire?.level === 3, `level ${lockState.lastFire?.level}`);
    await bg(`taskwhip.action('snooze')`);
    const afterBeg1 = await bg(`chrome.tabs.query({}).then((ts) => ts.filter((t) => t.url.includes('beg=')).length)`);
    check('beg 1: no tabs closed yet', afterBeg1 === 2, `${afterBeg1} slacking tabs`);
    // Second beg (the lockdown button is the snooze action while the last warning was a lockdown).
    await bg(`taskwhip.action('snooze')`);
    let tabsNow = [];
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      tabsNow = await bg(`chrome.tabs.query({}).then((ts) => ts.map((t) => ({ url: t.url, active: t.active })))`);
      if (!tabsNow.some((t) => t.url.includes('beg='))) break;
    }
    const begState = await bg('taskwhip.state()');
    check('beg 2: Hackie closed the slacking tabs', !tabsNow.some((t) => t.url.includes('beg=')), tabsNow.map((t) => t.url.replace(/^http:\/\//, '')).join(' | '));
    check('beg 2: the work tab is in front, and was not closed', tabsNow.some((t) => t.url === workUrl && t.active), `begs ${begState.lockdownBegs}`);
    check('beg 2: no duplicate work tab was opened', tabsNow.filter((t) => t.url === workUrl).length === 1, tabsNow.filter((t) => t.url === workUrl).length + ' work tabs');
    const closedList = await bg(`chrome.storage.local.get('closedByHackie').then((r) => r.closedByHackie || [])`);
    check('closed tabs are restorable', closedList.filter((t) => t.url.includes('beg=')).length === 2, `${closedList.length} saved`);
    const mem2 = await bg('taskwhip.memory()');
    check('memory: the enforcement is logged as an incident', mem2.incidents.some((i) => i.kind === 'enforced' && i.closed === 2), JSON.stringify(mem2.incidents.slice(-2)));
    const restored = await bg('taskwhip.restore()');
    await sleep(1500);
    const afterRestore = await bg(`chrome.tabs.query({}).then((ts) => ts.filter((t) => t.url.includes('beg=')).length)`);
    check('restore brings the tabs back', restored.restored === 2 && afterRestore === 2, `${afterRestore} tabs`);
    await bg(`chrome.tabs.query({}).then((ts) => chrome.tabs.remove(ts.filter((t) => t.url.includes('beg=')).map((t) => t.id)))`);
    await bg(`taskwhip.action('resetMood')`);

    // Angry Hackie refuses clicks: angry -> the AI decides; furious -> refused outright.
    const restoreJudge = await bg(`taskwhip.judge('restore', null)`);
    check('anger: Restore is locked right after Hackie closed tabs', restoreJudge.allow === false && /DENIED-BY-AI/.test(restoreJudge.message), restoreJudge.message);
    await cdp.send('Page.navigate', { url: `${base}/cats2?angry=1` }, pg);
    await sleep(2500);
    await bg(`taskwhip.action('resetMood')`);
    for (let i = 0; i < 3; i++) await bg(`taskwhip.action('snooze')`); // 3 snoozes in a row: angry
    await bg(`taskwhip.state().then((s) => { s.snoozeUntil = 0; s.lastExerciseAt = 0; return chrome.storage.session.set({ state: s }); })`);
    const angerNow = await bg('taskwhip.anger()');
    check('anger: 3 snoozes in a row make Hackie angry', angerNow.level === 2, `${angerNow.label}: ${angerNow.reasons.join(', ')}`);
    await bg('taskwhip.refresh("e2e")');
    await bg('taskwhip.fire(1)');
    await sleep(800);
    const snoozeBefore = (await bg('taskwhip.state()')).snoozeUntil;
    await clickUi('[data-act="snooze"]');
    let refused = null;
    for (let i = 0; i < 12 && !(refused && /DENIED-BY-AI/.test(refused.text)); i++) {
      await sleep(400);
      refused = await ui('.bubble');
    }
    check('angry: the AI refuses the snooze, angrily', refused && /DENIED-BY-AI: no a few more minutes/.test(refused.text) && /Request denied/i.test(refused.text), refused?.text);
    check('angry: the refused button is crossed out', refused && /Snooze denied/.test(refused.text));
    const snoozeAfter = (await bg('taskwhip.state()')).snoozeUntil;
    check('angry: no snooze was granted', snoozeAfter === snoozeBefore, `${snoozeBefore} -> ${snoozeAfter}`);
    await shot('10-refused');
    const exJudge = await bg(`taskwhip.judge('exercise', null)`);
    check('angry: an exercise break is still allowed', exJudge.allow === true, exJudge.message);
    await bg(`taskwhip.state().then((s) => { s.lastExerciseAt = Date.now(); return chrome.storage.session.set({ state: s }); })`);
    const exAgain = await bg(`taskwhip.judge('exercise', null)`);
    check('angry: a second exercise within 10 minutes is refused', exAgain.allow === false, exAgain.message);

    // Furious: begging twice. "It's for my task" is refused by the rules (the AI only writes the speech).
    await bg(`taskwhip.state().then((s) => { s.lockdownBegs = 2; s.lastExerciseAt = 0; return chrome.storage.session.set({ state: s }); })`);
    const furious = await bg('taskwhip.anger()');
    check('anger: begging twice makes Hackie furious', furious.level === 3, furious.label);
    const isWorkJudge = await bg(`taskwhip.judge('isWork', null)`);
    check('furious: "It\'s for my task" is refused', isWorkJudge.allow === false && /DENIED-BY-AI/.test(isWorkJudge.message), isWorkJudge.message);
    const overridesAfter = await bg(`chrome.storage.local.get('overrides').then((r) => Object.keys((r.overrides || {}).pages || {}))`);
    check('furious: the refused override was not saved', !overridesAfter.some((k) => k.includes('angry=1')), overridesAfter.join(', '));
    await bg(`taskwhip.state().then((s) => { s.lockdownBegs = 0; s.snoozeCount = 0; s.lastEnforcedAt = 0; return chrome.storage.session.set({ state: s }); })`);
    await bg(`chrome.storage.local.set({ restoreLockedUntil: 0 })`);
    const calmJudge = await bg(`taskwhip.judge('snooze', null)`);
    check('calm: clicks go straight through', calmJudge.allow === true);

    // Seed a believable week so the popup/report screenshots show charts.
    await bg(`(async () => {
      const seed = [[3.1, 1.2], [4.5, 0.6], [2.2, 2.4], [5.0, 0.4], [3.8, 0.9], [1.5, 1.8]];
      const writes = {};
      for (let i = 0; i < seed.length; i++) {
        const d = new Date(); d.setDate(d.getDate() - (seed.length - i));
        const [w, sl] = seed[i];
        writes['day:' + d.toLocaleDateString('sv')] = {
          totals: { work: w * 3600, slack: sl * 3600, neutral: 1200 },
          domains: { 'github.com': { work: w * 2400, slack: 0, neutral: 0, lastCategory: 'work' }, 'youtube.com': { work: 0, slack: sl * 2600, neutral: 0, lastCategory: 'slack' }, 'instagram.com': { work: 0, slack: sl * 1000, neutral: 0, lastCategory: 'slack' }, 'docs.google.com': { work: w * 1200, slack: 0, neutral: 0, lastCategory: 'work' } },
          events: { nudges: 3 + i, whips: i % 3, blocks: i % 2, snoozes: 1, comebacks: 2 + (i % 2) },
        };
      }
      await chrome.storage.local.set(writes);
    })()`);

    // Leave the main tab on a slacking video for the popup screenshot.
    await cdp.send('Page.navigate', { url: `${base}/cats2` }, pg);
    await sleep(2500);
    await bgState();

    const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
    const { targetId: popId } = await cdp.send('Target.createTarget', { url: popupUrl, newWindow: true, background: true });
    const { sessionId: pop } = await cdp.send('Target.attachToTarget', { targetId: popId, flatten: true });
    await cdp.send('Page.enable', {}, pop);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 372, height: 900, deviceScaleFactor: 2, mobile: false }, pop);
    await cdp.send('Page.reload', {}, pop);
    await sleep(1800);
    const popupStatus = await evalIn(pop, `document.getElementById('status').textContent`);
    check('popup reports the current site', /Slacking on videos\.localhost/.test(popupStatus), popupStatus);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, pop);
    await sleep(300);
    const popHeight = await evalIn(pop, 'Math.ceil(document.body.getBoundingClientRect().height)');
    check("popup fits in Chrome's 600px popup limit", popHeight <= 600, `${popHeight}px`);
    await shot('4-popup-light', pop, { clip: { x: 0, y: 0, width: 372, height: popHeight, scale: 1 } });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, pop);
    await sleep(400);
    await shot('5-popup-dark', pop, { clip: { x: 0, y: 0, width: 372, height: popHeight, scale: 1 } });

    // Furious Hackie in the popup: the pill, and it still fits.
    await bg(`taskwhip.state().then((s) => { s.lockdownBegs = 2; return chrome.storage.session.set({ state: s }); })`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, pop);
    await cdp.send('Page.reload', {}, pop);
    await sleep(1500);
    const pill = await evalIn(pop, `(() => { const a = document.getElementById('anger'); return a && !a.hidden ? document.getElementById('angerPill').textContent : ''; })()`);
    check('popup: furious Hackie shows the anger pill', /FURIOUS/.test(pill), pill);
    const angryHeight = await evalIn(pop, 'Math.ceil(document.body.getBoundingClientRect().height)');
    check('popup: still fits in 600px when furious', angryHeight <= 600, `${angryHeight}px`);
    await shot('4b-popup-furious', pop, { clip: { x: 0, y: 0, width: 372, height: angryHeight, scale: 1 } });
    await bg(`taskwhip.state().then((s) => { s.lockdownBegs = 0; return chrome.storage.session.set({ state: s }); })`);

    for (const [name, path] of [
      ['6-options', 'options/options.html'],
      ['7-report', 'report/report.html'],
    ]) {
      await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/${path}` }, pop);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, pop);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }, pop);
      await sleep(1500);
      const h = await evalIn(pop, 'document.documentElement.scrollHeight');
      await shot(name, pop, { clip: { x: 0, y: 0, width: 1100, height: h, scale: 1 }, captureBeyondViewport: true });
    }
    const reportKpis = await evalIn(pop, `document.getElementById('kpis').textContent`);
    check('report page renders', /Working/.test(reportKpis), reportKpis.slice(0, 80));

    check('pages never logged extension-file loads ("Unsafe attempt to load URL")', extLoadLogs.length === 0, extLoadLogs.slice(0, 2).join(' | '));
    const errors = await bg('self.__errors || []');
    if (errors.length) console.log('      SW errors:', errors);
  } catch (err) {
    check('no unexpected errors', false, err.stack || err.message);
    if (stderr) console.log(stderr.slice(-2000));
  } finally {
    try {
      await cdp.send('Browser.close');
    } catch {
      proc.kill();
    }
    server.close();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold files on Windows */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main();
