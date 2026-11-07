// Renders Hackie (extension/assets/hackie.gif, frame 0) as PNG toolbar icons. No dependencies:
// node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodeGif } from './gif.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const GIF = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'assets', 'hackie.gif');
// The visible robot inside the 64x64 GIF (all frames), padded to a square.
const CROP = { x: 8, y: 7, w: 42, h: 48 };

// --- PNG encoding -----------------------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}


// Chrome's icon guidance: 128px icons draw the art in the middle 96px.
const ART = { 16: 16, 32: 32, 48: 48, 128: 96 };

function render(size, frame, gifWidth) {
  const side = Math.max(CROP.w, CROP.h); // 48
  const art = ART[size];
  const pad = (size - art) / 2;
  const out = Buffer.alloc(size * size * 4);
  const scale = side / art; // source pixels per output pixel
  for (let py = 0; py < art; py++) {
    for (let px = 0; px < art; px++) {
      // Box-filter the source area covered by this output pixel (exact copy when scale is 1 or 0.5).
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = px * scale, x1 = (px + 1) * scale, y0 = py * scale, y1 = (py + 1) * scale;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          n++;
          const gx = CROP.x + sx - (side - CROP.w) / 2;
          const gy = CROP.y + sy - (side - CROP.h) / 2;
          if (gx < CROP.x || gx >= CROP.x + CROP.w || gy < CROP.y || gy >= CROP.y + CROP.h) continue;
          const o = (gy * gifWidth + gx) * 4;
          const alpha = frame[o + 3];
          r += frame[o] * alpha; g += frame[o + 1] * alpha; b += frame[o + 2] * alpha; a += alpha;
        }
      }
      const i = ((py + pad) * size + (px + pad)) * 4;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const gif = decodeGif(readFileSync(GIF));
mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size, gif.frames[0].rgba, gif.width)));
  console.log('wrote', file);
}
