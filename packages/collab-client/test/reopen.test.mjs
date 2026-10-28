// Reopening a room project whose offline copy is newer than the app's saved project: the page died after the copy was
// written (300 ms after a remote change) and before the app saved the pulled change. The reopen must pull that change,
// not push the app's older values back over it (which would undo a collaborator's edit for everyone).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { startServer } from '@cue-board/sync-server';
import { initProject, shotsMap } from '@cue-board/sync-server/schema';
import { ProjectStore } from '../../sync-server/src/store.mjs';

/* the few IndexedDB calls collab.mjs makes, in memory; transactions complete on a later tick, like the real thing */
const stores = new Map();
function fakeIndexedDB() {
  const req = () => ({ result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null });
  const db = {
    objectStoreNames: { contains: n => stores.has(n) },
    createObjectStore: n => { stores.set(n, new Map()); },
    transaction(name) {
      const m = stores.get(name), tx = { oncomplete: null, onerror: null, onabort: null };
      const done = r => { setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); return r; };
      tx.objectStore = () => ({
        get: k => done({ result: structuredClone(m.get(k)) }),
        put: (v, k) => { m.set(k, structuredClone(v)); return done({ result: k }); },
        delete: k => { m.delete(k); return done({ result: undefined }); },
        getAll: () => done({ result: [...m.values()].map(v => structuredClone(v)) }),
        getAllKeys: () => done({ result: [...m.keys()] }),
      });
      return tx;
    },
  };
  return { open() { const r = req(); setTimeout(() => { r.result = db; r.onupgradeneeded && r.onupgradeneeded(); r.onsuccess && r.onsuccess(); }, 0); return r; } };
}
globalThis.indexedDB = fakeIndexedDB();
globalThis.window = new EventTarget();
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
const { createCollab } = await import('../src/collab.mjs');

const PORT = 3386;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label); await sleep(10); }
}
const clone = v => JSON.parse(JSON.stringify(v));

let srv, dir;
test.before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-collab-reopen-')); srv = await startServer({ port: PORT, dataDir: dir, logLevel: 'silent' }); });
test.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function fakeApp() {
  const app = {
    cur: /** @type {any} */ (null), pulls: 0,
    project: () => app.cur,
    applyRemote: (pid, p) => { app.pulls++; app.cur = { ...p, id: pid }; },
    busy: () => false, focusedText: () => null, mediaBlob: async () => null, songBlob: async () => null,
    onStatus() {}, onPeers() {}, onEvent() {},
  };
  return app;
}
/** what the app does when it saves its project (index.html flush): mark, store, then saved */
function appSave(sess, app) { const m = sess.mark ? sess.mark() : undefined; const snap = clone(app.cur); if (sess.saved) sess.saved(m, true); return snap; }

for (const kind of ['notes (text)', 'title (plain value)', 'a new take']) {
  test(`a remote change pulled but not yet in the app's saved project survives a crash and a reopen: ${kind}`, async () => {
    const seed = new Y.Doc(); initProject(seed, { title: 'Room' });
    const { id: roomId, token } = new ProjectStore(dir).createProject('t', seed);
    const binding = { roomId, token, name: 'A', dev: 'dA' };

    // B: a collaborator, a plain Yjs client in the room
    const b = new Y.Doc(), pb = new WebsocketProvider(srv.url, roomId, b, { protocols: ['cueboard', token], disableBc: true });
    // A: a session with a fake app; it syncs, types something and saves its project (as index.html does)
    const app = fakeApp(), collab = createCollab(app, srv.url.replace(/\/r$/, ''));
    const pid = 'p-' + kind.split(' ')[0];
    let sess = collab.open(pid, binding);
    try {
    await until(() => app.pulls > 0 && pb.synced, 'A and B synced');
    const sid = app.cur.sections[0].id, bShot = () => shotsMap(b).get(sid);
    app.cur.sections[0].notes = 'from A'; sess.changed(true);
    await until(() => bShot().get('notes')?.toString() === 'from A', 'A\'s notes reach B');
    const saved = appSave(sess, app);
    await sleep(400);

    // B changes something; A pulls it and its offline copy is written, but A's project save never happens
    const R = 'R from B';
    if (kind.startsWith('notes')) bShot().get('notes').insert(6, ' + ' + R);
    else if (kind.startsWith('title')) bShot().set('title', R);
    else {
      const t = new Y.Map(); t.set('id', 't-r'); t.set('prompt', R); t.set('status', 'completed');
      b.transact(() => { let ya = bShot().get('takes'); if (!(ya instanceof Y.Array)) { ya = new Y.Array(); bShot().set('takes', ya); } ya.insert(0, [t]); });
    }
    const has = p => JSON.stringify(p.sections[0]).includes(R);
    await until(() => has(app.cur), 'A pulls R');
    const copy = () => { const v = stores.get('docs').get(pid); return v && (v.u || v); };
    await until(() => { const c = copy(); if (!c) return false; const d = new Y.Doc(); Y.applyUpdate(d, c); return JSON.stringify(shotsMap(d).get(sid).toJSON()).includes(R); }, 'the offline copy has R');
    assert.ok(!has(saved), 'the app\'s saved project does not have R');

    // the page dies: nothing more is pushed or saved by the app (stop() with no open project only writes the copy)
    app.cur = null; sess.stop();
    await sleep(100);

    // reopen with the app's saved project
    const app2 = fakeApp(); app2.cur = clone(saved);
    const collab2 = createCollab(app2, srv.url.replace(/\/r$/, ''));
    sess = collab2.open(pid, binding);
    await until(() => app2.pulls > 0 && has(app2.cur), 'the reopened app gets R', 4000).catch(() => {});
    await sleep(500);
    assert.ok(JSON.stringify(bShot().toJSON()).includes(R), 'R is still in the room');
    assert.ok(has(app2.cur), 'R reached the reopened app');
    assert.ok(JSON.stringify(bShot().toJSON()).includes('from A'), 'A\'s earlier edit is still there');
    if (kind.startsWith('notes')) assert.equal(bShot().get('notes').toString(), 'from A + ' + R, 'nothing doubled');
    } finally { sess.stop(); pb.destroy(); b.destroy(); }
  });
}

test('leaving the room (forget) while a save is in flight: the offline copy is not written again', async () => {
  const seed = new Y.Doc(); initProject(seed, { title: 'Room' });
  const { id: roomId, token } = new ProjectStore(dir).createProject('t', seed);
  const app = fakeApp(), collab = createCollab(app, srv.url.replace(/\/r$/, ''));
  const sess = collab.open('p2', { roomId, token, name: 'A', dev: 'dA' });
  try {
    await until(() => app.pulls > 0, 'synced');
    const m = sess.mark();
    sess.stop(); await collab.forget('p2');
    sess.saved(m, true);
    await sleep(100);
    assert.equal(stores.get('docs').has('p2'), false);
  } finally { sess.stop(); }
});
