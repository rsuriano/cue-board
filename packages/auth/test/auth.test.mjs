// The spec's approval criteria 1-5 and 8 (docs/specs/auth-paywall.md), against a fake Lemon Squeezy and Resend. No real API is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auth, payload, DAY } from './helpers.mjs';
import { verifyToken } from '../src/token.mjs';
import { CodeStore, createFailureLimiter, createBurstLimiter } from '../src/codes.mjs';
import { Users } from '../src/users.mjs';

const KEY = '38b1460a-5104-4067-a91d-77b872934d51', OTHER_KEY = '80e15db5-c796-436b-850c-8f9c98a48abe';
const linkKey = mail => new URL(/https:\/\/\S+/.exec(mail.text)[0]).searchParams.get('key');
const session = (a, key, product = 'cue-board') => a.call('POST', '/session', { key, product });
/** verified with the public key, the way the sync server does it */
const valid = (a, s) => verifyToken(a.keys.publicKey, s, a.clock.t);

test('(1) a purchase key for Cue Board opens a session; a key for another product, an unknown key or an unknown product is refused', async () => {
  const a = await auth();
  try {
    a.up.buy(KEY, 111, 'Ana@Example.com');
    a.up.buy(OTHER_KEY, 222, 'luis@example.com');
    let r = await session(a, KEY);
    assert.equal(r.status, 200); assert.equal(r.body.email, 'ana@example.com');
    const p = valid(a, r.body.session);
    assert.ok(p, 'signed with the service key'); assert.equal(p.typ, 'session'); assert.equal(p.prd, 'cue-board'); assert.equal(p.sub, 'ana@example.com'); assert.equal(p.src, 'purchase');
    assert.ok(Math.abs(p.exp - (a.clock.t + 365 * DAY)) < 1000, 'sessions last a year');
    assert.equal(verifyToken(a.keys.publicKey, 'x' + r.body.session, a.clock.t), null, 'tampered: refused');
    assert.ok(!a.up.calls.some(c => c.includes('activate')), 'validate only, never activate');
    r = await session(a, OTHER_KEY);
    assert.equal(r.status, 401); assert.equal(r.body.error, 'bad_key'); assert.equal(r.body.session, undefined);
    assert.equal((await session(a, OTHER_KEY, 'other')).status, 200, 'the same key is fine for its own product');
    assert.equal((await session(a, 'f00ba7-not-a-key')).status, 401);
    assert.equal((await session(a, KEY, 'nope')).status, 400);
    assert.equal((await a.call('POST', '/session', '{bad json')).status, 400);
  } finally { await a.srv.close(); }
});

test('(2) a disabled or expired key is refused at session creation; a refund (key disabled) ends the session at the daily revalidation, never sooner than asked', async () => {
  const a = await auth();
  try {
    a.up.buy(KEY, 111, 'ana@example.com');
    a.up.buy(OTHER_KEY, 111, 'luis@example.com', 'disabled');
    assert.equal((await session(a, OTHER_KEY)).status, 401);
    a.up.keys.get(OTHER_KEY).status = 'expired';
    assert.equal((await session(a, OTHER_KEY)).status, 401);
    const s = (await session(a, KEY)).body.session;
    // within the day: no call to Lemon Squeezy, the same session back
    const n = a.up.calls.length;
    a.clock.t += 23 * 3600_000;
    let r = await a.call('POST', '/session', { session: s });
    assert.equal(r.status, 200); assert.equal(r.body.session, s); assert.equal(a.up.calls.length, n, 'at most one check a day');
    // past a day: re-checked, still good, a fresher session (same expiry)
    a.clock.t += 2 * 3600_000;
    r = await a.call('POST', '/session', { session: s });
    assert.equal(r.status, 200); assert.notEqual(r.body.session, s); assert.equal(payload(r.body.session).exp, payload(s).exp);
    assert.equal(valid(a, s), null, 'the sync server refuses a session not checked in the last 24h');
    assert.ok(valid(a, r.body.session));
    const fresh = r.body.session;
    // refunded: Lemon Squeezy disables the key; Lemon Squeezy down meanwhile is not a refund
    a.up.keys.get(KEY).status = 'disabled';
    a.clock.t += DAY + 1;
    a.up.down = true;
    r = await a.call('POST', '/session', { session: fresh });
    assert.equal(r.status, 503); assert.equal(r.body.error, 'upstream');
    a.up.down = false;
    r = await a.call('POST', '/session', { session: fresh });
    assert.equal(r.status, 401); assert.equal(r.body.error, 'signed_out');
    assert.equal(valid(a, fresh), null);
    // a year on, a session is over even if the key is fine
    a.up.buy('5a5a5a5a-1111-2222-3333-444455556666', 111, 'eva@example.com');
    const y = (await session(a, '5a5a5a5a-1111-2222-3333-444455556666')).body.session;
    a.clock.t += 366 * DAY;
    assert.equal((await a.call('POST', '/session', { session: y })).status, 401);
  } finally { await a.srv.close(); }
});

test('(3) /login answers buyers and non-buyers identically; only a buyer gets the email, with the magic link to the app', async () => {
  const a = await auth();
  try {
    a.up.buy(KEY, 111, 'ana@example.com');
    a.up.buy(OTHER_KEY, 222, 'luis@example.com');
    const buyer = await a.call('POST', '/login', { email: ' Ana@Example.com ', product: 'cue-board' });
    const stranger = await a.call('POST', '/login', { email: 'nobody@example.com', product: 'cue-board' });
    const otherProduct = await a.call('POST', '/login', { email: 'luis@example.com', product: 'cue-board' });
    for (const r of [stranger, otherProduct]) {
      assert.equal(r.status, buyer.status); assert.equal(r.text, buyer.text);
      assert.equal(r.headers.get('content-type'), buyer.headers.get('content-type'));
    }
    assert.equal(buyer.status, 200); assert.match(buyer.body.message, /if there's a purchase/i);
    await a.srv.idle();
    assert.equal(a.up.mails.length, 1);
    const m = a.up.mails[0];
    assert.deepEqual(m.to, ['ana@example.com']); assert.equal(m.from, 'Bedrock Labs <login@example.dev>'); assert.ok(m.subject && m.text);
    assert.match(m.text, /^https:\/\/cue\.example\.dev\/\?key=/m);
    assert.ok(!JSON.stringify(m).includes(KEY), 'the email never carries the license key');
    const ticket = linkKey(m), t = payload(ticket);
    assert.deepEqual([t.typ, t.sub, t.prd, t.src, t.exp], ['ticket', 'ana@example.com', 'cue-board', 'purchase', a.clock.t + 3600_000], 'a one-hour purchase ticket');
    assert.ok(!Buffer.from(ticket.split('.')[0], 'base64url').toString().includes(KEY), 'not inside the ticket either');
    let r = await session(a, ticket);
    assert.equal(r.status, 200, 'and the link opens a session'); assert.equal(r.body.email, 'ana@example.com'); assert.equal(payload(r.body.session).src, 'purchase');
    const users = new Users(a.dir);
    assert.equal(users.get('ana@example.com', 'cue-board').ref, KEY, 'the daily check still has the key (server side only)'); users.close();
    assert.equal((await session(a, ticket, 'other')).status, 401, 'a ticket is for its own product');
    // like the invite ticket: good for an hour, then refused
    a.clock.t += 3600_000;
    r = await session(a, ticket); assert.equal(r.status, 401); assert.equal(r.body.error, 'bad_key');
    a.clock.t -= 3600_000;
    // a refunded order sends nothing (same answer), and an unused ticket from before opens nothing
    a.up.orders.get('ana@example.com')[0].status = 'refunded';
    a.up.keys.get(KEY).status = 'disabled';
    const refunded = await a.call('POST', '/login', { email: 'ana@example.com', product: 'cue-board' });
    assert.equal(refunded.text, buyer.text); await a.srv.idle(); assert.equal(a.up.mails.length, 1);
    assert.equal((await session(a, ticket)).status, 401, 'a refund ends the ticket too');
    assert.equal((await a.call('POST', '/login', { email: 'not an email', product: 'cue-board' })).status, 400);
  } finally { await a.srv.close(); }
});

test('/login is off for a product with no lsProductId: "off", and no call to Lemon Squeezy or Resend', async () => {
  const a = await auth({ products: [{ id: 'cue-board', name: 'Cue Board', lsProductId: null, appUrl: 'https://cue.example.dev/' }] });
  try {
    a.up.buy(KEY, 111, 'ana@example.com');
    const r = await a.call('POST', '/login', { email: 'ana@example.com', product: 'cue-board' });
    await a.srv.idle();
    assert.equal(r.status, 503); assert.equal(r.body.error, 'off');
    assert.deepEqual(a.up.calls, []); assert.equal(a.up.mails.length, 0);
  } finally { await a.srv.close(); }
});

test('(4) repeated misses trip the rate limit (per IP and per email) without changing the answer; Lemon Squeezy failures do not count', async () => {
  const a = await auth({ loginPerHour: 5, trustProxy: true });
  try {
    a.up.buy(KEY, 111, 'ana@example.com');
    const login = (email, ip) => a.call('POST', '/login', { email, product: 'cue-board' }, { 'x-forwarded-for': ip });
    const lookups = () => a.up.calls.filter(c => c.endsWith('/v1/orders')).length;
    const first = await login('x0@example.com', '10.0.0.1');
    // Lemon Squeezy down: ten tries from one IP, none counted
    a.up.down = true;
    for (let i = 0; i < 10; i++) assert.equal((await login(`down${i}@example.com`, '10.0.0.2')).text, first.text);
    await a.srv.idle();
    a.up.down = false;
    await login('back@example.com', '10.0.0.2'); await a.srv.idle();
    const before = lookups();
    assert.ok(before >= 12, 'the outage did not block the IP');
    // misses from one IP: after 5 (one already made above from 10.0.0.1) no more lookups, same answer
    for (let i = 1; i < 8; i++) assert.equal((await login(`x${i}@example.com`, '10.0.0.1')).text, first.text);
    await a.srv.idle();
    assert.equal(lookups() - before, 4, 'stopped at 5 lookups for the IP');
    // the buyer, from that IP: still the same answer, but no lookup (blocked IP)
    const mails = a.up.mails.length;
    await login('ana@example.com', '10.0.0.1'); await a.srv.idle(); assert.equal(a.up.mails.length, mails);
    // per email, from many IPs
    const n = lookups();
    for (let i = 0; i < 8; i++) await login('target@example.com', `10.1.0.${i}`);
    await a.srv.idle();
    assert.equal(lookups() - n, 5, 'stopped at 5 lookups for the email');
    // the window passes
    a.clock.t += 3600_000 + 1;
    await login('ana@example.com', '10.0.0.1'); await a.srv.idle(); assert.equal(a.up.mails.length, mails + 1);
  } finally { await a.srv.close(); }
});

test('(5) an invite code + email opens a session; maxUsers is enforced; revoking the code ends its users\' access; wrong codes are rate-limited', async () => {
  const a = await auth({ failMax: 5 });
  try {
    const codes = new CodeStore(a.dir), c = codes.createCode({ label: 'Nacho', maxUsers: 1 });
    assert.match(c.code, /^[A-Za-z0-9_-]{16}$/, '96 random bits');
    assert.ok(!fs.readFileSync(path.join(a.dir, 'codes.json'), 'utf8').includes(c.code), 'stored hashed');
    let r = await a.call('POST', '/redeem', { email: 'nacho@example.com', code: c.code, product: 'cue-board' });
    assert.equal(r.status, 200);
    await a.srv.idle();
    assert.equal(a.up.mails.length, 1); assert.deepEqual(a.up.mails[0].to, ['nacho@example.com']);
    const ticket = linkKey(a.up.mails[0]);
    r = await session(a, ticket);
    assert.equal(r.status, 200); const p = valid(a, r.body.session);
    assert.equal(p.sub, 'nacho@example.com'); assert.equal(p.src, 'invite:Nacho');
    assert.equal((await session(a, ticket, 'other')).status, 401, 'a ticket is for its own product');
    // the same person again does not take a second seat; someone else does not fit
    assert.equal((await a.call('POST', '/redeem', { email: 'nacho@example.com', code: c.code, product: 'cue-board' })).status, 200);
    r = await a.call('POST', '/redeem', { email: 'ana@example.com', code: c.code, product: 'cue-board' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'code_full');
    // revoked: no new redeems, and its users are out at the next daily check
    const s = (await session(a, ticket)).body.session;
    codes.revokeCode(c.id);
    assert.equal((await a.call('POST', '/redeem', { email: 'nacho@example.com', code: c.code, product: 'cue-board' })).status, 403);
    assert.equal((await session(a, ticket)).status, 401, 'an unused link of a revoked code opens nothing');
    a.clock.t += DAY + 1;
    r = await a.call('POST', '/session', { session: s });
    assert.equal(r.status, 401); assert.equal(r.body.error, 'signed_out');
    // wrong codes: 5 failures block the IP (a right code too, while blocked)
    const d = codes.createCode({ label: 'Group' });
    for (let i = 0; i < 4; i++) assert.equal((await a.call('POST', '/redeem', { email: 'g@example.com', code: 'not-a-code-at-all', product: 'cue-board' })).status, 401);
    r = await a.call('POST', '/redeem', { email: 'g@example.com', code: 'not-a-code-at-all', product: 'cue-board' });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'too_many_attempts');
    assert.equal((await a.call('POST', '/redeem', { email: 'g@example.com', code: d.code, product: 'cue-board' })).status, 429);
  } finally { await a.srv.close(); }
});

test('(8) the users table gets one row on the first session and updates last_login after that', async () => {
  const a = await auth();
  try {
    a.up.buy(KEY, 111, 'ana@example.com');
    await session(a, KEY);
    const users = new Users(a.dir);
    let rows = users.all();
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], created: undefined, last_login: undefined }, { email: 'ana@example.com', product: 'cue-board', source: 'purchase', created: undefined, last_login: undefined });
    assert.equal(rows[0].created, rows[0].last_login);
    const created = rows[0].created;
    a.clock.t += 3 * DAY;
    await session(a, KEY);
    rows = users.all();
    assert.equal(rows.length, 1); assert.equal(rows[0].created, created);
    assert.equal(rows[0].last_login, new Date(a.clock.t).toISOString());
    users.close();
  } finally { await a.srv.close(); }
});

test('secrets stay out of the log; the code CLIs round-trip; no signing key or no mail key = that part is off, /health still answers', async () => {
  const a = await auth();
  try {
    a.up.buy(KEY, 111, 'ana.secret@example.com');
    const c = new CodeStore(a.dir).createCode({ label: 'Nacho' });
    const s = (await session(a, KEY)).body.session;
    await a.call('POST', '/login', { email: 'ana.secret@example.com', product: 'cue-board' });
    await a.call('POST', '/redeem', { email: 'ana.secret@example.com', code: c.code, product: 'cue-board' });
    await a.call('POST', '/session', { session: s });
    await a.srv.idle();
    const tickets = a.up.mails.map(linkKey), loginTicket = tickets.find(t => payload(t).src === 'purchase'), ticket = tickets.find(t => payload(t).code);
    await session(a, loginTicket);
    const log = a.lines.join('\n');
    assert.ok(a.lines.length > 3, 'something was logged');
    for (const secret of [KEY, s, c.code, ticket, loginTicket, 'ana.secret@example.com', 'test-ls', 'test-resend']) assert.ok(!log.includes(secret), 'never logged: ' + secret.slice(0, 12));
    assert.ok(!JSON.stringify(a.up.mails).includes(KEY), 'never emailed: the license key');
    const sql = fs.readFileSync(path.join(a.dir, 'users.db')).toString('latin1');
    assert.ok(!sql.includes(c.code), 'codes never reach the users table');
  } finally { await a.srv.close(); }
  const bin = n => fileURLToPath(new URL(`../bin/${n}.mjs`, import.meta.url));
  const dir = a.dir, cli = (name, args) => spawnSync(process.execPath, [bin(name), ...args, '--data-dir', dir], { encoding: 'utf8' });
  let out = cli('create-code', ['--label', 'Luis', '--max-users', '2']); assert.equal(out.status, 0, out.stderr);
  const id = /id: +(\S+)/.exec(out.stdout)[1];
  out = cli('list-codes', []); assert.match(out.stdout, new RegExp(`${id} +active +0/2 used .*Luis`));
  assert.match(out.stdout, /Nacho/);
  assert.equal(cli('revoke-code', [id]).status, 0);
  assert.match(cli('list-codes', []).stdout, new RegExp(`${id} +revoked`));
  assert.equal(cli('revoke-code', ['c-nope']).status, 1);
  assert.equal(cli('create-code', ['--label', 'x', '--max-users', '0']).status, 1);

  const off = await auth({ signingKey: null, resendKey: '' });
  try {
    assert.equal((await off.call('GET', '/health')).status, 200);
    assert.equal((await off.call('POST', '/session', { key: KEY, product: 'cue-board' })).status, 503);
    assert.equal((await off.call('POST', '/redeem', { email: 'a@example.com', code: 'x'.repeat(16), product: 'cue-board' })).status, 503);
    assert.equal((await off.call('POST', '/login', { email: 'a@example.com', product: 'cue-board' })).status, 503);
  } finally { await off.srv.close(); }
});

test('limiters on their own (moved from the sync server): failures expire only with time, the block ends, maps stay bounded; untake gives one back', () => {
  let t = 0; const now = () => t;
  const f = createFailureLimiter({ max: 3, blockMs: 1000, now });
  assert.equal(f.fail('a'), false); assert.equal(f.fail('a'), false);
  assert.equal(f.fail('a'), true); assert.equal(f.blocked('a'), 1000); t = 999; assert.equal(f.blocked('a'), 1); t = 1000; assert.equal(f.blocked('a'), 0);
  for (let i = 0; i < 1500; i++) f.fail('k' + i); t += 5000; f.fail('z'); assert.ok(f.size() < 1500, 'stale entries are pruned');
  const b = createBurstLimiter({ max: 2, windowMs: 100, now });
  assert.ok(b.take('x')); assert.ok(b.take('x')); assert.ok(b.full('x')); b.untake('x'); assert.ok(b.take('x')); assert.ok(!b.take('x')); t += 101; assert.ok(b.take('x'));
});

test('CORS: the app origin gets its header and a preflight; any other origin is refused', async () => {
  const a = await auth();
  try {
    let r = await a.call('OPTIONS', '/session', undefined, { origin: 'https://cue.example.dev' });
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://cue.example.dev');
    r = await a.call('POST', '/login', { email: 'a@example.com', product: 'cue-board' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
  } finally { await a.srv.close(); }
});
