// Criterion 7: existing rooms, owner links and invite links keep working after the change, against a copy of the real
// data (CUE_REAL_DATA, default /opt/cue-sync/data). The real directory is only read, once, into a temp dir; skipped
// where it isn't readable (CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { tmpDir, server, client, synced, join } from './helpers.mjs';
import { ProjectStore, ROOM_ID } from '../src/store.mjs';

const SRC = process.env.CUE_REAL_DATA || '/opt/cue-sync/data';
const readable = (() => { try { fs.accessSync(SRC, fs.constants.R_OK); return fs.statSync(SRC).isDirectory(); } catch { return false; } })();
const sha = (/** @type {string | Buffer} */ b) => createHash('sha256').update(b).digest('hex');

test('(7) a copy of the real data: every room loads, nothing on disk changes by starting the new server, and invite and owner links made the old way still work', { skip: !readable && `${SRC} not readable` }, async t => {
  const dir = tmpDir();
  fs.cpSync(SRC, dir, { recursive: true });
  const ids = fs.readdirSync(dir).filter(n => ROOM_ID.test(n) && fs.existsSync(path.join(dir, n, 'project.json')));
  assert.ok(ids.length > 0, 'the copy has rooms');
  const before = new Map(ids.map(id => [id, sha(fs.readFileSync(path.join(dir, id, 'project.json'))) + sha(fs.readFileSync(path.join(dir, id, 'updates.bin')))]));
  // an invite link and an owner link issued before the change: written exactly as the old addToken / setOwner did
  const store = new ProjectStore(dir), links = new Map();
  let srv = await server(dir, 0);
  try {
    // starting the new server on the old data changes no file
    assert.equal((await fetch(srv.httpUrl + '/health')).status, 200);
    await srv.close();
    for (const id of ids) assert.equal(sha(fs.readFileSync(path.join(dir, id, 'project.json'))) + sha(fs.readFileSync(path.join(dir, id, 'updates.bin'))), before.get(id), id);
    for (const [i, id] of ids.entries()) {
      const p = store.readProject(id), invite = randomBytes(16).toString('base64url'), owner = randomBytes(32).toString('base64url');
      p.tokens.push({ sha256: sha(invite), created: '2026-11-01T00:00:00.000Z' });
      // rooms with an owner keep it (new hash, so the test holds the link); every other legacy room gets one the way
      // the old setOwner wrote it (a room made from the app before this change), the rest stay legacy
      const hadOwner = !!p.owner || i % 2 === 1;
      if (hadOwner) p.owner = { ...(p.owner || { created: '2026-11-01T00:00:00.000Z', code: 'Nacho' }), sha256: sha(owner) };
      fs.writeFileSync(path.join(dir, id, 'project.json'), JSON.stringify(p, null, 2) + '\n');
      links.set(id, { invite, owner, hadOwner });
    }
    t.diagnostic(`${ids.length} rooms, ${[...links.values()].filter(l => l.hadOwner).length} with an owner link`);
    srv = await server(dir, 0);
    for (const id of ids.slice(0, 50)) {
      const l = /** @type {any} */ (links.get(id)), { doc } = store.loadDoc(id);
      // the invite link joins without any session and gets the room's whole doc
      const a = client(srv, id, l.invite); await synced(a.provider);
      assert.deepEqual(Y.encodeStateVector(a.doc), Y.encodeStateVector(doc), id);
      a.provider.destroy(); a.doc.destroy(); doc.destroy();
      assert.equal((await join(`${srv.url}/${id}?token=${'x'.repeat(22)}`)).result, 4401, 'a wrong invite token is still refused');
      // the owner link still manages the room; a legacy room (no owner) is still refused, as before
      const r = await fetch(`${srv.httpUrl}/rooms/${id}/invite`, { method: 'POST', headers: { authorization: 'Bearer ' + l.owner } });
      assert.equal(r.status, l.hadOwner ? 200 : 403, id);
    }
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
