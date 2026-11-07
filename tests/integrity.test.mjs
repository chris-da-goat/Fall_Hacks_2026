// The extension folder must contain every file Chrome and the code need, with exact-case names.
// (A copy missing lib/agent-tools.js failed with "Service worker registration failed. Status code: 3".)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, rmSync, renameSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExtension } from '../tools/check-extension.mjs';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'hackie-ext-'));
  temps.push(dir);
  cpSync(EXT, join(dir, 'extension'), { recursive: true });
  return join(dir, 'extension');
}

test('the extension folder has every file it needs', () => {
  const r = checkExtension(EXT);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.caseMismatch, []);
  assert.ok(r.checked > 30, `checked ${r.checked} files`);
});

test('a copy missing an imported module is caught (the "Status code: 3" failure)', () => {
  const dir = copy();
  rmSync(join(dir, 'lib', 'agent-tools.js'));
  const r = checkExtension(dir);
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.startsWith('lib/agent-tools.js')), r.missing.join('; '));
});

test("a copy missing Hackie's sprites or font is caught", () => {
  const dir = copy();
  rmSync(join(dir, 'assets', 'sprites'), { recursive: true });
  rmSync(join(dir, 'assets', 'fonts'), { recursive: true });
  const r = checkExtension(dir);
  assert.ok(r.missing.some((m) => m.startsWith('assets/sprites/angry-6.png')), r.missing.join('; '));
  assert.ok(r.missing.some((m) => m.startsWith('assets/sprites/hover-base.png')));
  assert.ok(r.missing.some((m) => m.startsWith('assets/fonts/inter-latin-800-normal.woff2')));
});

test('a file whose name differs only in case is caught, even on case-insensitive disks', () => {
  const dir = copy();
  renameSync(join(dir, 'lib', 'search.js'), join(dir, 'lib', 'search.tmp'));
  renameSync(join(dir, 'lib', 'search.tmp'), join(dir, 'lib', 'Search.js'));
  const r = checkExtension(dir);
  assert.equal(r.ok, false);
  assert.ok(r.caseMismatch.some((m) => m.startsWith('lib/search.js (found lib/Search.js')), r.caseMismatch.join('; '));
});

test('a missing page or icon from the manifest is caught', () => {
  const dir = copy();
  rmSync(join(dir, 'popup', 'popup.js'));
  rmSync(join(dir, 'icons', 'icon128.png'));
  const r = checkExtension(dir);
  assert.ok(r.missing.some((m) => m.startsWith('popup/popup.js (needed by popup/popup.html)')), r.missing.join('; '));
  assert.ok(r.missing.some((m) => m.startsWith('icons/icon128.png')));
});
