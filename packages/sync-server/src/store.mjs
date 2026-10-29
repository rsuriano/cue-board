// @ts-check
/* On-disk layout, one folder per project under DATA_DIR:
     <id>/project.json   { id, name, created, tokens: [{ sha256, created }], owner?: { sha256, created, code? } }
                         invite tokens and the owner token are stored hashed only. `owner` is absent on rooms made by the
                         CLI before owners existed (legacy rooms): they join and sync as before, nobody can manage them
                         until the CLI attaches an owner (bin/attach-owner.mjs). `code` is the label of the verification
                         code the creator redeemed (access.mjs), for the operator; never shown to members.
     <id>/updates.bin    Yjs updates, each framed as uint32 LE length + bytes; compaction rewrites it as one update
   Two files at the top of DATA_DIR belong to access.mjs (codes.json, verified.json); they can't collide with a room
   folder, since room ids are directories.
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

  /** Create a project folder, seeded with `doc`'s state. Returns the room id and a first invite token; with
      `owner: true` also an owner token (the creator's, see setOwner). `code` is the redeemed code's label, kept for the operator. */
  createProject(/** @type {string} */ name, /** @type {Y.Doc} */ doc, /** @type {{ owner?: boolean, code?: string }} */ o = {}) {
    const id = randomBytes(12).toString('base64url');
    fs.mkdirSync(this.folder(id));
    this.#writeProject(id, { id, name, created: new Date().toISOString(), tokens: [] });
    this.compact(id, doc);
    const token = this.addToken(id);
    return o.owner ? { id, token, ownerToken: this.setOwner(id, o.code) } : { id, token };
  }

  /** New random 128-bit invite token for a project; only its hash is kept. */
  addToken(/** @type {string} */ id) {
    const token = randomBytes(16).toString('base64url'), p = this.readProject(id);
    p.tokens.push({ sha256: hashToken(token).toString('hex'), created: new Date().toISOString() });
    this.#writeProject(id, p);
    return token;
  }

  /** Replace every invite token with one new one: every old link stops working at the next join. */
  replaceTokens(/** @type {string} */ id) {
    const token = randomBytes(16).toString('base64url'), p = this.readProject(id);
    p.tokens = [{ sha256: hashToken(token).toString('hex'), created: new Date().toISOString() }];
    this.#writeProject(id, p);
    return token;
  }

  /** Give the room an owner: a new random 256-bit owner token (hash kept), replacing any previous one. */
  setOwner(/** @type {string} */ id, /** @type {string} */ code = '') {
    const token = randomBytes(32).toString('base64url'), p = this.readProject(id);
    p.owner = { sha256: hashToken(token).toString('hex'), created: new Date().toISOString(), ...(code ? { code } : {}) };
    this.#writeProject(id, p);
    return token;
  }

  /** @param {string} id */
  hasOwner(id) { return this.exists(id) && typeof this.readProject(id).owner?.sha256 === 'string'; }

  /** Read on every owner action, so an owner removed from project.json loses control without a restart. */
  checkOwner(/** @type {string} */ id, /** @type {string} */ token) {
    if (!token || token.length > 128 || !this.exists(id)) return false;
    const o = this.readProject(id).owner;
    return !!o && typeof o.sha256 === 'string' && SHA256_HEX.test(o.sha256) && timingSafeEqual(Buffer.from(o.sha256, 'hex'), hashToken(token));
  }

  /** Wipe a room from disk. The folder is renamed first, so a crash mid-delete can't leave a half room that still joins. */
  deleteProject(/** @type {string} */ id) {
    const dir = this.folder(id), gone = `${dir}.deleting`;
    if (!fs.existsSync(dir)) return false;
    fs.renameSync(dir, gone);
    fs.rmSync(gone, { recursive: true, force: true });
    return true;
  }

  /** Rooms on disk (folders with a project.json). */
  count() {
    let n = 0;
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) if (e.isDirectory() && ROOM_ID.test(e.name) && fs.existsSync(path.join(this.dir, e.name, 'project.json'))) n++;
    return n;
  }

  /** Size of a room's update log on disk (0 when there is none yet). */
  logBytes(/** @type {string} */ id) {
    try { return fs.statSync(path.join(this.folder(id), 'updates.bin')).size; } catch { return 0; }
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
