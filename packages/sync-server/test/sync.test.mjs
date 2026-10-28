import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Y from 'yjs';
import { tmpDir, server, makeRoom, client, synced, until, closeCode } from './helpers.mjs';
import { orderedShots, shotsMap } from '../src/schema.mjs';
import { ProjectStore } from '../src/store.mjs';

const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const fresh = () => { const d = tmpDir(); dirs.push(d); return d; };
const notes = doc => orderedShots(doc)[0].get('notes');
const stop = (...cs) => cs.forEach(c => { c.provider.destroy(); c.doc.destroy(); });

test('(a) two clients edit the same Y.Text concurrently and converge', async t => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3350);
  const a = client(srv, id, token), b = client(srv, id, token);
  await Promise.all([synced(a.provider), synced(b.provider)]);
  for (let i = 0; i < 50; i++) {        // interleaved, no waiting: both sides type while the other's edits are in flight
    notes(a.doc).insert(0, 'a'); notes(b.doc).insert(notes(b.doc).length, 'b');
  }
  await until(() => notes(a.doc).toString() === notes(b.doc).toString() && notes(a.doc).length === 100, 3000, 'convergence');
  assert.equal(notes(a.doc).toString().replace(/b/g, ''), 'a'.repeat(50));

  // one round trip a -> server -> b, averaged
  const N = 200, ms = [];
  for (let i = 0; i < N; i++) {
    const seen = new Promise(ok => notes(b.doc).observe(function f() { notes(b.doc).unobserve(f); ok(); }));
    const t0 = performance.now(); notes(a.doc).insert(0, 'x'); await seen; ms.push(performance.now() - t0);
  }
  ms.sort((x, y) => x - y);
  t.diagnostic(`a->server->b latency over loopback, ${N} edits: median ${ms[N / 2].toFixed(2)} ms, p95 ${ms[Math.floor(N * 0.95)].toFixed(2)} ms`);
  stop(a, b); await srv.close();
});

test('(b) a client goes offline, edits, reconnects, everything merges', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3351);
  const a = client(srv, id, token), b = client(srv, id, token);
  await Promise.all([synced(a.provider), synced(b.provider)]);
  const shotA = orderedShots(a.doc)[0];
  shotA.get('title').insert(0, 'Opening');
  await until(() => orderedShots(b.doc)[0].get('title').toString() === 'Opening');

  b.provider.disconnect();
  orderedShots(b.doc)[0].get('title').insert(7, ' shot');          // offline edit
  orderedShots(b.doc)[0].get('notes').insert(0, 'written offline');
  shotA.get('title').insert(0, 'The ');                            // concurrent online edit
  b.doc.transact(() => { const s = new Y.Map(); shotsMap(b.doc).set('s-offline', s); s.set('id', 's-offline'); s.set('start', 4.4); s.set('title', new Y.Text('new cut')); });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(shotA.get('title').toString(), 'The Opening');       // a hasn't seen b's offline edits

  b.provider.connect();
  const want = 'The Opening shot';
  await until(() => orderedShots(a.doc)[0].get('title').toString() === want && orderedShots(b.doc)[0].get('title').toString() === want, 3000, 'merge');
  assert.equal(orderedShots(a.doc)[0].get('notes').toString(), 'written offline');
  assert.deepEqual(orderedShots(a.doc).map(s => s.get('id')).slice(1), ['s-offline']);
  stop(a, b); await srv.close();
});

test('(c) restart the server and the state is intact', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir);
  let srv = await server(dir, 3352, { compactEvery: 7 });          // small, so both compacted and appended records are on disk
  const a = client(srv, id, token);
  await synced(a.provider);
  for (let i = 0; i < 20; i++) notes(a.doc).insert(notes(a.doc).length, `line ${i}\n`);
  const expected = Y.encodeStateVector(a.doc);
  await until(() => srv.rooms.get(id) && Buffer.compare(Buffer.from(Y.encodeStateVector(srv.rooms.get(id).doc)), Buffer.from(expected)) === 0, 3000, 'server caught up');
  const text = notes(a.doc).toString();
  // already on disk while the server is still running: durability doesn't hang on the shutdown compaction
  assert.equal(notes(new ProjectStore(dir).loadDoc(id).doc).toString(), text);
  stop(a); await srv.close();

  srv = await server(dir, 3352);
  const b = client(srv, id, token);
  await synced(b.provider);
  assert.equal(notes(b.doc).toString(), text);
  stop(b); await srv.close();

  // and a log with a torn last record still loads everything before it
  fs.appendFileSync(`${dir}/${id}/updates.bin`, Buffer.from([200, 0, 0, 0, 1, 2]));
  srv = await server(dir, 3352);
  const c = client(srv, id, token);
  await synced(c.provider);
  assert.equal(notes(c.doc).toString(), text);
  stop(c); await srv.close();
});

test('(d) wrong token and unknown room are rejected', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3353);
  assert.equal(await closeCode(`${srv.url}/${id}?token=AAAAAAAAAAAAAAAAAAAAAA`), 4401);
  assert.equal(await closeCode(`${srv.url}/${id}`), 4401);
  assert.equal(await closeCode(`${srv.url}/AAAAAAAAAAAAAAAAAAAAAAAA?token=${token}`), 4404);
  assert.equal(await closeCode(`${srv.url}/..%2F..%2Fetc?token=${token}`), 4404);
  // a valid one still works
  const a = client(srv, id, token);
  await synced(a.provider);
  stop(a); await srv.close();
});

test('(e) oversized message is rejected without crashing the server', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3354, { maxMessageBytes: 64 * 1024, maxConnsPerIp: 3 });
  const code = await closeCode(`${srv.url}/${id}?token=${token}`, ws => ws.send(Buffer.alloc(100 * 1024, 7)));
  assert.equal(code, 1009);
  assert.equal(await closeCode(`${srv.url}/${id}?token=${token}`, ws => ws.send(Buffer.from([0, 9, 9, 9]))), 4400);   // garbage
  // still serving, and the room is still usable
  const a = client(srv, id, token), b = client(srv, id, token);
  await Promise.all([synced(a.provider), synced(b.provider)]);
  notes(a.doc).insert(0, 'still alive');
  await until(() => notes(b.doc).toString() === 'still alive');
  // per-IP limit: 2 open + 1 more is fine, the 4th is refused
  const c = client(srv, id, token);
  await synced(c.provider);
  assert.equal(await closeCode(`${srv.url}/${id}?token=${token}`), 4429);
  stop(a, b, c); await srv.close();
});
