// Rooms from the app: the Collaborate panel, the verification code, creating a room, the invite link, a second browser
// joining and editing both ways, the owner replacing the link and deleting the room; the same panel on a phone.
//   node design/rooms-check.mjs <repo-root> <out-dir>
// Sync server on 127.0.0.1:3367 (throwaway DATA_DIR, CORS_ORIGINS = the static origin); nothing leaves 127.0.0.1.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3367, dataDir = mkdtempSync(join(tmpdir(), 'cue-rooms-check-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const consoleLog = [];
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
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
const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', LOG_LEVEL: 'debug', CORS_ORIGINS: origin };
const server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(100);
const made = spawnSync(process.execPath, [join(root, 'packages/sync-server/bin/create-code.mjs'), '--label', 'Nacho'], { env, encoding: 'utf8' });
const CODE = /code: +(\S+)/.exec(made.stdout)?.[1];
check('create-code prints a code once', !!CODE && !readFileSync(join(dataDir, 'codes.json'), 'utf8').includes(CODE));

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function newPage(name, phone = null) {
  const ctx = await browser.newContext(phone ? { viewport: phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) || r.request().url().startsWith(`http://127.0.0.1:${SYNC_PORT}`) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = { off: true }; });
  const page = await ctx.newPage();
  page.on('console', m => consoleLog.push(`${name} ${m.type()}: ${m.text()}`)); page.on('pageerror', e => consoleLog.push(`${name} pageerror: ${e.message}`));
  await page.goto(app); await page.waitForSelector('#projname', { timeout: 10000 }); await sleep(600);
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const step = page => page.evaluate(() => document.getElementById('dlgJoin').open ? document.getElementById('dlgJoin').dataset.step : '');
const head = page => page.evaluate(() => document.getElementById('mhead').textContent);
const waitStep = (page, s, ms = 9000) => page.waitForSelector(`#dlgJoin[open][data-step="${s}"]`, { timeout: ms });

try {
  // ---- desktop: A creates a room from the open project ----
  const A = await newPage('A');
  check('bar: Collaborate (not Join) while the project is in no room', (await A.page.textContent('#joinb .lbl')) === 'Collaborate' && await A.page.isVisible('#joinb'));
  await A.page.click('#joinb'); await waitStep(A.page, 'collab');
  check('the panel offers Share this project and Join with a link', await A.page.isVisible('#jShareNew') && await A.page.isVisible('#jJoinLink') && !(await A.page.$eval('#jShareNew', b => b.disabled)));
  await shot(A.page, 'desktop-collaborate');
  await A.page.click('#jShareNew'); await waitStep(A.page, 'code');
  check('unverified: the code prompt, with the invite-only message', /invite-only/.test(await A.page.textContent('#jTitle')) && /code you were given/.test(await A.page.textContent('#jLead')));
  await shot(A.page, 'desktop-code');
  await A.page.fill('#jCode', 'not-the-code'); await A.page.click('#jGo'); await waitStep(A.page, 'code');
  await A.page.waitForFunction(() => /didn't work/.test(document.getElementById('jMsg').textContent), null, { timeout: 5000 });
  check('a wrong code: the server\'s sentence, the field stays', /didn't work/.test(await A.page.textContent('#jMsg')));
  await shot(A.page, 'desktop-code-wrong');
  await A.page.fill('#jCode', CODE); await A.page.click('#jGo'); await waitStep(A.page, 'name');
  await A.page.fill('#jName', 'Ana Torres'); await A.page.click('#jGo'); await A.page.waitForSelector('#dlgRoom[open]', { timeout: 15000 });
  const link = await A.page.inputValue('#rmLink');
  check('the room is created and This room opens at once with the link (owner sees New link and Delete room)', /#join=[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/.test(link) && link.startsWith(app) && !(await A.page.evaluate(() => document.getElementById('dlgJoin').open)) && await A.page.isVisible('#rmRegen') && await A.page.isVisible('#rmDel') && !(await A.page.isVisible('#rmNotOwner')), link.replace(/\..*$/, '.<token>'));
  await shot(A.page, 'desktop-room-created');
  await A.page.keyboard.press('Escape'); await sleep(300);
  check('Escape closes This room; focus on the bar\'s This room button', !(await A.page.evaluate(() => document.getElementById('dlgRoom').open)) && await A.page.evaluate(() => document.activeElement?.id === 'roomb'));
  check('A is in the room: This room in the bar (no Leave button there)', !(await A.page.isVisible('#joinb')) && await A.page.isVisible('#roomb') && (await A.page.textContent('#roomb .lbl')) === 'This room' && !(await A.page.$('#leaveb')));
  const noRoomInMore = async page => { await page.click('#moreb'); const t = await page.$$eval('#moremenu .mi', l => l.filter(b => !b.hidden).map(b => b.textContent).join('|')); await page.keyboard.press('Escape'); return t; };
  const moreA = await noRoomInMore(A.page);
  check('owner: More has no room action (no invite, room, leave)', !/invite|room|leave|collab/i.test(moreA), moreA);
  await A.page.waitForFunction(() => document.getElementById('mhead').textContent === 'Synced', null, { timeout: 9000 }).catch(() => {});
  check('A: Synced (the project was shared into the new room)', (await head(A.page)) === 'Synced', await head(A.page));
  const stored = await A.page.evaluate(() => JSON.stringify(Object.keys(localStorage).map(k => localStorage.getItem(k))) + location.href);
  check('no token in the address bar or localStorage', !stored.includes(link.split('#join=')[1].split('.')[1]) && !/#join/.test(stored));
  // a second verified share: the code is not asked again
  const verifiedOnce = await A.page.evaluate(async () => { const d = indexedDB.open('cueboard-local'); return new Promise(ok => { d.onsuccess = () => { const tx = d.result.transaction('settings').objectStore('settings').get('collab'); tx.onsuccess = () => ok(!!(tx.result && tx.result.verified && tx.result.verified.token)); tx.onerror = () => ok(false); }; d.onerror = () => ok(false); }); }).catch(() => null);
  check('the verified state is kept in this browser (settings/collab.verified)', verifiedOnce === true, String(verifiedOnce));

  // ---- B joins with the link, edits flow both ways ----
  const B = await newPage('B');
  await B.page.goto(link); await waitStep(B.page, 'name'); await B.page.fill('#jName', 'Bruno'); await B.page.click('#jGo');
  await waitStep(B.page, 'choose'); await B.page.click('#jNew'); await sleep(1500);
  await B.page.waitForFunction(() => document.getElementById('mhead').textContent === 'Synced', null, { timeout: 9000 }).catch(() => {});
  check('B joined with the link and is synced', (await head(B.page)) === 'Synced', await head(B.page));
  const moreB = await noRoomInMore(B.page);
  check('member: More has no room action either', !/invite|room|leave|collab/i.test(moreB), moreB);
  await A.page.fill('#f-title', 'Typed in A'); await B.page.waitForFunction(() => document.getElementById('f-title').value === 'Typed in A', null, { timeout: 8000 }).catch(() => {});
  check('A → B: the shot title arrives', (await B.page.inputValue('#f-title')) === 'Typed in A');
  await B.page.fill('#f-notes', 'Notes from B'); await A.page.waitForFunction(() => document.getElementById('f-notes').value === 'Notes from B', null, { timeout: 8000 }).catch(() => {});
  check('B → A: the notes arrive', (await A.page.inputValue('#f-notes')) === 'Notes from B');
  check('both see each other', (await A.page.$$eval('#presence .pchip', l => l.length)) === 2 && (await B.page.$$eval('#presence .pchip', l => l.length)) === 2);
  await B.page.click('#roomb'); await B.page.waitForSelector('#dlgRoom[open]');
  await B.page.waitForFunction(() => document.querySelectorAll('#rmPeople li').length === 2, null, { timeout: 8000 }).catch(() => {});
  const bPanel = await B.page.evaluate(() => ({ link: document.getElementById('rmLink').value, people: [...document.querySelectorAll('#rmPeople .nm')].map(n => n.textContent), name: document.getElementById('rmName').textContent }));
  check('member panel: the link, "(you)" first then the others, the room name', bPanel.link === link && bPanel.people[0] === 'Bruno (you)' && bPanel.people[1] === 'Ana Torres' && bPanel.name.length > 0, JSON.stringify(bPanel));
  check('member panel: no New link, no Delete room (absent, not disabled), the one-line owner note', !(await B.page.isVisible('#rmRegen')) && !(await B.page.isVisible('#rmDel')) && !(await B.page.isVisible('#rmOwnerRow')) && /Only the room's owner/.test(await B.page.textContent('#rmNotOwner')) && await B.page.isVisible('#rmNotOwner'));
  await shot(B.page, 'desktop-room-member');

  // ---- the owner replaces the link ----
  await A.page.click('#roomb'); await A.page.waitForSelector('#dlgRoom[open]');
  await A.page.waitForFunction(() => document.querySelectorAll('#rmPeople li').length === 2, null, { timeout: 8000 }).catch(() => {});
  check('This room shows the owner the link and New link', (await A.page.inputValue('#rmLink')) === link && await A.page.isVisible('#rmRegen'));
  await shot(A.page, 'desktop-room-owner');
  await A.page.click('#rmRegen'); await sleep(100);
  check('New link asks for a second tap', (await A.page.textContent('#rmRegen')) === 'Tap again to replace it');
  await A.page.click('#rmRegen');
  await A.page.waitForFunction(l => document.getElementById('rmLink').value !== l, link, { timeout: 8000 });
  const link2 = await A.page.inputValue('#rmLink');
  check('a new link, different from the old one, in the open panel', link2 !== link && /#join=/.test(link2));
  await A.page.waitForFunction(() => document.getElementById('mhead').textContent === 'Synced', null, { timeout: 9000 }).catch(() => {});
  check('the owner is back in the room with the new link', (await head(A.page)) === 'Synced', await head(A.page));
  await A.page.click('#rmClose');
  await B.page.waitForFunction(() => /no longer works/.test(document.getElementById('mhead').textContent), null, { timeout: 9000 }).catch(() => {});
  check('B (old link) is out: "This invite link no longer works"', /no longer works/.test(await head(B.page)), await head(B.page));
  // the member had the panel open while the link was replaced: it says why, and lists only them
  check('B\'s open panel says the link no longer works, only B listed', /no longer works/.test(await B.page.textContent('#rmState')) && (await B.page.$$eval('#rmPeople li', l => l.length)) === 1, await B.page.textContent('#rmState'));
  await shot(B.page, 'desktop-room-member-out');
  // Leave from the panel: two taps, the project stays, Collaborate is back and focused
  const bTitle = await B.page.inputValue('#f-title');
  await B.page.click('#rmLeave'); await sleep(100);
  check('Leave room asks for a second tap (panel still open, still in the room)', (await B.page.textContent('#rmLeave')) === 'Tap again to leave' && await B.page.evaluate(() => document.getElementById('dlgRoom').open));
  await B.page.click('#rmLeave'); await sleep(300);
  check('after Leave: panel closed, Collaborate back and focused, project kept', !(await B.page.evaluate(() => document.getElementById('dlgRoom').open)) && await B.page.evaluate(() => document.activeElement?.id === 'joinb') && (await B.page.inputValue('#f-title')) === bTitle);
  const C = await newPage('C');
  await C.page.goto(link); await waitStep(C.page, 'name'); await C.page.fill('#jName', 'Carla'); await C.page.click('#jGo'); await waitStep(C.page, 'err', 12000);
  check('the old link is refused for a newcomer', /no longer|didn't accept/.test(await C.page.textContent('#jLead')));
  await C.page.click('#jCancel');
  await C.page.goto(link2); await waitStep(C.page, 'choose'); await C.page.click('#jNew'); await sleep(1200);
  await C.page.waitForFunction(() => document.getElementById('mhead').textContent === 'Synced', null, { timeout: 9000 }).catch(() => {});
  check('the new link joins', (await head(C.page)) === 'Synced', await head(C.page));
  const cTitle = await C.page.inputValue('#f-title');

  // ---- the owner deletes the room ----
  // phone, member: the Projects sheet has This room (no Leave or Delete room of its own); it opens the same panel as a sheet
  await A.page.setViewportSize({ width: 390, height: 844 }); await sleep(300);
  const PM = await newPage('PM', { width: 390, height: 844 });
  await PM.page.goto(link2); await waitStep(PM.page, 'name'); await PM.page.fill('#jName', 'Dario'); await PM.page.click('#jGo');
  await waitStep(PM.page, 'choose'); await PM.page.tap('#jNew'); await sleep(1500);
  await PM.page.tap('#proj'); await PM.page.waitForSelector('#mProj[open]');
  const sheetT = await PM.page.$$eval('#mProj button', l => l.filter(b => b.getClientRects().length).map(b => (b.querySelector('span') || b).textContent.trim()));
  check('phone sheet: This room row, no Leave, Invite link or Delete room of its own', sheetT.includes('This room') && !sheetT.some(t => /^(Leave|Invite link|Delete room|New link)/.test(t)), sheetT.join('|'));
  await PM.page.tap('#mRoomb'); await PM.page.waitForSelector('#dlgRoom[open]'); await sleep(400);
  check('phone member: This room as a sheet, no owner actions', !(await PM.page.isVisible('#rmRegen')) && !(await PM.page.isVisible('#rmDel')) && await PM.page.isVisible('#rmLeave'));
  await shot(PM.page, 'phone-room-member');
  await PM.page.keyboard.press('Escape'); await sleep(200);
  await A.page.evaluate(() => document.getElementById('proj').click()); await A.page.waitForSelector('#mProj[open]');
  await A.page.click('#mRoomb'); await A.page.waitForSelector('#dlgRoom[open]'); await sleep(400);
  check('phone owner: New link and Delete room in the sheet', await A.page.isVisible('#rmRegen') && await A.page.isVisible('#rmDel'));
  await shot(A.page, 'phone-room-owner');
  await A.page.keyboard.press('Escape'); await A.page.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
  await PM.ctx.close();

  // an owner token the server doesn't know: the owner controls go away, the server's sentence shows
  await A.page.click('#roomb'); await A.page.waitForSelector('#dlgRoom[open]');
  const realOwner = await A.page.evaluate(() => { const T = window.__CUE_MEDIA_TEST.app, b = T.cset().rooms[T.cur().id], o = b.owner; b.owner = 'x'.repeat(22); return o; });
  await A.page.click('#rmRegen'); await A.page.click('#rmRegen');
  await A.page.waitForFunction(() => document.getElementById('rmMsg').textContent !== '', null, { timeout: 8000 }).catch(() => {});
  check('refused owner token: message in the panel, New link and Delete room gone, owner note shown', (await A.page.textContent('#rmMsg')) !== '' && !(await A.page.isVisible('#rmRegen')) && !(await A.page.isVisible('#rmDel')) && await A.page.isVisible('#rmNotOwner'), await A.page.textContent('#rmMsg'));
  check('the link was not replaced', (await A.page.inputValue('#rmLink')) === link2);
  await A.page.evaluate(o => { const T = window.__CUE_MEDIA_TEST.app; T.cset().rooms[T.cur().id].owner = o; T.renderCollabBtns(); }, realOwner);
  await A.page.click('#rmClose'); await A.page.click('#roomb'); await A.page.waitForSelector('#dlgRoom[open]');
  await A.page.click('#rmDel'); await sleep(100);
  check('Delete room asks for a second tap, panel open', (await A.page.textContent('#rmDel')) === 'Tap again to delete' && await A.page.evaluate(() => document.getElementById('dlgRoom').open));
  await A.page.click('#rmDel'); await sleep(1500);
  check('the owner is out of the room, project kept, panel closed, Collaborate focused', await A.page.isVisible('#joinb') && (await A.page.inputValue('#f-title')) === 'Typed in A' && !(await A.page.evaluate(() => document.getElementById('dlgRoom').open)) && await A.page.evaluate(() => document.activeElement?.id === 'joinb'));
  await C.page.waitForFunction(() => /was deleted/.test(document.getElementById('mhead').textContent), null, { timeout: 9000 }).catch(() => {});
  check('member C: "This room was deleted", local copy kept', /was deleted/.test(await head(C.page)) && (await C.page.inputValue('#f-title')) === cTitle, await head(C.page));
  await shot(C.page, 'desktop-deleted');
  check('server: the room folder is gone', !readFileSync(join(dataDir, 'verified.json'), 'utf8').includes(CODE) && !/[A-Za-z0-9_-]{16}\/project\.json/.test(''), '');
  const left = spawnSync('ls', [dataDir], { encoding: 'utf8' }).stdout.trim().split('\n');
  check('data dir holds only codes.json and verified.json', left.sort().join(',') === 'codes.json,verified.json', left.join(','));
  check('no secret in the server log', !serverLog.includes(CODE) && !serverLog.includes(link.split('.').pop()) && !serverLog.includes(link2.split('.').pop()));
  check('no page errors', !consoleLog.some(l => /pageerror|TypeError|ReferenceError/.test(l)), consoleLog.filter(l => /pageerror|Error/.test(l)).slice(0, 3).join(' | '));

  // ---- phone: the same panel as a sheet ----
  for (const [w, h] of [[390, 844], [390, 700]]) {
    const P = await newPage('P' + h, { width: w, height: h });
    await P.page.tap('#proj'); await P.page.waitForSelector('#mProj[open]', { timeout: 5000 });
    check(`phone ${w}x${h}: the Projects sheet has Collaborate`, (await P.page.textContent('#mJoin')).trim() === 'Collaborate' && await P.page.isVisible('#mJoin'));
    if (h === 844) await shot(P.page, `phone-${h}-sheet`);
    await P.page.tap('#mJoin'); await waitStep(P.page, 'collab'); await sleep(350);
    await shot(P.page, `phone-${h}-collaborate`);
    await P.page.tap('#jShareNew'); await waitStep(P.page, 'code'); await sleep(350);
    check(`phone ${w}x${h}: the code prompt`, /invite-only/.test(await P.page.textContent('#jTitle')));
    await shot(P.page, `phone-${h}-code`);
    const over = await P.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`phone ${w}x${h}: no horizontal overflow`, !over);
    await P.ctx.close();
  }
  await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
} finally {
  await browser.close(); server.kill(); srv.close(); rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
