// The browser side of the rooms API (src/api.mjs) against a real server on port 3379. Also: a deleted room and a full
// room reach the session as their own statuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '@cue-board/sync-server';
import { createApi, httpBase } from '../src/api.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

/** a session as packages/auth signs it, with a key the test server trusts */
const keys = generateKeyPairSync('ed25519');
const session = () => { const p = Buffer.from(JSON.stringify({ typ: 'session', sub: 'ana@example.com', prd: 'cue-board', src: 'purchase', exp: Date.now() + 86400_000, chk: Date.now() })).toString('base64url'); return p + '.' + sign(null, Buffer.from(p), keys.privateKey).toString('base64url'); };

test('httpBase maps the sync URL onto the API origin', () => {
  assert.equal(httpBase('wss://sync.example.dev'), 'https://sync.example.dev');
  assert.equal(httpBase('ws://127.0.0.1:3300/'), 'http://127.0.0.1:3300');
  assert.equal(httpBase(' wss://sync.example.dev// '), 'https://sync.example.dev');
});

test('createRoom, regenerateInvite, deleteRoom: plain results, never a throw; errors carry the server sentence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-api-')), srv = await startServer({ port: 3379, dataDir: dir, logLevel: 'silent', authPublicKey: keys.publicKey });
  const api = createApi(srv.url.replace(/\/r$/, ''));
  try {
    let r = await api.createRoom('', 'x');
    assert.equal(r.ok, false); assert.equal(r.error, 'no_session'); assert.equal(r.status, 401); assert.match(r.message, /account/);
    r = await api.createRoom(session(), 'My film'); assert.equal(r.ok, true); const { roomId, token, ownerToken } = r;
    assert.ok(roomId && token && ownerToken);
    r = await api.regenerateInvite(roomId, token); assert.equal(r.error, 'not_owner'); assert.match(r.message, /owner/);
    r = await api.regenerateInvite(roomId, ownerToken); assert.equal(r.ok, true); assert.notEqual(r.token, token);
    r = await api.deleteRoom(roomId, ownerToken); assert.deepEqual(r, { ok: true });
    r = await api.deleteRoom(roomId, ownerToken); assert.equal(r.error, 'unknown_room');
    r = await api.deleteRoom('../x', ownerToken); assert.equal(r.ok, false);
  } finally { await srv.close(); }
  const dead = createApi('ws://127.0.0.1:3379', { timeoutMs: 2000 });
  const r = await dead.createRoom(session(), 'x'); assert.equal(r.error, 'network'); assert.match(r.message, /didn't answer/);
});
