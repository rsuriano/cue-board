// Rooms created from the app (a session from auth), owners (src/api.mjs, src/access.mjs). Ports 3368, 3375, 3377-3378, 3381-3383.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, server, makeRoom, client, synced, until, join, signSession } from './helpers.mjs';
import { createBurstLimiter } from '../src/access.mjs';
import { ProjectStore } from '../src/store.mjs';

const bin = n => fileURLToPath(new URL(`../bin/${n}.mjs`, import.meta.url));
const cli = (name, args, dir) => spawnSync(process.execPath, [bin(name), ...args, '--data-dir', dir], { encoding: 'utf8' });
/** HTTP call: { status, body, headers } */
async function api(srv, method, p, { token, body, origin, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(srv.httpUrl + p, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, headers: r.headers };
}
/** the provider's awareness keeps a timer until its doc is destroyed: both go */
const stop = (...cs) => cs.forEach(c => { c.provider.destroy(); c.doc.destroy(); });

test('(u) create room: no session 401 with a plain message; a session 201 with invite and owner tokens; the room joins and syncs; the project file keeps only hashes, never the email', async () => {
  const dir = tmpDir(), srv = await server(dir, 3375);
  try {
    let r = await api(srv, 'POST', '/rooms', { body: { name: 'My film' } });
    assert.equal(r.status, 401); assert.equal(r.body.error, 'no_session'); assert.match(r.body.message, /account/);
    const vt = signSession();
    r = await api(srv, 'POST', '/rooms', { token: vt, body: { name: ' My \u0000film\n  trailer ' } });
    assert.equal(r.status, 201); const { roomId, token, ownerToken } = r.body;
    assert.ok(roomId && token && ownerToken && token !== ownerToken);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, roomId, 'project.json'), 'utf8'));
    assert.equal(pj.name, 'My film trailer'); assert.equal(pj.owner.code, 'invite:Nacho'); assert.equal(pj.tokens.length, 1);
    const files = fs.readFileSync(path.join(dir, roomId, 'project.json'), 'utf8');
    for (const secret of [vt, token, ownerToken, 'ana@example.com']) assert.ok(!files.includes(secret), 'secrets are stored hashed only');
    // the room is a real room: the first invite token joins, and the doc is a new project (title = name)
    const a = client(srv, roomId, token); await synced(a.provider);
    assert.equal(a.doc.getMap('meta').get('title'), 'My film trailer');
    stop(a);
    assert.equal((await join(`${srv.url}/${roomId}?token=${ownerToken}`)).result, 4401, 'the owner token is not an invite token');
  } finally { await srv.close(); }
});

test('(v) the old code endpoint is gone (codes live in auth now); malformed input is a plain 400, never a crash', async () => {
  const dir = tmpDir(), srv = await server(dir, 3376);
  try {
    assert.equal((await api(srv, 'POST', '/verify', { body: { code: 'x'.repeat(16) } })).status, 404);
    assert.equal((await api(srv, 'GET', '/verify')).status, 404);
    const vt = signSession();
    assert.equal((await api(srv, 'POST', '/rooms', { token: vt, raw: '{not json', body: null })).status, 400);
    assert.equal((await api(srv, 'POST', '/rooms', { token: vt, body: { name: 5 } })).status, 400);
    assert.equal((await api(srv, 'POST', '/rooms', { token: vt, raw: 'x'.repeat(20000), body: null })).status, 400);
    assert.equal((await api(srv, 'POST', '/rooms', { token: 'a'.repeat(5000), body: {} })).status, 401);
    assert.equal((await api(srv, 'GET', '/health')).status, 200);
  } finally { await srv.close(); }
});

test('(w) owner actions: a member token cannot delete or replace the link, the owner can; everyone with the old link is out at once; delete closes members with 4410, wipes the folder and nothing comes back', async () => {
  const dir = tmpDir(), srv = await server(dir, 3377);
  try {
    const vt = signSession();
    const { roomId, token, ownerToken } = (await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'Owned' } })).body;
    for (const t of [token, vt, 'x' + ownerToken.slice(1), '']) {
      assert.equal((await api(srv, 'POST', `/rooms/${roomId}/invite`, { token: t })).status, 403);
      assert.equal((await api(srv, 'DELETE', `/rooms/${roomId}`, { token: t })).status, 403);
    }
    assert.equal((await api(srv, 'DELETE', `/rooms/no-such-room-000000`, { token: ownerToken })).status, 404);
    assert.equal((await api(srv, 'DELETE', `/rooms/../${roomId}`, { token: ownerToken })).status, 404);
    // a member is connected and typing when the owner replaces the link
    const a = client(srv, roomId, token), b = client(srv, roomId, token); await synced(a.provider); await synced(b.provider);
    const aClosed = new Promise(ok => a.provider.on('connection-close', ev => ok(ev && ev.code)));
    const r = await api(srv, 'POST', `/rooms/${roomId}/invite`, { token: ownerToken });
    assert.equal(r.status, 200); const token2 = r.body.token; assert.notEqual(token2, token);
    assert.equal(await aClosed, 4401, 'the connected member is closed as a bad token');
    stop(a); stop(b);
    assert.equal((await join(`${srv.url}/${roomId}?token=${token}`)).result, 4401, 'the old link stops working');
    const c = client(srv, roomId, token2); await synced(c.provider);
    c.doc.getMap('meta').set('title', 'after the new link'); await until(() => srv.store.logBytes(roomId) > 0);
    // delete while c is connected and keeps editing
    const cClosed = new Promise(ok => c.provider.on('connection-close', ev => ok(ev && ev.code)));
    const del = await api(srv, 'DELETE', `/rooms/${roomId}`, { token: ownerToken });
    assert.deepEqual([del.status, del.body], [200, { ok: true }]);
    assert.equal(await cClosed, 4410);
    assert.ok(!fs.existsSync(path.join(dir, roomId)) && !fs.existsSync(path.join(dir, roomId + '.deleting')));
    c.doc.getMap('meta').set('title', 'typed after the delete');
    await new Promise(ok => setTimeout(ok, 150));
    stop(c);
    assert.ok(!fs.existsSync(path.join(dir, roomId)), 'edits after the delete never recreate the room');
    assert.equal(srv.rooms.has(roomId), false);
    assert.equal((await join(`${srv.url}/${roomId}?token=${token2}`)).result, 4404);
    assert.equal((await api(srv, 'DELETE', `/rooms/${roomId}`, { token: ownerToken })).status, 404, 'a second delete is a plain 404');
    // the compaction tick after a delete must not throw or write (ports the deleted room out of every timer)
    await new Promise(ok => setTimeout(ok, 120));
    assert.ok(!fs.existsSync(path.join(dir, roomId)));
  } finally { await srv.close(); }
});

test('(x) legacy rooms (CLI, no owner) join and sync as before; owner actions on them are refused until attach-owner gives them one', async () => {
  const dir = tmpDir(), { id, token } = makeRoom(dir, 'Legacy'), srv = await server(dir, 3378);
  try {
    const a = client(srv, id, token), b = client(srv, id, token); await synced(a.provider); await synced(b.provider);
    a.doc.getMap('meta').set('title', 'still syncing'); await until(() => b.doc.getMap('meta').get('title') === 'still syncing');
    stop(a); stop(b);
    assert.equal(srv.store.hasOwner(id), false);
    assert.equal((await api(srv, 'DELETE', `/rooms/${id}`, { token: 'x'.repeat(43) })).status, 403);
    const out = cli('attach-owner', [id], dir); assert.equal(out.status, 0, out.stderr);
    const owner = /owner: +(\S+)/.exec(out.stdout)[1];
    assert.equal(srv.store.hasOwner(id), true);
    assert.equal((await api(srv, 'POST', `/rooms/${id}/invite`, { token: owner })).status, 200);
    assert.equal((await api(srv, 'DELETE', `/rooms/${id}`, { token: owner })).status, 200);
    assert.ok(!fs.existsSync(path.join(dir, id)));
  } finally { await srv.close(); }
});

test('(y) caps: MAX_ROOMS gives a plain 507, the per-token burst a 429, and an update past MAX_ROOM_BYTES is refused with 4413 while the room keeps serving small ones', async () => {
  const dir = tmpDir(), srv = await server(dir, 3381, { maxRooms: 2, createPerHour: 3, maxRoomBytes: 4000 });
  try {
    const vt = signSession();
    const first = await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'one' } }); assert.equal(first.status, 201);
    assert.equal((await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'two' } })).status, 201);
    let r = await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'three' } });
    assert.equal(r.status, 507); assert.equal(r.body.error, 'room_cap'); assert.match(r.body.message, /operator/);
    assert.equal(srv.store.count(), 2);
    // the burst limit counts attempts (3 taken): a fourth is 429 even with room to spare
    r = await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'four' } }); assert.equal(r.status, 429); assert.equal(r.body.error, 'create_limit');
    // room size: a 10 KB note into a room capped at 4 KB
    const { roomId, token } = first.body;
    const a = client(srv, roomId, token), b = client(srv, roomId, token); await synced(a.provider); await synced(b.provider);
    const before = srv.store.logBytes(roomId);
    const closed = new Promise(ok => a.provider.on('connection-close', ev => ok(ev && ev.code)));
    a.doc.getMap('meta').set('title', 'x'.repeat(10_000));
    assert.equal(await closed, 4413);
    stop(a);
    assert.equal(srv.store.logBytes(roomId), before, 'the refused update was not written');
    b.doc.getMap('meta').set('title', 'small'); await until(() => srv.store.logBytes(roomId) > before);
    const c = client(srv, roomId, token); await synced(c.provider);
    assert.equal(c.doc.getMap('meta').get('title'), 'small', 'the room still serves');
    stop(b); stop(c);
  } finally { await srv.close(); }
});

test('(z) CORS: an allowed origin gets its header and a 204 preflight; any other origin is refused with 403 and no header; no Origin (curl) is fine', async () => {
  const dir = tmpDir(), srv = await server(dir, 3382, { corsOrigins: ['https://cue.example.dev'] });
  try {
    let r = await api(srv, 'OPTIONS', '/rooms', { origin: 'https://cue.example.dev' });
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://cue.example.dev');
    assert.match(r.headers.get('access-control-allow-headers'), /authorization/); assert.match(r.headers.get('access-control-allow-methods'), /DELETE/);
    r = await api(srv, 'POST', '/rooms', { origin: 'https://cue.example.dev', body: {} });
    assert.equal(r.status, 401); assert.equal(r.headers.get('access-control-allow-origin'), 'https://cue.example.dev'); assert.equal(r.headers.get('vary'), 'Origin');
    for (const o of ['https://evil.example', 'http://cue.example.dev', 'https://cue.example.dev.evil', 'null']) {
      r = await api(srv, 'OPTIONS', '/rooms', { origin: o }); assert.equal(r.status, 403, o); assert.equal(r.headers.get('access-control-allow-origin'), null);
      r = await api(srv, 'POST', '/rooms', { origin: o, body: {} }); assert.equal(r.status, 403, o);
    }
    r = await api(srv, 'POST', '/rooms', { body: {} }); assert.equal(r.status, 401, 'no Origin: not a CORS request');
    assert.equal((await api(srv, 'GET', '/nothing-here')).status, 404);
  } finally { await srv.close(); }
});

test('(aa) no secrets in the log at debug level: sessions, emails, invite tokens and owner tokens never appear; restart keeps tokens and owners', async () => {
  const dir = tmpDir(), lines = [];
  const rec = lv => (msg, fields = {}) => lines.push(JSON.stringify({ level: lv, msg, ...fields }));
  const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  let srv = await server(dir, 3383, { log, corsOrigins: ['https://app.example'] });
  let vt, roomId, token, ownerToken;
  try {
    vt = signSession({ src: 'invite:Ana' });
    await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'x' }, origin: 'https://nope.example' });
    ({ roomId, token, ownerToken } = (await api(srv, 'POST', '/rooms', { token: vt, body: { name: 'Logged' } })).body);
    await api(srv, 'POST', `/rooms/${roomId}/invite`, { token: token });          // refused: a member token
    token = (await api(srv, 'POST', `/rooms/${roomId}/invite`, { token: ownerToken })).body.token;
    const a = client(srv, roomId, token); await synced(a.provider); stop(a);
    await api(srv, 'POST', '/rooms', { token: vt.slice(0, -3) + 'AAA', body: { name: 'nope' } });
  } finally { await srv.close(); }
  assert.ok(lines.length > 5);
  for (const s of [vt, token, ownerToken, 'ana@example.com']) for (const l of lines) assert.ok(!l.includes(s), 'secret in log: ' + l);
  assert.ok(lines.some(l => /"room created"/.test(l) && /"code":"invite:Ana"/.test(l)), 'how the creator got in is logged, who is not');
  assert.ok(lines.some(l => /"rejected: origin"/.test(l)));
  // restart: everything persisted
  srv = await server(dir, 3368, { log });   // another port: fetch's keep-alive pool may still hold a socket to the old one
  try {
    assert.equal((await api(srv, 'POST', `/rooms/${roomId}/invite`, { token: ownerToken.slice(0, -1) + (ownerToken.at(-1) === 'A' ? 'B' : 'A') })).status, 403);
    assert.equal((await join(`${srv.url}/${roomId}?token=${token}`)).result, 'joined');
    assert.equal((await api(srv, 'DELETE', `/rooms/${roomId}`, { token: ownerToken })).status, 200);
    assert.equal((await api(srv, 'GET', '/health')).body.ok, true);
  } finally { await srv.close(); }
});

test('(ab) races: two creates at once make two rooms; a join racing a delete gets 4404 or 4410, never a half room', async () => {
  const dir = tmpDir(), srv = await server(dir, 3375);
  try {
    const vt = signSession();
    const [a, b] = await Promise.all([api(srv, 'POST', '/rooms', { token: vt, body: { name: 'A' } }), api(srv, 'POST', '/rooms', { token: vt, body: { name: 'B' } })]);
    assert.equal(a.status, 201); assert.equal(b.status, 201); assert.notEqual(a.body.roomId, b.body.roomId); assert.equal(srv.store.count(), 2);
    // delete fired while a join is in flight
    const { roomId, token, ownerToken } = a.body;
    const m = client(srv, roomId, token); await synced(m.provider);
    const results = await Promise.all([join(`${srv.url}/${roomId}?token=${token}`), api(srv, 'DELETE', `/rooms/${roomId}`, { token: ownerToken }), join(`${srv.url}/${roomId}?token=${token}`)]);
    for (const j of [results[0], results[2]]) { assert.ok(['joined', 4404, 4410].includes(j.result), String(j.result)); if (j.ws) j.ws.terminate(); }
    assert.equal(results[1].status, 200); stop(m);
    await new Promise(ok => setTimeout(ok, 100));
    assert.ok(!fs.existsSync(path.join(dir, roomId)) && !fs.existsSync(path.join(dir, roomId + '.deleting')));
    assert.equal(srv.rooms.has(roomId), false);
  } finally { await srv.close(); }
});

test('(ac) the burst limiter on its own: the window slides', () => {
  let t = 0; const now = () => t;
  const b = createBurstLimiter({ max: 2, windowMs: 100, now });
  assert.ok(b.take('x')); assert.ok(b.take('x')); assert.ok(!b.take('x')); t += 101; assert.ok(b.take('x'));
  const s = new ProjectStore(tmpDir()); assert.equal(s.count(), 0); assert.equal(s.deleteProject('nope-nope-nope-nope'), false);
});
