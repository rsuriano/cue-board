// Lemon Squeezy paywall: the signed order webhook (src/webhooks/lemonsqueezy.mjs), claims (src/access.mjs), GET /access/claim.
// Port 0 (any free one): the fixed ports left near 3393-3399 belong to collab-client's media tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, server } from './helpers.mjs';
import { AccessStore, canCreateRoom, CLAIM_TTL_MS } from '../src/access.mjs';
import { matchOrder } from '../src/restore.mjs';

const SECRET = 'test-signing-secret-not-real', VARIANT = '424242';
const LS = { lemonSqueezy: { secret: SECRET, variantId: VARIANT } };
const sign = (raw, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
/** the same string with its first character changed, always (a fixed replacement is a no-op 1 time in 16 or 64) */
const flip = s => (s[0] === 'e' ? 'f' : 'e') + s.slice(1);
/** an order_created body shaped like Lemon Squeezy's (meta.event_name, meta.custom_data, data.id, data.attributes) */
function order({ orderId = '1001', claimId = randomUUID(), status = 'paid', variantId = Number(VARIANT), event = 'order_created', custom, testMode = false } = {}) {
  return {
    meta: { event_name: event, test_mode: testMode, custom_data: custom !== undefined ? custom : { claim_id: claimId } },
    data: { type: 'orders', id: orderId, attributes: { status, user_email: 'buyer@example.com', identifier: randomUUID(),
      first_order_item: { order_id: Number(orderId), product_id: 7, variant_id: variantId, price: 900 } } },
  };
}
async function hook(srv, body, { sig, raw } = {}) {
  const text = raw ?? JSON.stringify(body), headers = { 'content-type': 'application/json', 'x-event-name': 'order_created' };
  if (sig !== null) headers['x-signature'] = sig ?? sign(text);
  const r = await fetch(srv.httpUrl + '/webhooks/lemonsqueezy', { method: 'POST', headers, body: text });
  return { status: r.status, text: await r.text() };
}
async function poll(srv, claimId) {
  const r = await fetch(srv.httpUrl + '/access/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim_id: claimId }) });
  return { status: r.status, body: await r.json() };
}
const tokens = dir => new AccessStore(dir).readVerified().tokens;
const bin = n => fileURLToPath(new URL(`../bin/${n}.mjs`, import.meta.url));
const cli = (name, args, dir) => spawnSync(process.execPath, [bin(name), ...args, '--data-dir', dir], { encoding: 'utf8' });
const capture = () => {
  const lines = [], rec = lv => (msg, fields = {}) => lines.push(JSON.stringify({ level: lv, msg, ...fields }));
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
};

test('(ls-a) a signed paid order issues one token: polling goes pending → ready (once: then unknown), the token creates rooms; a replay of the same order (same or another claim id) issues nothing', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, LS);
  try {
    const claimId = randomUUID();
    assert.deepEqual((await poll(srv, claimId)).body, { status: 'pending' }, 'not seen yet: the webhook may be on its way');
    const body = order({ claimId });
    let r = await hook(srv, body); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true });
    const p = await poll(srv, claimId);
    assert.equal(p.body.status, 'ready'); assert.match(p.body.token, /^[A-Za-z0-9_-]{40,}$/); assert.equal(p.body.label, 'Paid order 1001');
    assert.deepEqual((await poll(srv, claimId)).body, { status: 'unknown' }, 'collected once: a second poll gets nothing');
    // the exact same delivery again, and a forged-claim variant of it (needs the signature, but still): no second token
    assert.equal((await hook(srv, body)).status, 200);
    assert.equal((await hook(srv, order({ orderId: '1001' }))).status, 200);
    assert.equal(tokens(dir).length, 1);
    // the shape the rest of the server reads, plus bookkeeping; nothing in clear on disk
    const t = tokens(dir)[0];
    assert.deepEqual(Object.keys(t).sort(), ['box', 'code', 'created', 'label', 'orderId', 'sha256', 'source']);
    assert.equal(t.source, 'lemonsqueezy'); assert.equal(t.orderId, '1001'); assert.equal(t.code, null);
    const disk = fs.readFileSync(path.join(dir, 'verified.json'), 'utf8') + fs.readFileSync(path.join(dir, 'claims.json'), 'utf8');
    assert.ok(!disk.includes(p.body.token) && !disk.includes(claimId) && !disk.includes('buyer@example.com'));
    assert.equal(fs.statSync(path.join(dir, 'claims.json')).mode & 0o777, 0o600);
    // the token does what a redeemed code's token does
    assert.deepEqual(await (await fetch(srv.httpUrl + '/verify', { headers: { authorization: 'Bearer ' + p.body.token } })).json(), { ok: true, label: 'Paid order 1001' });
    const room = await fetch(srv.httpUrl + '/rooms', { method: 'POST', headers: { authorization: 'Bearer ' + p.body.token, 'content-type': 'application/json' }, body: '{"name":"Paid"}' });
    assert.equal(room.status, 201);
    // list-codes still counts code uses only
    assert.deepEqual(new AccessStore(dir).listCodes(), []);
  } finally { await srv.close(); }
});

test('(ls-b) forged webhooks never issue: no signature, a wrong one, the wrong secret, a re-encoded body; all 401 before parsing, even for a body that isn\'t JSON', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, LS);
  try {
    const claimId = randomUUID(), body = order({ claimId }), text = JSON.stringify(body);
    for (const opts of [{ sig: null }, { sig: '' }, { sig: 'zz' }, { sig: sign(text, 'another-secret') }, { sig: flip(sign(text)) },
      { sig: sign(text), raw: JSON.stringify(body, null, 1) }, { sig: sign(text) + '00' }, { sig: 'sha256=' + sign(text) }]) {
      const r = await hook(srv, body, opts); assert.equal(r.status, 401, JSON.stringify(opts).slice(0, 80)); assert.deepEqual(JSON.parse(r.text), { error: 'bad_signature' });
    }
    // unsigned garbage is refused as unsigned (401), not as malformed (400): the body is never parsed
    assert.equal((await hook(srv, null, { raw: '{not json', sig: null })).status, 401);
    // signed garbage is a plain 400
    assert.equal((await hook(srv, null, { raw: '{not json' })).status, 400);
    assert.equal(tokens(dir).length, 0); assert.ok(!fs.existsSync(path.join(dir, 'claims.json')));
    assert.deepEqual((await poll(srv, claimId)).body, { status: 'pending' });
    // over the size cap: 413, nothing parsed
    assert.equal((await hook(srv, null, { raw: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await fetch(srv.httpUrl + '/webhooks/lemonsqueezy')).status, 405);
  } finally { await srv.close(); }
});

test('(ls-c) not configured: without the secret (or the variant id) every webhook is refused 503, even a correctly signed one', async () => {
  const dir = tmpDir();
  for (const [port, cfg] of [[0, {}], [0, { lemonSqueezy: { secret: SECRET } }], [0, { lemonSqueezy: { variantId: VARIANT } }]]) {
    const srv = await server(dir, port, cfg);
    try {
      const body = order(), r = await hook(srv, body);
      assert.equal(r.status, 503); assert.deepEqual(JSON.parse(r.text), { error: 'not_configured' });
      assert.equal((await hook(srv, body, { sig: sign(JSON.stringify(body), '') })).status, 503, 'an empty secret signs nothing');
    } finally { await srv.close(); }
  }
  assert.equal(tokens(dir).length, 0);
});

test('(ls-d) acked and ignored: other events, unpaid orders, another variant, custom_data missing or malformed; nothing crashes, nothing is issued', async () => {
  const dir = tmpDir(), cap = capture(), srv = await server(dir, 0, { ...LS, log: cap.log });
  try {
    const cases = [
      order({ event: 'order_refunded', orderId: '1999' }), order({ event: 'subscription_created' }), order({ status: 'pending' }), order({ status: 'refunded' }),
      order({ variantId: 999 }), order({ variantId: null }),
      order({ custom: undefined }), order({ custom: null }), order({ custom: {} }), order({ custom: 'claim' }), order({ custom: { claim_id: 42 } }),
      order({ custom: { claim_id: 'not-a-uuid' } }), order({ custom: { claim_id: '00000000-0000-0000-0000-000000000000' } }),
      order({ custom: { claim_id: randomUUID() + 'x' } }), order({ orderId: '../../etc' }), order({ orderId: '' }),
      {}, { meta: null, data: null }, [], 'a string', 5, null,
    ];
    // custom: undefined means "omit custom_data entirely"
    delete cases[6].meta.custom_data;
    for (const [i, b] of cases.entries()) { const r = await hook(srv, b); assert.equal(r.status, 200, 'case ' + i); assert.deepEqual(JSON.parse(r.text), { ok: true }, 'case ' + i); }
    // the one write: case 0's refund leaves its order a revoked entry with no token (ls-i)
    assert.deepEqual(tokens(dir).map(t => t.sha256), [null]); assert.ok(!fs.existsSync(path.join(dir, 'claims.json')));
    assert.ok(cap.lines.some(l => /paid order without a usable claim id/.test(l)), 'a paid order nobody can collect is logged for the operator');
    assert.equal((await fetch(srv.httpUrl + '/health')).status, 200);
    // a claim id that's well formed but never made by any browser: it's a real paid order, so a token is issued and
    // waits in claims.json for whoever holds that id; it expires with the claim like any other
    const stray = randomUUID();
    assert.equal((await hook(srv, order({ orderId: '2002', claimId: stray }))).status, 200);
    assert.equal((await poll(srv, stray)).body.status, 'ready');
    assert.equal((await poll(srv, randomUUID())).body.status, 'pending', 'other ids learn nothing');
  } finally { await srv.close(); }
});

test('(ls-e) claims: pending → ready (once) → unknown, and unknown after the TTL; malformed ids are unknown; old entries are dropped on the next write; a revoked paid token is unknown and refused', () => {
  const dir = tmpDir(), a = new AccessStore(dir), t0 = 1_000_000_000_000, id = randomUUID();
  assert.deepEqual(a.claimStatus(id, t0), { status: 'pending' });
  assert.deepEqual(a.issueFromClaim(id, { orderId: '1', now: t0 }), { ok: true, duplicate: false });
  const r = a.claimStatus(id, t0 + 1000); assert.equal(r.status, 'ready');
  assert.deepEqual(a.claimStatus(id, t0 + 2000), { status: 'unknown' }, 'ready is answered once');
  assert.ok(a.readClaims().claims[0].collected && !('box' in a.readClaims().claims[0]), 'marked collected, the sealed token dropped');
  // never collected: ready until the TTL, then unknown
  const late = randomUUID(); a.issueFromClaim(late, { orderId: '1b', now: t0 });
  assert.deepEqual(a.claimStatus(late, t0 + CLAIM_TTL_MS), { status: 'unknown' });
  assert.equal(a.claimStatus(late, t0 + CLAIM_TTL_MS - 1).status, 'ready');
  // the token itself outlives the claim: it's in verified.json for good
  assert.equal(canCreateRoom(a, { verifiedToken: r.token }).ok, true);
  // replayed after the claim expired: still a duplicate, the claim doesn't come back
  assert.deepEqual(a.issueFromClaim(id, { orderId: '1', now: t0 + 2 * CLAIM_TTL_MS }), { ok: true, duplicate: true });
  assert.deepEqual(a.claimStatus(id, t0 + 2 * CLAIM_TTL_MS), { status: 'unknown' });
  for (const bad of ['', 'x', id.toUpperCase(), id + ' ', '../' + id, 'a'.repeat(5000), null, 5]) assert.deepEqual(a.claimStatus(/** @type {any} */ (bad), t0), { status: 'unknown' });
  // a write a day later drops the expired entries
  a.issueFromClaim(randomUUID(), { orderId: '2', now: t0 + 26 * 3600_000 });
  assert.equal(a.readClaims().claims.length, 1);
  // a refund before the browser collected: the claim stops handing the token out (its box is still there)
  const id3 = randomUUID(); a.issueFromClaim(id3, { orderId: '3', now: t0 + 27 * 3600_000 });
  const v = a.readVerified(); v.tokens.find(t => t.orderId === '3').revoked = new Date().toISOString(); fs.writeFileSync(a.verifiedFile, JSON.stringify(v));
  assert.deepEqual(a.claimStatus(id3, t0 + 27 * 3600_000), { status: 'unknown' });
  assert.ok(a.readClaims().claims.find(x => x.orderId === '3').box, 'unknown because revoked, not because collected');
  // a tampered box is unknown, not a crash
  const id4 = randomUUID(); a.issueFromClaim(id4, { orderId: '4', now: t0 + 27 * 3600_000 });
  const c = a.readClaims(); c.claims.find(x => x.orderId === '4').box = 'AAAA.BBBB.CCCC'; fs.writeFileSync(a.claimsFile, JSON.stringify(c));
  assert.deepEqual(a.claimStatus(id4, t0 + 27 * 3600_000), { status: 'unknown' });
});

test('(ls-f) both paths converge: a redeemed code\'s token and a paid order\'s token get the same answer from canCreateRoom, through the same identify()', () => {
  const dir = tmpDir(), a = new AccessStore(dir);
  const redeemed = a.redeem(a.createCode({ label: 'Nacho' }).code);
  assert.ok(redeemed.ok);
  const claimId = randomUUID(); a.issueFromClaim(claimId, { orderId: '77' });
  const paid = a.claimStatus(claimId);
  assert.equal(paid.status, 'ready');
  const byCode = canCreateRoom(a, { verifiedToken: redeemed.token }), byPayment = canCreateRoom(a, { verifiedToken: paid.token });
  assert.deepEqual(Object.keys(byCode).sort(), Object.keys(byPayment).sort());
  assert.equal(byCode.ok, true); assert.equal(byPayment.ok, true);
  assert.match(byCode.who, /^[0-9a-f]{64}$/); assert.match(byPayment.who, /^[0-9a-f]{64}$/); assert.notEqual(byCode.who, byPayment.who);
  assert.equal(byCode.label, 'Nacho'); assert.equal(byPayment.label, 'Paid order 77');
  // and the same refusals
  assert.deepEqual(canCreateRoom(a, { verifiedToken: flip(paid.token) }), { ok: false, reason: 'unverified' });
  assert.deepEqual(canCreateRoom(a, { verifiedToken: '' }), { ok: false, reason: 'unverified' });
});

test('(ls-h) the claim id travels only in a POST body: GET /access/claim?claim_id=… is not a route (404, no token, nothing in the answer), POST with it in the query string ignores it', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, LS);
  try {
    const claimId = randomUUID();
    assert.equal((await hook(srv, order({ claimId, orderId: '3003' }))).status, 200);
    const viaGet = await fetch(srv.httpUrl + '/access/claim?claim_id=' + claimId), text = await viaGet.text();
    assert.equal(viaGet.status, 404); assert.ok(!/token|ready/.test(text), text);
    const viaQuery = await fetch(srv.httpUrl + '/access/claim?claim_id=' + claimId, { method: 'POST', body: '{}' });
    assert.deepEqual(await viaQuery.json(), { status: 'unknown' }, 'the query string is never read');
    assert.equal((await fetch(srv.httpUrl + '/access/claim', { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await poll(srv, claimId)).body.status, 'ready', 'the body is');
  } finally { await srv.close(); }
});

test('(ls-i) a signed order_refunded revokes that order\'s token on the running server (no restart): canCreateRoom false, /verify 401, the entry kept and marked; a refund for an unknown order is a 200 no-op; a forged one does nothing', async () => {
  const dir = tmpDir(), cap = capture(), srv = await server(dir, 0, { ...LS, log: cap.log });
  try {
    const claimId = randomUUID();
    assert.equal((await hook(srv, order({ claimId, orderId: '4004' }))).status, 200);
    const other = randomUUID(); assert.equal((await hook(srv, order({ claimId: other, orderId: '4005' }))).status, 200);
    const tok = (await poll(srv, claimId)).body.token, tok2 = (await poll(srv, other)).body.token;
    const a = new AccessStore(dir);
    assert.equal(canCreateRoom(a, { verifiedToken: tok }).ok, true);
    // forged: unsigned refund, 401, the token still stands
    assert.equal((await hook(srv, order({ event: 'order_refunded', orderId: '4004', status: 'refunded' }), { sig: null })).status, 401);
    assert.equal(canCreateRoom(a, { verifiedToken: tok }).ok, true);
    // the real one (status "refunded", or "partial_refund": the same event, the same answer)
    const refund = order({ event: 'order_refunded', orderId: '4004', status: 'partial_refund' });
    let r = await hook(srv, refund); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true });
    assert.deepEqual(canCreateRoom(a, { verifiedToken: tok }), { ok: false, reason: 'unverified' });
    assert.equal((await fetch(srv.httpUrl + '/verify', { headers: { authorization: 'Bearer ' + tok } })).status, 401, 'the server already in memory refuses it');
    const room = await fetch(srv.httpUrl + '/rooms', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: '{"name":"Refunded"}' });
    assert.equal(room.status, 401);
    assert.deepEqual((await poll(srv, claimId)).body, { status: 'unknown' }, 'the claim stops handing it out too');
    // kept, marked with when; the other order untouched
    const e = tokens(dir).find(t => t.orderId === '4004');
    assert.ok(e && !Number.isNaN(Date.parse(e.revoked))); assert.equal(tokens(dir).length, 2);
    assert.equal(canCreateRoom(a, { verifiedToken: tok2 }).ok, true);
    // a retried refund keeps the first timestamp; a replayed order_created doesn't bring the token back
    const when = e.revoked;
    assert.equal((await hook(srv, refund)).status, 200);
    assert.equal((await hook(srv, order({ orderId: '4004' }))).status, 200);
    assert.equal(tokens(dir).find(t => t.orderId === '4004').revoked, when); assert.equal(tokens(dir).length, 2);
    assert.equal(canCreateRoom(a, { verifiedToken: tok }).ok, false);
    // malformed order id, no data: acked, nothing written, nothing crashes
    const before = fs.readFileSync(path.join(dir, 'verified.json'), 'utf8');
    for (const b of [order({ event: 'order_refunded', orderId: '../x' }), { meta: { event_name: 'order_refunded' } }]) {
      r = await hook(srv, b); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true });
    }
    assert.equal(fs.readFileSync(path.join(dir, 'verified.json'), 'utf8'), before);
    // an order not seen yet: acked, recorded revoked with no token (ls-n covers its late order_created)
    r = await hook(srv, order({ event: 'order_refunded', orderId: '9999' })); assert.equal(r.status, 200);
    const early = tokens(dir).find(t => t.orderId === '9999');
    assert.ok(early && early.sha256 === null && !Number.isNaN(Date.parse(early.revoked)));
    assert.ok(cap.lines.some(l => /token revoked/.test(l) && /"order":"4004"/.test(l)));
    assert.ok(cap.lines.some(l => /before its order arrived/.test(l) && /"order":"9999"/.test(l)));
    assert.equal((await fetch(srv.httpUrl + '/health')).status, 200);
  } finally { await srv.close(); }
});

test('(ls-j) bin/revoke-order.mjs: revokes a paid order\'s token in revoked-orders.json (verified.json only read), says so again for a second run, exits 1 for an unknown order and 64 without one', () => {
  const dir = tmpDir(), a = new AccessStore(dir), claimId = randomUUID();
  a.issueFromClaim(claimId, { orderId: '6006' });
  const tok = a.claimStatus(claimId).token;
  const redeemed = a.redeem(a.createCode({ label: 'Nacho' }).code);
  const verifiedBefore = fs.readFileSync(a.verifiedFile, 'utf8');
  let r = cli('revoke-order', ['6006'], dir);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /revoked order 6006/);
  assert.deepEqual(canCreateRoom(a, { verifiedToken: tok }), { ok: false, reason: 'unverified' });
  assert.equal(canCreateRoom(a, { verifiedToken: redeemed.token }).ok, true, 'code tokens untouched');
  assert.equal(fs.readFileSync(a.verifiedFile, 'utf8'), verifiedBefore, 'the CLI never writes the server\'s file');
  const when = a.readRevokedOrders().orders.find(o => o.orderId === '6006').revoked; assert.ok(!Number.isNaN(Date.parse(when)));
  r = cli('revoke-order', ['6006'], dir); assert.equal(r.status, 0); assert.match(r.stdout, /already revoked/);
  assert.equal(a.readRevokedOrders().orders.length, 1);
  // an order not in verified.json yet: recorded anyway (its order_created, if it comes, issues nothing), said so
  r = cli('revoke-order', ['7007'], dir); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /no paid order 7007 .*recorded as revoked/);
  assert.equal(a.readRevokedOrders().orders.length, 2);
  const late = randomUUID(); assert.deepEqual(a.issueFromClaim(late, { orderId: '7007' }), { ok: true, duplicate: true, revoked: true });
  assert.deepEqual(a.claimStatus(late), { status: 'unknown' }, 'the late order hands out nothing');
  r = cli('revoke-order', ['../x'], dir); assert.equal(r.status, 1); assert.match(r.stderr, /not an order id/);
  r = cli('revoke-order', [], dir); assert.equal(r.status, 64);
  assert.equal(fs.statSync(a.revokedOrdersFile).mode & 0o777, 0o600);
  // an order the webhook already revoked (verified.json marked): the CLI says so and writes nothing
  const other = randomUUID(); a.issueFromClaim(other, { orderId: '6007' }); a.revokeOrder('6007');
  r = cli('revoke-order', ['6007'], dir); assert.match(r.stdout, /already revoked/); assert.equal(a.readRevokedOrders().orders.length, 2);
});

test('(ls-k) bin/revoke-order.mjs while the server runs and writes verified.json: no write is lost, the revocation holds and the new order stands', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, LS);
  try {
    const c1 = randomUUID(); assert.equal((await hook(srv, order({ claimId: c1, orderId: '8001' }))).status, 200);
    const tok1 = (await poll(srv, c1)).body.token;
    const r = cli('revoke-order', ['8001'], dir); assert.equal(r.status, 0, r.stderr);
    // the server writes verified.json right after (a new order): with one shared file this could drop the CLI's change
    const c2 = randomUUID(); assert.equal((await hook(srv, order({ claimId: c2, orderId: '8002' }))).status, 200);
    const tok2 = (await poll(srv, c2)).body.token;
    assert.equal((await fetch(srv.httpUrl + '/verify', { headers: { authorization: 'Bearer ' + tok1 } })).status, 401, 'revoked on the running server');
    assert.equal((await fetch(srv.httpUrl + '/verify', { headers: { authorization: 'Bearer ' + tok2 } })).status, 200);
    assert.equal(tokens(dir).length, 2);
    assert.deepEqual(new AccessStore(dir).readRevokedOrders().orders.map(o => o.orderId), ['8001']);
    // a refund webhook for an order the operator already revoked: acked, nothing more
    assert.equal((await hook(srv, order({ event: 'order_refunded', orderId: '8001', status: 'refunded' }))).status, 200);
    assert.equal(tokens(dir).find(t => t.orderId === '8001').revoked, undefined);
  } finally { await srv.close(); }
});

test('(ls-l) test mode: a test-mode order is acked and issues nothing by default (meta.test_mode or attributes.test_mode); with allowTestMode (LEMONSQUEEZY_ALLOW_TEST_MODE=1) it issues like a real one; restore follows the same rule', async () => {
  const dir = tmpDir(), cap = capture(), srv = await server(dir, 0, { ...LS, log: cap.log });
  try {
    const c1 = randomUUID(), viaMeta = order({ claimId: c1, orderId: '9101', testMode: true });
    const c2 = randomUUID(), viaAttrs = order({ claimId: c2, orderId: '9102' }); viaAttrs.data.attributes.test_mode = true;
    for (const b of [viaMeta, viaAttrs]) { const r = await hook(srv, b); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true }); }
    assert.equal(tokens(dir).length, 0); assert.ok(!fs.existsSync(path.join(dir, 'claims.json')));
    assert.deepEqual((await poll(srv, c1)).body, { status: 'pending' });
    assert.ok(cap.lines.some(l => /ignored: test mode/.test(l) && /"order":"9101"/.test(l)), 'the operator sees why');
    // a live order on the same server still works
    const c3 = randomUUID(); await hook(srv, order({ claimId: c3, orderId: '9103' }));
    assert.equal((await poll(srv, c3)).body.status, 'ready');
  } finally { await srv.close(); }
  const dir2 = tmpDir(), srv2 = await server(dir2, 0, { lemonSqueezy: { ...LS.lemonSqueezy, allowTestMode: true } });
  try {
    const c = randomUUID(); assert.equal((await hook(srv2, order({ claimId: c, orderId: '9201', testMode: true }))).status, 200);
    const p = await poll(srv2, c); assert.equal(p.body.status, 'ready');
    assert.equal((await fetch(srv2.httpUrl + '/verify', { headers: { authorization: 'Bearer ' + p.body.token } })).status, 200);
  } finally { await srv2.close(); }
  // restore: the same check on the order from the API
  const ls = { id: '9301', attributes: { order_number: 5, user_email: 'b@example.com', status: 'paid', test_mode: true, first_order_item: { variant_id: Number(VARIANT) } } };
  assert.deepEqual(matchOrder([ls], { orderNumber: '5', email: 'b@example.com' }, VARIANT), { reason: 'test mode' });
  assert.deepEqual(matchOrder([ls], { orderNumber: '5', email: 'b@example.com' }, VARIANT, true), { orderId: '9301' });
});

test('(ls-g) nothing secret leaks: logs and answers never carry the signing secret, the claim id, the token, the email or a stack trace; the claim poll is rate-limited per IP', async () => {
  const dir = tmpDir(), cap = capture(), srv = await server(dir, 0, { ...LS, log: cap.log, claimsPerMinute: 5, logLevel: 'debug' });
  const answers = [];
  try {
    const claimId = randomUUID(), body = order({ claimId, orderId: '555' });
    answers.push((await hook(srv, body, { sig: null })).text, (await hook(srv, null, { raw: '{"meta":' })).text, (await hook(srv, body)).text, (await hook(srv, body)).text);
    // a write failure: claims.json becomes a directory, so the next order can't be stored → 500, plain, and retried later
    fs.mkdirSync(path.join(dir, 'claims.json.tmp'));
    const failed = await hook(srv, order({ orderId: '556' })); answers.push(failed.text);
    assert.equal(failed.status, 500); assert.deepEqual(Object.keys(JSON.parse(failed.text)).sort(), ['error', 'message']);
    fs.rmdirSync(path.join(dir, 'claims.json.tmp'));
    const p = await poll(srv, claimId); assert.equal(p.body.status, 'ready');
    for (let i = 0; i < 4; i++) await poll(srv, randomUUID());   // 5 per minute: this was the fifth
    const limited = await fetch(srv.httpUrl + '/access/claim', { method: 'POST', body: JSON.stringify({ claim_id: claimId }) });
    assert.equal(limited.status, 429); assert.equal((await limited.json()).error, 'claim_limit');
    const all = cap.lines.join('\n') + answers.join('\n');
    for (const s of [SECRET, claimId, p.body.token, 'buyer@example.com', sign(JSON.stringify(body))]) assert.ok(!all.includes(s), 'leaked: ' + s.slice(0, 12));
    assert.ok(!/\bat .*\.mjs:\d+/.test(all), 'no stack traces');
    assert.ok(cap.lines.some(l => /token issued/.test(l) && /"order":"555"/.test(l)));
    assert.ok(cap.lines.some(l => /already processed/.test(l)));
  } finally { await srv.close(); }
});
