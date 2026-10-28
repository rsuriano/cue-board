import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { tmpDir, server, makeRoom, until } from '../../sync-server/test/helpers.mjs';
import {
  CHUNK, hkdf, roomKeys, sealChunk, openChunk, chunkNonce, chunkAad, sealFile, openFile, sealCtl, openCtl, chunkFrame, parseChunk,
  checkCtl, SeqGuard, Download, drain, Sha256, sha256, sha256Blob, toHex, fromHex, chunkCount,
} from '../src/media-core.mjs';
import { createMedia } from '../src/media.mjs';
import { parseIce } from '../src/collab.mjs';

const nodeSha = b => createHash('sha256').update(b).digest('hex');

test('known answers: HKDF (RFC 5869 case 1), AES-256-GCM (GCM spec case 14), SHA-256', async () => {
  const okm = await hkdf(new Uint8Array(22).fill(0x0b), fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
  assert.equal(toHex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  const k = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, k, new Uint8Array(16)));
  assert.equal(toHex(ct), 'cea7403d4d606b6e074ec5d3baf39d18' + 'd0d1c8a799996bf0265b98b5d48ab919');
  assert.equal(toHex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(toHex(sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const n of [1, 55, 56, 63, 64, 65, 1000, 200_003]) { const b = randomBytes(n); assert.equal(toHex(sha256(b)), nodeSha(b), 'size ' + n); }
  const big = randomBytes(3 * 1024 * 1024 + 17), h = new Sha256();
  for (let p = 0; p < big.length; p += 77_777) h.update(big.subarray(p, p + 77_777));
  assert.equal(toHex(h.digest()), nodeSha(big), 'incremental, odd slices');
  assert.equal(await sha256Blob(new Blob([big]), 1 << 20), nodeSha(big));
});

test('envelope: room key and chunk sealing match an independent implementation (node:crypto)', async () => {
  const token = 'tok_' + 'x'.repeat(20), room = 'room-abcdefghijkl';
  const raw = Buffer.from(hkdfSync('sha256', token, 'cue-board media v1', 'aes-256-gcm|' + room, 32));
  const { key, kid } = await roomKeys(token, room);
  assert.equal(kid, Buffer.from(hkdfSync('sha256', token, 'cue-board media v1', 'key-id|' + room, 8)).toString('hex'));
  assert.notEqual((await roomKeys('other-token-000000', room)).kid, kid, 'another invite token, another key');
  const plain = randomBytes(CHUNK * 2 + 5), hex = nodeSha(plain), base = randomBytes(12), i = 2;
  const pc = plain.subarray(i * CHUNK);
  const c = createCipheriv('aes-256-gcm', raw, chunkNonce(base, i)); c.setAAD(chunkAad(hex, i, plain.length));
  const want = Buffer.concat([c.update(pc), c.final(), c.getAuthTag()]);
  assert.deepEqual(Buffer.from(await sealChunk(key, hex, plain.length, i, base, pc)), want);
  assert.deepEqual(Buffer.from(chunkNonce(base, i)).subarray(0, 8), base.subarray(0, 8));
  assert.equal(Buffer.from(chunkNonce(base, i)).readUInt32BE(8), (base.readUInt32BE(8) ^ i) >>> 0);
});

test('envelope: [nonce][sealed chunks] round-trips; any tampering, reorder, truncation or wrong id fails', async () => {
  const { key } = await roomKeys('token-token-token-1', 'room-1');
  const plain = randomBytes(CHUNK * 3 + 100), hex = nodeSha(plain), f = await sealFile(key, hex, plain);
  assert.equal(f.length, 12 + plain.length + 4 * 16);
  assert.deepEqual(Buffer.from(await openFile(key, hex, plain.length, f)), plain);
  const flip = f.slice(); flip[40] ^= 1;
  assert.equal(await openFile(key, hex, plain.length, flip), null, 'bit flip');
  const swap = f.slice(); swap.set(f.subarray(12, 12 + CHUNK + 16), 12 + CHUNK + 16); swap.set(f.subarray(12 + CHUNK + 16, 12 + 2 * (CHUNK + 16)), 12);
  assert.equal(await openFile(key, hex, plain.length, swap), null, 'chunks swapped');
  assert.equal(await openFile(key, hex, plain.length, f.subarray(0, f.length - 1)), null, 'truncated');
  assert.equal(await openFile(key, nodeSha(Buffer.from('other')), plain.length, f), null, 'another content id');
  const { key: k2 } = await roomKeys('token-token-token-2', 'room-1');
  assert.equal(await openFile(k2, hex, plain.length, f), null, 'another key');
  // control frames: bound to sender and receiver
  const cf = await sealCtl(key, 3, 4, { t: 'nf', s: 1, h: hex });
  assert.deepEqual(await openCtl(key, 3, 4, cf), { t: 'nf', s: 1, h: hex });
  assert.equal(await openCtl(key, 3, 5, cf), null, 'replayed to another peer');
  assert.equal(await openCtl(key, 4, 3, cf), null, 'reflected');
  // chunk frames
  const fr = chunkFrame(hex, 7, new Uint8Array(12).fill(9), new Uint8Array(100));
  assert.deepEqual({ ...parseChunk(fr), ct: undefined, base: undefined }, { tag: hex.slice(0, 16), i: 7, ct: undefined, base: undefined });
  assert.equal(parseChunk(new Uint8Array(25 + CHUNK + 17)), null, 'oversized');
  assert.equal(parseChunk(new Uint8Array(30)), null, 'too short');
  assert.equal((await openChunk(key, hex, plain.length, 0, new Uint8Array(12), new Uint8Array(40))), null);
});

test('control messages from peers are validated; replays refused', () => {
  const h = 'a'.repeat(64);
  assert.ok(checkCtl({ t: 'get', s: 1, h, i: [0, 1, 1] }));
  assert.deepEqual(checkCtl({ t: 'get', s: 1, h, i: [0, 1, 1] }).i, [0, 1], 'duplicates folded');
  for (const bad of [null, [], { t: 'get', s: 1, h, i: [] }, { t: 'get', s: 1, h, i: Array(33).fill(0) }, { t: 'get', s: 1, h, i: [-1] }, { t: 'get', s: 1, h, i: [1.5] },
    { t: 'get', s: 1, h: 'A'.repeat(64), i: [0] }, { t: 'get', h, i: [0] }, { t: 'have', s: 1, h: Array(257).fill(h) }, { t: 'have', s: 1, h: ['../x'] },
    { t: 'offer', s: 1, sdp: 'x'.repeat(12001) }, { t: 'ice', s: 1, c: { candidate: 'x'.repeat(1025) } }, { t: 'hi', s: 1, c: 'x' }, { t: 'eval', s: 1 }])
    assert.equal(checkCtl(bad), null, JSON.stringify(bad)?.slice(0, 60));
  const g = new SeqGuard();
  assert.ok(g.ok(5)); assert.ok(!g.ok(5)); assert.ok(g.ok(3)); assert.ok(g.ok(3000)); assert.ok(!g.ok(100), 'too old');
  assert.deepEqual(parseIce('stun:stun.example.dev:3478, turn:u1:s3cret@turn.example.dev:3478?transport=udp javascript:alert(1)'),
    [{ urls: 'stun:stun.example.dev:3478' }, { urls: 'turn:turn.example.dev:3478?transport=udp', username: 'u1', credential: 's3cret' }]);
  assert.deepEqual(parseIce(''), []);
});

test('Download: window, resume from stored chunks, only asked chunks from the asked peer, stale requests, reset', () => {
  const hex = 'b'.repeat(64), size = CHUNK * 10 + 1, d = new Download(hex, size, [0, 1, 2, 99]);
  assert.equal(d.count, 11); assert.equal(d.n, 3, 'resumed: three stored, out-of-range ignored');
  assert.deepEqual(d.take(7, 4, 0), [3, 4, 5, 6]);
  assert.equal(d.accept(7, 3), 'ok'); assert.equal(d.accept(8, 4), 'unasked', 'another peer'); assert.equal(d.accept(7, 1), 'dup');
  assert.equal(d.accept(7, 11), 'range'); assert.equal(d.accept(7, 2 ** 40), 'range');
  d.stored(7, 3); assert.equal(d.accept(7, 3), 'dup');
  assert.deepEqual([...d.stale(1000, 5000)], [7]);
  assert.equal(d.release(7), 3); assert.deepEqual(d.take(8, 100, 0), [4, 5, 6, 7, 8, 9, 10]);
  for (const i of [4, 5, 6, 7, 8, 9, 10]) d.stored(8, i);
  assert.ok(d.done); assert.equal(d.bytes, size); assert.deepEqual([...d.sources].sort(), [7, 8]);
  d.reset(); assert.equal(d.n, 0); assert.ok(!d.done);
  assert.throws(() => new Download('x', 1)); assert.throws(() => new Download(hex, -1)); assert.throws(() => new Download(hex, 2 ** 40));
  assert.equal(chunkCount(0), 1);
});

test('backpressure: nothing is sent while the queue is over the high-water mark', async () => {
  let buf = 0, max = 0; const t = { buffered: () => buf, waitLow: () => new Promise(r => setTimeout(() => { buf = Math.max(0, buf - 300_000); r(); }, 2)) };
  for (let i = 0; i < 40; i++) { await drain(t, 1_000_000); buf += 70_000; max = Math.max(max, buf); }
  assert.ok(max <= 1_070_000, 'queue stayed under high + one frame: ' + max);
});

/* ---------- end to end through the real server's relay (Node has no WebRTC) ---------- */
function memStore() {
  const parts = new Map(), chunks = new Map();
  return {
    parts, chunks, full: false, puts: 0,
    async open(hex, meta) { const o = parts.get(hex); if (o && o.size === meta.size) return [...chunks.keys()].filter(k => k.startsWith(hex + ':')).map(k => +k.split(':')[1]); parts.set(hex, meta); return []; },
    async put(hex, i, b) { if (this.full) return false; this.puts++; chunks.set(hex + ':' + i, new Blob([b])); return true; },
    async read(hex, count) { const o = []; for (let i = 0; i < count; i++) { const b = chunks.get(hex + ':' + i); if (!b) return null; o.push(b); } return o; },
    async drop(hex) { for (const k of [...chunks.keys()]) if (k.startsWith(hex + ':')) chunks.delete(k); parts.delete(hex); },
  };
}
/** a peer: `files` (hex -> Blob) is what it has, `refs` (hex -> size) what the doc references */
function mk(srv, room, token, refs, files = new Map(), { test: T = null, store = memStore() } = {}) {
  globalThis.__CUE_MEDIA_TEST = T || undefined;
  const doc = new Y.Doc(), provider = new WebsocketProvider(srv.url, room, doc, { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true, maxBackoffTime: 200 });
  const landed = [];
  const m = createMedia({
    provider, roomId: room, token, pid: 'p1', ice: [], store,
    wanted: () => new Map([...refs].map(([h, bytes]) => [h, { bytes, mime: 'application/octet-stream', label: 'f', local: files.has(h) }])),
    localBlob: async h => files.get(h) || null,
    landed: async (h, blob) => { files.set(h, blob); landed.push(h); m.refresh(); },
    clientName: () => 'x', limits: () => ({ file: 500e6, project: 5e9 }), onChange: () => {},
  });
  globalThis.__CUE_MEDIA_TEST = undefined;
  return { m, provider, doc, files, landed, store, close() { m.stop(); provider.destroy(); doc.destroy(); } };
}
const bytesOf = async b => Buffer.from(await b.arrayBuffer());

test('relay path: B and C replicate A\'s file; C still gets it from B when A leaves; verified byte for byte', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3393);
  const data = randomBytes(3 * 1024 * 1024 + 333), hex = nodeSha(data), refs = new Map([[hex, data.length]]);
  const peers = [];
  try {
    const A = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]])); peers.push(A);
    const B = mk(srv, r.id, r.token, refs); peers.push(B);
    await until(() => B.landed.length === 1, 20000, 'B got it');
    assert.ok((await bytesOf(B.files.get(hex))).equals(data));
    assert.equal(B.store.chunks.size, 0, 'parts dropped after landing');
    A.close();
    const C = mk(srv, r.id, r.token, refs); peers.push(C);
    await until(() => C.landed.length === 1, 20000, 'C got it from B');
    assert.ok((await bytesOf(C.files.get(hex))).equals(data));
    assert.ok(B.m.stats.sent >= data.length, 'B served it');
    // a peer that joined with another invite token (another key) can't read or be read: nothing is exchanged
    const other = await import('../../sync-server/src/store.mjs').then(({ ProjectStore }) => new ProjectStore(dir).addToken(r.id));
    const D = mk(srv, r.id, other, refs); peers.push(D);
    await until(() => C.m.summary().foreign >= 1, 5000, 'C sees a peer it can\'t read');
    await new Promise(ok => setTimeout(ok, 800));
    assert.equal(D.landed.length, 0); assert.equal(D.m.summary().unavailable, 1);
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

test('resume: a receiver with half the chunks stored asks only for the rest; a corrupted chunk is rejected, the bad peer dropped, the chunk refetched', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3394);
  const data = randomBytes(CHUNK * 40 + 9), hex = nodeSha(data), refs = new Map([[hex, data.length]]), peers = [];
  try {
    const store = memStore();
    await store.open(hex, { size: data.length });
    for (let i = 0; i < 20; i++) await store.put(hex, i, data.subarray(i * CHUNK, (i + 1) * CHUNK));
    store.puts = 0;
    const A = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]])); peers.push(A);
    const B = mk(srv, r.id, r.token, refs, new Map(), { store }); peers.push(B);
    await until(() => B.landed.length === 1, 20000, 'B resumed');
    assert.equal(store.puts, 21, 'only the 21 missing chunks were fetched');
    assert.ok((await bytesOf(B.files.get(hex))).equals(data));
    // E corrupts one chunk it serves; A is honest. C must reject it, drop E, and finish from A
    A.close(); B.close();
    const E = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]]), { test: { corrupt: new Set([0, 1, 2, 3]) } }); peers.push(E);
    const C = mk(srv, r.id, r.token, refs); peers.push(C);
    await until(() => C.m.stats.banned === 1, 20000, 'E dropped');
    const A2 = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]])); peers.push(A2);
    await until(() => C.landed.length === 1, 20000, 'C finished from an honest peer');
    assert.ok((await bytesOf(C.files.get(hex))).equals(data));
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

test('races: source leaves mid-transfer (another one finishes it); remote delete mid-transfer drops the parts; storage full pauses', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3395);
  const data = randomBytes(CHUNK * 60), hex = nodeSha(data), refs = new Map([[hex, data.length]]), peers = [];
  try {
    const slow = { chunkDelay: 15 };
    const A = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]]), { test: slow }); peers.push(A);
    const B = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]]), { test: slow }); peers.push(B);
    const C = mk(srv, r.id, r.token, refs); peers.push(C);
    await until(() => C.store.chunks.size >= 10, 20000, 'C halfway');
    const src = C.m.stats.recv; assert.ok(src > 0);
    // whoever is serving leaves; the other has it too
    (A.m.stats.sent > B.m.stats.sent ? A : B).close();
    await until(() => C.landed.length === 1, 30000, 'C finished from the other');
    assert.ok((await bytesOf(C.files.get(hex))).equals(data));
    // remote delete while downloading: the doc stops referencing it
    const refsD = new Map(refs), D = mk(srv, r.id, r.token, refsD); peers.push(D);
    await until(() => D.store.chunks.size >= 5, 20000, 'D started');
    refsD.clear(); D.m.refresh();
    await until(() => D.store.chunks.size === 0 && D.store.parts.size === 0, 5000, 'D dropped the parts');
    await new Promise(ok => setTimeout(ok, 600));
    assert.equal(D.landed.length, 0, 'nothing lands for a file nobody references');
    assert.equal(D.store.chunks.size, 0, 'late chunks are not written back');
    // storage full: the write fails, the transfer pauses with a flag, nothing lands half-written
    const st = memStore(); st.full = true;
    const F = mk(srv, r.id, r.token, refs, new Map(), { store: st }); peers.push(F);
    await until(() => F.m.summary().storageFull, 20000, 'storage full reported');
    assert.equal(F.landed.length, 0);
    st.full = false; F.m.downloadAll();
    await until(() => F.landed.length === 1, 30000, 'retried after space was freed');
    assert.ok((await bytesOf(F.files.get(hex))).equals(data));
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

test('limits: a file over the per-file limit is skipped until "Download all now"; a peer asking for a hash the doc doesn\'t reference gets nothing', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3396);
  const data = randomBytes(CHUNK * 3), hex = nodeSha(data), peers = [];
  try {
    const A = mk(srv, r.id, r.token, new Map([[hex, data.length]]), new Map([[hex, new Blob([data])]])); peers.push(A);
    // B: a per-file limit of 1000 bytes
    const doc = new Y.Doc(), provider = new WebsocketProvider(srv.url, r.id, doc, { WebSocketPolyfill: WebSocket, params: { token: r.token }, disableBc: true });
    const files = new Map(), landed = [];
    const m = createMedia({ provider, roomId: r.id, token: r.token, pid: 'p', ice: [], store: memStore(),
      wanted: () => new Map([[hex, { bytes: data.length, mime: '', label: 'f', local: files.has(hex) }]]), localBlob: async h => files.get(h) || null,
      landed: async (h, b) => { files.set(h, b); landed.push(h); }, clientName: () => '', limits: () => ({ file: 1000, project: 5e9 }), onChange: () => {} });
    peers.push({ close() { m.stop(); provider.destroy(); doc.destroy(); } });
    await until(() => m.summary().skipped === 1, 5000, 'skipped');
    await new Promise(ok => setTimeout(ok, 500));
    assert.equal(landed.length, 0);
    m.downloadAll();
    await until(() => landed.length === 1, 10000, 'downloaded on request');
    // an unreferenced hash: A answers "not found" and serves nothing
    const other = nodeSha(Buffer.from('not in the doc'));
    assert.equal(A.m.stats.sent, data.length);
    const X = mk(srv, r.id, r.token, new Map([[other, 10]])); peers.push(X);
    await new Promise(ok => setTimeout(ok, 800));
    assert.equal(X.landed.length, 0); assert.equal(A.m.stats.sent, data.length, 'A sent nothing more');
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});
