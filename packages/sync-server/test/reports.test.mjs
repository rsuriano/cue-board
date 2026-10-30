// Problem reports (src/reports.mjs, POST /reports in src/api.mjs, bin/*-report*.mjs) and the app's side of the same
// allow-list (the cue-report script in index.html's <head>, run here on its own). Port 3360.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, server } from './helpers.mjs';
import { cleanReport, scrub, ReportStore } from '../src/reports.mjs';

const PORT = 3360, ORIGIN = 'https://cue.example.dev';
const bin = n => fileURLToPath(new URL(`../bin/${n}.mjs`, import.meta.url));
const cli = (name, args, dir) => spawnSync(process.execPath, [bin(name), ...args, '--data-dir', dir], { encoding: 'utf8' });
const files = dir => { try { return fs.readdirSync(path.join(dir, 'reports')).sort(); } catch { return []; } };
const read = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, 'reports', n), 'utf8'));
/** a logger that keeps every line, at debug level */
const memLog = () => { const lines = []; const at = level => (msg, f = {}) => lines.push(JSON.stringify({ level, msg, ...f })); return { lines, log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }; };
/** POST /reports on a fresh connection (every test restarts the server on the same port; a pooled socket would be dead) */
function post(srv, body, { origin, ip, raw, type = 'application/json' } = {}) {
  const headers = { 'content-type': type };
  if (origin) headers.origin = origin;
  if (ip) headers['x-forwarded-for'] = ip;
  return new Promise((ok, no) => {
    const req = http.request(srv.httpUrl + '/reports', { method: 'POST', headers, agent: false }, res => {
      let t = ''; res.setEncoding('utf8'); res.on('data', d => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } ok({ status: res.statusCode, body: j, headers: new Headers(/** @type {any} */ (res.headers)) }); });
    });
    req.on('error', no); req.end(raw ?? JSON.stringify(body));
  });
}

// ---- the app's half, taken from index.html as it ships ----
const html = fs.readFileSync(fileURLToPath(new URL('../../../index.html', import.meta.url)), 'utf8');
const SRC = /<script id="cue-report">([\s\S]*?)<\/script>/.exec(html)[1];
class FakeErrorEvent { constructor(o) { Object.assign(this, o); } }
/** a fresh page: the script run against a window that records its listeners */
function page() {
  const on = {}, w = { addEventListener: (t, f) => { (on[t] ||= []).push(f); } };
  new Function('window', 'ErrorEvent', SRC)(w, FakeErrorEvent);
  return { r: w.cueReport, error: o => on.error.forEach(f => f(new FakeErrorEvent(o))), resourceError: () => on.error.forEach(f => f({ target: {} })), reject: reason => on.unhandledrejection.forEach(f => f({ reason })) };
}

// secrets of every kind the app holds; none may appear in a report
const ROOM = 'Q2hhbmdlTWVQbGVhc2UxMjM0', TOKEN = 'dG9rZW4tdGhhdC1sb29rcy1yZWFs', OWNER = 'b3duZXItdG9rZW4tc2VjcmV0LXh5ejk4Nw', KEY = 'sk-or-v1-9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const SECRETS = ['Kestrel Midnight', 'shot title ostrich', 'walrus notes', 'narwhal prompt', 'pangolin lyrics', 'axolotl.mp3', 'quokka-take.mp4', 'Zebra Room', ROOM, TOKEN, OWNER, KEY, 'VERIFYCODE7x', 'someone@example.com', 'data:image/png;base64,iVBORw0KGgo'];
const secretProject = {
  id: 'p-1', title: SECRETS[0], lyrics: SECRETS[4], song: { name: SECRETS[5], duration: 42 }, refs: ['m-ref'], apiKey: KEY, room: { roomId: ROOM, token: TOKEN, owner: OWNER, name: SECRETS[7] }, verified: { token: 'VERIFYCODE7x' },
  sections: [
    { id: 's1', start: 0, title: SECRETS[1], notes: SECRETS[2], imgPrompt: SECRETS[3], vidPrompt: SECRETS[3], img: SECRETS[14], takes: [{ id: 't1', name: SECRETS[6], prompt: SECRETS[3], media: 'm1' }] },
    { id: 's2', start: 10.04, title: SECRETS[13], notes: '', takes: [] },
  ],
};
const state = (extra = {}) => ({ build: 'abc1234', now: Date.parse('2026-10-30T12:00:00Z'), w: 390, h: 844, dpr: 3, phone: true, side: 'b', ua: 'Mozilla/5.0 (iPhone)', lang: 'es-AR', online: true,
  storage: { persisted: true, usage: 5 * 1048576, quota: 1024 * 1048576 }, save: 'Saved', collab: 'synced', files: [{ state: 'here', name: SECRETS[5] }, { state: 'queued' }, { state: 'failed' }, { state: 'weird' }], project: secretProject, duration: 42, ...extra });
const leaked = s => SECRETS.filter(x => s.includes(x));

test('(r1) the app builds the report field by field: a project full of secrets, a room, a key and errors carrying tokens and invite links leave nothing behind', () => {
  const p = page();
  p.error({ message: `Uncaught TypeError: failed https://cue.bedrocklabs.dev/#join=${ROOM}.${TOKEN}.${OWNER}`, filename: `https://cue.bedrocklabs.dev/index.html?v=${TOKEN}#join=${ROOM}.${TOKEN}`, lineno: 2101, colno: 7 });
  p.reject(Object.assign(new Error(`fetch wss://sync.bedrocklabs.dev/r/${ROOM}?token=${TOKEN} with Bearer ${OWNER} and ${KEY}`), { stack: `Error: x\n    at f (https://cue.bedrocklabs.dev/collab.js?t=${TOKEN}:12:5)` }));
  p.reject(`code=VERIFYCODE7x for someone@example.com`);
  const r = p.r.build(state(), { details: true, shape: true, text: `It broke. My link: https://cue.bedrocklabs.dev/#join=${ROOM}.${TOKEN}` });
  const s = JSON.stringify(r);
  assert.deepEqual(leaked(s), [], 'no secret in the report');
  assert.deepEqual(Object.keys(r), ['v', 'build', 'at', 'text', 'viewport', 'phone', 'side', 'ua', 'lang', 'online', 'storage', 'save', 'collab', 'media', 'errors', 'shape']);
  assert.equal(r.text, 'It broke. My link: https://cue.bedrocklabs.dev/');
  assert.deepEqual(r.viewport, { w: 390, h: 844, dpr: 3 });
  assert.deepEqual(r.storage, { persisted: true, usedMB: 5, quotaMB: 1024 });
  assert.deepEqual(r.media, { here: 1, queued: 1, downloading: 0, skipped: 0, failed: 1 });
  assert.deepEqual(r.shape, { shots: 2, lengths: [10, 32], takes: [1, 0] });
  assert.deepEqual(r.errors.map(e => e.at), ['index.html:2101:7', 'collab.js:12:5', undefined]);
  assert.match(r.errors[0].msg, /^Uncaught TypeError: failed https:\/\/cue\.bedrocklabs\.dev\/$/);
  assert.match(r.errors[1].msg, /Bearer \[redacted\]/);
  assert.match(r.errors[2].msg, /code=\[removed\] for \[email\]/);
  // what the app sends is already what the server stores
  assert.deepEqual(cleanReport(JSON.parse(s)), r);
});

test('(r2) details off: only the text (and build and time); shape off: no shots; an unknown collab state or language is not passed through', () => {
  const p = page(); p.error({ message: 'x', filename: 'https://h/index.html', lineno: 1 });
  assert.deepEqual(p.r.build(state(), { details: false, shape: false, text: '  hello  ' }), { v: 1, build: 'abc1234', at: '2026-10-30T12:00:00.000Z', text: 'hello' });
  const r = p.r.build(state({ collab: 'roomId-abc', lang: 'en"><script>', build: '' }), { details: true, shape: false, text: '' });
  assert.equal(r.collab, 'none'); assert.equal(r.lang, undefined); assert.equal(r.build, 'dev'); assert.equal(r.text, undefined); assert.equal(r.shape, undefined);
});

test('(r3) the error buffer keeps the last 20, counts repeats, clips each to 300 characters, ignores resource load errors and never throws on odd rejections', () => {
  const p = page();
  for (let i = 0; i < 30; i++) p.error({ message: 'err ' + i, filename: 'https://h/index.html', lineno: i });
  for (let i = 0; i < 3; i++) p.error({ message: 'loop', filename: 'https://h/index.html', lineno: 99 });
  p.resourceError();
  p.reject(undefined); p.reject(null); p.reject({ toString() { throw new Error('nope'); } }); p.reject({ message: 'm'.repeat(1000) });
  const e = p.r.errors();
  assert.equal(e.length, 20);
  assert.deepEqual(e.find(x => x.msg === 'loop'), { msg: 'loop', at: 'index.html:99', n: 3 });
  assert.equal(e.at(-1).msg.length, 300);
  assert.ok(e.some(x => x.msg === 'Unhandled rejection: undefined') && e.some(x => x.msg === 'Unhandled rejection: null'));
  assert.ok(!e.some(x => x.msg === 'err 0'), 'the oldest went first');
  // a page script (filename = the page's own URL) shows as "page"
  const q = page(); q.error({ message: 'x', filename: 'https://cue.bedrocklabs.dev/', lineno: 5, colno: 1 });
  assert.equal(q.r.errors()[0].at, 'page:5:1');
});

test('(r4) the app and the server scrub the same way, and scrubbing twice changes nothing', () => {
  const p = page();
  const cases = [
    `https://cue.bedrocklabs.dev/?room=${ROOM}&token=${TOKEN}#join=${ROOM}.${TOKEN}`, `see #join=${ROOM}.${TOKEN}.${OWNER} now`, `token=${TOKEN}; key=abc`, `Authorization: Bearer ${OWNER}`,
    `key ${KEY}`, 'mail me: someone@example.com', `TransactionInactiveError: the transaction ${TOKEN}`, 'QuotaExceededError: storage full', 'a\u001b[31mred\u0007\u2028b', 'tab\tand\nnewline',
    `wss://sync.bedrocklabs.dev/r/${ROOM}`, 'blob:https://cue.bedrocklabs.dev/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', 'x'.repeat(500),
  ];
  for (const c of cases) for (const lines of [false, true]) {
    const a = p.r.scrub(c, 300, lines), b = scrub(c, 300, lines);
    assert.equal(a, b, `same result for ${JSON.stringify(c).slice(0, 60)}`);
    assert.equal(scrub(b, 300, lines), b, 'idempotent');
    assert.deepEqual(leaked(b), []);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(b), 'no control characters');
  }
  assert.equal(scrub('QuotaExceededError: storage full', 300), 'QuotaExceededError: storage full', 'error names survive');
  assert.equal(scrub('tab\tand\nnewline', 300, true), 'tab\tand\nnewline');
});

test('(r5) the server cleans against the allow-list: unknown fields dropped (top level and nested), strings clipped, enums and numbers checked', () => {
  const big = 'y'.repeat(5000);
  const c = cleanReport({
    v: 99, build: big, at: 'not a date', text: big, viewport: { w: 1e9, h: -5, dpr: 'x', extra: 1 }, phone: 'yes', side: 'c', ua: big, lang: 'zz-ZZ', online: true,
    storage: { persisted: 'maybe', usedMB: 12.345, quotaMB: Infinity, path: '/etc' }, save: big, collab: 'roomid', media: { here: 2, secret: 5, failed: -1 },
    errors: Array.from({ length: 40 }, (_, i) => ({ msg: 'e' + i + ' ' + big, at: big, n: 3, stack: 'x' })), shape: { shots: 2, lengths: [1.26, 'x'], takes: [1, 2.6], titles: ['a'] },
    project: { title: 'secret' }, apiKey: KEY, __proto__: { polluted: true }, constructor: 'x',
  });
  assert.deepEqual(Object.keys(c).sort(), ['build', 'errors', 'lang', 'media', 'online', 'save', 'shape', 'storage', 'text', 'ua', 'v', 'viewport'].sort());
  assert.equal(c.v, 1); assert.equal(c.build.length, 40); assert.equal(c.text.length, 2000); assert.equal(c.ua.length, 400); assert.equal(c.save.length, 80);
  assert.deepEqual(c.viewport, { w: 20000, h: 0, dpr: 1 });
  assert.deepEqual(c.storage, { persisted: null, usedMB: 12.3, quotaMB: null });
  assert.deepEqual(c.media, { here: 2, failed: 0 });
  assert.equal(c.errors.length, 20); assert.ok(c.errors.every(e => e.msg.length === 300 && e.at.length === 120 && e.n === 3 && !('stack' in e)));
  assert.deepEqual(c.shape, { shots: 2, lengths: [1.3, 0], takes: [1, 3] });
  assert.equal(cleanReport([1, 2]), null); assert.equal(cleanReport('x'), null); assert.equal(cleanReport(null), null);
  assert.equal(({}).polluted, undefined);
  // strings built to make the patterns backtrack: a whole 16 KiB body of them is cleaned in well under a second
  const evil = ['a.'.repeat(8000), 'a'.repeat(16000), 'a@'.repeat(8000), 'x'.repeat(15) + ' '.repeat(1), 'ab-'.repeat(5000), 'http'.repeat(4000)];
  const t0 = performance.now();
  for (const e of evil) cleanReport({ text: e, ua: e, save: e, build: e, errors: Array.from({ length: 20 }, () => ({ msg: e, at: e })) });
  assert.ok(performance.now() - t0 < 500, `took ${Math.round(performance.now() - t0)} ms`);
});

test('(r6) POST /reports: stored as a 0600 file under reports/ (0700), 201 { id }; non-JSON, an array and oversize are refused; nothing of the report reaches the log, even at debug', async () => {
  const dir = tmpDir(), { lines, log } = memLog(), srv = await server(dir, PORT, { log, corsOrigins: [ORIGIN] });
  try {
    const text = 'The Takes tab went blank on my phone. CANARY ' + 'q'.repeat(10);
    let r = await post(srv, { text, ua: 'UA-CANARY', save: 'SAVE-CANARY', unknown: 'DROPPED-CANARY', errors: [{ msg: 'ERR-CANARY' }] }, { origin: ORIGIN });
    assert.equal(r.status, 201); assert.match(r.body.id, /^[a-z0-9]{10}$/); assert.deepEqual(Object.keys(r.body), ['id']);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    const [f] = files(dir); assert.match(f, new RegExp(`^\\d{8}T\\d{9}Z-${r.body.id}\\.json$`));
    assert.equal(fs.statSync(path.join(dir, 'reports', f)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'reports')).mode & 0o777, 0o700);
    const j = read(dir, f); assert.equal(j.text, text); assert.equal(j.id, r.body.id); assert.ok(!('unknown' in j));
    r = await post(srv, null, { raw: '{"text": "unterminated' }); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_request');
    r = await post(srv, null, { raw: '[1,2]' }); assert.equal(r.status, 400);
    r = await post(srv, null, { raw: 'text=hello', type: 'application/x-www-form-urlencoded' }); assert.equal(r.status, 400);
    r = await post(srv, { text: 'z'.repeat(17 * 1024) }); assert.equal(r.status, 413); assert.equal(r.body.error, 'too_large');
    const g = await fetch(srv.httpUrl + '/reports'); assert.equal(g.status, 404);
    assert.equal(files(dir).length, 1, 'refused bodies store nothing');
    const all = lines.join('\n');
    for (const canary of ['CANARY', 'Takes tab', 'qqqqqqqqqq']) assert.ok(!all.includes(canary), `the log has no ${canary}`);
    assert.ok(lines.some(l => /report stored/.test(l)));
  } finally { await srv.close(); }
});

test('(r7) limits: 5 per IP per hour, then a plain "try later"; another IP still gets through; the shared daily limit stops everyone and is checked first', async () => {
  const dir = tmpDir(), srv = await server(dir, PORT, { trustProxy: true, reportsPerDay: 8 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post(srv, { text: 'a' + i }, { ip: '203.0.113.1' })).status, 201);
    let r = await post(srv, { text: 'a6' }, { ip: '203.0.113.1' });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'report_limit'); assert.equal(r.body.message, 'Too many reports right now. Try again later.');
    for (let i = 0; i < 3; i++) assert.equal((await post(srv, { text: 'b' + i }, { ip: '203.0.113.' + (10 + i) })).status, 201);
    // 8 stored: the daily limit is reached for everyone, new addresses included
    r = await post(srv, { text: 'c' }, { ip: '198.51.100.7' }); assert.equal(r.status, 429);
    assert.equal(files(dir).length, 8);
    // a flood from many addresses after that is refused, every one of them, and stores nothing
    for (let i = 0; i < 20; i++) assert.equal((await post(srv, { text: 'flood' }, { ip: '192.0.2.' + i })).status, 429);
    assert.equal(files(dir).length, 8);
  } finally { await srv.close(); }
});

test('(r8) CORS: an allowed origin gets its preflight and answer; any other origin is refused and stores nothing', async () => {
  const dir = tmpDir(), srv = await server(dir, PORT, { corsOrigins: [ORIGIN] });
  try {
    // a preflight as a browser sends it (fetch() won't set these headers itself)
    const options = origin => new Promise((ok, no) => http.request(srv.httpUrl + '/reports', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }, res => { res.resume(); res.on('end', () => ok(res)); }).on('error', no).end());
    const pre = await options(ORIGIN);
    assert.equal(pre.statusCode, 204); assert.equal(pre.headers['access-control-allow-origin'], ORIGIN); assert.match(pre.headers['access-control-allow-headers'], /content-type/);
    const bad = await options('https://evil.example');
    assert.equal(bad.statusCode, 403); assert.equal(bad.headers['access-control-allow-origin'], undefined);
    const r = await post(srv, { text: 'x' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403); assert.equal(files(dir).length, 0);
  } finally { await srv.close(); }
});

test('(r9) retention: at most maxReports files, the oldest go first; reports survive a restart', async () => {
  const dir = tmpDir();
  let srv = await server(dir, PORT, { maxReports: 3, reportsPerHour: 100 });
  const ids = [];
  try { for (let i = 0; i < 5; i++) ids.push((await post(srv, { text: 'n' + i })).body.id); } finally { await srv.close(); }
  let kept = files(dir).map(n => read(dir, n).text);
  assert.equal(kept.length, 3); assert.ok(!kept.includes('n0') && !kept.includes('n1') && kept.includes('n4'), kept.join(','));
  srv = await server(dir, PORT, { maxReports: 3 });
  try {
    assert.equal(new ReportStore(dir).get(ids[4]).text, 'n4', 'still there after a restart');
    assert.equal((await post(srv, { text: 'n5' })).status, 201);
    kept = files(dir).map(n => read(dir, n).text); assert.equal(kept.length, 3); assert.ok(kept.includes('n5'));
  } finally { await srv.close(); }
});

test('(r10) the CLIs: list-reports newest first on one line each (no terminal escapes), show-report by id only (no paths), clear-reports --older-than', () => {
  const dir = tmpDir(), st = new ReportStore(dir);
  const now = Date.now(), old = new ReportStore(dir, { now: () => now - 40 * 86_400_000 });
  const a = old.add(cleanReport({ text: 'old one', build: 'aaa1111', phone: false }));
  const b = st.add(cleanReport({ text: 'Timeline\nblank\u001b[2J after loading a song, and then some more words to pass eighty characters for sure', build: 'bbb2222', phone: true, errors: [{ msg: 'x' }, { msg: 'y' }] }));
  // a file written by hand with escapes in it: the list still prints one clean line
  fs.writeFileSync(path.join(dir, 'reports', '20260101T000000000Z-handwritten.json'), '{}');
  fs.writeFileSync(path.join(dir, 'reports', '20260102T000000000Z-zzzzzzzzzz.json'), JSON.stringify({ id: 'zzzzzzzzzz', received: '2026-01-02T00:00:00.000Z', text: 'evil\u001b]0;pwned\u0007\u001b[31m' }));
  let r = cli('list-reports', [], dir);
  assert.equal(r.status, 0);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, 3, r.stdout); assert.ok(out[0].startsWith(b) && out[1].startsWith(a) && out[2].startsWith('zzzzzzzzzz'), 'newest first');
  assert.match(out[0], /bbb2222 +phone +2 err +Timeline blank \[2J after/); assert.ok(out[0].length < 160);
  assert.match(out[1], /desktop/);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.stdout), 'no control characters printed');
  r = cli('show-report', [b], dir); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).build, 'bbb2222');
  r = cli('show-report', ['zzzzzzzzzz'], dir); assert.ok(!/\u001b/.test(r.stdout), 'escapes stay escaped in JSON');
  for (const bad of ['../../etc/passwd', '..%2f', '/etc/passwd', 'handwritten', b + '/..', '']) { r = cli('show-report', [bad], dir); assert.equal(r.status, 64, bad); }
  r = cli('show-report', ['abcdefghij'], dir); assert.equal(r.status, 1); assert.match(r.stderr, /no report/);
  r = cli('clear-reports', ['--older-than', 'soon'], dir); assert.equal(r.status, 64);
  r = cli('clear-reports', ['--older-than', '30d'], dir); assert.equal(r.status, 0); assert.match(r.stdout, /removed 2 reports/);
  assert.ok(!st.get(a) && st.get(b));
  assert.equal(cli('list-reports', [], tmpDir()).stdout.trim(), 'no reports yet');
});
