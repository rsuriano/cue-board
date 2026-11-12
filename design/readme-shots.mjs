// Screenshots for the README (docs/readme/*.png), on the example project as shipped:
//   node design/run-local.mjs design/readme-shots.mjs <repo-root> [out-dir]      (default out: docs/readme)
// The pictures and takes are the example's own (example/media/, made by design/example-art.mjs), loaded by the app
// as on a first visit. The collaboration view uses a stubbed /collab.js with one other person in the room. Every request outside the local
// server is aborted: nothing reaches OpenRouter or a sync server.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
import { png8 } from './png8.mjs';
import { toShot, tapTile } from './mobile-b-lib.mjs';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out = join(root, 'docs/readme')] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [] };
  const media = { files: () => [], summary: () => ({ total: 0, here: 0, active: 0, unavailable: 0, skipped: 0, failed: 0, relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0, direct: 1, relayed: 0 }), progress: () => null, pause() {}, refresh() {}, downloadAll() {}, download() {}, retry() {} };
  S.ping = () => { if (S.pid) { app.onStatus(S.pid, S.status); app.onPeers(S.pid, S.peers); app.onMedia(S.pid); } };
  return { open(pid) { S.pid = pid; setTimeout(S.ping, 30); return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {}, probe: async () => ({ ok: false }), seed: async () => {} };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/collab.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(STUB); return; }
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', '<meta name="cue-sync-url" content="ws://127.0.0.1:9">');
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];

// ---- in the page: the example as shipped (its pictures and takes come from example/media/); only an API key, and
// for the room view a room entry, are added so the app shows the generate side and the room chip ----
async function seed(page, { room = false } = {}) {
  await page.evaluate(async room => {
    const db = await new Promise(r => { const q = indexedDB.open("cueboard-local", 1); q.onsuccess = () => r(q.result); });
    const st = (n, m) => db.transaction(n, m).objectStore(n), req = q => new Promise(r => { q.onsuccess = () => r(q.result); });
    await req(st("settings", "readwrite").put("sk-or-v1-readme-screenshots", "apiKey"));
    if (room) await req(st("settings", "readwrite").put({ name: "Lucía Ferrer", rooms: { "p-example": { roomId: "r".repeat(22), token: "t".repeat(22), name: "Lucía Ferrer", owner: true } } }, "collab"));
  }, room);
}

async function open(viewport, phone = false, room = false) {
  const ctx = await browser.newContext(phone ? { viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS } : { viewport, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => { const u = r.request().url();
    if (u === 'https://openrouter.ai/api/v1/credits') return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }, body: JSON.stringify({ data: { total_credits: 20, total_usage: 4.45 } }) });
    return u.startsWith(origin) || /^(data|blob):/.test(u) ? r.continue() : r.abort(); });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) errs.push(m.text()); });
  const ready = () => page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.getElementById('audio').duration > 0, null, { timeout: 20000 });
  await page.goto(origin + '/index.html'); await ready();
  await seed(page, { room });
  await page.reload(); await ready(); await page.evaluate(() => document.fonts.ready); await sleep(800);
  return { ctx, page };
}
const quiet = page => page.evaluate(() => { document.getElementById('toast').hidden = true; });
const shot = async (page, name, fullPage = false) => { await quiet(page); await sleep(200); const raw = await page.screenshot({ fullPage }), small = [0.3, 0.15, 0].map(k => png8(raw, k)).find((b, i) => b.length < 290e3 || i === 2), buf = small.length < raw.length ? small : raw;
  writeFileSync(join(out, name + '.png'), buf); console.log('shot', name, Math.round(raw.length / 1024) + ' KB →', Math.round(buf.length / 1024) + ' KB'); };
const seekTo = (page, t) => page.evaluate(t => window.__CUE_MEDIA_TEST.app.seek(t), t);
const top = async page => { await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(5, 5); await sleep(400); };
const D = { width: 1440, height: 1000 };

try {
  // ---- desktop: Cut side with a shot selected and an in/out selection; Takes; Render ----
  {
    const { ctx, page } = await open(D);
    console.log('desktop page height', await page.evaluate(() => document.documentElement.scrollHeight));
    await page.locator('.card').nth(3).click(); await sleep(300);
    await page.evaluate(() => { const A = window.__CUE_MEDIA_TEST.app; A.ioSet('in', 26.8); A.ioSet('out', 64.3); }); await seekTo(page, 33);
    await top(page);
    await shot(page, 'cut', true);
    await page.click('.sidetab[data-side="b"]'); await sleep(400); await page.locator('.bitem').nth(2).click(); await sleep(900); await top(page);
    await shot(page, 'takes');
    await page.click('.sidetab[data-side="a"]'); await sleep(300); await page.locator('.card').nth(3).click(); await top(page);
    await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(500);
    await shot(page, 'render');
    await ctx.close();
  }
  // ---- desktop, in a room with one other person ----
  {
    const { ctx, page } = await open(D, false, true);
    await page.waitForFunction(() => window.__STUB && window.__STUB.pid);
    await page.evaluate(() => { const S = window.__STUB; S.peers = [{ id: 2, name: 'Tomás Ibarra', initials: 'TI', sel: 's-ex-12' }]; S.ping(); });
    await page.locator('.card').nth(9).click(); await sleep(400); await seekTo(page, 108); await top(page);
    await shot(page, 'room', true);
    await ctx.close();
  }
  // ---- phone 390x844: Cut with a shot selected, the Project sheet ----
  {
    const { ctx, page } = await open({ width: 390, height: 844 }, true);
    await toShot(page, 3); await tapTile(page); await sleep(400);
    await shot(page, 'phone-cut');
    await page.tap('#mTabs [data-side="b"]'); await sleep(600);
    await shot(page, 'phone-takes');
    await page.tap('#mTabs [data-side="a"]'); await sleep(300);
    await page.tap('#proj'); await sleep(500);
    await shot(page, 'phone-project');
    await ctx.close();
  }
} catch (e) { console.log('FAIL', e.stack); }
console.log(errs.length ? 'page errors: ' + errs.join(' | ') : 'no page errors');
await browser.close(); srv.close();
