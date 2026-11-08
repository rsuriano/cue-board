// @ts-check
/* POST /access/restore { orderNumber, email }: a buyer who lost their paid token (site data cleared, a new device, iOS
   clearing storage) gets it back by proving the purchase. The server looks the order up in the Lemon Squeezy API with
   LEMONSQUEEZY_API_KEY (read only: one list call filtered by the email typed, a few pages at most), and it qualifies only if
     its order_number (the "#1234" on the receipt) or identifier (the receipt's UUID) is what was typed,
     its user_email is the email typed (case-insensitive), and
     paidOrderProblem() passes: status "paid", not refunded, LEMONSQUEEZY_VARIANT_ID, not test mode unless
     LEMONSQUEEZY_ALLOW_TEST_MODE=1 (the webhook's own check).
   Then AccessStore.issueFromOrder hands back that order's token (the same one every time). The route (api.mjs) answers
   every miss the same way, whichever field was wrong, and rate-limits attempts per IP and for everyone.
   Nothing here logs or returns the email, the order number, the API key or Lemon Squeezy's answer.
   API reference: https://docs.lemonsqueezy.com/api/orders */
import { paidOrderProblem } from './webhooks/lemonsqueezy.mjs';

export const LS_API = 'https://api.lemonsqueezy.com';
const MAX_PAGES = 5, PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The two fields as typed, cleaned: "#1234" → "1234", a receipt UUID lowercased, the email trimmed and lowercased.
    The route runs this before the shared hourly budget (restoresPerHour), so junk (empty, a number that isn't one, an
    email without "@" or a dotted domain) is a 400 that costs nothing and can't use up the restores of real buyers.
    @param {any} b the request body @returns {{ orderNumber: string, email: string } | null} null when malformed */
export function cleanRestoreInput(b) {
  if (!b || typeof b !== 'object' || typeof b.orderNumber !== 'string' || typeof b.email !== 'string') return null;
  const orderNumber = b.orderNumber.trim().replace(/^#\s*/, '').toLowerCase(), email = b.email.trim().toLowerCase();
  if (!/^[0-9]{1,12}$/.test(orderNumber) && !UUID.test(orderNumber)) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return { orderNumber, email };
}

/** The orders Lemon Squeezy has for this email (its own filter; matched again in matchOrder). Throws on anything but a
    clean answer, so a lookup that failed is never read as "no such order".
    @param {{ apiKey: string, apiBase?: string, timeoutMs?: number }} cfg @param {string} email @returns {Promise<any[]>} */
export async function listOrdersByEmail({ apiKey, apiBase = LS_API, timeoutMs = 10_000 }, email) {
  const base = apiBase.replace(/\/+$/, '') + '/v1/orders';
  /** @type {any[]} */ const orders = [];
  let url = base + '?filter[user_email]=' + encodeURIComponent(email) + '&page[size]=' + PAGE_SIZE;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const r = await fetch(url, { headers: { accept: 'application/vnd.api+json', authorization: 'Bearer ' + apiKey }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw Object.assign(new Error('lemonsqueezy api'), { code: 'LS_HTTP_' + r.status });
    const j = /** @type {any} */ (await r.json());
    if (!j || !Array.isArray(j.data)) throw Object.assign(new Error('lemonsqueezy api'), { code: 'LS_SHAPE' });
    orders.push(...j.data);
    const next = j.links && typeof j.links.next === 'string' ? j.links.next : '';
    // only ever back to the same endpoint: the API key goes nowhere else
    url = next.startsWith(base + '?') ? next : '';
  }
  return orders;
}

/** The order the buyer means, if it qualifies. `reason` is for the server log only; the answer never tells them apart.
    @param {any[]} orders @param {{ orderNumber: string, email: string }} input @param {string} variantId
    @param {boolean} [allowTestMode] @returns {{ orderId: string } | { reason: 'no order' | 'email' | 'test mode' | 'not paid' | 'another variant' }} */
export function matchOrder(orders, { orderNumber, email }, variantId, allowTestMode = false) {
  /** @type {'no order' | 'email' | 'test mode' | 'not paid' | 'another variant'} */ let reason = 'no order';
  for (const o of orders) {
    const a = o && typeof o === 'object' && o.attributes && typeof o.attributes === 'object' ? o.attributes : null;
    if (!a || !(typeof o.id === 'string' || typeof o.id === 'number')) continue;
    const num = (typeof a.order_number === 'number' || typeof a.order_number === 'string') && String(a.order_number) === orderNumber;
    if (!num && !(typeof a.identifier === 'string' && a.identifier.toLowerCase() === orderNumber)) continue;
    if (!(typeof a.user_email === 'string' && a.user_email.trim().toLowerCase() === email)) { reason = 'email'; continue; }
    const problem = paidOrderProblem(a, variantId, allowTestMode);
    if (problem) { reason = problem.reason; continue; }
    return { orderId: String(o.id) };
  }
  return { reason };
}
