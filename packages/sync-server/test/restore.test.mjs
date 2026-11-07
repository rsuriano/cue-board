// Restoring paid access: POST /access/restore (src/restore.mjs, api.mjs) against a stand-in for the Lemon Squeezy API on
// 127.0.0.1, and AccessStore.issueFromOrder. Ports 0: nothing fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpDir, server } from './helpers.mjs';
import { AccessStore, canCreateRoom } from '../src/access.mjs';
import { cleanRestoreInput, matchOrder } from '../src/restore.mjs';
import { paidOrderProblem } from '../src/webhooks/lemonsqueezy.mjs';

const SECRET = 'test-signing-secret-not-real', VARIANT = '424242', API_KEY = 'test-ls-api-key-not-real';
const EMAIL = 'Buyer@Example.com', IDENT = randomUUID();
/** an order as GET /v1/orders lists it (JSON:API: id + attributes) */
const lsOrder = ({ id = '5550001', number = 31, email = EMAIL, status = 'paid', refunded = false, variantId = Number(VARIANT), identifier = IDENT } = {}) =>
  ({ type: 'orders', id, attributes: { identifier, order_number: number, user_email: email, status, refunded, test_mode: false,
    first_order_item: { order_id: Number(id), variant_id: variantId, price: 900 } } });

/** A stand-in Lemon Squeezy API: filters by filter[user_email] (case-insensitive) like the real one; records every call. */
async function fakeLs(orders = [lsOrder()]) {
  const calls = [], state = { mode: 'ok', orders, pages: null };
  const srv = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
    const u = new URL(req.url, 'http://x');
    if (state.mode === 'error') { res.writeHead(500); res.end('{"errors":[]}'); return; }
    if (state.mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); return; }
    if (u.pathname !== '/v1/orders') { res.writeHead(404); res.end(); return; }
    if (state.pages) { const p = state.pages[Number(u.searchParams.get('page[number]') || 1) - 1] || { data: [] }; res.writeHead(200, { 'content-type': 'application/vnd.api+json' }); res.end(JSON.stringify(p)); return; }
    const email = (u.searchParams.get('filter[user_email]') || '').toLowerCase();
    res.writeHead(200, { 'content-type': 'application/vnd.api+json' });
    res.end(JSON.stringify({ data: state.orders.filter(o => o.attributes.user_email.toLowerCase() === email), links: {} }));
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, calls, state, close: () => new Promise(ok => srv.close(ok)) };
}
const capture = () => {
  const lines = [], rec = lv => (msg, fields = {}) => lines.push(JSON.stringify({ level: lv, msg, ...fields }));
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
};
async function setup({ ls = {}, orders, ...extra } = {}) {
  const api = await fakeLs(orders), dir = tmpDir();
  const srv = await server(dir, 0, { lemonSqueezy: { secret: SECRET, variantId: VARIANT, apiKey: API_KEY, apiBase: api.base, ...ls }, ...extra });
  return { api, dir, srv, close: async () => { await srv.close(); await api.close(); } };
}
async function restore(srv, body) {
  const r = await fetch(srv.httpUrl + '/access/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const tokens = dir => new AccessStore(dir).readVerified().tokens;

test('(rs-a) a paid order found by number + email gives a token that creates rooms; restoring again (any device) gives the SAME token; a webhook-issued token is the one restored', async () => {
  const t = await setup();
  try {
    const r = await restore(t.srv, { orderNumber: '31', email: 'buyer@example.com' });
    assert.equal(r.status, 200); assert.match(r.body.token, /^[A-Za-z0-9_-]{40,}$/); assert.equal(r.body.label, 'Paid order 5550001');
    assert.deepEqual(Object.keys(r.body).sort(), ['label', 'token']);
    // the call: the API key as a Bearer header, JSON:API, the email filter; nothing else
    assert.equal(t.api.calls.length, 1); assert.equal(t.api.calls[0].auth, 'Bearer ' + API_KEY); assert.equal(t.api.calls[0].accept, 'application/vnd.api+json');
    assert.match(t.api.calls[0].url, /^\/v1\/orders\?filter\[user_email\]=buyer%40example\.com&page\[size\]=100$/);
    // idempotent: "#31", other casing and spaces, the receipt UUID: the same token, still one entry for the order
    for (const body of [{ orderNumber: '#31', email: ' BUYER@example.COM ' }, { orderNumber: IDENT.toUpperCase(), email: EMAIL }, { orderNumber: '31', email: EMAIL }]) {
      const again = await restore(t.srv, body); assert.equal(again.status, 200, JSON.stringify(body)); assert.equal(again.body.token, r.body.token);
    }
    assert.equal(tokens(t.dir).length, 1);
    assert.ok(!fs.readFileSync(t.dir + '/verified.json', 'utf8').includes(r.body.token), 'sealed, not in clear');
    assert.deepEqual(await (await fetch(t.srv.httpUrl + '/verify', { headers: { authorization: 'Bearer ' + r.body.token } })).json(), { ok: true, label: 'Paid order 5550001' });
    const room = await fetch(t.srv.httpUrl + '/rooms', { method: 'POST', headers: { authorization: 'Bearer ' + r.body.token, 'content-type': 'application/json' }, body: '{"name":"Restored"}' });
    assert.equal(room.status, 201);
  } finally { await t.close(); }
  // the usual path first: the webhook issued the order's token, the browser collected it; restoring hands back that one
  const dir = tmpDir(), a = new AccessStore(dir, { orderSecret: SECRET }), claimId = randomUUID();
  a.issueFromClaim(claimId, { orderId: '5550001' });
  const first = a.claimStatus(claimId).token;
  const r1 = a.issueFromOrder('5550001'), r2 = a.issueFromOrder('5550001');
  assert.deepEqual([r1.token, r1.reused, r2.token, r2.reused], [first, true, first, true]);
  assert.equal(a.readVerified().tokens.length, 1);
  // and an order restored before its webhook arrived: the late webhook is a duplicate, nothing new
  a.issueFromOrder('777');
  assert.deepEqual(a.issueFromClaim(randomUUID(), { orderId: '777' }), { ok: true, duplicate: true });
  assert.equal(a.readVerified().tokens.length, 2);
});

test('(rs-b) every miss answers the same 404, whichever field was wrong: no such number, right number + wrong email, unpaid, refunded, another variant, a revoked token', async () => {
  const orders = [lsOrder(), lsOrder({ id: '2', number: 32, status: 'pending' }), lsOrder({ id: '3', number: 33, status: 'refunded', refunded: true }),
    lsOrder({ id: '4', number: 34, refunded: true }), lsOrder({ id: '5', number: 35, variantId: 999 }), lsOrder({ id: '6', number: 36, status: 'failed' }),
    lsOrder({ id: '7', number: 37, email: 'someone@else.com' }), lsOrder({ id: '8', number: 38 })];
  const cap = capture(), t = await setup({ orders, restoreFails: 100, log: cap.log, logLevel: 'debug' });
  try {
    // order 8 was restored once, then the operator revoked it (a refund handled by hand)
    assert.equal((await restore(t.srv, { orderNumber: '38', email: EMAIL })).status, 200);
    const v = new AccessStore(t.dir).readVerified(); v.tokens.find(x => x.orderId === '8').revoked = new Date().toISOString(); fs.writeFileSync(t.dir + '/verified.json', JSON.stringify(v));
    const misses = [
      { orderNumber: '99', email: EMAIL },                 // no such order
      { orderNumber: '31', email: 'wrong@example.com' },   // right number, wrong email
      { orderNumber: '37', email: EMAIL },                 // someone else's order, our email
      { orderNumber: '32', email: EMAIL }, { orderNumber: '33', email: EMAIL }, { orderNumber: '34', email: EMAIL }, { orderNumber: '36', email: EMAIL },
      { orderNumber: '35', email: EMAIL },                 // another product
      { orderNumber: '38', email: EMAIL },                 // revoked
      { orderNumber: randomUUID(), email: EMAIL },
    ];
    const answers = [];
    for (const m of misses) { const r = await restore(t.srv, m); assert.equal(r.status, 404, JSON.stringify(m)); answers.push(JSON.stringify(r.body)); }
    assert.equal(new Set(answers).size, 1, 'one answer for every miss');
    assert.deepEqual(JSON.parse(answers[0]), { error: 'restore_no_match', message: "We couldn't find a paid order with that number and email." });
    assert.equal(tokens(t.dir).length, 1, 'no miss issued anything');
    // the operator's log tells them apart (a wrong email is "no order": Lemon Squeezy's own filter already leaves the
    // order out, so not even the server learns the number exists); it never has the email or the API key
    for (const reason of ['no order', 'not paid', 'another variant', 'revoked']) assert.ok(cap.lines.some(l => l.includes('"reason":"' + reason + '"')), reason);
    const all = cap.lines.join('\n');
    for (const s of [API_KEY, 'buyer@example.com', 'wrong@example.com', SECRET]) assert.ok(!all.toLowerCase().includes(s.toLowerCase()), 'leaked ' + s);
    // malformed input: 400, Lemon Squeezy isn't asked
    const before = t.api.calls.length;
    for (const b of [{}, { orderNumber: '31' }, { email: EMAIL }, { orderNumber: 31, email: EMAIL }, { orderNumber: '31', email: 'nope' }, { orderNumber: '3 1', email: EMAIL },
      { orderNumber: '1'.repeat(13), email: EMAIL }, { orderNumber: '31', email: 'a@b'.padStart(300, 'x') }, '[]', 'not json']) {
      assert.equal((await restore(t.srv, b)).status, 400, JSON.stringify(b));
    }
    assert.equal(t.api.calls.length, before);
    assert.equal((await fetch(t.srv.httpUrl + '/access/restore')).status, 404, 'GET is not a route');
  } finally { await t.close(); }
});

test('(rs-c) rate limits: 5 misses per IP block for 15 min (even a right answer then); a success in between does not reset the count; everyone: restoresPerHour', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await restore(t.srv, { orderNumber: String(100 + i), email: EMAIL })).status, 404);
    // a buyer restoring their own order between guesses doesn't wipe the guesses
    assert.equal((await restore(t.srv, { orderNumber: '31', email: EMAIL })).status, 200);
    const fifth = await restore(t.srv, { orderNumber: '104', email: EMAIL });
    assert.equal(fifth.status, 429); assert.equal(fifth.body.error, 'too_many_attempts'); assert.ok(fifth.body.retryAfter > 800 && fifth.body.retryAfter <= 900);
    const calls = t.api.calls.length;
    const right = await restore(t.srv, { orderNumber: '31', email: EMAIL });
    assert.equal(right.status, 429, 'blocked means blocked'); assert.equal(t.api.calls.length, calls, 'and Lemon Squeezy is not asked');
  } finally { await t.close(); }
  const g = await setup({ restoresPerHour: 2, restoreFails: 100 });
  try {
    assert.equal((await restore(g.srv, { orderNumber: '31', email: EMAIL })).status, 200);
    assert.equal((await restore(g.srv, { orderNumber: '9', email: EMAIL })).status, 404);
    const busy = await restore(g.srv, { orderNumber: '31', email: EMAIL });
    assert.equal(busy.status, 429); assert.equal(busy.body.error, 'restore_busy'); assert.equal(g.api.calls.length, 2);
  } finally { await g.close(); }
});

test('(rs-d) not configured: without LEMONSQUEEZY_API_KEY (or the variant, or the webhook secret) the route answers 503 and trusts nothing, asks nothing', async () => {
  for (const ls of [{ apiKey: '' }, { variantId: '' }, { secret: '' }]) {
    const t = await setup({ ls });
    try {
      const r = await restore(t.srv, { orderNumber: '31', email: EMAIL });
      assert.equal(r.status, 503, JSON.stringify(ls)); assert.equal(r.body.error, 'restore_not_configured');
      assert.equal(t.api.calls.length, 0); assert.equal(tokens(t.dir).length, 0);
    } finally { await t.close(); }
  }
  // the store refuses on its own too, without the secret its tokens are sealed under
  assert.deepEqual(new AccessStore(tmpDir()).issueFromOrder('1'), { ok: false, reason: 'no_secret' });
});

test('(rs-e) Lemon Squeezy failing is 502, never a token and never "no such order"; pages are followed only back to the same endpoint', async () => {
  const t = await setup({ restoreFails: 100 });
  try {
    for (const mode of ['error', 'html']) {
      t.api.state.mode = mode;
      const r = await restore(t.srv, { orderNumber: '31', email: EMAIL });
      assert.equal(r.status, 502, mode); assert.equal(r.body.error, 'restore_unavailable');
    }
    assert.equal(tokens(t.dir).length, 0);
    t.api.state.mode = 'ok';
    // the order on page 2: found through links.next
    t.api.state.pages = [{ data: [lsOrder({ id: '1', number: 1 })], links: { next: t.api.base + '/v1/orders?filter[user_email]=x&page[number]=2&page[size]=100' } }, { data: [lsOrder()], links: {} }];
    assert.equal((await restore(t.srv, { orderNumber: '31', email: EMAIL })).status, 200);
    // a next link anywhere else is not followed (the API key would go with it)
    t.api.state.pages = [{ data: [], links: { next: 'http://127.0.0.1:1/v1/orders?page[number]=2' } }];
    const n = t.api.calls.length;
    assert.equal((await restore(t.srv, { orderNumber: '31', email: EMAIL })).status, 404);
    assert.equal(t.api.calls.length, n + 1);
  } finally { await t.close(); }
});

test('(rs-f) issueFromOrder: one token per order; a token that can\'t be opened (the signing secret rotated) is replaced, said so; the shared paid check is the webhook\'s', () => {
  const dir = tmpDir(), a = new AccessStore(dir, { orderSecret: SECRET });
  const r1 = a.issueFromOrder('42'); assert.deepEqual([r1.ok, r1.reused, r1.replaced], [true, false, false]);
  assert.equal(a.issueFromOrder('42').token, r1.token);
  const rotated = new AccessStore(dir, { orderSecret: 'another-secret' }), r2 = rotated.issueFromOrder('42');
  assert.deepEqual([r2.ok, r2.reused, r2.replaced], [true, false, true]); assert.notEqual(r2.token, r1.token);
  assert.equal(canCreateRoom(a, { verifiedToken: r1.token }).ok, false, 'the old one ends: still one token per order');
  assert.equal(canCreateRoom(a, { verifiedToken: r2.token }).ok, true);
  assert.equal(rotated.issueFromOrder('42').token, r2.token);
  assert.equal(a.readVerified().tokens.length, 1);
  for (const bad of ['', '../x', 'a'.repeat(65), null]) assert.deepEqual(a.issueFromOrder(/** @type {any} */ (bad)), { ok: false, reason: 'bad_order' });
  // the one check, used by both the webhook and the restore
  assert.equal(paidOrderProblem({ status: 'paid', first_order_item: { variant_id: 424242 } }, VARIANT), null);
  assert.equal(paidOrderProblem({ status: 'paid', refunded: true, first_order_item: { variant_id: 424242 } }, VARIANT).reason, 'not paid');
  assert.equal(paidOrderProblem({ status: 'paid', first_order_item: { variant_id: 424242 } }, '').reason, 'another variant');
  assert.equal(paidOrderProblem(null, VARIANT).reason, 'not paid');
  assert.deepEqual(matchOrder([lsOrder()], /** @type {any} */ (cleanRestoreInput({ orderNumber: '# 31', email: EMAIL })), VARIANT), { orderId: '5550001' });
  assert.deepEqual(matchOrder([null, {}, { id: 1 }, { attributes: {} }], { orderNumber: '31', email: 'x@y' }, VARIANT), { reason: 'no order' });
  // were the API's email filter ever looser, the match still checks the email itself
  assert.deepEqual(matchOrder([lsOrder()], { orderNumber: '31', email: 'wrong@example.com' }, VARIANT), { reason: 'email' });
});
