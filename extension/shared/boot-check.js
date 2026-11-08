// Hackie's extension pages (popup, settings, report) check that this copy of the extension is
// complete. A copy missing even one file fails quietly: the page's script never runs (fields
// look wrong, nothing saves), or the background never starts ("Service worker registration
// failed. Status code: 3"). Instead, show a plain banner naming the missing files.
// Classic script with no imports, so it still runs when the page's own module can't load.
(() => {
  const root = chrome.runtime.getURL('');
  const rel = (url) => String(url).replace(root, '');

  async function fetchText(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  // Walk a module and its relative imports; return the files that can't be fetched.
  async function missingFrom(entry) {
    const missing = new Set();
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const text = await fetchText(url);
      if (text == null) {
        missing.add(rel(url));
        continue;
      }
      for (const m of text.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) queue.push(new URL(m[1], url).href);
    }
    return [...missing];
  }

  // true = answered, false = no service worker, null = no answer yet. When the worker failed to
  // register, Chrome never answers at all (it keeps trying to start it), hence the timeout.
  function backgroundRunning(ms = 3000) {
    const ping = chrome.runtime.sendMessage({ type: 'hackie:ping' }).then(
      () => true,
      (err) => !/Receiving end does not exist|Could not establish connection/i.test(String(err?.message || err)),
    );
    return Promise.race([ping, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  }

  function banner(lines, missing) {
    const box = document.createElement('div');
    box.id = 'hackie-broken';
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:sticky;top:0;z-index:2147483647;margin:0;padding:12px 14px;background:#c4271e;color:#fff;' +
      'font:600 13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:800;font-size:14px;margin-bottom:4px;';
    title.textContent = "Hackie can't start: this copy of the extension is missing files.";
    box.append(title);
    for (const line of lines) {
      const p = document.createElement('div');
      p.textContent = line;
      box.append(p);
    }
    if (missing.length) {
      const list = document.createElement('div');
      list.style.cssText = 'margin:4px 0;font:12px/1.4 ui-monospace,Consolas,monospace;word-break:break-all;';
      list.textContent = `Missing: ${missing.join(', ')}`;
      box.append(list);
    }
    const fix = document.createElement('div');
    fix.textContent =
      'Fix: download the whole extension again (the full extension/ folder, or a zip made with npm run zip), then reload it in chrome://extensions.';
    box.append(fix);
    document.body.prepend(box);
  }

  async function check() {
    const lines = [];
    const missing = new Set();
    // 1) This page's own script: page modules set data-hackie-ready as soon as they run.
    if (document.documentElement.dataset.hackieReady !== '1') {
      const modules = [...document.querySelectorAll('script[type="module"][src]')].map((s) => s.src);
      const gone = (await Promise.all(modules.map(missingFrom))).flat();
      gone.forEach((f) => missing.add(f));
      lines.push(gone.length ? "This page's script couldn't load, so its controls don't work." : "This page's script failed to start.");
    }
    // 2) The background service worker (tracking, AI, everything else).
    const running = await backgroundRunning();
    if (running !== true) {
      const sw = chrome.runtime.getManifest().background?.service_worker;
      const gone = sw ? await missingFrom(chrome.runtime.getURL(sw)) : [];
      // No answer yet but nothing missing: probably just a slow start, so don't cry wolf.
      if (running === false || gone.length) {
        gone.forEach((f) => missing.add(f));
        lines.push("Hackie's background script isn't running, so nothing is tracked.");
      }
    }
    // 3) Hackie's art and font (without them he's invisible on web pages).
    const art = globalThis.Hackie ? [...(globalThis.Hackie.ART_FILES || []), globalThis.Hackie.FONT].filter(Boolean) : [];
    const artGone = (await Promise.all(art.map(async (p) => ((await fetchText(chrome.runtime.getURL(p))) == null ? p : null)))).filter(Boolean);
    if (artGone.length) {
      artGone.forEach((f) => missing.add(f));
      lines.push("Some of Hackie's art is missing, so he can't appear on web pages.");
    }
    if (lines.length) banner(lines, [...missing]);
  }

  if (document.readyState === 'complete') check();
  else window.addEventListener('load', () => check(), { once: true });
})();
