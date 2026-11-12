// Security review, finding 1: Yjs updates whose dependencies are missing ("pending structs") were kept in the server's
// memory without counting against MAX_ROOM_BYTES, then integrated all at once when the missing piece arrived. Now they
// count against the room cap, are bounded by maxPendingBytes, and are dropped with the connection that sent them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { tmpDir, server, makeRoom, until, client, synced } from './helpers.mjs';

const MSG_SYNC = 0, SYNC_UPDATE = 2;
const frame = (/** @type {Uint8Array} */ u) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_SYNC); encoding.writeVarUint(e, SYNC_UPDATE); encoding.writeVarUint8Array(e, u); return encoding.toUint8Array(e); };
const open = (url) => new Promise((ok, no) => { const ws = new WebSocket(url); ws.on('error', no); ws.once('message', () => ok(ws)); });
const logSize = (dir, id) => fs.statSync(path.join(dir, id, 'updates.bin')).size;

/** attacker doc: a 1-char first insert (held back) and `n` inserts of `size` bytes that depend on it */
function dependentUpdates(n, size) {
  const a = new Y.Doc(), t = a.getText('x');
  t.insert(0, 'a');
  const first = Y.encodeStateAsUpdate(a), chunk = 'z'.repeat(size), rest = [];
  for (let i = 0; i < n; i++) { const before = Y.encodeStateVector(a); t.insert(t.length, chunk); rest.push(Y.encodeStateAsUpdate(a, before)); }
  return { first, rest };
}

test('pending updates count against MAX_ROOM_BYTES: 6 MB into a 1 MiB room is refused, dropped, and never reaches disk', async () => {
  const dir = tmpDir(), MAX = 1024 * 1024;
  const srv = await server(dir, 0, { maxRoomBytes: MAX, compactIntervalMs: 3600_000 });
  const { id, token } = makeRoom(dir);
  const ana = client(srv, id, token), bea = client(srv, id, token);
  await synced(ana.provider); await synced(bea.provider);
  const ws = await open(`${srv.url}/${id}?token=${token}`);
  let closed = null; ws.on('close', c => { closed = c; });
  try {
    const { first, rest } = dependentUpdates(30, 200 * 1024);
    for (const u of rest) if (ws.readyState === ws.OPEN) ws.send(frame(u));
    await until(() => closed !== null, 3000, 'attacker closed');
    assert.ok(closed === 4413 || closed === 4400, `closed with ${closed}`);
    const room = srv.rooms.get(id);
    await until(() => !room.doc.store.pendingStructs, 1000, 'pending dropped with the connection');
    assert.ok(room.bytes < MAX);
    // the missing piece from a new connection applies alone: nothing held back is left to flush to disk
    const ws2 = await open(`${srv.url}/${id}?token=${token}`);
    ws2.send(frame(first));
    await until(() => room.doc.getText('x').length === 1, 2000, 'missing piece applied');
    ws2.terminate();
    assert.ok(logSize(dir, id) <= MAX, `log on disk ${logSize(dir, id)} stays under the cap ${MAX}`);
    // the room keeps working for everyone else
    ana.doc.getText('notes').insert(0, 'still here');
    await until(() => bea.doc.getText('notes').toString() === 'still here', 3000, 'others still sync');
  } finally { ws.terminate(); [ana, bea].forEach(c => { c.provider.destroy(); c.doc.destroy(); }); await srv.close(); }
  // nothing held back ended up on disk at shutdown either
  assert.ok(logSize(dir, id) <= MAX);
});

test('pending updates are bounded by maxPendingBytes even under a big room cap; the sender gets 4400, others stay', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, { compactIntervalMs: 3600_000 });   // default 64 MiB cap, 4 MiB pending
  const { id, token } = makeRoom(dir);
  const ana = client(srv, id, token); await synced(ana.provider);
  const ws = await open(`${srv.url}/${id}?token=${token}`);
  let closed = null; ws.on('close', c => { closed = c; });
  try {
    const { rest } = dependentUpdates(10, 1900 * 1024);
    const t0 = performance.now();
    for (const u of rest) { if (ws.readyState !== ws.OPEN) break; await new Promise(ok => ws.send(frame(u), ok)); }
    await until(() => closed !== null, 5000, 'attacker closed');
    assert.equal(closed, 4400);
    const room = srv.rooms.get(id);
    assert.equal(room.doc.store.pendingStructs, null, 'pending dropped');
    assert.ok(performance.now() - t0 < 5000);
    assert.equal((await fetch(srv.httpUrl + '/health').then(r => r.json())).ok, true);
    ana.doc.getText('notes').insert(0, 'ok');
    await until(() => room.doc.getText('notes').toString() === 'ok', 3000, 'ana still syncs');
  } finally { ws.terminate(); ana.provider.destroy(); ana.doc.destroy(); await srv.close(); }
});

test('reconnecting does not add up: each connection starts again from an empty pending pile', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, { maxPendingBytes: 1024 * 1024, compactIntervalMs: 3600_000 });
  const { id, token } = makeRoom(dir);
  const keeper = await open(`${srv.url}/${id}?token=${token}`);   // keeps the room loaded between rounds
  try {
    for (let round = 0; round < 3; round++) {
      const ws = await open(`${srv.url}/${id}?token=${token}`);
      const done = new Promise(ok => ws.on('close', ok));
      for (const u of dependentUpdates(3, 300 * 1024).rest) ws.send(frame(u));
      await new Promise(r => setTimeout(r, 100));
      const p = srv.rooms.get(id).doc.store.pendingStructs;
      assert.ok(p && p.update.length < 1024 * 1024);
      ws.terminate(); await done;
      await until(() => !srv.rooms.get(id).doc.store.pendingStructs, 1000, 'dropped on close');
    }
  } finally { keeper.terminate(); await srv.close(); }
});

test('a normal client sending an edit just before the piece it depends on is not dropped', async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  const { id, token } = makeRoom(dir);
  const ws = await open(`${srv.url}/${id}?token=${token}`);
  let closed = null; ws.on('close', c => { closed = c; });
  try {
    const { first, rest } = dependentUpdates(2, 1000);
    ws.send(frame(rest[0])); ws.send(frame(rest[1])); ws.send(frame(first));
    await until(() => srv.rooms.get(id).doc.getText('x').length === 2001, 2000, 'all applied');
    assert.equal(closed, null);
    assert.equal(srv.rooms.get(id).doc.store.pendingStructs, null);
  } finally { ws.terminate(); await srv.close(); }
});
