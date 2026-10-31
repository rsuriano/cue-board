// Undo in a room: two sessions (A and B, each with a fake app and its own history) against a real sync server. A's undo
// is applied to A's project as a new change and pushed like any edit; the history (cue-history, from index.html) decides
// whether the step still applies. Port 3387.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { startServer } from '@cue-board/sync-server';
import { initProject } from '@cue-board/sync-server/schema';
import { ProjectStore } from '../../sync-server/src/store.mjs';
import { H } from './history-src.mjs';

globalThis.window = new EventTarget();
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true, writable: true });
const { createCollab } = await import('../src/collab.mjs');

const PORT = 3387;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 5000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label); await sleep(10); } }
const clone = v => JSON.parse(JSON.stringify(v));
/* the project without its local keys; a shot with no image is read with or without kind/clipDur (sanitizeShot adds them
   on a pull, a client that only pushed never gets them) */
const strip = p => { const { id, updated, ...r } = clone(p); r.sections.forEach(s => { if (!s.img) { delete s.kind; delete s.clipDur; } }); return r; };

let srv, dir;
test.before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-undo-')); srv = await startServer({ port: PORT, dataDir: dir, logLevel: 'silent' }); });
test.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** a client as the app runs one: the session, the project, its own history, and the app's record/undo around edits */
function client(name, pid, roomId, token) {
  const app = { cur: null, pulls: 0, project: () => app.cur, applyRemote: (_p, p) => { app.pulls++; app.cur = { ...p, id: pid }; },
    busy: () => false, focusedText: () => null, mediaBlob: async () => null, songBlob: async () => null, onStatus() {}, onPeers() {}, onEvent() {} };
  const collab = createCollab(app, srv.url.replace(/\/r$/, ''), { media: false });
  const sess = collab.open(pid, { roomId, token, name, dev: 'd' + name });
  const hist = H.create();
  const c = {
    app, sess, hist, name,
    shot: id => app.cur.sections.find(s => s.id === id),
    /** one action, recorded and pushed */
    edit(label, fn) { const before = clone(app.cur); fn(app.cur); const s = hist.push(label, H.diff(before, app.cur), { pid }); sess.changed(true); return s; },
    /** the app's undo: the history decides, the result is pushed like any edit; the notice the app would show */
    undo(dir = 'undo') { const r = dir === 'undo' ? hist.undo(app.cur) : hist.redo(app.cur); if (r.ok) sess.changed(true); return r.ok ? 'Undone: ' + r.step.label : r.empty ? 'Nothing to undo' : `Can't ${dir} ${r.step.label}: ${r.where} changed since`; },
    stop: () => sess.stop(),
  };
  return c;
}
async function room() {
  const seed = new Y.Doc(); initProject(seed, { title: 'Room' });
  const { id: roomId, token } = new ProjectStore(dir).createProject('t', seed);
  const A = client('A', 'pa', roomId, token), B = client('B', 'pb', roomId, token);
  await until(() => A.app.cur && B.app.cur, 'both synced');
  // three shots to work on (the room's first shot gets the id s1)
  A.edit('setup', p => { p.sections[0].id = 's1'; p.sections[0].title = 'one'; p.sections.push({ id: 's2', start: 10, title: 'two', notes: 'n2', shot: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [{ id: 't1', status: 'completed', media: '' }] }, { id: 's3', start: 20, title: 'three', notes: '', shot: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [] }); });
  A.hist.clear();
  await until(() => B.app.cur.sections.length === 3, 'B has the three shots');
  return { A, B, done: () => { A.stop(); B.stop(); } };
}
const converged = async (A, B) => {
  try { await until(() => H.same(strip(A.app.cur), strip(B.app.cur)), 'A and B converge'); }
  catch (e) { console.log('A', JSON.stringify(strip(A.app.cur))); console.log('B', JSON.stringify(strip(B.app.cur))); throw e; }
};

test('A deletes a shot, B edits another shot, A undoes: the shot is back with its take, B\'s edit stays, both converge', async () => {
  const { A, B, done } = await room();
  try {
    A.edit('delete shot 02', p => { p.sections.splice(1, 1); });
    await until(() => B.app.cur.sections.length === 2, 'B sees the delete');
    B.edit('title of shot 03', p => { p.sections.find(s => s.id === 's3').title = 'three, by B'; });
    await until(() => A.shot('s3')?.title === 'three, by B', 'A sees B\'s edit');
    assert.equal(A.undo(), 'Undone: delete shot 02');
    assert.deepEqual(A.app.cur.sections.map(s => s.id), ['s1', 's2', 's3']);
    assert.equal(A.shot('s2').takes[0].id, 't1');
    await until(() => B.app.cur.sections.length === 3, 'B gets the shot back');
    assert.equal(B.shot('s3').title, 'three, by B', 'B\'s edit stays');
    assert.equal(A.shot('s3').title, 'three, by B');
    await converged(A, B);
    // and redo deletes it again, everywhere
    assert.equal(A.undo('redo'), 'Undone: delete shot 02');
    await until(() => B.app.cur.sections.length === 2, 'B sees the redo');
    await converged(A, B);
  } finally { done(); }
});

test('A edits a note, B then edits the same note, A undoes: skipped with a notice, B\'s text untouched', async () => {
  const { A, B, done } = await room();
  try {
    A.edit('notes of shot 02', p => { p.sections[1].notes = 'n2 by A'; });
    await until(() => B.shot('s2').notes === 'n2 by A', 'B sees A\'s note');
    B.edit('notes', p => { p.sections[1].notes = 'n2 by A, then B'; });
    await until(() => A.shot('s2').notes === 'n2 by A, then B', 'A sees B\'s note');
    assert.equal(A.undo(), "Can't undo notes of shot 02: shot 02 changed since");
    assert.equal(A.shot('s2').notes, 'n2 by A, then B');
    assert.equal(A.hist.canUndo(), false, 'the step is gone');
    await sleep(200);
    assert.equal(B.shot('s2').notes, 'n2 by A, then B', 'nothing was pushed');
    await converged(A, B);
    // B's edit to another field of the same shot is not "the same thing": A's undo of its title goes through
    A.edit('title of shot 02', p => { p.sections[1].title = 'two by A'; });
    await until(() => B.shot('s2').title === 'two by A', 'B sees the title');
    B.edit('notes', p => { p.sections[1].notes = 'n2 again'; });
    await until(() => A.shot('s2').notes === 'n2 again', 'A sees the notes');
    assert.equal(A.undo(), 'Undone: title of shot 02');
    await until(() => B.shot('s2').title === 'two', 'B sees the title back');
    assert.equal(B.shot('s2').notes, 'n2 again');
    await converged(A, B);
  } finally { done(); }
});

test('A drags cut 2, B adds a cut between its old and new place (or right next to the old one), A undoes: skipped, shot order kept', async () => {
  const { A, B, done } = await room();
  const cut = (id, start) => ({ id, start, title: id, notes: '', shot: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [] });
  const add = (p, s) => { p.sections.push(s); p.sections.sort((x, y) => x.start - y.start); };   // the app keeps shots by start
  const order = c => [...c.app.cur.sections].sort((x, y) => x.start - y.start).map(s => s.id);
  try {
    A.edit('move cut', p => { p.sections[1].start = 16; });
    await until(() => B.shot('s2').start === 16, 'B sees the move');
    B.edit('cut at 0:13', p => { add(p, cut('b1', 13)); });
    await until(() => A.shot('b1'), 'A sees B\'s cut');
    assert.equal(A.undo(), "Can't undo move cut: shot 03 changed since");
    assert.equal(A.shot('s2').start, 16);
    assert.deepEqual(order(A), ['s1', 'b1', 's2', 's3']);
    await converged(A, B);
    // a cut just short of where it would go back: the shot between would be under the shortest a drag allows
    A.edit('move cut', p => { p.sections.find(s => s.id === 's3').start = 22; });
    await until(() => B.shot('s3').start === 22, 'B sees the second move');
    B.edit('cut at 0:19.9', p => { add(p, cut('b2', 19.9)); });
    await until(() => A.shot('b2'), 'A sees B\'s second cut');
    assert.match(A.undo(), /^Can't undo move cut: /);
    assert.equal(A.shot('s3').start, 22);
    // a cut elsewhere doesn't get in the way
    A.edit('move cut', p => { p.sections.find(s => s.id === 's3').start = 23; });
    await until(() => B.shot('s3').start === 23, 'B sees the third move');
    B.edit('cut at 0:40', p => { add(p, cut('b3', 40)); });
    await until(() => A.shot('b3'), 'A sees B\'s far cut');
    assert.equal(A.undo(), 'Undone: move cut');
    assert.equal(A.shot('s3').start, 22);
    await converged(A, B);
  } finally { done(); }
});

test('undo and redo while disconnected, then reconnect: both converge on A\'s final state, B\'s offline edit kept', async () => {
  const { A, B, done } = await room();
  try {
    A.edit('move cut', p => { p.sections[1].start = 12; });
    A.edit('title of shot 01', p => { p.sections[0].title = 'one, moved'; });
    await until(() => B.shot('s2').start === 12 && B.shot('s1').title === 'one, moved', 'B is up to date');
    navigator.onLine = false; window.dispatchEvent(new Event('offline'));
    await sleep(100);
    assert.equal(A.undo(), 'Undone: title of shot 01');
    assert.equal(A.undo(), 'Undone: move cut');
    assert.equal(A.undo('redo'), 'Undone: move cut');
    B.edit('notes', p => { p.sections[2].notes = 'B while A was away'; });
    await sleep(300);
    assert.equal(B.shot('s1').title, 'one, moved', 'nothing reached B yet');
    navigator.onLine = true; window.dispatchEvent(new Event('online'));
    await until(() => B.shot('s1').title === 'one', 'B gets the undo', 8000);
    assert.equal(B.shot('s2').start, 12, 'the redone cut stays moved');
    await until(() => A.shot('s3').notes === 'B while A was away', 'A gets B\'s offline edit');
    await converged(A, B);
  } finally { done(); }
});

test('a held key in a room: many undos in a row all land, in order, and B ends on the same state', async () => {
  const { A, B, done } = await room();
  try {
    for (let i = 1; i <= 12; i++) A.edit('cut ' + i, p => { p.sections.push({ id: 'c' + i, start: 30 + i, title: 'c' + i, shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [] }); });
    await until(() => B.app.cur.sections.length === 15, 'B has them all');
    for (let i = 0; i < 12; i++) { assert.ok(A.undo().startsWith('Undone'), 'undo ' + i); await sleep(20); }
    assert.equal(A.app.cur.sections.length, 3);
    await until(() => B.app.cur.sections.length === 3, 'B has none of them');
    await converged(A, B);
    for (let i = 0; i < 12; i++) assert.ok(A.undo('redo').startsWith('Undone'), 'redo ' + i);
    await until(() => B.app.cur.sections.length === 15, 'B has them again');
    await converged(A, B);
  } finally { done(); }
});
