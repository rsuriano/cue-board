// @ts-check
/* The HTTP side of the sync server: rooms created from the app, verification codes, owner actions. It lives on the
   same http.Server as the WebSocket upgrade, so one reverse proxy site (sync.example.dev) serves both.

   All bodies are JSON (≤ 16 KiB), all answers JSON with cache-control: no-store. Tokens travel in the Authorization
   header (`Bearer <token>`), never in URLs. Caddy's default access log already redacts Authorization.

     OPTIONS *                     CORS preflight (origins from CORS_ORIGINS; see below)
     POST   /verify   { code }     redeem a verification code → 200 { token, label }   (token: long-lived verified token)
                                   401 bad_code · 403 code_revoked · 409 code_full · 429 too_many_attempts (per IP:
                                   5 failures block for 15 min, retryAfter in seconds)
     GET    /verify                Bearer <verified token> → 200 { ok, label } · 401 unverified (revoked codes too)
     POST   /rooms    { name }     Bearer <verified token> → 201 { roomId, token, ownerToken }  (token: first invite token)
                                   401 unverified · 429 create_limit (per token, CREATE_PER_HOUR) · 507 room_cap (MAX_ROOMS)
     POST   /rooms/:id/invite      Bearer <owner token> → 200 { token }: every old invite link stops working and everyone
                                   connected is closed with 4401 (they rejoin with the new link; the owner's app does so itself)
     DELETE /rooms/:id             Bearer <owner token> → 200 { ok }: members get 4410 "room deleted", the folder is wiped
                                   404 unknown_room · 403 not_owner (also for a legacy room without an owner)
     POST   /reports  { …report }  no token (anyone can report a problem) → 201 { id }; the body is cleaned against the
                                   report allow-list (src/reports.mjs) and stored under DATA_DIR/reports/, never logged.
                                   400 bad_request · 413 too_large (over 16 KiB) · 429 report_limit (per IP: reportsPerHour,
                                   5; everyone: reportsPerDay, 200)
     GET    /access/claim?claim_id=    no token: the claim id (a v4 UUID the browser made before a Lemon Squeezy checkout) is
                                   the secret → 200 { status: 'pending' } (not seen yet: the webhook may be on its way) ·
                                   { status: 'ready', token, label } (a verified token, as POST /verify gives) ·
                                   { status: 'unknown' } (malformed, past its hour, or revoked). 429 claim_limit (per IP)
     POST   /webhooks/lemonsqueezy     Lemon Squeezy's order webhook, signed (webhooks/lemonsqueezy.mjs); read raw and
                                   checked before anything else here, no CORS (it carries no Origin)

   CORS: a browser request carries an Origin header; it's answered with CORS headers only if that origin is in
   `corsOrigins` (exact match, scheme and host). A request from any other origin is refused with 403 origin (defence in
   depth: the browser would have blocked the answer anyway). Requests without Origin (curl, the CLI) are not CORS. */
import { AccessStore, canCreateRoom, createFailureLimiter, createBurstLimiter } from './access.mjs';
import { ROOM_ID } from './store.mjs';
import { ReportStore, cleanReport } from './reports.mjs';
import { createLemonSqueezyWebhook } from './webhooks/lemonsqueezy.mjs';

const MAX_BODY = 16 * 1024, NAME_MAX = 120;
const ERRORS = {
  bad_request: [400, 'Bad request'], bad_code: [401, "That code didn't work. Check it and try again."], code_revoked: [403, 'That code was cancelled. Ask for a new one.'],
  code_full: [409, 'That code has been used by as many people as it allows.'], too_many_attempts: [429, 'Too many attempts. Try again in 15 minutes.'],
  unverified: [401, 'Creating rooms is invite-only for now. Enter the code you were given.'], create_limit: [429, 'You created a lot of rooms in the last hour. Try again later.'],
  room_cap: [507, "The server can't take more rooms right now. Tell the operator."], unknown_room: [404, 'No such room.'], not_owner: [403, "Only the room's owner can do that."],
  claim_limit: [429, 'Too many checks. Try again in a minute.'],
  report_limit: [429, 'Too many reports right now. Try again later.'], too_large: [413, 'That report is too big.'],
  origin: [403, 'Origin not allowed'], not_found: [404, 'Not found'], server: [500, 'Something went wrong on the server.'],
};

/**
 * @param {{ store: import('./store.mjs').ProjectStore, log: ReturnType<typeof import('./log.mjs').createLogger>, dataDir: string,
 *   corsOrigins: string[], maxRooms: number, createPerHour: number, verifyFails?: number, verifyBlockMs?: number,
 *   reportsPerHour?: number, reportsPerDay?: number, maxReports?: number, claimsPerMinute?: number,
 *   lemonSqueezy?: { secret?: string, variantId?: string },
 *   clientIp: (req: import('node:http').IncomingMessage) => string,
 *   initDoc: (name: string) => import('yjs').Doc,
 *   kickRoom: (id: string, code: number, reason: string) => void, deleteRoom: (id: string) => boolean }} o
 */
export function createApi(o) {
  const access = new AccessStore(o.dataDir), log = o.log;
  const verifyLimit = createFailureLimiter({ max: o.verifyFails ?? 5, blockMs: o.verifyBlockMs ?? 15 * 60_000 });
  const createLimit = createBurstLimiter({ max: o.createPerHour });
  const reports = new ReportStore(o.dataDir, { max: o.maxReports ?? 500 });
  const reportIp = createBurstLimiter({ max: o.reportsPerHour ?? 5 }), reportAll = createBurstLimiter({ max: o.reportsPerDay ?? 200, windowMs: 24 * 3600_000 });
  const claimLimit = createBurstLimiter({ max: o.claimsPerMinute ?? 60, windowMs: 60_000 });
  const lsWebhook = createLemonSqueezyWebhook({ access, log, clientIp: o.clientIp, ...o.lemonSqueezy });
  const origins = new Set(o.corsOrigins.map(s => s.trim()).filter(Boolean));

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body */
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  /** @param {import('node:http').ServerResponse} res @param {keyof typeof ERRORS} error @param {object} [extra] */
  const fail = (res, error, extra = {}) => json(res, ERRORS[error][0], { error, message: ERRORS[error][1], ...extra });
  /** @param {import('node:http').IncomingMessage} req */
  const bearer = req => { const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(String(req.headers.authorization || '')); return m ? m[1] : ''; };
  /** requests whose body was over MAX_BODY (answered 413 by /reports, 400 elsewhere as before) */
  const big = new WeakSet();
  /** The request body, read whole before any answer (answering with it unread resets a keep-alive connection).
      @param {import('node:http').IncomingMessage} req @returns {Promise<any>} parsed JSON ({} when empty), or undefined
      when it isn't valid JSON or is over MAX_BODY (past 4× that the socket is dropped instead of drained) */
  const body = req => new Promise(ok => {
    /** @type {Buffer[]} */ const chunks = []; let n = 0, done = false;
    const end = (/** @type {any} */ v) => { if (!done) { done = true; ok(v); } };
    req.on('data', d => { n += d.length; if (n > 4 * MAX_BODY) { big.add(req); end(undefined); req.destroy(); } else if (n > MAX_BODY) big.add(req); else chunks.push(d); });
    req.on('end', () => { if (big.has(req)) return end(undefined); try { const t = Buffer.concat(chunks).toString('utf8'); end(t ? JSON.parse(t) : {}); } catch { end(undefined); } });
    req.on('error', () => end(undefined));
  });

  /**
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url
   * @returns {Promise<boolean>} false when the path isn't the API's (the caller answers 404)
   */
  async function handle(req, res, url) {
    if (url.pathname === '/webhooks/lemonsqueezy') {
      // its own raw body: the signature is over the exact bytes
      try { await lsWebhook.handle(req, res); } catch (err) {
        const e = /** @type {any} */ (err);
        log.error('lemonsqueezy webhook failed', { err: e && e.code ? e.code : e && e.name });
        if (!res.headersSent) fail(res, 'server');
      }
      return true;
    }
    const b = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? {} : await body(req);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (origin) {
      if (!origins.has(origin)) { log.warn('rejected: origin', { ip: o.clientIp(req), origin: origin.slice(0, 200) }); fail(res, 'origin'); return true; }
      res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-max-age', '600');
      res.writeHead(204); res.end(); return true;
    }
    const p = url.pathname, m = /^\/rooms\/([^/]+)(\/invite)?$/.exec(p);
    try {
      if (p === '/verify' && req.method === 'POST') return verify(req, res, b);
      if (p === '/verify' && req.method === 'GET') return whoami(req, res);
      if (p === '/rooms' && req.method === 'POST') return createRoom(req, res, b);
      if (m && m[2] && req.method === 'POST') return ownerAction(req, res, m[1], 'invite');
      if (m && !m[2] && req.method === 'DELETE') return ownerAction(req, res, m[1], 'delete');
      if (p === '/reports' && req.method === 'POST') return report(req, res, b);
      if (p === '/access/claim' && req.method === 'GET') return claim(req, res, url);
      if (p === '/verify' || p === '/rooms' || p === '/reports' || p === '/access/claim' || m) { fail(res, 'not_found'); return true; }
      return false;
    } catch (err) {
      // only our own words are logged: a JSON.parse message can quote codes.json (hashes)
      const e = /** @type {any} */ (err);
      log.error('api failed', { path: p, method: req.method, err: e && e.code ? e.code : e && e.name });
      if (!res.headersSent) fail(res, 'server');
      return true;
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {any} b */
  function verify(req, res, b) {
    const ip = o.clientIp(req), left = verifyLimit.blocked(ip);
    if (left) { log.warn('verify blocked', { ip }); fail(res, 'too_many_attempts', { retryAfter: Math.ceil(left / 1000) }); return true; }
    const code = b && typeof b.code === 'string' ? b.code.trim() : '';
    if (!b || !code || code.length > 128) { fail(res, 'bad_request'); return true; }
    const r = access.redeem(code);
    if (!r.ok) {
      if (r.reason === 'full') { log.info('verify refused: code full', { ip }); fail(res, 'code_full'); return true; }
      const blocked = verifyLimit.fail(ip);
      log.warn('verify failed', { ip, reason: r.reason, blocked });
      if (blocked) fail(res, 'too_many_attempts', { retryAfter: Math.ceil(verifyLimit.blocked(ip) / 1000) }); else fail(res, r.reason === 'revoked' ? 'code_revoked' : 'bad_code');
      return true;
    }
    verifyLimit.ok(ip);
    log.info('verified', { ip, code: r.label });
    json(res, 200, { token: r.token, label: r.label });
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  function whoami(req, res) {
    const r = canCreateRoom(access, { verifiedToken: bearer(req) });
    if (!r.ok) fail(res, 'unverified'); else json(res, 200, { ok: true, label: r.label });
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {any} b */
  function createRoom(req, res, b) {
    const ip = o.clientIp(req), who = canCreateRoom(access, { verifiedToken: bearer(req) });
    if (!who.ok) { log.warn('create refused: unverified', { ip }); fail(res, 'unverified'); return true; }
    if (!b || (b.name !== undefined && typeof b.name !== 'string')) { fail(res, 'bad_request'); return true; }
    const name = String(b.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Untitled project';
    if (!createLimit.take(who.who)) { log.warn('create refused: burst limit', { ip, code: who.label }); fail(res, 'create_limit'); return true; }
    if (o.store.count() >= o.maxRooms) { log.error('create refused: room cap reached (MAX_ROOMS)', { ip, max: o.maxRooms }); fail(res, 'room_cap'); return true; }
    const { id, token, ownerToken } = o.store.createProject(name, o.initDoc(name), { owner: true, code: who.label });
    log.info('room created', { room: id, ip, code: who.label });
    json(res, 201, { roomId: id, token, ownerToken });
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} id @param {'invite' | 'delete'} what */
  function ownerAction(req, res, id, what) {
    const ip = o.clientIp(req);
    if (!ROOM_ID.test(id) || !o.store.exists(id)) { fail(res, 'unknown_room'); return true; }
    if (!o.store.checkOwner(id, bearer(req))) { log.warn('rejected: not owner', { room: id, ip, what }); fail(res, 'not_owner'); return true; }
    if (what === 'invite') {
      const token = o.store.replaceTokens(id);
      o.kickRoom(id, 4401, 'bad token');
      log.info('invite link replaced', { room: id, ip });
      json(res, 200, { token });
    } else {
      o.deleteRoom(id);
      log.info('room deleted', { room: id, ip });
      json(res, 200, { ok: true });
    }
    return true;
  }

  /** A problem report from the app: rate-limited per IP and for everyone, cleaned, stored. Only the id is logged.
      The shared limit is checked before the IP's, so a flood from many addresses stops at reportsPerDay without
      growing the per-IP table past that.
      @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {any} b */
  function report(req, res, b) {
    const ip = o.clientIp(req);
    if (big.has(req)) { log.warn('report refused: too large', { ip }); fail(res, 'too_large'); return true; }
    if (!b || typeof b !== 'object' || Array.isArray(b)) { fail(res, 'bad_request'); return true; }
    if (reportAll.full('all')) { log.warn('report refused: daily limit (everyone)', { ip }); fail(res, 'report_limit'); return true; }
    if (!reportIp.take(ip)) { log.warn('report refused: hourly limit (IP)', { ip }); fail(res, 'report_limit'); return true; }
    reportAll.take('all');
    const id = reports.add(/** @type {Record<string, unknown>} */ (cleanReport(b)));
    log.info('report stored', { id, ip });
    json(res, 201, { id });
    return true;
  }

  /** A browser back from checkout asks for its token, every ~1.5 s for ~30 s. Only the outcome is logged, never the claim id.
      @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  function claim(req, res, url) {
    const ip = o.clientIp(req);
    if (!claimLimit.take(ip)) { log.warn('claim refused: rate limit', { ip }); fail(res, 'claim_limit'); return true; }
    const r = access.claimStatus(url.searchParams.get('claim_id') || '');
    if (r.status === 'ready') log.info('claim collected', { ip, code: r.label });
    json(res, 200, r);
    return true;
  }

  return { handle, access, reports, limits: { verify: verifyLimit, create: createLimit, reportIp, reportAll, claim: claimLimit } };
}
