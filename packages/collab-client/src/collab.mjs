// @ts-check
/* Cue Board collaboration client. Bundled into /collab.js (npm run build:collab) and loaded by index.html with a
   dynamic import() only once a project is bound to a room. index.html hands in `app`, a small set of callbacks;
   nothing here touches the app's own storage.

   Storage (IndexedDB "cueboard-collab", separate from the app's "cueboard-local"):
     docs   : projectId -> { u: Y.Doc state, base: the push base that goes with the app's saved project } (offline
              edits survive a reload and merge on reconnect). A bare Uint8Array (seed(), older copies) has no base.
     hashes : mediaId   -> { sha256, bytes, mime } (this device's media files, by content hash)
     parts  : sha256    -> { size, mime, pid, t } a file being received from peers (media.mjs, docs/media-p2p.md)
     chunks : [sha256, i] -> Blob, its verified chunks so far (a reload or a crash resumes from them)
   The invite token only ever goes into the WebSocket subprotocol list, never into a URL, a log line or the doc. */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { shotsMap } from '@cue-board/sync-server/schema';
import { docToProject, pushProject, keepPending, isEmptyRoom, clearShots, sanitizeName, initials, same } from './convert.mjs';
import { createMedia } from './media.mjs';

const LOCAL = 'cueboard-app';                      // transaction origin of our own writes
const REJECTED = new Set([4400, 4401, 4404]);       // the server won't take us: stop retrying
const SHA_ID = /^sha256-([0-9a-f]{64})$/;
const SHOT_ID = /^[\w-]{1,64}$/;

/* ---------- IndexedDB ---------- */
/** @type {Promise<IDBDatabase | null> | null} */ let dbP = null;
const BLOCKED_MS = 2500;
/* 'ok' · 'blocked': a tab still running an older version holds the database at version 1, so the upgrade waits until that
   tab closes or reloads. After BLOCKED_MS this tab goes on without it (the doc syncs, without the offline copy; file
   transfers wait, the chip says why) and switches to it once it opens · 'replaced': a newer version opened in another
   tab and this one let go of the database (reloading fixes it) · 'failed': no IndexedDB here */
/** @type {'ok' | 'blocked' | 'replaced' | 'failed'} */ let dbState = 'ok';
/** @type {Set<() => void>} */ const dbWatch = new Set();      // open sessions: the database opened late or went away
function db() {
  if (!dbP) dbP = new Promise(res => {
    let settled = false, timer = /** @type {any} */ (0);
    const settle = (/** @type {IDBDatabase | null} */ d) => { if (!settled) { settled = true; clearTimeout(timer); res(d); } };
    try {
      const r = indexedDB.open('cueboard-collab', 2);
      r.onupgradeneeded = () => { for (const n of ['docs', 'hashes', 'parts', 'chunks']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
      r.onsuccess = () => {
        const d = r.result;
        // a later version opening in another tab: let go at once instead of blocking it like we were blocked
        d.onversionchange = () => { d.close(); dbState = 'replaced'; dbP = Promise.resolve(null); dbWatch.forEach(f => f()); };
        dbState = 'ok';
        if (settled) { dbP = Promise.resolve(d); loadHashes().finally(() => dbWatch.forEach(f => f())); }   // opened late
        else settle(d);
      };
      r.onerror = () => { if (!settled) dbState = 'failed'; settle(null); };
      r.onblocked = () => { if (!timer) timer = setTimeout(() => { dbState = 'blocked'; settle(null); dbWatch.forEach(f => f()); }, BLOCKED_MS); };
    } catch { dbState = 'failed'; res(null); }
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
/** a hash's local id, unless that one is gone: then the newest copy wins */
const noteHash = (/** @type {string} */ hex, /** @type {string} */ id) => { const was = bySha.get(hex); if (!was || noFile.has(was)) bySha.set(hex, id); };
async function loadHashes() {
  const [keys, vals] = await Promise.all([op('hashes', 'readonly', st => st.getAllKeys()), op('hashes', 'readonly', st => st.getAll())]);
  (keys || []).forEach((/** @type {any} */ k, /** @type {number} */ i) => { const v = vals && vals[i]; if (typeof k === 'string' && v && typeof v.sha256 === 'string' && !hashes.has(k) && !noFile.has(k)) { hashes.set(k, v); noteHash(v.sha256, k); } });
}
const hashesLoaded = loadHashes();
const canHash = () => !!(globalThis.crypto && crypto.subtle);
async function sha256(/** @type {Blob} */ b) {
  const h = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const localIdFor = (/** @type {string} */ hex) => { const id = bySha.get(hex); return id && !noFile.has(id) ? id : undefined; };
/** The app deleted media file `id`: forget its hash, so a remote ref to the same content finds another local copy
    (or a later one) instead of the dead id. Ids are never reused. */
async function dropMedia(/** @type {string} */ id) {
  await hashesLoaded;
  const h = hashes.get(id); hashes.delete(id); noFile.add(id);
  if (h && bySha.get(h.sha256) === id) {
    bySha.delete(h.sha256);
    for (const [k, v] of hashes) if (v.sha256 === h.sha256 && !noFile.has(k)) { bySha.set(h.sha256, k); break; }
  }
  return op('hashes', 'readwrite', st => st.delete(id));
}

/* ---------- partly received files (media.mjs) ---------- */
const range = (/** @type {string} */ hex) => (typeof IDBKeyRange === 'function' ? IDBKeyRange.bound([hex, 0], [hex, Infinity]) : null);
const parts = {
  /** start or resume receiving `hex`: the indexes of the chunks already stored */
  async open(/** @type {string} */ hex, /** @type {any} */ meta) {
    const r = range(hex); if (!r) return [];
    const old = await op('parts', 'readonly', st => st.get(hex));
    if (old && old.size === meta.size) {
      if (old.pid !== meta.pid) await op('parts', 'readwrite', st => st.put({ ...old, pid: meta.pid }, hex));
      const keys = await op('chunks', 'readonly', st => st.getAllKeys(r));
      return (keys || []).map((/** @type {any} */ k) => k[1]).filter(Number.isInteger);
    }
    if (old) await parts.drop(hex);
    await op('parts', 'readwrite', st => st.put(meta, hex));
    return [];
  },
  /** false when the write failed (quota exceeded, storage gone) */
  async put(/** @type {string} */ hex, /** @type {number} */ i, /** @type {Uint8Array} */ b) {
    return (await op('chunks', 'readwrite', st => st.put(new Blob([b]), [hex, i]))) !== undefined;
  },
  async read(/** @type {string} */ hex, /** @type {number} */ count) {
    const r = range(hex), v = r && await op('chunks', 'readonly', st => st.getAll(r));
    return Array.isArray(v) && v.length === count && v.every(b => b instanceof Blob) ? v : null;
  },
  /** the files project `pid` has parts of */
  async list(/** @type {string} */ pid) {
    const [keys, vals] = await Promise.all([op('parts', 'readonly', st => st.getAllKeys()), op('parts', 'readonly', st => st.getAll())]);
    return (keys || []).filter((/** @type {any} */ k, /** @type {number} */ i) => typeof k === 'string' && vals && vals[i] && vals[i].pid === pid);
  },
  async drop(/** @type {string} */ hex) {
    const r = range(hex); if (!r) return;
    await op('chunks', 'readwrite', st => st.delete(r)); await op('parts', 'readwrite', st => st.delete(hex));
  },
  /** what a left room was receiving; with no pid, whatever no room's offline copy points at anymore, and orphan chunks */
  async gc(/** @type {string} */ pid = '') {
    if (!range('0')) return;
    const [keys, vals] = await Promise.all([op('parts', 'readonly', st => st.getAllKeys()), op('parts', 'readonly', st => st.getAll())]);
    const docs = new Set(pid ? [] : (await op('docs', 'readonly', st => st.getAllKeys())) || []);
    const keep = new Set();
    for (const [i, k] of (keys || []).entries()) {
      const v = vals && vals[i];
      if (pid ? v && v.pid === pid : !v || !docs.has(v.pid)) await parts.drop(k); else keep.add(k);
    }
    if (!pid) for (const hex of new Set(((await op('chunks', 'readonly', st => st.getAllKeys())) || []).map((/** @type {any} */ k) => k[0]))) if (!keep.has(hex)) await parts.drop(hex);
  },
};

/** <meta name="cue-ice-urls">: space- or comma-separated stun:/turn: URLs; a TURN login as turn:user:secret@host:port.
    Empty: no ICE servers at all, so only host candidates (same network) connect directly; everyone else uses the relay. */
export function parseIce(/** @type {string} */ s) {
  /** @type {RTCIceServer[]} */ const out = [];
  for (const u of String(s || '').split(/[\s,]+/).filter(Boolean).slice(0, 8)) {
    const t = /^(turns?):([^:@\s]+):([^@\s]+)@([\w.[\]:?=&-]+)$/.exec(u);
    if (t) out.push({ urls: t[1] + ':' + t[4], username: t[2], credential: t[3] });
    else if (/^(stuns?|turns?):[\w.[\]:?=&-]+$/.test(u)) out.push({ urls: u });
  }
  return out;
}

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
 *   onUnshared?(pid: string, n: number): void, n media fields whose file couldn't be read or hashed: kept here, not in the room
 *   storeMedia?(blob: Blob, mime: string): Promise<string>,   a file received from a peer, verified: keep it, return its new media id
 *   storeSong?(pid: string, blob: Blob, name: string): Promise<void>,
 *   onMedia?(pid: string): void,               transfer state changed (chip, placeholders, files list)
 *   mediaLimits?(pid: string): { file: number, project: number },
 * }} App
 */

/** @param {App} app @param {string} syncUrl e.g. wss://sync.example.dev @param {{ ice?: RTCIceServer[], media?: boolean }} [opts] */
export function createCollab(app, syncUrl, opts = {}) {
  // __CUE_MEDIA_TEST.off: design/collab-check.mjs checks doc sync with media transfers off (design/media-check.mjs covers them)
  const ice = opts.ice || [], mediaOn = opts.media !== false && !!app.storeMedia && !(/** @type {any} */ (globalThis).__CUE_MEDIA_TEST?.off);
  if (mediaOn) setTimeout(() => parts.gc().catch(() => {}), 10000);
  const base = syncUrl.replace(/\/+$/, '') + '/r';
  const connect = (/** @type {string} */ roomId, /** @type {string} */ token, /** @type {Y.Doc} */ doc, /** @type {boolean} */ now) => {
    const p = new WebsocketProvider(base, roomId, doc, { protocols: ['cueboard', token], disableBc: true, connect: now, maxBackoffTime: 10000 });
    p.messageHandlers[10] = () => {};            // media frames (media.mjs takes them over); a probe ignores them
    return p;
  };

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
  /** @type {Map<string, Set<() => void>>} */ const live = new Map();   // pid -> its open sessions' "never write the copy again"
  const forget = (/** @type {string} */ pid) => { for (const f of live.get(pid) || []) f(); parts.gc(pid).catch(() => {}); return op('docs', 'readwrite', st => st.delete(pid)); };

  /**
   * Bind the open project `pid` to its room.
   * mode "share": the room must still be empty on first sync; then the local project is written into it.
   * @param {string} pid @param {Binding} binding @param {{ mode?: 'normal' | 'share' }} [o]
   */
  function open(pid, binding, { mode = 'normal' } = {}) {
    const doc = new Y.Doc();
    /** @type {WebsocketProvider | null} */ let prov = null;
    /** @type {any} */ let last = null;           // the project as the doc held it after our last push or pull
    /* `last` as it was when the app last saved its project (mark/saved), stored with the offline copy so a reopen pushes
       only what changed since. Never ahead of the app's saved project: a remote change pulled here but not yet in the
       app's storage when the page dies is in the doc and not in the base, so the reopen pulls it instead of undoing it. */
    /** @type {any} */ let savedBase = null;
    let dropped = false;                          // forget(pid): the offline copy is gone and is never written again
    /** @type {Uint8Array | null} */ let finalState = null;
    let ready = false, stopped = false, rejected = false, failing = false, pullQueued = false;
    /** @type {any} */ let caret = null;
    /** @type {any} */ let refs = new Map(), songFile = null, songLocal = null, songFor = null;
    /** @type {any} */ let pushTimer = 0, saveTimer = 0;
    /** @type {Set<string>} */ const needHash = new Set();
    /** @type {Set<string>} */ const failed = new Set();   // media ids that couldn't be read or hashed: not retried this session
    let hashing = false;
    /* Fields the last push had to leave out because their file isn't hashed yet (or can't be): the doc still has the
       old value, the app the new one. Pulls keep the app's value for them (keepPending), so a remote change arriving
       meanwhile doesn't undo a local one. Rebuilt on every push, so a field changed again, written, or deleted
       elsewhere drops out by itself. */
    /** @type {Map<string, import('./convert.mjs').Hold>} */ let held = new Map();
    let unshared = 0;
    /** @type {ReturnType<typeof createMedia> | null} */ let media = null;
    /** @type {Map<string, any> | null} */ let wantCache = null;
    /* every file the doc references: hash -> size, type, a label for the files list, and whether this device has it */
    function wanted() {
      if (wantCache) return wantCache;
      const v = docToProject(doc, localIdFor), m = new Map();
      if (!v) return (wantCache = m);
      const hexOf = (/** @type {string} */ id) => { const x = SHA_ID.exec(id || ''); return x ? x[1] : id && hashes.get(id)?.sha256; };
      /** @type {Map<string, string>} */ const label = new Map();
      const name = (/** @type {string | undefined} */ h, /** @type {string} */ l) => { if (h && !label.has(h)) label.set(h, l); };
      v.project.sections.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const n = 'Shot ' + String(i + 1).padStart(2, '0');
        name(hexOf(s.img), n + ' · ' + (s.kind === 'video' ? 'clip' : 'image')); name(hexOf(s.key), n + ' · start frame'); name(hexOf(s.endKey), n + ' · end frame');
        (s.takes || []).forEach((/** @type {any} */ t, /** @type {number} */ j) => name(hexOf(t.media), n + ' · take ' + (j + 1)));
      });
      (v.project.refs || []).forEach((/** @type {string} */ id) => name(hexOf(id), 'Reference image'));
      for (const [hex, r] of v.refs) m.set(hex, { bytes: r.bytes, mime: r.mime, label: label.get(hex) || 'File', local: !!localIdFor(hex) });
      const sf = v.songFile, sl = songLocal;
      if (sf && sl !== 'pending' && (!sl || sl.sha256 === sf.sha256)) m.set(sf.sha256, { bytes: sf.bytes, mime: sf.mime, label: 'Song' + (sf.name ? ' · ' + sf.name : ''), song: true, local: !!sl });
      return (wantCache = m);
    }
    const mediaChanged = () => { wantCache = null; if (media) media.refresh(); };
    dbWatch.add(mediaChanged);                    // the database opened late (hashes loaded) or went away: the chip, transfers
    async function landed(/** @type {string} */ hex, /** @type {Blob} */ blob, /** @type {any} */ w) {
      if (stopped) throw new Error('session stopped');
      if (w.song) {
        if (!app.storeSong) throw new Error('no song store');
        const name = (songFile && songFile.name) || 'song';
        await app.storeSong(pid, blob, name);
        songLocal = { sha256: hex, mime: w.mime, bytes: blob.size, name }; songFor = app.project(pid)?.song?.name ?? songFor;
      } else {
        if (!app.storeMedia) throw new Error('no media store');
        const id = await app.storeMedia(blob, w.mime), ref = { sha256: hex, bytes: blob.size, mime: w.mime };
        hashes.set(id, ref); noteHash(hex, id);
        await op('hashes', 'readwrite', st => st.put(ref, id));
      }
      mediaChanged(); queuePull();
    }

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
      if (canHash() && !failed.has(id)) needHash.add(id);
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
      songLocal = r; wantCache = null;
      if (!stopped) push();
    }
    async function hashQueued() {
      if (hashing) return; hashing = true;
      while (needHash.size && !stopped) {
        const [id] = needHash; needHash.delete(id);
        if (hashes.has(id) || noFile.has(id) || failed.has(id)) continue;
        try {
          const b = await app.mediaBlob(id);
          if (!b) { noFile.add(id); continue; }
          const ref = { sha256: await sha256(b), bytes: b.size, mime: b.type || '' };
          if (noFile.has(id)) continue;          // deleted (dropMedia) while it was being hashed
          hashes.set(id, ref); noteHash(ref.sha256, id);
          op('hashes', 'readwrite', st => st.put(ref, id));
        } catch { failed.add(id); }            // read or hash failed or was aborted: the file stays here, unshared
      }
      hashing = false;
      if (!stopped) push();
    }
    function push() {
      if (!ready || stopped) return;
      const cur = app.project(pid); if (!cur) return;
      if (cur.song && cur.song.name !== songFor) checkSong(cur.song.name);
      /** @type {Map<string, import('./convert.mjs').Hold>} */ const now = new Map();
      last = pushProject(doc, last, cur, { refOf, songRef, origin: LOCAL, pending: h => now.set([h.shot, h.take, h.field].join('/'), h) });
      held = now; reportUnshared();
      if (needHash.size) hashQueued();
      mediaChanged();
    }
    const isFailed = (/** @type {import('./convert.mjs').Hold} */ h) => [h.value].flat().some(id => failed.has(id));
    function reportUnshared() {
      const n = [...held.values()].filter(isFailed).length;
      if (n !== unshared) { unshared = n; if (app.onUnshared) app.onUnshared(pid, n); }
    }
    /** a held field's value in a project, or undefined if its shot or take is gone */
    function valueAt(/** @type {any} */ p, /** @type {import('./convert.mjs').Hold} */ h) {
      if (!h.shot) return p[h.field];
      const s = p.sections.find((/** @type {any} */ x) => x.id === h.shot), o = s && (h.take ? s.takes.find((/** @type {any} */ t) => t.id === h.take) : s);
      return o ? o[h.field] : undefined;
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
      // a file that can't be hashed is never written: once someone else changes that field, their value wins
      for (const [k, h] of held) if (isFailed(h) && !same(valueAt(v.project, h) ?? '', h.base ?? '')) held.delete(k);
      const mine = keepPending(structuredClone(v.project), held.values());
      if (!same(mine, stripLocal(app.project(pid)))) app.applyRemote(pid, mine);
      reportUnshared(); mediaChanged();
      restoreCaret(c);
    }
    const stripLocal = (/** @type {any} */ p) => { if (!p) return p; const { id, updated, ...rest } = p; return rest; };

    /** First look at the doc: from here on edits flow both ways. */
    function start() {
      const v = docToProject(doc, localIdFor); if (!v) return;
      refs = v.refs; songFile = v.songFile; last = savedBase || v.project; ready = true;
      push();                                    // local edits the doc never got (saved here, page closed before sending)
      if (!savedBase) savedBase = last;          // a copy without a base (seeded, or older): the app's project is what we just synced
      queuePull();                               // and what the doc has that the app's saved project doesn't
    }
    function firstSync() {
      if (ready || stopped) return;
      if (mode === 'share') {
        if (!isEmptyRoom(doc)) { app.onEvent(pid, 'not-empty'); return; }
        clearShots(doc, LOCAL); last = null; ready = true; push(); savedBase = last;
        app.onEvent(pid, 'shared');
        return;
      }
      start(); queuePull();
    }

    doc.on('beforeTransaction', tr => { if (ready && tr.origin !== LOCAL && !caret) caret = captureCaret(); });
    doc.on('afterTransaction', tr => { if (ready && tr.origin !== LOCAL && (tr.changed.size || tr.deleteSet.clients.size)) queuePull(); });
    const saveDoc = () => {
      saveTimer = 0; if (dropped) return;
      const u = finalState || Y.encodeStateAsUpdate(doc), base = savedBase;
      op('docs', 'readwrite', st => st.put({ u, base }, pid));
    };
    doc.on('update', () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveDoc, 300); });
    const onHide = () => { if (saveTimer && !stopped) { clearTimeout(saveTimer); saveDoc(); } };
    const onVis = () => { if (document.visibilityState === 'hidden') onHide(); };
    window.addEventListener('pagehide', onHide); globalThis.document?.addEventListener('visibilitychange', onVis);
    const drop = () => { dropped = true; clearTimeout(saveTimer); };
    if (!live.has(pid)) live.set(pid, new Set());
    /** @type {Set<() => void>} */ (live.get(pid)).add(drop);
    const unlist = () => { const l = live.get(pid); if (l) { l.delete(drop); if (!l.size) live.delete(pid); } };
    let marks = 0;                                // app saves begun (mark) and not finished (saved)

    const onOnline = () => { if (prov && !rejected && !stopped) prov.connect(); report(); };
    const onOffline = () => { if (prov) prov.disconnect(); report(); };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);

    (async () => {
      await hashesLoaded;
      const saved = await op('docs', 'readonly', st => st.get(pid));
      if (stopped) return;
      const u = saved && saved.u ? saved.u : saved, b = saved && saved.u && saved.base;
      const base = b && typeof b === 'object' && Array.isArray(b.sections) ? b : null;   // written by us, like the app's own copy
      if (u) { try { Y.applyUpdate(doc, new Uint8Array(u), 'idb'); savedBase = base; } catch { /* a damaged local copy: the server's state fills in */ } }
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
      if (mediaOn) media = createMedia({
        provider: prov, roomId: binding.roomId, token: binding.token, pid, ice, store: parts, wanted, landed,
        localBlob: async hex => {
          const w = wanted().get(hex);
          if (w && w.song) { const r = songLocal && songLocal !== 'pending' && songLocal.sha256 === hex ? await app.songBlob(pid) : null; return r ? r.blob : null; }
          const id = localIdFor(hex); if (!id) return null;
          const b = await app.mediaBlob(id);
          if (!b) { noFile.add(id); wantCache = null; }     // gone from this browser's storage: fetched again from the others
          return b;
        },
        clientName: c => { const st = prov && prov.awareness.getStates().get(c); return st ? sanitizeName(st.user && st.user.name) : ''; },
        limits: () => (app.mediaLimits ? app.mediaLimits(pid) : { file: 500e6, project: 5e9 }),
        onChange: () => { if (!stopped && app.onMedia) app.onMedia(pid); },
        storage: () => (dbState === 'blocked' || dbState === 'replaced' ? dbState : 'ok'),
      });
      report();
    })();

    function peers() {
      /** @type {Peer[]} */ const out = [];
      if (!prov) return out;
      const a = prov.awareness, at = (/** @type {number} */ id) => a.meta.get(id)?.lastUpdated || 0;
      /** @type {Map<string, number>} */ const byDev = new Map();   // someone else's browser -> its index in `out`
      for (const [id, st] of a.getStates()) {
        if (id === doc.clientID || !st || typeof st !== 'object') continue;
        // this browser in another tab, or this tab before a reload (its state lingers until it times out): not someone else
        if (binding.dev && st.user && st.user.dev === binding.dev) continue;
        const name = sanitizeName(st.user && st.user.name); if (!name) continue;
        const p = { id, name, initials: initials(name), sel: typeof st.sel === 'string' && SHOT_ID.test(st.sel) ? st.sel : null };
        // one person per browser: two tabs, or a tab and its pre-reload session, show once (the most recently active)
        const dev = st.user && typeof st.user.dev === 'string' && st.user.dev ? st.user.dev : '', i = dev ? byDev.get(dev) : undefined;
        if (i !== undefined) { if (at(id) > at(out[i].id)) out[i] = p; continue; }
        if (out.length >= 24) continue;
        if (dev) byDev.set(dev, out.length);
        out.push(p);
      }
      return out;
    }

    return {
      /** the app changed something; text edits go out at once, the rest batched */
      changed(/** @type {boolean} */ now) { clearTimeout(pushTimer); if (now) push(); else pushTimer = setTimeout(push, 150); },
      /** the app is about to save its project: send what's unsent, and return the base that goes with that save */
      mark() { if (!ready || stopped) return undefined; clearTimeout(pushTimer); push(); marks++; return { base: last }; },
      /** that save is done (ok: it went through): the offline copy gets its base now, also after stop() unless the room was left */
      saved(/** @type {any} */ m, /** @type {boolean} */ ok) {
        if (!m) return;
        if (!--marks && stopped) unlist();
        if (ok && !dropped) { savedBase = m.base; clearTimeout(saveTimer); saveDoc(); }
      },
      select(/** @type {string | null} */ id) { const a = prov && prov.awareness; if (a && a.getLocalState()?.sel !== id) a.setLocalStateField('sel', id); },
      status,
      peers,
      /** transfer state for the chip, the placeholders and the files list; null when media sync is off */
      media: () => media,
      stop() {
        if (stopped) return;
        clearTimeout(pushTimer); push(); stopped = true;
        clearTimeout(saveTimer); finalState = Y.encodeStateAsUpdate(doc); saveDoc();
        window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
        window.removeEventListener('pagehide', onHide); globalThis.document?.removeEventListener('visibilitychange', onVis);
        if (!marks) unlist();
        dbWatch.delete(mediaChanged);
        if (media) media.stop();
        if (prov) { prov.awareness.setLocalState(null); prov.destroy(); }
        setTimeout(() => doc.destroy(), 0);
      },
    };
  }

  return { probe, open, seed, forget, dropMedia };
}
