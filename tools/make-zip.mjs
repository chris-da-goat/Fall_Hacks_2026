// Packages extension/ as dist/hackie-extension-<version>.zip, with every file under a top-level
// hackie/ folder, so unzipping gives a folder you can load unpacked in chrome://extensions.
// No dependencies: a minimal ZIP writer (DEFLATE via node:zlib) plus a reader that re-checks the result.
//
//   npm run zip        (or: node tools/make-zip.mjs)
//
// Exits non-zero if the manifest is broken, tools/check-extension.mjs (when present) reports missing
// files, or the written zip does not match extension/ byte for byte.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');
const CHECKER = join(ROOT, 'tools', 'check-extension.mjs');
const TOP = 'hackie/';
const JUNK = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX']);
// Fixed timestamp (1980-01-01 00:00:00, the earliest DOS date) so identical input gives an identical zip.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800; // general-purpose bit 11: names are UTF-8
const FILE_MODE = 0o100644; // regular file, rw-r--r-- (stored in the high 16 bits of external attributes)

class Fail extends Error {}

// --- CRC-32 (IEEE 802.3, as used by ZIP) --------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Input -------------------------------------------------------------------
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (JUNK.has(name)) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  // Plain code-unit order, not locale order, so the result is the same on every machine.
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readManifest() {
  const file = join(EXT, 'manifest.json');
  if (!existsSync(file)) throw new Fail(`extension/manifest.json not found (looked in ${EXT})`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Fail(`extension/manifest.json does not parse: ${err.message}`);
  }
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Fail(`extension/manifest.json has no valid "version" (got ${JSON.stringify(version)})`);
  }
  return manifest;
}

async function runChecker() {
  if (!existsSync(CHECKER)) {
    console.log('make-zip: tools/check-extension.mjs not found; skipping the missing-file check.');
    return;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(CHECKER).href);
  } catch (err) {
    throw new Fail(`could not load tools/check-extension.mjs: ${err.message}`);
  }
  if (typeof mod.checkExtension !== 'function') throw new Fail('tools/check-extension.mjs does not export checkExtension(dir)');
  const result = await mod.checkExtension(EXT);
  const missing = result?.missing ?? [];
  const caseMismatch = result?.caseMismatch ?? [];
  if (!result?.ok || missing.length || caseMismatch.length) {
    const lines = ['extension/ is incomplete; refusing to package it.'];
    if (missing.length) lines.push(`  missing files referenced by the extension:\n    ${missing.join('\n    ')}`);
    if (caseMismatch.length) lines.push(`  references whose letter case differs from the file on disk:\n    ${caseMismatch.join('\n    ')}`);
    if (!missing.length && !caseMismatch.length) lines.push('  check-extension reported ok: false without details.');
    throw new Fail(lines.join('\n'));
  }
}

// --- ZIP writer ----------------------------------------------------------------
function buildZip(entries) {
  if (entries.length > 0xffff) throw new Fail(`too many files for a non-ZIP64 archive (${entries.length})`);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    // Already-compressed files (PNG, WOFF2, GIF) are stored as-is when DEFLATE would make them bigger.
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    if (data.length > 0xfffffffe || offset + 30 + nameBuf.length + body.length > 0xfffffffe) {
      throw new Fail('archive would exceed 4 GiB; ZIP64 is not supported');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix, 2.0 (so the mode below is honoured)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // file comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // offset of local header
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where the central directory starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// --- ZIP reader (only what buildZip writes: no ZIP64, no encryption, no data descriptors) -------
function readZip(buf) {
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) throw new Fail('verify: end-of-central-directory record not found');
  const count = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  let p = buf.readUInt32LE(eocdAt + 16);
  if (p + cdSize !== eocdAt) throw new Fail('verify: central directory size/offset do not line up with the EOCD record');
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Fail(`verify: bad central directory signature at entry ${i}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!(flags & UTF8_FLAG)) throw new Fail(`verify: ${name} is missing the UTF-8 flag`);
    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Fail(`verify: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    if (buf.toString('utf8', localAt + 30, localAt + 30 + lNameLen) !== name) throw new Fail(`verify: local and central names differ for ${name}`);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 8) data = inflateRawSync(raw);
    else if (method === 0) data = raw;
    else throw new Fail(`verify: ${name} uses unexpected compression method ${method}`);
    if (data.length !== usize) throw new Fail(`verify: ${name} inflates to ${data.length} bytes, header says ${usize}`);
    if (crc32(data) !== crc) throw new Fail(`verify: CRC-32 mismatch for ${name}`);
    if (files.has(name)) throw new Fail(`verify: duplicate entry ${name}`);
    files.set(name, data);
  }
  return files;
}

function verify(zipPath, entries) {
  const files = readZip(readFileSync(zipPath));
  if (files.size !== entries.length) throw new Fail(`verify: zip has ${files.size} files, extension/ has ${entries.length}`);
  for (const { name, rel } of entries) {
    const got = files.get(name);
    if (!got) throw new Fail(`verify: ${name} is missing from the zip`);
    if (!got.equals(readFileSync(join(EXT, ...rel.split('/'))))) throw new Fail(`verify: ${name} differs from extension/${rel}`);
  }
}

// -------------------------------------------------------------------------------
async function main() {
  const { version } = readManifest();
  await runChecker();

  const rels = listFiles(EXT);
  if (!rels.length) throw new Fail('extension/ has no files');
  const entries = rels.map((rel) => ({ rel, name: TOP + rel, data: readFileSync(join(EXT, ...rel.split('/'))) }));

  mkdirSync(DIST, { recursive: true });
  const zipPath = join(DIST, `hackie-extension-${version}.zip`);
  const tmpPath = `${zipPath}.tmp`;
  writeFileSync(tmpPath, buildZip(entries));
  try {
    verify(tmpPath, entries);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
  renameSync(tmpPath, zipPath);

  const size = statSync(zipPath).size;
  const shown = relative(ROOT, zipPath).split('\\').join('/');
  console.log(`make-zip: wrote ${shown} (${entries.length} files, ${(size / 1024).toFixed(1)} KiB, ${size} bytes), verified against extension/`);
}

main().catch((err) => {
  console.error(`make-zip: ${err instanceof Fail ? err.message : err.stack || err}`);
  process.exitCode = 1;
});
