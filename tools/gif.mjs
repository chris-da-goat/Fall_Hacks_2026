// Minimal GIF decoder (no dependencies) used by tools/make-icons.mjs.
// Returns fully composited RGBA frames, honoring transparency and disposal methods.

export function decodeGif(buf) {
  let p = 0;
  const u8 = () => buf[p++];
  const u16 = () => {
    const v = buf[p] | (buf[p + 1] << 8);
    p += 2;
    return v;
  };
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('Not a GIF');
  p = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); // background color index
  u8(); // aspect
  const readTable = (size) => {
    const t = [];
    for (let i = 0; i < size; i++) t.push([buf[p++], buf[p++], buf[p++]]);
    return t;
  };
  const globalTable = packed & 0x80 ? readTable(1 << ((packed & 7) + 1)) : null;

  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let gce = { transparent: -1, disposal: 0, delay: 0 };

  const readSubBlocks = () => {
    const parts = [];
    for (let size = u8(); size; size = u8()) {
      parts.push(buf.subarray(p, p + size));
      p += size;
    }
    return Buffer.concat(parts);
  };

  while (p < buf.length) {
    const block = u8();
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8(); // block size (4)
        const flags = u8();
        const delay = u16();
        const tIndex = u8();
        u8(); // terminator
        gce = { transparent: flags & 1 ? tIndex : -1, disposal: (flags >> 2) & 7, delay: delay * 10 };
      } else {
        readSubBlocks();
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`Unexpected block 0x${block.toString(16)}`);

    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const ipacked = u8();
    const table = ipacked & 0x80 ? readTable(1 << ((ipacked & 7) + 1)) : globalTable;
    const interlaced = Boolean(ipacked & 0x40);
    const minCode = u8();
    const indices = lzwDecode(readSubBlocks(), minCode, w * h);

    const before = gce.disposal === 3 ? canvas.slice() : null;
    const rows = interlaced ? interlaceOrder(h) : [...Array(h).keys()];
    for (let i = 0; i < h; i++) {
      const y = top + rows[i];
      if (y >= height) continue;
      for (let x = 0; x < w; x++) {
        const idx = indices[i * w + x];
        if (idx === gce.transparent || idx == null || !table[idx]) continue;
        const cx = left + x;
        if (cx >= width) continue;
        const o = (y * width + cx) * 4;
        const [r, g, b] = table[idx];
        canvas[o] = r;
        canvas[o + 1] = g;
        canvas[o + 2] = b;
        canvas[o + 3] = 255;
      }
    }
    frames.push({ rgba: canvas.slice(), delay: gce.delay });

    if (gce.disposal === 2) {
      for (let y = top; y < Math.min(height, top + h); y++) {
        canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
      }
    } else if (gce.disposal === 3 && before) {
      canvas.set(before);
    }
    gce = { transparent: -1, disposal: 0, delay: 0 };
  }
  return { width, height, frames };
}

function interlaceOrder(h) {
  const order = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < h; y += step) order.push(y);
  }
  return order;
}

function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push(null, null);
    codeSize = minCodeSize + 1;
  };
  reset();
  const out = [];
  let bitPos = 0;
  let prev = null;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[(bitPos + i) >> 3];
      if (byte === undefined) return end;
      code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += codeSize;
    return code;
  };
  while (out.length < pixelCount) {
    const code = readCode();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}
