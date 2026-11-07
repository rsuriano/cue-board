// Lemon Squeezy paywall: the signed order webhook (src/webhooks/lemonsqueezy.mjs), claims (src/access.mjs), GET /access/claim.
// Port 0 (any free one): the fixed ports left near 3393-3399 belong to collab-client's media tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpDir, server } from './helpers.mjs';
import { AccessStore, canCreateRoom, CLAIM_TTL_MS } from '../src/access.mjs';

const SECRET = 'test-signing-secret-not-real', VARIANT = '424242';
const LS = { lemonSqueezy: { secret: SECRET, variantId: VARIANT } };
const sign = (raw, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
/** the same string with its first character changed, always (a fixed replacement is a no-op 1 time in 16 or 64) */
const flip = s => (s[0] === 'e' ? 'f' : 'e') + s.slice(1);
/** an order_created body shaped like Lemon Squeezy's (meta.event_name, meta.custom_data, data.id, data.attributes) */
function order({ orderId = '1001', claimId = randomUUID(), status = 'paid', variantId = Number(VARIANT), event = 'order_created', custom } = {}) {
  return {
    meta: { event_name: event, test_mode: false, custom_data: custom !== undefined ? custom : { claim_id: claimId } },
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
  const r = await fetch(srv.httpUrl + '/access/claim?claim_id=' + encodeURIComponent(claimId));
  return { status: r.status, body: await r.json() };
}
const tokens = dir => new AccessStore(dir).readVerified().tokens;
const capture = () => {
  const lines = [], rec = lv => (msg, fields = {}) => lines.push(JSON.stringify({ level: lv, msg, ...fields }));
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
};

test('(ls-a) a signed paid order issues one token: polling goes pending → ready, the token creates rooms; a replay of the same order (same or another claim id) issues nothing', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, LS);
  try {
    const claimId = randomUUID();
    assert.deepEqual((await poll(srv, claimId)).body, { status: 'pending' }, 'not seen yet: the webhook may be on its way');
    const body = order({ claimId });
    let r = await hook(srv, body); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true });
    const p = await poll(srv, claimId);
    assert.equal(p.body.status, 'ready'); assert.match(p.body.token, /^[A-Za-z0-9_-]{40,}$/); assert.equal(p.body.label, 'Paid order 1001');
    assert.deepEqual((await poll(srv, claimId)).body, p.body, 'polling again gives the same token');
    // the exact same delivery again, and a forged-claim variant of it (needs the signature, but still): no second token
    assert.equal((await hook(srv, body)).status, 200);
    assert.equal((await hook(srv, order({ orderId: '1001' }))).status, 200);
    assert.equal(tokens(dir).length, 1);
    // the shape the rest of the server reads, plus bookkeeping; nothing in clear on disk
    const t = tokens(dir)[0];
    assert.deepEqual(Object.keys(t).sort(), ['code', 'created', 'label', 'orderId', 'sha256', 'source']);
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
      order({ event: 'order_refunded' }), order({ event: 'subscription_created' }), order({ status: 'pending' }), order({ status: 'refunded' }),
      order({ variantId: 999 }), order({ variantId: null }),
      order({ custom: undefined }), order({ custom: null }), order({ custom: {} }), order({ custom: 'claim' }), order({ custom: { claim_id: 42 } }),
      order({ custom: { claim_id: 'not-a-uuid' } }), order({ custom: { claim_id: '00000000-0000-0000-0000-000000000000' } }),
      order({ custom: { claim_id: randomUUID() + 'x' } }), order({ orderId: '../../etc' }), order({ orderId: '' }),
      {}, { meta: null, data: null }, [], 'a string', 5, null,
    ];
    // custom: undefined means "omit custom_data entirely"
    delete cases[6].meta.custom_data;
    for (const [i, b] of cases.entries()) { const r = await hook(srv, b); assert.equal(r.status, 200, 'case ' + i); assert.deepEqual(JSON.parse(r.text), { ok: true }, 'case ' + i); }
    assert.equal(tokens(dir).length, 0); assert.ok(!fs.existsSync(path.join(dir, 'claims.json')));
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

test('(ls-e) claims: pending → ready → unknown after the TTL; malformed ids are unknown; old entries are dropped on the next write; a revoked paid token is unknown and refused', () => {
  const dir = tmpDir(), a = new AccessStore(dir), t0 = 1_000_000_000_000, id = randomUUID();
  assert.deepEqual(a.claimStatus(id, t0), { status: 'pending' });
  assert.deepEqual(a.issueFromClaim(id, { orderId: '1', now: t0 }), { ok: true, duplicate: false });
  const r = a.claimStatus(id, t0 + 1000); assert.equal(r.status, 'ready');
  assert.deepEqual(a.claimStatus(id, t0 + CLAIM_TTL_MS - 1), r);
  assert.deepEqual(a.claimStatus(id, t0 + CLAIM_TTL_MS), { status: 'unknown' });
  // the token itself outlives the claim: it's in verified.json for good
  assert.equal(canCreateRoom(a, { verifiedToken: r.token }).ok, true);
  // replayed after the claim expired: still a duplicate, the claim doesn't come back
  assert.deepEqual(a.issueFromClaim(id, { orderId: '1', now: t0 + 2 * CLAIM_TTL_MS }), { ok: true, duplicate: true });
  assert.deepEqual(a.claimStatus(id, t0 + 2 * CLAIM_TTL_MS), { status: 'unknown' });
  for (const bad of ['', 'x', id.toUpperCase(), id + ' ', '../' + id, 'a'.repeat(5000), null, 5]) assert.deepEqual(a.claimStatus(/** @type {any} */ (bad), t0), { status: 'unknown' });
  // a write a day later drops the expired entry
  a.issueFromClaim(randomUUID(), { orderId: '2', now: t0 + 26 * 3600_000 });
  assert.equal(a.readClaims().claims.length, 1);
  // a refund: the operator marks the token revoked; the claim and the token stop working
  const id3 = randomUUID(); a.issueFromClaim(id3, { orderId: '3', now: t0 + 27 * 3600_000 });
  const tok3 = a.claimStatus(id3, t0 + 27 * 3600_000).token;
  const v = a.readVerified(); v.tokens.find(t => t.orderId === '3').revoked = new Date().toISOString(); fs.writeFileSync(a.verifiedFile, JSON.stringify(v));
  assert.equal(canCreateRoom(a, { verifiedToken: tok3 }).ok, false);
  assert.deepEqual(a.claimStatus(id3, t0 + 27 * 3600_000), { status: 'unknown' });
  // a tampered box is unknown, not a crash
  const c = a.readClaims(); c.claims[0].box = 'AAAA.BBBB.CCCC'; fs.writeFileSync(a.claimsFile, JSON.stringify(c));
  assert.deepEqual(a.claimStatus(id3, t0 + 27 * 3600_000), { status: 'unknown' });
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
    const limited = await fetch(srv.httpUrl + '/access/claim?claim_id=' + claimId);
    assert.equal(limited.status, 429); assert.equal((await limited.json()).error, 'claim_limit');
    const all = cap.lines.join('\n') + answers.join('\n');
    for (const s of [SECRET, claimId, p.body.token, 'buyer@example.com', sign(JSON.stringify(body))]) assert.ok(!all.includes(s), 'leaked: ' + s.slice(0, 12));
    assert.ok(!/\bat .*\.mjs:\d+/.test(all), 'no stack traces');
    assert.ok(cap.lines.some(l => /token issued/.test(l) && /"order":"555"/.test(l)));
    assert.ok(cap.lines.some(l => /already processed/.test(l)));
  } finally { await srv.close(); }
});
