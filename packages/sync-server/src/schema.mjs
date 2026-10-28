// @ts-check
/* Y.Doc schema for one cue board (one project = one room = one Y.Doc). See docs/data-model.md.

   doc.getMap('meta')    schema, id, title, created, updated, song (SongRef | null), plus any unknown project keys
   doc.getArray('refs')  MediaRef[]                    project reference images
   doc.getMap('shots')   shotId -> Y.Map               order is derived: by `start`, then id (a cue board is a timeline)
     shot Y.Map           id, start, shot, kind, clipDur, keyOff, ...   plain values (last writer wins)
                          title, notes, imgPrompt, vidPrompt            Y.Text (character-level merge)
                          img, key, endKey                              MediaRef | null
                          takes                                         Y.Array<Y.Map>, newest first
     take Y.Map           id, model, prompt, status, cost, ...          plain values; media: MediaRef | null

   Media payloads never go in the doc: only content hashes. */
import * as Y from 'yjs';

export const SCHEMA_VERSION = 1;
/** shot fields edited as collaborative text */
export const TEXT_FIELDS = ['title', 'notes', 'imgPrompt', 'vidPrompt'];
/** shot fields that point at a media file */
export const SHOT_MEDIA_FIELDS = ['img', 'key', 'endKey'];

/**
 * @typedef {{ sha256: string, bytes: number, mime: string }} MediaRef
 * @typedef {{ sha256: string | null, name: string, mime?: string, bytes?: number, duration?: number, peaks?: number[], bpm?: number }} SongRef
 * @typedef {{ id: string, model: string, prompt: string, status: string, cost: number | null, media: MediaRef | null, [k: string]: unknown }} Take
 * @typedef {{ id: string, start: number, title: string, notes: string, imgPrompt: string, vidPrompt: string,
 *   img?: MediaRef | null, key?: MediaRef | null, endKey?: MediaRef | null, takes: Take[], [k: string]: unknown }} Shot
 */

export const metaMap = (/** @type {Y.Doc} */ doc) => doc.getMap('meta');
export const refsArray = (/** @type {Y.Doc} */ doc) => /** @type {Y.Array<MediaRef>} */ (doc.getArray('refs'));
export const shotsMap = (/** @type {Y.Doc} */ doc) => /** @type {Y.Map<Y.Map<any>>} */ (doc.getMap('shots'));

const rand = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const newId = (/** @type {string} */ prefix) => `${prefix}-${rand()}`;

/** Fill an empty doc with a new project, like the app's makeProject(): one shot at 0 s. */
export function initProject(/** @type {Y.Doc} */ doc, { id = newId('p'), title = 'Untitled project' } = {}) {
  doc.transact(() => {
    const m = metaMap(doc), now = Date.now();
    m.set('schema', SCHEMA_VERSION); m.set('id', id); m.set('title', title);
    m.set('created', now); m.set('updated', now); m.set('song', null);
    addShot(doc, { start: 0 });
  });
}

/** Add a shot (a cut at `start` seconds). Returns its Y.Map. Missing text fields start empty. */
export function addShot(/** @type {Y.Doc} */ doc, /** @type {Partial<Shot>} */ fields = {}) {
  const s = new Y.Map(), id = fields.id || newId('s');
  doc.transact(() => {
    shotsMap(doc).set(id, s);
    s.set('id', id); s.set('start', fields.start ?? 0);
    for (const k of TEXT_FIELDS) s.set(k, new Y.Text(typeof fields[k] === 'string' ? /** @type {string} */ (fields[k]) : ''));
    s.set('takes', new Y.Array());
  });
  return s;
}

/** Shots in timeline order. Ties on `start` (two people cutting at the same instant) break by id, the same on every peer. */
export function orderedShots(/** @type {Y.Doc} */ doc) {
  return [...shotsMap(doc).values()].sort((a, b) => a.get('start') - b.get('start') || (a.get('id') < b.get('id') ? -1 : 1));
}

/** [start, end) of a shot: it runs until the next cut, the last one until the end of the song. */
export function cutRange(/** @type {Y.Doc} */ doc, /** @type {string} */ shotId) {
  const list = orderedShots(doc), i = list.findIndex(s => s.get('id') === shotId);
  if (i < 0) return null;
  const song = /** @type {SongRef | null} */ (metaMap(doc).get('song'));
  const next = list[i + 1];
  return { start: list[i].get('start'), end: next ? next.get('start') : (song && song.duration) || null };
}

/** Add a take to a shot, newest first (as the app does). Returns its Y.Map. */
export function addTake(/** @type {Y.Map<any>} */ shot, /** @type {Partial<Take>} */ take) {
  const t = new Y.Map();
  for (const [k, v] of Object.entries({ id: newId('t'), status: 'submitting', cost: null, media: null, ...take })) t.set(k, v);
  shot.get('takes').insert(0, [t]);
  return t;
}

/** "Use in cut" is derived, never stored: a take is in the cut when the shot's img is the take's media.
    One register per shot means two people picking different takes at once still leaves exactly one in the cut. */
export function useInCut(/** @type {Y.Map<any>} */ shot, /** @type {Y.Map<any>} */ take) {
  const img = shot.get('img'), m = take.get('media');
  return !!(img && m && img.sha256 === m.sha256);
}
export function setInCut(/** @type {Y.Map<any>} */ shot, /** @type {Y.Map<any>} */ take) {
  shot.doc?.transact(() => {
    shot.set('img', take.get('media')); shot.set('kind', 'video'); shot.set('clipDur', take.get('clipDur') || 0);
  });
}

/** Replace the whole content of a Y.Text with a minimal edit (common prefix/suffix kept), so concurrent typing elsewhere survives. */
export function setText(/** @type {Y.Text} */ ytext, /** @type {string} */ next) {
  const cur = ytext.toString();
  if (cur === next) return;
  let a = 0; while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0; while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  ytext.doc?.transact(() => {
    if (cur.length - a - b) ytext.delete(a, cur.length - a - b);
    if (next.length - a - b) ytext.insert(a, next.slice(a, next.length - b));
  });
}

/** Plain JSON view of a shot (for rendering or tests), with useInCut filled in per take. */
export function shotToJSON(/** @type {Y.Map<any>} */ shot) {
  /** @type {any} */ const o = {};
  for (const [k, v] of shot.entries()) o[k] = v instanceof Y.Text ? v.toString() : v instanceof Y.Array ? v.toArray().map(t => t.toJSON()) : v;
  o.takes = (o.takes || []).map((/** @type {any} */ t, /** @type {number} */ i) => ({ ...t, useInCut: useInCut(shot, shot.get('takes').get(i)) }));
  return o;
}
