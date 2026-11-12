// Shared harness for the phone redesign checks (docs/specs/mobile-redesign-b.md): design/mobile-b-check.mjs and
// design/mobile-b-shots.mjs. Not a check itself: run on its own it does nothing.
// The app is served from 127.0.0.1 with a sync URL nothing listens on and /collab.js as a stub (so the Project sheet
// has its Collaboration section); every request outside the local server is aborted.
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [], files: [] };
  const media = { files: () => S.files, summary: () => ({ total: 0, here: 0, active: 0, unavailable: 0, skipped: 0, failed: 0, relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0 }), progress: () => null, pause() {}, refresh() {}, downloadAll() {}, download() {}, retry() {} };
  return { open(pid) { S.pid = pid; return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; }, forget() {}, dropMedia() {}, probe: async () => ({ ok: false }), seed: async () => {} };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
export const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function start(root) {
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
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
  // a phone page on the example project (its song loaded), errors collected
  async function open([width, height], { phone = true, url = origin + '/index.html', wait = true } = {}) {
    const ctx = await browser.newContext(phone ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS, acceptDownloads: true } : { viewport: { width, height } });
    await ctx.route('**/*', r => (r.request().url().startsWith(new URL(url).origin) ? r.continue() : r.abort()));
    await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
    const page = await ctx.newPage(), errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await page.goto(url);
    if (wait) { await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.getElementById('audio').duration > 0, null, { timeout: 20000 }); await page.evaluate(() => document.fonts.ready); await sleep(500); }
    return { ctx, page, errs };
  }
  return { origin, browser, open, close: async () => { await browser.close(); srv.close(); } };
}

// real touch through CDP. pts: one finger's path; two: [[a0,b0],[a1,b1]…] with two fingers per step
export async function touch(page, pts, { hold = 0, steps = 8 } = {}) {
  const c = await page.context().newCDPSession(page);
  const tp = p => (Array.isArray(p[0]) ? p : [p]).map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }));
  const mix = (a, b, k) => Array.isArray(a[0]) ? a.map((q, i) => [q[0] + (b[i][0] - q[0]) * k, q[1] + (b[i][1] - q[1]) * k]) : [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) });
  if (hold) await sleep(hold);
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(mix(pts[k - 1], pts[k], i / steps)) }); await sleep(16); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach(); await sleep(250);
}

// the app's state as a check reads it
export const state = page => page.evaluate(() => {
  const A = window.__CUE_MEDIA_TEST.app, s = A.S(), a = document.getElementById('audio'), sc = document.getElementById('tl-scroll'), cv = document.getElementById('tl').getBoundingClientRect();
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const toast = document.getElementById('toast');
  return { n: s.length, ids: s.map(x => x.id), starts: s.map(x => x.start), t: a.currentTime, d: a.duration, paused: a.paused, rate: a.playbackRate,
    P: (sc.scrollWidth - sc.clientWidth) / a.duration, left: sc.scrollLeft, cv: { x: cv.x, y: cv.y, w: cv.width, h: cv.height }, band: cv.height ? cv.y + A.mLayout(cv.height).top + 20 : 0, wave: cv.height ? cv.y + A.mLayout(cv.height).wave + 30 : 0,
    bar: [...document.querySelectorAll('#mTool > *')].filter(vis).map(e => e.id), toast: toast.hidden ? '' : toast.textContent,
    at: s.findLastIndex(x => x.start <= a.currentTime + 1e-6) };
});
// scroll the timeline so the playhead is in the middle of shot i (the selection follows, as a finger's scroll does)
export const toShot = async (page, i) => { await page.evaluate(i => { const s = window.__CUE_MEDIA_TEST.app.S(), sc = document.getElementById('tl-scroll'), d = document.getElementById('audio').duration, P = (sc.scrollWidth - sc.clientWidth) / d;
  sc.scrollLeft = Math.round(((s[i].start + (s[i + 1] ? s[i + 1].start : d)) / 2) * P); }, i); await sleep(350); };
// tap the tile under the playhead: selects that shot (or deselects it when it was the selected one)
export const tapTile = async page => { const s = await state(page); await page.touchscreen.tap(s.cv.x + s.cv.w / 2, s.band); await sleep(250); };
export const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
