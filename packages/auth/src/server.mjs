// @ts-check
/* auth.bedrocklabs.dev: accounts for Bedrock Labs products. Paying is the account (an email); no passwords, no signup.
   Products come from products.json: { id, name, lsProductId, appUrl }. JSON bodies (≤ 4 KiB), JSON answers, no-store.

     GET  /health
     POST /login   { email, product }        always 200 with the same message ('off' for a product with no lsProductId).
                                             Afterwards, if that email bought the product, it gets the magic link
                                             appUrl?key=<one-hour ticket> (never the license key). Lookups are
                                             limited per IP and per email (loginPerHour); past that, requests are
                                             dropped silently (same answer). A Lemon Squeezy failure counts against nobody.
     POST /session { key, product }          a license key (the receipt button) or a ticket (from /login's or /redeem's
                                             email; a purchase ticket looks the key up again)
                                             → 200 { session, email }. The key is validated, never activated, and must
                                             belong to `product`. Upserts the user (users.mjs).
                   { session }               renew: the same session while checked in the last 24h; past that the
                                             purchase (or code) is re-checked: a fresh session, or 401 signed_out.
     POST /redeem  { email, code, product }  an invite code (codes.mjs): emails a magic link with a one-hour ticket.
   Wrong license keys, tickets and codes count as failures per IP (5 block it for 15 minutes). Never logged: keys,
   codes, tokens, emails (a short hash stands in for an email). */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { CodeStore, createFailureLimiter, createBurstLimiter } from './codes.mjs';
import { Users } from './users.mjs';
import { signToken, verifyToken, DAY } from './token.mjs';
import { createUpstream } from './upstream.mjs';
import { createLogger } from './log.mjs';

const YEAR = 365 * DAY, TICKET_MS = 3600_000, MAX_BODY = 4096, EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;
const SENT = "If there's a purchase with that email, we sent a link to it. It can take a minute to arrive.";
const ERRORS = {
  bad_request: [400, 'Bad request'], bad_key: [401, "That link didn't work. Use the newest one, or log in again."],
  signed_out: [401, 'You were logged out. Log in again.'], bad_code: [401, "That code didn't work. Check it and try again."],
  code_revoked: [403, 'That code was cancelled. Ask for a new one.'], code_full: [409, 'That code has been used by as many people as it allows.'],
  too_many_attempts: [429, 'Too many attempts. Try again later.'], upstream: [503, "Couldn't check that right now. Try again in a minute."],
  off: [503, "Accounts aren't set up on this server yet."], origin: [403, 'Origin not allowed'], not_found: [404, 'Not found'], server: [500, 'Something went wrong on the server.'],
};

/**
 * @param {{ port: number, host?: string, dataDir: string, products: { id: string, name: string, lsProductId: number | null, appUrl: string }[],
 *   signingKey: import('node:crypto').KeyObject | null, lsApiKey?: string, resendKey?: string, mailFrom?: string, corsOrigins?: string[],
 *   trustProxy?: boolean, fetch?: typeof fetch, now?: () => number, loginPerHour?: number, failMax?: number,
 *   logLevel?: string, logWrite?: (line: string) => void }} o
 */
export async function startAuth(o) {
  const log = createLogger(o.logLevel, o.logWrite), now = o.now || Date.now, key = o.signingKey;
  const products = new Map(o.products.map(p => [p.id, p])), codes = new CodeStore(o.dataDir), users = new Users(o.dataDir);
  const up = createUpstream({ fetch: o.fetch || globalThis.fetch, lsApiKey: o.lsApiKey || '', resendKey: o.resendKey || '', mailFrom: o.mailFrom || '' });
  const lookups = createBurstLimiter({ max: o.loginPerHour ?? 5, now }), mails = createBurstLimiter({ max: o.loginPerHour ?? 5, now });
  const fails = createFailureLimiter({ max: o.failMax ?? 5, now }), origins = new Set(o.corsOrigins || []);
  const on = { session: !!key, login: !!(key && o.lsApiKey && o.resendKey), redeem: !!(key && o.resendKey) };
  if (!key) log.warn('sessions off: SESSION_KEY_FILE not set');
  if (!o.lsApiKey) log.warn('lemon squeezy off: LEMONSQUEEZY_API_KEY not set (log in by email is off; receipt links still work)');
  if (!o.resendKey) log.warn('email off: RESEND_API_KEY not set (log in by email and invite codes are off)');
  /** @type {Set<Promise<void>>} */ const pending = new Set();

  /** @param {http.ServerResponse} res @param {number} status @param {any} body */
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  /** @param {http.ServerResponse} res @param {keyof typeof ERRORS} e */
  const fail = (res, e) => json(res, ERRORS[e][0], { error: e, message: ERRORS[e][1] });
  /** a wrong secret: counts against the IP @param {http.ServerResponse} res @param {string} ip @param {keyof typeof ERRORS} e */
  const miss = (res, ip, e) => { const blocked = fails.fail(ip); log.warn('refused', { ip, error: e, blocked }); fail(res, blocked ? 'too_many_attempts' : e); };
  const tag = (/** @type {string} */ email) => createHash('sha256').update(email).digest('hex').slice(0, 10);
  const email = (/** @type {any} */ v) => { const e = typeof v === 'string' ? v.trim().toLowerCase() : ''; return e.length <= 254 && EMAIL.test(e) ? e : ''; };
  const link = (/** @type {{ appUrl: string }} */ p, /** @type {string} */ k) => { const u = new URL(p.appUrl); u.searchParams.set('key', k); return u.href; };
  /** @param {string} to @param {{ name: string }} p @param {string} url */
  const send = (to, p, url) => up.mail(to, `Your ${p.name} login link`, `Open this link to log in to ${p.name}:\n\n${url}\n\nIf you didn't ask for it, ignore this email.\n`);
  /** @param {http.IncomingMessage} req */
  const clientIp = req => {
    const hops = o.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean) : [];
    return hops.length ? hops[hops.length - 1] : req.socket.remoteAddress || '';
  };

  /** @param {http.ServerResponse} res @param {any} b @param {string} ip */
  async function session(res, b, ip) {
    if (typeof b.session === 'string') return renew(res, b.session);
    const p = products.get(b.product);
    if (!p || typeof b.key !== 'string' || !b.key || b.key.length > 2048) return fail(res, 'bad_request');
    if (fails.blocked(ip)) return fail(res, 'too_many_attempts');
    const t = verifyToken(/** @type {any} */ (key), b.key, now());
    let who, source, ref;
    if (t && t.typ === 'ticket' && t.src === 'purchase') {   // /login's email: the key is looked up again, never sent
      if (t.prd !== p.id) return fail(res, 'bad_key');
      try { ref = p.lsProductId ? await up.findKey(t.sub, p.lsProductId) : ''; } catch (err) { log.warn('lemon squeezy failed', { err: /** @type {Error} */ (err).message }); return fail(res, 'upstream'); }
      if (!ref) return fail(res, 'bad_key');
      [who, source] = [t.sub, 'purchase'];
    } else if (t && t.typ === 'ticket') {
      const c = codes.standing(t.code);
      if (!c || t.prd !== p.id) return fail(res, 'bad_key');
      if (c.maxUsers != null && users.seats(c.id, t.sub) >= c.maxUsers) return fail(res, 'code_full');
      [who, source, ref] = [t.sub, 'invite:' + c.label, c.id];
    } else {
      if (b.key.includes('.')) return miss(res, ip, 'bad_key');   // a forged or expired ticket (license keys have no dots)
      try { who = p.lsProductId ? await up.validate(b.key, p.lsProductId) : null; } catch (err) { log.warn('lemon squeezy failed', { err: /** @type {Error} */ (err).message }); return fail(res, 'upstream'); }
      if (!who) return miss(res, ip, 'bad_key');
      [source, ref] = ['purchase', b.key];
    }
    fails.ok(ip);
    const at = now();
    users.login({ email: who, product: p.id, source, ref, at: new Date(at).toISOString() });
    log.info('session opened', { product: p.id, source, who: tag(who), ip });
    json(res, 200, { session: signToken(/** @type {any} */ (key), { typ: 'session', sub: who, prd: p.id, src: source, exp: at + YEAR, chk: at }), email: who });
  }

  /** @param {http.ServerResponse} res @param {string} token */
  async function renew(res, token) {
    const t = verifyToken(/** @type {any} */ (key), token, now(), { stale: true });
    if (!t || t.typ !== 'session') return fail(res, 'signed_out');
    if (t.chk + DAY > now()) return json(res, 200, { session: token, email: t.sub });
    const u = users.get(t.sub, t.prd), p = products.get(t.prd);
    let ok = false;
    try { ok = !!u && !!p && (u.source === 'purchase' ? !!p.lsProductId && !!(await up.validate(u.ref, p.lsProductId)) : !!codes.standing(u.ref)); }
    catch (err) { log.warn('lemon squeezy failed', { err: /** @type {Error} */ (err).message }); return fail(res, 'upstream'); }
    log.info(ok ? 'session renewed' : 'session ended', { product: t.prd, who: tag(t.sub), source: u?.source });
    if (!ok) return fail(res, 'signed_out');
    json(res, 200, { session: signToken(/** @type {any} */ (key), { ...t, src: u.source, chk: now() }), email: t.sub });
  }

  /** answered at once, the same for everyone; the lookup and the email happen after. @param {http.ServerResponse} res @param {any} b @param {string} ip */
  function login(res, b, ip) {
    const p = products.get(b.product), to = email(b.email);
    if (!p || !to) return fail(res, 'bad_request');
    if (!p.lsProductId) return fail(res, 'off');
    json(res, 200, { ok: true, message: SENT });
    const keys = ['ip:' + ip, 'email:' + to];
    if (keys.some(k => lookups.full(k))) { log.warn('login dropped: rate limit', { ip, who: tag(to) }); return; }
    keys.forEach(k => lookups.take(k));
    const job = (async () => {
      try {
        const k = await up.findKey(to, Number(p.lsProductId));
        if (k) await send(to, p, link(p, signToken(/** @type {any} */ (key), { typ: 'ticket', sub: to, prd: p.id, src: 'purchase', exp: now() + TICKET_MS })));
        log.info(k ? 'login link sent' : 'login: no purchase', { ip, who: tag(to), product: p.id });
      } catch (err) {
        keys.forEach(k => lookups.untake(k));
        log.warn('login lookup failed', { ip, err: /** @type {Error} */ (err).message });
      }
    })();
    pending.add(job); job.finally(() => pending.delete(job));
  }

  /** @param {http.ServerResponse} res @param {any} b @param {string} ip */
  async function redeem(res, b, ip) {
    const p = products.get(b.product), to = email(b.email), code = typeof b.code === 'string' ? b.code.trim() : '';
    if (!p || !to || !code) return fail(res, 'bad_request');
    if (fails.blocked(ip)) return fail(res, 'too_many_attempts');
    const c = codes.find(code);
    if (!c) return miss(res, ip, 'bad_code');
    if (c.revoked) return fail(res, 'code_revoked');
    if (c.maxUsers != null && users.seats(c.id, to) >= c.maxUsers) return fail(res, 'code_full');
    fails.ok(ip);
    if (!mails.take(to)) return fail(res, 'too_many_attempts');
    try { await send(to, p, link(p, signToken(/** @type {any} */ (key), { typ: 'ticket', sub: to, prd: p.id, code: c.id, exp: now() + TICKET_MS }))); }
    catch (err) { mails.untake(to); log.warn('email failed', { err: /** @type {Error} */ (err).message }); return fail(res, 'upstream'); }
    log.info('code redeemed', { ip, code: c.label, who: tag(to) });
    json(res, 200, { ok: true, message: 'Check your email: we sent you a link to log in.' });
  }

  /** @param {http.IncomingMessage} req @returns {Promise<any>} parsed JSON object, or undefined */
  const body = req => new Promise(ok => {
    /** @type {Buffer[]} */ const chunks = []; let n = 0;
    req.on('data', d => { n += d.length; if (n <= MAX_BODY) chunks.push(d); else if (n > 4 * MAX_BODY) { ok(undefined); req.destroy(); } });
    req.on('end', () => { try { const v = n <= MAX_BODY && JSON.parse(Buffer.concat(chunks).toString('utf8')); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : undefined); } catch { ok(undefined); } });
    req.on('error', () => ok(undefined));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x'), p = url.pathname, ip = clientIp(req), origin = req.headers.origin;
    try {
      if (p === '/health') return json(res, 200, { ok: true });
      const b = req.method === 'POST' ? await body(req) : {};
      if (origin) {
        if (!origins.has(origin)) { log.warn('rejected: origin', { ip, origin: String(origin).slice(0, 200) }); return fail(res, 'origin'); }
        res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
        return res.end();
      }
      const route = req.method === 'POST' && /** @type {const} */ ({ '/session': 'session', '/login': 'login', '/redeem': 'redeem' })[p];
      if (!route) return fail(res, 'not_found');
      if (!on[route]) return fail(res, 'off');
      if (!b) return fail(res, 'bad_request');
      await (route === 'session' ? session(res, b, ip) : route === 'login' ? login(res, b, ip) : redeem(res, b, ip));
    } catch (err) {
      log.error('failed', { path: p, err: /** @type {any} */ (err)?.code || /** @type {any} */ (err)?.name });
      if (!res.headersSent) fail(res, 'server');
    }
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(o.port, o.host || '127.0.0.1', () => ok(undefined)); });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  log.info('listening', { host: o.host || '127.0.0.1', port, products: [...products.keys()] });
  return {
    port, url: `http://${o.host || '127.0.0.1'}:${port}`,
    /** resolves once every login lookup in flight has finished (tests) */
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
    async close() { await new Promise(ok => { server.close(() => ok(undefined)); server.closeAllConnections(); }); await this.idle(); users.close(); log.info('stopped'); },
  };
}
