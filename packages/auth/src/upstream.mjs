// @ts-check
/* Lemon Squeezy and Resend, the only two services auth talks to. Every call throws UpstreamError when the service is
   down or answers something unexpected, so callers can tell "no" from "couldn't ask" (an outage never counts against
   anyone's rate limit and never ends a session).
     License API  POST /v1/licenses/validate (form body, Accept: application/json, no API key; never activate)
                  docs.lemonsqueezy.com/api/license-api/validate-license-key. A key we never activate stays "inactive":
                  active and inactive are both good; expired and disabled (refunds disable it) are not.
     Orders       GET /v1/orders?filter[user_email]=, then GET /v1/license-keys?filter[order_id]= (Bearer API key, JSON:API)
                  docs.lemonsqueezy.com/api/orders/list-all-orders, /api/license-keys/list-all-license-keys
     Resend       POST https://api.resend.com/emails { from, to, subject, text }   resend.com/docs/api-reference/emails/send-email */
const LS = 'https://api.lemonsqueezy.com', GOOD = ['active', 'inactive'];
export class UpstreamError extends Error {}

/** @param {{ fetch: typeof fetch, lsApiKey: string, resendKey: string, mailFrom: string, timeoutMs?: number }} o */
export function createUpstream(o) {
  /** @param {string} url @param {RequestInit} init @returns {Promise<{ status: number, body: any }>} */
  async function req(url, init) {
    let r; try { r = await o.fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) }); } catch { throw new UpstreamError('unreachable'); }
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  }
  const lsHeaders = () => ({ accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json', authorization: 'Bearer ' + o.lsApiKey });
  /** @param {string} p @returns {Promise<any[]>} */
  async function list(p) {
    const { status, body } = await req(LS + p, { headers: lsHeaders() });
    if (status !== 200 || !body || !Array.isArray(body.data)) throw new UpstreamError('lemon squeezy ' + status);
    return body.data;
  }

  return {
    /** The buyer's email if `key` is a good license key for `productId`, else null. */
    async validate(/** @type {string} */ key, /** @type {number} */ productId) {
      const { status, body } = await req(LS + '/v1/licenses/validate', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ license_key: key }).toString() });
      if (status >= 500 || status === 429 || !body) throw new UpstreamError('lemon squeezy ' + status);
      const ok = status === 200 && body.valid === true && GOOD.includes(body.license_key?.status) && Number(body.meta?.product_id) === Number(productId);
      return ok && typeof body.meta.customer_email === 'string' ? body.meta.customer_email.trim().toLowerCase() : null;
    },
    /** A good license key for `productId` from a paid order made with `email`, or ''. */
    async findKey(/** @type {string} */ email, /** @type {number} */ productId) {
      if (!o.lsApiKey) throw new UpstreamError('no LEMONSQUEEZY_API_KEY');
      for (const ord of await list('/v1/orders?' + new URLSearchParams({ 'filter[user_email]': email, 'page[size]': '100' }))) {
        const a = ord.attributes || {};
        if (!['paid', 'partial_refund'].includes(a.status) || Number(a.first_order_item?.product_id) !== Number(productId)) continue;
        for (const k of await list('/v1/license-keys?' + new URLSearchParams({ 'filter[order_id]': String(ord.id) }))) {
          const ka = k.attributes || {};
          if (Number(ka.product_id) === Number(productId) && GOOD.includes(ka.status) && typeof ka.key === 'string') return ka.key;
        }
      }
      return '';
    },
    async mail(/** @type {string} */ to, /** @type {string} */ subject, /** @type {string} */ text) {
      const { status } = await req('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + o.resendKey, 'content-type': 'application/json' }, body: JSON.stringify({ from: o.mailFrom, to: [to], subject, text }) });
      if (status !== 200) throw new UpstreamError('resend ' + status);
    },
  };
}
