// Test helpers: a fake Lemon Squeezy + Resend (injected fetch, nothing leaves the process), a temp auth server, HTTP calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { startAuth } from '../src/server.mjs';

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cue-auth-test-'));
export const PRODUCTS = [
  { id: 'cue-board', name: 'Cue Board', lsProductId: 111, appUrl: 'https://cue.example.dev/' },
  { id: 'other', name: 'Other app', lsProductId: 222, appUrl: 'https://other.example.dev/' },
];
export const DAY = 24 * 3600_000;

/** Fake upstreams, shaped after the docs (docs.lemonsqueezy.com/api/license-api/validate-license-key,
    /api/orders/list-all-orders, /api/license-keys/list-all-license-keys; resend.com/docs/api-reference/emails/send-email). */
export function fakeUpstream() {
  const up = {
    /** license key → { product, status, email } */ keys: new Map(),
    /** email → [{ id, product, status }] (orders) */ orders: new Map(),
    down: false, mailDown: false, /** @type {string[]} */ calls: [], /** @type {any[]} */ mails: [],
    /** @param {string} key @param {number} product @param {string} email @param {string} [status] */
    buy(key, product, email, status = 'inactive') {
      up.keys.set(key, { product, status, email });
      const id = 1000 + up.keys.size;
      up.orders.set(email, [...(up.orders.get(email) || []), { id, product, status: 'paid', key }]);
      return id;
    },
  };
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  up.fetch = async (url, init = {}) => {
    const u = new URL(url), h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    up.calls.push(u.host + u.pathname);
    if (u.host === 'api.resend.com' && u.pathname === '/emails') {
      if (up.mailDown) return res(500, { name: 'internal_server_error', message: 'down' });
      if (h.authorization !== 'Bearer test-resend') return res(401, { name: 'missing_api_key' });
      up.mails.push(JSON.parse(init.body)); return res(200, { id: 'mail-' + up.mails.length });
    }
    if (u.host !== 'api.lemonsqueezy.com') return res(404, {});
    if (up.down) return res(503, { error: 'Service unavailable' });
    if (u.pathname === '/v1/licenses/validate') {
      if (h.accept !== 'application/json' || h['content-type'] !== 'application/x-www-form-urlencoded') return res(400, { error: 'bad headers' });
      const key = new URLSearchParams(init.body).get('license_key'), k = up.keys.get(key);
      if (!k) return res(404, { valid: false, error: 'license_key not found.', license_key: null, instance: null, meta: null });
      return res(200, { valid: k.status === 'active' || k.status === 'inactive', error: null, instance: null,
        license_key: { id: 1, status: k.status, key, activation_limit: null, activation_usage: 0 },
        meta: { store_id: 9, order_id: 1, product_id: k.product, variant_id: 5, customer_email: k.email } });
    }
    if (h.authorization !== 'Bearer test-ls' || h.accept !== 'application/vnd.api+json') return res(401, { errors: [{ detail: 'Unauthenticated.' }] });
    if (u.pathname === '/v1/orders') {
      const email = u.searchParams.get('filter[user_email]');
      return res(200, { meta: { page: { currentPage: 1, lastPage: 1 } }, data: (up.orders.get(email) || []).map(o => ({ type: 'orders', id: String(o.id),
        attributes: { user_email: email, status: o.status, refunded: o.status === 'refunded', first_order_item: { order_id: o.id, product_id: o.product, variant_id: 5 } } })) });
    }
    if (u.pathname === '/v1/license-keys') {
      const id = Number(u.searchParams.get('filter[order_id]')), o = [...up.orders.values()].flat().find(x => x.id === id);
      const k = o && up.keys.get(o.key);
      return res(200, { meta: { page: { currentPage: 1, lastPage: 1 } }, data: k ? [{ type: 'license-keys', id: '1', attributes: { order_id: id, product_id: k.product, key: o.key, status: k.status, disabled: k.status === 'disabled' } }] : [] });
    }
    return res(404, { errors: [{ detail: 'Not found' }] });
  };
  return up;
}

export function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

/** A running auth service on a free port with a controllable clock. */
export async function auth(extra = {}) {
  const dir = extra.dataDir || tmpDir(), up = extra.up || fakeUpstream(), keys = keyPair(), clock = { t: Date.parse('2026-11-08T12:00:00Z') };
  const lines = [];
  const srv = await startAuth({ port: 0, host: '127.0.0.1', dataDir: dir, products: PRODUCTS, signingKey: keys.privateKey,
    lsApiKey: 'test-ls', resendKey: 'test-resend', mailFrom: 'Bedrock Labs <login@example.dev>', corsOrigins: ['https://cue.example.dev'],
    fetch: up.fetch, now: () => clock.t, logLevel: 'debug', logWrite: l => lines.push(l), ...extra });
  return { srv, dir, up, keys, clock, lines, call: (method, p, body, headers = {}) => call(srv.url, method, p, body, headers) };
}

/** HTTP call: { status, body, text, headers } */
export async function call(base, method, p, body, headers = {}) {
  const h = { ...headers }; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, text, headers: r.headers };
}

/** the token's payload (no check: tests verify signatures with verifySession) */
export const payload = t => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
