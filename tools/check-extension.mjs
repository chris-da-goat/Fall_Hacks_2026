// Checks that an unpacked copy of the extension has every file it needs, with exact-case names.
// A missing import makes Chrome fail with "Service worker registration failed. Status code: 3"
// and "An unknown error occurred when fetching the script"; this finds the culprit first.
//
//   node tools/check-extension.mjs [dir]      # default: extension/
//
// Covers: manifest entries (service worker, content scripts, popup, options page, icons,
// web-accessible resources), scripts and stylesheets the HTML pages load, every relative JS
// import (static and dynamic, recursively), and Hackie's art and font files (assets/... strings).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Does `rel` exist under `root` with exactly this case, segment by segment? */
function exactPath(root, rel) {
  let dir = root;
  for (const part of rel.split('/').filter(Boolean)) {
    if (part === '.') continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return { ok: false };
    }
    if (names.includes(part)) {
      dir = join(dir, part);
      continue;
    }
    const other = names.find((n) => n.toLowerCase() === part.toLowerCase());
    return { ok: false, caseOf: other ? relative(root, join(dir, other)).split(sep).join('/') : null };
  }
  return { ok: true };
}

const toPosix = (p) => p.split(sep).join('/');

/**
 * @param {string} dir  The extension folder (the one with manifest.json).
 * @returns {{ok: boolean, missing: string[], caseMismatch: string[], checked: number}}
 */
export function checkExtension(dir) {
  const root = resolve(dir);
  const missing = new Set();
  const caseMismatch = new Set();
  const seen = new Set();
  const queue = [];

  const need = (rel, from = 'manifest.json') => {
    rel = toPosix(rel).replace(/^\.?\//, '').replace(/[?#].*$/, '');
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    if (rel.includes('*')) return; // globs in web_accessible_resources: nothing specific to check
    const found = exactPath(root, rel);
    if (!found.ok) {
      if (found.caseOf) caseMismatch.add(`${rel} (found ${found.caseOf}; needed by ${from})`);
      else missing.add(`${rel} (needed by ${from})`);
      return;
    }
    if (/\.(m?js|html)$/.test(rel)) queue.push(rel);
  };

  if (!existsSync(join(root, 'manifest.json'))) return { ok: false, missing: ['manifest.json'], caseMismatch: [], checked: 0 };
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  need('manifest.json', 'Chrome');
  if (manifest.background?.service_worker) need(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) for (const f of [...(cs.js || []), ...(cs.css || [])]) need(f);
  for (const f of [manifest.action?.default_popup, manifest.options_page, manifest.options_ui?.page]) if (f) need(f);
  for (const f of Object.values(manifest.icons || {})) need(f);
  for (const f of Object.values(manifest.action?.default_icon || {})) need(f);
  for (const war of manifest.web_accessible_resources || []) for (const f of war.resources || []) need(f);

  while (queue.length) {
    const rel = queue.shift();
    const src = readFileSync(join(root, rel), 'utf8');
    const base = dirname(rel);
    const refs = [];
    if (rel.endsWith('.html')) {
      for (const m of src.matchAll(/<(?:script|img)\b[^>]*\bsrc=["']([^"']+)["']/gi)) refs.push(m[1]);
      for (const m of src.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)) refs.push(m[1]);
    } else {
      for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) refs.push(m[1]);
      for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.push(m[1]);
      // Files the code loads by path at runtime (Hackie's art and font, page URLs).
      for (const m of src.matchAll(/['"`]((?:assets|popup|options|report|content|shared|lib|data|icons)\/[\w./-]+\.\w+)['"`]/g)) need(m[1], rel);
    }
    for (const ref of refs) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue; // http:, data:, chrome:, anchors
      need(toPosix(join(base, ref)), rel);
    }
  }
  // Hackie's angry frames are built from a template (angry-${i}.png): check them explicitly.
  const mascot = join(root, 'shared', 'mascot.js');
  if (existsSync(mascot)) {
    const m = readFileSync(mascot, 'utf8').match(/\[([\d,\s]+)\]\.map\(\(i\) => `assets\/sprites\/angry-\$\{i\}\.png`\)/);
    for (const i of m ? m[1].split(',').map((n) => n.trim()).filter(Boolean) : []) need(`assets/sprites/angry-${i}.png`, 'shared/mascot.js');
  }
  return { ok: !missing.size && !caseMismatch.size, missing: [...missing], caseMismatch: [...caseMismatch], checked: seen.size };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`No such folder: ${dir}`);
    process.exit(2);
  }
  const r = checkExtension(dir);
  if (r.ok) {
    console.log(`OK: all ${r.checked} files the extension needs are present in ${dir}.`);
  } else {
    console.error(`This copy of the extension is incomplete (${dir}):`);
    for (const m of r.missing) console.error(`  missing: ${m}`);
    for (const m of r.caseMismatch) console.error(`  wrong case: ${m}`);
    console.error('Chrome will fail to load it ("Service worker registration failed"). Use a full copy of the extension/ folder.');
    process.exit(1);
  }
}
