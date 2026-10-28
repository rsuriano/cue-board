import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { cueboardToDoc, docToCueboard, parseExampleJS } from '@cue-board/sync-server/import-cueboard';
import { shotsMap, metaMap } from '@cue-board/sync-server/schema';
import { pushProject, keepPending, docToProject, sanitizeProject, isEmptyRoom, clearShots, initials, sanitizeName, LIMITS } from '../src/convert.mjs';

const example = parseExampleJS(fs.readFileSync(new URL('../../../example/example.js', import.meta.url), 'utf8'));
// the example has no keyframes or takes: give it some, so media refs, takes and refs are covered too
example.media = { 'm-a': { type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }, 'm-b': { type: 'video/mp4', data: 'data:video/mp4;base64,AAAAIGZ0eXA=' } };
Object.assign(example.project.sections[0], { img: 'm-b', kind: 'video', clipDur: 4, key: 'm-a', takes: [{ id: 't1', status: 'completed', media: 'm-b', cost: 0.3, model: 'w' }, { id: 't0', status: 'failed', media: '', error: 'no' }] });
example.project.refs = ['m-a'];
const bytes = u => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');
const sha = b => createHash('sha256').update(b).digest('hex');
const refOf = id => { const m = example.media[id]; if (!m) return null; const b = bytes(m.data); return { sha256: sha(b), bytes: b.length, mime: m.type || '' }; };
const songRef = s => { const b = bytes(example.song.data); return { ...s, sha256: sha(b), mime: example.song.type || '', bytes: b.length }; };
const exportOf = doc => { const d = docToCueboard(doc, { exportedAt: '' }); delete d.project.id; delete d.project.updated; return d; };
const sync = (a, b) => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))); Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))); };

test('writing the example project into an empty doc gives the same doc as the server import (cueboardToDoc)', () => {
  const ref = cueboardToDoc(example).doc;
  const mine = new Y.Doc();
  pushProject(mine, null, structuredClone(example.project), { refOf, songRef });
  assert.deepEqual(exportOf(mine), exportOf(ref));
});

test('doc -> project -> doc round trip, media ids mapped back to local ids, and an empty push writes nothing', () => {
  const doc = new Y.Doc(), p = structuredClone(example.project);
  pushProject(doc, null, p, { refOf, songRef });
  const local = new Map(Object.keys(example.media).map(id => [refOf(id).sha256, id]));
  const v = docToProject(doc, h => local.get(h));
  assert.equal(v.project.sections.length, p.sections.length);
  for (const [i, s] of p.sections.entries()) for (const k of ['id', 'start', 'title', 'notes', 'img', 'key', 'kind', 'imgPrompt', 'vidPrompt']) assert.deepEqual(v.project.sections[i][k], s[k] ?? '', `${s.id}.${k}`);
  assert.deepEqual(v.project.sections[0].takes.map(t => [t.id, t.media]), [['t1', 'm-b'], ['t0', '']]);
  assert.deepEqual(v.project.refs, ['m-a']);
  assert.equal(v.songFile.sha256, songRef({}).sha256);
  let updates = 0; doc.on('update', () => updates++);
  pushProject(doc, v.project, structuredClone(v.project), { refOf, songRef });
  assert.equal(updates, 0, 'no change, no update');
  // unknown hashes come back as sha256-<hex> ids (the app shows "not on this device yet")
  assert.match(docToProject(doc).project.sections.find(s => s.img).img, /^sha256-[0-9a-f]{64}$/);
});

test('concurrent edits from two docs: notes merge by character, a new shot and a moved cut both survive', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  pushProject(a, null, structuredClone(example.project), { refOf, songRef });
  sync(a, b);
  const pa = docToProject(a).project, pb = docToProject(b).project;
  const na = structuredClone(pa), nb = structuredClone(pb);
  na.sections[0].notes = 'A: ' + na.sections[0].notes;
  nb.sections[0].notes = nb.sections[0].notes + ' :B';
  na.sections.push({ id: 's-new', start: 99, title: 'New', notes: '', takes: [] });
  nb.sections[2].start = nb.sections[2].start + 0.5;
  pushProject(a, pa, na, { refOf: () => null, songRef });
  pushProject(b, pb, nb, { refOf: () => null, songRef });
  sync(a, b);
  const ra = docToProject(a).project, rb = docToProject(b).project;
  assert.deepEqual(ra, rb);
  assert.ok(ra.sections[0].notes.startsWith('A: ') && ra.sections[0].notes.endsWith(' :B'));
  assert.ok(ra.sections.some(s => s.id === 's-new'));
  assert.equal(ra.sections.find(s => s.id === pb.sections[2].id).start, pb.sections[2].start + 0.5);
});

test('a media file whose hash is not known yet is left out and retried on the next push', () => {
  const doc = new Y.Doc(), p = { title: 'x', song: null, sections: [{ id: 's1', start: 0, title: '', notes: '', img: 'm-local', kind: 'image', takes: [] }] };
  let known = false;
  const ro = id => (id === 'm-local' ? (known ? { sha256: 'a'.repeat(64), bytes: 3, mime: 'image/png' } : undefined) : null);
  let last = pushProject(doc, null, p, { refOf: ro, songRef: s => s });
  assert.equal(shotsMap(doc).get('s1').get('img'), undefined);
  known = true;
  last = pushProject(doc, last, p, { refOf: ro, songRef: s => s });
  assert.equal(shotsMap(doc).get('s1').get('img').sha256, 'a'.repeat(64));
});

test('fields left out for a hash are reported, and keepPending puts them over the doc\'s state (not over a deleted shot or take)', () => {
  const doc = new Y.Doc(), p = { title: 'x', song: null, refs: ['m-r'], sections: [
    { id: 's1', start: 0, title: '', notes: '', img: 'm-i', kind: 'video', clipDur: 3, takes: [{ id: 't1', status: 'completed', media: 'm-t' }] },
    { id: 's2', start: 5, title: '', notes: '', img: 'm-j', kind: 'image', takes: [] }] };
  const holds = [];
  const last = pushProject(doc, null, p, { refOf: () => undefined, songRef: s => s, pending: h => holds.push(h) });
  assert.deepEqual(holds.map(h => [h.shot, h.take, h.field, h.value]).sort(), [
    [undefined, undefined, 'refs', ['m-r']], ['s1', 't1', 'media', 'm-t'], ['s1', undefined, 'img', 'm-i'], ['s2', undefined, 'img', 'm-j']].sort());
  assert.equal(last.sections[0].img, undefined, 'the base keeps the old value, so the next push retries');
  const v = docToProject(doc).project;
  assert.deepEqual([v.sections[0].img, v.sections[0].kind, v.sections[0].takes[0].media ?? ''], ['', '', ''], 'the doc has no media yet');
  shotsMap(doc).delete('s2');
  const mine = keepPending(docToProject(doc).project, holds);
  assert.deepEqual([mine.sections[0].img, mine.sections[0].kind, mine.sections[0].clipDur, mine.sections[0].takes[0].media, mine.sections[0].takes[0].status], ['m-i', 'video', 3, 'm-t', 'completed']);
  assert.deepEqual(mine.refs, ['m-r']);
  assert.equal(mine.sections.length, 1, 'the deleted shot is not brought back');
});

test('remote data is validated: wrong types, oversize values and junk are dropped, never thrown', () => {
  assert.equal(sanitizeProject(null), null);
  assert.equal(sanitizeProject({ sections: 'x' }), null);
  const big = 'x'.repeat(LIMITS.text + 50);
  const p = sanitizeProject({
    title: { evil: 1 }, sections: [
      { id: 's1', start: 'NaN', notes: big, img: 'javascript:alert(1)', kind: 'script', takes: [{ id: 't1', status: 5, media: '../x' }, { nope: 1 }, 'x'], extra: { deep: 1 } },
      { id: 's1', start: 3 }, { id: '<img src=x>', start: 1 }, 42,
      ...Array.from({ length: LIMITS.shots + 10 }, (_, i) => ({ id: 'n' + i, start: i })),
    ],
  });
  assert.equal(p.title, 'Untitled project');
  assert.equal(p.sections.length, LIMITS.shots - 3, 'the first 500 entries, minus the duplicate and the 2 bad ones');
  const s1 = p.sections.find(s => s.id === 's1');
  assert.equal(s1.notes.length, LIMITS.text);
  assert.equal(s1.img, ''); assert.equal(s1.kind, ''); assert.equal(s1.start, 0); assert.equal(s1.extra, undefined);
  assert.deepEqual(s1.takes.map(t => [t.id, t.status, t.media]), [['t1', undefined, '']]);
  // a doc whose shots aren't maps
  const doc = new Y.Doc(); shotsMap(doc).set('x', 'not a map'); metaMap(doc).set('title', 't');
  assert.equal(docToProject(doc), null);
  assert.equal(sanitizeName('  Ana‮ María\u0000 '), 'Ana María'); assert.equal(initials('Ana María'), 'AM'); assert.equal(initials('zoe'), 'ZO');
});

test('an empty room is one blank shot; clearShots empties it before a share', () => {
  const doc = new Y.Doc();
  pushProject(doc, null, { title: 'Room', song: null, sections: [{ id: 's0', start: 0, title: '', notes: '', imgPrompt: '', vidPrompt: '', takes: [] }] }, { refOf, songRef });
  assert.ok(isEmptyRoom(doc));
  const t = shotsMap(doc).get('s0').get('title'); t.insert(0, 'x');
  assert.ok(!isEmptyRoom(doc));
  clearShots(doc); assert.equal(shotsMap(doc).size, 0);
});
