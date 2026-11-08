// @ts-check
/* Invite codes (moved from the sync server's access.mjs): the owner hands one to a person or a group; with an email it
   opens a session, as a purchase does. DATA_DIR/codes.json, mode 0600, written whole (tmp + rename) by the CLI only:
     { codes: [{ id, label, sha256, created, maxUsers: number | null, revoked: iso | null }] }
   the same file the sync server used, so an old codes.json can be copied over as it is. The server reads it on every use,
   so a code made or revoked while it runs counts at once. Codes are 96 random bits, stored hashed, compared in constant
   time and never logged. Revoking a code ends every session it opened at that session's next daily check. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const hash = (/** @type {string} */ t) => createHash('sha256').update(t).digest();

export class CodeStore {
  /** @param {string} dir DATA_DIR */
  constructor(dir) { this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true }); }
  get file() { return path.join(this.dir, 'codes.json'); }

  /** @returns {any[]} */
  read() {
    try { const v = JSON.parse(fs.readFileSync(this.file, 'utf8')); return v && Array.isArray(v.codes) ? v.codes : []; }
    catch (err) { if (/** @type {any} */ (err).code === 'ENOENT') return []; throw err; }
  }
  write(/** @type {any[]} */ codes) {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ codes }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  /** CLI: a new code, returned once in clear; only its hash is kept. @param {{ label: string, maxUsers?: number | null }} o */
  createCode({ label, maxUsers = null }) {
    label = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    if (!label) throw new Error('a code needs a label');
    if (maxUsers != null && !(Number.isInteger(maxUsers) && maxUsers > 0)) throw new Error('--max-users must be a whole number above 0');
    const code = randomBytes(12).toString('base64url'), id = 'c-' + randomBytes(4).toString('hex'), codes = this.read();
    codes.push({ id, label, sha256: hash(code).toString('hex'), created: new Date().toISOString(), maxUsers, revoked: null });
    this.write(codes);
    return { id, label, code, maxUsers };
  }

  /** CLI: revoke a code (its sessions end at their next daily check). */
  revokeCode(/** @type {string} */ id) {
    const codes = this.read(), c = codes.find(x => x && x.id === id);
    if (!c) return false;
    if (!c.revoked) { c.revoked = new Date().toISOString(); this.write(codes); }
    return true;
  }

  /** the entry for a code in clear, compared against every entry in constant time */
  find(/** @type {string} */ code) {
    if (typeof code !== 'string' || !code || code.length > 128) return null;
    const h = hash(code); /** @type {any} */ let found = null;
    for (const e of this.read()) if (e && typeof e.sha256 === 'string' && SHA256_HEX.test(e.sha256) && timingSafeEqual(Buffer.from(e.sha256, 'hex'), h) && !found) found = e;
    return found;
  }

  /** a code that exists and isn't revoked, by id */
  standing(/** @type {string} */ id) { const c = this.read().find(x => x && x.id === id); return c && !c.revoked ? c : null; }
}

/** Failures per key (an IP): after `max` within the window the key is blocked for `blockMs`. A success clears it. */
export function createFailureLimiter({ max = 5, blockMs = 15 * 60_000, now = Date.now } = {}) {
  /** @type {Map<string, { fails: number, first: number, until: number }>} */ const m = new Map();
  const prune = () => { const t = now(); if (m.size > 1000) for (const [k, e] of m) if (e.until < t && t - e.first > blockMs) m.delete(k); };
  return {
    /** ms left on a block, or 0 */
    blocked(/** @type {string} */ key) { const e = m.get(key); return e && e.until > now() ? e.until - now() : 0; },
    fail(/** @type {string} */ key) {
      prune();
      const t = now(), e = m.get(key) || { fails: 0, first: t, until: 0 };
      if (t - e.first > blockMs && e.until <= t) { e.fails = 0; e.first = t; }
      e.fails++; if (e.fails >= max) e.until = t + blockMs;
      m.set(key, e);
      return e.until > t;
    },
    ok(/** @type {string} */ key) { m.delete(key); },
    size: () => m.size,
  };
}

/** Events per key in a sliding window: `take(key)` is false once `max` happened within `windowMs`. */
export function createBurstLimiter({ max = 5, windowMs = 3600_000, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} */ const m = new Map();
  const live = (/** @type {string} */ key) => (m.get(key) || []).filter(x => now() - x < windowMs);
  return {
    /** true when `key` has no room left in the window (nothing is taken) */
    full: (/** @type {string} */ key) => live(key).length >= max,
    take(/** @type {string} */ key) {
      if (m.size > 1000) for (const [k] of m) if (!live(k).length) m.delete(k);
      const l = live(key);
      if (l.length >= max) return false;
      l.push(now()); m.set(key, l); return true;
    },
    /** give back the last take (what it counted didn't happen) */
    untake(/** @type {string} */ key) { m.get(key)?.pop(); },
  };
}
