// The collab database's version-2 upgrade while a tab of the previous version still holds a version-1 connection (it
// never set onversionchange, so it never lets go). The new tab must not hang on "Syncing…": the doc connects and syncs
// without the offline copy, media says the storage is busy, and everything switches over once the old tab goes away.
// A later version opening must find this tab letting go at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { startServer } from '@cue-board/sync-server';
import { initProject } from '@cue-board/sync-server/schema';
import { ProjectStore } from '../../sync-server/src/store.mjs';

/* IndexedDB's versioning, in memory: an open at a higher version first fires versionchange on the open connections,
   then "blocked" on the request while any stays open, and upgrades once they're all closed. */
const dbs = new Map();
function fakeIndexedDB() {
  const conn = rec => {
    const c = {
      closed: false, onversionchange: null, close() { c.closed = true; },
      objectStoreNames: { contains: n => rec.stores.has(n) },
      createObjectStore: n => { rec.stores.set(n, new Map()); },
      transaction(name) {
        if (c.closed) throw new Error('InvalidStateError: the connection is closed');
        const m = rec.stores.get(name), tx = { oncomplete: null, onerror: null, onabort: null };
        if (!m) throw new Error('NotFoundError: ' + name);
        const done = r => { setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); return r; };
        tx.objectStore = () => ({
          get: k => done({ result: structuredClone(m.get(k)) }),
          put: (v, k) => { m.set(k, v); return done({ result: k }); },
          delete: k => { m.delete(k); return done({ result: undefined }); },
          getAll: () => done({ result: [...m.values()] }),
          getAllKeys: () => done({ result: [...m.keys()] }),
        });
        return tx;
      },
    };
    rec.conns.add(c);
    return c;
  };
  return {
    open(name, version) {
      const r = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(async () => {
        let rec = dbs.get(name);
        if (!rec) dbs.set(name, rec = { version: 0, stores: new Map(), conns: new Set() });
        const v = version || rec.version || 1;
        if (v < rec.version) { r.onerror && r.onerror(); return; }
        if (v > rec.version) {
          const open = () => [...rec.conns].filter(c => !c.closed);
          for (const c of open()) c.onversionchange && c.onversionchange({ oldVersion: rec.version, newVersion: v });
          if (open().length) { r.onblocked && r.onblocked(); while (open().length) await new Promise(ok => setTimeout(ok, 10)); }
          rec.version = v; r.result = conn(rec); r.onupgradeneeded && r.onupgradeneeded();
        } else r.result = conn(rec);
        r.onsuccess && r.onsuccess();
      }, 0);
      return r;
    },
  };
}
globalThis.indexedDB = fakeIndexedDB();
globalThis.window = new EventTarget();
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label); await sleep(10); }
}
const openRaw = (version) => new Promise((ok, no) => { const r = indexedDB.open('cueboard-collab', version); r.onsuccess = () => ok(r.result); r.onerror = no; r.onupgradeneeded = () => { r.result.createObjectStore('docs'); r.result.createObjectStore('hashes'); }; });

test('an old tab holding the v1 database: the session still connects and syncs; media says "storage busy" until the old tab goes; a newer version gets the database at once', async () => {
  // the old tab: version 1, as the deployed collab.js opens it, and it never lets go
  const old = await openRaw(1);
  const { createCollab } = await import('../src/collab.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-collab-idb-')), srv = await startServer({ port: 3384, dataDir: dir, logLevel: 'silent' });
  let sess;
  try {
    const seed = new Y.Doc(); initProject(seed, { title: 'Room' });
    const { id: roomId, token } = new ProjectStore(dir).createProject('t', seed);
    const app = {
      cur: null, pulls: 0, status: '', media: 0,
      project: () => app.cur, applyRemote: (_pid, p) => { app.pulls++; app.cur = { ...p, id: 'p1' }; },
      busy: () => false, focusedText: () => null, mediaBlob: async () => null, songBlob: async () => null,
      onStatus: (_pid, s) => { app.status = s; }, onPeers() {}, onEvent() {}, onMedia: () => { app.media++; },
      storeMedia: async () => 'm1', storeSong: async () => {},
    };
    const t0 = Date.now();
    sess = createCollab(app, srv.url.replace(/\/r$/, '')).open('p1', { roomId, token, name: 'A', dev: 'dA' });
    await until(() => app.status === 'synced' && app.pulls > 0 && app.cur.sections.length === 1, 'the session connected and pulled the doc');
    assert.ok(Date.now() - t0 < 6000, 'within a few seconds, not "until the old tab closes"');
    assert.equal(dbs.get('cueboard-collab').version, 1, 'the upgrade is still waiting on the old tab');
    await until(() => sess.media() && sess.media().summary().storageBusy === 'blocked', 'media: storage busy');
    // the old tab goes away: the upgrade runs, this tab picks the database up, media goes on
    old.close();
    await until(() => sess.media().summary().storageBusy === '', 'storage free again');
    const rec = dbs.get('cueboard-collab');
    assert.equal(rec.version, 2);
    assert.ok(['docs', 'hashes', 'parts', 'chunks'].every(n => rec.stores.has(n)));
    // a newer version in another tab: this one lets go right away instead of blocking it
    let blocked = false;
    const newer = await new Promise((ok, no) => { const r = indexedDB.open('cueboard-collab', 3); r.onblocked = () => { blocked = true; }; r.onsuccess = () => ok(r.result); r.onerror = no; });
    assert.equal(blocked, false, 'never blocked: the session closed its connection on versionchange');
    newer.close();
    await until(() => sess.media().summary().storageBusy === 'replaced', 'media: reload this tab');
    assert.equal(app.status, 'synced', 'the doc keeps syncing');
  } finally { if (sess) sess.stop(); await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
