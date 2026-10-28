/* Numbers for SPIKE.md: node --expose-gc test/measure.mjs   (throwaway data dir, server on 127.0.0.1:3370) */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { cueboardToDoc, parseExampleJS } from '../src/import-cueboard.mjs';
import { orderedShots } from '../src/schema.mjs';
import { ProjectStore } from '../src/store.mjs';
import { tmpDir, server, client, synced, until } from './helpers.mjs';

const example = parseExampleJS(fs.readFileSync(fileURLToPath(new URL('../../../example/example.js', import.meta.url)), 'utf8'));
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed; };
const dir = tmpDir(), store = new ProjectStore(dir);

// 1. doc growth: heavy editing on one shot's notes, then compaction
const { doc } = cueboardToDoc(example);
const base = Y.encodeStateAsUpdate(doc).length;
const notes = orderedShots(doc)[0].get('notes');
for (let i = 0; i < 20000; i++) { notes.insert(notes.length, 'x'); if (i % 3 === 2) notes.delete(notes.length - 2, 1); }  // type, backspace now and then
for (let i = 0; i < 200; i++) orderedShots(doc)[1].set('start', 4.4 + (i % 7) / 10);                                // nudge a cut 200 times
const grown = Y.encodeStateAsUpdate(doc).length;
console.log(`example doc: ${base} B; after 20k keystrokes (1/3 deleted) + 200 cut nudges: ${grown} B (text now ${notes.length} chars)`);

// 2. memory: N rooms of the example loaded in one server, one client each
const N = 100, ids = [];
for (let i = 0; i < N; i++) ids.push(store.createProject(`room ${i}`, cueboardToDoc(example).doc));
const srv = await server(dir, 3370, { unloadAfterMs: 60_000, maxConnsPerIp: 1000 });
const h0 = heap(), clients = [];
for (const { id, token } of ids) { const c = client(srv, id, token); clients.push(c); await synced(c.provider); }
await until(() => srv.rooms.size === N);
const h1 = heap();
console.log(`${N} example rooms loaded + ${N} client connections in one process: heap +${mb(h1 - h0)} (~${((h1 - h0) / N / 1024).toFixed(0)} KB per room incl. client side), rss ${mb(process.memoryUsage().rss)}`);
clients.forEach(c => { c.provider.destroy(); c.doc.destroy(); });
await srv.close();

// 3. reconnect storm: all N clients reconnect at once to a freshly started server
const srv2 = await server(dir, 3371, { maxConnsPerIp: 1000 }), t0 = performance.now();
const again = ids.map(({ id, token }) => client(srv2, id, token));
await Promise.all(again.map(c => synced(c.provider)));
console.log(`reconnect storm: ${N} clients, ${N} rooms loaded from disk and synced in ${(performance.now() - t0).toFixed(0)} ms`);
again.forEach(c => { c.provider.destroy(); c.doc.destroy(); });
await srv2.close();
fs.rmSync(dir, { recursive: true, force: true });
