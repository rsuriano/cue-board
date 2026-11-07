// @ts-check
/* POST /webhooks/lemonsqueezy: a paid one-time order gives the buyer's browser a verified token (the same kind a
   verification code gives, access.mjs), which it collects with GET /access/claim?claim_id=… (api.mjs).

   The browser makes a random claim id (a v4 UUID), keeps it, and opens the checkout with
   ?checkout[custom][claim_id]=<id>; Lemon Squeezy echoes custom checkout data back in the webhook as meta.custom_data.

   Order of checks, each answered before the next is tried:
     no LEMONSQUEEZY_WEBHOOK_SECRET or LEMONSQUEEZY_VARIANT_ID   503 (never accepts an unsigned payload)
     not POST                                                   405
     body over MAX_BODY                                         413
     X-Signature missing or not hex HMAC-SHA256(secret, raw body)  401, before the body is parsed
     not JSON                                                   400
     not order_created, not status "paid", another variant, no or malformed meta.custom_data.claim_id
                                                                200 { ok: true } and nothing else (acked, so it isn't retried)
     a paid order of our variant                                200: AccessStore.issueFromClaim, idempotent by order id
     a write failed                                             500, so Lemon Squeezy retries later
   Answers carry no detail. Logs carry the order id and event name, never the body, the signature, the secret, the
   claim id (whoever holds it can collect the token until it's collected) or the buyer's email. */
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 64 * 1024;
const SIG_HEX = /^[0-9a-f]{64}$/i;

/**
 * @param {{ access: import('../access.mjs').AccessStore, log: ReturnType<typeof import('../log.mjs').createLogger>,
 *   secret?: string, variantId?: string, clientIp: (req: import('node:http').IncomingMessage) => string }} o
 */
export function createLemonSqueezyWebhook(o) {
  const secret = String(o.secret || ''), variantId = String(o.variantId || '').trim(), log = o.log;

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {object} body */
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  /** The raw body, or null when it's over MAX_BODY (past 4× that the socket is dropped instead of drained).
      @param {import('node:http').IncomingMessage} req @returns {Promise<Buffer | null>} */
  const rawBody = req => new Promise(ok => {
    /** @type {Buffer[]} */ const chunks = []; let n = 0, done = false, big = false;
    const end = (/** @type {Buffer | null} */ v) => { if (!done) { done = true; ok(v); } };
    req.on('data', d => { n += d.length; if (n > 4 * MAX_BODY) { end(null); req.destroy(); } else if (n > MAX_BODY) big = true; else chunks.push(d); });
    req.on('end', () => end(big ? null : Buffer.concat(chunks)));
    req.on('error', () => end(null));
  });

  /** constant-time: the header must be the hex HMAC-SHA256 of the raw body under the signing secret */
  const signed = (/** @type {Buffer} */ raw, /** @type {unknown} */ header) => {
    if (typeof header !== 'string' || !SIG_HEX.test(header)) return false;
    return timingSafeEqual(Buffer.from(header, 'hex'), createHmac('sha256', secret).update(raw).digest());
  };

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handle(req, res) {
    const ip = o.clientIp(req);
    if (!secret || !variantId) { log.error('lemonsqueezy webhook refused: LEMONSQUEEZY_WEBHOOK_SECRET or LEMONSQUEEZY_VARIANT_ID not set', { ip }); json(res, 503, { error: 'not_configured' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return; }
    const raw = await rawBody(req);
    if (!raw) { log.warn('lemonsqueezy webhook refused: too large', { ip }); json(res, 413, { error: 'too_large' }); return; }
    if (!signed(raw, req.headers['x-signature'])) { log.warn('lemonsqueezy webhook refused: bad signature', { ip }); json(res, 401, { error: 'bad_signature' }); return; }
    /** @type {any} */ let b;
    try { b = JSON.parse(raw.toString('utf8')); } catch { log.warn('lemonsqueezy webhook: signed but not JSON', { ip }); json(res, 400, { error: 'bad_request' }); return; }
    const meta = b && typeof b === 'object' ? b.meta : null, data = b && typeof b === 'object' ? b.data : null;
    const event = meta && typeof meta.event_name === 'string' ? meta.event_name.slice(0, 60) : '';
    const attrs = data && typeof data === 'object' && data.attributes && typeof data.attributes === 'object' ? data.attributes : {};
    const orderId = data && (typeof data.id === 'string' || typeof data.id === 'number') ? String(data.id).slice(0, 64) : '';
    const ack = () => json(res, 200, { ok: true });
    if (event !== 'order_created') { log.info('lemonsqueezy webhook ignored: event', { event }); ack(); return; }
    if (attrs.status !== 'paid') { log.info('lemonsqueezy webhook ignored: not paid', { order: orderId, status: String(attrs.status).slice(0, 30) }); ack(); return; }
    const item = attrs.first_order_item && typeof attrs.first_order_item === 'object' ? attrs.first_order_item : {};
    if (String(item.variant_id ?? '') !== variantId) { log.info('lemonsqueezy webhook ignored: another variant', { order: orderId, variant: String(item.variant_id ?? '').slice(0, 30) }); ack(); return; }
    const custom = meta.custom_data && typeof meta.custom_data === 'object' ? meta.custom_data : {};
    const r = o.access.issueFromClaim(typeof custom.claim_id === 'string' ? custom.claim_id : '', { orderId });
    if (!r.ok) {
      // a real payment the buyer can't collect: the operator finds it by order id and hands them a code instead
      log.error('lemonsqueezy webhook: paid order without a usable claim id, nothing issued', { order: orderId, reason: r.reason, testMode: meta.test_mode === true });
      ack(); return;
    }
    log.info(r.duplicate ? 'lemonsqueezy webhook: order already processed' : 'lemonsqueezy order paid: token issued', { order: orderId, testMode: meta.test_mode === true });
    ack();
  }

  return { handle };
}
