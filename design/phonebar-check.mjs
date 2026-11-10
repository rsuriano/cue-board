// The phone's top bar (below 820px): the project name on the left, then Report a problem (flag) and Settings (gear),
// icon only. The files indicator (#mstatw) and the bubbles (#presence) are not in it: they live in the Projects sheet
// (Files and downloads, Collaboration). From 820px up the desktop bar is unchanged.
//   node design/phonebar-check.mjs <repo-root> <out-dir>
// Same harness as design/mobile-check.mjs: /collab.js is a stub whose status, peers and files the script sets, and
// index.html gets a sync URL nothing listens on, so a #join= link puts the page in a room (bubbles and indicator shown
// on desktop). Every request outside the local server is aborted. Screenshots go to <out-dir>/phonebar-<width>.png.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [], files: [] };
  const summary = () => { const n = s => S.files.filter(f => f.state === s).length;
    return { total: S.files.length, here: n('here'), active: n('downloading') + n('queued'), unavailable: n('unavailable'), skipped: n('skipped'), failed: n('failed'), relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0 }; };
  const media = { files: () => S.files, summary, progress: () => null, pause() {}, refresh() { setTimeout(S.ping, 0); }, downloadAll() {}, download() {}, retry() {} };
  S.ping = () => { if (S.pid) { app.onStatus(S.pid, S.status); app.onPeers(S.pid, S.peers); app.onMedia(S.pid); } };
  return {
    open(pid) { S.pid = pid; setTimeout(S.ping, 30);
      return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {},
    probe: async () => ({ ok: true, empty: false, shots: 2, title: 'A project name long enough to need an ellipsis on a phone', update: null,
      project: { title: 'A project name long enough to need an ellipsis on a phone', song: null, sections: [0, 6].map((start, i) => ({ id: 'sr' + i, start, title: i ? 'Second' : 'First', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [] })) } }),
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
const check = (name, ok, ev = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
const page = await ctx.newPage(), errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(origin + '/index.html#join=roomroomroomroom1234.tokentokentokentoken5678');
await page.waitForSelector('#dlgJoin[open] #jName', { timeout: 10000 });
await page.fill('#jName', 'Rami Cue'); await page.tap('#jGo');
await page.waitForSelector('#dlgJoin[open] #jNew:visible', { timeout: 5000 }).then(() => page.tap('#jNew')).catch(() => {});
await page.waitForFunction(() => /long enough/.test(document.getElementById('projname').textContent), null, { timeout: 10000 });
// someone else here, and a file nobody online has: the indicator shows its dot, the bubbles show "RC" and "NP"
await page.evaluate(() => { const S = window.__STUB; S.peers = [{ id: 2, name: 'Nacho Pérez', initials: 'NP', sel: null }];
  S.files = [{ hex: 'aa', label: 'Shot 01 · take 1', bytes: 3e6, song: false, state: 'unavailable', skip: '', got: 0, who: [] }]; S.ping(); });
await sleep(400);

// geometry of the bar's pieces; "shown" = has a box (display:contents and display:none have none)
const bar = () => page.evaluate(() => {
  const box = id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { shown: !!e.getClientRects().length && r.width > 0 && getComputedStyle(e).visibility !== 'hidden', l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  return { vw: innerWidth, doc: document.documentElement.scrollWidth, proj: box('proj'), report: box('reportb'), settings: box('settingsb'), presence: box('presence'), mstat: box('mstat'), mstatw: box('mstatw'),
    att: document.getElementById('proj').dataset.att || '', k: document.getElementById('mstat').dataset.k || '', name: (() => { const e = document.getElementById('projname'); return e.scrollWidth > e.clientWidth; })() };
});
const apart = (a, b) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;

for (const w of [320, 360, 390, 430]) {
  await page.setViewportSize({ width: w, height: 800 }); await sleep(250);
  const g = await bar();
  check(`${w}px: flag and gear shown, inside the viewport`, g.report.shown && g.settings.shown && g.report.l >= 0 && g.settings.r <= g.vw, JSON.stringify({ report: g.report, settings: g.settings }));
  check(`${w}px: flag and gear are the bar's hit size (at least 44px on the phone)`, Math.min(g.report.w, g.report.h, g.settings.w, g.settings.h) >= 44, `${g.report.w}x${g.report.h}, ${g.settings.w}x${g.settings.h}`);
  check(`${w}px: neither overlaps the title selector; the title comes first`, apart(g.proj, g.report) && apart(g.proj, g.settings) && g.proj.r <= g.report.l && g.report.r <= g.settings.l);
  check(`${w}px: the long name ellipsizes, nothing overflows`, g.name && g.doc <= g.vw, `scrollWidth ${g.doc}`);
  check(`${w}px: no bubbles and no files indicator in the bar`, !g.presence.shown && !g.mstat.shown && !g.mstatw.shown);
  check(`${w}px: the indicator's dot is on the title`, /^(off|err)$/.test(g.k) && g.att === g.k, `k=${g.k} att=${g.att}`);
  await page.screenshot({ path: join(out, `phonebar-${w}.png`), clip: { x: 0, y: 0, width: w, height: 64 } });
}

// the gear opens Settings, the flag opens the report dialog (phone)
await page.setViewportSize({ width: 390, height: 844 }); await sleep(250);
await page.tap('#settingsb'); await sleep(400);
check('phone: tapping the gear opens Settings', await page.evaluate(() => document.getElementById('dlgSettings').open));
await page.keyboard.press('Escape'); await sleep(300);
await page.tap('#reportb'); await sleep(400);
check('phone: tapping the flag opens the report dialog', await page.evaluate(() => document.getElementById('dlgReport').open));
await page.keyboard.press('Escape'); await sleep(300);
// the title still opens the Projects sheet: people, the Files row with its words and dot, no Settings/Report rows
await page.tap('#proj'); await sleep(400);
const sh = await page.evaluate(() => ({ open: document.getElementById('mProj').open, people: document.querySelectorAll('#mPeople li').length, files: !!document.getElementById('mFiles').getClientRects().length,
  v: document.getElementById('mFilesV').textContent, att: document.getElementById('mFiles').dataset.att || '', settings: !!document.getElementById('mSettings'), report: !!document.getElementById('mReport'), copy: !!document.getElementById('mCopy') }));
check('phone: the title opens the Projects sheet, people listed, Files row with the indicator\'s words and dot', sh.open && sh.people === 2 && sh.files && sh.v.length > 0 && /^(off|err)$/.test(sh.att), JSON.stringify(sh));
check('phone: no Settings or Report rows in the sheet; Copy shot list stays', !sh.settings && !sh.report && sh.copy);
await page.tap('#mFiles'); await sleep(400);
check('phone: Files and downloads opens the files sheet', await page.evaluate(() => !document.getElementById('mpanel').hidden && !!document.getElementById('mpanel').getClientRects().length));
await page.screenshot({ path: join(out, 'phonebar-files.png') });

// desktop: the bar as before, bubbles, indicator, flag and gear all shown; the title carries no dot styling there
await page.keyboard.press('Escape'); await sleep(200);
await page.setViewportSize({ width: 1280, height: 900 }); await sleep(300);
const d = await bar();
check('1280px: bubbles, files indicator, flag and gear all shown', d.presence.shown && d.mstat.shown && d.report.shown && d.settings.shown, JSON.stringify({ presence: d.presence.shown, mstat: d.mstat.shown, report: d.report.shown, settings: d.settings.shown }));
check('1280px: no dot on the title (the indicator has its own)', await page.evaluate(() => getComputedStyle(document.getElementById('proj'), '::after').content === 'none'));
await page.mouse.click(d.settings.l + d.settings.w / 2, d.settings.t + d.settings.h / 2); await sleep(400);
check('1280px: the gear opens Settings', await page.evaluate(() => document.getElementById('dlgSettings').open));
await page.keyboard.press('Escape'); await sleep(300);
await page.screenshot({ path: join(out, 'phonebar-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 72 } });

check('no console errors', !errs.length, errs.join(' | '));
await browser.close(); srv.close();
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
