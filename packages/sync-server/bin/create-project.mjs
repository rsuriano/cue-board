#!/usr/bin/env node
// @ts-check
/* npm run create-project -- "<name>" [--import file.cueboard.json] [--invite <roomId>] [--data-dir <dir>]
   Creates a room in --data-dir, else DATA_DIR, else ./data, and prints its id and an invite link. --invite adds a token to an existing room.
   The link points at PUBLIC_URL (default http://127.0.0.1:$PORT/demo/, the dev demo page). Run it while the server is
   stopped, or for a room the server hasn't loaded: it writes the room's files directly. */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { ProjectStore } from '../src/store.mjs';
import { initProject, metaMap } from '../src/schema.mjs';
import { cueboardToDoc, parseExampleJS } from '../src/import-cueboard.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { import: { type: 'string' }, invite: { type: 'string' }, 'data-dir': { type: 'string' } } });
const store = new ProjectStore(values['data-dir'] || process.env.DATA_DIR || './data');
const base = process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 3300}/demo/`;
// APP_URL (e.g. https://cue.bedrocklabs.dev/): also print a link that opens the app and joins. The token sits in the
// #fragment, which browsers never send to the server; the app strips it from the address bar on load.
const appUrl = process.env.APP_URL || '';
const link = (/** @type {string} */ id, /** @type {string} */ token) =>
  `${base}?room=${id}&token=${token}` + (appUrl ? `\napp:    ${appUrl.replace(/#.*$/, '')}#join=${id}.${token}` : '');

if (values.invite) {
  if (!store.exists(values.invite)) { console.error(`no room ${values.invite}`); process.exit(1); }
  console.log(`invite: ${link(values.invite, store.addToken(values.invite))}`);
  process.exit(0);
}
const name = positionals[0];
if (!name) { console.error('usage: npm run create-project -- "<name>" [--import file.cueboard.json]'); process.exit(64); }

const doc = new Y.Doc();
if (values.import) {
  // a .cueboard.json, or example/example.js (same JSON wrapped in a script)
  const { media, dropped } = cueboardToDoc(parseExampleJS(fs.readFileSync(values.import, 'utf8')), doc);
  console.log(`imported ${values.import}: ${media.size} media file(s) referenced by hash and left out${dropped.length ? `, ${dropped.length} dangling media id(s) dropped` : ''}`);
  metaMap(doc).set('title', name);
} else initProject(doc, { title: name });

const { id, token } = store.createProject(name, doc);
console.log(`room:   ${id}\ninvite: ${link(id, token)}`);
