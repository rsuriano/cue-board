// The frame ratio and the in/out marks between two browsers in one room (docs/specs/export-render.md, criteria 1, 2
// and 5): the ratio travels like the project's title, an undo never overwrites the other person's later ratio, and the
// marks stay in the tab that set them. A real sync server on a fixed port: run it alone.
//   node design/render-collab-check.mjs <repo-root> <out-dir>
// Paths: CUE_TESTKIT (a folder with playwright-core) and CUE_CHROMIUM override the defaults below.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.CUE_TESTKIT || '/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3366, dataDir = mkdtempSync(join(tmpdir(), 'cue-render-collab-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], errs = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(80); } }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="ws://127.0.0.1:${SYNC_PORT}">`);
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', APP_URL: app };
const made = spawnSync(process.execPath, [join(root, 'packages/sync-server/bin/create-project.mjs'), 'Render check'], { env, encoding: 'utf8' });
const link = /app: +(\S+)/.exec(made.stdout)?.[1];
const server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(100);
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = { off: true }; window.__A = () => window.__CUE_MEDIA_TEST.app; });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) errs.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errs.push(`${name}: ${e.message}`));
  return { ctx, page };
}
const chip = page => page.evaluate(() => (document.getElementById('mstatw').hidden ? '' : document.getElementById('mhead').textContent));
const frame = page => page.evaluate(() => ({ sel: document.getElementById('frame').value, ratio: __A().cur().ratio, a: (r => r.width / r.height)(document.getElementById('mframe').getBoundingClientRect()) }));
const marks = page => page.evaluate(() => { const m = __A().io(); return [m.in, m.out]; });
const synced = page => until(async () => (await chip(page)) === 'Synced');

try {
  if (!link) throw new Error('create-project printed no app link: ' + made.stdout + made.stderr);
  /* A shares the example into the room, B joins from the link */
  const A = await newPage('A'); await A.page.goto(app); await A.page.waitForSelector('.card'); await sleep(500);
  await A.page.goto(link); await A.page.waitForSelector('#dlgJoin[open][data-step="name"]'); await A.page.fill('#jName', 'Ana'); await A.page.click('#jGo');
  await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 }); await A.page.click('#jShare'); await synced(A.page);
  const B = await newPage('B'); await B.page.goto(link); await B.page.waitForSelector('#dlgJoin[open][data-step="name"]'); await B.page.fill('#jName', 'Ben'); await B.page.click('#jGo');
  await B.page.waitForFunction(() => document.querySelectorAll('.card').length > 3, null, { timeout: 9000 }); await synced(B.page);
  let a = await frame(A.page), b = await frame(B.page);
  check('1 · a room project without `ratio` is 16:9 in both tabs', a.sel === '16:9' && b.sel === '16:9' && a.ratio === undefined && b.ratio === undefined, JSON.stringify([a, b]));

  await A.page.selectOption('#frame', '9:16');
  b = await until(async () => { const v = await frame(B.page); return v.sel === '9:16' ? v : null; });
  check('1 · A sets 9:16: it travels to B (selector, project, the monitor\'s frame)', b && b.ratio === '9:16' && Math.abs(b.a - 9 / 16) < .01, JSON.stringify(b || await frame(B.page)));
  await A.page.evaluate(() => __A().flushNow()); await sleep(700); await A.page.reload(); await A.page.waitForSelector('.card'); await synced(A.page);
  a = await frame(A.page);
  check('1 · A reloads: still 9:16 (saved here and in the room)', a.sel === '9:16' && a.ratio === '9:16', JSON.stringify(a));

  /* undo against a collaborator's later change */
  await A.page.selectOption('#frame', '1:1'); await until(async () => (await frame(B.page)).sel === '1:1');
  await B.page.selectOption('#frame', '4:3'); await until(async () => (await frame(A.page)).sel === '4:3');
  await A.page.evaluate(() => document.activeElement.blur()); await A.page.keyboard.press('Control+z'); await sleep(900);
  a = await frame(A.page); b = await frame(B.page);
  check('2 · A\'s undo does not overwrite B\'s later ratio: both stay on 4:3, with a notice', a.sel === '4:3' && b.sel === '4:3' && /Can't undo frame 1:1: the frame changed since/.test(await A.page.$eval('#toast', t => t.textContent)), JSON.stringify([a.sel, b.sel, await A.page.$eval('#toast', t => t.textContent)]));
  await B.page.selectOption('#frame', '16:9'); await until(async () => (await frame(A.page)).sel === '16:9'); await sleep(300);
  await B.page.evaluate(() => document.activeElement.blur()); await B.page.keyboard.press('Control+z'); await sleep(300);
  a = await until(async () => { const v = await frame(A.page); return v.sel === '4:3' ? v : null; });
  check('2 · B\'s own undo restores its previous ratio, here and for A', a && (await frame(B.page)).sel === '4:3', JSON.stringify([a, await frame(B.page)]));

  /* marks stay in their tab */
  await A.page.evaluate(() => { __A().seek(3); }); await A.page.keyboard.press('i'); await A.page.evaluate(() => { __A().seek(9); }); await A.page.keyboard.press('o');
  await A.page.fill('#f-title', 'after the marks'); await until(async () => (await B.page.$$eval('.card .ct', e => e.map(x => x.textContent))).includes('after the marks'));
  const ma = await marks(A.page), mb = await marks(B.page);
  check('5 · A\'s marks are set in A and not synced to B (an edit made after them did arrive)', Math.abs(ma[0] - 3) < .05 && Math.abs(ma[1] - 9) < .05 && mb[0] === null && mb[1] === null, JSON.stringify([ma, mb]));
  const pb = await B.page.evaluate(() => JSON.stringify(__A().cur()));
  check('5 · nothing about the marks is in B\'s copy of the project', !/"(in|out|io|marks)"\s*:/.test(pb));
  await A.page.screenshot({ path: `${out}/room-ratio-and-marks.png` });
  check('no console errors or page errors', !errs.length, errs.slice(0, 5).join(' | '));
} catch (e) {
  check('run completed', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close(); server.kill('SIGTERM'); srv.close();
  rmSync(dataDir, { recursive: true, force: true });
  const fails = results.filter(x => !x).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exitCode = fails ? 1 : 0;
}
