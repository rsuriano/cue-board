// The undo history as it ships: the cue-history script in index.html's <head>, run on its own (no DOM, no storage).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const html = fs.readFileSync(fileURLToPath(new URL('../../../index.html', import.meta.url)), 'utf8');
const SRC = /<script id="cue-history">([\s\S]*?)<\/script>/.exec(html)[1];
const w = {}; new Function('window', SRC)(w);
export const H = w.cueHistory;
