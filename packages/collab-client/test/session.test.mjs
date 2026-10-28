// A session (createCollab().open) against a real sync server, with a fake app, while another client edits the room.
// Covers pull()/applyRemote() while a media field waits for its hash: kept, failed, changed twice, deleted elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { startServer } from '@cue-board/sync-server';
import { initProject, shotsMap } from '@cue-board/sync-server/schema';
import { ProjectStore } from '../../sync-server/src/store.mjs';

// the browser bits collab.mjs touches; no indexedDB, so nothing is stored
globalThis.window = new EventTarget();
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
const { createCollab } = await import('../src/collab.mjs');

const PORT = 3385;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label); await sleep(10); }
}
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = (s, type = 'image/png') => new Blob([s], { type });
/** a promise you resolve later: the media read (and so the hash) waits on it */
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

let srv, dir;
test.before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-collab-session-')); srv = await startServer({ port: PORT, dataDir: dir, logLevel: 'silent' }); });
test.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** A fresh room; A: a session with a fake app; B: a plain Yjs client in the same room. */
async function setup() {
  const seed = new Y.Doc(); initProject(seed, { title: 'Room' });
  const { id: roomId, token } = new ProjectStore(dir).createProject('t', seed);
  /** @type {Map<string, () => Promise<any>>} */ const media = new Map();
  const reads = new Map();
  const app = {
    cur: /** @type {any} */ (null), pulls: 0, unshared: 0,
    project: () => app.cur,
    applyRemote: (_pid, p) => { app.pulls++; app.cur = { ...p, id: 'p1' }; },
    busy: () => false, focusedText: () => null,
    mediaBlob: async id => { reads.set(id, (reads.get(id) || 0) + 1); return media.has(id) ? media.get(id)() : null; },
    songBlob: async () => null,
    onStatus() {}, onPeers() {}, onEvent() {},
    onUnshared: (_pid, n) => { app.unshared = n; },
  };
  const collab = createCollab(app, srv.url.replace(/\/r$/, ''));
  const sess = collab.open('p1', { roomId, token, name: 'A', dev: 'dA' });
  const b = new Y.Doc();
  const pb = new WebsocketProvider(srv.url, roomId, b, { protocols: ['cueboard', token], disableBc: true });
  await until(() => app.pulls > 0 && app.cur.sections.length === 1 && pb.synced, 'both synced');
  const sid = app.cur.sections[0].id;
  const bShot = () => shotsMap(b).get(sid);
  /** B types `n` characters into the notes, one transaction each, and waits until A has pulled them all */
  async function bTypes(n = 8) {
    for (let i = 0; i < n; i++) { bShot().get('notes').insert(0, 'b'); await sleep(15); }
    const want = bShot().get('notes').toString();
    await until(() => app.cur.sections.find(s => s.id === sid)?.notes === want, 'A pulls B\'s notes');
  }
  const aShot = () => app.cur.sections.find(s => s.id === sid);
  const done = () => { sess.stop(); pb.destroy(); b.destroy(); };
  return { app, sess, media, reads, b, sid, bShot, aShot, bTypes, done };
}

test('a frame image waiting for its hash survives remote edits, then reaches the room as its hash', async () => {
  const t = await setup();
  try {
    const g = gate(), file = blob('frame-1');
    t.media.set('m-1', async () => { await g.p; return file; });
    Object.assign(t.aShot(), { img: 'm-1', kind: 'video', clipDur: 4 }); t.sess.changed(true);
    await t.bTypes();
    assert.equal(t.aShot().img, 'm-1', 'the local image is not undone by the pull');
    assert.equal(t.aShot().kind, 'video'); assert.equal(t.aShot().clipDur, 4);
    assert.equal(t.bShot().get('img'), undefined, 'not in the room yet');
    g.open();
    await until(() => t.bShot().get('img')?.sha256, 'the hash reaches the room');
    assert.equal(t.bShot().get('img').sha256, hex('frame-1'));
    assert.equal(t.bShot().get('kind'), 'video');
    await t.bTypes(2);
    assert.equal(t.aShot().img, 'm-1');
  } finally { t.done(); }
});

test('a take whose media lands while a peer edits keeps it, with status "completed", and B gets the hash', async () => {
  const t = await setup();
  try {
    const g = gate(), file = blob('take-1', 'video/mp4');
    t.aShot().takes = [{ id: 't1', status: 'downloading', media: '', jobId: 'j' }]; t.sess.changed(true);
    await until(() => t.bShot().get('takes')?.length === 1, 'take reaches B');
    t.media.set('m-t', async () => { await g.p; return file; });
    Object.assign(t.aShot().takes[0], { status: 'completed', media: 'm-t' }); t.sess.changed(false);
    await sleep(300); await t.bTypes();
    assert.deepEqual([t.aShot().takes[0].status, t.aShot().takes[0].media], ['completed', 'm-t']);
    g.open();
    await until(() => t.bShot().get('takes').get(0).get('media')?.sha256, 'take media reaches B');
    assert.equal(t.bShot().get('takes').get(0).get('media').sha256, hex('take-1'));
    assert.equal(t.aShot().takes[0].media, 'm-t');
  } finally { t.done(); }
});

test('a file that can\'t be hashed: kept here, reported once, not retried in a loop; a remote change to the field wins', async () => {
  const t = await setup();
  try {
    t.media.set('m-bad', async () => ({ size: 3, type: 'image/png', arrayBuffer: () => Promise.reject(new DOMException('The operation was aborted', 'AbortError')) }));
    Object.assign(t.aShot(), { img: 'm-bad', kind: 'image' }); t.sess.changed(true);
    await until(() => t.app.unshared === 1, 'unshared reported');
    await t.bTypes();
    assert.equal(t.aShot().img, 'm-bad', 'the local value stays');
    assert.equal(t.reads.get('m-bad'), 1, 'read once, not retried on every push');
    assert.equal(t.bShot().get('img'), undefined);
    // B sets its own image: that field is B's now
    const other = 'c'.repeat(64);
    t.bShot().set('img', { sha256: other, bytes: 1, mime: 'image/png' });
    await until(() => t.aShot().img === 'sha256-' + other, 'B\'s image reaches A');
    await until(() => t.app.unshared === 0, 'nothing unshared anymore');
  } finally { t.done(); }
});

test('two quick changes to the same field while the first hashes: the last one wins, the stale hash is never written', async () => {
  const t = await setup();
  try {
    const g1 = gate(), g2 = gate();
    t.media.set('m-a', async () => { await g1.p; return blob('first'); });
    t.media.set('m-b', async () => { await g2.p; return blob('second'); });
    Object.assign(t.aShot(), { img: 'm-a', kind: 'image' }); t.sess.changed(true);
    await sleep(50);
    t.aShot().img = 'm-b'; t.sess.changed(true);
    g1.open(); await sleep(100);
    await t.bTypes();
    assert.equal(t.bShot().get('img'), undefined, 'the first file\'s hash was not written');
    assert.equal(t.aShot().img, 'm-b');
    g2.open();
    await until(() => t.bShot().get('img')?.sha256, 'second hash reaches B');
    assert.equal(t.bShot().get('img').sha256, hex('second'));
    await sleep(200);
    assert.equal(t.bShot().get('img').sha256, hex('second'));
    assert.equal(t.aShot().img, 'm-b');
  } finally { t.done(); }
});

test('a shot or take deleted elsewhere while its media is hashing stays deleted', async () => {
  const t = await setup();
  try {
    const g = gate();
    t.app.cur.sections.push({ id: 's-x', start: 9, title: 'X', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [] });
    t.aShot().takes = [{ id: 't-x', status: 'downloading', media: '' }];
    t.sess.changed(true);
    await until(() => shotsMap(t.b).has('s-x') && t.bShot().get('takes')?.length === 1, 'shot and take reach B');
    t.media.set('m-x', async () => { await g.p; return blob('x'); });
    t.media.set('m-y', async () => { await g.p; return blob('y'); });
    t.app.cur.sections.find(s => s.id === 's-x').img = 'm-x';
    Object.assign(t.aShot().takes[0], { status: 'completed', media: 'm-y' });
    t.sess.changed(true);
    await sleep(100);
    t.b.transact(() => { shotsMap(t.b).delete('s-x'); t.bShot().get('takes').delete(0, 1); });
    await until(() => !t.app.cur.sections.some(s => s.id === 's-x') && t.aShot().takes.length === 0, 'A drops both');
    g.open(); await sleep(300); await t.bTypes(2);
    assert.ok(!shotsMap(t.b).has('s-x'), 'shot not brought back');
    assert.equal(t.bShot().get('takes').length, 0, 'take not brought back');
    assert.ok(!t.app.cur.sections.some(s => s.id === 's-x'));
  } finally { t.done(); }
});
