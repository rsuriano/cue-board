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
  if (path === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>blank</title>'); return; }   // same origin, no app
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
    // this check is about the doc: "not on this device yet" stays as it is. Media transfers: design/media-check.mjs
    window.__CUE_MEDIA_TEST = { off: true };
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
// the room's state in words: the media status indicator's panel header (there whether the panel is open or not)
const chip = page => page.evaluate(() => (document.getElementById('mstatw').hidden ? '' : document.getElementById('mhead').textContent));
async function until(fn, ms = 6000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(80); } }
const val = (page, id) => page.$eval('#' + id, el => el.value);
const cards = page => page.$$eval('.card .ct', els => els.map(e => e.textContent));
async function nameStep(page, name) {
  await page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 6000 });
  await page.fill('#jName', name); await page.click('#jGo');
}
// Join and Leave are top-level buttons in the bar; Leave confirms with a second tap
const menu = async (page, act) => { if (act === 'join') await page.click('#joinb'); else { await page.click('#leaveb'); await page.click('#leaveb'); } };
// everyone else in the presence row (your own bubble, .self, comes first and is left out here)
const presence = page => page.evaluate(() => { const p = document.getElementById('presence'); return p.hidden ? '' : [...p.children].filter(c => !c.classList.contains('self')).map(c => c.textContent).join(','); });
// the whole row as [initials, tooltip] pairs, and what a bubble's tooltip shows on hover / keyboard focus
const bubbles = page => page.evaluate(() => [...document.querySelectorAll('#presence:not([hidden]) .pchip')].map(c => [c.textContent, c.dataset.tip, c.classList.contains('self')]));
const tipShown = (page, sel) => page.evaluate(sel => { const c = document.querySelector(sel), a = c && getComputedStyle(c, '::after'); return a && a.display !== 'none' && a.visibility === 'visible' ? a.content.replace(/^"|"$/g, '') : ''; }, sel);
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
/* the room's offline copy for `pid` contains the string `s` (a single insert is stored as one run of UTF-8) */
const copyHas = (page, pid, s) => page.evaluate(async ([pid, s]) => {
  const d = await new Promise(r => { const q = indexedDB.open('cueboard-collab'); q.onupgradeneeded = () => q.transaction.abort(); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
  if (!d) return false;
  const rec = await new Promise(r => { try { const g = d.transaction('docs').objectStore('docs').get(pid); g.onsuccess = () => r(g.result); g.onerror = () => r(null); } catch { r(null); } });
  d.close(); const u = rec && (rec.u || rec);
  return !!u && new TextDecoder().decode(u).includes(s);
}, [pid, s]);
/* this browser has a media file with this id */
const hasBlob = (page, id) => page.evaluate(async id => {
  const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
  return new Promise(r => { const g = d.transaction('media').objectStore('media').get(id); g.onsuccess = () => r(!!g.result); g.onerror = () => r(false); });
}, id);
const watch = (page, name) => { page.on('console', m => { log.console.push(`${name} ${m.type()}: ${m.text()}`); }); page.on('pageerror', e => log.console.push(`${name} pageerror: ${e.message}`)); };
/* a plain Yjs client in the room (someone else's browser, as the server sees it) */
const Y = await import('yjs'), { WebsocketProvider } = await import('y-websocket'), { shotsMap } = await import('@cue-board/sync-server/schema');
async function roomClient() {
  const doc = new Y.Doc(), p = new WebsocketProvider(`ws://127.0.0.1:${SYNC_PORT}/r`, room.room, doc, { protocols: ['cueboard', room.token], disableBc: true });
  await until(() => p.synced, 6000);
  return { doc, shot: id => shotsMap(doc).get(id), done: () => { p.destroy(); doc.destroy(); } };
}
const takeIn = (ys, id) => (ys.get('takes')?.toArray() || []).find(t => t.get('id') === id);

let A, B, C;
try {
  /* ---- A has the example open, follows the invite, shares it into the (empty) room ---- */
  A = await newPage('A');
  await A.page.goto(app); await A.page.waitForSelector('.card'); await sleep(500);
  check('no room bound: collab.js is not loaded, no socket opened', !(await A.page.evaluate(() => performance.getEntriesByType('resource').some(e => /collab\.js|:3360/.test(e.name)))));
  const exampleBefore = await A.page.evaluate(() => document.querySelectorAll('.card').length);
  // a take from before collaboration (no `dev`) in the project A is about to share, written once A has nothing left to save
  check('not in a room: Join collaboration in the bar, no Leave, no bubbles', await A.page.isVisible('#joinb') && !(await A.page.isVisible('#leaveb')) && !(await A.page.isVisible('#presence'))
    && await A.page.evaluate(() => !document.querySelector('#projmenu [data-act="join"], #projmenu [data-act="leave"]')));
  await until(() => A.page.evaluate(() => document.getElementById('status').textContent === 'Saved')); await sleep(1000);
  // (a save still pending when the page goes is flushed on pagehide, over this write: reload, then check it held)
  const hasLegacy = async () => !!(await stored(A.page, 'p-example')).project?.sections.some(s => (s.takes || []).some(t => t.id === 't-legacy'));
  let injected = false;
  for (let i = 0; i < 3 && !injected; i++) {
  await until(() => A.page.evaluate(async () => {
    const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const st = () => d.transaction('projects', 'readwrite').objectStore('projects');
    const p = await new Promise(r => { const g = st().get('p-example'); g.onsuccess = () => r(g.result); });
    if (!p) return false;
    p.sections[0].takes = [{ id: 't-legacy', jobId: 'job-legacy', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 4, audio: false, seed: '', prompt: 'legacy', start: false, end: false, est: 0.2, cost: null, status: 'completed', created: Date.now(), media: '', error: '', note: '' }];
    await new Promise(r => { const q = st().put(p, 'p-example'); q.onsuccess = r; }); return true;
  }), 6000);
  await A.page.reload(); await A.page.waitForSelector('.card'); await sleep(1500);
  injected = await hasLegacy();
  }
  await A.page.goto(room.link); await A.page.waitForSelector('.card');
  check('the token is out of the address bar right after load', !A.page.url().includes(room.token) && !A.page.url().includes('#join'), A.page.url());
  await A.page.waitForSelector('#dlgJoin[open][data-step="name"]'); await A.page.fill('#jName', 'Ana Torres'); await shot(A.page, 'name-prompt');
  await A.page.click('#jGo');
  await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 });
  await sleep(250); await shot(A.page, 'join-dialog');
  check('join dialog offers sharing (room is empty) and opening as a new project', !(await A.page.$eval('#jShare', b => b.disabled)) && await A.page.isVisible('#jNew'));
  await A.page.click('#jShare');
  check('A: chip says Synced after sharing', (await until(async () => (await chip(A.page)) === 'Synced')) , await chip(A.page));
  const aAlone = await until(async () => { const b = await bubbles(A.page); return b.length ? b : null; });
  check('A, alone in the room: its own bubble, Leave instead of Join, saved state "Saved" (synced)', JSON.stringify(aAlone) === JSON.stringify([['AT', 'Ana Torres (you)', true]]) && await A.page.isVisible('#leaveb') && !(await A.page.isVisible('#joinb'))
    && await A.page.evaluate(() => document.getElementById('status').textContent === 'Saved' && /synced with the room/.test(document.getElementById('status').title)), JSON.stringify(aAlone));

  /* ---- B: a new device, joins from the link, gets the shared project ---- */
  B = await newPage('B');
  await B.page.goto(room.link);
  await nameStep(B.page, 'Ben Ito');
  await B.page.waitForFunction(n => document.querySelectorAll('.card').length === n, exampleBefore, { timeout: 9000 }).catch(() => {});
  check('B: new device opens the room as a project with every shot', (await cards(B.page)).length === exampleBefore, `${(await cards(B.page)).length}/${exampleBefore}`);
  check('B: example was not auto-opened next to it', (await B.page.evaluate(() => document.querySelectorAll('#projmenu').length)) === 1 && !(await B.page.evaluate(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); return new Promise(r => { const g = d.transaction('projects').objectStore('projects').get('p-example'); g.onsuccess = () => r(!!g.result); }); })));
  await until(async () => (await chip(B.page)) === 'Synced');
  const aDev = (await stored(A.page)).dev, legacy = await until(async () => (await stored(B.page)).project?.sections.flatMap(s => s.takes || []).find(t => t.id === 't-legacy'));
  check('sharing stamps this browser\'s id on the project\'s older takes (so only A ever polls them)', !!legacy && !!aDev && legacy.dev === aDev, legacy ? `dev ${legacy.dev === aDev ? 'A' : legacy.dev || 'none'}` : `take not in B (written into A's project: ${injected}; in A's saved project: ${(await stored(A.page)).project?.sections.some(s => (s.takes || []).some(t => t.id === 't-legacy'))})`);

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
  const pres = await until(async () => { const b = await bubbles(A.page); return b.length > 1 ? b : null; });
  check('A\'s header lists itself first, then B', JSON.stringify(pres?.map(b => [b[0], b[2]])) === '[["AT",true],["BI",false]]' && pres[1][1] === 'Ben Ito · on shot 01', JSON.stringify(pres));
  const bRow = await until(async () => { const b = await bubbles(B.page); return b.length > 1 ? b : null; });
  check('the second user sees itself first (Ben Ito (you)) and the first user', JSON.stringify(bRow?.map(b => [b[0], b[1].replace(/ · .*/, ''), b[2]])) === '[["BI","Ben Ito (you)",true],["AT","Ana Torres",false]]', JSON.stringify(bRow));
  await A.page.hover('#presence .pchip.self'); await sleep(150);
  const tipHover = await tipShown(A.page, '#presence .pchip.self');
  await shot(A.page, 'own-bubble-hover');
  await A.page.mouse.move(700, 600); await A.page.focus('#presence .pchip.self'); await A.page.keyboard.press('ArrowRight'); await sleep(150);
  const tipFocus = await tipShown(A.page, '#presence .pchip:not(.self)');
  check('bubble names show on hover (own: "Ana Torres (you)") and on keyboard focus (arrows move along the row)', tipHover === 'Ana Torres (you)' && /^Ben Ito/.test(tipFocus), `${tipHover} / ${tipFocus}`);
  check('the own bubble is not the accent colour', await A.page.evaluate(() => { const cs = getComputedStyle(document.querySelector('#presence .self')); return !(cs.color + cs.backgroundColor + cs.boxShadow).includes('240, 163, 58'); }));
  await A.page.evaluate(() => document.activeElement.blur());
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

  /* ---- B's renderer dies right after its offline copy took A's change (copy saved, project maybe not): the reopen keeps it ---- */
  {
    const bPid = (await stored(B.page)).pid, sid0 = await A.page.locator('.card').nth(0).getAttribute('data-id'), R = ' [R from A before B crashed]';
    await A.page.locator('.card').nth(0).click();
    await A.page.fill('#f-notes', (await val(A.page, 'f-notes')) + R); await A.page.evaluate(() => document.activeElement.blur());
    const inCopy = await until(() => copyHas(B.page, bPid, R), 4000);
    const cdp = await B.ctx.newCDPSession(B.page); cdp.send('Page.crash').catch(() => {});
    await B.page.waitForEvent('crash', { timeout: 4000 }).catch(() => {});
    B.page = await B.ctx.newPage(); watch(B.page, 'B');
    await B.page.goto(origin + '/blank.html');   // what the crash left in storage, read without the app running
    const inProject = !!secOf((await stored(B.page, bPid)).project, sid0)?.notes.includes(R);
    await B.page.goto(app); await B.page.waitForSelector('.card'); await until(async () => (await chip(B.page)) === 'Synced');
    await sleep(1500);
    const aNow = await val(A.page, 'f-notes');   // A still has shot 01 selected
    const bNow = secOf((await stored(B.page, bPid)).project, sid0)?.notes || '';
    check('B crashes after its offline copy has A\'s change: after reopening, A\'s change is still in the room and reaches B',
      inCopy && aNow.endsWith(R) && bNow.endsWith(R), `in B's copy ${!!inCopy}, in B's saved project at the crash ${inProject}; A ${aNow.endsWith(R)}, B ${bNow.endsWith(R)}`);
  }

  /* ---- media: A uploads a frame for shot 01; B doesn't have the file ---- */
  await A.page.locator('.card').nth(0).click();
  const png = await A.page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 320, 180); gr.addColorStop(0, '#2b2a33'); gr.addColorStop(1, '#6e5a3a'); g.fillStyle = gr; g.fillRect(0, 0, 320, 180); return c.toDataURL('image/png').split(',')[1]; });
  await A.page.setInputFiles('#f-img', { name: 'frame.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const ph = await until(() => B.page.evaluate(() => document.querySelector('.card .thumb .tn.miss')?.textContent || ''), 9000);
  check('B shows a quiet "not on this device yet" placeholder for A\'s image', ph === 'Not on this device yet', ph);
  check('A still shows its own image', await A.page.evaluate(() => !!document.querySelector('.card .thumb img')));
  await B.page.locator('.card').nth(0).click(); await sleep(300); await shot(B.page, 'placeholder');
  const own = await B.page.evaluate(() => [...document.querySelectorAll('.pmark b,#presence .pchip:not(.self)')].map(e => e.textContent));
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

  /* ---- someone else deletes A's take while the shot still uses its file, then clears the shot: A frees the file only then ---- */
  {
    const rc = await roomClient(), ys = rc.shot(tId), ref = takeIn(ys, 't-check')?.get('media'), mId = aTake.media || '';
    rc.doc.transact(() => { ys.set('img', { ...ref }); ys.set('kind', 'video'); });
    const used = await until(async () => secOf((await stored(A.page)).project, tId)?.img === mId, 6000);
    rc.doc.transact(() => { const ya = ys.get('takes'); ya.delete(ya.toArray().indexOf(takeIn(ys, 't-check')), 1); });
    await until(async () => !(secOf((await stored(A.page)).project, tId)?.takes || []).some(t => t.id === 't-check'), 6000); await sleep(1000);
    const kept = mId && await hasBlob(A.page, mId);
    rc.doc.transact(() => { ys.delete('img'); ys.set('kind', ''); });
    const freed = await until(async () => !(await hasBlob(A.page, mId)), 6000);
    check('a take deleted elsewhere: A keeps its file while the shot still uses it, and frees it once nothing does', used && kept && freed, `used by the shot ${used}, kept after the take went ${kept}, freed after the shot cleared ${freed}`);
    rc.done();
  }

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

  /* ---- a pending take with no `dev` in the room (someone else's, or older): B has a key and polls, but never that one ---- */
  {
    const rc = await roomClient(), sid = await A.page.locator('.card').nth(0).getAttribute('data-id'), ys = rc.shot(sid);
    rc.doc.transact(() => {
      let ya = ys.get('takes'); if (!(ya instanceof Y.Array)) { ya = new Y.Array(); ys.set('takes', ya); }
      const t = new Y.Map();
      for (const [k, v] of Object.entries({ id: 't-nodev', jobId: 'job-nodev', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 4, status: 'pending', created: Date.now(), prompt: 'not B\'s', media: '', error: '', note: '' })) t.set(k, v);
      ya.insert(0, [t]);
    });
    let polls = 0;
    const count = q => { if (q.url().includes('job-nodev')) polls++; };
    A.page.on('request', count);
    // what OpenRouter would answer for another account's job (assumed: not found), so a poll would mark it failed
    await B.page.route(u => u.href.includes('/videos/job-nodev'), r => r.fulfill({ status: r.request().method() === 'OPTIONS' ? 204 : 404, headers: cors }));
    await until(async () => (secOf((await stored(B.page)).project, sid)?.takes || []).some(t => t.id === 't-nodev'), 6000);
    await B.page.evaluate(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); await new Promise(r => { const p = d.transaction('settings', 'readwrite').objectStore('settings').put('sk-or-v1-collab-check-not-a-key', 'apiKey'); p.onsuccess = r; }); });
    B.page.on('request', count);
    await B.page.reload(); await B.page.waitForSelector('.card'); await until(async () => (await chip(B.page)) === 'Synced');
    await sleep(4500);   // the first poll runs 2.5 s after the project opens
    const st = takeIn(ys, 't-nodev')?.get('status'), bSt = (secOf((await stored(B.page)).project, sid)?.takes || []).find(t => t.id === 't-nodev')?.status;
    check('nobody polls a take without `dev` in a room, and its status stays "pending" everywhere', polls === 0 && st === 'pending' && bSt === 'pending', `requests ${polls}, room ${st}, B ${bSt}`);
    A.page.off('request', count); B.page.off('request', count); await B.page.unroute(u => u.href.includes('/videos/job-nodev')).catch(() => {});
    rc.done();
  }

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
  await B.page.click('#leaveb'); await sleep(100);
  check('Leave asks for a second tap first (still in the room)', await B.page.evaluate(() => document.getElementById('leaveb').textContent === 'Tap again to leave') && (await chip(B.page)) !== '');
  await B.page.click('#leaveb'); await sleep(200);
  check('after leaving: Join is back in the bar and has the focus, no bubbles', await B.page.evaluate(() => document.activeElement?.id === 'joinb' && document.getElementById('leaveb').hidden && document.getElementById('presence').hidden));
  await A.page.locator('.card').nth(0).click(); await A.page.click('#f-title'); await A.page.keyboard.press('End'); await A.page.keyboard.type(' after B left'); await A.page.evaluate(() => document.activeElement.blur());
  await sleep(800); await B.page.reload(); await B.page.waitForSelector('.card'); await sleep(600);
  check('leave: B keeps its copy, no chip, and no longer receives edits', JSON.stringify(await cards(B.page)) === JSON.stringify(bKeep) && (await chip(B.page)) === '' && !(await B.page.evaluate(() => performance.getEntriesByType('resource').some(e => /collab\.js/.test(e.name)))), (await cards(B.page))[0]);
  check('C (still in the room) gets the edit made after B left', await until(async () => (await cards(C.page))[0]?.endsWith(' after B left')));

  /* ---- layout with the indicator, its panel and presence: 1920 to 820 ---- */
  const widths = [1920, 1440, 1280, 1100, 900, 820], over = [];
  // every state's label, longest included, in the hover label and the open panel (the text is set directly here; the states themselves are checked above)
  const states = [['synced', 'Synced', 'ok'], ['offline', 'Offline, changes will sync', 'off'], ['rejected', "Can't reach the room", 'err'], ['synced', 'Synced, 2 files not shared', 'off']];
  for (const [st, label, k] of states) for (const w of widths) {
    await A.page.setViewportSize({ width: w, height: 900 });
    await A.page.click('#mstat');
    await A.page.evaluate(([st, label, k]) => { const b = document.getElementById('mstat'); b.dataset.state = st; b.dataset.k = k; document.getElementById('mhead').textContent = label; const l = document.getElementById('mlabel'); l.textContent = label; l.style.visibility = 'visible'; dispatchEvent(new Event('resize')); }, [st, label, k]);
    await sleep(120);
    const o = await A.page.evaluate(() => { const p = document.getElementById('mpanel').getBoundingClientRect(), l = document.getElementById('mlabel').getBoundingClientRect(); return Math.max(document.documentElement.scrollWidth - innerWidth, -Math.min(p.left, l.left), Math.max(p.right, l.right) - innerWidth); });
    if (o > 0) over.push(`${st}@${w}:${o}`);
    await A.page.keyboard.press('Escape'); await A.page.evaluate(() => document.getElementById('mlabel').style.removeProperty('visibility'));
  }
  await A.page.setViewportSize({ width: 1440, height: 900 });
  check('no horizontal overflow 1920 to 820 px with collaboration on (indicator label and open panel included)', !over.length, over.join(' ') || widths.join(','));

  /* ---- a first visit through an invite link, join cancelled: the example opens, the app isn't left empty ---- */
  {
    const D = await newPage('D');
    await D.page.goto(room.link); await D.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 6000 });
    await D.page.click('#jCancel');
    const n = await until(async () => { const k = await D.page.evaluate(() => document.querySelectorAll('.card').length); return k === exampleBefore ? k : 0; }, 6000);
    check('first visit, join cancelled at the name step: the example project opens', n === exampleBefore, `${n || 0}/${exampleBefore} shots`);
    await D.ctx.close();
  }

  /* ---- the token never shows up where it shouldn't ---- */
  // snap Chromium can't write downloads to /tmp: read the blob the app hands to its download link instead
  await A.page.evaluate(() => { const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) fetch(this.href).then(r => r.text()).then(t => { window.__export = t; }); else click.call(this); }; });
  await A.page.click('#exportb'); await A.page.click('#expGo');
  const exp = await until(() => A.page.evaluate(() => window.__export || ''));
  check('export: a .cueboard.json without the token or room id', exp.includes('"format":"cueboard"') && !tokens.some(t => exp.includes(t)) && !exp.includes(room.room));

  /* ---- the media reference check (mediaInUse), on its own: other projects count, the skipped one doesn't ---- */
  {
    // the three one-line functions, from index.html as served, run here with no app around them (projects, cur: the defaults)
    const html = readFileSync(join(root, 'index.html'), 'utf8'), fn = n => new RegExp(`^function ${n}\\(.*$`, 'm').exec(html)?.[0] || '';
    const mediaInUse = new Function(`const projects = [], cur = null; ${fn('sectionMediaIds')} ${fn('projectMediaIds')} ${fn('mediaInUse')} return typeof mediaInUse === 'function' ? mediaInUse : () => 'missing';`)();
    const r = [
      mediaInUse('m1', 'p1', [{ id: 'p1', refs: ['m1'] }]),
      mediaInUse('m1', 'p1', [{ id: 'p1', refs: ['m1'] }, { id: 'p2', sections: [{ img: '', takes: [{ media: 'm1' }] }] }]),
      mediaInUse('m2', null, [null, { id: 'p1', sections: [{ key: 'm2' }] }]),
      mediaInUse('m2', null, [{ id: 'p1', sections: [{ endKey: 'm2' }] }]),
      mediaInUse('m3', null, [{ id: 'p1', refs: ['m1'], sections: [{ img: 'm2', takes: [] }] }]),
      mediaInUse('m-nobody-has', 'x'),
    ];
    check('mediaInUse: only the skipped project uses it -> no; another project\'s take, a key, an end frame -> yes; unused -> no', JSON.stringify(r) === '[false,true,true,true,false,false]', JSON.stringify(r));
  }

  /* ---- A leaves, joins again as a new project (same files, so the same local ids), deletes that one: the first keeps its media ---- */
  {
    const ids = p => [...new Set([...(p?.refs || []), ...(p?.sections || []).flatMap(s => [s.img, s.key, s.endKey, ...(s.takes || []).map(t => t.media)])])].filter(x => x && !x.startsWith('sha256-'));
    const first = await stored(A.page), pIds = ids(first.project);
    await menu(A.page, 'leave'); await sleep(400);
    await menu(A.page, 'join'); await A.page.fill('#jLink', room.link); await A.page.click('#jGo');
    await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 }); await A.page.click('#jNew');
    await until(async () => (await chip(A.page)) === 'Synced', 9000);
    const second = await until(async () => { const s = await stored(A.page); return s.pid && s.pid !== first.pid && s.project ? s : null; }, 6000);
    const shared = pIds.filter(id => ids(second?.project).includes(id));
    await A.page.click('#moreb'); await A.page.click('#delp'); await A.page.click('#delp');
    const gone = await until(async () => !(await stored(A.page, second?.pid)).project, 6000); await sleep(800);
    const lost = []; for (const id of pIds) if (!(await hasBlob(A.page, id))) lost.push(id);
    const kept = !!(await stored(A.page, first.pid)).project;
    check('leave, rejoin as a new project, delete it: the first project keeps every media file the two shared',
      pIds.length > 0 && shared.length > 0 && gone && kept && !lost.length, `${pIds.length} files, ${shared.length} shared with the rejoined project, deleted ${!!gone}, first project kept ${kept}, files lost ${lost.length}`);
  }

  /* ---- a project imported mid-render from another device or origin (a foreign `dev`), no room: its take is still polled ---- */
  {
    const E = await newPage('E'); let polls = 0;
    await E.page.goto(app); await E.page.waitForSelector('.card');
    await E.page.evaluate(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); await new Promise(r => { const p = d.transaction('settings', 'readwrite').objectStore('settings').put('sk-or-v1-collab-check-not-a-key', 'apiKey'); p.onsuccess = r; }); });
    await E.page.route(u => u.href.includes('/videos/job-foreign'), r => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      polls++; return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'job-foreign', status: 'in_progress' }) });
    });
    await E.page.reload(); await E.page.waitForSelector('.card'); await sleep(400);
    const take = { id: 't-foreign', jobId: 'job-foreign', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 4, audio: false, seed: '', prompt: 'from elsewhere', start: false, end: false, est: 0.2, cost: null, status: 'pending', created: Date.now(), media: '', error: '', note: '', dev: 'd-another-device' };
    const project = { id: 'p-foreign', title: 'Imported mid-render', created: Date.now(), updated: Date.now(), song: null, sections: [{ id: 's-foreign', start: 0, title: 'One', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', takes: [take] }] };
    await E.page.setInputFiles('#importf', { name: 'foreign.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'cueboard', version: 1, project, media: {} })) });
    await until(() => polls > 0, 8000);
    const st = await until(async () => (secOf((await stored(E.page, 'p-foreign')).project, 's-foreign')?.takes || [])[0]?.status, 3000);
    check('imported take with another device\'s `dev`, project in no room: polled here, not left "Rendering" forever', polls > 0 && st && st !== 'failed', `polls ${polls}, status ${st}`);
    await E.ctx.close();
  }
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
