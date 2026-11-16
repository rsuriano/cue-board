// Products sold on Gumroad (gumroadProductId): the same flow as Lemon Squeezy (log in by email → one-hour ticket →
// session → a daily check), against a fake Gumroad API. No real API is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { auth, payload, DAY } from './helpers.mjs';
import { verifyToken } from '../src/token.mjs';
import { Users } from '../src/users.mjs';

const CUE = 'cueAAAA-EigMEsVmxxRQ==', OTHER = 'otherBB-EigMEsVmxxRQ==';
const PRODUCTS = [
  { id: 'cue-board', name: 'Cue Board', gumroadProductId: CUE, lsProductId: null, appUrl: 'https://cue.example.dev/' },
  { id: 'other', name: 'Other app', gumroadProductId: OTHER, lsProductId: null, appUrl: 'https://other.example.dev/' },
];
const linkKey = mail => new URL(/https:\/\/\S+/.exec(mail.text)[0]).searchParams.get('key');
const login = (a, email, product = 'cue-board') => a.call('POST', '/login', { email, product });
const session = (a, key, product = 'cue-board') => a.call('POST', '/session', { key, product });
const grCalls = a => a.up.calls.filter(c => c.startsWith('api.gumroad.com'));
/** log in by email and open a session with the emailed link: the session token, or null when no email came */
async function logIn(a, email) {
  const n = a.up.mails.length;
  await login(a, email); await a.srv.idle();
  if (a.up.mails.length === n) return null;
  const r = await session(a, linkKey(a.up.mails.at(-1)));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.session;
}

test('gumroad: a good sale gets the login email; its link opens a session; the sale id is kept server side only', async () => {
  const a = await auth({ products: PRODUCTS, loginPerHour: 100 });
  try {
    const sale = a.up.sell('Ana@Example.com', CUE);
    const buyer = await login(a, ' ana@example.com ');
    const stranger = await login(a, 'nobody@example.com');
    assert.equal(buyer.status, 200); assert.equal(stranger.text, buyer.text, 'buyers and strangers get the same answer');
    await a.srv.idle();
    assert.equal(a.up.mails.length, 1); assert.deepEqual(a.up.mails[0].to, ['ana@example.com']);
    assert.ok(!JSON.stringify(a.up.mails).includes(sale.id), 'the email never carries the sale id');
    const ticket = linkKey(a.up.mails[0]);
    assert.deepEqual([payload(ticket).typ, payload(ticket).src], ['ticket', 'purchase']);
    const r = await session(a, ticket);
    assert.equal(r.status, 200); assert.equal(r.body.email, 'ana@example.com');
    const p = verifyToken(a.keys.publicKey, r.body.session, a.clock.t);
    assert.deepEqual([p.typ, p.sub, p.prd, p.src], ['session', 'ana@example.com', 'cue-board', 'purchase']);
    const users = new Users(a.dir);
    assert.equal(users.get('ana@example.com', 'cue-board').ref, sale.id, 'the daily check has the sale id'); users.close();
    assert.ok(!a.up.calls.some(c => c.includes('lemonsqueezy')), 'Lemon Squeezy is never asked for a Gumroad product');
    assert.equal((await session(a, ticket, 'other')).status, 401, 'a ticket is for its own product');
    const log = a.lines.join('\n');
    for (const secret of [sale.id, 'test-gr', 'ana@example.com', ticket, r.body.session]) assert.ok(!log.includes(secret), 'never logged: ' + secret.slice(0, 12));
  } finally { await a.srv.close(); }
});

test('gumroad: refunded, chargedback, disputed or another product\'s sale opens no session', async () => {
  const a = await auth({ products: PRODUCTS, loginPerHour: 100 });
  try {
    a.up.sell('refund@example.com', CUE, { refunded: true });
    a.up.sell('charge@example.com', CUE, { chargedback: true });
    a.up.sell('dispute@example.com', CUE, { disputed: true });
    a.up.sell('other@example.com', OTHER);
    a.up.sell('won@example.com', CUE, { disputed: true, dispute_won: true });
    a.up.sell('partial@example.com', CUE, { partially_refunded: true });
    for (const e of ['refund', 'charge', 'dispute', 'other']) assert.equal(await logIn(a, e + '@example.com'), null, e + ': no email');
    assert.ok(await logIn(a, 'won@example.com'), 'a dispute won counts again');
    assert.ok(await logIn(a, 'partial@example.com'), 'a partial refund still counts');
    // a ticket made while the sale was good opens nothing once it is refunded
    const s = a.up.sell('late@example.com', CUE);
    await login(a, 'late@example.com'); await a.srv.idle();
    s.refunded = true;
    const r = await session(a, linkKey(a.up.mails.at(-1)));
    assert.equal(r.status, 401); assert.equal(r.body.error, 'bad_key');
  } finally { await a.srv.close(); }
});

test('gumroad: the email filter is checked again, and pages are followed', async () => {
  const a = await auth({ products: PRODUCTS, loginPerHour: 100 });
  try {
    a.up.grPageSize = 2;
    for (let i = 0; i < 5; i++) a.up.sell('many@example.com', CUE, { refunded: true });
    a.up.sell('many@example.com', CUE);
    await login(a, 'many@example.com'); await a.srv.idle();
    assert.equal(a.up.mails.length, 1, 'the good sale on page 3 is found');
    assert.equal(grCalls(a).filter(c => c.endsWith('/v2/sales')).length, 3, 'three pages');
    // a Gumroad that ignores the email filter: someone else's sale lets nobody in
    const fetch0 = a.up.fetch;
    a.up.sell('ana@example.com', CUE);
    const ignoring = await auth({ products: PRODUCTS, up: { ...a.up, fetch: (url, init) => { const u = new URL(url); u.searchParams.delete('email'); return fetch0(u.href, init); } } });
    try { assert.equal(await logIn(ignoring, 'mallory@example.com'), null); } finally { await ignoring.srv.close(); }
  } finally { await a.srv.close(); }
});

test('gumroad: the daily check re-checks the sale: good renews, refunded or unknown signs out', async () => {
  const a = await auth({ products: PRODUCTS, loginPerHour: 100 });
  try {
    const sale = a.up.sell('ana@example.com', CUE);
    const s = await logIn(a, 'ana@example.com');
    const n = grCalls(a).length;
    a.clock.t += 23 * 3600_000;
    let r = await a.call('POST', '/session', { session: s });
    assert.equal(r.body.session, s); assert.equal(grCalls(a).length, n, 'no check within the day');
    a.clock.t += 2 * 3600_000;
    r = await a.call('POST', '/session', { session: s });
    assert.equal(r.status, 200); assert.notEqual(r.body.session, s);
    assert.ok(grCalls(a).slice(n).some(c => c === 'api.gumroad.com/v2/sales/' + encodeURIComponent(sale.id)), 'the sale itself is asked for');
    const fresh = r.body.session;
    sale.refunded = true;
    a.clock.t += DAY + 1;
    r = await a.call('POST', '/session', { session: fresh });
    assert.equal(r.status, 401); assert.equal(r.body.error, 'signed_out');
    // an unknown sale id (404 from Gumroad) is not an outage: signed out
    const b = a.up.sell('luis@example.com', CUE);
    const t = await logIn(a, 'luis@example.com');
    a.up.sales.splice(a.up.sales.indexOf(b), 1);
    a.clock.t += DAY + 1;
    r = await a.call('POST', '/session', { session: t });
    assert.equal(r.status, 401); assert.equal(r.body.error, 'signed_out');
  } finally { await a.srv.close(); }
});

test('gumroad: down, 5xx, 429 or a bad token is an outage: "upstream", nobody is counted or logged out', async () => {
  const a = await auth({ products: PRODUCTS, trustProxy: true, loginPerHour: 5, failMax: 5 });
  try {
    a.up.sell('ana@example.com', CUE);
    const s = await logIn(a, 'ana@example.com');
    a.clock.t += DAY + 1;
    await login(a, 'ana@example.com'); await a.srv.idle();
    const ticket = linkKey(a.up.mails.at(-1));
    for (const outage of [() => { a.up.grDown = true; }, () => { a.up.grStatus = 500; }, () => { a.up.grStatus = 429; }, () => { a.up.grStatus = 401; }]) {
      a.up.grDown = false; a.up.grStatus = null; outage();
      let r = await a.call('POST', '/session', { session: s });
      assert.equal(r.status, 503); assert.equal(r.body.error, 'upstream');
      r = await session(a, ticket);
      assert.equal(r.status, 503); assert.equal(r.body.error, 'upstream');
    }
    // ten logins from one IP during the outage: none counted against the IP or the email
    a.up.grStatus = 503;
    for (let i = 0; i < 10; i++) await a.call('POST', '/login', { email: 'ana@example.com', product: 'cue-board' }, { 'x-forwarded-for': '10.0.0.9' });
    await a.srv.idle();
    a.up.grStatus = null;
    const n = a.up.mails.length;
    await a.call('POST', '/login', { email: 'ana@example.com', product: 'cue-board' }, { 'x-forwarded-for': '10.0.0.9' }); await a.srv.idle();
    assert.equal(a.up.mails.length, n + 1, 'the outage blocked neither the IP nor the email');
    // and the session is still good after Gumroad comes back
    assert.equal((await a.call('POST', '/session', { session: s })).status, 200);
    assert.equal((await session(a, ticket)).status, 200, 'and no failure was counted for the ticket');
  } finally { await a.srv.close(); }
});

test('gumroad: a non-ticket key is bad_key and counts as a failure; no token = log in by email is off', async () => {
  const a = await auth({ products: PRODUCTS, failMax: 3 });
  try {
    const sale = a.up.sell('ana@example.com', CUE);
    for (const k of [sale.id, '38b1460a-5104-4067-a91d-77b872934d51']) {
      const r = await session(a, k);
      assert.equal(r.status, 401); assert.equal(r.body.error, 'bad_key');
    }
    assert.equal((await session(a, 'whatever')).body.error, 'too_many_attempts', 'the third miss blocks the IP');
    assert.deepEqual(grCalls(a), [], 'Gumroad is not asked for a key');
  } finally { await a.srv.close(); }
  const off = await auth({ products: PRODUCTS, gumroadToken: '' });
  try {
    off.up.sell('ana@example.com', CUE);
    const r = await login(off, 'ana@example.com');
    await off.srv.idle();
    assert.equal(r.status, 503); assert.equal(r.body.error, 'off'); assert.deepEqual(off.up.calls, []);
  } finally { await off.srv.close(); }
});

test('the repo\'s products.json sells Cue Board on Gumroad', async () => {
  const { default: products } = await import('../products.json', { with: { type: 'json' } });
  const cue = products.find(p => p.id === 'cue-board');
  assert.equal(cue.gumroadProductId, '6ytYbaDIL-EigMEsVmxxRQ=='); assert.equal(cue.lsProductId, null);
});
