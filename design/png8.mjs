// Shrinks a screenshot to a 256-colour PNG (no dependency; the README images must stay small):
//   import { png8 } from './png8.mjs';  writeFileSync(path, png8(await page.screenshot()))
// Decodes an 8-bit, non-interlaced RGB/RGBA PNG (what Chromium writes), quantizes it by median cut on a 5-bit
// histogram, and writes an indexed PNG with the best filter per row.
import { inflateSync, deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length), t = Buffer.from(type); out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([t, data])), 8 + data.length); return out; };
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

function decode(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12] !== 0 || (ct !== 2 && ct !== 6)) throw new Error('png8: unsupported PNG'); }
    if (type === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride;
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? px[o + x - bpp] : 0, b = y ? px[o - stride + x] : 0, c = x >= bpp && y ? px[o - stride + x - bpp] : 0, v = raw[src + x];
      px[o + x] = (v + [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]) & 255; } }
  return { w, h, bpp, px };
}

export function png8(buf, K = 0.75) {
  const { w, h, bpp, px } = decode(buf), n = w * h, key = new Uint16Array(n), hist = new Uint32Array(32768);
  for (let i = 0; i < n; i++) { const k = ((px[i * bpp] >> 3) << 10) | ((px[i * bpp + 1] >> 3) << 5) | (px[i * bpp + 2] >> 3); key[i] = k; hist[k]++; }
  // median cut over the occupied histogram cells, weighted by count
  const cells = []; for (let k = 0; k < 32768; k++) if (hist[k]) cells.push(k);
  const ch = (k, c) => (k >> (10 - 5 * c)) & 31;
  let boxes = [cells];
  while (boxes.length < 256) {
    let bi = -1, best = 0, bc = 0;
    boxes.forEach((b, i) => { if (b.length < 2) return; for (let c = 0; c < 3; c++) { let lo = 31, hi = 0; for (const k of b) { const v = ch(k, c); if (v < lo) lo = v; if (v > hi) hi = v; } let cnt = 0; for (const k of b) cnt += hist[k]; const s = (hi - lo) * Math.sqrt(cnt); if (s > best) { best = s; bi = i; bc = c; } } });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => ch(x, bc) - ch(y, bc)); let tot = 0; for (const k of b) tot += hist[k]; let acc = 0, cut = 1;
    for (let i = 0; i < b.length - 1; i++) { acc += hist[b[i]]; if (acc >= tot / 2) { cut = i + 1; break; } }
    boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
  }
  // palette: box means of the histogram cells, then a few k-means passes over the cells (weighted by count)
  const cellRGB = k => [(ch(k, 0) << 3) + 4, (ch(k, 1) << 3) + 4, (ch(k, 2) << 3) + 4];
  let pal = boxes.map(b => { let r = 0, g = 0, bl = 0, c = 0; for (const k of b) { const [x, y, z] = cellRGB(k); r += x * hist[k]; g += y * hist[k]; bl += z * hist[k]; c += hist[k]; } return [r / c, g / c, bl / c]; });
  const nearest = (r, g, b) => { let bi = 0, bd = Infinity; for (let i = 0; i < pal.length; i++) { const p = pal[i], d = (p[0] - r) ** 2 * 2 + (p[1] - g) ** 2 * 3 + (p[2] - b) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; };
  for (let it = 0; it < 4; it++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const k of cells) { const [r, g, b] = cellRGB(k), a = acc[nearest(r, g, b)]; a[0] += r * hist[k]; a[1] += g * hist[k]; a[2] += b * hist[k]; a[3] += hist[k]; }
    pal = pal.map((p, i) => (acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : p));
  }
  pal = pal.map(p => p.map(v => Math.max(0, Math.min(255, Math.round(v)))));
  // map with light Floyd–Steinberg dithering (errors scaled down so flat UI surfaces stay flat), nearest colour cached per 5-bit cell
  const memo = new Int16Array(32768).fill(-1), near = (r, g, b) => { const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); if (memo[k] < 0) memo[k] = nearest((r & 248) + 4, (g & 248) + 4, (b & 248) + 4); return memo[k]; };
  const idx = Buffer.alloc(n), err = new Float32Array((w + 2) * 3 * 2);
  for (let y = 0; y < h; y++) {
    const cur = (y & 1) * (w + 2) * 3, nxt = ((y + 1) & 1) * (w + 2) * 3; err.fill(0, nxt, nxt + (w + 2) * 3);
    for (let x = 0; x < w; x++) { const i = y * w + x, e = cur + (x + 1) * 3, v = [0, 1, 2].map(c => Math.max(0, Math.min(255, px[i * bpp + c] + err[e + c])));
      const q = near(v[0] | 0, v[1] | 0, v[2] | 0); idx[i] = q;
      for (let c = 0; c < 3; c++) { const d = (v[c] - pal[q][c]) * K; err[e + 3 + c] += d * 7 / 16; err[nxt + x * 3 + c] += d * 3 / 16; err[nxt + (x + 1) * 3 + c] += d * 5 / 16; err[nxt + (x + 2) * 3 + c] += d / 16; } }
  }
  pal = Buffer.from(pal.flat());
  // rows with the filter that leaves the smallest sum, as encoders usually pick
  const rows = [];
  for (let y = 0; y < h; y++) { const cur = idx.subarray(y * w, y * w + w), up = y ? idx.subarray((y - 1) * w, y * w) : Buffer.alloc(w); let bestRow = null, bs = Infinity;
    for (let f = 0; f < 5; f++) { const r = Buffer.alloc(w + 1); r[0] = f; let s = 0;
      for (let x = 0; x < w; x++) { const a = x ? cur[x - 1] : 0, b = up[x], c = x ? up[x - 1] : 0; const v = (cur[x] - [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]) & 255; r[x + 1] = v; s += v < 128 ? v : 256 - v; }
      if (s < bs) { bs = s; bestRow = r; } }
    rows.push(bestRow); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', pal), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
