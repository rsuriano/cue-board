// Security review, finding 3: how much disk one account can take through room creation. Now: a per-account room
// limit and the hourly limit are counted from the rooms on disk (a restart forgets nothing), and under a free-disk
// floor the server refuses new rooms and updates instead of filling the disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { tmpDir, server, signSession, makeRoom, until } from './helpers.mjs';

const create = (srv, s) => fetch(srv.httpUrl + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s }, body: '{"name":"x"}' }).then(async r => ({ status: r.status, body: await r.json() }));
const del = (srv, r) => fetch(srv.httpUrl + '/rooms/' + r.roomId, { method: 'DELETE', headers: { authorization: 'Bearer ' + r.ownerToken } }).then(x => x.status);
const open = (url) => new Promise((ok, no) => { const ws = new WebSocket(url); ws.on('error', no); ws.once('message', () => ok(ws)); });

test('one account: MAX_ROOMS_PER_ACCOUNT rooms on disk, and the limit holds across a restart', async () => {
  const dir = tmpDir(), opts = { createPerHour: 100, maxRoomsPerAccount: 3 };
  const s = signSession({ sub: 'one@example.com' }), other = signSession({ sub: 'two@example.com' });
  let srv = await server(dir, 0, opts);
  const made = [];
  try {
    for (let i = 0; i < 3; i++) { const r = await create(srv, s); assert.equal(r.status, 201); made.push(r.body); }
    const r4 = await create(srv, s);
    assert.equal(r4.status, 429); assert.equal(r4.body.error, 'account_cap');
  } finally { await srv.close(); }
  srv = await server(dir, 0, opts);
  try {
    assert.equal((await create(srv, s)).body.error, 'account_cap', 'still refused after a restart');
    assert.equal((await create(srv, other)).status, 201, 'another account is not affected');
    assert.equal(await del(srv, made[0]), 200);
    assert.equal((await create(srv, s)).status, 201, 'deleting a room frees a place');
  } finally { await srv.close(); }
  // the account is kept as a hash, never the email
  const p = fs.readFileSync(path.join(dir, made[1].roomId, 'project.json'), 'utf8');
  assert.ok(!p.includes('one@example.com') && /"account": "[0-9a-f]{64}"/.test(p));
});

test('the hourly create limit is counted from disk too: a restart does not reset it', async () => {
  const dir = tmpDir(), opts = { createPerHour: 3 };
  const s = signSession({ sub: 'one@example.com' });
  let srv = await server(dir, 0, opts);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await create(srv, s)).status, 201);
    assert.equal((await create(srv, s)).body.error, 'create_limit');
  } finally { await srv.close(); }
  srv = await server(dir, 0, opts);
  try {
    const r = await create(srv, s);
    assert.equal(r.status, 429, 'refused after a restart'); assert.equal(r.body.error, 'create_limit');
  } finally { await srv.close(); }
});

test('under MIN_FREE_DISK_BYTES: new rooms get 507 disk_full, updates get 4413, joining and reading still work', async () => {
  const dir = tmpDir(), { id, token } = makeRoom(dir);
  const srv = await server(dir, 0, { minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
  try {
    const r = await create(srv, signSession());
    assert.equal(r.status, 507); assert.equal(r.body.error, 'disk_full');
    assert.ok(!/[A-Z_]{6,}/.test(r.body.message), 'a plain message, no env names');
    const before = fs.statSync(path.join(dir, id, 'updates.bin')).size;
    const ws = await open(`${srv.url}/${id}?token=${token}`);   // joined and greeted (sync step 1)
    let closed = null; ws.on('close', c => { closed = c; });
    const d = new Y.Doc(); d.getText('x').insert(0, 'hello');
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(d));
    ws.send(encoding.toUint8Array(e));
    await until(() => closed !== null, 3000, 'closed');
    assert.equal(closed, 4413);
    assert.equal(fs.statSync(path.join(dir, id, 'updates.bin')).size, before, 'nothing appended');
  } finally { await srv.close(); }
});
