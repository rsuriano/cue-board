// Security review: room access and paths built from client input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import WebSocket from 'ws';
import { tmpDir, server, makeRoom, signSession, AUTH_KEYS } from './helpers.mjs';
import { canCreateRoom } from '../src/access.mjs';

const proto = (token) => token;
/** join as the app does: token as the second subprotocol. 'joined' once greeted, else the close code */
const join = (url, token) => new Promise(ok => {
  const ws = new WebSocket(url, typeof token === 'string' && token ? ['cueboard', token] : ['cueboard']);
  ws.on('error', () => {}); ws.once('message', () => ok({ result: 'joined', ws })); ws.on('close', code => ok({ result: code, ws }));
});
const api = (srv, method, p, token, body) => fetch(srv.httpUrl + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

test('a token opens only its own room; traversal-shaped room ids never reach the filesystem', async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  // a file outside DATA_DIR shaped like a room, to see whether a traversal could reach it
  const outside = path.join(path.dirname(dir), path.basename(dir) + '-outside');
  fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'project.json'), JSON.stringify({ tokens: [] }));
  try {
    const A = makeRoom(dir, 'A'), B = makeRoom(dir, 'B');
    const ok = await join(`${srv.url}/${A.id}`, proto(A.token)); assert.equal(ok.result, 'joined'); ok.ws.terminate();
    assert.equal((await join(`${srv.url}/${B.id}`, proto(A.token))).result, 4401, "A's token on B");
    assert.equal((await join(`${srv.url}/${B.id}`, '')).result, 4401, 'no token');
    assert.equal((await join(`${srv.url}/${B.id}`, proto(A.token.slice(0, -1) + 'x'))).result, 4401, 'near-miss token');
    // guessing: ids are 96 random bits; a plausible-looking one is just unknown
    assert.equal((await join(`${srv.url}/${'A'.repeat(16)}`, proto(A.token))).result, 4404);
    for (const bad of ['..', '..%2F' + path.basename(outside), '%2e%2e%2f%2e%2e%2fetc', '....//....//etc', encodeURIComponent('../' + path.basename(outside)), 'a'.repeat(65)]) {
      assert.equal((await join(`${srv.url}/${bad}`, proto(A.token))).result, 4404, 'ws ' + bad);
      const r = await api(srv, 'DELETE', `/rooms/${bad}`, 'x'.repeat(32));
      assert.ok([404].includes(r.status), `DELETE ${bad} -> ${r.status}`);
      const r2 = await api(srv, 'POST', `/rooms/${bad}/invite`, 'x'.repeat(32));
      assert.ok([404].includes(r2.status), `invite ${bad} -> ${r2.status}`);
    }
    assert.ok(fs.existsSync(path.join(outside, 'project.json')), 'nothing outside DATA_DIR was touched');
  } finally { await srv.close(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('replaced invite link: old token refused at once; deleted room: every token refused; owner token is not an invite and vice versa', async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  try {
    const c = await api(srv, 'POST', '/rooms', signSession(), { name: 'R' });
    assert.equal(c.status, 201);
    const { roomId, token, ownerToken } = c.body;
    const member = await join(`${srv.url}/${roomId}`, proto(token)); assert.equal(member.result, 'joined');
    const kicked = new Promise(ok => member.ws.on('close', ok));
    assert.equal((await api(srv, 'POST', `/rooms/${roomId}/invite`, token)).status, 403, 'a member cannot replace the link');
    const n = await api(srv, 'POST', `/rooms/${roomId}/invite`, ownerToken); assert.equal(n.status, 200);
    assert.equal(await kicked, 4401, 'connected holder of the old link is closed');
    assert.equal((await join(`${srv.url}/${roomId}`, proto(token))).result, 4401, 'old link refused');
    assert.equal((await join(`${srv.url}/${roomId}`, proto(ownerToken))).result, 4401, 'owner token is not an invite token (length cap 64)');
    const j = await join(`${srv.url}/${roomId}`, proto(n.body.token)); assert.equal(j.result, 'joined'); j.ws.terminate();
    assert.equal((await api(srv, 'DELETE', `/rooms/${roomId}`, ownerToken)).status, 200);
    assert.equal((await join(`${srv.url}/${roomId}`, proto(n.body.token))).result, 4404, 'deleted room');
  } finally { await srv.close(); }
});

test('session forgeries: alg-confusion shapes, HMAC with the public key, another Ed25519 key, wrong types, stringly-typed fields', () => {
  const now = Date.now(), b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const good = { typ: 'session', sub: 'eve@example.com', prd: 'cue-board', src: 'purchase', exp: now + 1e9, chk: now };
  const p = b64(good), pubPem = AUTH_KEYS.publicKey.export({ type: 'spki', format: 'pem' });
  const cases = {
    'JWT-style header.payload.sig with alg none': b64({ alg: 'none' }) + '.' + p + '.',
    'payload with empty signature': p + '.',
    'payload only': p,
    'HMAC-SHA256 keyed with the public key PEM': p + '.' + createHmac('sha256', pubPem).update(p).digest('base64url'),
    'signed by another Ed25519 key': p + '.' + sign(null, Buffer.from(p), generateKeyPairSync('ed25519').privateKey).toString('base64url'),
    'good signature, payload swapped after signing': b64({ ...good, sub: 'mallory@example.com' }) + '.' + signSession(good).split('.')[1],
    'ticket typ': signSession({ typ: 'ticket' }),
    'sub not a string': signSession({ sub: ['x'] }),
    'exp missing': signSession({ exp: undefined }),
    'chk missing': signSession({ chk: undefined }),
    'over 2048 chars': signSession({ pad: 'x'.repeat(3000) }),
  };
  for (const [why, t] of Object.entries(cases)) assert.equal(canCreateRoom(AUTH_KEYS.publicKey, { session: t }).ok, false, why);
  assert.equal(canCreateRoom(AUTH_KEYS.publicKey, { session: signSession() }).ok, true, 'control: a real session passes');
});
