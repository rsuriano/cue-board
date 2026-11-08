// Criterion 6: creating a room needs a session from auth (checked locally with auth's public key); joining needs none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { tmpDir, server, client, synced, signSession, AUTH_KEYS } from './helpers.mjs';
import { canCreateRoom } from '../src/access.mjs';

const create = (srv, token) => fetch(srv.httpUrl + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ name: 'Gate' }) })
  .then(async r => ({ status: r.status, body: await r.json() }));

test('(6) no session: no room; a valid session: a room; joining it needs no session', async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  try {
    let r = await create(srv);
    assert.equal(r.status, 401); assert.equal(r.body.error, 'no_session'); assert.match(r.body.message, /account/i);
    const day = 86400_000, now = Date.now(), other = generateKeyPairSync('ed25519').privateKey;
    const s = signSession();
    const refused = {
      'signed by another key': signSession({}, other),
      'tampered': s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1),
      'expired (a year is over)': signSession({ exp: now - 1 }),
      'not re-checked in the last 24h': signSession({ chk: now - day - 1000 }),
      'for another product': signSession({ prd: 'other' }),
      'an invite ticket, not a session': signSession({ typ: 'ticket' }),
      'garbage': 'abc.def', 'empty': '',
    };
    for (const [why, t] of Object.entries(refused)) {
      assert.equal(canCreateRoom(AUTH_KEYS.publicKey, { session: t }).ok, false, why);
      if (t) assert.equal((await create(srv, t)).status, 401, why);
    }
    assert.ok(canCreateRoom(AUTH_KEYS.publicKey, { session: s }).ok);
    r = await create(srv, s);
    assert.equal(r.status, 201); const { roomId, token, ownerToken } = r.body; assert.ok(roomId && token && ownerToken);
    // a member joins and syncs with the invite token alone: no session, no Authorization
    const a = client(srv, roomId, token); await synced(a.provider);
    assert.equal(a.doc.getMap('meta').get('title'), 'Gate');
    a.provider.destroy(); a.doc.destroy();
  } finally { await srv.close(); }
  // no AUTH_PUBLIC_KEY_FILE: nobody creates rooms (and nothing crashes)
  const off = await server(tmpDir(), 0, { authPublicKey: null });
  try {
    assert.equal(canCreateRoom(null, { session: signSession() }).ok, false);
    assert.equal((await create(off, signSession())).status, 401);
  } finally { await off.close(); }
});
