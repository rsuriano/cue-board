// Collaboration check: two (three) browser contexts against a real sync server, rooms made with the server CLI.
//   node design/collab-check.mjs <repo-root> <out-dir>
// Starts packages/sync-server on 127.0.0.1:3360 with a throwaway DATA_DIR, serves <repo-root> on a free port with
// <meta name="cue-sync-url"> pointed at it (?sync=hang points it at a socket that never answers, for "Syncing…").
// Never talks to OpenRouter: every request that isn't local is aborted.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3360, dataDir = mkdtempSync(join(tmpdir(), 'cue-collab-check-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = { console: [], checks: [] };
const check = (name, ok, ev = '') => { log.checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };

// a socket that accepts and never answers the WebSocket handshake
const hang = tcpServer(() => {}); await new Promise(ok => hang.listen(0, '127.0.0.1', ok));
// a pass-through to the sync server that records each WebSocket handshake as the server receives it, and the answer
const TAP_PORT = 3361, taps = [];
const tap = tcpServer(c => {
  const up = connect(SYNC_PORT, '127.0.0.1'), rec = { req: '', res: '' }; taps.push(rec);
  c.on('data', d => { if (!rec.req.includes('\r\n\r\n')) rec.req += d.toString('latin1'); });
  up.on('data', d => { if (!rec.res.includes('\r\n\r\n')) rec.res += d.toString('latin1'); });
  c.pipe(up); up.pipe(c); c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
});
await new Promise(ok => tap.listen(TAP_PORT, '127.0.0.1', ok));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = createServer((q, r) => {
  const [path, qs = ''] = q.url.split('?');
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="ws://127.0.0.1:${/sync=hang/.test(qs) ? hang.address().port : /sync=tap/.test(qs) ? TAP_PORT : SYNC_PORT}">`);
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';

const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', LOG_LEVEL: 'debug', APP_URL: app };
const cli = name => {
  const r = spawnSync(process.execPath, [join(root, 'packages/sync-server/bin/create-project.mjs'), name], { env, encoding: 'utf8' });
  const link = /app: +(\S+)/.exec(r.stdout)?.[1], m = /#join=([^.]+)\.(\S+)$/.exec(link || '');
  if (!m) throw new Error('create-project printed no app link: ' + r.stdout + r.stderr);
  return { link, room: m[1], token: m[2] };
};
const room = cli('Collab check'), tokens = [room.token];
check('CLI prints an app invite link with the token in the #fragment', room.link.startsWith(app + '#join='), room.link.replace(room.token, '<token>'));
const server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(100);

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  // sessionStorage "slowHash" = ms: SHA-256 takes that long (a large file on a slow device), to widen the hashing window
  await ctx.addInitScript(() => {
    const digest = SubtleCrypto.prototype.digest;
    SubtleCrypto.prototype.digest = async function (...a) { const ms = +sessionStorage.getItem('slowHash') || 0; if (ms) await new Promise(r => setTimeout(r, ms)); return digest.apply(this, a); };
  });
  const page = await ctx.newPage();
  page.on('console', m => { log.console.push(`${name} ${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => log.console.push(`${name} pageerror: ${e.message}`));
  return { ctx, page };
}
const shot = async (page, name) => {
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 4000 }).catch(() => {});
  await page.screenshot({ path: `${out}/${name}.png` });
};
const chip = page => page.evaluate(() => { const c = document.getElementById('cstat'); return c.hidden ? '' : c.textContent; });
async function until(fn, ms = 6000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(80); } }
const val = (page, id) => page.$eval('#' + id, el => el.value);
const cards = page => page.$$eval('.card .ct', els => els.map(e => e.textContent));
async function nameStep(page, name) {
  await page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 6000 });
  await page.fill('#jName', name); await page.click('#jGo');
}
const menu = async (page, act) => { await page.click('#proj'); await page.click(`#projmenu [data-act="${act}"]`); };
const presence = page => page.evaluate(() => { const p = document.getElementById('presence'); return p.hidden ? '' : [...p.children].map(c => c.textContent).join(','); });
/* this browser's room project as saved in IndexedDB (pid: the first bound one), whether the room's offline copy
   ("cueboard-collab" docs) exists, and the device id. Never creates a database. */
const stored = (page, pid) => page.evaluate(async pid => {
  const open = n => new Promise(r => { const q = indexedDB.open(n); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
  const get = (d, st, k) => new Promise(r => { try { const g = d.transaction(st).objectStore(st).get(k); g.onsuccess = () => r(g.result); g.onerror = () => r(undefined); } catch { r(undefined); } });
  const l = await open('cueboard-local'), cd = await open('cueboard-collab');
  if (!pid) pid = Object.keys((await get(l, 'settings', 'collab'))?.rooms || {})[0];
  const out = { pid, project: (await get(l, 'projects', pid)) || null, copy: !!(cd && await get(cd, 'docs', pid)), dev: await get(l, 'settings', 'deviceId') };
  l.close(); if (cd) cd.close(); return out;
}, pid);
const secOf = (p, id) => (p && p.sections.find(s => s.id === id)) || null;

let A, B, C;
try {
  /* ---- A has the example open, follows the invite, shares it into the (empty) room ---- */
  A = await newPage('A');
  await A.page.goto(app); await A.page.waitForSelector('.card'); await sleep(500);
  check('no room bound: collab.js is not loaded, no socket opened', !(await A.page.evaluate(() => performance.getEntriesByType('resource').some(e => /collab\.js|:3360/.test(e.name)))));
  const exampleBefore = await A.page.evaluate(() => document.querySelectorAll('.card').length);
  await A.page.goto(room.link); await A.page.waitForSelector('.card');
  check('the token is out of the address bar right after load', !A.page.url().includes(room.token) && !A.page.url().includes('#join'), A.page.url());
  await A.page.waitForSelector('#dlgJoin[open][data-step="name"]'); await A.page.fill('#jName', 'Ana Torres'); await shot(A.page, 'name-prompt');
  await A.page.click('#jGo');
  await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 });
  await sleep(250); await shot(A.page, 'join-dialog');
  check('join dialog offers sharing (room is empty) and opening as a new project', !(await A.page.$eval('#jShare', b => b.disabled)) && await A.page.isVisible('#jNew'));
  await A.page.click('#jShare');
  check('A: chip says Synced after sharing', (await until(async () => (await chip(A.page)) === 'Synced')) , await chip(A.page));

  /* ---- B: a new device, joins from the link, gets the shared project ---- */
  B = await newPage('B');
  await B.page.goto(room.link);
  await nameStep(B.page, 'Ben Ito');
  await B.page.waitForFunction(n => document.querySelectorAll('.card').length === n, exampleBefore, { timeout: 9000 }).catch(() => {});
  check('B: new device opens the room as a project with every shot', (await cards(B.page)).length === exampleBefore, `${(await cards(B.page)).length}/${exampleBefore}`);
  check('B: example was not auto-opened next to it', (await B.page.evaluate(() => document.querySelectorAll('#projmenu').length)) === 1 && !(await B.page.evaluate(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); return new Promise(r => { const g = d.transaction('projects').objectStore('projects').get('p-example'); g.onsuccess = () => r(!!g.result); }); })));
  await until(async () => (await chip(B.page)) === 'Synced');

  /* ---- A edits title and notes, B edits the same notes at the same time ---- */
  await A.page.click('#f-title'); await A.page.keyboard.press('End'); await A.page.keyboard.type(' (A)', { delay: 20 });
  await A.page.click('#f-notes'); await A.page.keyboard.press('Control+End');
  await B.page.click('#f-notes'); await B.page.keyboard.press('Control+Home');
  await Promise.all([A.page.keyboard.type(' alpha', { delay: 35 }), B.page.keyboard.type('beta ', { delay: 35 })]);
  const conv = await until(async () => { const a = await val(A.page, 'f-notes'), b = await val(B.page, 'f-notes'); return a === b && a.includes(' alpha') && a.startsWith('beta ') ? a : ''; });
  check('concurrent notes converge with both edits', !!conv, JSON.stringify((conv || (await val(A.page, 'f-notes'))).slice(0, 40) + '…'));
  const ca = await A.page.$eval('#f-notes', el => [el.selectionStart, el.value.indexOf(' alpha') + 6, document.activeElement === el]);
  const cb = await B.page.$eval('#f-notes', el => [el.selectionStart, 5, document.activeElement === el]);
  check('carets stay with each typist (A after " alpha", B after "beta ") and focus is kept', ca[0] === ca[1] && cb[0] === cb[1] && ca[2] && cb[2], `A ${ca[0]}/${ca[1]} B ${cb[0]}/${cb[1]}`);
  check('A\'s title edit reaches B', await until(async () => (await cards(B.page))[0]?.endsWith(' (A)')), (await cards(B.page))[0]);

  /* ---- A adds a cut and swaps two shots; B sees both ---- */
  await A.page.click('#ed-n').catch(() => {}); await A.page.evaluate(() => document.activeElement && document.activeElement.blur());
  const before = await cards(A.page);
  await A.page.keyboard.press('Shift+ArrowRight'); await A.page.keyboard.press('m'); // cut at 5 s
  check('A adds a shot, B sees it', await until(async () => (await cards(B.page)).length === before.length + 1), `${(await cards(B.page)).length}`);
  const c1 = await A.page.locator('.card').nth(2).boundingBox(), c2 = await A.page.locator('.card').nth(3).boundingBox();
  const t2 = (await cards(A.page))[2], t3 = (await cards(A.page))[3];
  await A.page.mouse.move(c1.x + c1.width / 2, c1.y + 40); await A.page.mouse.down();
  await A.page.mouse.move(c1.x + c1.width / 2 + 20, c1.y + 45, { steps: 3 }); await A.page.mouse.move(c2.x + c2.width / 2, c2.y + 40, { steps: 8 }); await A.page.mouse.up();
  check('A swaps shots 03 and 04, B sees the new order', await until(async () => { const l = await cards(B.page); return l[2] === t3 && l[3] === t2; }), `${t2} <-> ${t3}`);

  /* ---- presence: A on shot 05, B on shot 01 ---- */
  await A.page.locator('.card').nth(4).click(); await B.page.locator('.card').nth(0).click();
  const mark = await until(() => B.page.evaluate(() => { const m = document.querySelectorAll('.card')[4]?.querySelector('.pmark'); return m ? m.textContent : ''; }));
  check('B sees A\'s selection as a quiet marker on shot 05', mark === 'AT', mark);
  const pres = await until(() => A.page.evaluate(() => { const p = document.getElementById('presence'); return p.hidden ? '' : p.textContent; }));
  check('A\'s header lists B', pres === 'BI', pres);
  check('the marker is not the accent colour', await B.page.evaluate(() => { const b = document.querySelector('.pmark b'), cs = getComputedStyle(b), acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); return !!b && !(cs.color + cs.backgroundColor).includes('240, 163, 58') && acc === '#f0a33a'; }));
  await sleep(300); await shot(A.page, 'side-a-two-users'); await shot(B.page, 'presence-b');

  /* ---- B goes offline and edits, A edits meanwhile, B comes back ---- */
  await B.ctx.setOffline(true);
  check('B: chip says offline', await until(async () => (await chip(B.page)) === 'Offline, changes will sync'), await chip(B.page));
  await B.page.locator('.card').nth(1).click(); await B.page.click('#f-notes'); await B.page.keyboard.press('Control+End'); await B.page.keyboard.type(' [offline B]', { delay: 10 });
  await B.page.evaluate(() => document.activeElement.blur()); await sleep(200); await shot(B.page, 'chip-offline');
  await A.page.locator('.card').nth(1).click(); await A.page.click('#f-title'); await A.page.keyboard.press('End'); await A.page.keyboard.type(' [A while B away]', { delay: 10 });
  await A.page.evaluate(() => document.activeElement.blur());
  await sleep(600);
  await B.ctx.setOffline(false);
  const merged = await until(async () => (await val(A.page, 'f-notes')).endsWith(' [offline B]') && (await cards(B.page))[1]?.endsWith(' [A while B away]'), 9000);
  check('B\'s offline edit and A\'s edit both survive the reconnect', merged, `${(await val(A.page, 'f-notes')).slice(-14)} | ${(await cards(B.page))[1]}`);
  check('B: chip back to Synced', await until(async () => (await chip(B.page)) === 'Synced'), await chip(B.page));

  /* ---- reload keeps the binding and the state ---- */
  const bBefore = await cards(B.page);
  await B.page.reload(); await B.page.waitForSelector('.card');
  check('B reload: same shots, still bound, Synced', await until(async () => (await chip(B.page)) === 'Synced' && JSON.stringify(await cards(B.page)) === JSON.stringify(bBefore)), await chip(B.page));

  /* ---- media: A uploads a frame for shot 01; B doesn't have the file ---- */
  await A.page.locator('.card').nth(0).click();
  const png = await A.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 320, 180); gr.addColorStop(0, '#2b2a33'); gr.addColorStop(1, '#6e5a3a'); g.fillStyle = gr; g.fillRect(0, 0, 320, 180); return c.toDataURL('image/png').split(',')[1]; });
  await A.page.setInputFiles('#f-img', { name: 'frame.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const ph = await until(() => B.page.evaluate(() => document.querySelector('.card .thumb .tn.miss')?.textContent || ''), 9000);
  check('B shows a quiet "not on this device yet" placeholder for A\'s image', ph === 'Not on this device yet', ph);
  check('A still shows its own image', await A.page.evaluate(() => !!document.querySelector('.card .thumb img')));
  await B.page.locator('.card').nth(0).click(); await sleep(300); await shot(B.page, 'placeholder');
  const own = await B.page.evaluate(() => [...document.querySelectorAll('.pmark b,#presence .pchip')].map(e => e.textContent));
  check('B never sees itself (not even its pre-reload session) as someone else', !own.includes('BI') && own.includes('AT'), own.join(','));

  /* ---- A sets a frame that takes a while to hash while B keeps typing: A's image stays and reaches B as its hash ---- */
  const fId = await A.page.locator('.card').nth(2).getAttribute('data-id');
  await A.page.locator('.card').nth(2).click();
  await A.page.evaluate(() => sessionStorage.setItem('slowHash', '3000'));
  const noise = await A.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'), im = g.createImageData(1280, 720);
    for (let i = 0; i < im.data.length; i++) im.data[i] = (i * 2654435761 >>> 13) & 255; g.putImageData(im, 0, 0); return c.toDataURL('image/png').split(',')[1]; });
  await B.page.locator('.card').nth(0).click(); await B.page.click('#f-notes'); await B.page.keyboard.press('Control+End');
  const typingF = B.page.keyboard.type(' B types while A sets a frame'.repeat(2), { delay: 70 });
  await sleep(300);
  await A.page.setInputFiles('#f-img', { name: 'big-frame.png', mimeType: 'image/png', buffer: Buffer.from(noise, 'base64') });
  const hasImg = () => A.page.evaluate(id => !!document.querySelector(`.card[data-id="${id}"] .thumb img`), fId);
  await sleep(1500); const midF = await hasImg(); await typingF;
  // saved once A's save timer (700 ms after the last change, B's keystrokes included) runs
  const aF = await until(async () => secOf((await stored(A.page)).project, fId)?.img || '', 4000) || '';
  check('A: a frame still being hashed is not undone by B\'s typing', midF && await hasImg() && /^m/.test(aF), `while hashing: ${midF}, saved: ${aF.slice(0, 12)}`);
  const bF = await until(async () => { const v = secOf((await stored(B.page)).project, fId)?.img || ''; return v.startsWith('sha256-') ? v : ''; }, 9000);
  check('the frame reaches B as sha256-…', /^sha256-[0-9a-f]{64}$/.test(bF), bF.slice(0, 20) || 'nothing');
  await A.page.evaluate(() => sessionStorage.removeItem('slowHash'));

  /* ---- a take finishes downloading on A (a fake OpenRouter job, nothing leaves the machine) while B types ---- */
  const JOB = 'https://openrouter.ai/api/v1/videos/job-collab-check';
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  await A.page.route(u => u.href.startsWith(JOB), r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (r.request().url().includes('/content')) return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'video/mp4' }, body: Buffer.alloc(65536, 7) });
    return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'job-collab-check', status: 'completed', unsigned_urls: [JOB + '/content?index=0'] }) });
  });
  const tId = await A.page.locator('.card').nth(1).getAttribute('data-id');
  await A.page.evaluate(() => document.activeElement && document.activeElement.blur()); await sleep(1200);
  // a pending take this browser started, straight into its saved project (as after a reload mid-generation)
  await A.page.evaluate(async sid => {
    const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const st = n => d.transaction(n, 'readwrite').objectStore(n), get = (n, k) => new Promise(r => { const g = st(n).get(k); g.onsuccess = () => r(g.result); });
    const put = (n, v, k) => new Promise(r => { const p = st(n).put(v, k); p.onsuccess = r; });
    const pid = Object.keys((await get('settings', 'collab')).rooms)[0], dev = await get('settings', 'deviceId'), p = await get('projects', pid);
    const s = p.sections.find(x => x.id === sid);
    s.takes = [{ id: 't-check', jobId: 'job-collab-check', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 4, audio: false, seed: '', prompt: 'check', start: true, end: false, est: 0.2, cost: null, status: 'pending', created: Date.now(), error: '', note: '', media: '', dev }, ...(s.takes || [])];
    p.updated = Date.now(); await put('projects', p, pid); await put('settings', 'sk-or-v1-collab-check-not-a-key', 'apiKey');
    sessionStorage.setItem('slowHash', '3000');
  }, tId);
  await A.page.reload(); await A.page.waitForSelector('.card');
  await B.page.click('#f-notes'); await B.page.keyboard.press('Control+End');
  await B.page.keyboard.type(' B types while A\'s take lands'.repeat(4), { delay: 70 });   // ~8 s: poll, download, hash all inside
  const aT = () => stored(A.page).then(v => (secOf(v.project, tId)?.takes || []).find(t => t.id === 't-check') || {});
  const aTake = await until(async () => { const t = await aT(); return t.status === 'completed' ? t : null; }, 6000) || {};
  check('A: the landed take keeps its media through B\'s edits (status "completed" with a file)', aTake.status === 'completed' && /^m/.test(aTake.media || ''), `${aTake.status}/${(aTake.media || '""').slice(0, 10)}`);
  const bT = await until(async () => { const t = (secOf((await stored(B.page)).project, tId)?.takes || []).find(t => t.id === 't-check'); return t && /^sha256-/.test(t.media || '') ? t : null; }, 9000);
  check('the take reaches B as completed with sha256-… media', !!bT && bT.status === 'completed', bT ? bT.media.slice(0, 20) : 'no media');
  await A.page.evaluate(() => sessionStorage.removeItem('slowHash')); await A.page.unroute(u => u.href.startsWith(JOB)).catch(() => {});
  await until(async () => (await chip(A.page)) === 'Synced');

  /* ---- the same browser in two tabs on one bound project: one person for the others, no duplicate, same state ---- */
  const A2 = await A.ctx.newPage();
  A2.on('console', m => { log.console.push(`A2 ${m.type()}: ${m.text()}`); }); A2.on('pageerror', e => log.console.push(`A2 pageerror: ${e.message}`));
  await A2.goto(app); await A2.waitForSelector('.card'); await until(async () => (await chip(A2)) === 'Synced');
  await A2.locator('.card').nth(3).click(); await A.page.locator('.card').nth(0).click(); await sleep(800);
  const pB = await presence(B.page), pA2 = await presence(A2), pA = await presence(A.page);
  check('two tabs of A: B lists A once; neither tab lists A itself', pB === 'AT' && pA2 === 'BI' && pA === 'BI', `B:${pB} A:${pA} A2:${pA2}`);
  await A2.click('#f-title'); await A2.keyboard.press('End');
  await A.page.click('#f-notes'); await A.page.keyboard.press('Control+End');
  await Promise.all([A2.keyboard.type(' [tab 2]', { delay: 40 }), A.page.keyboard.type(' [tab 1]', { delay: 40 })]);
  await A.page.evaluate(() => document.activeElement.blur()); await A2.evaluate(() => document.activeElement.blur());
  const sameAll = await until(async () => { const l = await Promise.all([cards(A.page), cards(A2), cards(B.page)]).then(x => x.map(c => JSON.stringify(c)));
    return l[0] === l[1] && l[1] === l[2] && l[0].includes(' [tab 2]'); });
  await sleep(1500);
  const [sA, sB] = [await stored(A.page), await stored(B.page)], strip = p => JSON.stringify(p.sections.map(s => [s.id, s.start, s.title, s.notes, (s.takes || []).length]));
  check('two tabs of A: both tabs\' edits reach everyone, and A\'s saved project matches B\'s', !!sameAll && strip(sA.project) === strip(sB.project) && secOf(sA.project, await A.page.locator('.card').nth(0).getAttribute('data-id')).notes.endsWith(' [tab 1]'));
  await A2.close();

  /* ---- C: has a local project; a wrong token first, then the right link as a new project ---- */
  C = await newPage('C');
  await C.page.goto(app); await C.page.waitForSelector('.card'); await sleep(400);
  const cLocal = await C.page.evaluate(() => JSON.stringify([...document.querySelectorAll('.card .ct')].map(e => e.textContent)));
  await menu(C.page, 'join');
  await C.page.fill('#jLink', `${app}#join=${room.room}.${'x' + room.token.slice(1)}`); await C.page.click('#jGo');
  await nameStep(C.page, 'Cleo');
  await C.page.waitForSelector('#dlgJoin[open][data-step="err"]', { timeout: 9000 });
  check('wrong token: "Can\'t reach the room", local project untouched', (await C.page.textContent('#jTitle')) === "Can't reach the room" && (await C.page.evaluate(() => JSON.stringify([...document.querySelectorAll('.card .ct')].map(e => e.textContent)))) === cLocal);
  await shot(C.page, 'join-wrong-token'); await C.page.click('#jCancel');
  await menu(C.page, 'join'); await C.page.fill('#jLink', room.link); await C.page.click('#jGo');
  await C.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 });
  check('room not empty: sharing is disabled', await C.page.$eval('#jShare', b => b.disabled));
  await C.page.click('#jNew');
  await until(async () => (await chip(C.page)) === 'Synced');
  const cProjects = await C.page.evaluate(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); return new Promise(r => { const g = d.transaction('projects').objectStore('projects').getAll(); g.onsuccess = () => r(g.result.map(p => [p.id, JSON.stringify(p.sections.map(s => s.title))])); }); });
  check('open as new project: C keeps its example untouched and has the room as a second project', cProjects.length === 2 && cProjects.some(([id, t]) => id === 'p-example' && t === cLocal), cProjects.length + ' projects');

  // a binding whose token was revoked (simulated: the stored token is changed), then a server that never answers
  const setToken = (page, t) => page.evaluate(async t => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); const st = () => d.transaction('settings', 'readwrite').objectStore('settings'); const c = await new Promise(r => { const g = st().get('collab'); g.onsuccess = () => r(g.result); }); for (const b of Object.values(c.rooms)) b.token = t; await new Promise(r => { const p = st().put(c, 'collab'); p.onsuccess = r; }); }, t);
  await setToken(C.page, 'x' + room.token.slice(1)); await C.page.reload(); await C.page.waitForSelector('.card');
  check('revoked token: chip says "Can\'t reach the room", the project still works', (await until(async () => (await chip(C.page)) === "Can't reach the room")) && (await C.page.$$('.card')).length > 1, await chip(C.page));
  await sleep(200); await shot(C.page, 'chip-rejected');
  await setToken(C.page, room.token); await C.page.goto(app + '?sync=hang'); await C.page.waitForSelector('.card'); await sleep(800);
  check('server not answering yet: chip says Syncing…', (await chip(C.page)) === 'Syncing…', await chip(C.page));
  await shot(C.page, 'chip-syncing');
  // the handshake as the server gets it: the token only in Sec-WebSocket-Protocol, never in the request line
  await C.page.goto(app + '?sync=tap'); await until(async () => (await chip(C.page)) === 'Synced');
  const hs = taps.find(t => t.req.startsWith(`GET /r/${room.room}`)) || { req: '', res: '' };
  const reqLine = hs.req.split('\r\n')[0], proto = /^sec-websocket-protocol: *(.*)$/im.exec(hs.req)?.[1] || '', echoed = /^sec-websocket-protocol: *(.*)$/im.exec(hs.res)?.[1] || '';
  check('Chromium sends the token as the second WebSocket subprotocol, not in the URL; the server echoes only "cueboard"',
    proto.split(/, */).join(',') === `cueboard,${room.token}` && !reqLine.includes(room.token) && /^HTTP\/1\.1 101/.test(hs.res) && echoed.trim() === 'cueboard',
    `${reqLine.replace(room.room, '<room>')} · protocols: ${proto.replace(room.token, '<token>')} · echoed: ${echoed.trim()}`);
  await C.page.goto(app); await until(async () => (await chip(C.page)) === 'Synced');

  /* ---- B leaves: keeps a local copy, stops syncing ---- */
  const bKeep = await cards(B.page);
  await menu(B.page, 'leave');
  await A.page.locator('.card').nth(0).click(); await A.page.click('#f-title'); await A.page.keyboard.press('End'); await A.page.keyboard.type(' after B left'); await A.page.evaluate(() => document.activeElement.blur());
  await sleep(800); await B.page.reload(); await B.page.waitForSelector('.card'); await sleep(600);
  check('leave: B keeps its copy, no chip, and no longer receives edits', JSON.stringify(await cards(B.page)) === JSON.stringify(bKeep) && (await chip(B.page)) === '' && !(await B.page.evaluate(() => performance.getEntriesByType('resource').some(e => /collab\.js/.test(e.name)))), (await cards(B.page))[0]);
  check('C (still in the room) gets the edit made after B left', await until(async () => (await cards(C.page))[0]?.endsWith(' after B left')));

  /* ---- layout with the chip and presence: 1920 to 820 ---- */
  const widths = [1920, 1440, 1280, 1100, 900, 820], over = [];
  // every chip state's label, longest included (the chip's text is set directly here; the states themselves are checked above)
  const states = [['synced', 'Synced', 'ok'], ['offline', 'Offline, changes will sync', 'off'], ['rejected', "Can't reach the room", 'err'], ['synced', 'Synced, 2 files not shared', 'ok', 1]];
  for (const [st, label, cls, un] of states) for (const w of widths) {
    await A.page.setViewportSize({ width: w, height: 900 });
    await A.page.evaluate(([st, label, cls, un]) => { const c = document.getElementById('cstat'); c.dataset.state = st; c.textContent = label; c.className = 'status cchip ' + cls; if (un) c.dataset.unshared = ''; else delete c.dataset.unshared; }, [st, label, cls, un]);
    await sleep(120); const o = await A.page.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (o > 0) over.push(`${st}@${w}:${o}`);
  }
  await A.page.setViewportSize({ width: 1440, height: 900 });
  check('no horizontal overflow 1920 to 820 px with collaboration on', !over.length, over.join(' ') || widths.join(','));

  /* ---- the token never shows up where it shouldn't ---- */
  // snap Chromium can't write downloads to /tmp: read the blob the app hands to its download link instead
  await A.page.evaluate(() => { const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then(r => r.text()).then(t => { window.__export = t; }); else click.call(this); }; });
  await A.page.click('#exportb'); await A.page.click('#expGo');
  const exp = await until(() => A.page.evaluate(() => window.__export || ''));
  check('export: a .cueboard.json without the token or room id', exp.includes('"format":"cueboard"') && !tokens.some(t => exp.includes(t)) && !exp.includes(room.room));
  const leaks = [];
  for (const [n, P] of [['A', A], ['B', B], ['C', C]]) {
    if (tokens.some(t => P.page.url().includes(t))) leaks.push(n + ' url');
    const lsDump = await P.page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    if (tokens.some(t => lsDump.includes(t))) leaks.push(n + ' localStorage');
    const titles = await P.page.evaluate(() => [...document.querySelectorAll('[title]')].map(e => e.title).join('|') + document.body.innerText);
    if (tokens.some(t => titles.includes(t))) leaks.push(n + ' page text');
  }
  if (log.console.some(l => tokens.some(t => l.includes(t)))) leaks.push('console');
  if (tokens.some(t => serverLog.includes(t))) leaks.push('server log');
  check('token absent from page URLs, localStorage, page text, console and server log', !leaks.length, leaks.join(', '));
  // expected noise, as in shoot.mjs: the api/health probe (404 without server.mjs) and the aborted OpenRouter model list
  const errs = log.console.filter(l => / (error|pageerror):/.test(l) && !/Failed to load resource/.test(l));
  check('no console errors (besides blocked/404 probes); no WebSocket errors', !errs.length, errs.slice(0, 3).join(' / '));

  /* ---- leaving from a tab that never loaded collab.js still deletes the room's offline copy ---- */
  const cBefore = await stored(C.page);
  await C.page.close();
  const C2 = await C.ctx.newPage(); let blocked = 0;
  await C2.route(u => u.pathname.endsWith('/collab.js'), r => { blocked++; return r.abort(); });
  await C2.goto(app); await C2.waitForSelector('.card');
  await until(async () => (await chip(C2)) === "Can't reach the room");
  await menu(C2, 'leave'); await sleep(600);
  const cAfter = await stored(C2, cBefore.pid);
  check('leave without collab.js loaded: the room\'s offline copy is gone, the project stays', blocked > 0 && cBefore.copy && !cAfter.copy && !!cAfter.project && (await chip(C2)) === '', `copy before ${cBefore.copy}, after ${cAfter.copy}; collab.js requests blocked: ${blocked}`);
} catch (e) {
  check('run completed', false, e.stack.split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close(); server.kill('SIGTERM'); srv.close(); hang.close(); tap.close();
  rmSync(dataDir, { recursive: true, force: true });
  const fails = log.checks.filter(c => !c.ok).length;
  console.log(`\n${log.checks.length - fails}/${log.checks.length} passed`);
  process.exitCode = fails ? 1 : 0;
}
