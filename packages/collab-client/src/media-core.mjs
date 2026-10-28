// @ts-check
/* Media layer core (docs/media-p2p.md): the crypto envelope, the frame format, message validation and the receive-side
   bookkeeping of one file. No DOM, no network, no storage: media.mjs wires these to WebRTC, the room's relay and
   IndexedDB, and the tests run them under Node.

   Envelope. key = HKDF-SHA256(ikm = invite token, salt = "cue-board media v1", info = "aes-256-gcm|" + roomId).
   A file is [12-byte base nonce][chunk 0 ciphertext + tag][chunk 1 ...]: chunk i is the plaintext's bytes
   [i*CHUNK, (i+1)*CHUNK), sealed with AES-256-GCM under nonce = base XOR i (in its last 4 bytes) and
   AAD = "cue-media-v1" · sha256 of the whole PLAINTEXT (32) · u32 i · u32 count · u64 size, so a chunk can't be moved
   to another index, file or length. The content id stays the plaintext's sha256 (the doc's refs and dedup are unchanged).
   On the wire a chunk travels with its index and base nonce, so any peer (or a future seed holding the file sealed)
   can serve any chunk. Control messages are JSON sealed under a random nonce with AAD "cue-ctl-v1" · u32 from · u32 to.

   Frames (WebRTC data channel and relay alike):
     control  [1][8 zero bytes][12 nonce][ciphertext + tag]
     chunk    [2][first 8 bytes of the sha256][u32 index][12 base nonce][ciphertext + tag]
   Bytes 1-8 are the relay's transfer tag (media-relay.mjs). */

export const CHUNK = 64 * 1024;
export const MAX_FILE = 8 * 1024 * 1024 * 1024;          // hard ceiling on any size a peer or the doc claims
export const WINDOW = 16;                                 // chunks in flight per download (1 MiB)
export const MAX_QUEUE = 128;                             // chunk requests a peer may have queued with us
export const MAX_HAVE = 4096;                             // hashes a peer may announce
export const HEX = /^[0-9a-f]{64}$/;
const te = new TextEncoder(), td = new TextDecoder('utf-8', { fatal: true });
const subtle = () => globalThis.crypto.subtle;

export const toHex = (/** @type {Uint8Array} */ b) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (/** @type {string} */ h) => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
export const chunkCount = (/** @type {number} */ size) => Math.max(1, Math.ceil(size / CHUNK));
export const chunkLen = (/** @type {number} */ size, /** @type {number} */ i) => (i < chunkCount(size) - 1 ? CHUNK : size - i * CHUNK);
const u32 = (/** @type {DataView} */ v, /** @type {number} */ at, /** @type {number} */ n) => v.setUint32(at, n >>> 0);
const cat = (/** @type {Uint8Array[]} */ ...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

/* ---------- keys ---------- */
/** HKDF-SHA256 (RFC 5869) through WebCrypto. */
export async function hkdf(/** @type {Uint8Array} */ ikm, /** @type {Uint8Array} */ salt, /** @type {Uint8Array} */ info, /** @type {number} */ len) {
  const k = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
/** The room's media key, and a short id of it peers compare (two invite tokens of one room give two keys). */
export async function roomKeys(/** @type {string} */ token, /** @type {string} */ roomId) {
  const ikm = te.encode(token), salt = te.encode('cue-board media v1');
  const raw = await hkdf(ikm, salt, te.encode('aes-256-gcm|' + roomId), 32);
  const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { key, kid: toHex(await hkdf(ikm, salt, te.encode('key-id|' + roomId), 8)) };
}

/* ---------- chunks ---------- */
export function chunkNonce(/** @type {Uint8Array} */ base, /** @type {number} */ i) {
  const n = new Uint8Array(12); n.set(base.subarray(0, 12));   // a copy: `base` may be a view into a larger buffer
  const v = new DataView(n.buffer);
  v.setUint32(8, (v.getUint32(8) ^ i) >>> 0);
  return n;
}
export function chunkAad(/** @type {string} */ hex, /** @type {number} */ i, /** @type {number} */ size) {
  const a = new Uint8Array(12 + 32 + 16), v = new DataView(a.buffer);
  a.set(te.encode('cue-media-v1'), 0); a.set(fromHex(hex), 12);
  u32(v, 44, i); u32(v, 48, chunkCount(size)); u32(v, 52, Math.floor(size / 2 ** 32)); u32(v, 56, size % 2 ** 32);
  return a;
}
export async function sealChunk(/** @type {CryptoKey} */ key, /** @type {string} */ hex, /** @type {number} */ size, /** @type {number} */ i, /** @type {Uint8Array} */ base, /** @type {Uint8Array} */ plain) {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: chunkNonce(base, i), additionalData: chunkAad(hex, i, size) }, key, plain));
}
/** @returns {Promise<Uint8Array | null>} null when the tag doesn't verify */
export async function openChunk(/** @type {CryptoKey} */ key, /** @type {string} */ hex, /** @type {number} */ size, /** @type {number} */ i, /** @type {Uint8Array} */ base, /** @type {Uint8Array} */ ct) {
  try { return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: chunkNonce(base, i), additionalData: chunkAad(hex, i, size) }, key, ct)); } catch { return null; }
}
/** The at-rest format a future always-on seed would hold: [base nonce][sealed chunks]. */
export async function sealFile(/** @type {CryptoKey} */ key, /** @type {string} */ hex, /** @type {Uint8Array} */ plain, base = crypto.getRandomValues(new Uint8Array(12))) {
  const out = [base];
  for (let i = 0; i < chunkCount(plain.length); i++) out.push(await sealChunk(key, hex, plain.length, i, base, plain.subarray(i * CHUNK, i * CHUNK + chunkLen(plain.length, i))));
  return cat(...out);
}
export async function openFile(/** @type {CryptoKey} */ key, /** @type {string} */ hex, /** @type {number} */ size, /** @type {Uint8Array} */ sealed) {
  const base = sealed.subarray(0, 12), out = [];
  let p = 12;
  for (let i = 0; i < chunkCount(size); i++) {
    const n = chunkLen(size, i) + 16, c = await openChunk(key, hex, size, i, base, sealed.subarray(p, p + n));
    if (!c) return null;
    out.push(c); p += n;
  }
  if (p !== sealed.length) return null;
  const plain = cat(...out);
  return toHex(sha256(plain)) === hex ? plain : null;
}

/* ---------- frames ---------- */
export const F_CTL = 1, F_CHUNK = 2;
const ctlAad = (/** @type {number} */ from, /** @type {number} */ to) => { const a = new Uint8Array(18), v = new DataView(a.buffer); a.set(te.encode('cue-ctl-v1')); u32(v, 10, from); u32(v, 14, to); return a; };
export async function sealCtl(/** @type {CryptoKey} */ key, /** @type {number} */ from, /** @type {number} */ to, /** @type {any} */ msg) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: ctlAad(from, to) }, key, te.encode(JSON.stringify(msg))));
  return cat(Uint8Array.of(F_CTL), new Uint8Array(8), nonce, ct);
}
/** @returns {Promise<any>} the message, or null (bad tag, not JSON, wrong frame) */
export async function openCtl(/** @type {CryptoKey} */ key, /** @type {number} */ from, /** @type {number} */ to, /** @type {Uint8Array} */ f) {
  if (f.length < 1 + 8 + 12 + 16 || f[0] !== F_CTL || f.length > 64 * 1024) return null;
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: f.subarray(9, 21), additionalData: ctlAad(from, to) }, key, f.subarray(21));
    const m = JSON.parse(td.decode(pt));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch { return null; }
}
export function chunkFrame(/** @type {string} */ hex, /** @type {number} */ i, /** @type {Uint8Array} */ base, /** @type {Uint8Array} */ ct) {
  const h = new Uint8Array(1 + 8 + 4 + 12); h[0] = F_CHUNK; h.set(fromHex(hex).subarray(0, 8), 1);
  new DataView(h.buffer).setUint32(9, i); h.set(base, 13);
  return cat(h, ct);
}
/** @returns {{ tag: string, i: number, base: Uint8Array, ct: Uint8Array } | null} */
export function parseChunk(/** @type {Uint8Array} */ f) {
  if (f.length < 25 + 16 || f.length > 25 + CHUNK + 16 || f[0] !== F_CHUNK) return null;
  return { tag: toHex(f.subarray(1, 9)), i: new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(9), base: f.slice(13, 25), ct: f.subarray(25) };
}

/* ---------- control messages from a peer: everything is checked ---------- */
const isIdx = (/** @type {any} */ n) => Number.isInteger(n) && n >= 0 && n < 2 ** 32;
const hexList = (/** @type {any} */ l, /** @type {number} */ max) => Array.isArray(l) && l.length <= max && l.every(h => typeof h === 'string' && HEX.test(h));
/** A sealed control message as its fields, or null for anything malformed. `s` is the sender's sequence number. */
export function checkCtl(/** @type {any} */ m) {
  if (!m || typeof m.t !== 'string' || !isIdx(m.s)) return null;
  switch (m.t) {
    case 'hi': return Number.isInteger(m.c) && m.c >= 0 && m.c < 2 ** 53 && (m.kid === undefined || typeof m.kid === 'string') ? { t: 'hi', s: m.s, c: m.c, re: !!m.re } : null;
    case 'offer': case 'answer': return typeof m.sdp === 'string' && m.sdp.length <= 12000 ? { t: m.t, s: m.s, sdp: m.sdp } : null;
    case 'ice': return m.c && typeof m.c === 'object' && typeof m.c.candidate === 'string' && m.c.candidate.length <= 1024 &&
      (m.c.sdpMid == null || (typeof m.c.sdpMid === 'string' && m.c.sdpMid.length <= 32)) && (m.c.sdpMLineIndex == null || isIdx(m.c.sdpMLineIndex))
      ? { t: 'ice', s: m.s, c: { candidate: m.c.candidate, sdpMid: m.c.sdpMid ?? null, sdpMLineIndex: m.c.sdpMLineIndex ?? null } } : null;
    case 'have': case 'lost': return hexList(m.h, 256) ? { t: m.t, s: m.s, h: m.h } : null;
    case 'get': return typeof m.h === 'string' && HEX.test(m.h) && Array.isArray(m.i) && m.i.length >= 1 && m.i.length <= 32 && m.i.every(isIdx) ? { t: 'get', s: m.s, h: m.h, i: [...new Set(m.i)] } : null;
    case 'nf': case 'cancel': return typeof m.h === 'string' && HEX.test(m.h) ? { t: m.t, s: m.s, h: m.h } : null;
    default: return null;
  }
}
/** Replay guard per peer: a sequence number counts once; anything older than the last 1024 is refused. */
export class SeqGuard {
  max = -1; seen = new Set();
  ok(/** @type {number} */ s) {
    if (s <= this.max - 1024 || this.seen.has(s)) return false;
    this.seen.add(s); if (s > this.max) this.max = s;
    if (this.seen.size > 1100) for (const x of this.seen) if (x <= this.max - 1024) this.seen.delete(x);
    return true;
  }
}

/** Backpressure: wait until the transport's queue is under `high` bytes before the next frame goes out.
    @param {{ buffered(): number, waitLow(): Promise<void> }} t */
export async function drain(t, high = 1024 * 1024) { while (t.buffered() > high) await t.waitLow(); }

/* ---------- one file being received ---------- */
/** Which chunks are here (verified and stored), which are asked for and from whom. A chunk counts only once stored;
    everything a peer sends is matched against what was asked of that peer. */
export class Download {
  /** @param {string} hex @param {number} size @param {Iterable<number>} [have] chunks already stored (resume) */
  constructor(hex, size, have = []) {
    if (!HEX.test(hex) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw new Error('bad file');
    this.hex = hex; this.size = size; this.count = chunkCount(size);
    this.bits = new Uint8Array(Math.ceil(this.count / 8)); this.n = 0;
    /** @type {Map<number, { peer: number, t: number }>} */ this.inflight = new Map();
    /** @type {Set<number>} peers whose chunks are in the current attempt */ this.sources = new Set();
    for (const i of have) if (isIdx(i) && i < this.count) this.#set(i);
  }
  has(/** @type {number} */ i) { return !!(this.bits[i >> 3] & (1 << (i & 7))); }
  #set(/** @type {number} */ i) { if (!this.has(i)) { this.bits[i >> 3] |= 1 << (i & 7); this.n++; } }
  get done() { return this.n === this.count; }
  get bytes() { let b = this.n * CHUNK; if (this.has(this.count - 1)) b -= CHUNK - chunkLen(this.size, this.count - 1); return Math.min(b, this.size); }
  /** Up to `max` missing chunks not yet asked for, lowest first; marked as asked of `peer`. */
  take(/** @type {number} */ peer, /** @type {number} */ max, now = Date.now()) {
    const out = [];
    for (let i = 0; i < this.count && out.length < max; i++) if (!this.has(i) && !this.inflight.has(i)) { this.inflight.set(i, { peer, t: now }); out.push(i); }
    return out;
  }
  inflightFrom(/** @type {number} */ peer) { let n = 0; for (const v of this.inflight.values()) if (v.peer === peer) n++; return n; }
  /** A chunk arrived from `peer`: 'ok' to store it, else why it's refused ('range', 'unasked', 'dup'). */
  accept(/** @type {number} */ peer, /** @type {number} */ i) {
    if (!isIdx(i) || i >= this.count) return 'range';
    if (this.has(i)) return 'dup';
    const f = this.inflight.get(i);
    if (!f || f.peer !== peer) return 'unasked';
    return 'ok';
  }
  /** Stored and verified. */
  stored(/** @type {number} */ peer, /** @type {number} */ i) { this.inflight.delete(i); this.#set(i); this.sources.add(peer); }
  /** Forget what was asked of `peer` (it left, timed out or was dropped); returns how many. */
  release(/** @type {number} */ peer) { let n = 0; for (const [i, v] of this.inflight) if (v.peer === peer) { this.inflight.delete(i); n++; } return n; }
  /** Requests older than `ms`: their peers. */
  stale(/** @type {number} */ ms, now = Date.now()) { const s = new Set(); for (const v of this.inflight.values()) if (now - v.t > ms) s.add(v.peer); return s; }
  /** The whole file failed its hash: start over. */
  reset() { this.bits.fill(0); this.n = 0; this.inflight.clear(); this.sources.clear(); }
}

/* ---------- SHA-256, incremental (WebCrypto has no streaming digest; a 500 MB take must not be read at once) ---------- */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export class Sha256 {
  h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  buf = new Uint8Array(64); bl = 0; len = 0; w = new Uint32Array(64);
  #block(/** @type {Uint8Array} */ b, /** @type {number} */ o) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + w[i - 16];
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  update(/** @type {Uint8Array} */ d) {
    let i = 0; this.len += d.length;
    if (this.bl) { while (i < d.length && this.bl < 64) this.buf[this.bl++] = d[i++]; if (this.bl === 64) { this.#block(this.buf, 0); this.bl = 0; } }
    for (; i + 64 <= d.length; i += 64) this.#block(d, i);
    while (i < d.length) this.buf[this.bl++] = d[i++];
    return this;
  }
  digest() {
    const bits = this.len * 8, pad = new Uint8Array(((this.bl < 56 ? 56 : 120) - this.bl) + 8), v = new DataView(pad.buffer);
    pad[0] = 0x80; v.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32)); v.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    const out = new Uint8Array(32), ov = new DataView(out.buffer);
    this.h.forEach((x, i) => ov.setUint32(i * 4, x));
    return out;
  }
}
export const sha256 = (/** @type {Uint8Array} */ d) => new Sha256().update(d).digest();
/** sha256 of a Blob, read 4 MiB at a time. */
export async function sha256Blob(/** @type {Blob} */ b, step = 4 * 1024 * 1024) {
  const h = new Sha256();
  for (let p = 0; p < b.size; p += step) h.update(new Uint8Array(await b.slice(p, p + step).arrayBuffer()));
  return toHex(h.digest());
}
