// @ts-check
/* Signed tokens: base64url(JSON payload) + '.' + base64url(Ed25519 signature of that first part). Two kinds:
     session  { typ: 'session', sub: email, prd: product id, src: 'purchase' | 'invite:<label>', exp, chk }
              lasts a year (exp); chk is when the purchase or code was last checked. A session not checked in the last
              24h is refused by verifyToken (what the sync server runs), so the app renews it with POST /session.
     ticket   { typ: 'ticket', sub, prd, code: <code id>, exp }   the invite magic link; one hour
              { typ: 'ticket', sub, prd, src: 'purchase', exp }   the "Log in" magic link; one hour, no license key in it
   Anyone with the public key (the sync server) checks a session without calling this service. */
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const DAY = 24 * 3600_000;

/** The signing key at `file`, made on first start (mode 0600) with its public half next to it (`file`.pub). */
export function loadSigningKey(/** @type {string} */ file) {
  if (!fs.existsSync(file)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(file + '.pub', publicKey.export({ type: 'spki', format: 'pem' }));
  }
  return createPrivateKey(fs.readFileSync(file));
}

/** @param {import('node:crypto').KeyObject} key @param {object} payload */
export function signToken(key, payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + sign(null, Buffer.from(p), key).toString('base64url');
}

/** The payload if the signature is good and it hasn't expired (a session: also checked in the last 24h, unless
    `stale` is allowed); otherwise null. @param {import('node:crypto').KeyObject} key private or public
    @param {unknown} token @param {number} now @returns {any} */
export function verifyToken(key, token, now, { stale = false } = {}) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [p, s, extra] = token.split('.');
  if (!p || !s || extra !== undefined) return null;
  try {
    const pub = key.type === 'private' ? createPublicKey(key) : key;
    if (!verify(null, Buffer.from(p), pub, Buffer.from(s, 'base64url'))) return null;
    const v = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!(v.exp > now)) return null;
    if (v.typ === 'session' && !stale && !(v.chk + DAY > now)) return null;
    return v;
  } catch { return null; }
}
