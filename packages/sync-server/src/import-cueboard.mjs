// @ts-check
/* .cueboard.json (index.html's export format, version 1) <-> Y.Doc.

   Lossless for everything but the media payloads: every project/section/take key is kept, unknown keys included,
   and each media id becomes a content ref { sha256, bytes, mime }. Payloads are returned on the side
   (cueboardToDoc → media) and only go back into a file if the caller hands them to docToCueboard.
   Media ids come back as "sha256-<hex>" (the app re-ids media on import anyway). */
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { SCHEMA_VERSION, TEXT_FIELDS, SHOT_MEDIA_FIELDS, metaMap, refsArray, shotsMap, orderedShots } from './schema.mjs';

const PROJECT_KEYS = new Set(['song', 'refs', 'sections']);
const SONG_FILE_KEYS = ['sha256', 'mime', 'bytes', 'fileName'];

/** @param {string} dataURL */
function decodeDataURL(dataURL) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataURL || '');
  if (!m) throw new Error('not a data URL');
  return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
}
const sha256 = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');
export const mediaId = (/** @type {string} */ hash) => `sha256-${hash}`;

/**
 * @param {any} data parsed .cueboard.json
 * @param {Y.Doc} [doc] an empty doc to fill
 * @returns {{ doc: Y.Doc, media: Map<string, { mime: string, data: Buffer }>, dropped: string[] }}
 */
export function cueboardToDoc(data, doc = new Y.Doc()) {
  if (!data || data.format !== 'cueboard' || !data.project || !Array.isArray(data.project.sections)) throw new Error('not a Cue Board export');
  if (data.version !== 1) throw new Error(`unsupported export version ${data.version}`);
  /** @type {Map<string, { mime: string, data: Buffer }>} */ const media = new Map();
  /** @type {Map<string, any>} */ const byOldId = new Map();
  for (const [id, m] of Object.entries(data.media || {})) {
    const buf = decodeDataURL(m.data), hash = sha256(buf);
    media.set(hash, { mime: m.type || '', data: buf });
    byOldId.set(id, { sha256: hash, bytes: buf.length, mime: m.type || '' });
  }
  /** @type {string[]} */ const dropped = [];
  // same rule as the app's import: an id without a payload is dropped
  const ref = (/** @type {string} */ id) => { if (!id) return null; const r = byOldId.get(id); if (!r) dropped.push(id); return r ? { ...r } : null; };
  const p = data.project;

  doc.transact(() => {
    const meta = metaMap(doc);
    meta.set('schema', SCHEMA_VERSION);
    for (const [k, v] of Object.entries(p)) if (!PROJECT_KEYS.has(k)) meta.set(k, v);
    let song = p.song === undefined ? undefined : p.song && { ...p.song };
    if (data.song && data.song.data) {
      const buf = decodeDataURL(data.song.data), hash = sha256(buf);
      media.set(hash, { mime: data.song.type || '', data: buf });
      song = { ...(song || {}), sha256: hash, mime: data.song.type || '', bytes: buf.length };
      if (data.song.name !== (p.song && p.song.name)) song.fileName = data.song.name;
    }
    if (song !== undefined) meta.set('song', song);
    if (p.refs !== undefined) { meta.set('hasRefs', true); refsArray(doc).push(p.refs.map(ref).filter(Boolean)); }

    const shots = shotsMap(doc);
    for (const s of p.sections) {
      const ys = new Y.Map();
      shots.set(s.id, ys);
      for (const [k, v] of Object.entries(s)) {
        if (k === 'takes') {
          const yt = new Y.Array();
          ys.set('takes', yt);
          yt.push((v || []).map((/** @type {any} */ t) => {
            const m = new Y.Map();
            for (const [tk, tv] of Object.entries(t)) m.set(tk, tk === 'media' ? ref(tv) : tv);
            return m;
          }));
        } else if (TEXT_FIELDS.includes(k) && typeof v === 'string') ys.set(k, new Y.Text(v));
        else if (SHOT_MEDIA_FIELDS.includes(k)) ys.set(k, ref(v));
        else ys.set(k, v);
      }
    }
  });
  return { doc, media, dropped };
}

/**
 * @param {Y.Doc} doc
 * @param {{ media?: Map<string, { mime: string, data: Buffer }>, exportedAt?: string }} [opts] payloads to embed, if you have them
 */
export function docToCueboard(doc, opts = {}) {
  const payloads = opts.media || new Map();
  /** @type {Record<string, any>} */ const media = {};
  const out = (/** @type {any} */ r) => {
    if (!r) return '';
    const id = mediaId(r.sha256), pl = payloads.get(r.sha256);
    media[id] = { type: r.mime, sha256: r.sha256, bytes: r.bytes };
    if (pl) media[id].data = `data:${pl.mime};base64,${pl.data.toString('base64')}`;
    return id;
  };
  /** @type {any} */ const project = {};
  let song = null;
  for (const [k, v] of metaMap(doc).entries()) {
    if (k === 'schema' || k === 'hasRefs') continue;
    if (k === 'song' && v && v.sha256) {
      const s = { ...v };
      song = { name: s.fileName ?? s.name, type: s.mime, sha256: s.sha256, bytes: s.bytes };
      const pl = payloads.get(s.sha256);
      if (pl) song.data = `data:${pl.mime};base64,${pl.data.toString('base64')}`;
      for (const f of SONG_FILE_KEYS) delete s[f];
      project.song = s;
    } else project[k] = v;
  }
  if (metaMap(doc).get('hasRefs')) project.refs = refsArray(doc).toArray().map(out);
  project.sections = orderedShots(doc).map(ys => {
    /** @type {any} */ const s = {};
    for (const [k, v] of ys.entries()) {
      if (k === 'takes') s.takes = v.toArray().map((/** @type {Y.Map<any>} */ t) => {
        /** @type {any} */ const o = {};
        for (const [tk, tv] of t.entries()) o[tk] = tk === 'media' ? out(tv) : tv;
        return o;
      });
      else if (v instanceof Y.Text) s[k] = v.toString();
      else if (SHOT_MEDIA_FIELDS.includes(k)) s[k] = out(v);
      else s[k] = v;
    }
    return s;
  });
  return { format: 'cueboard', version: 1, exportedAt: opts.exportedAt ?? new Date().toISOString(), project, media, song };
}

/** What a lossless round trip without payloads must give back: media ids renamed to their hashes, payloads replaced by
    { type, sha256, bytes }. Used by the tests; also handy to diff two exports. */
export function withoutPayloads(/** @type {any} */ data) {
  const d = structuredClone(data), rename = new Map(), media = {};
  for (const [id, m] of Object.entries(d.media || {})) {
    const buf = decodeDataURL(m.data), hash = sha256(buf);
    rename.set(id, mediaId(hash));
    /** @type {any} */ (media)[mediaId(hash)] = { type: m.type || '', sha256: hash, bytes: buf.length };
  }
  const re = (/** @type {string} */ id) => (id && rename.get(id)) || '';
  const p = d.project;
  if (p.refs) p.refs = p.refs.map(re).filter(Boolean);
  for (const s of p.sections) {
    for (const k of SHOT_MEDIA_FIELDS) if (k in s) s[k] = re(s[k]);
    for (const t of s.takes || []) if ('media' in t) t.media = re(t.media);
  }
  d.media = media;
  if (d.song && d.song.data) {
    const buf = decodeDataURL(d.song.data);
    d.song = { name: d.song.name, type: d.song.type || '', sha256: sha256(buf), bytes: buf.length };
  } else d.song = null;
  delete d.exportedAt;
  return d;
}

/** Load window.CUEBOARD_EXAMPLE out of example/example.js without running it. */
export function parseExampleJS(/** @type {string} */ src) {
  return JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
}
