// The phone layout (below 820px, docs/mobile/PLAN.md) in Chromium with iPhone 14 and Pixel 7 emulation, real touch
// events through CDP (Input.dispatchTouchEvent: the browser scrolls, long-presses and drags as on a phone).
//   node design/mobile-check.mjs <repo-root> <out-dir>
// Same harness as design/topbar-check.mjs: /collab.js is a stub whose status, peers and files the script sets, and
// index.html gets a sync URL nothing listens on. Every request outside the local server is aborted (no OpenRouter).
// Screenshots of every phone state go to <out-dir>/<device>-<state>.png.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [], files: [], dl: [], all: 0, refreshes: 0 };
  const summary = () => { const n = s => S.files.filter(f => f.state === s).length;
    return { total: S.files.length, here: n('here'), active: n('downloading') + n('queued'), unavailable: n('unavailable'), skipped: n('skipped'), failed: n('failed'), relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0 }; };
  const media = { files: () => S.files, summary, progress: () => null, pause() {},
    // as media.mjs: refresh re-reads the limits, a video held for Wi-Fi is fetched once they allow it, then onMedia
    refresh() { S.refreshes++; if (S.pid && app.mediaLimits(S.pid).video !== false) S.files.forEach(f => { if (f.state === 'skipped' && f.skip === 'video') { f.state = 'queued'; f.skip = ''; } }); setTimeout(S.ping, 0); }, downloadAll(only) { S.all++; S.allList = only; if (!only) S.override = true; }, download(h){ S.dl.push(h); }, retry() {} };
  // as media.mjs: downloadAll() without a list fetches everything from then on, the phone's list only those files
  S.ping = () => { if (S.override) S.files.forEach(f => { if (f.state === 'skipped') { f.state = 'queued'; f.skip = ''; } }); if (S.pid) { app.onStatus(S.pid, S.status); app.onPeers(S.pid, S.peers); app.onMedia(S.pid); } };
  return {
    open(pid) { S.pid = pid; setTimeout(S.ping, 30);
      return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {},
    probe: async () => ({ ok: true, empty: false, shots: 2, title: 'Night drive', update: null,
      project: { title: 'Night drive', song: null, sections: [0, 6].map((start, i) => ({ id: 'sr' + i, start, title: i ? 'Second' : 'First', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [] })) } }),
    seed: async () => {},
  };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
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
const results = [];
const check = (dev, name, ok, ev = '') => { results.push({ dev, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} [${dev}] ${name}${ev ? ' · ' + ev : ''}`); };
const DEVICES = {
  'iphone14': { viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'pixel7': { viewport: { width: 412, height: 839 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAGklEQVR4nGP8z4AKmBgYGBgYGBgYGBgYGAAAkQABZyH5NwAAAABJRU5ErkJggg==', 'base64');

async function touch(page, pts, { hold = 0, steps = 8 } = {}) {
  const c = await page.context().newCDPSession(page);
  const tp = ([x, y]) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) });
  if (hold) await page.waitForTimeout(hold);
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= steps; i++) {
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]) });
    await page.waitForTimeout(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach(); await page.waitForTimeout(250);
}
const filesHidden = page => page.evaluate(() => document.getElementById('mpanel').hidden);
// the files indicator isn't in the phone's bar: the Projects sheet's "Files and downloads" row opens the panel
const openFiles = async page => { if (await filesHidden(page)) { await page.tap('#proj'); await page.waitForTimeout(300); await page.tap('#mFiles'); await page.waitForTimeout(200); } };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const app = page => page.evaluate(() => { const a = window.__CUE_MEDIA_TEST.app, s = a.S(); return { n: s.length, ids: s.map(x => x.id), starts: s.map(x => x.start), img: s.map(x => x.img), sel: document.querySelector('#mPeek .ed-n')?.textContent }; });
const tl = page => page.evaluate(() => { const r = document.querySelector('.timeline').getBoundingClientRect(), c = document.getElementById('tl').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, band: c.y + window.__CUE_MEDIA_TEST.app.mLayout(c.height).top + 20 }; });

for (const [dev, opts] of Object.entries(DEVICES)) {
  const ctx = await browser.newContext({ ...opts });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
  const page = await ctx.newPage(), errs = [], blocked = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') (/Failed to load resource/.test(m.text()) ? blocked : errs).push(m.text()); });
  page.on('requestfailed', q => { if (!q.url().startsWith(origin)) blocked.push(q.url()); });
  const shot = n => page.screenshot({ path: join(out, `${dev}-${n}.png`) });
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.querySelector('#mPeek .m-peekb'), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await shot('cut');
  check(dev, 'phone layout: tabs and toolbar shown, the peek row only from 700px tall; desktop bar items hidden', await page.evaluate(() => ['mTabs', 'mTool'].every(id => document.getElementById(id).getClientRects().length) && !!document.getElementById('mPeek').getClientRects().length === innerHeight >= 700 && !document.querySelector('.sides').getClientRects().length && !document.getElementById('strip').getClientRects().length));
  check(dev, 'the whole side A deck fits the screen (tab bar on screen)', await page.evaluate(() => document.getElementById('mTabs').getBoundingClientRect().bottom <= innerHeight + 1));
  const small = await page.evaluate(() => [...document.querySelectorAll('#sideA button,#sideA select,.m-tabs button,.top button')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map(b => { const r = b.getBoundingClientRect(); return [b.id || b.className || b.textContent.trim(), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44));
  check(dev, 'every visible control on side A is at least 44px', !small.length, JSON.stringify(small));
  const fonts = await page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=file]),textarea,select')].map(e => parseFloat(getComputedStyle(e).fontSize)).filter(v => v < 16).length);
  check(dev, 'inputs are 16px (no iOS zoom on focus)', fonts === 0, fonts + ' smaller');

  // scrub: drag the timeline with a finger, the time follows the scroll
  let T = await tl(page);
  const t0 = await page.evaluate(() => document.getElementById('audio').currentTime);
  await touch(page, [[T.x + T.w * .75, T.y + T.h * .7], [T.x + T.w * .25, T.y + T.h * .7]]);
  await page.waitForTimeout(400);
  const sc = await page.evaluate(() => { const s = document.getElementById('tl-scroll'), a = document.getElementById('audio'); return { left: s.scrollLeft, t: a.currentTime, tc: document.getElementById('tc').textContent }; });
  check(dev, 'dragging the timeline scrubs (scroll = time)', sc.t > t0 + 2 && sc.left > 0, `t ${t0.toFixed(2)} → ${sc.t.toFixed(2)}, ${sc.tc}`);
  await shot('scrubbed');

  // add a cut at the playhead (scrolled to the middle of the shot under it first, away from its cuts)
  await page.evaluate(() => { const s = window.__CUE_MEDIA_TEST.app.S(), sc = document.getElementById('tl-scroll'), d = document.getElementById('audio').duration, P = (sc.scrollWidth - sc.clientWidth) / d, t = document.getElementById('audio').currentTime, i = s.findLastIndex(x => x.start <= t);
    sc.scrollLeft = Math.round(((s[i].start + (s[i + 1] ? s[i + 1].start : d)) / 2) * P); });
  await page.waitForTimeout(400); sc.t = await page.evaluate(() => document.getElementById('audio').currentTime);
  let A = await app(page);
  await page.tap('#mtCut'); await page.waitForTimeout(300);
  let B = await app(page);
  check(dev, 'Cut here adds a cut at the playhead', B.n === A.n + 1 && B.starts.some(s => Math.abs(s - sc.t) < .05), `${A.n} → ${B.n}`);

  // trim: drag the new cut's grip right by 36px
  const g = await page.evaluate(() => { const b = [...document.querySelectorAll('#mGrips .grip:not([hidden])')].sort((p, q) => Math.abs(p.getBoundingClientRect().x + 22 - innerWidth / 2) - Math.abs(q.getBoundingClientRect().x + 22 - innerWidth / 2))[0]; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, i: +b.dataset.i }; });
  const before = B.starts[g.i];
  await touch(page, [[g.x, g.y], [g.x + 36, g.y]]);
  let C = await app(page);
  const P = await page.evaluate(() => { const s = document.getElementById('tl-scroll'); return (s.scrollWidth - s.clientWidth) / Math.max(1, document.getElementById('audio').duration || 1); });
  check(dev, 'dragging a cut grip trims the cut', C.starts[g.i] > before + .5, `${before} → ${C.starts[g.i]} (≈${(36 / P).toFixed(2)} s expected)`);
  await shot('trim');
  // tap the grip: cut mode, ±0.1 s
  const g2 = await page.evaluate(i => { const b = document.querySelector(`#mGrips .grip[data-i="${i}"]`); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, g.i);
  check(dev, 'while a cut moves, the toolbar reads its time and both lengths', await page.isVisible('#mtRead') && /is .* s/.test(await page.textContent('#mtRead')));
  if (!(await page.isVisible('#mtPlus'))) { await page.touchscreen.tap(g2.x, g2.y); await page.waitForTimeout(200); }
  const s0 = (await app(page)).starts[g.i];
  await page.tap('#mtPlus'); await page.waitForTimeout(150);
  const s1 = (await app(page)).starts[g.i];
  check(dev, 'tapping a grip picks the cut; +0.1 s nudges it', Math.abs(s1 - s0 - .1) < .011 && await page.isVisible('#mtRead'), `${s0} → ${s1}`);
  await shot('cut-selected');
  // a collaborator inserts a shot just before the picked cut: the pick stays on the same cut
  const ins = await page.evaluate(i => { const a = window.__CUE_MEDIA_TEST.app, s = a.S(), id = s[i].id, at = +((s[i - 1].start + s[i].start) / 2).toFixed(2);
    s.splice(i, 0, { ...s[i], id: 'remote-ins', start: at, title: 'Inserted', takes: [] }); a.renderAll(); return { id, at, s0: s[i + 1].start }; }, g.i);
  await page.waitForTimeout(150); await page.tap('#mtPlus'); await page.waitForTimeout(150);
  const after = await page.evaluate(() => { const s = window.__CUE_MEDIA_TEST.app.S(); return Object.fromEntries(s.map(x => [x.id, x.start])); });
  check(dev, 'a remote insert before the picked cut: +0.1 s still moves the same cut, not the new one', Math.abs(after[ins.id] - ins.s0 - .1) < .011 && after['remote-ins'] === ins.at, `${ins.s0} → ${after[ins.id]}, inserted ${ins.at} → ${after['remote-ins']}`);
  await page.evaluate(() => { const a = window.__CUE_MEDIA_TEST.app, s = a.S(); s.splice(s.findIndex(x => x.id === 'remote-ins'), 1); a.renderAll(); });
  await page.tap('#mtDone');

  // reorder: hold a shot tile, drag it onto the middle of its neighbour (swap)
  T = await tl(page);
  A = await app(page);
  const selIdx = await page.evaluate(() => { const a = window.__CUE_MEDIA_TEST.app; return a.S().findIndex(s => s.start <= document.getElementById('audio').currentTime + 1e-6 && true); });
  const tiles = await page.evaluate(() => { const s = window.__CUE_MEDIA_TEST.app.S(), sc = document.getElementById('tl-scroll'), cw = sc.clientWidth, P = (sc.scrollWidth - cw) / document.getElementById('audio').duration, off = sc.scrollLeft - cw / 2, t = document.getElementById('audio').currentTime;
    const i = s.findLastIndex(x => x.start <= t), mid = k => ((s[k].start + (s[k + 1] ? s[k + 1].start : document.getElementById('audio').duration)) / 2) * P - off; return { i, a: mid(i), b: s[i + 1] ? mid(i + 1) : null }; });
  if (tiles.b != null && tiles.b < T.w - 50) {
    await touch(page, [[T.x + tiles.a, T.band], [T.x + tiles.b, T.band]], { hold: 650, steps: 14 });
    B = await app(page);
    check(dev, 'hold a shot and drop it on its neighbour: swapped', B.ids[tiles.i] === A.ids[tiles.i + 1] && B.ids[tiles.i + 1] === A.ids[tiles.i], `${A.ids.slice(tiles.i, tiles.i + 2)} → ${B.ids.slice(tiles.i, tiles.i + 2)}`);
  } else check(dev, 'hold a shot and drop it on its neighbour: swapped', false, 'neighbour not on screen ' + JSON.stringify(tiles));
  // Move → Earlier / Later (the button way)
  await page.tap('#mtMove'); await shot('move');
  A = await app(page); await page.tap('#mtNext'); B = await app(page);
  check(dev, 'Move · Later swaps the shot with the next one', A.ids.join() !== B.ids.join() && B.n === A.n);
  await page.tap('#mtDone');

  // an armed Delete disarms when the selection changes: a scroll onto another shot, then playback crossing a cut.
  // The second tap (well within the 2.6 s) only arms again, nothing is deleted.
  const armed = () => page.evaluate(() => document.getElementById('mtDel').hasAttribute('data-armed'));
  const selId = () => page.evaluate(() => { const s = window.__CUE_MEDIA_TEST.app.S(), t = document.getElementById('audio').currentTime; return s[s.findLastIndex(x => x.start <= t)].id; });
  A = await app(page); const shotA = await selId();
  await page.tap('#mtDel'); const arm1 = await armed();
  await page.evaluate(() => { const s = window.__CUE_MEDIA_TEST.app.S(), sc = document.getElementById('tl-scroll'), a = document.getElementById('audio'), P = (sc.scrollWidth - sc.clientWidth) / a.duration;
    const i = s.findLastIndex(x => x.start <= a.currentTime), j = s[i + 1] ? i + 1 : i - 1; sc.scrollLeft = Math.round(((s[j].start + (s[j + 1] ? s[j + 1].start : a.duration)) / 2) * P); });
  await page.waitForTimeout(250);
  const shotB = await selId(), dis1 = !(await armed());
  await page.tap('#mtDel'); await page.waitForTimeout(150); B = await app(page);
  check(dev, 'armed Delete, then a scroll onto another shot: disarmed, a second tap deletes nothing', arm1 && dis1 && shotA !== shotB && B.n === A.n && B.ids.includes(shotA) && B.ids.includes(shotB), `${shotA} → ${shotB}, ${A.n} → ${B.n}`);
  // that tap armed Delete on B: let it lapse, go just before the next cut, arm, play across it
  await page.waitForTimeout(2700);
  await page.evaluate(() => { const s = window.__CUE_MEDIA_TEST.app.S(), a = document.getElementById('audio'), i = s.findLastIndex(x => x.start <= a.currentTime), c = s[i + 1] || s[i];
    a.currentTime = Math.max(s[i].start + .05, c.start - .25); });
  await page.waitForTimeout(300);
  A = await app(page); const shotC = await selId(); await page.tap('#mtDel'); const arm2 = await armed();
  await page.tap('#play'); await page.waitForFunction(id => { const s = window.__CUE_MEDIA_TEST.app.S(), t = document.getElementById('audio').currentTime; return s[s.findLastIndex(x => x.start <= t)].id !== id; }, shotC, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(120); await page.tap('#play');
  const shotD = await selId(), dis2 = !(await armed());
  await page.tap('#mtDel'); await page.waitForTimeout(150); B = await app(page);
  check(dev, 'armed Delete, then playback crosses a cut: disarmed, a second tap deletes nothing', arm2 && dis2 && shotC !== shotD && B.n === A.n && B.ids.includes(shotC) && B.ids.includes(shotD), `${shotC} → ${shotD}, armed ${arm2}/${!dis2}, ${A.n} → ${B.n}`);
  await page.waitForTimeout(2700);

  // delete (two taps)
  A = await app(page); await page.tap('#mtDel'); await page.waitForTimeout(100); await page.tap('#mtDel'); await page.waitForTimeout(200); B = await app(page);
  check(dev, 'Delete (tap twice) removes the shot', B.n === A.n - 1, `${A.n} → ${B.n}`);

  // upload a photo into the selected shot
  A = await app(page);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.tap('#mtImg')]);
  await fc.setFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG }); await page.waitForTimeout(800);
  B = await app(page);
  check(dev, 'Photo uploads an image into the selected shot', B.img.filter(Boolean).length === A.img.filter(Boolean).length + 1 || A.img.join() !== B.img.join());

  // details sheet: opens half height, full height on focus, closes and gives focus back
  await page.tap((await page.isVisible('#mPeek .m-peekb')) ? '#mPeek .m-peekb' : '#mtDet'); await page.waitForTimeout(300);
  const half = await page.evaluate(() => ({ open: document.body.classList.contains('m-ed'), top: document.getElementById('editor').getBoundingClientRect().top, play: document.getElementById('play').getBoundingClientRect().bottom }));
  check(dev, 'Details opens as a sheet under the transport (Play stays visible)', half.open && half.top >= half.play - 1, JSON.stringify(half));
  await shot('details');
  check(dev, 'no horizontal overflow with the details sheet', (await overflow(page)) <= 0);
  await page.tap('#f-title'); await page.waitForTimeout(400);
  check(dev, 'focusing a field: the sheet goes full height', await page.evaluate(() => document.body.classList.contains('m-full') && document.getElementById('editor').getBoundingClientRect().top < 60));
  await page.keyboard.type(' — a long title that keeps going and going past the edge of a phone screen');
  await shot('details-typing');
  await page.tap('#mShotChips [data-shot="Close-up"]'); await page.waitForTimeout(100);
  check(dev, 'shot type chips set the field', (await page.inputValue('#f-shot')) === 'Close-up');
  await page.tap('#mEdClose'); await page.waitForTimeout(300);
  check(dev, 'the sheet closes', !(await page.evaluate(() => document.body.classList.contains('m-ed'))));
  check(dev, 'a long shot title: no overflow (the peek row truncates it)', (await overflow(page)) <= 0 && await page.evaluate(() => { const e = document.querySelector('#mPeek .pt'); return !e.getClientRects().length || e.scrollWidth > e.clientWidth; }));

  // tabs
  await page.tap('#mTabs [data-side="b"]'); await page.waitForTimeout(400);
  check(dev, 'Takes tab shows side B, generation hidden', await page.evaluate(() => !document.getElementById('sideB').hidden && !document.querySelector('.genbox').getClientRects().length && document.querySelector('#mTabs [data-side="b"]').getAttribute('aria-selected') === 'true'));
  check(dev, 'no horizontal overflow on side B', (await overflow(page)) <= 0);
  await shot('takes');
  await page.evaluate(() => document.getElementById('bTakes').scrollIntoView()); await shot('takes-list');
  await page.tap('#mTabs [data-side="a"]'); await page.waitForTimeout(300);
  check(dev, 'Cut tab back to side A', await page.evaluate(() => !document.getElementById('sideA').hidden));

  // project sheet: song picker, then no room yet (Join)
  await page.tap('#proj'); await page.waitForTimeout(300);
  check(dev, 'the project name opens the Project sheet', await page.evaluate(() => document.getElementById('mProj').open));
  await shot('project');
  check(dev, 'no horizontal overflow with the Project sheet', (await overflow(page)) <= 0);
  const acc = await page.getAttribute('#song', 'accept');
  const [sc2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.tap('#mSong')]);
  check(dev, 'song picker opens, accept lists the extensions (iOS)', !!sc2 && /\.mp3/.test(acc) && /\.m4a/.test(acc), acc);

  // join a room from an invite link, then presence, files, Wi-Fi only, size confirmation
  const room = 'roomroomroomroom1234', token = 'tokentokentokentoken5678';
  const p2 = await ctx.newPage(); p2.on('pageerror', e => errs.push(String(e)));
  await p2.goto(origin + `/index.html#join=${room}.${token}`);
  await p2.waitForSelector('#dlgJoin[open] #jName', { timeout: 10000 });
  await p2.screenshot({ path: join(out, `${dev}-join.png`) });
  await p2.fill('#jName', 'Ana Pérez'); await p2.tap('#jGo');
  // this phone already has a project open: the room opens as a new project next to it
  await p2.waitForSelector('#dlgJoin[open] #jNew:visible', { timeout: 10000 }); await p2.screenshot({ path: join(out, `${dev}-join-choose.png`) }); await p2.tap('#jNew');
  await p2.waitForFunction(() => /Night drive/.test(document.getElementById('projname').textContent), null, { timeout: 10000 });
  check(dev, 'a #join= link joins the room on the phone', true);
  await p2.waitForTimeout(300);
  await p2.evaluate(() => { const S = window.__STUB; S.peers = Array.from({ length: 12 }, (_, i) => ({ id: i + 2, name: ['Julia Martínez', 'Nacho', 'Bea'][i % 3] + ' ' + i, initials: 'P' + (i % 9), sel: i ? null : 'sr1' }));
    S.files = [{ hex: 'aa', label: 'Shot 02 · take 1', bytes: 31.5e6, song: false, state: 'skipped', skip: 'video', got: 0, who: ['Julia'] }, { hex: 'bb', label: 'Shot 01 · start frame', bytes: 1.2e6, song: false, state: 'here', skip: '', got: 1.2e6, who: [] }]; S.ping(); });
  await p2.waitForTimeout(300);
  check(dev, 'many collaborators: no bubbles and no files indicator in the phone bar, flag and gear shown, no overflow', await p2.evaluate(() => !document.getElementById('presence').getClientRects().length && !document.getElementById('mstat').getClientRects().length
    && ['reportb', 'settingsb'].every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width && r.right <= innerWidth; })) && (await overflow(p2)) <= 0);
  check(dev, 'Wi-Fi only is on by default on a phone, video held back', await p2.evaluate(() => window.__STUB.app.mediaLimits(window.__STUB.pid).video === false));
  check(dev, 'the indicator says the video waits for Wi-Fi', /Wi-Fi/.test(await p2.getAttribute('#mstat', 'aria-label')));
  // the indicator's dot (hollow: a file missing here) moves to the project name, from the same state
  const att = await p2.evaluate(() => { const k = document.getElementById('mstat').dataset.k, p = document.getElementById('proj'), a = getComputedStyle(p, '::after');
    return { k, att: p.dataset.att || '', shown: a.content !== 'none' && parseFloat(a.width) > 0 }; });
  check(dev, 'the title carries the indicator\'s dot when it would show one', /^(off|err)$/.test(att.k) ? att.att === att.k && att.shown : !att.att, JSON.stringify(att));
  await p2.screenshot({ path: join(out, `${dev}-room.png`) });
  await p2.tap('#proj'); await p2.waitForTimeout(300);
  check(dev, 'Project sheet lists who is here and the sync state', await p2.evaluate(() => document.querySelectorAll('#mPeople li').length === 13 && /Synced|Wi-Fi/.test(document.getElementById('mStateT').textContent)));
  check(dev, 'the Files row says the indicator\'s words and has its dot', await p2.evaluate(() => { const f = document.getElementById('mFiles'), k = document.getElementById('mstat').dataset.k;
    return /Wi-Fi/.test(document.getElementById('mFilesV').textContent) && (f.dataset.att || '') === (/^(off|err)$/.test(k) ? k : '') && (!f.dataset.att || getComputedStyle(document.getElementById('mFilesV'), '::before').content !== 'none'); }));
  check(dev, 'the sheet has no Settings or Report rows (they are in the bar); Copy shot list stays', await p2.evaluate(() => !document.getElementById('mSettings') && !document.getElementById('mReport') && !!document.getElementById('mCopy')));
  await p2.screenshot({ path: join(out, `${dev}-project-room.png`), fullPage: false });
  // the room drops while the sheet is open
  await p2.evaluate(() => { window.__STUB.status = 'offline'; window.__STUB.ping(); }); await p2.waitForTimeout(200);
  check(dev, 'room goes offline with the sheet open: the sheet says so', /Offline/.test(await p2.textContent('#mStateT')) && await p2.evaluate(() => document.getElementById('mProj').open));
  await p2.evaluate(() => { window.__STUB.status = 'synced'; window.__STUB.ping(); });
  await p2.tap('#mFiles'); await p2.waitForTimeout(300);
  check(dev, 'Files and downloads opens the files sheet', await p2.evaluate(() => !document.getElementById('mpanel').hidden && document.getElementById('fWifi').checked));
  await p2.screenshot({ path: join(out, `${dev}-files.png`) });
  await p2.tap('#fList [data-mact="download"]'); await p2.waitForTimeout(300);
  const ask = await p2.evaluate(() => ({ open: document.getElementById('dlgSize').open, text: document.getElementById('szText').textContent }));
  check(dev, 'Download on a take asks first, with its size', ask.open && /31\.5 MB/.test(ask.text), ask.text);
  await p2.screenshot({ path: join(out, `${dev}-size.png`) });
  await p2.tap('#dlgSize button[value=""]'); await p2.waitForTimeout(200);
  check(dev, 'Cancel downloads nothing, the files sheet stays open behind the dialog', (await p2.evaluate(() => window.__STUB.dl.length)) === 0 && !(await filesHidden(p2)));
  await openFiles(p2); await p2.tap('#fList [data-mact="download"]'); await p2.waitForTimeout(200); await p2.tap('#szGo'); await p2.waitForTimeout(200);
  check(dev, 'confirming downloads that take', (await p2.evaluate(() => window.__STUB.dl.join())) === 'aa');
  await openFiles(p2);
  check(dev, '"Download everything now" is there', (await p2.textContent('#fAll')) === 'Download everything now');
  await p2.tap('#fAll'); await p2.waitForTimeout(200); await p2.tap('#szGo'); await p2.waitForTimeout(200);
  const listed = await p2.evaluate(() => ({ all: window.__STUB.all, only: window.__STUB.allList, want: window.__STUB.files.filter(f => f.state !== 'here').map(f => f.hex) }));
  check(dev, 'Download everything now asks, then downloads exactly the files it listed (a one-off)', listed.all === 1 && Array.isArray(listed.only) && listed.only.join() === listed.want.join() && listed.want.length > 0, JSON.stringify(listed));
  check(dev, 'after confirming "Download everything now" the files sheet stays open and shows progress', await p2.evaluate(() => !document.getElementById('mpanel').hidden && !!document.querySelector('#fList li')));
  // a collaborator adds a take afterwards: still held for Wi-Fi, not downloaded
  await p2.evaluate(() => { const S = window.__STUB; S.files.push({ hex: 'cc', label: 'Shot 01 · take 2', bytes: 12e6, song: false, state: 'skipped', skip: 'video', got: 0, who: ['Julia'] }); S.ping(); });
  await p2.waitForTimeout(300); await openFiles(p2);
  const late = await p2.evaluate(() => ({ st: window.__STUB.files.find(f => f.hex === 'cc').state, dl: window.__STUB.dl.includes('cc'), row: [...document.querySelectorAll('#fList li')].map(l => l.textContent).find(t => /take 2/.test(t)) || '' }));
  check(dev, 'a take added after "Download everything now" is not downloaded and shows as waiting for Wi-Fi', late.st === 'skipped' && !late.dl && /Waits for Wi-Fi/.test(late.row), JSON.stringify(late));
  // a held clip in the monitor's slate: its Download asks for the size and doesn't play or pause (the monitor's tap does)
  await p2.evaluate(() => { const S = window.__STUB, p = JSON.parse(JSON.stringify(window.__CUE_MEDIA_TEST.app.cur()));
    S.files.push({ hex: 'dd', label: 'Shot 01 · clip', bytes: 8e6, song: false, state: 'skipped', skip: 'video', got: 0, who: ['Julia'] });
    p.sections[0].img = 'sha256-dd'; p.sections[0].kind = 'video'; S.app.applyRemote(S.pid, p); S.ping(); });
  if (!(await filesHidden(p2))) await p2.tap('#fClose');
  await p2.evaluate(() => { document.getElementById('toast').hidden = true; }); await p2.waitForTimeout(400);
  const slateBtn = await p2.$('#slate [data-mact="download"]');
  if (slateBtn) { await slateBtn.tap(); await p2.waitForTimeout(300); }
  const sl = await p2.evaluate(() => ({ dlg: document.getElementById('dlgSize').open, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent }));
  check(dev, 'Download on a held clip in the slate: #dlgSize opens, nothing plays or pauses', !!slateBtn && sl.dlg && !/song|playback/i.test(sl.toast), JSON.stringify({ btn: !!slateBtn, ...sl }));
  if (sl.dlg) { await p2.tap('#dlgSize button[value=""]'); await p2.waitForTimeout(200); }
  await p2.tap('#slate .t'); await p2.waitForTimeout(200);
  check(dev, 'a tap elsewhere on the monitor still plays (here: asks for the song)', await p2.isVisible('#toast') && /Load the song/.test(await p2.textContent('#toast')));
  await openFiles(p2);
  await p2.tap('#fWifi'); await p2.waitForTimeout(100);
  check(dev, 'turning Wi-Fi only off lets video download', await p2.evaluate(() => window.__STUB.app.mediaLimits(window.__STUB.pid).video === undefined && window.__STUB.refreshes > 0));
  // long project name
  await p2.evaluate(() => { const a = window.__CUE_MEDIA_TEST.app; a.cur().title = 'A very long project name that goes on far past what a phone bar can hold'; a.renderAll(); });
  check(dev, 'a long project name truncates in the bar', (await overflow(p2)) <= 0 && await p2.evaluate(() => { const e = document.getElementById('projname'); return e.scrollWidth > e.clientWidth; }));
  check(dev, 'a long project name leaves the flag and gear on screen, clear of the title', await p2.evaluate(() => { const t = document.getElementById('proj').getBoundingClientRect(), f = document.getElementById('reportb').getBoundingClientRect(), g = document.getElementById('settingsb').getBoundingClientRect();
    return t.right <= f.left && f.right <= g.left && g.right <= innerWidth; }));
  await p2.screenshot({ path: join(out, `${dev}-long-name.png`) });
  await p2.close();

  // gestures the browser must not take: double-tap zoom, pull-to-refresh, bounce
  const ta = await page.evaluate(() => ({ body: getComputedStyle(document.body).touchAction, ob: getComputedStyle(document.documentElement).overscrollBehaviorY, ov: getComputedStyle(document.body).overflow, tl: getComputedStyle(document.getElementById('tl-scroll')).overscrollBehaviorX }));
  check(dev, 'no double-tap zoom, no pull-to-refresh or bounce on the shell, timeline overscroll contained', ta.body === 'manipulation' && ta.ob === 'none' && ta.ov === 'hidden' && ta.tl === 'contain', JSON.stringify(ta));
  // a save error (#status is hidden on the phone): a toast with the full text, a notice in the Projects sheet while it
  // lasts, then "Saved again" and no notice once saving works
  const se = await page.evaluate(async () => {
    const A = window.__CUE_MEDIA_TEST.app, store = A.store(), { scheduleSave, flushNow, setStatus } = A;
    const set0 = store.set, toast = () => { const t = document.getElementById('toast'); return t.hidden ? '' : t.textContent; }, note = () => { const n = document.getElementById('mSaveErr'); return n.hidden ? '' : n.textContent; };
    const kinds = {};
    for (const [code, want] of [['quota_exceeded', 'Out of storage space'], ['', "Couldn't save"]]) {
      store.set = () => Promise.reject(Object.assign(new Error('x'), { code })); scheduleSave(); flushNow();
      await new Promise(r => setTimeout(r, 200)); kinds[want] = { toast: toast(), note: note() };
    }
    store.set = set0; scheduleSave(); flushNow(); await new Promise(r => setTimeout(r, 200));
    const after = { toast: toast(), note: note() };
    setStatus('err', 'Browser storage unavailable'); const un = { toast: toast(), note: note() }; setStatus('ok', 'Saved locally');
    return { kinds, after, un };
  });
  check(dev, 'save error on the phone: toast and Projects-sheet notice with the full text, both kinds', Object.entries(se.kinds).every(([w, v]) => v.toast.startsWith(w) && /only in this tab/.test(v.toast) && v.note === v.toast), JSON.stringify(se.kinds));
  check(dev, 'storage unavailable: toast and notice say nothing will be saved', /^Browser storage unavailable\. .*nothing will be saved/.test(se.un.toast) && se.un.note === se.un.toast, JSON.stringify(se.un));
  check(dev, 'saving works again: "Saved again" toast, the notice is gone', se.after.toast === 'Saved again' && !se.after.note, JSON.stringify(se.after));
  // widths 360/390/430
  for (const w of [360, 390, 430]) {
    await page.setViewportSize({ width: w, height: 780 }); await page.waitForTimeout(250);
    const o = await overflow(page);
    check(dev, `no horizontal overflow at ${w}px`, o <= 0, String(o));
    if (w === 360) await shot('cut-360');
  }
  // rotate: landscape still works (no special design)
  await page.setViewportSize({ width: opts.screen.height - 90, height: opts.screen.width - 48 }); await page.waitForTimeout(400);
  check(dev, 'rotated: no overflow, Play reachable', (await overflow(page)) <= 0 && await page.evaluate(() => { const r = document.getElementById('play').getBoundingClientRect(); return r.width > 0 && r.top >= 0; }));
  await shot('landscape');
  await page.setViewportSize(opts.viewport); await page.waitForTimeout(300);
  // manifest and icons
  const man = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const j = await (await fetch(l.href)).json();
    const icons = await Promise.all(j.icons.map(async i => { const b = await (await fetch(new URL(i.src, l.href))).blob(); const im = await createImageBitmap(b); return [i.sizes, im.width + 'x' + im.height, b.type, i.purpose || 'any']; }));
    return { name: j.name, display: j.display, theme: j.theme_color, start: j.start_url, icons, apple: !!document.querySelector('link[rel=apple-touch-icon]') }; });
  const cdp = await ctx.newCDPSession(page), am = await cdp.send('Page.getAppManifest');
  const iconSet = man.icons.map(([s, , , p]) => p + ' ' + s).sort().join();
  check(dev, 'install manifest valid: standalone, theme from tokens, separate "any" and "maskable" icons at 192 and 512, iOS meta', man.display === 'standalone' && man.theme === '#191817' && iconSet === 'any 192x192,any 512x512,maskable 192x192,maskable 512x512' && man.icons.every(([s, d, t]) => s === d && t === 'image/png') && man.apple && !(am.errors || []).length, JSON.stringify(man) + ' ' + JSON.stringify(am.errors));
  check(dev, 'no console errors', !errs.length, errs.join(' | '));
  check(dev, 'nothing left 127.0.0.1 except the blocked OpenRouter catalog', blocked.every(u => /openrouter\.ai|Failed to load resource/.test(u)), blocked.slice(0, 3).join(' '));
  await ctx.close();
}
// a touch device that boots below 820px (an iPad in portrait, a narrowed touch laptop) gets Wi-Fi only by default;
// widened past 820px the switch is gone, so nothing may stay held and the chip doesn't mention Wi-Fi
{
  const dev = 'tablet';
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1000 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
  const p = await ctx.newPage(), errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto(origin + '/index.html#join=roomroomroomroom1234.tokentokentokentoken5678');
  await p.waitForSelector('#dlgJoin[open] #jName', { timeout: 10000 });
  await p.fill('#jName', 'Ana'); await p.tap('#jGo');
  await p.waitForSelector('#dlgJoin[open] #jNew:visible', { timeout: 5000 }).then(() => p.tap('#jNew')).catch(() => {});
  await p.waitForFunction(() => /Night drive/.test(document.getElementById('projname').textContent), null, { timeout: 10000 });
  await p.waitForTimeout(300);
  await p.evaluate(() => { const S = window.__STUB; S.files = [{ hex: 'aa', label: 'Shot 02 · take 1', bytes: 31.5e6, song: false, state: 'skipped', skip: 'video', got: 0, who: ['Julia'] }]; S.ping(); });
  await p.waitForTimeout(300);
  const coarse = await p.evaluate(() => matchMedia('(pointer:coarse)').matches);
  const held = await p.evaluate(() => window.__STUB.app.mediaLimits(window.__STUB.pid).video === false);
  check(dev, 'boots at 768px with a coarse pointer: Wi-Fi only on, video held, the chip says so', coarse && held && /Wi-Fi/.test(await p.getAttribute('#mstat', 'aria-label')));
  // held videos and a file over the size limit: the chip counts the two reasons apart
  await p.evaluate(() => { const S = window.__STUB, v = (hex, label) => ({ hex, label, bytes: 31.5e6, song: false, state: 'skipped', skip: 'video', got: 0, who: ['Julia'] });
    S.files = [v('aa', 'Shot 02 · take 1'), v('ab', 'Shot 03 · take 1'), { hex: 'ac', label: 'Song', bytes: 900e6, song: true, state: 'skipped', skip: 'file', got: 0, who: ['Julia'] }]; S.ping(); });
  await p.waitForTimeout(300);
  const mix = await p.getAttribute('#mstat', 'aria-label') || '';
  check(dev, 'mixed skips: "2 videos wait for Wi-Fi" and "1 file skipped: over the size limit", counted apart', /2 videos wait for Wi-Fi/.test(mix) && /1 file skipped: over the size limit/.test(mix) && !/3 files/.test(mix), mix);
  await p.evaluate(() => { const S = window.__STUB; S.files = S.files.slice(0, 1); S.ping(); }); await p.waitForTimeout(300);
  const r0 = await p.evaluate(() => window.__STUB.refreshes);
  await p.setViewportSize({ width: 1024, height: 768 }); await p.waitForTimeout(400);
  const wide = await p.evaluate(() => ({ video: window.__STUB.app.mediaLimits(window.__STUB.pid).video, refreshes: window.__STUB.refreshes, wifi: document.getElementById('fWifi').getClientRects().length }));
  const label = await p.getAttribute('#mstat', 'aria-label') || '';
  check(dev, 'widened past 820px: video no longer held, media refreshed, the chip says nothing of Wi-Fi', wide.video !== false && wide.refreshes > r0 && !/Wi-Fi/.test(label), JSON.stringify(wide) + ' · ' + label);
  await p.setViewportSize({ width: 768, height: 1000 }); await p.waitForTimeout(400);
  check(dev, 'narrowed again: held again (the setting is kept)', await p.evaluate(() => window.__STUB.app.mediaLimits(window.__STUB.pid).video === false));
  check(dev, 'no console errors', !errs.length, errs.join(' | '));
  await ctx.close();
}
// fractional widths (zoom, a fractional DPR) can be 819.5px: every phone/desktop switch must be (min-width:820px) or
// its exact complement, so no width is both halves (phone() false with the .m-only tab bar showing) or neither.
// Headless Chromium rounds an iframe's width to whole CSS px, so the source is checked, and 819/820 in a frame
{
  const dev = 'fractional';
  const src = readFileSync(join(root, 'index.html'), 'utf8');
  const qs = [...src.matchAll(/(?:@media|matchMedia\()\s*["']?([^{"']*?(?:min|max)-width[^{"']*)/g)].map(m => m[1].trim());
  const odd = qs.filter(q => /\b8[12]\d(?:\.\d+)?px/.test(q) && q !== '(min-width:820px)' && q !== 'not all and (min-width:820px)');
  check(dev, 'the 820px switch is (min-width:820px) or "not all and" it everywhere, in the CSS and in JS', !odd.length && qs.filter(q => /820px/.test(q)).length >= 6, JSON.stringify(odd));
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  await p.goto(origin + '/manifest.webmanifest');
  for (const w of [819, 820]) {
    await p.setContent(`<iframe id="f" src="${origin}/index.html" style="border:0;width:${w}px;height:800px"></iframe>`);
    const f = await (await p.$('#f')).contentFrame();
    await f.waitForSelector('#projname', { timeout: 10000 }); await p.waitForTimeout(300);
    const st = await f.evaluate(() => ({ w: document.documentElement.getBoundingClientRect().width, phone: matchMedia('not all and (min-width:820px)').matches, desk: matchMedia('(min-width:820px)').matches, oldQuery: matchMedia('(max-width:819px)').matches, tabs: !!document.getElementById('mTabs').getClientRects().length, strip: !!document.getElementById('strip').getClientRects().length }));
    const ok = st.phone !== st.desk && st.tabs === st.phone && st.strip === st.desk && st.phone === (w < 820);
    check(dev, `${w}px wide: exactly one layout (${w < 820 ? 'phone' : 'desktop'})`, ok, JSON.stringify(st));
  }
  await ctx.close();
}
await browser.close(); srv.close();
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
