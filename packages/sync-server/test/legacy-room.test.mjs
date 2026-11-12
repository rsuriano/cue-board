// A room saved by the server as it was before the security fixes (test/fixtures/room-2026-11-12, written by
// make-room-fixture.mjs at 9340fc5) must load and work unchanged: no data migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, server, client, synced, until, records, signSession } from './helpers.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'room-2026-11-12.json'), 'utf8'));

test('legacy: a room saved by the pre-fix server loads unchanged, syncs, and its owner token still works', async () => {
  const dir = tmpDir();
  fs.cpSync(path.join(FIX, 'room-2026-11-12'), path.join(dir, meta.id), { recursive: true });
  const before = fs.readFileSync(path.join(dir, meta.id, 'project.json'), 'utf8');
  assert.ok(records(path.join(dir, meta.id, 'updates.bin')) > 1, 'fixture log is uncompacted');
  const srv = await server(dir, 0);
  const c = client(srv, meta.id, meta.token);
  try {
    await synced(c.provider);
    assert.equal(c.doc.getText('fixture').toString(), 'hello from 2026-11-12');
    assert.equal(c.doc.getMap('meta').get('note'), 'saved by the pre-fix server');
    assert.equal(c.doc.getMap('meta').get('title'), 'Fixture room');
    c.doc.getText('fixture').insert(0, 'still editable: ');
    await until(() => srv.rooms.get(meta.id)?.doc.getText('fixture').toString().startsWith('still editable'), 3000, 'edit applied');
    assert.equal(fs.readFileSync(path.join(dir, meta.id, 'project.json'), 'utf8'), before, 'project.json is not rewritten on join');
    // creating rooms next to it still works (the per-account limit must cope with rooms that carry no account)
    const r = await fetch(srv.httpUrl + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signSession() }, body: '{"name":"new"}' });
    assert.equal(r.status, 201);
    const inv = await fetch(srv.httpUrl + `/rooms/${meta.id}/invite`, { method: 'POST', headers: { authorization: 'Bearer ' + meta.ownerToken } });
    assert.equal(inv.status, 200, 'owner token from the old project.json');
  } finally { c.provider.destroy(); c.doc.destroy(); await srv.close(); }
});
