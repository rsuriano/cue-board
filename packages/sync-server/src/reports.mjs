// @ts-check
/* Problem reports sent from the app (More → Report a problem; docs/reports.md). Anyone can send one: no token, so
   everything that arrives is treated as hostile. The app builds its report from an allow-list (index.html, the
   `cue-report` script in <head>); this file is the same allow-list on the server: every field is checked and clipped,
   unknown fields are dropped, free text has control characters taken out and URLs, tokens and e-mail addresses
   scrubbed again (the app already did; a report that didn't come from the app gets the same treatment).

   Storage: one file per report, DATA_DIR/reports/<UTC time>-<id>.json, mode 0600, at most `max` (oldest removed).
   File names are built here only, from the time and a random id; the CLIs read them back by matching that pattern,
   never by joining a path with what someone typed. Report contents are never logged. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const REPORT_MAX_BYTES = 16 * 1024;
export const REPORT_ID = /^[a-z0-9]{10}$/;
const FILE = /^(\d{8}T\d{9}Z)-([a-z0-9]{10})\.json$/;
const COLLAB = ['off', 'none', 'synced', 'syncing', 'offline', 'unreachable', 'rejected', 'deleted', 'full'];
const MEDIA = ['here', 'queued', 'downloading', 'skipped', 'failed'];
const MAX_ERRORS = 20, MAX_SHOTS = 1000;

/** Free text made safe to store and to print: no control characters (terminal escapes), no URL queries or fragments,
    no invite fragments, no token-looking strings, no e-mail addresses; clipped to `max`. The app runs the same rules
    (index.html, `scrub` in the cue-report script); test/reports.test.mjs feeds both the same strings.
    Every pattern starts only where a run starts (the lookbehinds), so the work stays linear in the length: a 16 KiB
    body crafted to backtrack costs milliseconds. The input is cut to 4 \u00d7 `max` first for the same reason.
    @param {unknown} v @param {number} max @param {boolean} [lines] keep newlines and tabs */
export function scrub(v, max, lines = false) {
  if (typeof v !== 'string') return '';
  return v.slice(0, max * 4)
    .replace(lines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g : /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s?#'"`<>()]*)[^\s'"`<>()]*/gi, '$1')
    .replace(/#join=[^\s'"`<>()]*/gi, '#join=[removed]')
    .replace(/([?&;]|\b)(token|access_token|key|code|auth|password|secret|room)=[^\s&'"`<>()]*/gi, '$1$2=[removed]')
    .replace(/\bBearer\s+[^\s'"`]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/(?<![^\s@'"`<>()])[^\s@'"`<>()]+@[^\s@'"`<>()]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}/g, w => (/\d|[_-]/.test(w) || (w.match(/[A-Z]/g) || []).length * 4 >= w.length ? '[redacted]' : w))
    .slice(0, max);
}

const int = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : null);
const num = (/** @type {unknown} */ v, /** @type {number} */ max, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * d) / d)) : null);
const bool = (/** @type {unknown} */ v) => (typeof v === 'boolean' ? v : null);
const obj = (/** @type {unknown} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : null);

/** The stored report: only the allow-listed fields, each checked and clipped. Fields that are missing or of the wrong
    type are left out. @param {unknown} input @returns {Record<string, unknown> | null} null when it isn't an object */
export function cleanReport(input) {
  const r = obj(input); if (!r) return null;
  /** @type {Record<string, unknown>} */ const o = { v: 1 };
  const put = (/** @type {string} */ k, /** @type {unknown} */ v) => { if (v !== null && v !== '' && v !== undefined) o[k] = v; };
  put('build', scrub(r.build, 40));
  put('at', typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? new Date(Date.parse(r.at)).toISOString() : null);
  put('text', scrub(r.text, 2000, true).trim());
  const vp = obj(r.viewport);
  if (vp) { const w = int(vp.w, 20000), h = int(vp.h, 20000), dpr = num(vp.dpr, 10, 100); if (w !== null && h !== null) put('viewport', { w, h, dpr: dpr ?? 1 }); }
  put('phone', bool(r.phone));
  put('side', r.side === 'a' || r.side === 'b' ? r.side : null);
  put('ua', scrub(r.ua, 400));
  put('lang', typeof r.lang === 'string' && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,4}$/.test(r.lang) ? r.lang : null);
  put('online', bool(r.online));
  const st = obj(r.storage);
  if (st) put('storage', { persisted: bool(st.persisted), usedMB: num(st.usedMB, 1e9, 10), quotaMB: num(st.quotaMB, 1e9, 10) });
  put('save', scrub(r.save, 80));
  put('collab', typeof r.collab === 'string' && COLLAB.includes(r.collab) ? r.collab : null);
  const md = obj(r.media);
  if (md) { /** @type {Record<string, number>} */ const m = {}; for (const k of MEDIA) { const n = int(md[k], 1e6); if (n !== null) m[k] = n; } if (Object.keys(m).length) put('media', m); }
  if (Array.isArray(r.errors)) {
    const l = r.errors.slice(-MAX_ERRORS).map(obj).filter(e => e).map(e => {
      const x = /** @type {Record<string, unknown>} */ (e), msg = scrub(x.msg, 300), at = scrub(x.at, 120), n = int(x.n, 1e6);
      return msg ? { msg, ...(at ? { at } : {}), ...(n && n > 1 ? { n } : {}) } : null;
    }).filter(e => e);
    if (l.length) put('errors', l);
  }
  const sh = obj(r.shape);
  if (sh) {
    const shots = int(sh.shots, 1e6), lengths = Array.isArray(sh.lengths) ? sh.lengths.slice(0, MAX_SHOTS).map(v => num(v, 1e6, 10) ?? 0) : null;
    const takes = Array.isArray(sh.takes) ? sh.takes.slice(0, MAX_SHOTS).map(v => int(v, 1e6) ?? 0) : null;
    if (shots !== null) put('shape', { shots, ...(lengths ? { lengths } : {}), ...(takes ? { takes } : {}) });
  }
  return o;
}

/** A compact UTC time with milliseconds for file names, sortable as text: 20261030T141522123Z. @param {Date} d */
const stamp = d => d.toISOString().replace(/[-:.]/g, '');
const fromStamp = (/** @type {string} */ s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`);
export class ReportStore {
  /** @param {string} dataDir @param {{ max?: number, now?: () => number }} [o] */
  constructor(dataDir, o = {}) { this.dir = path.join(dataDir, 'reports'); this.max = o.max ?? 500; this.now = o.now || Date.now; this.last = 0; }

  /** Report files, oldest first. @returns {{ name: string, id: string, time: number }[]} */
  files() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.map(n => FILE.exec(n)).filter(m => m).map(m => { const x = /** @type {RegExpExecArray} */ (m); return { name: x[0], id: x[2], time: fromStamp(x[1]) }; }).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Stores a cleaned report; removes the oldest past `max`. @param {Record<string, unknown>} clean @returns {string} the id */
  add(clean) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // two reports in the same millisecond still sort in the order they arrived
    const t = this.now(); this.last = t > this.last ? t : this.last + 1;
    const d = new Date(this.last), id = Array.from(randomBytes(10), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    const body = JSON.stringify({ id, received: d.toISOString(), ...clean }, null, 2) + '\n';
    fs.writeFileSync(path.join(this.dir, `${stamp(d)}-${id}.json`), body, { mode: 0o600, flag: 'wx' });
    const all = this.files();
    for (const f of all.slice(0, Math.max(0, all.length - this.max))) try { fs.unlinkSync(path.join(this.dir, f.name)); } catch { /* already gone */ }
    return id;
  }

  /** @param {string} id @returns {Record<string, any> | null} */
  get(id) {
    if (!REPORT_ID.test(id)) return null;
    const f = this.files().find(x => x.id === id);
    if (!f) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, f.name), 'utf8')); } catch { return null; }
  }

  /** Newest first, with the file read. @returns {Record<string, any>[]} */
  list() {
    return this.files().reverse().map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f.name), 'utf8')); } catch { return { id: f.id, received: new Date(f.time).toISOString(), unreadable: true }; } });
  }

  /** Removes reports received more than `ms` ago. @param {number} ms @returns {number} how many */
  clearOlderThan(ms) {
    const cut = this.now() - ms; let n = 0;
    for (const f of this.files()) if (f.time < cut) { try { fs.unlinkSync(path.join(this.dir, f.name)); n++; } catch { /* already gone */ } }
    return n;
  }
}
