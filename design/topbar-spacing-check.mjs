// The app bar's horizontal rhythm: every gap between neighbours, measured (getBoundingClientRect) against the steps
// it is meant to have, 1920 to 820; nothing moves sideways when the saved state's words or an armed Leave change.
//   node design/topbar-spacing-check.mjs <repo-root> <out-dir> [prefix]
// Prints the gaps per width and state, saves the bar at 1440x900 and 1920x1080 as <prefix>-*.png.
// Same harness as design/topbar-check.mjs: /collab.js is a stub, index.html gets a sync URL nothing listens on.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out, prefix = 'after'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [] };
  const media = { files: () => [], summary: () => ({ total: 0, here: 0, active: 0, unavailable: 0, skipped: 0, failed: 0, relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0 }),
    progress: () => null, pause() {}, refresh() {}, downloadAll() {}, download() {}, retry() {} };
  S.ping = () => { if (S.pid) { app.onStatus(S.pid, S.status); app.onPeers(S.pid, S.peers); } };
  return {
    open(pid) { S.pid = pid; setTimeout(S.ping, 30);
      return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {}, probe: async () => ({ ok: false }), seed: async () => {},
  };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/collab.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(STUB); return; }
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', '<meta name="cue-sync-url" content="ws://127.0.0.1:9">');
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route('**/*', r => (r.request().url().startsWith(origin) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));

// The intended gaps, by kind of neighbour. A ghost button's 8px padding counts as space, so these box gaps all give
// the same 32px of empty bar between groups (logo|project, project|operations, operations|song, room|saved|Settings),
// 16px inside the room group (Join/Leave, bubbles, sync), 20px along a row of ghost buttons, and the bar ends on
// Settings' ink at the gutter. Bubbles overlap by 4. Gaps to and from Side A/B are the bar's free space (at least 32, 16 below 1280).
const GUTTER = w => (w > 1180 ? 20 : 16);
const EXPECT = { 'logo→picker': 32, 'picker→pencil': 4, 'pencil→op': 16, 'op→op': 4, 'op→song': 24,
  'room→bubble': 8, 'bubble→bubble': -4, 'bubble→sync': 8, 'room→saved': 24, 'sync→saved': 24, 'saved→settings': 24 };
const KIND = { new: 'op', import: 'op', export: 'op', more: 'op', join: 'room', leave: 'room', you: 'bubble' };
const kind = n => KIND[n] || (/^p\d/.test(n) ? 'bubble' : n);

// the bar's visible items, left to right, and the gap from each to the next (from the bar's edge for the ends)
const measure = () => page.evaluate(() => {
  const vis = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const t = document.querySelector('.top').getBoundingClientRect();
  const items = [];
  const add = (name, e) => { if (vis(e)) { const r = e.getBoundingClientRect(); items.push({ name, l: r.left, r: r.right }); } };
  add('logo', document.querySelector('.brand'));
  add('picker', document.querySelector('.projpick'));
  add('pencil', document.getElementById('renamep'));
  for (const id of ['newp', 'importb', 'exportb', 'moreb']) add(id.replace(/b$|p$/, ''), document.getElementById(id));
  add('song', document.getElementById('songlbl'));
  add('sides', document.querySelector('.sides'));
  add('join', document.getElementById('joinb')); add('leave', document.getElementById('leaveb'));
  document.querySelectorAll('#presence .pchip').forEach((c, i) => add(c.classList.contains('self') ? 'you' : 'p' + i, c));
  add('sync', document.getElementById('mstat'));
  add('saved', document.getElementById('status'));
  add('settings', document.getElementById('settingsb'));
  const gaps = [{ a: '|', b: items[0].name, v: items[0].l - t.left }];
  for (let i = 1; i < items.length; i++) gaps.push({ a: items[i - 1].name, b: items[i].name, v: items[i].l - items[i - 1].r });
  gaps.push({ a: items[items.length - 1].name, b: '|', v: t.right - items[items.length - 1].r });
  // where the words sit vertically: each text's own box against the bar's middle
  const mid = t.top + (t.height - 1) / 2, words = {};
  for (const [n, sel] of [['logo', '.brand .lbl'], ['picker', '#projname'], ['side', '.sidetab'], ['join', '#joinb .lbl'], ['leave', '#leaveb .lbl'], ['saved', '#status .lbl'], ['settings', '#settingsb .lbl']]) {
    const e = document.querySelector(sel); if (!vis(e) || e.getBoundingClientRect().width < 2) continue;
    const g = document.createRange(); g.selectNodeContents(e.firstChild?.nodeType === 3 ? e.firstChild : e); const r = g.getBoundingClientRect(); words[n] = Math.round((r.top + r.height / 2 - mid) * 10) / 10; }
  const s = document.querySelector('.sides').getBoundingClientRect();
  return { gaps: gaps.map(g => ({ ...g, v: Math.round(g.v * 10) / 10 })), items: items.map(i => [i.name, Math.round(i.l)]), words,
    off: (s.left + s.width / 2) - (t.left + t.width / 2), h: Math.round(t.height), scroll: document.documentElement.scrollWidth - innerWidth };
});
// every gap against its intended value (1px tolerance); an unknown pair is a failure too, so nothing drifts by accident
const wrong = (m, w) => m.gaps.filter(g => {
  if (g.a === '|') return Math.abs(g.v - GUTTER(w)) > 1;
  if (g.b === '|') return Math.abs(g.v - (GUTTER(w) - 8)) > 1;
  if (g.a === 'sides' || g.b === 'sides') return g.v < (w >= 1280 ? 32 : 16) - 1;
  const want = EXPECT[`${kind(g.a)}→${kind(g.b)}`];
  return want === undefined || Math.abs(g.v - want) > 1;
}).map(g => `${g.a}→${g.b} ${g.v}`);
const table = (label, m) => console.log(`  ${label.padEnd(24)} ${m.gaps.map(g => `${g.a}→${g.b} ${g.v}`).join(' · ')}`);
const bar = async (name, extra = 0) => { await page.evaluate(() => scrollTo(0, 0)); await sleep(60); const b = await page.locator('.top').boundingBox();
  await page.screenshot({ path: `${out}/${prefix}-${name}.png`, clip: { x: 0, y: 0, width: page.viewportSize().width, height: Math.ceil(b.height) + extra } }); };
const rest = async () => { await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement?.blur()); await sleep(120); };
const at = async w => { await page.setViewportSize({ width: w, height: w === 1920 ? 1080 : 900 }); await sleep(200); await rest(); };
const db = fn => page.evaluate(fn);
const peers = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'Peer ' + i, initials: ['NP', 'AR', 'CP', 'DR', 'EM', 'FL', 'GH'][i], sel: '' }));
const setPeers = async n => { await page.evaluate(p => { window.__STUB.peers = p; window.__STUB.ping(); }, peers(n)); await sleep(250); };
const inRoom = async n => { await page.reload(); await page.waitForSelector('.card'); await page.waitForFunction(() => window.__STUB && window.__STUB.pid); await sleep(300); await setPeers(n); };
const WIDTHS = [1920, 1440, 1280, 1024, 820];
const bad = [], centre = [], words = [];
// measure the bar in one state at every width; screenshots at 1440 and 1920
const pass = async (state, shots = true) => {
  console.log(`gaps (px), ${state}:`);
  for (const w of WIDTHS) {
    await at(w); const m = await measure(); table(String(w), m);
    const x = wrong(m, w); if (x.length) bad.push(`${state} ${w}: ${x.join(', ')}`);
    if (m.h !== 49 || m.scroll > 0) bad.push(`${state} ${w}: height ${m.h}, overflow ${m.scroll}`);
    // the switch only leaves the centre when a zone is full: its gap to the switch is then the bar's 32px floor
    const full = m.gaps.find(g => (m.off > 0 ? g.b : g.a) === 'sides');
    if ((w === 1440 || w === 1920) && Math.abs(m.off) > 2 && Math.abs(full.v - 32) > 1) centre.push(`${state} ${w}: ${m.off.toFixed(1)}`);
    if (Math.abs(m.off) > 2) console.log(`    (${w}: side switch ${m.off.toFixed(1)}px off centre: a full zone, ${full.a}→${full.b} ${full.v})`);
    const off = Object.entries(m.words).filter(([, v]) => Math.abs(v) > 1); if (off.length) words.push(`${state} ${w}: ${JSON.stringify(m.words)}`);
    if (shots && (w === 1440 || w === 1920)) await bar(`${state}-${w}`);
  }
};

try {
  await page.goto(origin + '/index.html'); await page.waitForSelector('.card', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready); await sleep(800);

  await pass('local');
  await db(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    await new Promise(r => { const q = d.transaction('settings', 'readwrite').objectStore('settings').put({ name: 'Rami', rooms: { 'p-example': { roomId: 'r'.repeat(22), token: 't'.repeat(22), name: 'Rami' } } }, 'collab'); q.onsuccess = r; }); });
  await inRoom(1);
  await pass('room');

  // ---------- what changes words: nothing else in the bar moves sideways ----------
  const xs = m => Object.fromEntries(m.items);
  const moved = (a, b, keep) => keep.filter(n => a[n] !== undefined && a[n] !== b[n]).map(n => `${n} ${a[n]}→${b[n]}`);
  const shifts = [];
  for (const w of WIDTHS) {
    await at(w); const base = xs(await measure());
    for (const [k, t] of [['busy', 'Saving…'], ['busy', 'Syncing…'], ['local', 'Saved locally'], ['err', "Couldn't save"], ['err', 'Out of storage space'], ['ok', 'Saved']]) {
      await page.evaluate(([k, t]) => { const s = document.getElementById('status'); s.dataset.k = k; s.querySelector('.lbl').textContent = t; }, [k, t]); await sleep(60);
      const m = await measure(); shifts.push(...moved(base, xs(m), ['logo', 'sides', 'leave', 'you', 'p0', 'sync', 'saved', 'settings']).map(x => `${w} saved "${t}": ${x}`));
      if (w === 1440 && t === "Couldn't save") await bar('room-saved-error-1440');
    }
    await page.click('#leaveb'); await sleep(120); await page.mouse.move(700, 600);
    const ma = await measure(); shifts.push(...moved(base, xs(ma), ['logo', 'sides', 'you', 'p0', 'sync', 'saved', 'settings']).map(x => `${w} armed Leave: ${x}`));
    const x = wrong(ma, w); if (x.length) shifts.push(`${w} armed Leave: ${x.join(', ')}`);
    const said = await page.evaluate(() => { const l = document.querySelector('#leaveb .lbl'), r = l.getBoundingClientRect(), t = document.querySelector('.top').getBoundingClientRect();
      return { t: l.textContent, inBar: r.bottom <= t.bottom, under: r.top >= t.bottom - 8, w: r.width }; });
    if (said.t !== 'Tap again to leave' || said.w < 40 || (w >= 1440 ? !said.inBar : !said.under)) shifts.push(`${w} armed Leave's words: ${JSON.stringify(said)}`);
    if (w === 1440 || w === 1920 || w === 1280) await bar(`room-leave-armed-${w}`, 40);
    await inRoom(1);
  }
  check('the saved state\'s words (Saving…, Saved locally, errors) and an armed Leave move nothing else, 1920 to 820; an armed Leave says so in the bar (1440+) or right under its icon', !shifts.length, shifts.slice(0, 6).join(' | '));

  // ---------- a long name, many collaborators ----------
  await setPeers(7);
  await page.click('#renamep'); await page.keyboard.press('Control+a'); await page.keyboard.type('The Mountain King (example) — the extended director’s cut, final final v3'); await page.keyboard.press('Enter'); await sleep(300);
  await pass('crowd');

  // ---------- a project with no song yet: Load song after the operations ----------
  await at(1440); await page.click('#newp'); await sleep(400); await page.keyboard.type('Spacing'); await page.keyboard.press('Enter'); await sleep(400);
  await pass('nosong');

  check('every gap is its intended step (±1px): logo 32 picker 4 pencil 16 ops 4 … 24 song; room 8, bubbles −4, 8 sync, 24 saved 24 Settings; edges gutter / gutter−8 (1920 to 820, local, room, crowd, no song)', !bad.length, bad.slice(0, 4).join(' | '));
  check('Side A/B on the bar\'s centre at 1440 and 1920 (±2px) unless a zone is full and holds it at 32px',!centre.length, centre.join(' | '));
  check('the words in the bar (logo, project, sides, Join/Leave, saved, Settings) sit on its middle (±1px)', !words.length, words.slice(0, 3).join(' | '));
} catch (e) { check('run completed', false, e.stack.split('\n').slice(0, 3).join(' ')); }
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close(); srv.close();
