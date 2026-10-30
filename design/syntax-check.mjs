// Parses every inline <script> in index.html (the app has no build step, so nothing else would catch a typo before the
// browser does) and looks for U+2028/U+2029 line separators, which break regex literals.
//   node design/syntax-check.mjs <repo-root>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const html = readFileSync(join(process.argv[2] || '.', 'index.html'), 'utf8');
let bad = 0;
const LS = new RegExp('[\\u2028\\u2029]');
for (const m of html.matchAll(/<script(?: id="([^"]*)")?>([\s\S]*?)<\/script>/g)) {
  const name = m[1] || 'main', src = m[2];
  if (src.length < 200) continue;
  try { new Function(src); console.log('PASS parses: ' + name + ' (' + src.length + ' chars)'); }
  catch (e) { bad++; console.log('FAIL parses: ' + name + ' · ' + e.message); }
}
const ls = html.split(/\r?\n/).map((l, i) => (LS.test(l) ? i + 1 : 0)).filter(Boolean);
if (ls.length) { bad++; console.log('FAIL line separators at lines ' + ls.join(', ')); } else console.log('PASS no line separators');
process.exit(bad ? 1 : 0);
