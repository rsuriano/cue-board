// @ts-check
/* Who may create a room: whoever holds a session from auth (packages/auth, auth.bedrocklabs.dev), checked here with
   auth's public key (AUTH_PUBLIC_KEY_FILE), no network call. A session is base64url(JSON payload) + '.' +
   base64url(Ed25519 signature of that first part), payload { typ: 'session', sub: email, prd, src, exp, chk }; it counts
   while it hasn't expired (exp, a year) and was checked by auth in the last 24h (chk), so a refund or a revoked invite
   code ends it within a day. The one seam the rest of the server uses is canCreateRoom. Joining a room needs no session. */
import { createHash, verify } from 'node:crypto';

const DAY = 24 * 3600_000, PRODUCT = 'cue-board';

/**
 * @param {import('node:crypto').KeyObject | null} publicKey auth's (null: nobody can create rooms)
 * @param {{ session?: string }} identity
 * @returns {{ ok: true, who: string, label: string } | { ok: false, reason: 'no_session' }}
 *   who: a key to rate-limit on (a hash of the email, never the email); label: how they got in, kept on the room
 */
export function canCreateRoom(publicKey, identity, now = Date.now()) {
  const t = identity.session, [p, s, extra] = typeof t === 'string' && t.length <= 2048 ? t.split('.') : [];
  if (!publicKey || !p || !s || extra !== undefined) return { ok: false, reason: 'no_session' };
  try {
    if (!verify(null, Buffer.from(p), publicKey, Buffer.from(s, 'base64url'))) return { ok: false, reason: 'no_session' };
    const v = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (v.typ !== 'session' || v.prd !== PRODUCT || !(v.exp > now) || !(v.chk + DAY > now) || typeof v.sub !== 'string') return { ok: false, reason: 'no_session' };
    return { ok: true, who: createHash('sha256').update(v.sub).digest('hex'), label: String(v.src || '').slice(0, 80) };
  } catch { return { ok: false, reason: 'no_session' }; }
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
