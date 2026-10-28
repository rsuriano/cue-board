import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { tmpDir, server, makeRoom, client, synced, until, join, records } from './helpers.mjs';
import { orderedShots } from '../src/schema.mjs';
import { ProjectStore } from '../src/store.mjs';

const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const fresh = () => { const d = tmpDir(); dirs.push(d); return d; };
const notes = doc => orderedShots(doc)[0].get('notes');
const stop = (...cs) => cs.forEach(c => { c.provider.destroy(); c.doc.destroy(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const caughtUp = (srv, id, doc) => () => srv.rooms.get(id) && Buffer.compare(Buffer.from(Y.encodeStateVector(srv.rooms.get(id).doc)), Buffer.from(Y.encodeStateVector(doc))) === 0;

/** A logger that keeps its lines, so tests can count them. */
function capture() {
  const lines = [], at = level => (msg, fields = {}) => lines.push({ level, msg, ...fields });
  return { lines, log: { debug: () => {}, info: at('info'), warn: at('warn'), error: at('error') }, count: re => lines.filter(l => re.test(l.msg)).length };
}
const diskError = (code = 'ENOSPC') => Object.assign(new Error(`${code}: no space left on device, write`), { code });

test('(k) a failed append degrades that room only: sender 4500, joins 4500, others served, then a compaction tick recovers it', async () => {
  const dir = fresh(), A = makeRoom(dir), B = makeRoom(dir), cap = capture();
  const srv = await server(dir, 3361, { compactIntervalMs: 30, log: cap.log });
  const a1 = client(srv, A.id, A.token), a2 = client(srv, A.id, A.token), b = client(srv, B.id, B.token);
  await Promise.all([a1, a2, b].map(c => synced(c.provider)));
  const codes = [];
  a1.provider.on('connection-close', e => codes.push(e?.code));

  // the disk fills up for room A only: appends and compactions there throw
  let full = true, appendsA = 0;
  const { append, compact } = srv.store;
  srv.store.append = (id, u) => { if (id === A.id) { appendsA++; if (full) throw diskError(); } return append.call(srv.store, id, u); };
  srv.store.compact = (id, d) => { if (id === A.id && full) throw diskError(); return compact.call(srv.store, id, d); };

  notes(a1.doc).insert(0, 'from a1 ');
  await until(() => codes.includes(4500), 3000, 'a1 closed with 4500');
  a1.provider.disconnect();
  await until(() => notes(a2.doc).toString() === 'from a1 ', 3000, 'a2 got the edit');
  assert.equal(srv.rooms.get(A.id).degraded, true);
  assert.equal((await join(`${srv.url}/${A.id}?token=${A.token}`)).result, 4500);   // new joins refused
  notes(a2.doc).insert(notes(a2.doc).length, 'from a2');                              // existing clients stay
  await until(caughtUp(srv, A.id, a2.doc), 3000, 'server has a2 edit');
  assert.equal(a2.provider.wsconnected, true);
  assert.equal(appendsA, 1);                                                          // no append after the failure
  const health = await (await fetch(`http://127.0.0.1:${srv.port}/health`)).json();
  assert.deepEqual(health, { ok: true, rooms: 2, degraded: 1 });

  // room B is served and persisted as usual
  notes(b.doc).insert(0, 'B is fine');
  await until(caughtUp(srv, B.id, b.doc), 3000, 'B caught up');
  assert.equal(notes(new ProjectStore(dir).loadDoc(B.id).doc).toString(), 'B is fine');

  await sleep(150);                                                                   // several failing compaction ticks
  assert.equal(cap.count(/^append failed/), 1);
  assert.equal(cap.count(/^compaction failed/), 1);                                   // once per burst, not per tick

  full = false;                                                                       // space freed: the next tick persists A
  await until(() => !srv.rooms.get(A.id).degraded, 3000, 'recovered');
  assert.equal(cap.count(/^compaction recovered/), 1);
  const file = `${dir}/${A.id}/updates.bin`;
  assert.equal(records(file), 1);
  assert.equal(notes(new ProjectStore(dir).loadDoc(A.id).doc).toString(), 'from a1 from a2');
  const c = client(srv, A.id, A.token);                                               // joins work again, appends resume
  await synced(c.provider);
  assert.equal(notes(c.doc).toString(), 'from a1 from a2');
  notes(c.doc).insert(0, '>');
  await until(caughtUp(srv, A.id, c.doc), 3000, 'c caught up');
  assert.equal(records(file), 2);
  stop(a1, a2, b, c); await srv.close();
});

test('(l) a real disk error (EACCES) in the compaction and unload timers keeps the process up and the room loaded until it clears', async t => {
  const dir = fresh(), { id, token } = makeRoom(dir), other = makeRoom(dir), folder = `${dir}/${id}`, file = `${folder}/updates.bin`, cap = capture();
  t.after(() => fs.chmodSync(folder, 0o755));
  const srv = await server(dir, 3362, { compactIntervalMs: 20, unloadAfterMs: 30, log: cap.log });
  const a = client(srv, id, token);
  await synced(a.provider);
  fs.chmodSync(folder, 0o555);           // appends to the existing log still work; the compaction's temp file can't be created
  for (let i = 0; i < 5; i++) notes(a.doc).insert(notes(a.doc).length, `${i} `);
  await until(caughtUp(srv, id, a.doc), 3000, 'server caught up');
  await sleep(150);
  assert.equal(records(file), 6);
  assert.equal(cap.count(/^compaction failed/), 1);
  assert.equal(cap.lines.find(l => /^compaction failed/.test(l.msg)).code, 'EACCES');

  stop(a);                               // the unload's compaction fails too: the room stays loaded, nothing lost
  await sleep(200);
  assert.equal(srv.rooms.has(id), true);
  assert.equal(cap.count(/^compaction failed/), 1);
  const o = client(srv, other.id, other.token);   // still serving
  await synced(o.provider);

  fs.chmodSync(folder, 0o755);
  await until(() => !srv.rooms.has(id), 3000, 'unload retried by the tick');
  assert.equal(records(file), 1);
  assert.equal(cap.count(/^compaction recovered/), 1);
  assert.equal(notes(new ProjectStore(dir).loadDoc(id).doc).toString(), '0 1 2 3 4 ');
  stop(o); await srv.close();
});

test('(m) per-IP limit without TRUST_PROXY ignores X-Forwarded-For, and closed sockets free their slots', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3363, { maxConnsPerIp: 2 });
  const u = `${srv.url}/${id}?token=${token}`, conns = () => srv.rooms.get(id)?.conns.size || 0;
  const [x, y, z] = [await join(u, { 'x-forwarded-for': '10.0.0.1' }), await join(u, { 'x-forwarded-for': '10.0.0.2' }), await join(u, { 'x-forwarded-for': '10.0.0.3' })];
  assert.deepEqual([x.result, y.result, z.result], ['joined', 'joined', 4429]);
  x.ws.close();                                                       // clean close
  await until(() => conns() === 1, 3000, 'x gone');
  const w = await join(u);
  assert.equal(w.result, 'joined');
  y.ws.terminate(); w.ws.terminate();                                 // abrupt
  await until(() => conns() === 0, 3000, 'all gone');
  const again = [await join(u), await join(u), await join(u)];
  assert.deepEqual(again.map(j => j.result), ['joined', 'joined', 4429]);
  again.forEach(j => j.ws.close()); await srv.close();
});

test('(n) awareness: a presence is broadcast, sent to late joiners, and removed for everyone when its socket drops', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3364);
  const b = client(srv, id, token);
  await synced(b.provider);
  const pdoc = new Y.Doc(), aw = new awarenessProtocol.Awareness(pdoc);
  aw.setLocalState({ user: 'P' });
  const p = await join(`${srv.url}/${id}?token=${token}`);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(aw, [pdoc.clientID]));
  p.ws.send(encoding.toUint8Array(enc));
  const sees = c => c.provider.awareness.getStates().get(pdoc.clientID)?.user === 'P';
  await until(() => sees(b), 3000, 'b sees P');
  const c = client(srv, id, token);
  await until(() => sees(c), 3000, 'late joiner sees P');
  p.ws.terminate();                      // no goodbye from the client: the server's close handler must remove it
  await until(() => ![b, c].some(x => x.provider.awareness.getStates().has(pdoc.clientID)), 3000, 'P removed');
  assert.equal(srv.rooms.get(id).awareness.getStates().has(pdoc.clientID), false);
  aw.destroy(); pdoc.destroy(); stop(b, c); await srv.close();
});

test('(o) TRUST_PROXY: an X-Forwarded-For shorter than TRUSTED_PROXY_HOPS uses the socket address, warned once', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), cap = capture();
  const srv = await server(dir, 3365, { trustProxy: true, trustedProxyHops: 2, maxConnsPerIp: 1, log: cap.log });
  const u = `${srv.url}/${id}?token=${token}`, at = xff => join(u, { 'x-forwarded-for': xff });
  const js = [await at('1.1.1.1'), await at('2.2.2.2'), await join(u), await at('3.3.3.3, 192.0.2.9')];
  // the first three are all 127.0.0.1 (not the client-written leftmost entry); the last one came through both hops
  assert.deepEqual(js.map(j => j.result), ['joined', 4429, 4429, 'joined']);
  assert.equal(cap.count(/fewer entries than TRUSTED_PROXY_HOPS/), 1);
  js.forEach(j => j.ws.close()); await srv.close();
});

test('(p) a client that stops reading is terminated once its send queue passes maxBufferedBytes', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), cap = capture();
  const srv = await server(dir, 3366, { maxBufferedBytes: 256 * 1024, log: cap.log });
  const slow = await join(`${srv.url}/${id}?token=${token}`);
  slow.ws.pause();                                                    // stops reading its socket
  const a = client(srv, id, token);
  await synced(a.provider);
  const conns = () => srv.rooms.get(id).conns.size, chunk = 'x'.repeat(100 * 1024);
  let sent = 0;
  for (; sent < 400 && conns() === 2; sent++) { notes(a.doc).insert(0, chunk); await new Promise(r => setImmediate(r)); }
  await until(() => conns() === 1, 3000, 'slow reader dropped');
  assert.equal(cap.count(/^terminating: slow reader/), 1);
  assert.ok(sent < 400, 'dropped before the loop ran out');
  assert.equal(a.provider.wsconnected, true);                         // the reading client is unaffected
  stop(a); slow.ws.terminate(); await srv.close();
});

test('(q) unsolicited pongs do not keep a socket alive; a client answering our pings stays', async () => {
  const dir = fresh(), { id, token } = makeRoom(dir), srv = await server(dir, 3367, { pingMs: 40 });
  const a = client(srv, id, token);
  await synced(a.provider);
  const p = await join(`${srv.url}/${id}?token=${token}`);
  p.ws.pause();                                                       // never sees our pings...
  const spam = setInterval(() => p.ws.pong('alive'), 10);            // ...but keeps sending pongs of its own
  await until(() => srv.rooms.get(id).conns.size === 1, 3000, 'pong spammer terminated');
  clearInterval(spam);
  await sleep(200);                                                   // 5 more ping periods
  assert.equal(a.provider.wsconnected, true);
  assert.equal(srv.rooms.get(id).conns.size, 1);
  stop(a); p.ws.terminate(); await srv.close();
});

test('(r) safety net: uncaught errors are logged as UNCAUGHT and the process lives; the same error 3 times in 10 s exits 1', () => {
  const mod = f => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);
  const script = n => `
    import { installSafetyNet } from ${mod('safety-net.mjs')};
    import { createLogger } from ${mod('log.mjs')};
    installSafetyNet(createLogger('error'), () => { process.stderr.write('FATAL\\n'); process.exit(1); });
    Promise.reject(new Error('a different one'));
    const boom = () => { throw new Error('boom'); };
    let i = 0;
    const t = setInterval(() => { if (i++ < ${n}) boom(); else { clearInterval(t); process.stdout.write('still serving'); } }, 5);`;
  const run = n => spawnSync(process.execPath, ['--input-type=module', '-e', script(n)], { encoding: 'utf8', timeout: 10_000 });
  const lines = r => r.stderr.split('\n').filter(Boolean);

  const twice = run(2);
  assert.equal(twice.status, 0);
  assert.equal(twice.stdout, 'still serving');
  assert.equal(lines(twice).length, 3);
  assert.ok(lines(twice).every(l => /"msg":"UNCAUGHT (uncaughtException|unhandledRejection)"/.test(l)), twice.stderr);

  const thrice = run(3);
  assert.equal(thrice.status, 1);
  assert.equal(thrice.stdout, '');
  assert.match(thrice.stderr, /UNCAUGHT: same error 3 times in 10 s, exiting/);
  assert.match(thrice.stderr, /FATAL/);
});
