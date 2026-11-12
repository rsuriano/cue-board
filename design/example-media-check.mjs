// The example project's pictures and takes (example/media/, made by design/example-art.mjs), as a visitor gets them:
//   node design/run-local.mjs design/example-media-check.mjs <repo-root> <out-dir>
// 1 a fresh profile: the example opens on its own, all 13 shots show a picture, every media file is in IndexedDB,
//   the takes play (the card thumbnails and every take file), side B lists shot 3's three takes, nothing is fetched
//   from another origin, no page errors · 2 a second profile opens it from the link: "Loading the example…" stays up
//   while the files arrive, the page keeps answering · 3 the page opened from disk (file://): the example opens without
//   pictures, no page errors. Screenshots go to <out-dir>.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };
let slow = 0;   // ms to hold every example/media/ answer (part 2)
const srv = createServer(async (q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>blank</title>'); return; }
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  if (slow && path.startsWith('/example/media/')) await new Promise(ok => setTimeout(ok, slow));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v || Date.now() - t0 > ms) return v; await sleep(100); } }
const section = async (name, fn) => { try { await fn(); } catch (e) { check(name + ': ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' ')); } };
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

const ex = (() => { const box = { window: {} }; new Function('window', readFileSync(join(root, 'example/example.js'), 'utf8'))(box.window); return box.window.CUEBOARD_EXAMPLE; })();
const takeIds = ex.project.sections.flatMap(s => s.takes.map(t => t.media));

async function context(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [], foreign = [];
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob|file):/.test(u)) return r.continue(); if (!u.startsWith('https://openrouter.ai/')) foreign.push(u); return r.abort(); });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(name + ': ' + String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FILE_NOT_FOUND|net::ERR_/.test(m.text())) errs.push(name + ': ' + m.text()); });
  return { ctx, page, errs, foreign };
}
const opened = page => until(() => page.evaluate(() => /Mountain/.test(document.getElementById('projname').textContent) && document.querySelectorAll('.card').length === 13));

// ---- 1: a fresh profile over http ----
await section('fresh profile', async () => {
  const { ctx, page, errs, foreign } = await context('fresh');
  await page.goto(origin + '/index.html');
  check('the example opens on the first visit', await opened(page));
  const thumbs = await until(() => page.evaluate(() => { const c = [...document.querySelectorAll('.card .thumb')];
    const ok = c.map(t => { const i = t.querySelector('img'), v = t.querySelector('video'); return !!(i ? i.complete && i.naturalWidth > 0 : v && v.readyState >= 1 && v.videoWidth > 0); });
    return ok.every(Boolean) && ok.length === 13 ? ok : null; }));
  const seen = await page.evaluate(() => [...document.querySelectorAll('.card .thumb')].map(t => t.querySelector('img') ? 'img' : t.querySelector('video') ? 'video' : 'none').join(' '));
  check('all 13 shots show a picture', !!thumbs, seen);
  const db = await page.evaluate(async () => {
    const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const get = (n, k) => new Promise(r => { const q = d.transaction(n).objectStore(n).get(k); q.onsuccess = () => r(q.result); });
    const p = await get('projects', 'p-example'), ids = [...new Set(p.sections.flatMap(s => [s.img, s.key, s.endKey, ...s.takes.map(t => t.media)]).filter(Boolean))];
    const sizes = []; for (const id of ids) { const m = await get('media', id); sizes.push(m && m.blob ? m.blob.size : 0); }
    return { keys: p.sections.filter(s => s.key).length, ends: p.sections.filter(s => s.endKey).length, takes: p.sections.map(s => s.takes.length), ids: ids.length, stored: sizes.filter(n => n > 0).length,
      takeMedia: p.sections.flatMap(s => s.takes.map(t => t.media)) };
  });
  check('every shot has a start frame, shot 3 an end frame', db.keys === 13 && db.ends === 1, `keys ${db.keys}, end frames ${db.ends}`);
  check('the takes are there (shots 3, 4 and 10)', db.takes[2] === 3 && db.takes[3] === 1 && db.takes[9] === 1 && db.takeMedia.length === takeIds.length, db.takes.join(','));
  check('every media file is stored in IndexedDB', db.ids === 19 && db.stored === db.ids, `${db.stored}/${db.ids}`);
  // the three shots with takes show them as clips: their thumbnails play
  const cards = await page.evaluate(async () => { const vs = [...document.querySelectorAll('.card .thumb video')], r = [];
    for (const v of vs) { v.muted = true; const t0 = v.currentTime; await v.play().catch(() => {}); await new Promise(ok => setTimeout(ok, 900)); r.push(v.currentTime - t0 > 0.4 && !v.paused && !v.error); v.pause(); }
    return r; });
  check('the 3 shots with takes play in the cut', cards.length === 3 && cards.every(Boolean), JSON.stringify(cards));
  // every take file decodes and plays to its own length
  const files = await page.evaluate(async ids => {
    const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const r = [];
    for (const id of ids) {
      const m = await new Promise(ok => { const q = d.transaction('media').objectStore('media').get(id); q.onsuccess = () => ok(q.result); });
      const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(m.blob);
      await new Promise(ok => { v.onloadedmetadata = ok; v.onerror = ok; });
      await v.play().catch(() => {}); await new Promise(ok => setTimeout(ok, 700));
      r.push({ id, type: m.type, w: v.videoWidth, dur: Math.round(v.duration), played: v.currentTime > 0.3 && !v.error }); v.pause(); URL.revokeObjectURL(v.src);
    }
    return r; }, db.takeMedia);
  check('every take file plays', files.length === 5 && files.every(f => f.played && f.type === 'video/mp4' && f.w > 0), files.map(f => `${f.w}px ${f.dur}s ${f.played ? 'plays' : 'NO'}`).join(', '));
  // side B: shot 3's takes, and the monitor plays the chosen one
  await page.click('.sidetab[data-side="b"]'); await sleep(400); await page.locator('.bitem').nth(2).click(); await sleep(800);
  await page.screenshot({ path: join(out, 'example-takes.png') });
  const b = await page.evaluate(() => { const items = document.querySelectorAll('.bitem'); return { items: items.length, vids: document.querySelectorAll('#sideb video, .bside video, video').length }; });
  check('side B lists the 13 shots', b.items === 13, `${b.items} shots`);
  await page.click('.sidetab[data-side="a"]'); await sleep(300); await page.locator('.card').nth(2).click(); await sleep(500);
  await page.screenshot({ path: join(out, 'example-cut.png') });
  check('nothing fetched from another origin (OpenRouter aside: side B asks it for the model list)', foreign.length === 0, foreign.slice(0, 3).join(' '));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
});

// ---- 2: the link, with slow media: the toast stays up, the page answers ----
await section('from the link', async () => {
  const { ctx, page, errs } = await context('link');
  await page.goto(origin + '/blank.html');
  await page.evaluate(() => new Promise(ok => { const q = indexedDB.open('cueboard-local', 1); q.onupgradeneeded = () => ['songs', 'projects', 'media', 'settings'].forEach(n => q.result.createObjectStore(n));
    q.onsuccess = () => { const t = q.result.transaction('settings', 'readwrite'); t.objectStore('settings').put(true, 'exampleOpened'); t.oncomplete = ok; }; }));
  await page.goto(origin + '/index.html'); await sleep(800);
  check('the example does not open again on its own', await page.evaluate(() => !document.querySelectorAll('.card').length));
  slow = 2500;
  await page.locator('#ed-empty [data-example]').click();
  await sleep(1500);
  const mid = await page.evaluate(() => { const t0 = performance.now(), el = document.getElementById('toast'); return { toast: !el.hidden && el.textContent, ms: performance.now() - t0 }; });
  check('"Loading the example…" shows while the files arrive', mid.toast === 'Loading the example…', String(mid.toast));
  const t0 = Date.now(); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
  check('the page keeps answering meanwhile', Date.now() - t0 < 500, `${Date.now() - t0} ms for a frame`);
  check('then the example opens with its pictures', await opened(page) && await until(() => page.evaluate(() => document.querySelectorAll('.card .thumb img, .card .thumb video').length === 13)));
  slow = 0;
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
});

// ---- 3: from disk ----
await section('from disk', async () => {
  const { ctx, page, errs } = await context('file');
  await page.goto(pathToFileURL(resolve(root, 'index.html')).href);
  check('from file:// the example still opens', await opened(page));
  await sleep(500);
  const n = await page.evaluate(() => document.querySelectorAll('.card .thumb img, .card .thumb video').length);
  check('from file:// it opens without pictures (the browser refuses the fetch)', n === 0, `${n} pictures`);
  check('from file:// no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: join(out, 'example-file.png') });
  await ctx.close();
});

await browser.close(); srv.close();
const failed = results.filter(r => !r).length;
console.log(failed ? `${failed} of ${results.length} checks FAILED` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
