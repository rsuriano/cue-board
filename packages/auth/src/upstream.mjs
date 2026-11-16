// @ts-check
/* Gumroad, Lemon Squeezy and Resend, the only services auth talks to. Every call throws UpstreamError when the service is
   down or answers something unexpected, so callers can tell "no" from "couldn't ask" (an outage never counts against
   anyone's rate limit and never ends a session).
     License API  POST /v1/licenses/validate (form body, Accept: application/json, no API key; never activate)
                  docs.lemonsqueezy.com/api/license-api/validate-license-key. A key we never activate stays "inactive":
                  active and inactive are both good; expired and disabled (refunds disable it) are not.
     Orders       GET /v1/orders?filter[user_email]=, then GET /v1/license-keys?filter[order_id]= (Bearer API key, JSON:API)
                  docs.lemonsqueezy.com/api/orders/list-all-orders, /api/license-keys/list-all-license-keys
     Gumroad      GET /v2/sales?access_token=&email=&product_id= (pages: next_page_key → page_key), GET /v2/sales/<id>
                  gumroad.com/api#sales. A good sale: our product, the buyer's email, not refunded, not chargedback, not
                  disputed (unless the dispute was won). The sale id is the reference kept for the daily check.
     Resend     POST https://api.resend.com/emails { from, to, subject, text }   resend.com/docs/api-reference/emails/send-email */
const LS = 'https://api.lemonsqueezy.com', GOOD = ['active', 'inactive'], GR = 'https://api.gumroad.com/v2', GR_PAGES = 50;
export class UpstreamError extends Error {}

/** a Gumroad sale that still counts as a purchase of `productId` @param {any} s @param {string} productId */
const goodSale = (s, productId) => !!s && typeof s === 'object' && String(s.product_id) === String(productId) && typeof s.id === 'string' && !!s.id
  && typeof s.email === 'string' && !s.refunded && !s.chargedback && !(s.disputed && !s.dispute_won);

/** @param {{ fetch: typeof fetch, lsApiKey: string, gumroadToken?: string, resendKey: string, mailFrom: string, timeoutMs?: number }} o */
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
    /** The id of a good Gumroad sale of `productId` made with `email`, or ''. */
    async findSale(/** @type {string} */ email, /** @type {string} */ productId) {
      if (!o.gumroadToken) throw new UpstreamError('no GUMROAD_ACCESS_TOKEN');
      let page = '';
      for (let i = 0; i < GR_PAGES; i++) {
        const q = new URLSearchParams({ access_token: o.gumroadToken, email, product_id: productId });
        if (page) q.set('page_key', page);
        const { status, body } = await req(GR + '/sales?' + q, { headers: { accept: 'application/json' } });
        if (status !== 200 || !body || body.success !== true || !Array.isArray(body.sales)) throw new UpstreamError('gumroad ' + status);
        // Gumroad filters by email; we check the email again, so a filter that stops working never lets anyone in
        const s = body.sales.find((/** @type {any} */ s) => goodSale(s, productId) && s.email.trim().toLowerCase() === email);
        if (s) return s.id;
        page = typeof body.next_page_key === 'string' ? body.next_page_key : '';
        if (!page) return '';
      }
      throw new UpstreamError('gumroad: too many pages');
    },
    /** The buyer's email if sale `id` is still a good sale of `productId`, else null (an unknown id is null). */
    async checkSale(/** @type {string} */ id, /** @type {string} */ productId) {
      if (!o.gumroadToken) throw new UpstreamError('no GUMROAD_ACCESS_TOKEN');
      const { status, body } = await req(GR + '/sales/' + encodeURIComponent(id) + '?' + new URLSearchParams({ access_token: o.gumroadToken }), { headers: { accept: 'application/json' } });
      if (status === 404 || (status === 200 && body && body.success === false)) return null;
      if (status !== 200 || !body || body.success !== true) throw new UpstreamError('gumroad ' + status);
      return goodSale(body.sale, productId) ? body.sale.email.trim().toLowerCase() : null;
    },
    async mail(/** @type {string} */ to, /** @type {string} */ subject, /** @type {string} */ text) {
      const { status } = await req('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + o.resendKey, 'content-type': 'application/json' }, body: JSON.stringify({ from: o.mailFrom, to: [to], subject, text }) });
      if (status !== 200) throw new UpstreamError('resend ' + status);
    },
  };
}
