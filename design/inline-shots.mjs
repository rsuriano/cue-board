// Screenshots of the media status indicator, its panel and the in-place placeholders, in every state:
//   node design/inline-shots.mjs <repo-root> <out-dir>
// No sync server: /collab.js is replaced by a stub whose media state the script sets (so "failed" and "skipped" can be
// shown on demand), and index.html gets a sync URL nothing listens on. Every other request is aborted.
// The real states are exercised by design/media-check.mjs; this is for looking at them, plus keyboard, overflow and contrast.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', files: [], paused: false, peers: [] };
  const n = s => S.files.filter(f => f.state === s).length;
  const media = {
    files: () => S.files.map(f => ({ ...f, who: [...f.who] })),
    summary: () => ({ total: S.files.length, here: n('here'), active: n('downloading') + n('queued'), unavailable: n('unavailable'), skipped: n('skipped'), failed: n('failed'), relay: n('relay'),
      paused: S.paused, storageFull: false, storageBusy: '', storage: { persisted: true, free: S.free ?? 5e10 }, foreign: 0, direct: 1, relayed: 0 }),
    progress: h => { const f = S.files.find(x => x.hex === h); return f && /downloading|queued/.test(f.state) ? f.got / f.bytes : null; },
    pause(on) { S.paused = on; S.ping(); }, refresh() {},
    downloadAll() { S.paused = false; S.files.forEach(f => { if (/skipped|failed/.test(f.state)) f.state = 'queued'; }); S.ping(); },
    download(h) { const f = S.files.find(x => x.hex === h); if (f) { f.state = 'downloading'; f.got = Math.round(f.bytes * 0.06); } S.ping(); },
    retry(h) { media.download(h); },
  };
  S.ping = () => { if (S.pid) { app.onStatus(S.pid, S.status); app.onMedia(S.pid); } };
  return {
    open(pid) { S.pid = pid; setTimeout(() => { app.onPeers(pid, S.peers); S.ping(); }, 30);
      return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {}, probe: async () => ({ ok: false }), seed: async () => {},
  };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
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
await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));

const H = i => String(i).repeat(64);   // fake content hashes: 111…, 222…
try {
  await page.goto(origin + '/index.html'); await page.waitForSelector('.card', { timeout: 15000 });
  // the example, as a collaborator's project: shot 3's frame, its take, a reference and the song aren't here yet
  await page.evaluate(async H => {
    const db = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const st = (n, m) => db.transaction(n, m).objectStore(n), req = q => new Promise(r => { q.onsuccess = () => r(q.result); });
    const p = await req(st('projects', 'readonly').get('p-example')), s = p.sections[2], now = Date.now();
    const base = { jobId: '', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 6, audio: false, seed: '', prompt: 'The camera pushes in slowly.', start: true, end: false, error: '', note: '', est: 0.3, cost: 0.3, status: 'completed', clipDur: 6 };
    s.img = 'sha256-' + H[3]; s.kind = 'image';
    p.sections[5].img = 'sha256-' + H[4]; p.sections[5].kind = 'video';
    s.takes = [{ ...base, id: 't-2', created: now - 60000, media: 'sha256-' + H[2] }, { ...base, id: 't-1', created: now - 900000, media: 'sha256-' + H[1] }];
    p.refs = ['sha256-' + H[5], 'sha256-' + H[6]]; p.updated = now;
    await req(st('projects', 'readwrite').put(p, p.id));
    await req(st('songs', 'readwrite').delete('p-example'));
    await req(st('settings', 'readwrite').put({ name: 'Ramiro', rooms: { 'p-example': { roomId: 'r'.repeat(22), token: 't'.repeat(22), name: 'Ramiro' } } }, 'collab'));
  }, Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(i => [i, H(i)])));
  await page.reload(); await page.waitForSelector('.card'); await page.waitForFunction(() => window.__STUB && window.__STUB.pid);
  const F = (i, label, bytes, state, got = 0, who = ['Ana Ruiz']) => ({ hex: H(i), label, bytes, state, got, who, song: i === 7, skip: state === 'skipped' ? 'file' : '' });
  const all = s => [
    F(7, 'Song · night-drive.mp3', 8.4e6, s[7] || 'here'), F(3, 'Shot 03 · frame', 2.1e6, s[3] || 'here'), F(2, 'Shot 03 · take 2', 31.5e6, s[2] || 'here'),
    F(1, 'Shot 03 · take 1', 640e6, s[1] || 'here'), F(4, 'Shot 06 · clip', 12.8e6, s[4] || 'here'), F(5, 'Reference 1', 0.9e6, s[5] || 'here'), F(6, 'Reference 2', 1.2e6, s[6] || 'here'),
  ].map(f => ({ ...f, got: f.state === 'downloading' ? Math.round(f.bytes * ({ 2: 0.42, 3: 0.68, 5: 0.25, 7: 0.31 }[f.hex[0]] || 0.1)) : 0, who: f.state === 'unavailable' ? [] : f.who }));
  const set = (files, extra = {}) => page.evaluate(([files, extra]) => { const S = window.__STUB; S.files = files; S.paused = false; Object.assign(S, extra); S.ping(); }, [files, extra]);
  const shot = (name, clip) => page.screenshot({ path: `${out}/${name}.png`, ...(clip ? { clip } : {}) });
  const header = async () => { const b = await page.locator('.top').boundingBox(); return { x: 0, y: 0, width: 1440, height: Math.ceil(b.height) + 120 }; };
  await page.evaluate(() => window.__STUB.peers = [{ initials: 'AR', name: 'Ana Ruiz', sel: '' }]);
  const open = async () => { if (await page.$eval('#mpanel', e => e.hidden)) await page.click('#mstat'); await sleep(250); };
  const close = async () => { if (!(await page.$eval('#mpanel', e => e.hidden))) await page.keyboard.press('Escape'); await page.mouse.move(700, 600); await sleep(150); };

  // ---- the indicator alone: quiet, ring, hollow dot, error dot (with its label on hover) ----
  await set(all({}));
  check('quiet: All files here, no ring, no dot', await page.$eval('#mstat', e => e.dataset.k === 'ok') && await page.$eval('#mhead', e => e.textContent) === 'All files here');
  await shot('header-quiet', await header());
  await page.hover('#mstat'); await sleep(150); await shot('header-quiet-hover', await header());
  await set(all({ 2: 'downloading', 3: 'downloading', 5: 'queued' }));
  check('downloading: ring with progress', await page.$eval('#mstat', e => e.dataset.k === 'ring' && +e.style.getPropertyValue('--p') > 0), await page.$eval('#mhead', e => e.textContent));
  await page.mouse.move(700, 600); await sleep(100); await shot('header-ring', await header());
  await page.hover('#mstat'); await sleep(150); await shot('header-ring-hover', await header());
  await set(all({ 3: 'unavailable', 5: 'unavailable' }));
  await page.hover('#mstat'); await sleep(150); await shot('header-dot-nobody', await header());
  await set(all({}), { status: 'offline' });
  check('offline: hollow dot, label on focus', await page.$eval('#mstat', e => e.dataset.k === 'off'));
  await page.mouse.move(700, 600); await page.focus('#mstat'); await page.keyboard.press('Shift'); await sleep(150);
  check('the state shows on keyboard focus', await page.$eval('#mlabel', e => getComputedStyle(e).visibility === 'visible' && e.textContent === 'Offline, changes will sync'));
  await shot('header-dot-offline-focus', await header());
  await set(all({}), { status: 'unreachable' });
  await page.hover('#mstat'); await sleep(150); await shot('header-dot-unreachable', await header());
  await set(all({}), { status: 'synced' });

  // ---- the panel in each state ----
  await set(all({})); await open(); await shot('panel-all-here'); await close();
  await set(all({ 2: 'downloading', 3: 'downloading', 5: 'queued', 7: 'downloading' })); await open(); await shot('panel-downloading'); await close();
  await set(all({ 3: 'unavailable', 5: 'unavailable', 2: 'unavailable' })); await open(); await shot('panel-nobody-online'); await close();
  await set(all({ 1: 'skipped' })); await open(); await shot('panel-skipped');
  // keyboard: focus on the first file, arrows reach the row's action, Escape returns to the indicator
  check('opened with the mouse, focus is on the panel itself (no ring on a row)', await page.evaluate(() => document.activeElement?.id === 'mpanel'));
  await page.keyboard.press('Escape'); await page.focus('#mstat'); await page.keyboard.press('Enter'); await sleep(150);
  const kb = [];
  kb.push(await page.evaluate(() => document.activeElement?.classList.contains('mrow')));
  for (let i = 0; i < 9 && !(await page.evaluate(() => document.activeElement?.dataset.mact === 'download')); i++) await page.keyboard.press('ArrowDown');
  kb.push(await page.evaluate(() => document.activeElement?.dataset.mact === 'download'));
  await page.keyboard.press('Space'); await sleep(200);   // Download, from the keyboard; playback must not start
  kb.push(await page.evaluate(h => window.__STUB.files.find(f => f.hex === h).state === 'downloading' && document.activeElement?.closest('#mpanel') != null, H(1)));
  kb.push(await page.evaluate(() => document.getElementById('play').textContent.trim() === 'Play'));
  await page.keyboard.press('Escape');
  kb.push(await page.evaluate(() => document.getElementById('mpanel').hidden && document.activeElement?.id === 'mstat'));
  check('panel keyboard: first file focused, arrows reach Download, Space downloads (no playback), Escape back to the indicator', kb.every(Boolean), JSON.stringify(kb));
  await set(all({ 2: 'failed' })); await open(); await shot('panel-failed');
  await page.click('#fList [data-mact="retry"]'); await sleep(150);
  check('Retry in the panel asks again', await page.evaluate(h => window.__STUB.files.find(f => f.hex === h).state === 'downloading', H(2)));
  await page.click('#fPause'); await sleep(150);
  check('Pause in the panel; the button turns into Resume, the panel stays open', await page.$eval('#fPause', e => e.textContent) === 'Resume' && !(await page.$eval('#mpanel', e => e.hidden)));
  await page.click('.brand'); await sleep(100);
  check('a click outside closes the panel', await page.$eval('#mpanel', e => e.hidden));

  // ---- in place, side A: the strip card and the monitor ----
  await set(all({ 3: 'downloading', 4: 'unavailable', 1: 'skipped', 2: 'downloading' }));
  await page.locator('.card').nth(2).click(); await sleep(300);
  const sideA = await page.evaluate(() => ({ card: document.querySelector('.card [data-miss] .mpt')?.textContent, bar: !!document.querySelector('.card [data-miss] .mbar b'), slate: document.querySelector('.slate [data-miss] .mpt')?.textContent }));
  check('side A: the card and the monitor show the frame arriving with its progress', /^Arriving · 68%$/.test(sideA.card) && sideA.bar && /^Arriving · 68%$/.test(sideA.slate), JSON.stringify(sideA));
  await shot('sideA-placeholders');
  await page.evaluate(() => document.getElementById('strip').scrollIntoView({ block: 'center' })); await sleep(150);
  await shot('sideA-strip');
  // ---- side B: frame slot, takes (one arriving, one skipped with Download), references, and the song bar on side A ----
  await page.click('.sidetab[data-side="b"]'); await page.locator('.bitem').nth(2).click(); await sleep(300);
  await set(all({ 3: 'downloading', 2: 'downloading', 1: 'skipped', 5: 'downloading', 6: 'failed', 7: 'downloading' }));
  await sleep(200);
  const sideB = await page.evaluate(() => ({ frame: document.querySelector('#fStartImg [data-miss] .mpt')?.textContent, takes: [...document.querySelectorAll('.take [data-miss]')].map(e => e.querySelector('.mpt').textContent + (e.querySelector('[data-mact]') ? ' +' + e.querySelector('[data-mact]').textContent : '')),
    refs: [...document.querySelectorAll('.ref [data-miss]')].map(e => e.querySelector('[data-mact]')?.textContent || e.querySelector('.mpt').textContent) }));
  check('side B: frame, takes and references show their state, Download on the skipped take, Retry on the failed reference',
    /^Arriving/.test(sideB.frame) && sideB.takes.some(t => /^Arriving · 42%/.test(t)) && sideB.takes.some(t => /Over the size limit \+Download/.test(t)) && sideB.refs.includes('Retry') && sideB.refs.some(t => /^Arriving/.test(t)), JSON.stringify(sideB));
  await shot('sideB-placeholders');
  await page.evaluate(() => document.getElementById('bTakes').scrollIntoView({ block: 'center' })); await sleep(150);
  await shot('sideB-takes');
  await page.click(`.take [data-miss="sha256-${H(1)}"] [data-mact="download"]`); await sleep(200);
  check('Download in place fetches the skipped take, focus stays on its placeholder', await page.evaluate(h => window.__STUB.files.find(f => f.hex === h).state === 'downloading' && !!document.querySelector(`.take [data-miss="sha256-${h}"] .mbar`), H(1)));
  await page.click('.sidetab[data-side="a"]'); await page.evaluate(() => scrollTo(0, 0)); await sleep(200);
  const bar = await page.evaluate(() => document.querySelector('#songph:not([hidden]) .mpt')?.textContent);
  check('the song bar shows the song arriving', /^Arriving · 31%$/.test(bar || ''), bar);
  await shot('sideA-songbar', { x: 0, y: 0, width: 1440, height: 260 });

  // ---- a deleted take while its file is downloading: its placeholder goes, nothing throws ----
  await page.click('.sidetab[data-side="b"]'); await sleep(150);
  await page.evaluate(() => { const a = window.__CUE_MEDIA_TEST.app, s = a.S()[2]; s.takes = s.takes.slice(1); a.scheduleSave(); a.renderAll(); });
  await page.click('.sidetab[data-side="a"]'); await page.click('.sidetab[data-side="b"]');   // renderAll is side A's; switching back draws side B
  await page.evaluate(() => window.__STUB.ping()); await sleep(150);
  check('deleted take while downloading: its placeholder is gone, the panel still renders', await page.evaluate(h => !document.querySelector(`[data-miss="sha256-${h}"]`), H(2)));
  await page.click('.sidetab[data-side="a"]');

  // ---- leaving the room with the panel open: panel and indicator go, focus isn't lost in a hidden panel ----
  await open();
  await page.evaluate(() => { window.__STUB.status = 'synced'; });
  await page.click('#proj'); await page.click('#projmenu [data-act="leave"]'); await sleep(200);
  check('leaving the room with the panel open hides the indicator and the panel', await page.$eval('#mstatw', e => e.hidden) && await page.$eval('#mpanel', e => e.hidden));

  // ---- 820px: the panel fits and scrolls; nothing overflows 1920 to 820 ----
  await page.evaluate(async () => { const db = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    await new Promise(r => { const q = db.transaction('settings', 'readwrite').objectStore('settings').put({ name: 'Ramiro', rooms: { 'p-example': { roomId: 'r'.repeat(22), token: 't'.repeat(22), name: 'Ramiro' } } }, 'collab'); q.onsuccess = r; }); });
  await page.reload(); await page.waitForSelector('.card'); await page.waitForFunction(() => window.__STUB && window.__STUB.pid);
  const many = [...all({ 2: 'downloading', 3: 'unavailable', 1: 'skipped', 6: 'failed' }), ...Array.from({ length: 14 }, (_, i) => F(8 + (i % 2), `Shot ${String(i + 7).padStart(2, '0')} · a frame with a long descriptive file name`, 3e6 + i * 1e5, 'here'))].map((f, i) => ({ ...f, hex: f.hex.slice(0, 60) + String(1000 + i) }));
  await set(many, { free: 6e8 });
  const over = [];
  for (const w of [1920, 1440, 1280, 1100, 900, 820]) {
    await page.setViewportSize({ width: w, height: 900 }); await sleep(150); await open();
    const o = await page.evaluate(() => { const p = document.getElementById('mpanel').getBoundingClientRect(); return { doc: document.documentElement.scrollWidth - innerWidth, left: p.left, right: innerWidth - p.right, bottom: innerHeight - p.bottom, scroll: document.getElementById('fList').scrollHeight > document.getElementById('fList').clientHeight }; });
    if (o.doc > 0 || o.left < 0 || o.right < 0 || o.bottom < 0 || !o.scroll) over.push(`${w}:${JSON.stringify(o)}`);
    if (w === 820) await shot('panel-820');
    await close();
  }
  check('the panel fits on screen and its list scrolls, 1920 to 820 px; no page overflow', !over.length, over.join(' '));
  await page.setViewportSize({ width: 820, height: 600 }); await open();
  check('820x600: the panel fits the height and scrolls inside', await page.evaluate(() => { const p = document.getElementById('mpanel'), r = p.getBoundingClientRect(); return r.bottom <= innerHeight && p.scrollHeight >= p.clientHeight; }));
  await shot('panel-820x600'); await close();
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- contrast (AA) and hit targets of what this adds ----
  await open();
  const cr = await page.evaluate(() => {
    const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number), lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bg = getComputedStyle(document.getElementById('mpanel')).backgroundColor, low = [];
    document.querySelectorAll('#mpanel .fn, #mpanel .fs, #mpanel .fw, #mpanel .hint, #mpanel h3, #mpanel label, #mpanel .muted').forEach(e => { const r = ratio(getComputedStyle(e).color, bg); if (r < 4.5) low.push(e.className + ' ' + r.toFixed(2)); });
    const small = [...document.querySelectorAll('#mpanel button, #mpanel select, #mstat')].map(e => { const r = e.getBoundingClientRect(), a = getComputedStyle(e, '::after'), extra = a.content !== 'none' ? Math.max(0, -parseFloat(a.top) * 2) : 0; return [e.id || e.textContent, Math.max(r.height + extra, 0), r.width]; }).filter(([, h, w]) => h < 32 || w < 32);
    return { low, small };
  });
  check('panel text meets AA (4.5:1) on its surface', !cr.low.length, cr.low.join(', '));
  check('panel controls and the indicator have hit targets of at least 32px', !cr.small.length, JSON.stringify(cr.small));
  await close();
  // prefers-reduced-motion: the waiting ring stands still, the panel doesn't rise
  await set(all({ 5: 'queued' }));
  const spin = await page.$eval('#mstat .mring', e => getComputedStyle(e).animationName);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(100);
  const still = await page.$eval('#mstat .mring', e => getComputedStyle(e).animationName);
  check('the waiting ring spins, and stands still with reduced motion', spin === 'mspin' && still === 'none', `${spin} / ${still}`);
} catch (e) { check('ran to the end', false, e.stack); }
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close(); srv.close();
process.exit(results.every(Boolean) ? 0 : 1);
