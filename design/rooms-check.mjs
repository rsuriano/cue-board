// Rooms from the app: the Collaborate panel, the $9 step when logged out, Have a code, the magic link logging in,
// creating a room, the invite link, a second browser joining and editing both ways, the owner replacing the link and
// deleting the room; the same panel on a phone.
//   node design/rooms-check.mjs <repo-root> <out-dir>
// Auth on 127.0.0.1:3366 and the sync server on 3367 (throwaway data dirs, CORS_ORIGINS = the static origin); nothing
// leaves 127.0.0.1.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createPrivateKey, sign } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3367, AUTH_PORT = 3366, BUY = 'https://bedrock.lemonsqueezy.example/buy/cue', dataDir = mkdtempSync(join(tmpdir(), 'cue-rooms-check-')), authDir = mkdtempSync(join(tmpdir(), 'cue-rooms-auth-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const consoleLog = [];
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="ws://127.0.0.1:${SYNC_PORT}">`)
      .replace('<meta name="cue-auth-url" content="">', `<meta name="cue-auth-url" content="http://127.0.0.1:${AUTH_PORT}">`).replace('<meta name="cue-buy-url" content="">', `<meta name="cue-buy-url" content="${BUY}">`);
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
// auth (packages/auth) first: it makes the signing key the sync server checks sessions with. No Resend or Lemon Squeezy
// key: emails are off, so the check opens the session the way an emailed link would (?key=<ticket>, signed here)
const authEnv = { ...process.env, PORT: String(AUTH_PORT), DATA_DIR: authDir, SESSION_KEY_FILE: join(authDir, 'session.key'), LOG_LEVEL: 'debug', CORS_ORIGINS: origin };
const auth = spawn(process.execPath, [join(root, 'packages/auth/src/main.mjs')], { env: authEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let authLog = ''; auth.stdout.on('data', d => { authLog += d; }); auth.stderr.on('data', d => { authLog += d; });
for (let i = 0; i < 50 && !/listening/.test(authLog); i++) await sleep(100);
const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', LOG_LEVEL: 'debug', CORS_ORIGINS: origin, AUTH_PUBLIC_KEY_FILE: join(authDir, 'session.key.pub') };
const server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(100);
const made = spawnSync(process.execPath, [join(root, 'packages/auth/bin/create-code.mjs'), '--label', 'Nacho'], { env: authEnv, encoding: 'utf8' });
const CODE = /code: +(\S+)/.exec(made.stdout)?.[1], CODE_ID = /id: +(\S+)/.exec(made.stdout)?.[1];
check('auth create-code prints a code once', !!CODE && !readFileSync(join(authDir, 'codes.json'), 'utf8').includes(CODE));
const signTok = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + sign(null, Buffer.from(b), createPrivateKey(readFileSync(join(authDir, 'session.key')))).toString('base64url'); };
const TICKET = signTok({ typ: 'ticket', sub: 'ana@example.com', prd: 'cue-board', code: CODE_ID, exp: Date.now() + 3600_000 });

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function newPage(name, phone = null) {
  const ctx = await browser.newContext(phone ? { viewport: phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) || r.request().url().startsWith(`http://127.0.0.1:${SYNC_PORT}`) || r.request().url().startsWith(`http://127.0.0.1:${AUTH_PORT}`) ? r.continue() : r.abort()));
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
  // ---- Log in by pasting (the link opened in another browser, or in Safari instead of the home-screen app): a login
  // link, a bare ticket, a license key. Auth here has no Lemon Squeezy, so the license key's answer is faked ----
  const L = await newPage('L'), LICENSE = '38B1460A-5104-4067-A91D-77B872934D51', sentKeys = [];
  await L.ctx.route(`http://127.0.0.1:${AUTH_PORT}/session`, r => {
    const b = JSON.parse(r.request().postData() || '{}'); if (b.key) sentKeys.push(b.key);
    return b.key === LICENSE ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify({ session: TICKET, email: 'buyer@example.com' }) }) : r.continue();
  });
  const acct = () => L.page.evaluate(() => localStorage.getItem('cue.account') || '');
  const pasteLogin = async (text, viaPay) => {
    await L.page.evaluate(() => localStorage.removeItem('cue.account'));
    await L.page.click('#joinb'); await waitStep(L.page, 'collab');
    if (viaPay) { await L.page.click('#jShareNew'); await waitStep(L.page, 'pay'); await L.page.click('#jLogin'); } else await L.page.click('#jLogin2');
    await waitStep(L.page, 'login'); await L.page.fill('#jEmail', text); await L.page.click('#jGo');
    await L.page.waitForFunction(() => !!localStorage.getItem('cue.account'), null, { timeout: 8000 }).catch(() => {}); await sleep(200);
  };
  await L.page.click('#joinb'); await waitStep(L.page, 'collab'); await L.page.click('#jLogin2'); await waitStep(L.page, 'login');
  check('Log in says a link that opened elsewhere can be pasted', /paste the link/i.test(await L.page.textContent('#jLead')), await L.page.textContent('#jLead'));
  await L.page.fill('#jEmail', 'not a link'); await L.page.click('#jGo');
  check('Log in: neither an email nor a link is caught in the app', /paste the link/i.test(await L.page.textContent('#jMsg')), await L.page.textContent('#jMsg'));
  await L.page.click('#jCancel');
  await pasteLogin(`${app}?key=${TICKET}`);
  check('pasting the login link into Log in logs in (dialog closed)', /ana@example\.com/.test(await acct()) && !(await L.page.evaluate(() => document.getElementById('dlgJoin').open)));
  await pasteLogin(TICKET);
  check('pasting the bare ticket logs in', /ana@example\.com/.test(await acct()));
  await pasteLogin(LICENSE, true);
  check('pasting a license key from the $9 step logs in and goes on to the name step', /buyer@example\.com/.test(await acct()) && sentKeys.at(-1) === LICENSE && (await step(L.page)) === 'name', await step(L.page));
  await L.page.click('#jCancel'); await L.ctx.close();

  // ---- desktop: A creates a room from the open project ----
  const A = await newPage('A');
  check('bar: Collaborate (not Join) while the project is in no room', (await A.page.textContent('#joinb .lbl')) === 'Collaborate' && await A.page.isVisible('#joinb'));
  await A.page.click('#joinb'); await waitStep(A.page, 'collab');
  check('the panel offers Share this project and Join with a link', await A.page.isVisible('#jShareNew') && await A.page.isVisible('#jJoinLink') && !(await A.page.$eval('#jShareNew', b => b.disabled)));
  await shot(A.page, 'desktop-collaborate');
  check('logged out: the panel offers Log in', /^Log in$/.test((await A.page.textContent('#jAcct')).trim()) && await A.page.isVisible('#jAcct'));
  await A.page.click('#jShareNew'); await waitStep(A.page, 'pay');
  check('logged out: one step, "Live collab, $9 once", Buy (the checkout link), Log in, Have a code',
    /\$9 once/.test(await A.page.textContent('#jTitle')) && (await A.page.getAttribute('#jBuy', 'href')) === BUY && await A.page.isVisible('#jLogin') && await A.page.isVisible('#jHaveCode'));
  await shot(A.page, 'desktop-pay');
  await A.page.click('#jHaveCode'); await waitStep(A.page, 'code');
  check('Have a code: email and code', await A.page.isVisible('#jEmail') && await A.page.isVisible('#jCode'));
  await A.page.click('#jGo');
  check('an empty email is caught in the app', /email/.test(await A.page.textContent('#jMsg')));
  await A.page.fill('#jEmail', 'ana@example.com'); await A.page.fill('#jCode', CODE); await A.page.click('#jGo'); await waitStep(A.page, 'err');
  check('auth answers (email is off here): its sentence, nothing breaks', /set up/.test(await A.page.textContent('#jLead')), await A.page.textContent('#jLead'));
  await shot(A.page, 'desktop-code-sent');
  await A.page.click('#jCancel');
  // the emailed link: ?key=<ticket> opens the session and leaves the address bar
  await A.page.goto(app + '?key=' + TICKET); await A.page.waitForFunction(() => !!localStorage.getItem('cue.account'), null, { timeout: 8000 }).catch(() => {});
  check('the magic link logs in and drops the key from the address bar', !A.page.url().includes('key=') && /ana@example\.com/.test(await A.page.evaluate(() => localStorage.getItem('cue.account') || '')), A.page.url());
  // the daily check runs out while the name step waits: a session auth checked 24h minus 4s ago is fresh at "Checking
  // your account" and refused by the sync server once the name is typed; the app renews it once and creates the room
  const due = Date.now() - 24 * 3600_000 + 4000, NEAR = signTok({ typ: 'session', sub: 'ana@example.com', prd: 'cue-board', src: 'invite:Nacho', exp: Date.now() + 365 * 24 * 3600_000, chk: due });
  await A.page.evaluate(s => localStorage.setItem('cue.account', JSON.stringify({ session: s, email: 'ana@example.com' })), NEAR);
  await A.page.click('#joinb'); await waitStep(A.page, 'collab');
  check('logged in: "Logged in as" with Log out', /Logged in as ana@example\.com/.test(await A.page.textContent('#jAcct')) && await A.page.isVisible('#jLogout'));
  await A.page.click('#jShareNew'); await waitStep(A.page, 'name');
  await sleep(Math.max(0, due + 24 * 3600_000 + 500 - Date.now()));
  await A.page.fill('#jName', 'Ana Torres'); await A.page.click('#jGo'); await A.page.waitForSelector('#dlgRoom[open]', { timeout: 15000 }).catch(() => {});
  check('a session whose daily check ran out at the name step still creates the room (renewed once)', await A.page.evaluate(() => document.getElementById('dlgRoom').open) && /create refused: no session/.test(serverLog) && !(await A.page.evaluate(() => localStorage.getItem('cue.account'))).includes(NEAR));
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
  const left = spawnSync('ls', [dataDir], { encoding: 'utf8' }).stdout.trim();
  check('server: the room folder is gone (the data dir is empty)', left === '', left);
  check('no secret in the server or auth log', ![CODE, TICKET, 'ana@example.com', link.split('.').pop(), link2.split('.').pop()].some(s => serverLog.includes(s) || authLog.includes(s)));
  check('no page errors', !consoleLog.some(l => /pageerror|TypeError|ReferenceError/.test(l)), consoleLog.filter(l => /pageerror|Error/.test(l)).slice(0, 3).join(' | '));

  // ---- phone: the same panel as a sheet ----
  for (const [w, h] of [[390, 844], [390, 700]]) {
    const P = await newPage('P' + h, { width: w, height: h });
    await P.page.tap('#proj'); await P.page.waitForSelector('#mProj[open]', { timeout: 5000 });
    check(`phone ${w}x${h}: the Projects sheet has Collaborate`, (await P.page.textContent('#mJoin')).trim() === 'Collaborate' && await P.page.isVisible('#mJoin'));
    if (h === 844) await shot(P.page, `phone-${h}-sheet`);
    await P.page.tap('#mJoin'); await waitStep(P.page, 'collab'); await sleep(350);
    await shot(P.page, `phone-${h}-collaborate`);
    await P.page.tap('#jShareNew'); await waitStep(P.page, 'pay'); await sleep(350);
    check(`phone ${w}x${h}: logged out, the $9 step`, /\$9 once/.test(await P.page.textContent('#jTitle')) && await P.page.isVisible('#jBuy'));
    await shot(P.page, `phone-${h}-pay`);
    const over = await P.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`phone ${w}x${h}: no horizontal overflow`, !over);
    await P.ctx.close();
  }
  await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
} finally {
  await browser.close(); server.kill(); auth.kill(); srv.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(authDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
