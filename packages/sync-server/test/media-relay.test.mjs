import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { tmpDir, server, makeRoom, until } from './helpers.mjs';
import { MSG_MEDIA, K, DROP, Bucket, RELAY_DEFAULTS, createMediaRelay } from '../src/media-relay.mjs';
import { MEDIA_CHUNK, RELAY_MAX_FILE, relayable } from '../src/media-limits.mjs';

/** A raw room socket that records media frames: { kind, from, payload }. */
async function peer(srv, id, token) {
  const ws = new WebSocket(`${srv.url}/${id}`, ['cueboard', token]), got = [], p = { ws, got, id: 0, closed: 0 };
  ws.on('error', () => {});
  ws.on('close', code => { p.closed = code; });
  ws.on('message', data => {
    const d = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(d) !== MSG_MEDIA) return;
    const f = { kind: decoding.readVarUint(d), from: decoding.readVarUint(d), payload: Buffer.from(decoding.readVarUint8Array(d)) };
    if (f.kind === K.WELCOME) p.id = f.from;
    got.push(f);
  });
  await until(() => p.id || p.closed, 3000, 'welcome');
  return p;
}
const msg = (kind, to, payload) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_MEDIA); encoding.writeVarUint(e, kind); encoding.writeVarUint(e, to); encoding.writeVarUint8Array(e, payload);
  return encoding.toUint8Array(e);
};
const relayFrame = (n, tag = Buffer.alloc(8, 7)) => Buffer.concat([Buffer.of(2), tag, Buffer.alloc(4), randomBytes(n)]);
/** a chunk frame's header as the relay reads it: [2][tag][u32 index], then `n` opaque bytes */
const chunkFrame = (tag, i, n) => { const h = Buffer.alloc(13); h[0] = 2; tag.copy(h, 1); h.writeUInt32BE(i, 9); return Buffer.concat([h, randomBytes(n)]); };
const of = (p, kind) => p.got.filter(f => f.kind === kind);
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('(m1) peer ids, joined/left, signals to one peer or everyone, never across rooms', async () => {
  const dir = tmpDir(), r1 = makeRoom(dir, 'a'), r2 = makeRoom(dir, 'b');
  const srv = await server(dir, 3390);
  try {
    const a = await peer(srv, r1.id, r1.token), b = await peer(srv, r1.id, r1.token), x = await peer(srv, r2.id, r2.token);
    assert.ok(a.id && b.id && a.id !== b.id);
    const wb = of(b, K.WELCOME)[0], dw = decoding.createDecoder(new Uint8Array(wb.payload));
    assert.equal(decoding.readVarUint(dw), 1); assert.equal(decoding.readVarUint(dw), a.id, 'B is told A is here');
    await until(() => of(a, K.JOINED).some(f => f.from === b.id), 2000, 'A hears B joined');
    a.ws.send(msg(K.SIGNAL, b.id, Buffer.from('to-b')));
    a.ws.send(msg(K.SIGNAL, 0, Buffer.from('to-all')));
    a.ws.send(msg(K.SIGNAL, x.id, Buffer.from('other-room')));
    await until(() => of(b, K.SIGNAL).length === 2, 2000, 'B gets both');
    assert.deepEqual(of(b, K.SIGNAL).map(f => [f.from, String(f.payload)]), [[a.id, 'to-b'], [a.id, 'to-all']]);
    await sleep(100);
    assert.equal(of(x, K.SIGNAL).length, 0, 'a peer of another room never gets it');
    assert.equal(of(a, K.SIGNAL).length, 0, 'a broadcast is not echoed');
    b.ws.close();
    await until(() => of(a, K.LEFT).some(f => f.from === b.id), 2000, 'A hears B left');
    a.ws.close(); x.ws.close();
  } finally { await srv.close(); }
});

test('(m2) relay forwards byte for byte between two online peers and stores nothing; caps are enforced', async () => {
  const dir = tmpDir(), r = makeRoom(dir), lines = [];
  const rec = lv => (m, f = {}) => lines.push(JSON.stringify({ level: lv, msg: m, ...f }));
  const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  const srv = await server(dir, 3391, { log, media: { relayMaxTransferBytes: 300_000, relayRoomBytesPerSec: 1_000_000, relayIpBytesPerSec: 10_000_000 } });
  try {
    const a = await peer(srv, r.id, r.token), b = await peer(srv, r.id, r.token);
    const marker = Buffer.from('PLAINTEXT-MARKER-' + randomBytes(8).toString('hex'));
    const f1 = Buffer.concat([Buffer.of(2), Buffer.alloc(8, 1), Buffer.alloc(4), marker, randomBytes(60_000)]);
    a.ws.send(msg(K.RELAY, b.id, f1));
    await until(() => of(b, K.RELAY).length === 1, 2000, 'relayed');
    assert.ok(of(b, K.RELAY)[0].payload.equals(f1), 'same bytes');
    assert.equal(of(b, K.RELAY)[0].from, a.id);
    // per-file cap: 300 KB is chunks 0-4 of a file; chunk 5 of that tag is refused, the sender is told which tag
    for (let i = 0; i < 6; i++) a.ws.send(msg(K.RELAY, b.id, chunkFrame(Buffer.alloc(8, 9), i, 60_000)));
    await until(() => of(a, K.DROPPED).length >= 1, 2000, 'transfer cap');
    assert.equal(of(a, K.DROPPED)[0].payload[0], DROP.TRANSFER);
    assert.ok(of(a, K.DROPPED)[0].payload.subarray(1, 9).equals(Buffer.alloc(8, 9)), 'the dropped frame\'s tag');
    // a peer that isn't there (or left): dropped, sender told
    a.ws.send(msg(K.RELAY, 999999, relayFrame(100)));
    await until(() => of(a, K.DROPPED).some(f => f.from === 999999 && f.payload[0] === DROP.BUSY), 2000, 'busy');
    // room byte rate: 1 MB/s with a 2 s burst. 50 x 60 KB at once must hit it
    for (let i = 0; i < 50; i++) a.ws.send(msg(K.RELAY, b.id, relayFrame(60_000, randomBytes(8))));
    await until(() => of(a, K.DROPPED).some(f => f.payload[0] === DROP.RATE), 3000, 'rate cap');
    assert.ok(of(b, K.RELAY).length < 50, 'not everything went through');
    // nothing on disk and nothing in the log contains the payload
    const files = []; const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)));
    walk(dir);
    for (const f of files) assert.ok(!fs.readFileSync(f).includes(marker), 'payload on disk in ' + f);
    assert.ok(!lines.join('\n').includes(marker.toString()), 'payload in log');
    assert.ok(!lines.join('\n').includes(r.token), 'token in log');
    assert.ok(lines.some(l => /media frames dropped/.test(l)), 'drops are counted in the log');
    assert.ok(srv.mediaStats.relayedBytes > 0);
    a.ws.close(); b.ws.close();
  } finally { await srv.close(); }
});

test('(m3) malformed or oversized media messages close with 4400; signal floods are dropped; Yjs sync unaffected', async () => {
  const dir = tmpDir(), r = makeRoom(dir);
  const srv = await server(dir, 3392, { media: { signalPerConnPerSec: 5, signalPerRoomPerSec: 1000 } });
  try {
    const a = await peer(srv, r.id, r.token), b = await peer(srv, r.id, r.token);
    for (let i = 0; i < 40; i++) a.ws.send(msg(K.SIGNAL, b.id, Buffer.from('s' + i)));
    await sleep(300);
    const n = of(b, K.SIGNAL).length;
    assert.ok(n >= 5 && n <= 12, 'per-connection signal rate (burst 10): got ' + n);
    assert.equal(a.closed, 0, 'a flood is dropped, not fatal');
    const big = await peer(srv, r.id, r.token);
    big.ws.send(msg(K.SIGNAL, b.id, Buffer.alloc(17 * 1024)));
    await until(() => big.closed, 2000, 'oversized signal'); assert.equal(big.closed, 4400);
    const big2 = await peer(srv, r.id, r.token);
    big2.ws.send(msg(K.RELAY, b.id, Buffer.alloc(81 * 1024)));
    await until(() => big2.closed, 2000, 'oversized relay'); assert.equal(big2.closed, 4400);
    for (const bad of [Uint8Array.of(MSG_MEDIA), Uint8Array.of(MSG_MEDIA, 9, 0, 0), Uint8Array.of(MSG_MEDIA, K.RELAY, 1, 2, 0, 0), [...msg(K.SIGNAL, 1, Buffer.from('x')), 0]]) {
      const c = await peer(srv, r.id, r.token);
      c.ws.send(Uint8Array.from(bad));
      await until(() => c.closed, 2000, 'malformed'); assert.equal(c.closed, 4400);
    }
    const c = await peer(srv, r.id, r.token);
    c.ws.send(msg(K.WELCOME, 0, Buffer.alloc(0)));
    await until(() => c.closed, 2000, 'client may not send server kinds'); assert.equal(c.closed, 4400);
    assert.equal(b.closed, 0, 'the honest peer stays');
    a.ws.close(); b.ws.close();
  } finally { await srv.close(); }
});

test('(m5) the per-file cap fits the app\'s biggest automatic limit, is sent in WELCOME, and a chunk sent again never counts twice', async () => {
  // the app's largest "Download automatically" option must fit through the default relay (shared constant)
  const html = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  const opts = [...html.match(/<select id="fLimF">(.*?)<\/select>/)[1].matchAll(/value="(\d+)"/g)].map(m => +m[1] * 1e6);
  assert.ok(opts.length >= 3 && opts.every(b => relayable(b, RELAY_DEFAULTS.relayMaxTransferBytes)), 'every per-file option is relayable: ' + opts);
  assert.equal(RELAY_DEFAULTS.relayMaxTransferBytes, RELAY_MAX_FILE);
  assert.ok(!relayable(RELAY_MAX_FILE + 1, RELAY_MAX_FILE) && relayable(RELAY_MAX_FILE, RELAY_MAX_FILE));
  const dir = tmpDir(), r = makeRoom(dir), cap = 4 * MEDIA_CHUNK;
  const srv = await server(dir, 3389, { media: { relayMaxTransferBytes: cap, relayRoomBytesPerSec: 50e6, relayIpBytesPerSec: 50e6 } });
  try {
    const a = await peer(srv, r.id, r.token), b = await peer(srv, r.id, r.token);
    const w = decoding.createDecoder(new Uint8Array(of(b, K.WELCOME)[0].payload));
    const n = decoding.readVarUint(w); for (let i = 0; i < n; i++) decoding.readVarUint(w);
    assert.equal(decoding.readVarUint(w), cap, 'WELCOME carries the relay\'s per-file cap');
    // chunks 0-3 of one file, each sent 10 times (re-asks): all forwarded, none refused. The old byte count refused
    // everything past 256 KiB of traffic, so a file that fits could never finish after a few re-asks.
    const tag = Buffer.alloc(8, 5);
    for (let k = 0; k < 10; k++) for (let i = 0; i < 4; i++) a.ws.send(msg(K.RELAY, b.id, chunkFrame(tag, i, MEDIA_CHUNK)));
    await until(() => of(b, K.RELAY).length === 40, 4000, 'all 40 relayed');
    assert.equal(of(a, K.DROPPED).length, 0);
    // chunk 4 is past a 4-chunk file: refused with the tag; control frames (type 1) aren't counted per file
    a.ws.send(msg(K.RELAY, b.id, chunkFrame(tag, 4, 100)));
    for (let i = 0; i < 20; i++) a.ws.send(msg(K.RELAY, b.id, Buffer.concat([Buffer.of(1), Buffer.alloc(8), randomBytes(MEDIA_CHUNK)])));
    await until(() => of(a, K.DROPPED).length === 1 && of(b, K.RELAY).length === 60, 4000, 'one refused, control frames through');
    assert.deepEqual([...of(a, K.DROPPED)[0].payload], [DROP.TRANSFER, ...tag]);
    a.ws.close(); b.ws.close();
  } finally { await srv.close(); }
});

test('(m6) per-IP buckets are forgotten once idle, also for an IP that was busy when it left', async () => {
  const sent = [], relay = createMediaRelay({ relayIpBytesPerSec: 40_000, relayRoomBytesPerSec: 10e6 }, { debug() {}, info() {}, warn() {}, error() {} }, (ws, m) => sent.push(m));
  const room = { id: 'r' }, sock = () => ({ OPEN: 1, readyState: 1, bufferedAmount: 0 });
  const enc = (to, payload) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, K.RELAY); encoding.writeVarUint(e, to); encoding.writeVarUint8Array(e, payload); return decoding.createDecoder(encoding.toUint8Array(e)); };
  const ips = 50, conns = [];
  for (let i = 0; i < ips; i++) {
    const a = sock(), b = sock(); relay.attach(room, a, '10.0.0.' + i); const bid = relay.attach(room, b, '10.1.0.' + i);
    relay.handle(room, a, enc(bid, relayFrame(60_000)));      // most of a's 2 s burst: its bucket isn't full when it leaves
    conns.push(a, b);
  }
  assert.equal(relay.ipBuckets, ips);
  for (const c of conns) relay.detach(room, c);
  assert.equal(relay.ipBuckets, ips, 'busy when they left: kept for now');
  relay.sweep(Date.now() + 3000, true);
  assert.equal(relay.ipBuckets, 0, 'idle again: forgotten');
  // the sweep also runs by itself (at most every 10 s) while frames are relayed
  const a = sock(), b = sock(); relay.attach(room, a, '10.9.9.9'); const bid = relay.attach(room, b, '10.9.9.8');
  relay.handle(room, a, enc(bid, relayFrame(60_000)));
  relay.detach(room, a); relay.detach(room, b);
  assert.equal(relay.ipBuckets, 1);
  const t = Date.now; Date.now = () => t() + 20_000;
  try { relay.sweep(); } finally { Date.now = t; }
  assert.equal(relay.ipBuckets, 0);
});

test('(m4) token bucket', () => {
  const b = new Bucket(10, 0);
  assert.equal(b.take(20, 0), true); assert.equal(b.take(1, 0), false);
  assert.equal(b.take(5, 500), true); assert.equal(b.take(1, 500), false);
  assert.equal(b.take(20, 10_000), true, 'refills up to two seconds worth');
});
