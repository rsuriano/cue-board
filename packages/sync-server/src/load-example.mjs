// @ts-check
/* Node-only (reads files): kept out of import-cueboard.mjs, which collab.js bundles for the browser.

   Reads a .cueboard.json, or example/example.js (the same JSON wrapped in a script). The example's media entries are
   { type, url } (files in example/media/, made by design/example-art.mjs), not data URLs: their url is relative to the
   page, i.e. the folder above example/. They are read and inlined as data URLs, the way the app fetches them when the
   example opens, so cueboardToDoc takes the result like any export. */
import fs from 'node:fs';
import path from 'node:path';
import { parseExampleJS } from './import-cueboard.mjs';

/** @param {string} file @param {{ root?: string }} [opts] root: the folder media urls are relative to (default: the folder above the file's) */
export function loadCueboardFile(file, { root = path.dirname(path.dirname(path.resolve(file))) } = {}) {
  const data = parseExampleJS(fs.readFileSync(file, 'utf8'));
  const base = path.resolve(root);
  for (const m of Object.values((data && data.media) || {})) {
    if (!m || m.data || typeof m.url !== 'string') continue;
    const f = path.resolve(base, m.url);
    if (!f.startsWith(base + path.sep)) throw new Error(`media url outside ${base}: ${m.url}`);
    m.data = `data:${m.type || 'application/octet-stream'};base64,${fs.readFileSync(f).toString('base64')}`;
    delete m.url;
  }
  return data;
}
