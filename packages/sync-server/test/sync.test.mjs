import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Y from 'yjs';
import { tmpDir, server, makeRoom, client, synced, until, closeCode, join, records } from './helpers.mjs';
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
  const file = `${dir}/${id}/updates.bin`;
  fs.appendFileSync(file, Buffer.from([200, 0, 0, 0, 1, 2]));
  const withTail = fs.readFileSync(file);
  srv = await server(dir, 3352);
  const c = client(srv, id, token);
  await synced(c.provider);
  assert.equal(notes(c.doc).toString(), text);
  // the original, tail included, was copied aside before the cut
  const aside = fs.readdirSync(`${dir}/${id}`).filter(f => f.startsWith('updates.bin.torn-'));
  assert.equal(aside.length, 1);
  assert.deepEqual(fs.readFileSync(`${dir}/${id}/${aside[0]}`), withTail);
  assert.equal(fs.statSync(file).size, withTail.length - 6);
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

test('(g) a malformed token hash or project.json refuses that room only, and the server keeps serving', async () => {
  const dir = fresh(), good = makeRoom(dir), typo = makeRoom(dir), only = makeRoom(dir), broken = makeRoom(dir);
  const pj = id => `${dir}/${id}/project.json`, edit = (id, f) => { const p = JSON.parse(fs.readFileSync(pj(id), 'utf8')); f(p); fs.writeFileSync(pj(id), JSON.stringify(p)); };
  edit(typo.id, p => p.tokens.unshift({ sha256: 'abc' }, { sha256: 'z'.repeat(64) }, { nope: 1 }));   // hand-edit typos before the real hash
  edit(only.id, p => { p.tokens[0].sha256 = p.tokens[0].sha256.slice(1); });                      // 63 chars
  fs.writeFileSync(pj(broken.id), '{"tokens": [');
  const srv = await server(dir, 3355, { maxConnsPerIp: 2 });
  const url = r => `${srv.url}/${r.id}?token=${r.token}`;

  assert.equal(await closeCode(`${srv.url}/${typo.id}?token=AAAAAAAAAAAAAAAAAAAAAA`), 4401);
  assert.equal(await closeCode(url(only)), 4401);                 // never matches, never throws
  for (let i = 0; i < 3; i++) assert.equal(await closeCode(url(broken)), 4500);
  // still serving, the malformed entries are skipped, and the refusals didn't leak per-IP slots (limit 2)
  const a = client(srv, typo.id, typo.token), b = client(srv, good.id, good.token);
  await Promise.all([synced(a.provider), synced(b.provider)]);
  assert.equal(await closeCode(url(good)), 4429);
  stop(a, b); await srv.close();
});

test('(h) a corrupt (not torn) update log refuses the room with 4500 and is left untouched', async () => {
  const dir = fresh(), midRec = makeRoom(dir), midHead = makeRoom(dir), ok = makeRoom(dir);
  const file = r => `${dir}/${r.id}/updates.bin`, orig = fs.readFileSync(file(midRec));
  const frame = b => { const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
  // a garbage record between two valid ones; and a mangled length header with valid records after it
  fs.writeFileSync(file(midRec), Buffer.concat([orig, frame(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), orig]));
  fs.writeFileSync(file(midHead), Buffer.concat([orig, Buffer.from([0xff, 0xff, 0xff, 0xff]), orig, orig]));
  const before = [fs.readFileSync(file(midRec)), fs.readFileSync(file(midHead))];
  const srv = await server(dir, 3356);
  const url = r => `${srv.url}/${r.id}?token=${r.token}`;

  for (let i = 0; i < 2; i++) {             // every join is refused, not just the first
    assert.equal(await closeCode(url(midRec)), 4500);
    assert.equal(await closeCode(url(midHead)), 4500);
  }
  assert.deepEqual(fs.readFileSync(file(midRec)), before[0]);
  assert.deepEqual(fs.readFileSync(file(midHead)), before[1]);
  for (const r of [midRec, midHead]) assert.deepEqual(fs.readdirSync(`${dir}/${r.id}`).filter(f => f.includes('torn')), []);
  assert.equal(srv.rooms.size, 0);

  const c = client(srv, ok.id, ok.token);                           // other rooms still work
  await synced(c.provider);
  fs.writeFileSync(file(midRec), orig);                             // an operator repairs the file: the room opens again
  const d = client(srv, midRec.id, midRec.token);
  await synced(d.provider);
  assert.equal(orderedShots(d.doc).length, 1);
  stop(c, d); await srv.close();
});

test('(i) TRUST_PROXY: the per-IP limit uses the address our proxy appended, not the client-sent X-Forwarded-For', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir);
  let srv = await server(dir, 3357, { trustProxy: true, maxConnsPerIp: 1 });
  const at = xff => join(`${srv.url}/${id}?token=${token}`, { 'x-forwarded-for': xff });
  const first = await at('10.0.0.1, 192.0.2.7');
  const spoofed = await at('10.0.0.2, 192.0.2.7');      // rotating the client-controlled left side
  const other = await at('10.0.0.1, 192.0.2.8');        // a different real client
  assert.deepEqual([first.result, spoofed.result, other.result], ['joined', 4429, 'joined']);
  [first, spoofed, other].forEach(j => j.ws.close()); await srv.close();

  // two proxies of ours: the client is the second entry from the right
  srv = await server(dir, 3357, { trustProxy: true, trustedProxyHops: 2, maxConnsPerIp: 1 });
  const x = await at('1.1.1.1, 192.0.2.7, 10.9.9.9'), y = await at('2.2.2.2, 192.0.2.7, 10.9.9.9'), z = await at('192.0.2.8, 10.9.9.9');
  assert.deepEqual([x.result, y.result, z.result], ['joined', 4429, 'joined']);
  [x, y, z].forEach(j => j.ws.close()); await srv.close();
});

test('(j) a room unloaded after unloadAfterMs and rejoined keeps its state, as one compacted record', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), file = `${dir}/${id}/updates.bin`;
  const srv = await server(dir, 3358, { unloadAfterMs: 50 });
  let text = '';
  for (let round = 0; round < 3; round++) {
    const a = client(srv, id, token);
    await synced(a.provider);
    assert.equal(notes(a.doc).toString(), text);
    for (let i = 0; i < 5; i++) notes(a.doc).insert(notes(a.doc).length, `r${round}.${i} `);
    text = notes(a.doc).toString();
    const sv = Buffer.from(Y.encodeStateVector(a.doc));
    await until(() => Buffer.compare(Buffer.from(Y.encodeStateVector(srv.rooms.get(id).doc)), sv) === 0, 3000, 'server caught up');
    assert.equal(records(file), 6);                     // the compacted state plus this round's 5 appends
    stop(a);
    await until(() => !srv.rooms.has(id), 3000, 'unload');
    assert.equal(records(file), 1);
    const disk = new ProjectStore(dir).loadDoc(id).doc;
    assert.equal(notes(disk).toString(), text);
    assert.equal(orderedShots(disk).length, 1);
  }
  await srv.close();
  assert.equal(records(file), 1);
});
