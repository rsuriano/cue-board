// Settings has two tabs: Model (default: API key, models) and Account (email + Log out, or Log in). The Account tab only
// exists where an auth service is set up, and Log out works from inside Settings (it used to live only in the Collaborate dialog).
//   node design/settings-account-check.mjs <repo-root> <out-dir>
// A static server on 127.0.0.1 with the auth meta filled in; no request leaves 127.0.0.1.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
const { chromium } = createRequire(['/home/talos/testkit/', '/home/ramiro/testkit/'].find(p => { try { statSync(p); return true } catch { return false } }))('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const srv = createServer((q, r) => {
  const [path, qs = ''] = q.url.split('?');
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html') && qs !== 'auth=none') body = body.toString().replace('<meta name="cue-auth-url" content="">', '<meta name="cue-auth-url" content="http://127.0.0.1:9">');
    const ext = p.slice(p.lastIndexOf('.'));
    r.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const base = 'http://127.0.0.1:' + srv.address().port + '/index.html';
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/snap/bin/chromium', args: ['--no-sandbox'] });
const vis = (page, id) => page.evaluate(id => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0 }, id);
const tab = (page, id) => page.evaluate(id => document.getElementById(id).getAttribute('aria-selected'), id);
for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 700 }]]) {
  const ctx = await browser.newContext({ viewport: vp }), page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(base); await page.waitForTimeout(800);
  await page.evaluate(() => localStorage.setItem('cue.account', JSON.stringify({ session: 's'.repeat(20), email: 'rami@test.dev' })));
  await page.reload(); await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('settingsb').click()); await page.waitForTimeout(300);
  check(label + ': Settings opens on the Model tab', await tab(page, 'setTabModel') === 'true' && await vis(page, 'setKey') && !(await vis(page, 'setPaneAcct')));
  check(label + ': the Account tab is there', await vis(page, 'setTabAcct'));
  // the tab bar runs edge to edge (negative margins equal to the dialog's side padding): not wider, no sideways scroll
  const bar = await page.evaluate(() => {
    const d = document.getElementById('dlgSettings'), t = d.querySelector('.setTabs'), dr = d.getBoundingClientRect(), tr = t.getBoundingClientRect();
    const inL = dr.left + d.clientLeft, inR = inL + d.clientWidth;
    return { dl: inL, dr: inR, tl: tr.left, tr: tr.right, sw: d.scrollWidth, cw: d.clientWidth };
  });
  check(label + ': Settings tab bar sits edge to edge, dialog does not scroll sideways',
    Math.abs(bar.tl - bar.dl) <= 0.5 && Math.abs(bar.tr - bar.dr) <= 0.5 && bar.sw <= bar.cw, JSON.stringify(bar));
  await page.click('#setTabAcct'); await page.waitForTimeout(200);
  const who = await page.textContent('#setAcctWho');
  check(label + ': Account shows the email and Log out', who.includes('rami@test.dev') && (await page.textContent('#setAcctBtn')) === 'Log out' && !(await vis(page, 'setKey')), who);
  await page.screenshot({ path: join(out, 'settings-account-' + label + '.png') });
  const box = await page.evaluate(() => { const d = document.getElementById('dlgSettings').getBoundingClientRect(); return [d.left, d.right, innerWidth] });
  check(label + ': dialog fits the viewport', box[0] >= 0 && box[1] <= box[2], JSON.stringify(box));
  await page.click('#setAcctBtn'); await page.waitForTimeout(200);
  check(label + ': Log out clears the account and offers Log in', (await page.evaluate(() => localStorage.getItem('cue.account'))) === null && (await page.textContent('#setAcctBtn')) === 'Log in');
  await page.click('#setTabModel'); await page.waitForTimeout(200);
  check(label + ': back on Model, the key field is there', await vis(page, 'setKey') && !(await vis(page, 'setPaneAcct')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('settingsb').click()); await page.waitForTimeout(200);
  check(label + ': reopening Settings starts on Model again', await tab(page, 'setTabModel') === 'true');
  check(label + ': no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage();
  await page.goto(base.replace('index.html', 'index.html?auth=none')); await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('settingsb').click()); await page.waitForTimeout(300);
  check('no auth service: no Account tab, Model works', !(await vis(page, 'setTabAcct')) && await vis(page, 'setKey'));
  await ctx.close();
}
await browser.close(); srv.close();
console.log(fails ? fails + ' FAILED' : 'ALL PASS');
process.exit(fails ? 1 : 0);
