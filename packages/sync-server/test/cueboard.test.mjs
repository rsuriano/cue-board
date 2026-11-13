import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { cueboardToDoc, docToCueboard, withoutPayloads, mediaId } from '../src/import-cueboard.mjs';
import { loadCueboardFile } from '../src/load-example.mjs';
import { orderedShots, useInCut, setInCut, cutRange } from '../src/schema.mjs';

// since #34 the example's media are files in example/media/ ({ type, url } entries, not data URLs): load it the way
// create-project --import does, with the files read and inlined, so its pictures and takes are in the round trip too
const example = loadCueboardFile(fileURLToPath(new URL('../../../example/example.js', import.meta.url)));
const viaWire = doc => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(doc)); return d; };

test('(f) .cueboard.json round trip is lossless on the example (media payloads out, hashes in)', t => {
  const { doc, media, dropped } = cueboardToDoc(example);
  assert.deepEqual(dropped, []);
  const update = Y.encodeStateAsUpdate(doc);
  t.diagnostic(`example as one Yjs update: ${update.length} bytes (${example.project.sections.length} shots; peaks alone ${JSON.stringify(example.project.song.peaks).length} bytes of JSON)`);
  for (const m of media.values()) assert.ok(!Buffer.from(update).includes(m.data.subarray(0, 64)), 'no payload bytes in the doc');

  const back = docToCueboard(viaWire(doc));
  delete back.exportedAt;
  assert.deepEqual(back, withoutPayloads(example));
  assert.equal(back.song.sha256.length, 64);

  // with the payloads handed back, it's the original file byte for byte, media ids aside (they come back as sha256-<hex>)
  const full = docToCueboard(viaWire(doc), { media, exportedAt: example.exportedAt });
  assert.ok(Object.keys(example.media).length > 0, 'the example ships media');
  assert.equal(JSON.stringify(full.project), JSON.stringify(withoutPayloads(example).project));
  const idOf = data => mediaId(createHash('sha256').update(Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')).digest('hex'));
  for (const [id, m] of Object.entries(example.media)) assert.equal(full.media[idOf(m.data)]?.data, m.data, id);
  assert.equal(full.song.data, example.song.data);
});

// the example has no takes, media or references: cover them with a small synthetic export
const png = 'data:image/png;base64,' + Buffer.from('fake png bytes').toString('base64');
const mp4 = 'data:video/mp4;base64,' + Buffer.from('fake mp4 bytes').toString('base64');
const synthetic = {
  format: 'cueboard', version: 1, exportedAt: '2026-10-28T00:00:00.000Z',
  project: {
    id: 'p-x', title: 'Synthetic', created: 1, updated: 2, song: null, refs: ['m-ref'], futureKey: { nested: [1, 2] },
    sections: [
      { id: 's-1', start: 0, title: 'One', shot: 'Wide', notes: 'n', img: 'm-take', imgPrompt: 'ip', vidPrompt: 'vp', key: 'm-key', endKey: '', kind: 'video', clipDur: 5.04, keyOff: false,
        takes: [
          { id: 't-2', jobId: 'j2', model: 'wan', modelName: 'Wan 3.0', res: '720p', dur: 5, audio: false, seed: '', prompt: 'p', start: true, end: false, est: 0.4, cost: null, status: 'failed', created: 3, media: '', error: 'boom', note: '' },
          { id: 't-1', jobId: 'j1', model: 'wan', modelName: 'Wan 3.0', res: '480p', dur: 5, audio: true, seed: 42, prompt: 'p', start: true, end: true, est: 0.2, cost: 0.19, status: 'completed', created: 2, media: 'm-take', error: '', note: '', clipDur: 5.04, done: 4 },
        ] },
      { id: 's-2', start: 3.5, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: 'm-key', takes: [] },
    ],
  },
  media: { 'm-ref': { type: 'image/png', data: png }, 'm-key': { type: 'image/png', data: png }, 'm-take': { type: 'video/mp4', data: mp4 } },
  song: null,
};

test('(f) round trip keeps takes, frames, references, unknown keys; useInCut is derived', () => {
  const { doc, media } = cueboardToDoc(synthetic);
  assert.equal(media.size, 2, 'same bytes = same hash = one entry (m-ref and m-key are identical)');
  const d = viaWire(doc);
  const back = docToCueboard(d);
  delete back.exportedAt;
  assert.deepEqual(back, withoutPayloads(synthetic));

  const [s1] = orderedShots(d), takes = s1.get('takes');
  assert.deepEqual(takes.toArray().map(t => useInCut(s1, t)), [false, true]);
  assert.deepEqual(cutRange(d, 's-1'), { start: 0, end: 3.5 });
  setInCut(s1, takes.get(1));
  assert.equal(docToCueboard(d).project.sections[0].img, mediaId(takes.get(1).get('media').sha256));
});
