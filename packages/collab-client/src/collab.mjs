// @ts-check
/* Cue Board collaboration client. Bundled into /collab.js (npm run build:collab) and loaded by index.html with a
   dynamic import() only once a project is bound to a room. index.html hands in `app`, a small set of callbacks;
   nothing here touches the app's own storage.

   Storage (IndexedDB "cueboard-collab", separate from the app's "cueboard-local"):
     docs   : projectId -> Y.Doc state (offline edits survive a reload and merge on reconnect)
     hashes : mediaId   -> { sha256, bytes, mime } (this device's media files, by content hash)
   The invite token only ever goes into the WebSocket subprotocol list, never into a URL, a log line or the doc. */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { shotsMap } from '@cue-board/sync-server/schema';
import { docToProject, pushProject, isEmptyRoom, clearShots, sanitizeName, initials, same } from './convert.mjs';

const LOCAL = 'cueboard-app';                      // transaction origin of our own writes
const REJECTED = new Set([4400, 4401, 4404]);       // the server won't take us: stop retrying
const SHA_ID = /^sha256-([0-9a-f]{64})$/;
const SHOT_ID = /^[\w-]{1,64}$/;

/* ---------- IndexedDB ---------- */
/** @type {Promise<IDBDatabase | null> | null} */ let dbP = null;
function db() {
  if (!dbP) dbP = new Promise(res => {
    try {
      const r = indexedDB.open('cueboard-collab', 1);
      r.onupgradeneeded = () => { for (const n of ['docs', 'hashes']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbP;
}
/** @param {string} name @param {IDBTransactionMode} mode @param {(st: IDBObjectStore) => IDBRequest | void} fn @returns {Promise<any>} */
async function op(name, mode, fn) {
  const d = await db(); if (!d) return undefined;
  return new Promise(res => {
    try {
      const tx = d.transaction(name, mode), q = fn(tx.objectStore(name));
      tx.oncomplete = () => res(q ? q.result : undefined); tx.onerror = tx.onabort = () => res(undefined);
    } catch { res(undefined); }
  });
}

/* ---------- media hashes ---------- */
/** @type {Map<string, { sha256: string, bytes: number, mime: string }>} */ const hashes = new Map();
/** @type {Map<string, string>} */ const bySha = new Map();
/** @type {Set<string>} */ const noFile = new Set();
const hashesLoaded = (async () => {
  const [keys, vals] = await Promise.all([op('hashes', 'readonly', st => st.getAllKeys()), op('hashes', 'readonly', st => st.getAll())]);
  (keys || []).forEach((/** @type {any} */ k, /** @type {number} */ i) => { const v = vals && vals[i]; if (typeof k === 'string' && v && typeof v.sha256 === 'string') { hashes.set(k, v); if (!bySha.has(v.sha256)) bySha.set(v.sha256, k); } });
})();
const canHash = () => !!(globalThis.crypto && crypto.subtle);
async function sha256(/** @type {Blob} */ b) {
  const h = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const localIdFor = (/** @type {string} */ hex) => { const id = bySha.get(hex); return id && !noFile.has(id) ? id : undefined; };

/**
 * @typedef {{ roomId: string, token: string, name: string, dev?: string }} Binding   dev: this browser's id
 * @typedef {'syncing' | 'synced' | 'offline' | 'unreachable' | 'rejected'} Status
 * @typedef {{ id: number, name: string, initials: string, sel: string | null }} Peer
 * @typedef {{
 *   project(pid: string): any,                 the app's live project object if `pid` is open, else null
 *   applyRemote(pid: string, p: any): void,    take the doc's state (sanitized) into the open project, save it locally
 *   busy(): boolean,                           a drag is running: hold remote changes for a moment
 *   focusedText(): { el: HTMLInputElement | HTMLTextAreaElement, shotId: string, field: string } | null,
 *   mediaBlob(id: string): Promise<Blob | null>,
 *   songBlob(pid: string): Promise<{ blob: Blob, name: string } | null>,
 *   onStatus(pid: string, s: Status): void,
 *   onPeers(pid: string, peers: Peer[]): void,
 *   onEvent(pid: string, type: 'shared' | 'not-empty'): void,
 * }} App
 */

/** @param {App} app @param {string} syncUrl e.g. wss://sync.example.dev */
export function createCollab(app, syncUrl) {
  const base = syncUrl.replace(/\/+$/, '') + '/r';
  const connect = (/** @type {string} */ roomId, /** @type {string} */ token, /** @type {Y.Doc} */ doc, /** @type {boolean} */ now) =>
    new WebsocketProvider(base, roomId, doc, { protocols: ['cueboard', token], disableBc: true, connect: now, maxBackoffTime: 10000 });

  /** Connect once, read the room, disconnect. */
  async function probe(/** @type {string} */ roomId, /** @type {string} */ token, ms = 8000) {
    await hashesLoaded;
    const doc = new Y.Doc(), p = connect(roomId, token, doc, true);
    try {
      /** @type {{ ok: boolean, reason?: string }} */
      const r = await new Promise(ok => {
        const t = setTimeout(() => ok({ ok: false, reason: 'unreachable' }), ms);
        p.on('sync', s => { if (s) { clearTimeout(t); ok({ ok: true }); } });
        p.on('connection-close', ev => { if (ev && REJECTED.has(ev.code)) { clearTimeout(t); ok({ ok: false, reason: 'rejected' }); } });
      });
      if (!r.ok) return r;
      const v = docToProject(doc, localIdFor);
      if (!v) return { ok: false, reason: 'malformed' };
      return { ok: true, empty: isEmptyRoom(doc), title: v.project.title, shots: v.project.sections.length, project: v.project, update: Y.encodeStateAsUpdate(doc) };
    } finally { p.destroy(); doc.destroy(); }
  }

  /** Keep a room's state for a local project before its session opens (so "open as a new project" starts offline-ready). */
  const seed = (/** @type {string} */ pid, /** @type {Uint8Array} */ update) => op('docs', 'readwrite', st => st.put(update, pid));
  const forget = (/** @type {string} */ pid) => op('docs', 'readwrite', st => st.delete(pid));

  /**
   * Bind the open project `pid` to its room.
   * mode "share": the room must still be empty on first sync; then the local project is written into it.
   * @param {string} pid @param {Binding} binding @param {{ mode?: 'normal' | 'share' }} [o]
   */
  function open(pid, binding, { mode = 'normal' } = {}) {
    const doc = new Y.Doc();
    /** @type {WebsocketProvider | null} */ let prov = null;
    /** @type {any} */ let last = null;           // the project as the doc held it after our last push or pull
    let ready = false, stopped = false, rejected = false, failing = false, pullQueued = false;
    /** @type {any} */ let caret = null;
    /** @type {any} */ let refs = new Map(), songFile = null, songLocal = null, songFor = null;
    /** @type {any} */ let pushTimer = 0, saveTimer = 0;
    /** @type {Set<string>} */ const needHash = new Set();
    let hashing = false;

    const status = () => /** @type {Status} */ (rejected ? 'rejected' : !navigator.onLine ? 'offline' : prov && prov.wsconnected ? (prov.synced ? 'synced' : 'syncing') : failing ? 'unreachable' : 'syncing');
    let shown = '';
    const report = () => { if (stopped) return; const s = status(); if (s !== shown) { shown = s; app.onStatus(pid, s); } };

    /* ----- app -> doc ----- */
    function refOf(/** @type {string} */ id) {
      const m = SHA_ID.exec(id);
      if (m) return refs.get(m[1]) || { sha256: m[1], bytes: 0, mime: '' };
      const h = hashes.get(id);
      if (h) return { ...h };
      if (noFile.has(id)) return null;
      if (canHash()) needHash.add(id);
      return undefined;
    }
    function songRef(/** @type {any} */ song) {
      if (songLocal === 'pending') return undefined;
      const f = songLocal && songLocal.name === song.name ? songLocal : songFile && songFile.name === song.name ? songFile : null;
      return f ? { ...song, sha256: f.sha256, mime: f.mime, bytes: f.bytes } : { ...song };
    }
    async function checkSong(/** @type {string} */ name) {
      songFor = name; songLocal = 'pending';
      let r = null;
      try { const rec = canHash() ? await app.songBlob(pid) : null; if (rec && rec.blob) r = { sha256: await sha256(rec.blob), mime: rec.blob.type || '', bytes: rec.blob.size, name: rec.name || name }; } catch { r = null; }
      songLocal = r;
      if (!stopped) push();
    }
    async function hashQueued() {
      if (hashing) return; hashing = true;
      try {
        while (needHash.size) {
          const [id] = needHash; needHash.delete(id);
          if (hashes.has(id) || noFile.has(id)) continue;
          const b = await app.mediaBlob(id).catch(() => null);
          if (!b) { noFile.add(id); continue; }
          const ref = { sha256: await sha256(b), bytes: b.size, mime: b.type || '' };
          hashes.set(id, ref); if (!bySha.has(ref.sha256)) bySha.set(ref.sha256, id);
          op('hashes', 'readwrite', st => st.put(ref, id));
        }
      } catch { /* a file we can't read stays unsynced; retried on the next change */ }
      hashing = false;
      if (!stopped) push();
    }
    function push() {
      if (!ready || stopped) return;
      const cur = app.project(pid); if (!cur) return;
      if (cur.song && cur.song.name !== songFor) checkSong(cur.song.name);
      last = pushProject(doc, last, cur, { refOf, songRef, origin: LOCAL });
      if (needHash.size) hashQueued();
    }

    /* ----- doc -> app ----- */
    function captureCaret() {
      const f = app.focusedText(); if (!f) return null;
      const ys = shotsMap(doc).get(f.shotId), yt = ys instanceof Y.Map ? ys.get(f.field) : null;
      if (!(yt instanceof Y.Text) || yt.toString() !== f.el.value) return null;
      return { el: f.el, yt, val: f.el.value, dir: f.el.selectionDirection || 'none',
        a: Y.createRelativePositionFromTypeIndex(yt, f.el.selectionStart || 0), b: Y.createRelativePositionFromTypeIndex(yt, f.el.selectionEnd || 0) };
    }
    function restoreCaret(/** @type {any} */ c) {
      if (!c || document.activeElement !== c.el || c.yt._item?.deleted) return;
      const typed = c.el.value !== c.val, v = c.yt.toString();
      if (c.el.value !== v) c.el.value = v;
      const a = Y.createAbsolutePositionFromRelativePosition(c.a, doc), b = Y.createAbsolutePositionFromRelativePosition(c.b, doc);
      if (!typed && a && b) c.el.setSelectionRange(a.index, b.index, c.dir);
    }
    function queuePull() { if (!pullQueued) { pullQueued = true; queueMicrotask(pull); } }
    function pull() {
      if (stopped) return;
      if (app.busy()) { setTimeout(pull, 200); return; }
      pullQueued = false;
      if (!ready) return;
      push();                                    // anything typed here but not sent yet goes first
      const c = caret; caret = null;
      const v = docToProject(doc, localIdFor);
      if (!v) return;                            // malformed remote data: ignored, the last good state stays
      refs = v.refs; songFile = v.songFile; last = v.project;
      if (!same(v.project, stripLocal(app.project(pid)))) app.applyRemote(pid, structuredClone(v.project));
      restoreCaret(c);
    }
    const stripLocal = (/** @type {any} */ p) => { if (!p) return p; const { id, updated, ...rest } = p; return rest; };

    /** First look at the doc: from here on edits flow both ways. */
    function start() {
      const v = docToProject(doc, localIdFor); if (!v) return;
      refs = v.refs; songFile = v.songFile; last = v.project; ready = true;
      push();                                    // local edits the doc never got (saved here, page closed before sending)
    }
    function firstSync() {
      if (ready || stopped) return;
      if (mode === 'share') {
        if (!isEmptyRoom(doc)) { app.onEvent(pid, 'not-empty'); return; }
        clearShots(doc, LOCAL); last = null; ready = true; push();
        app.onEvent(pid, 'shared');
        return;
      }
      start(); queuePull();
    }

    doc.on('beforeTransaction', tr => { if (ready && tr.origin !== LOCAL && !caret) caret = captureCaret(); });
    doc.on('afterTransaction', tr => { if (ready && tr.origin !== LOCAL && (tr.changed.size || tr.deleteSet.clients.size)) queuePull(); });
    const saveDoc = () => op('docs', 'readwrite', st => st.put(Y.encodeStateAsUpdate(doc), pid));
    doc.on('update', () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveDoc, 300); });

    const onOnline = () => { if (prov && !rejected && !stopped) prov.connect(); report(); };
    const onOffline = () => { if (prov) prov.disconnect(); report(); };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);

    (async () => {
      await hashesLoaded;
      const saved = await op('docs', 'readonly', st => st.get(pid));
      if (stopped) return;
      if (saved) { try { Y.applyUpdate(doc, new Uint8Array(saved), 'idb'); } catch { /* a damaged local copy: the server's state fills in */ } }
      if (mode === 'normal' && shotsMap(doc).size) start();   // offline-first: editable before the server answers
      prov = connect(binding.roomId, binding.token, doc, navigator.onLine);
      prov.awareness.setLocalState({ user: { name: binding.name, dev: binding.dev || '' }, sel: null });
      prov.on('status', e => { if (e.status === 'connected') failing = false; report(); });
      prov.on('sync', s => { if (s) firstSync(); report(); });
      prov.on('connection-error', () => { failing = true; report(); });
      prov.on('connection-close', ev => {
        if (ev && REJECTED.has(ev.code)) { rejected = true; prov && prov.disconnect(); }
        else if (prov && prov.shouldConnect) failing = true;
        report();
      });
      prov.awareness.on('change', () => { if (!stopped) app.onPeers(pid, peers()); });
      report();
    })();

    function peers() {
      /** @type {Peer[]} */ const out = [];
      if (!prov) return out;
      for (const [id, st] of prov.awareness.getStates()) {
        if (id === doc.clientID || !st || typeof st !== 'object') continue;
        // this browser in another tab, or this tab before a reload (its state lingers until it times out): not someone else
        if (binding.dev && st.user && st.user.dev === binding.dev) continue;
        const name = sanitizeName(st.user && st.user.name); if (!name) continue;
        out.push({ id, name, initials: initials(name), sel: typeof st.sel === 'string' && SHOT_ID.test(st.sel) ? st.sel : null });
        if (out.length >= 24) break;
      }
      return out;
    }

    return {
      /** the app changed something; text edits go out at once, the rest batched */
      changed(/** @type {boolean} */ now) { clearTimeout(pushTimer); if (now) push(); else pushTimer = setTimeout(push, 150); },
      select(/** @type {string | null} */ id) { const a = prov && prov.awareness; if (a && a.getLocalState()?.sel !== id) a.setLocalStateField('sel', id); },
      status,
      peers,
      stop() {
        if (stopped) return;
        clearTimeout(pushTimer); push(); stopped = true;
        clearTimeout(saveTimer); saveDoc();
        window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
        if (prov) { prov.awareness.setLocalState(null); prov.destroy(); }
        setTimeout(() => doc.destroy(), 0);
      },
    };
  }

  return { probe, open, seed, forget };
}
