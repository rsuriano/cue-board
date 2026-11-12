// Security review: what one invite holder can do with crafted messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { tmpDir, server, makeRoom, until, client, synced } from './helpers.mjs';
import { ProjectStore } from '../src/store.mjs';

const MSG_SYNC = 0, MSG_AWARENESS = 1;
const stage = () => {};
const open = (url) => new Promise((ok, no) => { const ws = new WebSocket(url); ws.on('error', no); ws.once('message', () => ok(ws)); });
/** an awareness message carrying `entries` [clientID, clock, state] */
function awareness(entries) {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const [id, clock, state] of entries) { encoding.writeVarUint(inner, id); encoding.writeVarUint(inner, clock); encoding.writeVarString(inner, JSON.stringify(state)); }
  const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_AWARENESS); encoding.writeVarUint8Array(e, encoding.toUint8Array(inner));
  return encoding.toUint8Array(e);
}

test('awareness: one socket cannot flood presence entries; it is closed with 4400 and the others hear almost nothing', async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  const { id, token } = makeRoom(dir);
  const ws = await open(`${srv.url}/${id}?token=${token}`);
  const victim = await open(`${srv.url}/${id}?token=${token}`);
  let victimBytes = 0; victim.on('message', d => { victimBytes += d.length; });
  let closed = null; ws.on('close', c => { closed = c; });
  try {
    const pad = 'p'.repeat(900);
    for (let m = 0; m < 40 && ws.readyState === ws.OPEN; m++) {
      const entries = []; for (let i = 0; i < 1000; i++) entries.push([1 + m * 1000 + i, 1, { user: { name: 'x' }, pad }]);
      await new Promise(ok => ws.send(awareness(entries), () => ok()));
    }
    await until(() => closed !== null, 3000, 'flooder closed');
    assert.equal(closed, 4400);
    assert.equal(srv.rooms.get(id).awareness.getStates().size, 0, 'nothing held');
    assert.ok(victimBytes < 64 * 1024, `victim got ${victimBytes} bytes`);
    // one at a time: the fifth id held by one socket closes it too
    const ws2 = await open(`${srv.url}/${id}?token=${token}`);
    let closed2 = null; ws2.on('close', c => { closed2 = c; });
    for (let i = 1; i <= 5; i++) ws2.send(awareness([[100 + i, 1, { user: { name: 'x' } }]]));
    await until(() => closed2 !== null, 3000, 'fifth id closes');
    assert.equal(closed2, 4400);
    // a state over 8 KiB is refused
    const ws3 = await open(`${srv.url}/${id}?token=${token}`);
    let closed3 = null; ws3.on('close', c => { closed3 = c; });
    ws3.send(awareness([[200, 1, { user: { name: 'x' }, pad: 'p'.repeat(9000) }]]));
    await until(() => closed3 !== null, 3000, 'big state closes');
    assert.equal(closed3, 4400);
  } finally { ws.terminate(); victim.terminate(); await srv.close(); }
});

test("awareness: a member cannot overwrite another member's presence (name) by reusing their clientID", async () => {
  const dir = tmpDir(), srv = await server(dir, 0);
  const { id, token } = makeRoom(dir);
  const ana = client(srv, id, token); await synced(ana.provider);
  ana.provider.awareness.setLocalStateField('user', { name: 'Ana' });
  await until(() => srv.rooms.get(id).awareness.getStates().get(ana.doc.clientID)?.user?.name === 'Ana', 3000, 'ana');
  const eve = await open(`${srv.url}/${id}?token=${token}`);
  try {
    eve.send(awareness([[ana.doc.clientID, 1000, { user: { name: 'Owner (real)' } }], [777, 1, { user: { name: 'Eve' } }]]));
    eve.send(awareness([[ana.doc.clientID, 1001, null]]));   // nor remove it
    await until(() => srv.rooms.get(id).awareness.getStates().get(777)?.user?.name === 'Eve', 3000, "eve's own entry still applies");
    await new Promise(r => setTimeout(r, 100));
    assert.equal(srv.rooms.get(id).awareness.getStates().get(ana.doc.clientID)?.user?.name, 'Ana');
    assert.equal(ana.provider.awareness.getStates().get(ana.doc.clientID)?.user?.name, 'Ana');
    assert.equal(eve.readyState, eve.OPEN, 'a foreign entry is left out, not a reason to close');
    // Ana can still change her own presence
    ana.provider.awareness.setLocalStateField('user', { name: 'Ana B' });
    await until(() => srv.rooms.get(id).awareness.getStates().get(ana.doc.clientID)?.user?.name === 'Ana B', 3000, 'ana renames');
  } finally { eve.terminate(); ana.provider.destroy(); ana.doc.destroy(); await srv.close(); }
});

test('malformed Yjs updates close the socket with 4400 and log one short line, rate-limited, never a stack trace', async () => {
  const dir = tmpDir(), lines = [];
  const rec = lv => (msg, fields = {}) => lines.push(JSON.stringify({ level: lv, msg, ...fields }));
  const srv = await server(dir, 0, { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } });
  const { id, token } = makeRoom(dir);
  const consoleErrors = []; const orig = console.error; console.error = (...a) => consoleErrors.push(a);
  try {
    const d = new Y.Doc(); d.getText('x').insert(0, 'hello world, this is a real update');
    const u = Y.encodeStateAsUpdate(d), broken = u.subarray(0, Math.floor(u.length / 2));
    const codes = [];
    for (let i = 0; i < 20; i++) {
      const ws = await open(`${srv.url}/${id}?token=${token}`);
      const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_SYNC); encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, broken);
      ws.send(encoding.toUint8Array(e));
      codes.push(await new Promise(ok => { ws.on('close', ok); setTimeout(() => ok('open'), 1000); }));
      ws.terminate();
    }
    assert.deepEqual([...new Set(codes)], [4400], 'every broken update closes its socket');
    assert.equal(consoleErrors.length, 0, 'nothing on console.error');
    const mal = lines.filter(l => /malformed/.test(l));
    assert.equal(mal.length, 1, '20 closes in a burst, one log line');
    assert.ok(mal[0].length < 500 && !/\n|    at /.test(mal[0]), 'short, no stack');
  } finally { console.error = orig; await srv.close(); }
});

test('fuzz: bit-flipped Yjs updates, random frames and junk never crash the process, and the room still loads from disk after', async () => {
  const dir = tmpDir(), srv = await server(dir, 0, { compactIntervalMs: 3600_000 });
  const { id, token } = makeRoom(dir);
  const base = new Y.Doc(); const m = base.getMap('meta'); const arr = base.getArray('sections');
  for (let i = 0; i < 20; i++) { m.set('k' + i, 'v'.repeat(i)); arr.push([new Y.Map([['title', 't' + i]])]); base.getText('x').insert(0, 'hello' + i); }
  const valid = Y.encodeStateAsUpdate(base);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const codes = {};
  let uncaught = 0; const onUnc = () => { uncaught++; }; process.on('uncaughtException', onUnc);
  try {
    for (let n = 0; n < 1500; n++) {
      const ws = await open(`${srv.url}/${id}?token=${token}`).catch(() => null);
      if (!ws) { codes.refused = (codes.refused || 0) + 1; continue; }
      const done = new Promise(ok => { ws.on('close', c => ok(c)); setTimeout(() => ok('open'), 30); });
      let msg;
      const kind = n % 3;
      if (kind === 0) {   // flipped bytes inside a real update, framed as sync update
        const u = Uint8Array.from(valid); const flips = 1 + Math.floor(rnd() * 4);
        for (let f = 0; f < flips; f++) u[Math.floor(rnd() * u.length)] = Math.floor(rnd() * 256);
        const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_SYNC); encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, u); msg = encoding.toUint8Array(e);
      } else if (kind === 1) {   // random frame with a plausible type byte
        msg = new Uint8Array(1 + Math.floor(rnd() * 200)); for (let i = 0; i < msg.length; i++) msg[i] = Math.floor(rnd() * 256); msg[0] = [0, 1, 3, 10][n % 4];
      } else {   // huge declared lengths
        msg = Uint8Array.from([MSG_SYNC, 2, 0xff, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]);
      }
      ws.send(msg);
      const c = await done; codes[c] = (codes[c] || 0) + 1; ws.terminate();
    }
    const h = await fetch(srv.httpUrl + '/health').then(r => r.json());
    assert.equal(h.ok, true);
    console.log('close codes over 1500 crafted messages:', JSON.stringify(codes), 'uncaught:', uncaught);
    assert.equal(uncaught, 0);
  } finally { process.off('uncaughtException', onUnc); stage('fuzz: closing server'); await srv.close(); stage('fuzz: closed'); }
  // after shutdown (final compaction) the room must still load
  const { doc } = new ProjectStore(dir).loadDoc(id);
  stage('fuzz: reloaded');
  assert.ok(doc, 'room loads after the fuzz');
});
