// TaskWhip content script: reads the page for the service worker and renders Hackie, the FH26 robot.
// Runs in every top-level http(s) page. All UI lives in a shadow root so page CSS can't touch it.
(() => {
  if (window.top !== window) return;

  const previous = window.__taskwhip;
  if (previous && previous.isAlive()) return;
  try {
    previous?.destroy();
  } catch {
    /* orphaned instance from an extension reload */
  }

  const runtime = chrome.runtime;
  // shared/mascot.js normally runs first. If it didn't (Chrome reads content.js from disk on every
  // page load but keeps the old manifest until the extension is reloaded), degrade instead of crashing.
  const Hackie =
    globalThis.Hackie ||
    (console.warn('[TaskWhip] Hackie\'s mascot module is missing. Reload the extension at chrome://extensions.'),
    { html: () => '', moodForLevel: (l) => ['stern', 'worried', 'angry', 'furious'][l] || 'stern', IDLE_MOODS: ['happy'] });
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Hackie's art comes from the service worker as data: URLs (this page never loads extension
  // files). Draw him once it has arrived; one retry if the worker was still waking up.
  // Everything that draws Hackie (walker, lockdown, debug console) waits for artLoaded.
  let artReady = Hackie.hasArt ? Hackie.hasArt() : true;
  const getArt = () => send({ type: 'hackie:art' }).then((art) => (art && !art.error ? art : null));
  const artLoaded = artReady
    ? Promise.resolve()
    : getArt()
        .then((art) => art || new Promise((r) => setTimeout(r, 1000)).then(getArt))
        .then((art) => {
          if (art) {
            Hackie.useArt(art);
            // The team's font (Inter ExtraBold) as "HackieInter", from the bytes in the art payload.
            Hackie.installFont?.();
          } else console.warn("[TaskWhip] Could not load Hackie's art. Reload the extension at chrome://extensions.");
          artReady = true;
          faceKey = '';
          render();
        });

  function alive() {
    try {
      return Boolean(runtime?.id);
    } catch {
      return false;
    }
  }

  function send(msg) {
    if (!alive()) {
      destroy();
      return Promise.resolve(null);
    }
    try {
      return runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // -------------------------------------------------------------------------
  // Page reader

  function clean(s, n) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  }

  function textOf(selector, n = 300) {
    const el = document.querySelector(selector);
    return el ? clean(el.textContent, n) : '';
  }

  function meta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return clean(el?.getAttribute('content'), 400);
  }

  function isMediaPlaying() {
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused && !m.ended && m.readyState > 2) return true;
    }
    return false;
  }

  function mainText(n) {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    if (!root) return '';
    return clean(root.innerText, n);
  }

  function readPage() {
    const host = location.hostname.replace(/^www\./, '');
    const ctx = {
      url: location.href,
      title: clean(document.title, 300),
      description: meta('description') || meta('og:description'),
      keywords: meta('keywords'),
      siteName: meta('og:site_name'),
      h1: textOf('h1'),
      videoTitle: '',
      channel: '',
      format: '',
      excerpt: '',
      mediaPlaying: isMediaPlaying(),
      // Web proxies often keep the original site in these, which helps spot proxied pages.
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      ogUrl: meta('og:url'),
      baseHref: document.querySelector('base[href]')?.href || '',
    };
    if (/(^|\.)youtube\.com$/.test(host)) {
      ctx.videoTitle = textOf('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1');
      ctx.channel = textOf('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a', 120);
      if (location.pathname.startsWith('/shorts')) ctx.format = 'YouTube Shorts';
      else if (location.pathname === '/watch') ctx.format = 'video';
      else if (location.pathname === '/' || location.pathname === '/feed/subscriptions') ctx.format = 'feed';
    } else if (/(^|\.)instagram\.com$/.test(host)) {
      if (/^\/reels?\//.test(location.pathname)) ctx.format = 'Instagram Reels';
      else if (location.pathname === '/') ctx.format = 'feed';
    } else if (/(^|\.)tiktok\.com$/.test(host)) {
      ctx.format = 'short video';
    }
    ctx.excerpt = mainText(600);
    return ctx;
  }

  let lastSig = '';
  let reportTimer = 0;
  function scheduleReport(delay = 600) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(report, delay);
  }
  function report() {
    const ctx = readPage();
    const sig = JSON.stringify([ctx.url, ctx.title, ctx.videoTitle, ctx.channel, ctx.mediaPlaying]);
    if (sig === lastSig) return;
    lastSig = sig;
    send({ type: 'page:context', ctx });
  }

  // SPA navigation (YouTube, Instagram...) doesn't reload the page; watch URL and title.
  let lastUrl = location.href;
  let lastTitle = document.title;
  const navWatcher = setInterval(() => {
    if (!alive()) return destroy();
    if (location.href !== lastUrl || document.title !== lastTitle) {
      lastUrl = location.href;
      lastTitle = document.title;
      scheduleReport(1200);
    }
  }, 1000);
  const onMedia = () => scheduleReport(300);
  const onYtNav = () => scheduleReport(800);
  const onVisibility = () => render();
  document.addEventListener('play', onMedia, true);
  document.addEventListener('pause', onMedia, true);
  document.addEventListener('playing', onMedia, true);
  document.addEventListener('yt-navigate-finish', onYtNav);
  document.addEventListener('visibilitychange', onVisibility);

  // -------------------------------------------------------------------------
  // UI: Hackie walks the edges of the screen on slacking sites (the team's patrol), with a
  // timer pill, nudge/whip bubbles, a click-for-report panel, and the full-screen lockdown.

  const HK = 100; // Hackie's box: the team's 50x48 sprite crop at exactly 2x (crisp pixels)
  const EDGE = 8;
  const SPEED = 20; // px per second along the edge (slow stroll)
  const HOVER_RADIUS = 130; // mouse this close -> Hackie stops and gets curious
  const SIDE_GAP = 8;
  const EXPRESSION_EVERY_MS = 6000;
  const DRAG_THRESHOLD = 5; // px the pointer must move before a press on Hackie becomes a drag
  const GLIDE_MS = 350; // after a drop, how long Hackie takes to slide back to the nearest edge
  const MOOD_LABEL = {
    happy: 'Happy 😊', wink: 'Winking 😉', surprised: 'Surprised 😮', sleepy: 'Sleepy 💤', silly: 'Silly 🤪',
    cool: 'Feeling cool 😎', love: 'In love 💕', curious: 'Curious ❓', stern: 'Watching 🤨',
    worried: 'Worried 😟', angry: 'Angry 💢', furious: 'Angry mom 🤬',
  };

  // The team's look: flat teal (#247287) bubbles, pill and panels with white Inter ExtraBold,
  // translucent white buttons, no borders or shadows. Same in light and dark mode.
  const FONT_STACK = '"HackieInter", Inter, ui-sans-serif, system-ui, sans-serif';
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font-family: ${FONT_STACK}; font-weight: 800; font-size: 14px; line-height: 1.4; color: #fff;
  -webkit-font-smoothing: antialiased;
  --teal: #247287; --glass: rgba(255,255,255,.2); --glass-hi: rgba(255,255,255,.35);
  --soft: rgba(255,255,255,.85); --dim: rgba(255,255,255,.72);
}
b, strong, h2, h3 { font-weight: 800; }
button { font: inherit; }

/* Hackie + whatever is next to him */
.walker { position: absolute; left: 0; top: 0; width: ${HK}px; height: ${HK}px; will-change: transform; }
.walker[hidden] { display: none; }
.hk-box {
  position: absolute; inset: 0; pointer-events: auto; cursor: grab; --hk-badge-size: 20px;
  animation: bob 1.4s ease-in-out infinite; appearance: none; border: 0; padding: 0; background: none;
  touch-action: none; user-select: none; -webkit-user-select: none;
}
.hk-box[data-grabbed] { cursor: grabbing; animation: none; }
.hk-box:focus-visible { outline: 2px solid var(--teal); outline-offset: 4px; border-radius: 8px; }
.hk-furious .hk-sprite { animation: shake .35s linear infinite; }
.hk-whip { transform-box: view-box; transform-origin: 15px 64px; }
.side { position: absolute; top: 0; pointer-events: auto; }
.side:empty { display: none; }

/* countdown pill: teal, white; warnings get a white ring instead of a color change */
.pill {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; padding: 5px 12px; border-radius: 14px;
  background: var(--teal); color: #fff; border: 0; box-shadow: none; font-size: 14px; font-weight: 800;
  font-variant-numeric: tabular-nums; cursor: pointer;
}
.pill .site { color: var(--dim); }
.pill.warn { outline: 2px solid rgba(255,255,255,.45); outline-offset: -2px; }
.pill.hot, .pill.angry { outline: 2px solid #fff; outline-offset: -2px; }
.pill.hot .site, .pill.angry .site { color: #fff; }

/* speech bubble (nudge, whip, refusal, cheer) */
.bubble {
  position: relative; width: min(320px, calc(100vw - ${HK + 3 * EDGE}px)); background: var(--teal); color: #fff;
  border: 0; border-radius: 12px; padding: 12px 14px; box-shadow: none; font-size: 14px; line-height: 1.4;
}
.bubble.cheer { width: max-content; max-width: min(260px, calc(100vw - ${HK + 3 * EDGE}px)); }
.enter { animation: pop-in .35s cubic-bezier(.2,1.4,.4,1); }
.tag {
  font-size: 11px; letter-spacing: .07em; text-transform: uppercase;
  color: var(--dim); margin-bottom: 6px; padding-right: 22px;
}
.msg { margin: 0 0 8px; font-size: 14px; text-wrap: pretty; }
.exercise { margin: 0 0 10px; font-size: 13px; color: var(--soft); }
.exercise b { color: #fff; }
.crack {
  display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 4px; background: var(--glass);
  color: #fff; letter-spacing: .04em; transform: rotate(-5deg);
}
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.btn {
  appearance: none; font: inherit; font-size: 13px; border: 0; border-radius: 6px; padding: 5px 10px;
  background: var(--glass); color: #fff; cursor: pointer; transition: background .15s, transform .1s;
}
.btn:hover { background: var(--glass-hi); }
.btn:active { transform: scale(.97); }
.btn.primary { background: #fff; color: var(--teal); }
.btn.primary:hover { background: rgba(255,255,255,.86); }
.btn.ghost { background: rgba(255,255,255,.1); color: var(--soft); }
.btn.ghost:hover { background: var(--glass); color: #fff; }
.btn:disabled, .btn:disabled:hover { opacity: .45; cursor: not-allowed; transform: none; background: var(--glass); }
.btn.primary:disabled { background: #fff; }
.btn.denied, .btn.denied:hover { text-decoration: line-through; opacity: .55; cursor: not-allowed; background: rgba(255,255,255,.1); }
.btn:focus-visible, .link:focus-visible, .x:focus-visible, .pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.x {
  position: absolute; top: 9px; right: 9px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px;
  background: none; color: #fff; font-size: 13px; line-height: 22px; text-align: center; cursor: pointer;
}
.x:hover { background: var(--glass); }

/* report panel (click Hackie): the team's "Hackie's report" */
.panel {
  position: relative; width: min(280px, calc(100vw - ${HK + 3 * EDGE}px)); background: var(--teal); color: #fff;
  border: 0; border-radius: 12px; padding: 12px 14px; box-shadow: none; font-size: 13px; line-height: 1.4;
}
.panel h3 { margin: 0; font-size: 14px; line-height: 22px; padding-right: 26px; }
.rows { display: grid; grid-template-columns: auto 1fr; gap: 7px 10px; margin-top: 7px; font-size: 13px; }
.rows span { color: #fff; }
.rows b { text-align: right; font-variant-numeric: tabular-nums; }
.note { margin: 8px 0 0; font-size: 12px; color: var(--soft); }
.panel .actions { margin-top: 10px; }
.panel > .x { top: 12px; right: 10px; }
.demo { display: block; margin-top: 10px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,.6); font-size: 12px; color: #fff; }
.demo input { width: 100%; margin: 4px 0 0; accent-color: #fff; }

/* red vignette on whip */
.flash { position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse at center, rgba(229,72,77,0) 40%, rgba(229,72,77,.6) 100%); }

/* lockdown: the teal panel on a dark, blurred page */
.block {
  position: absolute; inset: 0; pointer-events: auto; display: grid; place-items: center;
  background: rgba(8, 20, 24, .78); backdrop-filter: blur(7px); padding: 110px 16px 16px;
  animation: fade-in .3s ease; overflow: auto;
}
.block[hidden] { display: none; }
.block .panel {
  width: min(460px, 100%); text-align: center; padding: 26px 28px 20px; border-radius: 12px; font-size: 14px;
  animation: pop-in .42s cubic-bezier(.2,1.4,.4,1);
}
.block .big { width: 150px; height: 150px; /* 3x the 50px-wide crop */ margin: -112px auto 6px; --hk-badge-size: 30px; }
.block .tag { padding: 0; }
.block h2 { font-size: 26px; line-height: 1.15; margin: 0 0 8px; text-wrap: balance; }
.block .msg { font-size: 16px; color: var(--soft); margin: 0; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 18px 0 16px; }
.stat { border: 0; border-radius: 10px; padding: 10px 8px; background: rgba(255,255,255,.14); }
.stat span { display: block; font-size: 12px; color: var(--soft); }
.stat b { font-size: 22px; font-variant-numeric: tabular-nums; }
.stat.slack b { color: #ffc2b8; }
.stat.work b { color: #aef2cb; }
.block .btn { width: 100%; padding: 11px; font-size: 14px; margin-top: 8px; border-radius: 8px; }
.link {
  appearance: none; background: none; border: 0; font: inherit; font-size: 12.5px; color: var(--soft);
  text-decoration: underline; text-underline-offset: 3px; margin-top: 12px; cursor: pointer; padding: 4px;
}
.link:hover { color: #fff; }
.link:disabled { opacity: .45; cursor: not-allowed; }

.toast {
  position: absolute; left: 50%; bottom: 26px; max-width: min(520px, calc(100vw - 32px));
  background: var(--teal); color: #fff; padding: 10px 16px; border-radius: 12px; border: 0; box-shadow: none;
  font-size: 14px; pointer-events: none; animation: toast var(--toast-ms, 3200ms) ease forwards;
  text-align: center; line-height: 1.4;
}
.typing { display: inline-flex; gap: 3px; margin-left: 6px; vertical-align: middle; }
.typing i { width: 5px; height: 5px; border-radius: 50%; background: #fff; opacity: .35; animation: blink 1s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 50% { opacity: 1; } }
.ai-line { animation: fade-in .4s ease; }
.deciding { display: block; margin: -4px 0 8px; font-size: 12.5px; color: var(--soft); }
.bubble.refused { animation: shake .35s linear 2; }

/* replying to Hackie */
.reply { display: flex; gap: 6px; margin-top: 10px; }
.reply input {
  flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 0;
  background: var(--glass); color: #fff;
}
.reply input::placeholder { color: rgba(255,255,255,.7); opacity: 1; }
.reply input:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.reply input:disabled { opacity: .6; }
.reply .btn { flex: none; }
.block .reply { margin-top: 14px; }
.block .reply .btn { width: auto; margin-top: 0; padding: 5px 14px; font-size: 13px; border-radius: 6px; }
.you { margin: 0 0 6px; font-size: 12.5px; color: var(--dim); font-style: italic; }
.reply-note, .reply-error { margin: 8px 0 0; font-size: 12.5px; color: var(--soft); }
.reply-error { color: #fff; background: rgba(0,0,0,.18); padding: 4px 8px; border-radius: 6px; }
.reply + .deciding { margin: 6px 0 0; }

@keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
@keyframes shake { 0%, 100% { transform: translateX(0) rotate(0); } 25% { transform: translateX(-2px) rotate(-3deg); } 75% { transform: translateX(2px) rotate(3deg); } }
@keyframes pop-in { from { opacity: 0; transform: scale(.6) translateY(24px); } to { opacity: 1; transform: none; } }
@keyframes fade-in { from { opacity: 0; } }
@keyframes toast {
  0% { opacity: 0; transform: translate(-50%, 10px); }
  10%, 85% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .hk-box, .hk-furious .hk-sprite, .enter, .block, .block .panel, .bubble.refused, .ai-line { animation: none; }
}
`;

  const ui = { host: null, root: null, layer: null, walker: null, hk: null, side: null, panel: null, block: null, flash: null };
  let status = null; // last status from the service worker (with receivedAt)
  let nag = null; // the nudge/whip being shown, until answered
  let lastFire = null;
  let cheer = { until: 0, text: '' };
  let panelOpen = false;
  let expr = 'happy'; // random idle expression
  let hovering = false;
  let mouse = { x: -9999, y: -9999 };
  let u = 0.5; // position along the screen's perimeter, 0..1 (0.5 = bottom-right corner)
  let dir = 1;
  let pauseUntil = 0;
  let speedFactor = 1;
  let pos = { x: 0, y: 0 };
  let rafId = 0;
  let lastFrame = 0;
  let tickTimer = 0;
  let exprTimer = 0;
  let begTimer = 0;
  let mediaGuard = 0;
  let faceKey = '';
  let sideKey = '';
  let placeKey = '';
  let demoDragging = false;
  let press = null; // pointer pressed on Hackie: { id, x, y, px, py } (a click until it moves)
  let dragging = false; // Hackie is being carried around by the pointer
  let lastDragEnd = 0; // when the last drag ended (so the drop isn't also a click)
  let glide = null; // { from, t0 }: sliding back to the patrol edge after a drop

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function clock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function duration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  function ensureUI() {
    if (ui.host?.isConnected) return;
    const host = document.createElement('taskwhip-hackie');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }
    const layer = document.createElement('div');
    layer.className = 'layer';
    layer.innerHTML =
      '<div class="flash"></div>' +
      '<div class="block" hidden></div>' +
      '<div class="walker" hidden>' +
      '<button class="hk-box" type="button" aria-label="Hackie. Click for Hackie\'s report."></button>' +
      '<div class="side" aria-live="polite"></div>' +
      '<div class="side panel-wrap"></div>' +
      '</div>';
    root.appendChild(layer);
    (document.documentElement || document.body).appendChild(host);
    Object.assign(ui, {
      host,
      root,
      layer,
      flash: layer.querySelector('.flash'),
      block: layer.querySelector('.block'),
      walker: layer.querySelector('.walker'),
      hk: layer.querySelector('.hk-box'),
      side: layer.querySelector('.side'),
      panel: layer.querySelector('.panel-wrap'),
    });
    pos = perimeterPoint(u);
    layer.addEventListener('click', onClick);
    layer.addEventListener('submit', onReplySubmit);
    for (const type of ['keydown', 'keyup', 'keypress']) {
      layer.addEventListener(type, (e) => {
        if (e.target?.closest?.('form.reply')) e.stopPropagation();
      });
    }
    ui.panel.addEventListener('input', onDemoInput);
    ui.panel.addEventListener('change', () => (demoDragging = false));
    ui.hk.addEventListener('pointerdown', onPressHackie);
    ui.hk.addEventListener('pointermove', onDragHackie);
    ui.hk.addEventListener('pointerup', onDropHackie);
    ui.hk.addEventListener('pointercancel', onDropHackie);
    ui.hk.addEventListener('lostpointercapture', onDropHackie);
  }

  // ---- replying to Hackie (the AI judge may reconsider) --------------------------

  let replying = false;
  let blockRefused = null; // the click refused on the lockdown screen, if any
  const canReply = (m) => Boolean(m?.canReply ?? status?.canReply);

  function replyFormHtml(m, where) {
    if (!canReply(m)) return '';
    if (m.replyClosed) return `<p class="reply-note">${escapeHtml(m.replyClosed)}</p>`;
    const pending = Boolean(m.replyPending);
    return (
      `<form class="reply" data-reply="${where}">` +
      `<input name="say" type="text" maxlength="300" autocomplete="off" spellcheck="true" placeholder="Reply to Hackie…" aria-label="Reply to Hackie"${pending ? ' disabled' : ''}>` +
      `<button class="btn" type="submit"${pending ? ' disabled' : ''}>Reply</button></form>` +
      (pending ? `<span class="deciding" role="status">Hackie is reconsidering…${TYPING}</span>` : '') +
      (m.replyError ? `<p class="reply-error" role="alert">${escapeHtml(m.replyError)}</p>` : '')
    );
  }

  // Lockdown screen: swap its reply area in place.
  function setBlockReply(state) {
    const old = ui.block?.querySelector('.reply-area');
    if (!old) return;
    old.innerHTML = replyFormHtml({ canReply: true, ...state }, 'block');
  }

  async function onReplySubmit(e) {
    const form = e.target?.closest?.('form.reply');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('input');
    const text = (input?.value || '').trim();
    if (!text || replying) return;
    const where = form.dataset.reply;
    const refused = where === 'nag' ? (nag?.refusedAt ? nag.denied?.[nag.denied.length - 1] : null) : blockRefused;
    const said = where === 'nag' ? nag?.message : ui.block?.querySelector('.msg')?.textContent;
    replying = true;
    if (where === 'nag' && nag) {
      nag = { ...nag, replyPending: true, replyError: '', youSaid: text };
      sideKey = '';
      render();
    } else {
      setBlockReply({ replyPending: true });
    }
    const res = await send({ type: 'appeal:send', text, kind: refused ? 'refusal' : 'warning', action: refused, said });
    replying = false;
    if (!res?.ok) {
      const error = res?.error || "Hackie couldn't hear you. Try again.";
      if (where === 'nag' && nag) {
        nag = { ...nag, replyPending: false, replyError: error };
        sideKey = '';
        render();
        const again = ui.side.querySelector('form.reply input');
        if (again) again.value = text;
      } else {
        setBlockReply({ replyError: error });
        const again = ui.block?.querySelector('form.reply input');
        if (again) again.value = text;
      }
      return;
    }
    if (res.reconsidered) {
      // Hackie changed his mind: the warning (or lockdown) goes away and he says so.
      nag = null;
      hideBlock();
      setPanel(false);
      showCheer(res.message);
      return;
    }
    // Not convinced: Hackie answers in the same bubble (and the box is cleared for the next try).
    if (where === 'nag' && nag) {
      const sent = ui.side.querySelector('form.reply input');
      if (sent) sent.value = '';
      nag = {
        ...nag,
        message: res.message,
        youSaid: text,
        replyPending: false,
        replyError: '',
        replyClosed: res.final ? "Hackie has stopped listening to excuses about this page." : '',
        aiDone: true,
        aiPending: false,
      };
      sideKey = '';
      render();
    } else if (ui.block && !ui.block.hidden) {
      const msgEl = ui.block.querySelector('.msg');
      if (msgEl) {
        msgEl.textContent = res.message;
        msgEl.classList.add('ai-line');
      }
      let you = ui.block.querySelector('.you');
      if (!you) {
        you = document.createElement('p');
        you.className = 'you';
        msgEl?.before(you);
      }
      you.textContent = `You: "${text}"`;
      setBlockReply({ replyClosed: res.final ? "Hackie has stopped listening to excuses about this page." : '' });
      if (lastFire?.effects?.sound) playCrack();
    }
  }

  function onClick(e) {
    const target = e.target.closest('[data-act]');
    if (target && !target.disabled) {
      act(target.dataset.act);
      return;
    }
    if (e.target.closest('.hk-box')) {
      if (dragging || performance.now() - lastDragEnd < 300) return; // the end of a drag, not a click
      setPanel(!panelOpen);
    } else if (e.target.closest('.pill')) setPanel(!panelOpen);
  }

  function liveStreak() {
    if (!status) return 0;
    const paused = status.snoozedUntil && Date.now() < status.snoozedUntil;
    return status.streakSec + (paused ? 0 : (Date.now() - status.receivedAt) / 1000);
  }

  function snoozedLeft() {
    return status?.snoozedUntil ? Math.max(0, (status.snoozedUntil - Date.now()) / 1000) : 0;
  }

  // ---- what to show ---------------------------------------------------------

  function onSlack() {
    return status?.category === 'slack';
  }

  function shouldShow() {
    if (document.hidden || !ui.block?.hidden) return false;
    if (nag || cheer.until > Date.now()) return true;
    return onSlack() && status.chip !== false;
  }

  function sideMode() {
    if (nag) return 'nag';
    if (cheer.until > Date.now()) return 'cheer';
    if (onSlack() && snoozedLeft() > 0) return 'snooze';
    if (onSlack()) return 'timer';
    return 'none';
  }

  function currentMood() {
    if (nag) return nag.mood || Hackie.moodForLevel(nag.level);
    if ((status?.snoozeCount || 0) > 3) return 'furious'; // the angry mom stays until you move
    if (hovering) return 'curious';
    if (cheer.until > Date.now()) return 'happy';
    if (onSlack() && status.level >= 2) return 'angry';
    return expr;
  }

  // ---- render ---------------------------------------------------------------

  function render() {
    if (!artReady) return; // drawn as soon as the art arrives
    // Don't build anything on pages where Hackie has nothing to do.
    if (!ui.host?.isConnected && !(nag || cheer.until > Date.now() || onSlack())) return;
    ensureUI();
    const show = shouldShow();
    ui.walker.hidden = !show;
    if (!show) {
      if (press) dropHackie(press.id, false); // e.g. the lockdown came up mid-drag
      stopLoops();
      return;
    }
    startLoops();

    const mood = currentMood();
    const whip = mood === 'angry' || mood === 'furious' || (nag && nag.level >= 2);
    const fk = `${mood}:${whip}`;
    if (fk !== faceKey) {
      faceKey = fk;
      ui.hk.innerHTML = Hackie.html({ mood, whip });
    }

    const mode = sideMode();
    const sk = `${mode}:${nag?.at || ''}:${cheer.until}:${status?.snoozeCount || 0}:${status?.level || 0}`;
    if (sk !== sideKey) {
      sideKey = sk;
      placeKey = '';
      renderSide(mode);
    }
    updateTimers();
    if (panelOpen) renderPanel();
  }

  function messageHtml(message) {
    const m = String(message || '');
    if (m.startsWith('*CRACK*')) return `<span class="crack">CRACK!</span>${escapeHtml(m.replace(/^\*CRACK\*\s*/, ''))}`;
    return escapeHtml(m);
  }

  function renderSide(mode) {
    // Keep whatever the user was typing to Hackie across re-renders.
    const draftEl = ui.side.querySelector('form.reply input');
    const draft = draftEl?.value || '';
    const draftFocused = Boolean(draftEl && ui.root.activeElement === draftEl);
    renderSideInner(mode);
    const fresh = ui.side.querySelector('form.reply input');
    if (fresh && draft && !fresh.value) fresh.value = draft;
    if (fresh && draftFocused) fresh.focus({ preventScroll: true });
  }

  function renderSideInner(mode) {
    if (panelOpen) {
      ui.side.innerHTML = '';
      return;
    }
    if (mode === 'nag') {
      const m = nag;
      const angry = m.mood === 'angry' || m.mood === 'furious';
      const tag = m.refusedTag || (m.test ? `Test ${m.levelName}` : `${m.levelName} · ${m.minutesText} on ${m.site}`);
      const denied = new Set(m.denied || []);
      const btn = (act, cls, label, title = '') => {
        const off = m.deciding || denied.has(act) || (act === 'snooze' && denied.has('beg'));
        return `<button class="btn ${cls}${denied.has(act) ? ' denied' : ''}" data-act="${act}"${off ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</button>`;
      };
      ui.side.innerHTML =
        `<div class="bubble lvl-${m.level}${angry ? ' angry' : ''}${m.refusedAt ? ' refused' : ' enter'}" role="alertdialog" aria-label="Hackie says">` +
        `<div class="tag">${escapeHtml(tag)}</div>` +
        (m.youSaid ? `<p class="you">You: "${escapeHtml(m.youSaid)}"</p>` : '') +
        `<p class="msg${m.aiDone ? ' ai-line' : ''}">${messageHtml(m.message)}${m.aiPending && !m.aiDone ? TYPING : ''}</p>` +
        (m.deciding ? `<span class="deciding" role="status">Hackie is deciding…${TYPING}</span>` : '') +
        (m.exercise ? `<p class="exercise">Or get up and do <b>${escapeHtml(m.exercise)}</b>.</p>` : '') +
        `<div class="actions">` +
        `<button class="btn primary" data-act="back">Back to work</button>` +
        (m.exercise ? btn('exercise', 'good', 'I did it!', `I did ${m.exercise}`) : '') +
        btn('snooze', '', denied.has('snooze') || denied.has('beg') ? 'Snooze denied' : `${escapeHtml(m.snoozeMin)} more min`) +
        (m.sensitive ? '' : btn('isWork', 'ghost', denied.has('isWork') ? 'Override denied' : "It's for my task")) +
        `</div>` +
        replyFormHtml(m, 'nag') +
        (denied.has('dismiss') || m.deciding ? '' : `<button class="x" data-act="dismiss" aria-label="Dismiss">✕</button>`) +
        `</div>`;
    } else if (mode === 'cheer') {
      ui.side.innerHTML = `<div class="bubble cheer enter" role="status">${escapeHtml(cheer.text)}</div>`;
    } else if (mode === 'snooze' || mode === 'timer') {
      ui.side.innerHTML =
        `<div class="pill" role="button" tabindex="0" title="Click for Hackie's report">` +
        `<span class="site"></span><span class="time"></span></div>`;
    } else {
      ui.side.innerHTML = '';
    }
  }

  function updateTimers() {
    const pill = ui.side.querySelector('.pill');
    if (!pill || !status) return;
    const left = snoozedLeft();
    let cls = 'pill';
    if (left > 0) {
      cls += ' snoozed';
      pill.querySelector('.site').textContent = status.onBreak ? 'Break' : '⏳';
      pill.querySelector('.time').textContent = clock(left);
    } else {
      if (status.level >= 2) cls += ' hot';
      else if (status.level >= 1) cls += ' warn';
      pill.querySelector('.site').textContent = status.site;
      pill.querySelector('.time').textContent = clock(liveStreak());
    }
    if ((status.snoozeCount || 0) > 3) cls += ' angry';
    pill.className = cls;
  }

  // ---- report panel (the team's "Clippy's report", plus TaskWhip stats) -------

  function setPanel(open) {
    panelOpen = Boolean(open) && Boolean(status);
    sideKey = '';
    placeKey = '';
    if (!panelOpen) ui.panel.innerHTML = '';
    render();
  }

  function renderPanel() {
    if (!status) return;
    if (!ui.panel.firstChild) {
      ui.panel.innerHTML =
        `<div class="panel enter" role="dialog" aria-label="Hackie's report">` +
        `<h3>Hackie's report</h3>` +
        `<button class="x" data-act="closePanel" aria-label="Close">✕</button>` +
        `<div class="rows"></div><p class="note"></p>` +
        `<div class="actions">` +
        `<button class="btn primary" data-act="back">Back to work</button>` +
        (status.sensitive ? '' : `<button class="btn ghost" data-act="isWork">It's for my task</button>`) +
        `<button class="btn ghost" data-act="resetMood">Reset mood</button>` +
        `</div>` +
        `<label class="demo">🧪 Demo: drag to set the slack streak<input type="range" min="0" step="5" aria-label="Demo slack streak in seconds"></label>` +
        `</div>`;
    }
    const streak = liveStreak();
    const marks = status.marks || [];
    const names = ['Nudge', 'Whip', 'Lockdown'];
    let next = 'none';
    if (snoozedLeft() > 0) next = `snoozed ${clock(snoozedLeft())}`;
    else {
      const i = marks.findIndex((m) => m != null && m > streak);
      if (i >= 0) next = `${names[i]} in ${clock(marks[i] - streak)}`;
      else if (onSlack() && status.level > 0) next = 'reached';
    }
    const today = status.today || { work: 0, slack: 0, exercises: 0 };
    const mood = currentMood();
    const rows = [
      ['Slack streak', onSlack() ? `${clock(streak)} · ${status.site}` : 'not slacking'],
      ['Next warning', next],
      ['Today', `${duration(today.work)} work · ${duration(today.slack)} slacking`],
      ['Exercise breaks', String(today.exercises || 0)],
      ["Hackie's mood", MOOD_LABEL[mood] || mood],
    ];
    ui.panel.querySelector('.rows').innerHTML = rows.map(([k, v]) => `<span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b>`).join('');
    const n = status.snoozeCount || 0;
    ui.panel.querySelector('.note').textContent =
      (n > 3
        ? `${n} snoozes in a row. Hackie has had enough!`
        : n === 3
          ? '3 snoozes in a row. One more and Hackie loses it…'
          : n > 0
            ? `${n} snooze${n > 1 ? 's' : ''} in a row.`
            : 'No snoozes yet. Good job!') + ` Next snooze: ${status.nextSnoozeMin || 5} min.`;
    const bar = ui.panel.querySelector('.demo input');
    const lastMark = [...marks].reverse().find((m) => m != null) || 1200;
    bar.max = String(Math.round(lastMark + 60));
    if (!demoDragging) bar.value = String(Math.round(Math.min(+bar.max, streak)));
  }

  let demoTimer = 0;
  function onDemoInput(e) {
    if (!e.target.matches('.demo input') || !e.isTrusted) return;
    demoDragging = true;
    clearTimeout(demoTimer);
    const seconds = Number(e.target.value);
    demoTimer = setTimeout(() => send({ type: 'test:setStreak', seconds }), 250);
  }

  // ---- walking along the screen edges (the team's patrol) ---------------------

  // The visible area, without the page's scrollbars (innerWidth includes them).
  const viewW = () => document.documentElement.clientWidth || innerWidth;
  const viewH = () => Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);

  function bounds() {
    return {
      minX: EDGE,
      minY: EDGE,
      maxX: Math.max(EDGE + 1, viewW() - HK - EDGE),
      maxY: Math.max(EDGE + 1, viewH() - HK - EDGE),
    };
  }

  function perimeterLength() {
    const b = bounds();
    return 2 * (b.maxX - b.minX + (b.maxY - b.minY));
  }

  function perimeterPoint(t) {
    const b = bounds();
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    let s = (((t % 1) + 1) % 1) * 2 * (w + h);
    if (s < w) return { x: b.minX + s, y: b.minY };
    s -= w;
    if (s < h) return { x: b.maxX, y: b.minY + s };
    s -= h;
    if (s < w) return { x: b.maxX - s, y: b.maxY };
    s -= w;
    return { x: b.minX, y: b.maxY - s };
  }

  // The spot on the patrol loop closest to a point (where Hackie goes after a drop).
  function nearestU(p) {
    const b = bounds();
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const x = Math.min(b.maxX, Math.max(b.minX, p.x));
    const y = Math.min(b.maxY, Math.max(b.minY, p.y));
    const dTop = y - b.minY;
    const dRight = b.maxX - x;
    const dBottom = b.maxY - y;
    const dLeft = x - b.minX;
    const m = Math.min(dTop, dRight, dBottom, dLeft);
    let s;
    if (m === dTop) s = x - b.minX; // top edge, going right
    else if (m === dRight) s = w + (y - b.minY); // right edge, going down
    else if (m === dBottom) s = w + h + (b.maxX - x); // bottom edge, going left
    else s = 2 * w + h + (b.maxY - y); // left edge, going up
    return s / (2 * (w + h));
  }

  // ---- drag Hackie anywhere (the team's drag-and-drop) ---------------------------
  // Press and move more than DRAG_THRESHOLD px to pick him up; let go and he slides back to the
  // nearest edge and keeps patrolling. Not while the lockdown is up.

  function onPressHackie(e) {
    if (e.button !== 0 || !ui.block.hidden || ui.walker.hidden) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
    try {
      ui.hk.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
  }

  function onDragHackie(e) {
    if (!press || e.pointerId !== press.id) return;
    if (!ui.block.hidden || ui.walker.hidden) return dropHackie(e.pointerId, false);
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging = true;
      glide = null;
      ui.hk.dataset.grabbed = '1';
    }
    pos = {
      x: Math.min(Math.max(0, viewW() - HK), Math.max(0, press.px + dx)),
      y: Math.min(Math.max(0, viewH() - HK), Math.max(0, press.py + dy)),
    };
    ui.walker.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    placeSide();
  }

  function onDropHackie(e) {
    if (press && e.pointerId === press.id) dropHackie(e.pointerId, true);
  }

  function dropHackie(pointerId, glideBack) {
    press = null;
    try {
      if (ui.hk.hasPointerCapture(pointerId)) ui.hk.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    if (!dragging) return;
    dragging = false;
    delete ui.hk.dataset.grabbed;
    lastDragEnd = performance.now();
    u = nearestU(pos);
    glide = glideBack && !reducedMotion ? { from: { ...pos }, t0: performance.now() } : null;
  }

  // Keep the bubble / pill / panel on whichever side of Hackie has room.
  function placeSide() {
    const el = panelOpen ? ui.panel : ui.side;
    if (!el.firstChild) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const onRight = pos.x + HK + SIDE_GAP + w <= viewW() - EDGE;
    const anchorBottom = pos.y + h > viewH() - EDGE;
    const key = `${panelOpen}${onRight}${anchorBottom}${w > 0}`;
    if (key === placeKey) return;
    placeKey = key;
    el.style.left = onRight ? `${HK + SIDE_GAP}px` : 'auto';
    el.style.right = onRight ? 'auto' : `${HK + SIDE_GAP}px`;
    el.style.top = anchorBottom ? 'auto' : '0px';
    el.style.bottom = anchorBottom ? '0px' : 'auto';
  }

  function frame(now) {
    rafId = 0;
    if (!alive()) return destroy();
    if (ui.walker.hidden) return;
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
    lastFrame = now;

    const cx = pos.x + HK / 2;
    const cy = pos.y + HK / 2;
    const near = Math.hypot(mouse.x - cx, mouse.y - cy) < HOVER_RADIUS;
    if (near !== hovering) {
      hovering = near;
      render();
    }
    if (hovering && faceKey.startsWith('curious:')) Hackie.lookAt?.(ui.hk, mouse.x, mouse.y); // eyes follow the mouse
    // Walk, or ease to a stop when something wants Hackie's attention.
    const still = Boolean(nag) || panelOpen || hovering || dragging || now < pauseUntil || reducedMotion;
    speedFactor += ((still ? 0 : 1) - speedFactor) * Math.min(1, dt * 6);
    if (speedFactor > 0.01 && !dragging && !glide) u += (dir * SPEED * speedFactor * dt) / perimeterLength();
    if (!still) {
      if (Math.random() < dt / 12) dir *= -1; // sometimes turn around
      if (Math.random() < dt / 10) pauseUntil = now + 1500 + Math.random() * 2500; // sometimes rest
    }
    if (!dragging) {
      // (while dragging, the pointer decides where he is)
      const target = perimeterPoint(u);
      if (glide) {
        // just dropped: slide back to the patrol edge, cubic ease-out
        const t = Math.min(1, Math.max(0, (performance.now() - glide.t0) / GLIDE_MS));
        const ease = 1 - Math.pow(1 - t, 3);
        pos = { x: glide.from.x + (target.x - glide.from.x) * ease, y: glide.from.y + (target.y - glide.from.y) * ease };
        if (t >= 1) glide = null;
      } else pos = target;
    }
    ui.walker.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    placeSide();
    rafId = requestAnimationFrame(frame);
  }

  function startLoops() {
    if (!rafId) {
      lastFrame = 0;
      rafId = requestAnimationFrame(frame);
    }
    if (!tickTimer) {
      tickTimer = setInterval(() => {
        if (!alive()) return destroy();
        if (cheer.until && Date.now() >= cheer.until) {
          cheer = { until: 0, text: '' };
          sideKey = '';
        }
        render();
      }, 1000);
    }
    if (!exprTimer) {
      exprTimer = setInterval(() => {
        if (nag || hovering) return;
        const options = Hackie.IDLE_MOODS.filter((m) => m !== expr);
        expr = options[Math.floor(Math.random() * options.length)];
        render();
      }, EXPRESSION_EVERY_MS);
    }
  }

  function stopLoops() {
    if (rafId) cancelAnimationFrame(rafId);
    clearInterval(tickTimer);
    clearInterval(exprTimer);
    rafId = 0;
    tickTimer = 0;
    exprTimer = 0;
  }

  const onMouseMove = (e) => {
    mouse = { x: e.clientX, y: e.clientY };
  };
  const onMouseLeave = () => {
    mouse = { x: -9999, y: -9999 };
  };
  const onDocMouseDown = (e) => {
    if (panelOpen && !e.composedPath().includes(ui.host)) setPanel(false); // click elsewhere closes the panel
  };
  const onDocKey = (e) => {
    if (e.key === 'Escape' && panelOpen) setPanel(false);
  };
  window.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
  document.documentElement.addEventListener('mouseleave', onMouseLeave);
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onDocKey);

  // ---- lockdown ---------------------------------------------------------------

  function showBlock(msg) {
    ensureUI();
    nag = null;
    setPanel(false);
    const begDelay = Math.max(0, msg.begDelaySec || 0);
    const gated = begDelay ? 'disabled' : '';
    ui.block.innerHTML =
      `<div class="panel" role="alertdialog" aria-modal="true" aria-label="Hackie locked this page">` +
      `<div class="big">${Hackie.html({ mood: 'furious' })}</div>` +
      `<div class="tag">${escapeHtml(msg.zeroSlack ? 'Zero-slack mode' : msg.levelName)}</div>` +
      `<h2>${msg.zeroSlack ? `${escapeHtml(msg.site)} counts as slacking.` : `${escapeHtml(msg.minutesText)} on ${escapeHtml(msg.site)}.`}</h2>` +
      `<p class="msg">${messageHtml(msg.message)}${msg.aiPending ? TYPING : ''}</p>` +
      `<div class="stats">` +
      `<div class="stat slack"><span>Slacking today</span><b>${escapeHtml(duration(msg.today?.slack))}</b></div>` +
      `<div class="stat work"><span>Working today</span><b>${escapeHtml(duration(msg.today?.work))}</b></div>` +
      `</div>` +
      `<button class="btn primary" data-act="back">Take me back to ${escapeHtml(msg.task)}</button>` +
      (msg.exercise && !msg.zeroSlack ? `<button class="btn good" data-act="exercise" data-gated ${gated} data-label="I did ${escapeHtml(msg.exercise)}"></button>` : '') +
      (msg.zeroSlack ? '' : `<button class="btn" data-act="snooze" data-gated ${gated} data-label="Beg for ${escapeHtml(msg.snoozeMin)} more minutes"></button>`) +
      (msg.sensitive ? '' : `<button class="link" data-act="isWork" data-gated ${gated}>This page is actually for my task</button>`) +
      `<div class="reply-area">${replyFormHtml(msg, 'block')}</div>` +
      `</div>`;
    blockRefused = null;
    ui.block.hidden = false;
    render();
    const until = Date.now() + begDelay * 1000;
    const labelled = [...ui.block.querySelectorAll('[data-label]')];
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      for (const b of labelled) b.textContent = left > 0 ? `${b.dataset.label} (${clock(left)})` : b.dataset.label;
      if (left > 0) return;
      ui.block.querySelectorAll('[data-gated]').forEach((b) => (b.disabled = false));
      clearInterval(begTimer);
      begTimer = 0;
    };
    clearInterval(begTimer);
    tick();
    if (begDelay) begTimer = setInterval(tick, 250);
    // Keep videos paused while the lockdown is up (YouTube loves to autoplay).
    clearInterval(mediaGuard);
    mediaGuard = setInterval(pauseMedia, 1000);
    pauseMedia();
    ui.block.querySelector('[data-act="back"]').focus({ preventScroll: true });
  }

  function hideBlock() {
    if (ui.block && !ui.block.hidden) {
      ui.block.hidden = true;
      ui.block.innerHTML = '';
    }
    clearInterval(begTimer);
    clearInterval(mediaGuard);
    begTimer = 0;
    mediaGuard = 0;
  }

  // --- effects ---------------------------------------------------------------

  function pauseMedia() {
    document.querySelectorAll('video, audio').forEach((m) => {
      try {
        if (!m.paused) m.pause();
      } catch {
        /* ignore */
      }
    });
  }

  let audioCtx = null;
  function audio() {
    try {
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch {
      return null;
    }
  }

  function noise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Synthesized whip: a rising "whoosh" then a sharp high-passed noise crack with a thump.
  function playCrack() {
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const whoosh = ctx.createBufferSource();
    whoosh.buffer = noise(ctx, 0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(3800, t + 0.26);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.exponentialRampToValueAtTime(0.3, t + 0.2);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.29);
    whoosh.connect(bp).connect(wg).connect(ctx.destination);
    whoosh.start(t);
    whoosh.stop(t + 0.35);

    const ct = t + 0.25;
    const crack = ctx.createBufferSource();
    crack.buffer = noise(ctx, 0.12);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1700;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, ct);
    cg.gain.exponentialRampToValueAtTime(0.9, ct + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.09);
    crack.connect(hp).connect(cg).connect(ctx.destination);
    crack.start(ct);
    crack.stop(ct + 0.12);

    const thump = ctx.createOscillator();
    thump.type = 'triangle';
    thump.frequency.setValueAtTime(190, ct);
    thump.frequency.exponentialRampToValueAtTime(55, ct + 0.09);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.35, ct);
    tg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.11);
    thump.connect(tg).connect(ctx.destination);
    thump.start(ct);
    thump.stop(ct + 0.12);
  }

  // A polite "ahem" for nudges: two short descending blips.
  function playAhem() {
    const ctx = audio();
    if (!ctx) return;
    [
      [660, 0],
      [494, 0.13],
    ].forEach(([freq, offset]) => {
      const t = ctx.currentTime + 0.02 + offset;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.14);
    });
  }

  function shake(strength = 1) {
    if (reducedMotion || !document.documentElement.animate) return;
    const k = 8 * strength;
    const root = document.documentElement;
    // Hide the horizontal scrollbar the jolt would otherwise flash, then restore the page's value.
    const prevOverflowX = root.style.overflowX;
    root.style.overflowX = 'hidden';
    const anim = root.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: `translate(${-k}px, ${k / 2}px) rotate(-0.4deg)` },
        { transform: `translate(${k}px, ${-k / 2}px) rotate(0.4deg)` },
        { transform: `translate(${-k / 1.5}px, ${k / 3}px)` },
        { transform: `translate(${k / 2}px, 0)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: 420, easing: 'ease-out' },
    );
    const restore = () => {
      root.style.overflowX = prevOverflowX;
    };
    anim.onfinish = restore;
    anim.oncancel = restore;
  }

  function flashRed() {
    ui.flash?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
  }

  function crackWhip(container, effects) {
    const whip = container?.querySelector('.hk-whip');
    const lash = container?.querySelector('.hk-lash');
    const burst = container?.querySelector('.hk-burst');
    if (whip?.animate && !reducedMotion) {
      whip.animate(
        [
          { transform: 'rotate(40deg)' },
          { transform: 'rotate(-38deg)', offset: 0.45 },
          { transform: 'rotate(12deg)', offset: 0.7 },
          { transform: 'rotate(0deg)' },
        ],
        { duration: 540, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
      if (lash) {
        const len = lash.getTotalLength();
        lash.style.strokeDasharray = String(len);
        lash.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 280, easing: 'ease-out' });
      }
      if (burst) {
        const at = 'translate(-104px, 50px)';
        burst.animate(
          [
            { opacity: 0, transform: `${at} scale(.2)` },
            { opacity: 1, transform: `${at} scale(1.35)`, offset: 0.3 },
            { opacity: 0, transform: `${at} scale(1.7)` },
          ],
          { duration: 600, delay: 220 },
        );
      }
    }
    if (effects?.sound) playCrack();
    setTimeout(() => {
      if (effects?.shake) shake(1);
      flashRed();
    }, 250);
  }

  const TYPING = '<span class="typing" role="status" aria-label="Hackie is thinking"><i></i><i></i><i></i></span>';

  function toast(text, ms = 3200) {
    ensureUI();
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.setProperty('--toast-ms', `${ms}ms`);
    el.textContent = text;
    ui.layer.appendChild(el);
    setTimeout(() => el.remove(), ms + 100);
  }

  // The per-event AI's targeted line for a nudge/whip/lockdown that is already on screen.
  function handleSay(msg) {
    const text = String(msg.text || '').trim();
    if (!text) return;
    if (nag && msg.fireId && nag.fireId === msg.fireId) {
      nag = { ...nag, message: nag.message.startsWith('*CRACK*') ? `*CRACK* ${text}` : text, aiDone: true };
      sideKey = '';
      render();
      return;
    }
    const blockMsg = ui.block && !ui.block.hidden ? ui.block.querySelector('.msg') : null;
    if (blockMsg && msg.fireId && lastFire?.fireId === msg.fireId) {
      blockMsg.textContent = text;
      blockMsg.classList.add('ai-line');
      return;
    }
    toast(text, 7000);
  }

  // --- actions -----------------------------------------------------------------

  const CHEERS = ['Nice! 🎉 Hackie is proud of you.', 'Battery recharged. Great work, recruit!', 'Beep boop! That is what I like to see.'];

  function showCheer(text) {
    cheer = { until: Date.now() + 4000, text: text || CHEERS[Math.floor(Math.random() * CHEERS.length)] };
    sideKey = '';
    render();
  }

  const REFUSABLE = ['snooze', 'isWork', 'dismiss', 'exercise', 'resetMood'];
  let deciding = false;

  async function act(action) {
    if (action === 'closePanel') {
      setPanel(false);
      return;
    }
    if (action === 'back') {
      nag = null;
      hideBlock();
      setPanel(false);
      lockdownHoldUntil = Date.now() + 5000; // don't flash the lockdown back while the tab switches
      const min = status?.calmAfterMin ?? 2;
      toast(`Good. ${min} min of real work and Hackie calms down. Come straight back and he'll know.`, 5000);
      send({ type: 'pomo:action', action });
      return;
    }
    if (!REFUSABLE.includes(action) || deciding) return;
    // Angry Hackie may refuse: wait for his verdict (the AI can take a few seconds).
    deciding = true;
    const angry = (status?.anger?.level || 0) >= 2;
    if (angry) setDeciding(action, true);
    const res = await send({ type: 'pomo:action', action });
    deciding = false;
    if (angry) setDeciding(action, false);
    if (res?.denied) {
      showRefusal(res.action || action, res.message);
      return;
    }
    const answered = nag || lastFire;
    nag = null;
    hideBlock();
    setPanel(false);
    const said = res?.message;
    if (action === 'dismiss') {
      sideKey = '';
      render();
      if (said) toast(said, 6000);
      return;
    }
    if (action === 'snooze') toast(said || `Fine. ${answered?.snoozeMin ?? status?.nextSnoozeMin ?? 5} minutes. Hackie is counting.`, said ? 6000 : 3200);
    if (action === 'isWork') toast(said || 'Noted. Hackie will leave this page alone.', said ? 6000 : 3200);
    if (action === 'exercise' || action === 'resetMood') showCheer(said || undefined);
  }

  // Disable Hackie's buttons and show "Hackie is deciding…" while the verdict comes in.
  function setDeciding(action, on) {
    if (nag) {
      nag = { ...nag, deciding: on ? action : null };
      sideKey = '';
      render();
    }
    if (ui.block && !ui.block.hidden) {
      ui.block.querySelectorAll('button').forEach((b) => {
        if (b.dataset.act === 'back') return;
        if (on) b.dataset.wasDisabled = b.disabled ? '1' : '';
        b.disabled = on ? true : b.dataset.wasDisabled === '1' || b.dataset.refused === '1';
      });
      const msgEl = ui.block.querySelector('.msg');
      if (msgEl) {
        msgEl.querySelector('.deciding')?.remove();
        if (on) msgEl.insertAdjacentHTML('beforeend', `<span class="deciding" role="status">Hackie is deciding…${TYPING}</span>`);
      }
    }
    if (panelOpen && ui.panel) ui.panel.querySelectorAll('button[data-act]').forEach((b) => (b.disabled = on));
  }

  // Refused: Hackie gets furious, says why, and the refused button stays dead for this warning.
  function showRefusal(action, message) {
    const text = message || 'DENIED.';
    const effects = lastFire?.effects || { sound: true, shake: true };
    if (ui.block && !ui.block.hidden) {
      const msgEl = ui.block.querySelector('.msg');
      if (msgEl) {
        msgEl.textContent = text;
        msgEl.classList.add('ai-line');
      }
      blockRefused = action;
      const target = ui.block.querySelector(`[data-act="${action === 'beg' ? 'snooze' : action}"]`);
      if (target) {
        target.disabled = true;
        target.dataset.refused = '1';
        target.classList.add('denied');
        target.textContent = action === 'beg' || action === 'snooze' ? 'Begging denied' : action === 'isWork' ? 'Override denied' : 'Denied';
      }
      if (effects.sound) playCrack();
      if (effects.shake) setTimeout(() => shake(1.2), 250);
      return;
    }
    // On a nudge/whip (or from the report panel): an angry bubble with the refused option crossed out.
    const base = nag || {
      level: 2,
      levelName: 'Whip',
      site: status?.site || '',
      minutesText: '',
      snoozeMin: status?.nextSnoozeMin || 2,
      exercise: lastFire?.exercise || '',
      sensitive: Boolean(status?.sensitive),
      fireId: `refusal-${Date.now()}`,
      at: Date.now(),
    };
    panelOpen = false;
    if (ui.panel) ui.panel.innerHTML = '';
    nag = {
      ...base,
      message: `*CRACK* ${text}`,
      mood: 'furious',
      level: Math.max(2, base.level || 2),
      refusedTag: 'Request denied',
      refusedAt: Date.now(),
      denied: [...new Set([...(base.denied || []), action])],
      deciding: null,
      aiPending: false,
      aiDone: true,
    };
    sideKey = '';
    render();
    crackWhip(ui.hk, effects);
  }

  // --- messages from the service worker ----------------------------------------

  let lockdownHoldUntil = 0;

  function handleStatus(s) {
    status = s && s.category && s.category !== 'inactive' ? { ...s, receivedAt: Date.now() } : null;
    // An open lockdown comes back on every slacking page: navigating away and back doesn't escape it.
    if (status?.lockdown && artReady && onSlack() && (!ui.block || ui.block.hidden) && Date.now() > lockdownHoldUntil) {
      lastFire = status.lockdown;
      showBlock(status.lockdown);
      if (status.lockdown.effects?.sound) playCrack();
      if (status.lockdown.effects?.shake) setTimeout(() => shake(1), 250);
    }
    if (!onSlack()) {
      if (nag && !nag.test) nag = null; // test nudges stay until answered
      hideBlock();
      if (panelOpen && !status) setPanel(false);
    }
    if (status?.snoozedUntil && Date.now() < status.snoozedUntil) hideBlock();
    render();
  }

  function handleFire(msg) {
    lastFire = msg;
    if (msg.level >= 3) {
      showBlock(msg);
      if (msg.effects?.sound) playCrack();
      if (msg.effects?.shake) setTimeout(() => shake(1.4), 250);
      return;
    }
    nag = { ...msg, at: Date.now() };
    if (msg.aiPending) {
      setTimeout(() => {
        if (nag && nag.fireId === msg.fireId && !nag.aiDone) {
          nag = { ...nag, aiDone: true };
          sideKey = '';
          render();
        }
      }, 15000);
    }
    panelOpen = false;
    if (ui.panel) ui.panel.innerHTML = '';
    sideKey = '';
    render();
    if (msg.level >= 2) {
      crackWhip(ui.hk, msg.effects);
      if (msg.effects?.pauseVideo) pauseMedia();
    } else if (msg.effects?.sound) {
      playAhem();
    }
  }


  // -------------------------------------------------------------------------
  // Debug console (only when debug mode is on in settings).
  // A *closed* shadow root: page scripts can't read Hackie's stats or drive "Ask Hackie".
  // Browser agents still see it through screenshots and the accessibility tree.

  const DEBUG_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.dbg {
  position: fixed; left: 14px; bottom: 14px; z-index: 2147483646; width: min(360px, calc(100vw - 28px));
  max-height: min(70vh, 560px); display: flex; flex-direction: column;
  font-family: ${FONT_STACK}; font-weight: 800; font-size: 12px; line-height: 1.45; -webkit-font-smoothing: antialiased;
  color: #fff; background: #247287; border: 0; border-radius: 12px; box-shadow: none; overflow: hidden;
}
header { display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 10px; background: rgba(0,0,0,.12); }
header .mini { width: 20px; height: 20px; flex: none; }
header .mini svg { width: 100%; height: 100%; overflow: visible; }
header .title { font-size: 13px; flex: 1; }
header .ver { color: rgba(255,255,255,.72); font-size: 11px; }
button { font: inherit; cursor: pointer; }
.min { appearance: none; border: 0; background: rgba(255,255,255,.2); color: #fff; width: 24px; height: 22px; border-radius: 6px; }
.min:hover { background: rgba(255,255,255,.35); }
.min:focus-visible, form button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.body { overflow: auto; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.collapsed .body { display: none; }
.collapsed header { background: none; }
.state { display: flex; gap: 8px; align-items: flex-start; }
.badge { flex: none; font-size: 10.5px; letter-spacing: .05em; padding: 2px 7px; border-radius: 99px; color: #fff; }
.badge.on { background: #2f9e57; }
.badge.off { background: #c4271e; }
.why { color: #fff; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
dt { color: rgba(255,255,255,.72); }
dd { margin: 0; overflow-wrap: anywhere; }
.yes { color: #aef2cb; } .no { color: #ffc2b8; }
ol { list-style: none; margin: 0; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,.14);
  font: 600 11px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; max-height: 120px; overflow: auto; color: rgba(255,255,255,.9); }
form { display: flex; gap: 6px; }
input { flex: 1; min-width: 0; font: inherit; color: #fff; background: rgba(255,255,255,.2); border: 0;
  border-radius: 6px; padding: 6px 8px; }
input::placeholder { color: rgba(255,255,255,.7); opacity: 1; }
input:focus { outline: 2px solid #fff; outline-offset: 0; }
form button { appearance: none; border: 0; background: #fff; color: #247287; border-radius: 6px; padding: 0 12px; }
form button:hover { background: rgba(255,255,255,.86); }
form button:disabled { opacity: .5; cursor: progress; }
.answer { white-space: pre-wrap; background: rgba(255,255,255,.12); border-radius: 6px; padding: 7px 9px; }
.answer:empty { display: none; }
.answer .meta { display: block; margin-top: 4px; color: rgba(255,255,255,.72); font-size: 11px; }
.answer.err { color: #fff; background: rgba(0,0,0,.18); }
`;

  const dbg = { host: null, root: null, el: null, collapsed: false, busy: false };

  function ensureDebugUI() {
    if (dbg.host?.isConnected) return;
    const host = document.createElement('taskwhip-console');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(DEBUG_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = DEBUG_CSS;
      root.appendChild(style);
    }
    const el = document.createElement('section');
    el.className = 'dbg';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Hackie debug console');
    el.innerHTML =
      `<header><span class="mini">${Hackie.html({ mood: 'stern', whip: false, badge: false })}</span>` +
      `<span class="title">Hackie debug</span><span class="ver"></span>` +
      `<button class="min" type="button" aria-label="Collapse debug console" aria-expanded="true">–</button></header>` +
      `<div class="body">` +
      `<div class="state" role="status"><span class="badge"></span><span class="why"></span></div>` +
      `<dl aria-label="Tracking facts"></dl>` +
      `<ol aria-label="Recent decisions, newest first"></ol>` +
      `<form><input type="text" aria-label="Ask Hackie" placeholder="Ask Hackie… e.g. why aren't you tracking?" autocomplete="off" maxlength="500">` +
      `<button type="submit">Ask</button></form>` +
      `<div class="answer" aria-live="polite" aria-label="Hackie's answer"></div>` +
      `</div>`;
    root.appendChild(el);
    (document.documentElement || document.body).appendChild(host);
    Object.assign(dbg, { host, root, el });

    el.querySelector('.min').addEventListener('click', () => {
      dbg.collapsed = !dbg.collapsed;
      el.classList.toggle('collapsed', dbg.collapsed);
      const btn = el.querySelector('.min');
      btn.textContent = dbg.collapsed ? '+' : '–';
      btn.setAttribute('aria-expanded', String(!dbg.collapsed));
    });
    const input = el.querySelector('input');
    // Keep typing here from triggering the page's keyboard shortcuts (YouTube: k, f, space…).
    for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!e.isTrusted) return; // only real user (or browser-agent) input
      askFromConsole(input.value);
    });
  }

  function yesNo(v, yes, no) {
    return `<span class="${v ? 'yes' : 'no'}">${escapeHtml(v ? yes : no)}</span>`;
  }

  function renderDebug(payload) {
    if (!payload?.enabled) {
      dbg.host?.remove();
      dbg.host = null;
      return;
    }
    ensureDebugUI();
    const d = payload.last;
    const el = dbg.el;
    el.querySelector('.ver').textContent = `v${payload.version || ''}`;
    const badge = el.querySelector('.badge');
    badge.className = `badge ${d?.tracked ? 'on' : 'off'}`;
    badge.textContent = d?.tracked ? 'TRACKING' : 'NOT TRACKING';
    el.querySelector('.why').textContent = d?.why || 'Waiting for the first decision…';
    const facts = [];
    if (d) {
      if (d.window) {
        facts.push(['Window', yesNo(d.window.focused, d.window.forced ? 'treated as focused (testing switch)' : d.window.popupOpen ? 'focused (popup open)' : 'focused', 'not focused')]);
        facts.push(['Input', yesNo(d.window.idle === 'active', 'active', d.window.idle)]);
      } else {
        facts.push(['Window', d.trackingEnabled === false ? 'tracking paused' : 'none found']);
      }
      if (d.tab) facts.push(['Media', `${yesNo(d.playing, 'playing', 'not playing')} · tab ${d.tab.audible ? 'audible' : 'silent'}`]);
      if (d.tracked) facts.push(['Page', `${escapeHtml(d.category)} · ${escapeHtml(d.site)} · by ${escapeHtml(d.source)}`]);
      if (d.tracked && d.category === 'slack') {
        facts.push(['Streak', `${clock(d.streakSec)} · level ${d.level}${d.nextLevelAtSec ? ` · next at ${clock(d.nextLevelAtSec)}` : ''}${d.snoozed ? ' · snoozed' : ''}${d.overBudget ? ' · over budget' : ''}`]);
      }
      facts.push(['Last check', `${escapeHtml(new Date(d.at).toLocaleTimeString())} (${escapeHtml(d.trigger)})`]);
    }
    const ai = payload.ai;
    if (ai) {
      const status = ai.status ? (ai.status.ok ? `last call ok ${new Date(ai.status.at).toLocaleTimeString()}` : `error: ${ai.status.error}`) : 'no calls yet';
      facts.push(['AI', ai.configured ? `${escapeHtml(ai.provider)} · ${escapeHtml(ai.model)} · judge ${ai.judgeOn ? 'on' : 'off'} · ${escapeHtml(status)}` : 'not set up (Ask Hackie needs a key)']);
    }
    el.querySelector('dl').innerHTML = facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');
    el.querySelector('ol').innerHTML = (payload.lines || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  }

  async function askFromConsole(question) {
    const q = String(question || '').trim();
    if (!q || dbg.busy) return;
    const el = dbg.el;
    const out = el.querySelector('.answer');
    const btn = el.querySelector('form button');
    dbg.busy = true;
    btn.disabled = true;
    out.className = 'answer';
    out.textContent = 'Hackie is checking…';
    const res = await send({ type: 'agent:ask', question: q });
    dbg.busy = false;
    btn.disabled = false;
    if (!res?.ok) {
      out.className = 'answer err';
      out.textContent = res?.error || 'No answer (is the extension still loaded?).';
      return;
    }
    el.querySelector('input').value = '';
    out.textContent = res.answer;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const tools = [...new Set((res.steps || []).map((st) => st.tool))];
    meta.textContent = `${tools.length ? `used ${tools.join(', ')} · ` : ''}${res.model} · ${(res.ms / 1000).toFixed(1)}s`;
    out.appendChild(meta);
  }

  function onMessage(msg, _sender, sendResponse) {
    if (!artReady && msg?.type !== 'pomo:status') {
      artLoaded.then(() => onMessage(msg, _sender, () => {})); // lockdowns, nudges, debug: once Hackie can be drawn
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'pomo:status') handleStatus(msg.status);
    else if (msg?.type === 'pomo:fire') handleFire(msg);
    else if (msg?.type === 'pomo:debug') renderDebug(msg.debug);
    else if (msg?.type === 'pomo:say') handleSay(msg);
    else if (msg?.type === 'pomo:toast') toast(String(msg.text || ''), 7000);
    sendResponse({ ok: true });
  }
  runtime.onMessage.addListener(onMessage);
  artLoaded.then(() => send({ type: 'debug:get' })).then((payload) => {
    if (payload?.enabled) renderDebug(payload);
  });

  // -------------------------------------------------------------------------

  function destroy() {
    clearInterval(navWatcher);
    stopLoops();
    clearTimeout(demoTimer);
    clearInterval(begTimer);
    clearInterval(mediaGuard);
    clearTimeout(reportTimer);
    document.removeEventListener('play', onMedia, true);
    document.removeEventListener('pause', onMedia, true);
    document.removeEventListener('playing', onMedia, true);
    document.removeEventListener('yt-navigate-finish', onYtNav);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('mousemove', onMouseMove, { capture: true });
    document.documentElement.removeEventListener('mouseleave', onMouseLeave);
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKey);
    try {
      runtime.onMessage.removeListener(onMessage);
    } catch {
      /* runtime gone */
    }
    ui.host?.remove();
    dbg.host?.remove();
    if (window.__taskwhip?.destroy === destroy) delete window.__taskwhip;
  }

  window.__taskwhip = { isAlive: alive, destroy };
  scheduleReport(300);
})();
