// @ts-check
/* On-disk layout, one folder per project under DATA_DIR:
     <id>/project.json   { id, name, created, tokens: [{ sha256, created }] }   invite tokens are stored hashed only
     <id>/updates.bin    Yjs updates, each framed as uint32 LE length + bytes; compaction rewrites it as one update
   All writes are synchronous: an update is on disk (in the OS page cache) before the server reacts to it. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as Y from 'yjs';

export const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
/* A header claiming more than this is corruption, not a torn append (appends are bounded by maxMessageBytes) */
const MAX_RECORD_BYTES = 256 * 1024 * 1024;
const hashToken = (/** @type {string} */ t) => createHash('sha256').update(t).digest();

/** updates.bin can't be read safely. The file is left as it is for an operator to inspect. */
export class CorruptLogError extends Error {}

export class ProjectStore {
  #warnedHash = new Set();
  /** @param {string} dir @param {{ warn: (msg: string, fields?: object) => void }} [log] */
  constructor(dir, log = { warn: () => {} }) { this.dir = path.resolve(dir); this.log = log; fs.mkdirSync(this.dir, { recursive: true }); }

  /** @param {string} id */
  folder(id) { if (!ROOM_ID.test(id)) throw new Error('bad room id'); return path.join(this.dir, id); }

  /** @param {string} id */
  exists(id) { return ROOM_ID.test(id) && fs.existsSync(path.join(this.dir, id, 'project.json')); }

  /** @param {string} id */
  readProject(id) { return JSON.parse(fs.readFileSync(path.join(this.folder(id), 'project.json'), 'utf8')); }

  /** Create a project folder, seeded with `doc`'s state. Returns the room id and a first invite token. */
  createProject(/** @type {string} */ name, /** @type {Y.Doc} */ doc) {
    const id = randomBytes(12).toString('base64url');
    fs.mkdirSync(this.folder(id));
    this.#writeProject(id, { id, name, created: new Date().toISOString(), tokens: [] });
    this.compact(id, doc);
    return { id, token: this.addToken(id) };
  }

  /** New random 128-bit invite token for a project; only its hash is kept. */
  addToken(/** @type {string} */ id) {
    const token = randomBytes(16).toString('base64url'), p = this.readProject(id);
    p.tokens.push({ sha256: hashToken(token).toString('hex'), created: new Date().toISOString() });
    this.#writeProject(id, p);
    return token;
  }

  /** Read on every join, so removing a token from project.json revokes it without a restart. */
  checkToken(/** @type {string} */ id, /** @type {string} */ token) {
    if (!token || token.length > 64 || !this.exists(id)) return false;
    const h = hashToken(token), tokens = this.readProject(id).tokens;
    // a hand-edited hash that isn't 64 hex chars never matches (and must not throw in timingSafeEqual)
    return Array.isArray(tokens) && tokens.some((/** @type {any} */ t) => {
      if (typeof t?.sha256 === 'string' && SHA256_HEX.test(t.sha256)) return timingSafeEqual(Buffer.from(t.sha256, 'hex'), h);
      if (!this.#warnedHash.has(id)) { this.#warnedHash.add(id); this.log.warn('ignoring malformed token hash in project.json', { room: id }); }
      return false;
    });
  }

  /** Load a project's doc. A torn last record (crash mid-append) is copied aside to updates.bin.torn-<time>, then cut off.
      Anything else unreadable throws CorruptLogError and leaves the file untouched, so no later record is ever dropped. */
  loadDoc(/** @type {string} */ id) {
    const file = path.join(this.folder(id), 'updates.bin'), doc = new Y.Doc();
    const buf = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    const updates = [];
    let off = 0;
    while (off + 4 <= buf.length) {
      const len = buf.readUInt32LE(off);
      if (off + 4 + len > buf.length) break;
      updates.push(buf.subarray(off + 4, off + 4 + len)); off += 4 + len;
    }
    // what's left can only be a torn append if it's a partial header, or a header whose record runs past the end
    const torn = buf.length - off;
    if (torn >= 4 && buf.readUInt32LE(off) > MAX_RECORD_BYTES) {
      doc.destroy();
      throw new CorruptLogError(`bad record length at byte ${off} of ${buf.length}`);
    }
    try {
      if (updates.length) Y.applyUpdate(doc, Y.mergeUpdates(updates));
    } catch (err) {
      doc.destroy();
      throw new CorruptLogError(`undecodable update log (${updates.length} records, ${off} bytes): ${/** @type {Error} */ (err).message}`);
    }
    if (torn) {
      fs.copyFileSync(file, `${file}.torn-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.truncateSync(file, off);
    }
    return { doc, records: updates.length, bytes: off, torn };
  }

  append(/** @type {string} */ id, /** @type {Uint8Array} */ update) {
    const head = Buffer.alloc(4); head.writeUInt32LE(update.length);
    fs.appendFileSync(path.join(this.folder(id), 'updates.bin'), Buffer.concat([head, update]));
  }

  /** Replace the log with one update holding the whole state: written to a temp file, fsynced, then renamed over. */
  compact(/** @type {string} */ id, /** @type {Y.Doc} */ doc) {
    const file = path.join(this.folder(id), 'updates.bin'), tmp = file + '.tmp';
    const update = Y.encodeStateAsUpdate(doc), head = Buffer.alloc(4); head.writeUInt32LE(update.length);
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, Buffer.concat([head, update])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return update.length + 4;
  }

  #writeProject(/** @type {string} */ id, /** @type {any} */ p) {
    const file = path.join(this.folder(id), 'project.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(p, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
}
