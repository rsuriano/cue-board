// Report a problem: the More entry (desktop) and the Projects sheet row (phone), the dialog by keyboard and focus
// return, Send to a real sync server (the stored file equals "See what will be sent"), a project full of secrets that
// never reaches the report, errors with tokens and invite links scrubbed, the offline and failed-send fallbacks
// (Copy report, Download report), no horizontal overflow, 16px inputs on the phone.
//   node design/report-check.mjs <repo-root> <out-dir>
// Sync server on 127.0.0.1:3360 (throwaway DATA_DIR, CORS_ORIGINS = the static origin); nothing leaves 127.0.0.1.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3360, DEAD_PORT = 3362, dataDir = mkdtempSync(join(tmpdir(), 'cue-report-check-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const consoleLog = [];
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
// ?sync=none: no sync server (the standalone copy) · ?sync=dead: a port nobody listens on
const srv = createServer((q, r) => {
  const [path, qs = ''] = q.url.split('?');
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) {
      const url = /sync=none/.test(qs) ? '' : `ws://127.0.0.1:${/sync=dead/.test(qs) ? DEAD_PORT : SYNC_PORT}`;
      body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="${url}">`).replace('<meta name="cue-build" content="">', '<meta name="cue-build" content="abc1234">');
    }
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, LOG_LEVEL: 'debug', CORS_ORIGINS: origin, REPORTS_PER_HOUR: '50' };
const server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(100);

// a project whose every string is a secret: none of them may reach a report
const SECRETS = ['Kestrel Midnight Title', 'shot-title-ostrich', 'notes about the walrus', 'prompt with a narwhal', 'lyrics of the pangolin', 'songfile-axolotl.mp3', 'take-name-quokka', 'sk-or-v1-feedfacecafebeef0123456789', 'Zebra Lane Room'];
const project = {
  id: 'p-secret', title: SECRETS[0], created: 1, updated: 1, song: { name: SECRETS[5], duration: 60 }, lyrics: SECRETS[4], refs: [],
  sections: [0, 12.5, 30].map((start, i) => ({ id: 's' + i, start, title: SECRETS[1], shot: 'wide', notes: SECRETS[2], img: '', imgPrompt: SECRETS[3], vidPrompt: SECRETS[3], key: '', endKey: '',
    takes: Array.from({ length: i }, (_, k) => ({ id: `t${i}${k}`, name: SECRETS[6], prompt: SECRETS[3], media: '' })) })),
};
const importFile = join(dataDir, 'secret.cueboard.json');
writeFileSync(importFile, JSON.stringify({ format: 'cueboard', version: 1, project, media: {} }));
// errors that carry an invite link, a token, a key and a query string
const ERR_JOIN = 'AbCdEf0123456789xyzQ', ERR_TOKEN = 'Tk9mZ3x0aGlzaXNhdG9rZW4', ERR_KEY = 'sk-or-v1-0011223344556677';

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function newPage(name, { phone = null, q = '' } = {}) {
  const ctx = await browser.newContext({ ...(phone ? { viewport: phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }), acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) || r.request().url().startsWith('http://127.0.0.1:33') ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = { off: true }; });
  const page = await ctx.newPage();
  page.on('console', m => consoleLog.push(`${name} ${m.type()}: ${m.text()}`)); page.on('pageerror', e => consoleLog.push(`${name} pageerror: ${e.message}`));
  await page.goto(app + q); await page.waitForSelector('#projname', { timeout: 10000 }); await sleep(500);
  await page.setInputFiles('#importf', { name: 'secret.cueboard.json', mimeType: 'application/json', buffer: readFileSync(importFile) });
  for (let i = 0; i < 50 && (await page.textContent('#projname')) !== SECRETS[0]; i++) await sleep(100);
  if ((await page.textContent('#projname')) !== SECRETS[0]) console.log('INFO import: projname=' + await page.textContent('#projname') + ' toast=' + await page.textContent('#toast'));
  await page.evaluate(([j, t, k]) => {
    setTimeout(() => { throw new Error(`boom at https://cue.example/#join=${j}.${t} with ${k}`); });
    Promise.reject(new Error(`fetch https://sync.example/r?token=${t}&x=1 failed for someone@example.com`));
  }, [ERR_JOIN, ERR_TOKEN, ERR_KEY]);
  await sleep(200);
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const mode = page => page.evaluate(() => { const d = document.getElementById('dlgReport'); return d.open ? d.dataset.mode : ''; });
const shown = async page => JSON.parse(await page.textContent('#rJson'));
const stored = () => { const d = join(dataDir, 'reports'); try { return readdirSync(d).map(n => ({ n, mode: statSync(join(d, n)).mode & 0o777, j: JSON.parse(readFileSync(join(d, n), 'utf8')) })); } catch { return []; } };
const strip = j => { const { id, received, ...rest } = j; return rest; };
const leaks = text => [...SECRETS, ERR_JOIN, ERR_TOKEN, ERR_KEY, 'someone@example.com', 'x=1'].filter(s => text.includes(s));
const overflow = page => page.evaluate(() => { const d = document.querySelector('#dlgReport .dlg'); return { doc: document.documentElement.scrollWidth - innerWidth, dlg: d.scrollWidth - d.clientWidth }; });

try {
  // ---- desktop ----
  const A = await newPage('A');
  check('desktop: the secret project is open', (await A.page.evaluate(() => document.getElementById('projname').textContent)) === SECRETS[0]);
  await A.page.focus('#moreb'); await A.page.keyboard.press('ArrowDown');
  check('desktop: More has "Report a problem…"', await A.page.isVisible('#reportb') && (await A.page.textContent('#reportb')).trim() === 'Report a problem…');
  for (let i = 0; i < 12 && !(await A.page.evaluate(() => document.activeElement.id === 'reportb')); i++) await A.page.keyboard.press('ArrowDown');
  await A.page.keyboard.press('Enter'); await sleep(300);
  check('desktop: Enter on the entry opens the dialog, focus in the text box', (await mode(A.page)) === 'edit' && await A.page.evaluate(() => document.activeElement.id === 'rText'));
  check('desktop: technical details on, project shape off', await A.page.isChecked('#rTech') && !(await A.page.isChecked('#rShape')));
  await shot(A.page, 'desktop-dialog');
  await A.page.keyboard.press('Escape'); await sleep(200);
  check('desktop: Escape closes it and focus goes back to More', !(await mode(A.page)) && await A.page.evaluate(() => document.activeElement.id === 'moreb'));

  await A.page.click('#moreb'); await A.page.click('#reportb'); await sleep(300);
  await A.page.fill('#rText', 'The timeline went blank. My link was https://cue.example/#join=' + ERR_JOIN + '.' + ERR_TOKEN);
  await A.page.check('#rShape'); await A.page.click('#rSee summary'); await sleep(300);
  let j = await shown(A.page);
  check('report: build from <meta name="cue-build">, viewport, phone=false, side', j.build === 'abc1234' && j.viewport.w === 1440 && j.phone === false && j.side === 'a', JSON.stringify(j.viewport));
  check('report: not in a room, online, save state, storage', j.collab === 'none' && j.online === true && typeof j.save === 'string' && j.storage && 'usedMB' in j.storage);
  check('report: shape = 3 shots, lengths 12.5/17.5/30, takes 0/1/2', isDeepStrictEqual(j.shape, { shots: 3, lengths: [12.5, 17.5, 30], takes: [0, 1, 2] }), JSON.stringify(j.shape));
  check('report: both errors kept, file:line only', j.errors?.length === 2 && j.errors.every(e => !/https?:/.test(e.at || '')), JSON.stringify(j.errors));
  check('report: the invite link in the typed text is scrubbed', /https:\/\/cue\.example\//.test(j.text) && !j.text.includes(ERR_TOKEN) && !j.text.includes(ERR_JOIN), j.text);
  check('report: nothing secret in what will be sent', !leaks(JSON.stringify(j)).length, leaks(JSON.stringify(j)).join(', '));
  check('report: only allow-listed fields', Object.keys(j).every(k => ['v', 'build', 'at', 'text', 'viewport', 'phone', 'side', 'ua', 'lang', 'online', 'storage', 'save', 'collab', 'media', 'errors', 'shape'].includes(k)), Object.keys(j).join(','));
  let o = await overflow(A.page); check('desktop: no horizontal overflow (page, dialog)', o.doc <= 0 && o.dlg <= 0, JSON.stringify(o));
  await shot(A.page, 'desktop-dialog-json');
  await A.page.click('#rSend');
  await A.page.waitForSelector('#dlgReport[data-mode="done"]', { timeout: 8000 }).catch(() => {});
  const lead = await A.page.textContent('#rLead'), id = /Report ([a-z0-9]{10})\./.exec(lead)?.[1];
  check('desktop: Send → "Thanks, sent" with the report id, Close focused', !!id && await A.page.evaluate(() => document.activeElement.id === 'rCancel'), lead);
  await shot(A.page, 'desktop-sent');
  j = await shown(A.page); // rebuilt at Send: this is what went out
  let files = stored(), f = files.find(x => x.j.id === id);
  check('server: the report file is there, mode 0600', !!f && f.mode === 0o600, f && f.n);
  check('server: the stored report equals "See what will be sent"', !!f && isDeepStrictEqual(strip(f.j), j), f && Object.keys({ ...j, ...strip(f.j) }).filter(k => !isDeepStrictEqual(j[k], f.j[k])).map(k => `${k}: shown ${JSON.stringify(j[k])} stored ${JSON.stringify(f.j[k])}`).join(' · '));
  check('server log: no report contents (text, ua)', !serverLog.includes('timeline went blank') && !serverLog.includes(j.ua) && /report stored/.test(serverLog));
  await A.page.click('#rCancel'); await sleep(200);
  check('desktop: Close returns focus to More', await A.page.evaluate(() => document.activeElement.id === 'moreb'));
  await A.page.click('#moreb'); await A.page.click('#reportb'); await sleep(300);
  check('desktop: after a send the dialog starts clean', (await A.page.inputValue('#rText')) === '' && (await mode(A.page)) === 'edit');
  await A.page.keyboard.press('Escape');
  await A.ctx.close();

  // ---- phone ----
  for (const vp of [{ width: 390, height: 844 }, { width: 390, height: 700 }]) {
    const tag = `${vp.width}x${vp.height}`, P = await newPage('P' + tag, { phone: vp });
    await P.page.tap('#proj'); await sleep(400);
    check(`phone ${tag}: the Projects sheet has "Report a problem"`, await P.page.isVisible('#mReport'));
    await P.page.tap('#mReport'); await sleep(400);
    check(`phone ${tag}: the row opens the dialog as a sheet`, (await mode(P.page)) === 'edit' && !(await P.page.evaluate(() => document.getElementById('mProj').open)));
    const fs = await P.page.evaluate(() => getComputedStyle(document.getElementById('rText')).fontSize);
    check(`phone ${tag}: the text box is 16px (no zoom on focus)`, fs === '16px', fs);
    await P.page.tap('#rText'); await P.page.keyboard.type('Takes tab looks cut off');
    await P.page.tap('#rSee summary'); await sleep(300);
    j = await shown(P.page);
    check(`phone ${tag}: phone=true, viewport ${tag}, dpr 2`, j.phone === true && j.viewport.w === vp.width && j.viewport.h === vp.height && j.viewport.dpr === 2, JSON.stringify(j.viewport));
    o = await overflow(P.page); check(`phone ${tag}: no horizontal overflow`, o.doc <= 0 && o.dlg <= 0, JSON.stringify(o));
    await P.page.evaluate(() => document.getElementById('rSee').open = false); await sleep(150);
    await shot(P.page, `phone-${tag}-dialog`);
    if (vp.height === 844) {
      await P.page.tap('#rSend'); await P.page.waitForSelector('#dlgReport[data-mode="done"]', { timeout: 8000 }).catch(() => {});
      j = await shown(P.page);
      const pid = /Report ([a-z0-9]{10})\./.exec(await P.page.textContent('#rLead'))?.[1];
      f = stored().find(x => x.j.id === pid);
      check(`phone ${tag}: Send stores it, equal to what was shown`, !!f && isDeepStrictEqual(strip(f.j), j));
      await shot(P.page, `phone-${tag}-sent`);
    } else {
      // the network drops with the dialog open: the report is rebuilt at Send (online: false) and the fallback shows
      await P.ctx.setOffline(true);
      await P.page.tap('#rSend'); await P.page.waitForSelector('#dlgReport[data-mode="failed"]', { timeout: 20000 }).catch(() => {});
      j = await shown(P.page);
      check(`phone ${tag}: offline at Send → "Couldn't reach the server", Copy and Download offered`, (await mode(P.page)) === 'failed' && await P.page.isVisible('#rCopy') && await P.page.isVisible('#rDown') && /copy or download/i.test(await P.page.textContent('#rMsg')));
      check(`phone ${tag}: the rebuilt report says offline`, j.online === false);
      await shot(P.page, `phone-${tag}-failed`);
      await P.ctx.setOffline(false);
    }
    await P.ctx.close();
  }

  // ---- no sync server (standalone copy): Copy and Download are the way out ----
  const S = await newPage('S', { q: '?sync=none' });
  await S.page.click('#moreb'); await S.page.click('#reportb'); await sleep(400);
  check('standalone: offline mode, no Send, Copy and Download offered', (await mode(S.page)) === 'offline' && !(await S.page.isVisible('#rSend')) && await S.page.isVisible('#rCopy') && await S.page.isVisible('#rDown'));
  j = await shown(S.page);
  check('standalone: collab = off', j.collab === 'off');
  await shot(S.page, 'desktop-standalone');
  // the snap browser keeps downloads in its own /tmp: read the file from the link it clicks instead
  await S.page.evaluate(() => document.addEventListener('click', e => { const a = e.target; if (a.download) fetch(a.href).then(r => r.text()).then(text => { window.__dl = { name: a.download, text }; }); }, true));
  await S.page.click('#rDown'); await S.page.waitForFunction(() => window.__dl, null, { timeout: 5000 });
  const dl = await S.page.evaluate(() => window.__dl), dlText = dl.text;
  check('standalone: Download report saves exactly the JSON shown', dlText === await S.page.textContent('#rJson') && /^cue-board-report-\d{8}T\d{6}\.json$/.test(dl.name), dl.name);
  await S.page.click('#rCopy'); await sleep(200);
  const clip = await S.page.evaluate(() => navigator.clipboard.readText());
  check('standalone: Copy report puts the same JSON on the clipboard', clip === await S.page.textContent('#rJson') && (await S.page.textContent('#rCopy')) === 'Copied');
  check('standalone: no request left the page for the report', !consoleLog.some(l => /^S .*reports/.test(l)));
  await S.ctx.close();

  // ---- the server can't be reached ----
  const D = await newPage('D', { q: '?sync=dead' });
  await D.page.click('#moreb'); await D.page.click('#reportb'); await sleep(300);
  await D.page.click('#rSend'); await D.page.waitForSelector('#dlgReport[data-mode="failed"]', { timeout: 20000 }).catch(() => {});
  check('unreachable server: failed mode, Try again focused, fallback offered', (await D.page.textContent('#rSend')) === 'Try again' && await D.page.evaluate(() => document.activeElement.id === 'rSend') && await D.page.isVisible('#rDown'));
  await shot(D.page, 'desktop-failed');
  await D.ctx.close();

  const appErrors = consoleLog.filter(l => /pageerror/.test(l) && !/boom at|fetch https:\/\/sync\.example/.test(l));
  check('no page errors besides the planted ones', !appErrors.length, appErrors.slice(0, 3).join(' | '));
} catch (e) { fails++; console.log('FAIL exception · ' + (e && e.stack || e)); }
finally { await browser.close(); server.kill(); srv.close(); }
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
