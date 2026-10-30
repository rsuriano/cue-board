// The undo history (the cue-history script in index.html's <head>, run here on its own): inverse changes for every
// kind of edit, merging of rapid sequences, the 100-step cap, conflict skipping, clearing, and the media it holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { H } from './history-src.mjs';
const clone = v => JSON.parse(JSON.stringify(v));

const shot = (id, start, o = {}) => ({ id, start, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [], ...o });
const project = () => ({ id: 'p1', title: 'T', updated: 1, song: { name: 's.mp3', duration: 30, peaks: [0.1, 0.5] }, refs: ['m-ref'],
  sections: [shot('s1', 0, { title: 'one', img: 'm-1', kind: 'image' }), shot('s2', 10, { notes: 'two', takes: [{ id: 't1', status: 'completed', media: 'm-t1' }, { id: 't2', status: 'failed', media: '' }] }), shot('s3', 20)] });
/** record an action on `p` as the app does: diff of the project around it */
function rec(h, p, label, fn, opt) { const before = clone(p); fn(p); return h.push(label, H.diff(before, p), { pid: p.id, ...opt }); }
const ids = p => p.sections.map(s => s.id);

test('every kind of edit undoes and redoes back to the same project', () => {
  const cases = [
    ['delete a shot', p => { p.sections.splice(1, 1); }],
    ['delete the first shot (the next one starts at 0)', p => { p.sections.splice(0, 1); p.sections[0].start = 0; }],
    ['add a cut', p => { p.sections.splice(1, 0, shot('s9', 5)); }],
    ['move a cut', p => { p.sections[1].start = 12.5; }],
    ['swap two shots', p => { const a = p.sections[0].start; p.sections[0].start = p.sections[2].start; p.sections[2].start = a; p.sections.sort((x, y) => x.start - y.start); }],
    ['replace an image', p => { Object.assign(p.sections[0], { img: 'm-new', kind: 'video', clipDur: 4 }); }],
    ['remove an image', p => { Object.assign(p.sections[0], { img: '', kind: '', clipDur: 0 }); }],
    ['a title', p => { p.sections[2].title = 'three'; }],
    ['notes', p => { p.sections[1].notes = 'two, more'; }],
    ['a start frame and keyOff', p => { p.sections[1].key = 'm-k'; p.sections[1].keyOff = false; }],
    ['clear a start frame', p => { p.sections[0].key = ''; p.sections[0].keyOff = true; }],
    ['take in cut', p => { Object.assign(p.sections[1], { img: 'm-t1', kind: 'video', clipDur: 4 }); }],
    ['delete a take', p => { p.sections[1].takes.splice(0, 1); }],
    ['delete a take that was in the cut', p => { p.sections[1].img = 'm-t1'; p.sections[1].takes.splice(0, 1); p.sections[1].img = ''; }],
    ['a take field', p => { p.sections[1].takes[1].status = 'completed'; }],
    ['references', p => { p.refs = ['m-ref', 'm-ref2']; }],
    ['remove a reference', p => { p.refs = []; }],
    ['remove the song', p => { p.song = null; }],
    ['replace the song', p => { p.song = { name: 'other.mp3', duration: 40, peaks: [1] }; }],
    ['the project name', p => { p.title = 'New name'; }],
    ['a new field', p => { p.sections[0].bDur = 6; }],
  ];
  for (const [label, fn] of cases) {
    const h = H.create(), p = project(), before = clone(p);
    const step = rec(h, p, label, fn);
    assert.ok(step, label + ': recorded');
    const after = clone(p);
    assert.notDeepEqual(after, before, label + ': changed something');
    const u = h.undo(p);
    assert.ok(u.ok, label + ': undo applies');
    assert.deepEqual(clone(p), before, label + ': undone to the project before');
    const r = h.redo(p);
    assert.ok(r.ok, label + ': redo applies');
    assert.deepEqual(clone(p), after, label + ': redone to the project after');
    assert.equal(h.canRedo(), false);
  }
});

test('a step that changed nothing is not recorded; undo and redo on empty stacks say so', () => {
  const h = H.create(), p = project();
  assert.equal(rec(h, p, 'nothing', () => {}), null);
  assert.equal(rec(h, p, 'same value', q => { q.title = 'T'; }), null);
  assert.equal(h.canUndo(), false);
  assert.deepEqual(h.undo(p), { ok: false, empty: true });
  assert.deepEqual(h.redo(p), { ok: false, empty: true });
});

test('rapid sequences merge into one step: typing in a field, nudging the same cut; a blur or another cut starts a new one', () => {
  const h = H.create(), p = project();
  const type = v => { const s = p.sections[1], b = s.notes; s.notes = v; h.push('notes of shot 02', [{ k: 'sf', id: 's2', f: 'notes', b, a: v }], { pid: 'p1', merge: 'text:s2:notes' }); };
  type('two,'); type('two, t'); type('two, th'); type('two, three');
  assert.equal(h.size(), 1, 'four keystrokes, one step');
  h.breakMerge(); type('two, three!');
  assert.equal(h.size(), 2, 'after the field blurred, a new step');
  assert.ok(h.undo(p).ok); assert.equal(p.sections[1].notes, 'two, three');
  assert.ok(h.undo(p).ok); assert.equal(p.sections[1].notes, 'two', 'the whole typed run goes in one undo');
  // typing back to the original value leaves no step at all
  type('two, x'); type('two');
  assert.equal(h.size(), 0, 'a merged step whose two sides read the same disappears');
  // nudges: the same cut within the window merges, another cut or a pause does not
  let t = 1000;
  const nudge = (i, dt) => rec(h, p, 'move cut', q => { q.sections[i].start = Math.round((q.sections[i].start + dt) * 100) / 100; }, { merge: 'nudge:' + p.sections[i].id, within: 1500, now: (t += 100) });
  nudge(1, .1); nudge(1, .1); nudge(1, .1);
  assert.equal(h.size(), 1); assert.equal(p.sections[1].start, 10.3);
  nudge(2, .1);
  assert.equal(h.size(), 2, 'another cut: a new step');
  t += 5000; nudge(2, .1);
  assert.equal(h.size(), 3, 'after a pause: a new step');
  assert.ok(h.undo(p).ok); assert.ok(h.undo(p).ok); assert.ok(h.undo(p).ok);
  assert.equal(p.sections[1].start, 10); assert.equal(p.sections[2].start, 20);
});

test('100 steps are kept; older ones fall off and are reported as dropped', () => {
  const dropped = [], h = H.create({ onDrop: l => dropped.push(...l) }), p = project();
  for (let i = 1; i <= 120; i++) rec(h, p, 'title ' + i, q => { q.sections[0].title = 'v' + i; });
  assert.equal(h.size(), 100);
  assert.equal(dropped.length, 20); assert.equal(dropped[0].label, 'title 1');
  let n = 0; while (h.undo(p).ok) n++;
  assert.equal(n, 100); assert.equal(p.sections[0].title, 'v20', 'the oldest kept step restores the value after step 20');
});

test('a new edit clears the redo stack (its steps are dropped); clear() empties both', () => {
  const dropped = [], h = H.create({ onDrop: l => dropped.push(...l) }), p = project();
  rec(h, p, 'a', q => { q.title = 'A'; }); rec(h, p, 'b', q => { q.title = 'B'; });
  assert.ok(h.undo(p).ok); assert.equal(h.canRedo(), true);
  rec(h, p, 'c', q => { q.title = 'C'; });
  assert.equal(h.canRedo(), false); assert.deepEqual(dropped.map(s => s.label), ['b']);
  assert.ok(h.undo(p).ok);
  h.clear();
  assert.equal(h.size(), 0); assert.equal(h.canUndo(), false); assert.equal(h.canRedo(), false);
  assert.deepEqual(dropped.map(s => s.label).sort(), ['a', 'b', 'c']);
  assert.deepEqual(h.undo(p), { ok: false, empty: true });
});

test('a collaborator changed the same thing since: the step is skipped with where, dropped, and their value stays', () => {
  const h = H.create(), p = project();
  rec(h, p, 'notes of shot 02', q => { q.sections[1].notes = 'mine'; });
  p.sections[1].notes = 'mine, and theirs';            // a remote edit landed after the step
  const r = h.undo(p);
  assert.equal(r.ok, false); assert.equal(r.where, 'shot 02'); assert.equal(r.step.label, 'notes of shot 02');
  assert.equal(p.sections[1].notes, 'mine, and theirs', 'nothing overwritten');
  assert.equal(h.canUndo(), false, 'the skipped step is gone'); assert.equal(h.canRedo(), false);
  // the shot itself was deleted elsewhere
  rec(h, p, 'title of shot 03', q => { q.sections[2].title = 'x'; });
  p.sections.splice(2, 1);
  assert.deepEqual([h.undo(p).ok, h.undo(p).empty], [false, true]);
  // an undone step whose value then changed can't be redone either
  rec(h, p, 'move cut', q => { q.sections[1].start = 11; });
  assert.ok(h.undo(p).ok); p.sections[1].start = 9;
  const rr = h.redo(p); assert.equal(rr.ok, false); assert.equal(rr.where, 'shot 02'); assert.equal(p.sections[1].start, 9);
  // a deleted shot re-added by someone else (same id) blocks the undo of its deletion
  rec(h, p, 'delete shot 01', q => { q.sections.splice(0, 1); q.sections[0].start = 0; });
  p.sections.unshift(shot('s1', 0, { title: 'theirs' })); p.sections[1].start = 9;
  const rd = h.undo(p); assert.equal(rd.ok, false); assert.equal(rd.where, 'shot 01');
  assert.equal(p.sections[0].title, 'theirs');
});

test('undoing a delete brings the shot back where it was, with its takes, and the step holds its media until it is dropped', () => {
  const dropped = [], h = H.create({ onDrop: l => dropped.push(...l) }), p = project();
  const s2 = clone(p.sections[1]);
  const step = rec(h, p, 'delete shot 02', q => { q.sections.splice(1, 1); });
  assert.deepEqual(H.mediaOf(step).sort(), ['m-t1']);
  assert.ok(h.holds('m-t1')); assert.ok(!h.holds('m-1'));
  // the next shot was edited meanwhile: not the same thing, so the undo goes through
  p.sections[1].title = 'edited elsewhere';
  assert.ok(h.undo(p).ok);
  assert.deepEqual(ids(p), ['s1', 's2', 's3']); assert.deepEqual(p.sections[1], s2); assert.equal(p.sections[2].title, 'edited elsewhere');
  assert.ok(h.holds('m-t1'), 'on the redo stack it still holds the media');
  rec(h, p, 'title', q => { q.title = 'x'; });
  assert.ok(!h.holds('m-t1'), 'the redo stack went: nothing holds it'); assert.deepEqual(dropped.map(s => s.label), ['delete shot 02']);
  // media held by every kind of change
  const h2 = H.create(), q = project();
  const st = rec(h2, q, 'all media', x => { x.refs = ['m-r9']; x.sections[0].img = 'm-i9'; x.sections[0].key = 'm-k9'; x.sections[0].endKey = 'm-e9'; x.sections[1].takes[1].media = 'm-m9'; x.sections.push(shot('s8', 30, { img: 'm-s8', takes: [{ id: 't8', media: 'm-t8' }] })); });
  assert.deepEqual(H.mediaOf(st).sort(), ['m-1', 'm-e9', 'm-i9', 'm-k9', 'm-m9', 'm-r9', 'm-ref', 'm-s8', 'm-t8']);
});

test('a step from another project never applies (cleared on switch, and guarded)', () => {
  const h = H.create(), p = project();
  rec(h, p, 'title', q => { q.title = 'x'; });
  const other = { ...project(), id: 'p2' };
  const r = h.undo(other);
  assert.equal(r.ok, false); assert.equal(other.title, 'T'); assert.equal(h.canUndo(), false);
});

test('shots keep their order by start after an undo; a take comes back at its position', () => {
  const h = H.create(), p = project();
  rec(h, p, 'slide', q => { const [m] = q.sections.splice(2, 1); m.start = 5; q.sections.splice(1, 0, m); });
  assert.deepEqual(ids(p), ['s1', 's3', 's2']);
  assert.ok(h.undo(p).ok); assert.deepEqual(ids(p), ['s1', 's2', 's3']);
  assert.ok(h.redo(p).ok); assert.deepEqual(ids(p), ['s1', 's3', 's2']);
  rec(h, p, 'delete take', q => { q.sections[2].takes.splice(1, 1); });
  assert.ok(h.undo(p).ok); assert.deepEqual(p.sections[2].takes.map(t => t.id), ['t1', 't2']);
});

test('a remote edit to the open field: openLocs flags it, breakMerge ends the step, the next keystroke keeps their text', () => {
  const h = H.create(), p = project();
  const type = v => { const s = p.sections[1], b = s.notes; s.notes = v; h.push('notes of shot 02', [{ k: 'sf', id: 's2', f: 'notes', b, a: v }], { pid: 'p1', merge: 'text:s2:notes' }); };
  type('two,'); type('two, A');
  // the app, on a remote pull, sees the open step touches [s2, notes] and that the doc's value moved: it breaks the merge
  assert.deepEqual(h.openLocs(), [['s2', 'notes']]);
  p.sections[1].notes = 'two, A and B';            // B's text landed
  h.breakMerge();
  type('two, A and B!');                            // A keeps typing: a new step whose base is B's text
  assert.equal(h.size(), 2);
  assert.ok(h.undo(p).ok); assert.equal(p.sections[1].notes, 'two, A and B', "A's last run undone, B's text kept");
  // the first step now conflicts (the field no longer reads 'two, A'): it is skipped, nothing overwritten
  const r = h.undo(p); assert.equal(r.ok, false); assert.equal(p.sections[1].notes, 'two, A and B');
  // once no step is mergeable, openLocs is empty
  assert.deepEqual(h.openLocs(), []);
});

test('redo after a conflict-skip: the step is gone from both stacks, a following edit is independent', () => {
  const h = H.create(), p = project();
  rec(h, p, 'title', q => { q.sections[0].title = 'A1'; });
  rec(h, p, 'notes', q => { q.sections[1].notes = 'A2'; });
  assert.ok(h.undo(p).ok);                          // undo the notes; it's on redo
  p.sections[1].notes = 'B took it';               // a collaborator changed the same field
  const r = h.redo(p); assert.equal(r.ok, false); assert.equal(r.where, 'shot 02');
  assert.equal(h.canRedo(), false, 'the skipped step left the redo stack');
  // the earlier title step still undoes cleanly
  assert.ok(h.undo(p).ok); assert.equal(p.sections[0].title, 'one');
  assert.equal(p.sections[1].notes, 'B took it', 'untouched');
});

test('memory: 100 steps on a large project store diffs, not snapshots', () => {
  const h = H.create(), p = project();
  for (let i = 0; i < 100; i++) p.sections.push(shot('big' + i, 30 + i, { notes: 'n'.repeat(2000), takes: Array.from({ length: 10 }, (_, j) => ({ id: 'b' + i + '-' + j, status: 'completed', media: 'm' + i + j, prompt: 'p'.repeat(500) })) }));
  const whole = JSON.stringify(p).length;
  for (let i = 0; i < 100; i++) rec(h, p, 'title', q => { q.sections[i].title = 'v' + i; });
  let steps = 0; for (let i = 0; i < 100; i++) steps += JSON.stringify(h.peek()).length, h.undo(p);
  assert.ok(steps < whole / 10, `100 steps weigh ${steps} bytes, the project ${whole}`);
});
