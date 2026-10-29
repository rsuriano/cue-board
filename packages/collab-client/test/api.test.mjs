// The browser side of the rooms API (src/api.mjs) against a real server on port 3379. Also: a deleted room and a full
// room reach the session as their own statuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '@cue-board/sync-server';
import { AccessStore } from '../../sync-server/src/access.mjs';
import { createApi, httpBase } from '../src/api.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('httpBase maps the sync URL onto the API origin', () => {
  assert.equal(httpBase('wss://sync.example.dev'), 'https://sync.example.dev');
  assert.equal(httpBase('ws://127.0.0.1:3300/'), 'http://127.0.0.1:3300');
  assert.equal(httpBase(' wss://sync.example.dev// '), 'https://sync.example.dev');
});

test('verify, createRoom, regenerateInvite, deleteRoom: plain results, never a throw; errors carry the server sentence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-api-')), srv = await startServer({ port: 3379, dataDir: dir, logLevel: 'silent' });
  const api = createApi(srv.url.replace(/\/r$/, ''));
  try {
    let r = await api.verify('nope');
    assert.equal(r.ok, false); assert.equal(r.error, 'bad_code'); assert.equal(r.status, 401); assert.match(r.message, /didn't work/);
    r = await api.createRoom('', 'x'); assert.equal(r.error, 'unverified'); assert.match(r.message, /invite-only/);
    const code = new AccessStore(dir).createCode({ label: 'Ana' }).code;
    r = await api.verify(' ' + code + ' '); assert.equal(r.ok, true); assert.equal(r.label, 'Ana'); const vt = r.token;
    assert.deepEqual(await api.checkVerified(vt), { ok: true, label: 'Ana' });
    r = await api.createRoom(vt, 'My film'); assert.equal(r.ok, true); const { roomId, token, ownerToken } = r;
    assert.ok(roomId && token && ownerToken);
    r = await api.regenerateInvite(roomId, token); assert.equal(r.error, 'not_owner'); assert.match(r.message, /owner/);
    r = await api.regenerateInvite(roomId, ownerToken); assert.equal(r.ok, true); assert.notEqual(r.token, token);
    r = await api.deleteRoom(roomId, ownerToken); assert.deepEqual(r, { ok: true });
    r = await api.deleteRoom(roomId, ownerToken); assert.equal(r.error, 'unknown_room');
    r = await api.deleteRoom('../x', ownerToken); assert.equal(r.ok, false);
  } finally { await srv.close(); }
  const dead = createApi('ws://127.0.0.1:3379', { timeoutMs: 2000 });
  const r = await dead.verify('x'); assert.equal(r.error, 'network'); assert.match(r.message, /didn't answer/);
});
