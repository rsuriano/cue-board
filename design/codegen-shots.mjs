// Screenshots of the "Generate with code" mock (design/mock-codegen.html, docs/specs/generate-with-code.md).
//   node design/codegen-shots.mjs <repo-root> [out-dir]        (default out: design/out/codegen)
// Env: TESTKIT (folder with playwright-core, default /home/ramiro/testkit/), CHROMIUM (browser binary; default:
// playwright's own). Serves <repo-root> on 127.0.0.1; every other request is aborted and reported.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.TESTKIT || '/home/ramiro/testkit/')('playwright-core');

const [root, out = join(root, 'design/out/codegen')] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const external = [];

const SIZES = [['desktop', 1440, 900], ['phone', 390, 844]];
const STATES = { desktop: ['code', 'progress', 'done', 'error', 'settings', 'connected'], phone: ['code', 'sheet', 'progress', 'done', 'error', 'settings', 'connected'] };
const NAMES = { code: '1-b-side-code', sheet: '2-code-sheet', progress: '3-progress', done: '4-done-versions', error: '5-error', settings: '6-settings-connect', connected: '7-settings-connected' };

for (const [kind, w, h] of SIZES) for (const st of STATES[kind]) {
  const ctx = await browser.newContext(kind === 'phone'
    ? { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS }
    : { viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob):/.test(u)) return r.continue(); external.push(u); return r.abort(); });
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`${origin}/design/mock-codegen.html?state=${st}`);
  await page.waitForFunction(() => document.documentElement.dataset.mock === 'ready', null, { timeout: 30000 });
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
  await new Promise(r => setTimeout(r, 700));
  const file = join(out, `${kind}-${w}x${h}-${NAMES[st]}.png`);
  await page.screenshot({ path: file });
  console.log(file.replace(root + '/', '') + (errs.length ? '  page errors: ' + errs.join(' | ') : ''));
  await ctx.close();
}
if (external.length) console.log('aborted external requests:', [...new Set(external)].join(', '));
await browser.close(); srv.close();
