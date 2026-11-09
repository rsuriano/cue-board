// Back from the checkout: Buy remembers which project was being shared (cue.afterBuy, this browser only), and the
// receipt's ?key= link goes on with Share this project for it (the name step). Stale (> 1 h) or a deleted project:
// logged in, nothing else, intent gone. No intent: logged in, nothing else. Auth is faked in the browser, no servers.
//   node design/resume-buy-check.mjs <repo-root> <out-dir>
// CUE_TESTKIT (dir with playwright-core) and CUE_CHROMIUM (empty = playwright's own) override the defaults.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.CUE_TESTKIT || '/home/ramiro/testkit/')('playwright-core');
const exe = process.env.CUE_CHROMIUM ?? '/snap/bin/chromium';

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const AUTH = 'http://127.0.0.1:3399', BUY = 'https://bedrock.lemonsqueezy.example/buy/cue', GOOD = 'A'.repeat(32);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const errs = [];
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', '<meta name="cue-sync-url" content="ws://127.0.0.1:3398">')
      .replace('<meta name="cue-auth-url" content="">', `<meta name="cue-auth-url" content="${AUTH}">`).replace('<meta name="cue-buy-url" content="">', `<meta name="cue-buy-url" content="${BUY}">`);
    r.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript' }[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sessionCalls = [];
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u === AUTH + '/session') {
      const b = JSON.parse(r.request().postData() || '{}'); sessionCalls.push(b);
      const ok = b.key === GOOD || b.session === 'S1';
      return r.fulfill({ status: ok ? 200 : 401, contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify(ok ? { session: 'S1', email: 'buyer@example.com' } : { message: 'That link has expired.' }) });
    }
    return u.startsWith(origin) ? r.continue() : r.abort();
  });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = { off: true }; });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  const open = async url => { await page.goto(url); await page.waitForSelector('#projname', { timeout: 10000 }); };
  const ls = k => page.evaluate(k => localStorage.getItem(k), k);
  const step = () => page.evaluate(() => document.getElementById('dlgJoin').open ? document.getElementById('dlgJoin').dataset.step : '');
  const logout = () => page.evaluate(() => localStorage.removeItem('cue.account'));
  await open(app); await sleep(800);
  const P = await ls('cueboard-last');

  // A: Buy with P open, another project open meanwhile, back with ?key=valid → logged in, P open, its name step
  await page.click('#joinb'); await page.waitForSelector('#dlgJoin[open][data-step="collab"]');
  await page.click('#jShareNew'); await page.waitForSelector('#dlgJoin[open][data-step="pay"]');
  const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null), page.click('#jBuy')]);
  if (pop) await pop.close();
  const intent = JSON.parse(await ls('cue.afterBuy') || 'null');
  check('Buy remembers the project being shared and when', intent && intent.project === P && Math.abs(Date.now() - intent.at) < 10000 && !(await step()), JSON.stringify(intent));
  await page.click('#newp'); await page.keyboard.press('Escape'); await sleep(600);
  check('(another project is open before coming back)', (await ls('cueboard-last')) !== P);
  await open(app + '?key=' + GOOD);
  await page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 8000 }).catch(() => {});
  check('A: back with ?key=: logged in, P open again, the room-name step', /buyer@example\.com/.test(await ls('cue.account') || '') && (await ls('cueboard-last')) === P && (await step()) === 'name', await step());
  check('A: intent cleared, key gone from the address bar', (await ls('cue.afterBuy')) === null && !page.url().includes('key='));
  await page.screenshot({ path: `${out}/resume-name-step.png` });
  if (await step()) await page.click('#jCancel');

  // B: an intent over an hour old, or for a project that's gone → logged in, no share step, intent cleared
  for (const [label, val] of [['older than 1 h', { project: P, at: Date.now() - 3600_000 - 5000 }], ['project deleted', { project: 'p-gone', at: Date.now() }]]) {
    await logout(); await page.evaluate(v => localStorage.setItem('cue.afterBuy', v), JSON.stringify(val));
    await open(app + '?key=' + GOOD); await page.waitForFunction(() => !!localStorage.getItem('cue.account'), null, { timeout: 8000 }).catch(() => {}); await sleep(1200);
    check(`B: ${label}: logged in, no share step, intent cleared`, !!(await ls('cue.account')) && (await step()) === '' && (await ls('cue.afterBuy')) === null, await step());
  }

  // C: ?key= and no intent → logged in, nothing else
  await logout(); await open(app + '?key=' + GOOD); await page.waitForFunction(() => !!localStorage.getItem('cue.account'), null, { timeout: 8000 }).catch(() => {}); await sleep(1200);
  check('C: no intent: logged in, nothing else', !!(await ls('cue.account')) && (await step()) === '');

  // a key auth refuses: not logged in, nothing opens, intent gone too
  await logout(); await page.evaluate(v => localStorage.setItem('cue.afterBuy', v), JSON.stringify({ project: P, at: Date.now() }));
  await open(app + '?key=' + 'B'.repeat(32)); await sleep(1500);
  check('a refused key: not logged in, no share step, intent cleared', !(await ls('cue.account')) && (await step()) === '' && (await ls('cue.afterBuy')) === null);

  // logging in some other way (a pasted link in Log in) clears it
  await page.evaluate(v => localStorage.setItem('cue.afterBuy', v), JSON.stringify({ project: P, at: Date.now() }));
  await page.click('#joinb'); await page.waitForSelector('#dlgJoin[open][data-step="collab"]'); await page.click('#jLogin2');
  await page.waitForSelector('#dlgJoin[open][data-step="login"]'); await page.fill('#jEmail', GOOD); await page.click('#jGo');
  await page.waitForFunction(() => !!localStorage.getItem('cue.account'), null, { timeout: 8000 }).catch(() => {});
  check('logging in another way clears the intent', !!(await ls('cue.account')) && (await ls('cue.afterBuy')) === null);
  check('the intent never reaches auth', !sessionCalls.some(b => JSON.stringify(b).includes('afterBuy') || JSON.stringify(b).includes(P)));
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); srv.close(); }
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
