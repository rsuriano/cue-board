// @ts-check
/* Who may create a room. A temporary gate until paid plans exist: the owner hands out verification codes; redeeming
   one gives the browser a long-lived verified token. The one seam the rest of the server uses is canCreateRoom(identity).
   Replacing the gate with plans later means replacing that function (and the redeem endpoint), nothing else.

   Files at the top of DATA_DIR, both mode 0600, written whole (tmp + rename):
     codes.json     { codes: [{ id, label, sha256, created, maxUsers: number | null, revoked: iso | null }] }
                    written by the CLI only (bin/create-code.mjs, bin/revoke-code.mjs); the server reads it on every use,
                    so a code made or revoked while the server runs counts at once, and the two never race on one file
     verified.json  { tokens: [{ sha256, code: <code id>, created }] }
                    written by the server only (a redeem, a paid order); the CLI reads it (list-codes shows how many
                    redeemed each code). A token bought through Lemon Squeezy (webhooks/lemonsqueezy.mjs) has the same
                    shape with code: null, plus source: 'lemonsqueezy', orderId and label; it stands while its entry
                    exists and has no `revoked` (the operator deletes or marks the entry, e.g. after a refund)
     claims.json    { claims: [{ sha256, orderId, created, expires, box }] }  a paid order waiting for its browser to
                    collect the token (GET /access/claim). sha256 is the hash of the browser's claim id; box is the token
                    encrypted with a key derived from the claim id, so the file alone gives neither. Entries are ready
                    until `expires` (CLAIM_TTL_MS), then answer unknown, and are dropped a day later (on any write)
   Codes and tokens are random, stored hashed, compared in constant time and never logged. Revoking a code revokes its
   tokens: a token counts only while its code exists and isn't revoked (checked on every use, nothing cached). */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/i;
/** a claim id: a v4 UUID made by the browser (crypto.randomUUID), 122 random bits */
export const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CLAIM_TTL_MS = 3600_000;
const CLAIM_KEEP_MS = 24 * 3600_000;
const hash = (/** @type {string} */ t) => createHash('sha256').update(t).digest();
const hex = (/** @type {string} */ t) => hash(t).toString('hex');
/** constant-time: compares against every entry, returns the first match */
function findHash(/** @type {any[]} */ list, /** @type {string} */ token) {
  if (typeof token !== 'string' || !token || token.length > 128) return null;
  const h = hash(token);
  /** @type {any} */ let found = null;
  for (const e of list) if (e && typeof e.sha256 === 'string' && SHA256_HEX.test(e.sha256) && timingSafeEqual(Buffer.from(e.sha256, 'hex'), h) && !found) found = e;
  return found;
}

/* a claim's token at rest: AES-256-GCM under a key derived from the claim id (which only the buyer's browser and the
   webhook body carry), so claims.json on its own reveals no token */
const claimKey = (/** @type {string} */ claimId) => createHash('sha256').update('cue-claim-key\0' + claimId).digest();
function seal(/** @type {string} */ claimId, /** @type {string} */ token) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', claimKey(claimId), iv);
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
}
/** @returns {string | null} */
function unseal(/** @type {string} */ claimId, /** @type {unknown} */ box) {
  try {
    const [iv, tag, ct] = String(box).split('.').map(p => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', claimKey(claimId), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

/** @param {string} file @param {any} fallback */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (/** @type {any} */ (err).code === 'ENOENT') return fallback; throw err; }
}
/** @param {string} file @param {any} v */
function writeJson(file, v) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

/** The operator's side: codes (CLI) and what the server needs to read and write. */
export class AccessStore {
  /** @param {string} dir DATA_DIR */
  constructor(dir) { this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true }); }
  get codesFile() { return path.join(this.dir, 'codes.json'); }
  get verifiedFile() { return path.join(this.dir, 'verified.json'); }
  get claimsFile() { return path.join(this.dir, 'claims.json'); }

  /** @returns {{ codes: any[] }} */
  readCodes() { const v = readJson(this.codesFile, { codes: [] }); return v && Array.isArray(v.codes) ? v : { codes: [] }; }
  /** @returns {{ tokens: any[] }} */
  readVerified() { const v = readJson(this.verifiedFile, { tokens: [] }); return v && Array.isArray(v.tokens) ? v : { tokens: [] }; }
  /** @returns {{ claims: any[] }} */
  readClaims() { const v = readJson(this.claimsFile, { claims: [] }); return v && Array.isArray(v.claims) ? v : { claims: [] }; }

  /** CLI: a new code. Returned once, in clear; only its hash is stored. @param {{ label: string, maxUsers?: number | null }} o */
  createCode({ label, maxUsers = null }) {
    label = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    if (!label) throw new Error('a code needs a label');
    if (maxUsers != null && !(Number.isInteger(maxUsers) && maxUsers > 0)) throw new Error('--max-users must be a whole number above 0');
    const code = randomBytes(12).toString('base64url'), id = 'c-' + randomBytes(4).toString('hex'), all = this.readCodes();
    all.codes.push({ id, label, sha256: hex(code), created: new Date().toISOString(), maxUsers, revoked: null });
    writeJson(this.codesFile, all);
    return { id, label, code, maxUsers };
  }

  /** CLI: every code with how many tokens it has given out (uses). */
  listCodes() {
    const used = new Map();
    for (const t of this.readVerified().tokens) if (t && typeof t.code === 'string') used.set(t.code, (used.get(t.code) || 0) + 1);
    return this.readCodes().codes.map(c => ({ id: c.id, label: c.label, created: c.created, maxUsers: c.maxUsers ?? null, revoked: c.revoked || null, uses: used.get(c.id) || 0 }));
  }

  /** CLI: revoke a code. Its tokens stop working at their next use (nothing else to do: tokens are checked against it). */
  revokeCode(/** @type {string} */ id) {
    const all = this.readCodes(), c = all.codes.find(x => x && x.id === id);
    if (!c) return false;
    if (!c.revoked) { c.revoked = new Date().toISOString(); writeJson(this.codesFile, all); }
    return true;
  }

  /** Server: redeem a code. @returns {{ ok: true, token: string, label: string } | { ok: false, reason: 'bad' | 'revoked' | 'full' }} */
  redeem(/** @type {string} */ code) {
    const c = findHash(this.readCodes().codes, code);
    if (!c) return { ok: false, reason: 'bad' };
    if (c.revoked) return { ok: false, reason: 'revoked' };
    const v = this.readVerified();
    if (c.maxUsers != null && v.tokens.filter(t => t && t.code === c.id).length >= c.maxUsers) return { ok: false, reason: 'full' };
    const token = randomBytes(32).toString('base64url');
    v.tokens.push({ sha256: hex(token), code: c.id, created: new Date().toISOString() });
    writeJson(this.verifiedFile, v);
    return { ok: true, token, label: c.label };
  }

  /** Server: a paid order (the Lemon Squeezy webhook, already signature-checked) gives a verified token, collected by the
      browser that holds the claim id. Idempotent by order id: an order seen before (a retried or replayed webhook) issues
      nothing, whatever claim id it carries, and answers `duplicate`. The order id stays in verified.json for good, so a
      replay after the claim expired still issues nothing.
      @param {string} claimId @param {{ orderId: string, now?: number }} o
      @returns {{ ok: true, duplicate: boolean } | { ok: false, reason: 'bad_claim' | 'bad_order' }} */
  issueFromClaim(claimId, { orderId, now = Date.now() }) {
    if (typeof claimId !== 'string' || !CLAIM_ID.test(claimId)) return { ok: false, reason: 'bad_claim' };
    orderId = String(orderId ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { ok: false, reason: 'bad_order' };
    const v = this.readVerified();
    if (v.tokens.some(t => t && t.source === 'lemonsqueezy' && t.orderId === orderId)) return { ok: true, duplicate: true };
    const token = randomBytes(32).toString('base64url'), created = new Date(now).toISOString();
    // the claim first: if this write fails nothing was issued, and the webhook's retry starts over
    const c = this.readClaims(), h = hex(claimId);
    // a claim id seen again (the same browser's second order) points at the newest token
    c.claims = c.claims.filter(x => x && typeof x.expires === 'number' && x.expires + CLAIM_KEEP_MS > now && x.sha256 !== h);
    c.claims.push({ sha256: h, orderId, created, expires: now + CLAIM_TTL_MS, box: seal(claimId, token) });
    writeJson(this.claimsFile, c);
    v.tokens.push({ sha256: hex(token), code: null, created, source: 'lemonsqueezy', orderId, label: 'Paid order ' + orderId });
    writeJson(this.verifiedFile, v);
    return { ok: true, duplicate: false };
  }

  /** Server: what GET /access/claim answers. A well-formed claim id the server hasn't seen is `pending` (the webhook may
      still be on its way; the browser gives up after its own timeout); a claim past its TTL, or whose token was revoked
      meanwhile, is `unknown`. @returns {{ status: 'pending' } | { status: 'ready', token: string, label: string } | { status: 'unknown' }} */
  claimStatus(/** @type {string} */ claimId, now = Date.now()) {
    if (typeof claimId !== 'string' || !CLAIM_ID.test(claimId)) return { status: 'unknown' };
    const c = findHash(this.readClaims().claims, claimId);
    if (!c) return { status: 'pending' };
    if (!(typeof c.expires === 'number' && c.expires > now)) return { status: 'unknown' };
    const token = unseal(claimId, c.box), id = token ? this.identify(token) : null;
    return token && id ? { status: 'ready', token, label: id.label } : { status: 'unknown' };
  }

  /** Server: the code behind a verified token, if the token is known and its code still stands. A paid token stands on
      its own entry (there's no code behind it). */
  identify(/** @type {string} */ token) {
    const t = findHash(this.readVerified().tokens, token);
    if (!t) return null;
    if (t.source === 'lemonsqueezy') return t.revoked ? null : { codeId: null, label: String(t.label || 'Paid'), tokenHash: t.sha256 };
    const c = this.readCodes().codes.find(x => x && x.id === t.code);
    if (!c || c.revoked) return null;
    return { codeId: c.id, label: c.label, tokenHash: t.sha256 };
  }
}

/**
 * The seam: may this identity create a room? Today an identity is `{ verifiedToken }` and the answer comes from the
 * codes above or from a paid order (both give the same kind of token); plans would answer from an account instead. Callers get a key to rate-limit on (`who`) and a label to
 * record on the room, never the token itself.
 * @param {AccessStore} access @param {{ verifiedToken?: string }} identity
 * @returns {{ ok: true, who: string, label: string } | { ok: false, reason: 'unverified' }}
 */
export function canCreateRoom(access, identity) {
  const id = identity.verifiedToken ? access.identify(identity.verifiedToken) : null;
  return id ? { ok: true, who: id.tokenHash, label: id.label } : { ok: false, reason: 'unverified' };
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
export function createBurstLimiter({ max = 30, windowMs = 3600_000, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} */ const m = new Map();
  return {
    take(/** @type {string} */ key) {
      const t = now(), l = (m.get(key) || []).filter(x => t - x < windowMs);
      if (m.size > 1000) for (const [k, v] of m) if (!v.some(x => t - x < windowMs)) m.delete(k);
      if (l.length >= max) { m.set(key, l); return false; }
      l.push(t); m.set(key, l); return true;
    },
    /** true when `key` has no room left in the window (nothing is taken) */
    full(/** @type {string} */ key) { const t = now(); return (m.get(key) || []).filter(x => t - x < windowMs).length >= max; },
  };
}
