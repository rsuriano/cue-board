// @ts-check
/* The app's project object <-> the shared Y.Doc (schema 1, see packages/sync-server/docs/data-model.md).

   Doc -> app: docToCueboard() from the sync server (the same export the server tests check), then sanitizeProject(),
   because everything in the doc came from someone else's browser.
   App -> doc: pushProject() writes only what changed between `base` (what the doc held the last time we looked) and
   `cur` (the app's project now), field by field, with the schema's rules: text fields are Y.Text edited by minimal
   diffs, media fields are hash refs, takes are Y.Maps matched by id, everything else is last-writer-wins. Writing a
   whole project into an empty doc (base = null) gives the same doc as cueboardToDoc() (tested). */
import * as Y from 'yjs';
import { SCHEMA_VERSION, TEXT_FIELDS, SHOT_MEDIA_FIELDS, metaMap, refsArray, shotsMap, setText } from '@cue-board/sync-server/schema';
import { docToCueboard } from '@cue-board/sync-server/import-cueboard';

/** Limits for remote data. Anything over them is cut or dropped, never applied as is. */
export const LIMITS = { shots: 500, takes: 200, refs: 12, peaks: 5000, text: 20000, line: 500, other: 2000, id: 64, name: 40 };
const META_SKIP = new Set(['id', 'updated', 'sections', 'refs', 'song']);
const HEX = /^[0-9a-f]{64}$/;
const SHA_ID = /^sha256-([0-9a-f]{64})$/;
const ID = /^[\w-]{1,64}$/;
const MEDIA_ID = /^(sha256-[0-9a-f]{64}|[\w-]{1,80})$/;

/** JSON equality that ignores key order. */
export function same(/** @type {any} */ a, /** @type {any} */ b) { return stable(a) === stable(b); }
function stable(/** @type {any} */ v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const clone = (/** @type {any} */ v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---------- validation of remote data ---------- */
const str = (/** @type {any} */ v, /** @type {number} */ max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (/** @type {any} */ v, lo = -1e12, hi = 1e12) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const bool = (/** @type {any} */ v) => (typeof v === 'boolean' ? v : undefined);
/** an unknown key: kept only if it's a plain value */
const prim = (/** @type {any} */ v) => (v === null || typeof v === 'boolean' ? v : typeof v === 'number' ? num(v) : str(v, LIMITS.other));
const media = (/** @type {any} */ v) => (typeof v === 'string' && MEDIA_ID.test(v) ? v : '');

/** @type {Record<string, (v: any) => any>} */
const SHOT_FIELDS = {
  start: v => num(v, 0, 86400), title: v => str(v, LIMITS.line), shot: v => str(v, LIMITS.line),
  notes: v => str(v, LIMITS.text), imgPrompt: v => str(v, LIMITS.text), vidPrompt: v => str(v, LIMITS.text),
  endPrompt: v => str(v, LIMITS.text), endChange: v => str(v, LIMITS.text),
  img: media, key: media, endKey: media, kind: v => (v === '' || v === 'image' || v === 'video' ? v : undefined),
  clipDur: v => num(v, 0, 86400), keyOff: bool, bDur: v => num(v, 0, 3600), frameCost: v => num(v, 0, 1e6),
};
/** @type {Record<string, (v: any) => any>} */
const TAKE_FIELDS = {
  jobId: v => str(v, LIMITS.line), model: v => str(v, LIMITS.line), modelName: v => str(v, LIMITS.line), res: v => str(v, 32),
  dur: v => num(v, 0, 3600), audio: bool, seed: v => (typeof v === 'number' ? num(v) : str(v, 32)), prompt: v => str(v, LIMITS.text),
  start: bool, end: bool, est: v => (v === null ? null : num(v, 0, 1e6)), cost: v => (v === null ? null : num(v, 0, 1e6)),
  status: v => str(v, 32), created: v => num(v, 0), done: v => num(v, 0), error: v => str(v, LIMITS.other), note: v => str(v, LIMITS.other),
  media, clipDur: v => num(v, 0, 86400), dev: v => str(v, LIMITS.id),
};
/** @param {any} o @param {Record<string, (v: any) => any>} fields */
function pick(o, fields) {
  /** @type {any} */ const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'id' || k === 'takes' || k === '__proto__') continue;
    const x = fields[k] ? fields[k](v) : prim(v);
    if (x !== undefined) out[k] = x;
  }
  return out;
}
function sanitizeTake(/** @type {any} */ t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id)) return null;
  return { id: t.id, ...pick(t, TAKE_FIELDS) };
}
function sanitizeShot(/** @type {any} */ s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID.test(s.id)) return null;
  const o = { id: s.id, start: 0, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', ...pick(s, SHOT_FIELDS) };
  /** @type {Set<string>} */ const seen = new Set();
  o.takes = (Array.isArray(s.takes) ? s.takes.slice(0, LIMITS.takes) : []).map(sanitizeTake).filter(t => t && !seen.has(t.id) && seen.add(t.id));
  if (!o.img) { o.kind = ''; o.clipDur = 0; }
  return o;
}
function sanitizeSong(/** @type {any} */ s) {
  if (!s || typeof s !== 'object') return null;
  /** @type {any} */ const o = pick(s, { name: v => str(v, LIMITS.line), duration: v => num(v, 0, 86400), bpm: v => num(v, 0, 1000), peaks: () => undefined });
  o.name = o.name || '';
  o.peaks = Array.isArray(s.peaks) ? s.peaks.slice(0, LIMITS.peaks).map((/** @type {any} */ p) => num(p, 0, 1) ?? 0) : [];
  return o;
}
/** A project as the app keeps it, from data nobody here wrote. Returns null if it isn't one. Never throws. */
export function sanitizeProject(/** @type {any} */ p) {
  try {
    if (!p || typeof p !== 'object' || !Array.isArray(p.sections)) return null;
    /** @type {any} */ const o = {};
    for (const [k, v] of Object.entries(p)) if (!META_SKIP.has(k) && k !== '__proto__') { const x = k === 'title' ? str(v, LIMITS.line) : prim(v); if (x !== undefined) o[k] = x; }
    o.title = o.title || 'Untitled project';
    o.song = sanitizeSong(p.song);
    if (Array.isArray(p.refs)) o.refs = p.refs.slice(0, LIMITS.refs).map(media).filter(Boolean);
    /** @type {Set<string>} */ const seen = new Set();
    o.sections = p.sections.slice(0, LIMITS.shots).map(sanitizeShot).filter((/** @type {any} */ s) => s && !seen.has(s.id) && seen.add(s.id));
    o.sections.sort((/** @type {any} */ a, /** @type {any} */ b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    return o;
  } catch { return null; }
}

/** A display name from someone else's awareness state, or ''. */
const invisible = (/** @type {number} */ c) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
export const sanitizeName = (/** @type {any} */ v) => (typeof v === 'string' ? [...v].filter(ch => !invisible(/** @type {number} */ (ch.codePointAt(0)))).join('').trim().slice(0, LIMITS.name) : '');
export const initials = (/** @type {string} */ name) => {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w.length > 1 ? [...w[0]][0] + [...w[w.length - 1]][0] : [...(w[0] || '?')].slice(0, 2).join('')) || '?').toUpperCase();
};

/* ---------- doc -> app ---------- */
/**
 * The doc as an app project (sanitized), plus what the doc says about media and the song file.
 * @param {Y.Doc} doc
 * @param {(sha256: string) => string | undefined} localId the id this device stores a file under, if it has it
 * @returns {{ project: any, refs: Map<string, { sha256: string, bytes: number, mime: string }>, songFile: any } | null}
 */
export function docToProject(doc, localId = () => undefined) {
  try {
    const data = docToCueboard(doc, { exportedAt: '' });
    /** @type {Map<string, { sha256: string, bytes: number, mime: string }>} */ const refs = new Map();
    for (const m of Object.values(data.media)) {
      if (m && typeof m.sha256 === 'string' && HEX.test(m.sha256)) refs.set(m.sha256, { sha256: m.sha256, bytes: num(m.bytes, 0) ?? 0, mime: str(m.type, 100) || '' });
    }
    const re = (/** @type {any} */ id) => { const m = typeof id === 'string' && SHA_ID.exec(id); return m ? localId(m[1]) || id : ''; };
    const p = data.project;
    if (!p || !Array.isArray(p.sections)) return null;
    if (Array.isArray(p.refs)) p.refs = p.refs.map(re);
    for (const s of p.sections) {
      if (!s || typeof s !== 'object') continue;
      for (const k of SHOT_MEDIA_FIELDS) if (k in s) s[k] = re(s[k]);
      if (Array.isArray(s.takes)) for (const t of s.takes) if (t && typeof t === 'object' && 'media' in t) t.media = re(t.media);
    }
    const project = sanitizeProject(p);
    if (!project) return null;
    const sf = data.song && typeof data.song.sha256 === 'string' && HEX.test(data.song.sha256) ? { sha256: data.song.sha256, mime: str(data.song.type, 100) || '', bytes: num(data.song.bytes, 0) ?? 0, name: str(data.song.name, LIMITS.line) || '' } : null;
    return { project, refs, songFile: sf };
  } catch { return null; }
}

/** A room nobody has worked in yet: at most the one blank shot `create-project` starts with, no song, no references. */
export function isEmptyRoom(/** @type {Y.Doc} */ doc) {
  const r = docToProject(doc);
  if (!r) return false;
  const p = r.project, s = p.sections;
  return !p.song && !(p.refs && p.refs.length) && s.length <= 1 &&
    s.every((/** @type {any} */ x) => !x.takes.length && !x.img && !x.key && !x.endKey && ![...TEXT_FIELDS, 'shot'].some(k => x[k]));
}

/* ---------- app -> doc ---------- */
/** Apply the edit that turned `from` into `to` to a Y.Text that may have moved on since (someone else typed). */
function editText(/** @type {Y.Text} */ yt, /** @type {string} */ from, /** @type {string} */ to) {
  if (yt.toString() === from) { setText(yt, to); return; }
  let a = 0; while (a < from.length && a < to.length && from[a] === to[a]) a++;
  let b = 0; while (b < from.length - a && b < to.length - a && from[from.length - 1 - b] === to[to.length - 1 - b]) b++;
  const at = Math.min(a, yt.length), del = Math.min(from.length - a - b, yt.length - at), ins = to.slice(a, to.length - b);
  if (del > 0) yt.delete(at, del);
  if (ins) yt.insert(at, ins);
}
/** @param {Y.Map<any>} m @param {string} k @param {any} v */
function put(m, k, v) {
  if (v === undefined) { if (m.has(k)) m.delete(k); }
  else if (!same(m.get(k), v)) m.set(k, clone(v));
}

/**
 * Write the changes from `base` to `cur` into the doc. Returns the new base: `cur`, except for fields that couldn't be
 * written yet (a media file whose hash isn't known), which keep their old base value so the next push retries them.
 * @param {Y.Doc} doc
 * @param {any} base the project as the doc had it, or null to write everything
 * @param {any} cur the app's project
 * @param {{ refOf: (id: string) => any, songRef: (song: any) => any, origin?: any }} o
 *   refOf: media id -> MediaRef, or undefined if its hash isn't known yet
 */
export function pushProject(doc, base, cur, { refOf, songRef, origin = null }) {
  const next = base ? clone(base) : { sections: [] };
  const ref = (/** @type {string} */ id) => (id ? refOf(id) : null);
  doc.transact(() => {
    const meta = metaMap(doc);
    let changed = false;
    if (!meta.has('schema')) meta.set('schema', SCHEMA_VERSION);
    for (const k of new Set([...Object.keys(cur), ...Object.keys(base || {})])) {
      if (META_SKIP.has(k) || same(cur[k], base ? base[k] : undefined)) continue;
      put(meta, k, cur[k]); next[k] = clone(cur[k]); changed = true;
    }
    if (!base || !same(cur.song, base.song)) {
      const sr = cur.song ? songRef(cur.song) : null;   // undefined: the song file is still being hashed, retried later
      if (sr !== undefined) { put(meta, 'song', sr); next.song = clone(cur.song ?? null); changed = true; }
    }
    if ((!base && cur.refs) || (base && !same(cur.refs, base.refs))) {
      const rs = (cur.refs || []).map(ref);
      if (!rs.includes(undefined)) {
        const ra = refsArray(doc);
        if (!same(ra.toArray(), rs)) { ra.delete(0, ra.length); ra.push(rs.filter(Boolean)); }
        meta.set('hasRefs', true); next.refs = clone(cur.refs); changed = true;
      }
    }

    const shots = shotsMap(doc);
    const baseShots = new Map((base ? base.sections : []).map((/** @type {any} */ s) => [s.id, s]));
    const curIds = new Set(cur.sections.map((/** @type {any} */ s) => s.id));
    for (const id of baseShots.keys()) if (!curIds.has(id)) { if (shots.has(id)) shots.delete(id); changed = true; }
    /** @type {any[]} */ const nextShots = [];
    for (const s of cur.sections) {
      const b = baseShots.get(s.id);
      let ys = shots.get(s.id);
      if (!(ys instanceof Y.Map)) {
        if (b) continue;                      // deleted by someone else while it was edited here: their delete stands
        ys = new Y.Map(); shots.set(s.id, ys); ys.set('id', s.id); changed = true;
      }
      if (b && same(s, b)) { nextShots.push(b); continue; }
      /** @type {any} */ const n = b ? { ...b } : { id: s.id };
      for (const k of new Set([...Object.keys(s), ...Object.keys(b || {})])) {
        if (k === 'id' || k === 'takes' || same(s[k], b ? b[k] : undefined)) continue;
        const v = s[k];
        if (TEXT_FIELDS.includes(k) && typeof v === 'string') {
          const yt = ys.get(k);
          if (yt instanceof Y.Text) editText(yt, b && typeof b[k] === 'string' ? b[k] : yt.toString(), v);
          else ys.set(k, new Y.Text(v));
        } else if (SHOT_MEDIA_FIELDS.includes(k)) {
          const r = ref(v);
          if (r === undefined) continue;      // hash not known yet: retried on the next push
          put(ys, k, r);
        } else put(ys, k, v);
        if (v === undefined) delete n[k]; else n[k] = clone(v);
        changed = true;
      }
      n.takes = pushTakes(ys, b ? b.takes || [] : [], s.takes || [], ref);
      if (!same(n.takes, b ? b.takes : undefined)) changed = true;
      nextShots.push(n);
    }
    next.sections = nextShots;
    if (changed) meta.set('updated', Date.now());
  }, origin);
  return next;
}

/** Takes: matched by id, newest first. Returns what the doc now holds for them (as app takes). */
function pushTakes(/** @type {Y.Map<any>} */ ys, /** @type {any[]} */ from, /** @type {any[]} */ to, /** @type {(id: string) => any} */ ref) {
  if (same(from, to) && ys.get('takes') instanceof Y.Array) return clone(to);
  let ya = ys.get('takes');
  if (!(ya instanceof Y.Array)) { ya = new Y.Array(); ys.set('takes', ya); }
  const idx = (/** @type {string} */ id) => ya.toArray().findIndex((/** @type {any} */ t) => t instanceof Y.Map && t.get('id') === id);
  const keep = new Set(to.map(t => t.id)), fromById = new Map(from.map(t => [t.id, t]));
  for (const t of from) if (!keep.has(t.id)) { const i = idx(t.id); if (i >= 0) ya.delete(i, 1); }
  /** @type {any[]} */ const out = [];
  to.forEach((t, pos) => {
    const b = fromById.get(t.id), n = b ? { ...b } : { id: t.id };
    let ym = /** @type {Y.Map<any> | undefined} */ (ya.get(idx(t.id)));
    if (!ym) {
      if (b) return;                          // removed by someone else meanwhile
      ym = new Y.Map(); ym.set('id', t.id); ya.insert(Math.min(pos, ya.length), [ym]);
    }
    for (const k of new Set([...Object.keys(t), ...Object.keys(b || {})])) {
      if (k === 'id' || k === 'useInCut' || same(t[k], b ? b[k] : undefined)) continue;
      if (k === 'media') { const r = ref(t[k]); if (r === undefined) { n.media = b ? b.media : ''; continue; } put(ym, k, r); }
      else put(ym, k, t[k]);
      if (t[k] === undefined) delete n[k]; else n[k] = clone(t[k]);
    }
    out.push(n);
  });
  return out;
}

/** Drop every shot and reference from the doc (before sharing a project into an empty room). */
export function clearShots(/** @type {Y.Doc} */ doc, origin = null) {
  doc.transact(() => {
    const shots = shotsMap(doc);
    for (const k of [...shots.keys()]) shots.delete(k);
    const ra = refsArray(doc); if (ra.length) ra.delete(0, ra.length);
  }, origin);
}
