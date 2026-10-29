import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
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

test('an offer at the SDP limit still fits the server\'s signal cap once sealed (Chromium\'s real offer is ~460-720 chars: design/sdp-size.mjs)', async () => {
  const { RELAY_DEFAULTS } = await import('../../sync-server/src/media-relay.mjs');
  const { key } = await roomKeys('token-token-token-1', 'room-1');
  const line = 'a=candidate:1 1 udp 2113937151 0123abcd-4567-89ef-0123-456789abcdef.local 54321 typ host generation 0 network-cost 999\r\n';
  const sdp = line.repeat(Math.ceil(12000 / line.length)).slice(0, 12000);
  assert.ok(checkCtl({ t: 'offer', s: 2 ** 31, sdp }), 'accepted at the limit');
  const f = await sealCtl(key, 2 ** 31, 2 ** 31 - 1, { t: 'offer', sdp, s: 2 ** 31 });
  assert.ok(f.length + 16 <= RELAY_DEFAULTS.signalMaxBytes, 'sealed: ' + f.length + ' bytes');
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
  assert.equal(d.accept(7, 4), 'late', 'asked of 7 before it timed out: expected, not hostile'); assert.equal(d.accept(9, 4), 'unasked');
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
function mk(srv, room, token, refs, files = new Map(), { test: T = null, store = memStore(), limits = { file: 500e6, project: 5e9 }, url = srv.url } = {}) {
  globalThis.__CUE_MEDIA_TEST = T || undefined;
  const doc = new Y.Doc(), provider = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: WebSocket, params: { token }, disableBc: true, maxBackoffTime: 200 });
  const landed = [];
  const m = createMedia({
    provider, roomId: room, token, pid: 'p1', ice: [], store,
    wanted: () => new Map([...refs].map(([h, bytes]) => [h, { bytes, mime: 'application/octet-stream', label: 'f', local: files.has(h) }])),
    localBlob: async h => files.get(h) || null,
    landed: async (h, blob) => { files.set(h, blob); landed.push(h); m.refresh(); },
    clientName: () => 'x', limits: () => limits, onChange: () => {},
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

test('a media frame the client doesn\'t know (newer server or peer: unknown kind, extra fields, garbage) is ignored; files and doc edits still flow', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3374);
  const data = randomBytes(300_000), hex = nodeSha(data), refs = new Map([[hex, data.length]]);
  const peers = [];
  try {
    const A = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]])); peers.push(A);
    const B = mk(srv, r.id, r.token, refs); peers.push(B);
    await until(() => B.provider.wsconnected && B.provider.synced, 5000, 'B connected');
    const ws = B.provider.ws, frame = (...parts) => { const e = encoding.createEncoder(); parts.forEach(p => (p instanceof Uint8Array ? encoding.writeVarUint8Array(e, p) : encoding.writeVarUint(e, p))); return decoding.createDecoder(encoding.toUint8Array(e)); };
    const handle = B.provider.messageHandlers[10];
    for (const dec of [frame(77, 1, Uint8Array.of(1, 2, 3)), frame(200000, 0, new Uint8Array(0)), frame(4), decoding.createDecoder(Uint8Array.of(0xff, 0xff))]) handle(encoding.createEncoder(), dec, B.provider, true, 10);
    await until(() => B.landed.length === 1, 20000, 'B still gets the file');
    assert.ok((await bytesOf(B.files.get(hex))).equals(data));
    A.doc.getMap('meta').set('title', 'after');
    await until(() => B.doc.getMap('meta').get('title') === 'after', 3000, 'doc edits still flow');
    assert.equal(B.provider.ws, ws, 'the same socket');
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

test('limits: video: false (a phone off Wi-Fi) holds video back, images still come; video: true brings it', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3388);
  const vid = randomBytes(CHUNK * 2), hv = nodeSha(vid), img = randomBytes(CHUNK), hi = nodeSha(img), peers = [];
  try {
    const A = mk(srv, r.id, r.token, new Map([[hv, vid.length], [hi, img.length]]), new Map([[hv, new Blob([vid])], [hi, new Blob([img])]])); peers.push(A);
    const doc = new Y.Doc(), provider = new WebsocketProvider(srv.url, r.id, doc, { WebSocketPolyfill: WebSocket, params: { token: r.token }, disableBc: true });
    const files = new Map(), landed = [], lim = { file: 500e6, project: 5e9, video: false };
    const m = createMedia({ provider, roomId: r.id, token: r.token, pid: 'p', ice: [], store: memStore(),
      wanted: () => new Map([[hv, { bytes: vid.length, mime: 'video/mp4', label: 'take', local: files.has(hv) }], [hi, { bytes: img.length, mime: 'image/jpeg', label: 'frame', local: files.has(hi) }]]), localBlob: async h => files.get(h) || null,
      landed: async (h, b) => { files.set(h, b); landed.push(h); }, clientName: () => '', limits: () => lim, onChange: () => {} });
    peers.push({ close() { m.stop(); provider.destroy(); doc.destroy(); } });
    await until(() => landed.length === 1, 10000, 'the image');
    await new Promise(ok => setTimeout(ok, 500));
    assert.deepEqual(landed, [hi]);
    const f = m.files().find(x => x.hex === hv); assert.equal(f.state, 'skipped'); assert.equal(f.skip, 'video');
    lim.video = true; m.refresh();
    await until(() => landed.length === 2, 10000, 'the video once allowed');
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

test('"Download everything now" on the phone is a one-off: the listed files come past video: false, a take added afterwards is held again', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3386);
  const v1 = randomBytes(CHUNK * 2), h1 = nodeSha(v1), v2 = randomBytes(CHUNK), h2 = nodeSha(v2), peers = [];
  try {
    const A = mk(srv, r.id, r.token, new Map([[h1, v1.length], [h2, v2.length]]), new Map([[h1, new Blob([v1])], [h2, new Blob([v2])]])); peers.push(A);
    const doc = new Y.Doc(), provider = new WebsocketProvider(srv.url, r.id, doc, { WebSocketPolyfill: WebSocket, params: { token: r.token }, disableBc: true });
    const files = new Map(), landed = [], lim = { file: 500e6, project: 5e9, video: false }, refs = new Map([[h1, v1.length]]);
    const m = createMedia({ provider, roomId: r.id, token: r.token, pid: 'p', ice: [], store: memStore(),
      wanted: () => new Map([...refs].map(([h, bytes]) => [h, { bytes, mime: 'video/mp4', label: 'take', local: files.has(h) }])), localBlob: async h => files.get(h) || null,
      landed: async (h, b) => { files.set(h, b); landed.push(h); }, clientName: () => '', limits: () => lim, onChange: () => {} });
    peers.push({ close() { m.stop(); provider.destroy(); doc.destroy(); } });
    await until(() => m.files().find(x => x.hex === h1)?.skip === 'video', 5000, 'held for Wi-Fi');
    m.downloadAll([h1]);
    await until(() => landed.length === 1, 10000, 'the listed take');
    // a collaborator adds a take afterwards: still "Wi-Fi only"
    refs.set(h2, v2.length); m.refresh();
    await until(() => m.files().find(x => x.hex === h2)?.state === 'skipped', 5000, 'the new take listed');
    await sleep(800);
    assert.deepEqual(landed, [h1]);
    assert.equal(m.files().find(x => x.hex === h2).skip, 'video');
    // without a list it is the desktop's "Download all now": everything, for the rest of the session
    m.downloadAll();
    await until(() => landed.length === 2, 10000, 'the new take once everything is asked for');
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

test('limits: files over the per-file limit are skipped; "Download" fetches just that one, "Download all now" the rest; a peer asking for a hash the doc doesn\'t reference gets nothing', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3396);
  const data = randomBytes(CHUNK * 3), hex = nodeSha(data), data2 = randomBytes(CHUNK * 2), hex2 = nodeSha(data2), peers = [];
  try {
    const A = mk(srv, r.id, r.token, new Map([[hex, data.length], [hex2, data2.length]]), new Map([[hex, new Blob([data])], [hex2, new Blob([data2])]])); peers.push(A);
    // B: a per-file limit of 1000 bytes
    const doc = new Y.Doc(), provider = new WebsocketProvider(srv.url, r.id, doc, { WebSocketPolyfill: WebSocket, params: { token: r.token }, disableBc: true });
    const files = new Map(), landed = [];
    const m = createMedia({ provider, roomId: r.id, token: r.token, pid: 'p', ice: [], store: memStore(),
      wanted: () => new Map([[hex, { bytes: data.length, mime: '', label: 'f', local: files.has(hex) }], [hex2, { bytes: data2.length, mime: '', label: 'g', local: files.has(hex2) }]]), localBlob: async h => files.get(h) || null,
      landed: async (h, b) => { files.set(h, b); landed.push(h); }, clientName: () => '', limits: () => ({ file: 1000, project: 5e9 }), onChange: () => {} });
    peers.push({ close() { m.stop(); provider.destroy(); doc.destroy(); } });
    await until(() => m.summary().skipped === 2, 5000, 'skipped');
    await new Promise(ok => setTimeout(ok, 500));
    assert.equal(landed.length, 0);
    m.download(hex2);
    await until(() => landed.length === 1, 10000, 'the one asked for');
    await new Promise(ok => setTimeout(ok, 500));
    assert.deepEqual(landed, [hex2]); assert.equal(m.files().find(f => f.hex === hex).state, 'skipped');
    m.downloadAll();
    await until(() => landed.length === 2, 10000, 'downloaded on request');
    // an unreferenced hash: A answers "not found" and serves nothing
    const other = nodeSha(Buffer.from('not in the doc'));
    assert.equal(A.m.stats.sent, data.length + data2.length);
    const X = mk(srv, r.id, r.token, new Map([[other, 10]])); peers.push(X);
    await new Promise(ok => setTimeout(ok, 800));
    assert.equal(X.landed.length, 0); assert.equal(A.m.stats.sent, data.length + data2.length, 'A sent nothing more');
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

const sleep = ms => new Promise(ok => setTimeout(ok, ms));

test('"Download all now", then Pause, a lowered limit, or a smaller file taking the budget: the chunks stored so far are kept and the file resumes from them', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3397);
  const big = randomBytes(CHUNK * 40), hb = nodeSha(big), small = randomBytes(CHUNK * 2), hs = nodeSha(small), peers = [];
  try {
    const refs = new Map([[hb, big.length]]);
    const A = mk(srv, r.id, r.token, refs, new Map([[hb, new Blob([big])], [hs, new Blob([small])]]), { test: { chunkDelay: 30 } }); peers.push(A);
    // 1. over B's per-file limit: skipped; "Download all now"; Pause halfway: what's stored stays, Resume finishes it
    const lim = { file: 1000, project: 5e9 }, B = mk(srv, r.id, r.token, refs, new Map(), { limits: lim }); peers.push(B);
    await until(() => B.m.summary().skipped === 1, 5000, 'skipped');
    B.m.downloadAll();
    await until(() => B.store.chunks.size >= 8, 20000, 'B halfway');
    B.m.pause(true);
    await sleep(1500);
    const kept = B.store.chunks.size;
    assert.ok(kept >= 8 && B.store.parts.has(hb), 'paused: the partial download is still stored (' + kept + ' chunks)');
    B.m.pause(false);
    await until(() => B.landed.length === 1, 30000, 'B resumed and finished');
    assert.ok((await bytesOf(B.files.get(hb))).equals(big));
    assert.equal(B.store.puts, 40, 'every chunk fetched once: nothing stored was thrown away');
    // 2. no override, the limit is lowered mid-download: stopped with its chunks kept; raised again: resumes from them
    const lim2 = { file: 500e6, project: 5e9 }, C = mk(srv, r.id, r.token, refs, new Map(), { limits: lim2 }); peers.push(C);
    await until(() => C.store.chunks.size >= 8, 20000, 'C halfway');
    lim2.file = 1000; C.m.refresh();
    await until(() => C.m.summary().skipped === 1, 5000, 'C skips it now');
    await sleep(800);
    assert.ok(C.store.chunks.size >= 8 && C.store.parts.has(hb), 'lowered limit: chunks kept');
    lim2.file = 500e6; C.m.refresh();
    await until(() => C.landed.length === 1, 30000, 'C resumed');
    assert.ok((await bytesOf(C.files.get(hb))).equals(big));
    assert.equal(C.store.puts, 40);
    // 3. a smaller file added to the doc takes the project budget: the big one stops, keeps its chunks, resumes later
    const refs3 = new Map(refs), lim3 = { file: 500e6, project: big.length + 1000 }, D = mk(srv, r.id, r.token, refs3, new Map(), { limits: lim3 }); peers.push(D);
    await until(() => D.store.chunks.size >= 8, 20000, 'D halfway');
    refs.set(hs, small.length); refs3.set(hs, small.length); A.m.refresh(); D.m.refresh();
    await until(() => D.landed.includes(hs), 20000, 'D got the small file');
    assert.equal(D.m.files().find(f => f.hex === hb).state, 'skipped');
    assert.ok(D.store.chunks.size >= 8 && D.store.parts.has(hb), 'over the budget now: chunks kept');
    lim3.project = 5e9; D.m.refresh();
    await until(() => D.landed.includes(hb), 30000, 'D resumed the big one');
    assert.ok((await bytesOf(D.files.get(hb))).equals(big));
    assert.equal(D.store.puts, 42);
    // 4. the doc lets go of a file whose chunks were kept: they're dropped
    const refs4 = new Map([[hb, big.length]]), lim4 = { file: 500e6, project: 5e9 }, E = mk(srv, r.id, r.token, refs4, new Map(), { limits: lim4 }); peers.push(E);
    await until(() => E.store.chunks.size >= 4, 20000, 'E started');
    lim4.file = 1000; E.m.refresh();
    await until(() => E.m.summary().skipped === 1, 5000, 'E skips it');
    refs4.clear(); E.m.refresh();
    await until(() => E.store.chunks.size === 0 && !E.store.parts.has(hb), 5000, 'kept chunks of a file nobody references are dropped');
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

test('a file bigger than the relay\'s cap is not asked for over the relay: "too large to relay", not "Downloading" forever; smaller files still come', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3398, { media: { relayMaxTransferBytes: 4 * CHUNK } });
  const big = randomBytes(CHUNK * 10), hb = nodeSha(big), small = randomBytes(CHUNK * 3), hs = nodeSha(small), peers = [];
  try {
    const refs = new Map([[hb, big.length], [hs, small.length]]);
    const A = mk(srv, r.id, r.token, refs, new Map([[hb, new Blob([big])], [hs, new Blob([small])]])); peers.push(A);
    const B = mk(srv, r.id, r.token, refs); peers.push(B);
    await until(() => B.landed.includes(hs), 20000, 'the small file came through the relay');
    await until(() => B.m.summary().relay === 1, 5000, 'the big one is reported as too large to relay');
    assert.equal(B.m.files().find(f => f.hex === hb).state, 'relay');
    await sleep(1500);
    assert.equal(B.store.parts.has(hb), false, 'never started');
    assert.equal(A.m.stats.sent, small.length, 'nothing of the big file was sent');
    assert.equal(B.m.summary().active, 0, 'not "Syncing" forever');
    // "Download all now" doesn't change that: it still needs a direct connection
    B.m.downloadAll(); await sleep(1500);
    assert.equal(B.m.summary().relay, 1); assert.equal(A.m.stats.sent, small.length);
  } finally { peers.forEach(p => p.close()); await srv.close(); }
});

/** A pass-through between clients and the server that drops relayed control frames (type 1) while `drop` is on,
    silently or, with `tell`, answering DROPPED like the server does when a receiver's queue is full. */
async function faultyRelay(srv, port) {
  const { WebSocketServer } = await import('ws');
  const enc = await import('lib0/encoding'), dec = await import('lib0/decoding');
  const st = { drop: false, tell: false, dropped: 0 }, wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (c, req) => {
    const up = new WebSocket(srv.url.replace(/\/r$/, '') + req.url), q = [];
    up.on('open', () => { for (const m of q) up.send(m); q.length = 0; });
    up.on('message', m => { if (c.readyState === 1) c.send(m); });
    up.on('close', () => c.close()); up.on('error', () => c.close());
    c.on('close', () => up.close()); c.on('error', () => up.close());
    c.on('message', m => {
      const b = new Uint8Array(m);
      try {
        const d = dec.createDecoder(b);
        if (st.drop && dec.readVarUint(d) === 10 && dec.readVarUint(d) === 3) {
          const to = dec.readVarUint(d), p = dec.readVarUint8Array(d);
          if (p[0] === 1) {
            st.dropped++;
            if (st.tell) { const e = enc.createEncoder(); enc.writeVarUint(e, 10); enc.writeVarUint(e, 6); enc.writeVarUint(e, to); enc.writeVarUint8Array(e, Uint8Array.of(3, ...p.subarray(1, 9))); c.send(enc.toUint8Array(e)); }
            return;
          }
        }
      } catch { /* not ours to judge */ }
      if (up.readyState === 1) up.send(m); else q.push(m);
    });
  });
  await new Promise(ok => wss.on('listening', ok));
  return { st, url: `ws://127.0.0.1:${port}/r`, close: () => new Promise(ok => { for (const c of wss.clients) c.terminate(); wss.close(ok); }) };
}

test('relayed control frames the server drops (have, get, cancel) are sent again: the transfer still completes, with or without DROPPED', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3399), fr = await faultyRelay(srv, 3388);
  const data = randomBytes(CHUNK * 6), hex = nodeSha(data), refs = new Map([[hex, data.length]]), peers = [];
  try {
    // 1. silent loss (a reconnect, a cap the sender isn't told about): only the periodic re-announce can heal it
    fr.st.drop = true;
    const A = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]]), { test: { reannounceMs: 1500 }, url: fr.url }); peers.push(A);
    const B = mk(srv, r.id, r.token, refs, new Map(), { test: { reannounceMs: 1500 }, url: fr.url }); peers.push(B);
    await until(() => fr.st.dropped >= 1 && B.m.summary().unavailable === 1, 10000, 'A\'s `have` dropped: B thinks nobody has it');
    await sleep(2000);
    fr.st.drop = false;
    await until(() => B.landed.length === 1, 15000, 'B got it once frames went through again');
    assert.ok((await bytesOf(B.files.get(hex))).equals(data));
    A.close(); B.close();
    // 2. the server says DROPPED: the sender re-announces soon, not only on the (here: 60 s) period
    fr.st.drop = true; fr.st.tell = true; const n0 = fr.st.dropped;
    const A2 = mk(srv, r.id, r.token, refs, new Map([[hex, new Blob([data])]]), { test: { reannounceMs: 60000 }, url: fr.url }); peers.push(A2);
    const C = mk(srv, r.id, r.token, refs, new Map(), { test: { reannounceMs: 60000 }, url: fr.url }); peers.push(C);
    await until(() => fr.st.dropped > n0, 10000, 'dropped and told');
    await sleep(1500);
    fr.st.drop = false;
    await until(() => C.landed.length === 1, 15000, 'C got it within seconds');
    assert.ok((await bytesOf(C.files.get(hex))).equals(data));
  } finally { peers.forEach(p => p.close()); await fr.close(); await srv.close(); }
});

test('the scheduler runs one tick at a time and leaves at most one timer behind, however often it is poked', async () => {
  const dir = tmpDir(), r = makeRoom(dir), srv = await server(dir, 3387), peers = [];
  const files = [1, 2, 3, 4].map(n => randomBytes(CHUNK * 4 + n)), hexes = files.map(nodeSha), refs = new Map(hexes.map((h, i) => [h, files[i].length]));
  const pend = new Set(), oS = globalThis.setTimeout, oC = globalThis.clearTimeout;
  let maxPend = 0;
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (fn && fn.name === 'tick') { const h = oS(() => { pend.delete(h); fn(...a); }, ms); pend.add(h); maxPend = Math.max(maxPend, pend.size); return h; }
    return oS(fn, ms, ...a);
  };
  globalThis.clearTimeout = h => { pend.delete(h); return oC(h); };
  try {
    const A = mk(srv, r.id, r.token, refs, new Map(hexes.map((h, i) => [h, new Blob([files[i]])]))); peers.push(A);
    const store = memStore(), open = store.open.bind(store);
    let opening = 0, maxOpening = 0;
    store.open = async (h, meta) => { opening++; maxOpening = Math.max(maxOpening, opening); await sleep(150); try { return await open(h, meta); } finally { opening--; } };
    const B = mk(srv, r.id, r.token, refs, new Map(), { store }); peers.push(B);
    const poke = setInterval(() => B.m.refresh(), 5);
    try { await until(() => B.landed.length === 4, 30000, 'all four landed'); } finally { clearInterval(poke); }
    for (const [i, h] of hexes.entries()) assert.ok((await bytesOf(B.files.get(h))).equals(files[i]));
    assert.equal(maxOpening, 1, 'never two ticks opening files at once');
    assert.ok(maxPend <= 1, 'at most one tick timer pending, saw ' + maxPend);
    B.close(); await sleep(50);
    assert.equal(pend.size, 0, 'stop() leaves no tick timer behind');
  } finally { globalThis.setTimeout = oS; globalThis.clearTimeout = oC; peers.forEach(p => p.close()); await srv.close(); }
});
