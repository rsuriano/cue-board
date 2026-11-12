// Wrote room-2026-11-12/ with the server as it was before the security fixes (commit 9340fc5): a room exactly as that
// code saves it (project.json + an uncompacted updates.bin). Kept to show where the fixture came from; do not re-run it
// to "refresh" the fixture, its point is to be old. Usage: node test/fixtures/make-room-fixture.mjs test/fixtures
import fs from 'node:fs'; import path from 'node:path';
import * as Y from 'yjs';
import { tmpDir, server, client, synced, until } from '../helpers.mjs';
import { ProjectStore } from '../../src/store.mjs';
import { initProject } from '../../src/schema.mjs';
const dir = tmpDir(), out = process.argv[2];
const doc = new Y.Doc(); initProject(doc, { title: 'Fixture room' });
const { id, token, ownerToken } = new ProjectStore(dir).createProject('Fixture room', doc, { owner: true, code: 'invite:Fixture' });
const srv = await server(dir, 0, { compactEvery: 1e9 });
const c = client(srv, id, token); await synced(c.provider);
c.doc.getMap('meta').set('note', 'saved by the pre-fix server');
c.doc.getText('fixture').insert(0, 'hello from 2026-11-12');
await until(() => srv.rooms.get(id).doc.getText('fixture').toString() === 'hello from 2026-11-12');
// copy while connected: the log is still uncompacted (several records), as a live room is between compactions
fs.cpSync(path.join(dir, id), path.join(out, 'room-2026-11-12'), { recursive: true });
fs.writeFileSync(path.join(out, 'room-2026-11-12.json'), JSON.stringify({ id, token, ownerToken }, null, 2) + '\n');
c.provider.destroy(); await new Promise(r => setTimeout(r, 100));
await srv.close();
console.log(id, fs.readdirSync(path.join(out, 'room-2026-11-12')));
process.exit(0);
