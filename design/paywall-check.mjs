// Paid access in the app: Get access for $9 → checkout (a stand-in) → back with ?ls_claim=1 → the claim collected by POST;
// the claim id never in a URL the browser requests from our hosts; then a fresh browser (a new device) restores the same
// token with the order number and email; the restore step on a phone.
//   node design/paywall-check.mjs <repo-root> <out-dir>
// Sync server in-process on a free port (throwaway DATA_DIR), a stand-in Lemon Squeezy API and checkout; nothing leaves 127.0.0.1.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const { startServer } = await import(join(root, 'packages/sync-server/src/server.mjs'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const consoleLog = [];
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const SECRET = 'check-signing-secret', VARIANT = '424242', EMAIL = 'buyer@example.com', ORDER_ID = '9001', ORDER_NO = 41;
const CHECKOUT = 'https://checkout.lemonsqueezy.invalid/buy/cue-access';
const lsOrder = { type: 'orders', id: ORDER_ID, attributes: { identifier: '0b0c7a35-63a5-4e0e-9a4b-3d1b7f2a9c11', order_number: ORDER_NO, user_email: EMAIL, status: 'paid', refunded: false, first_order_item: { variant_id: Number(VARIANT) } } };

const fakeLs = createServer((q, r) => {
  const u = new URL(q.url, 'http://x'), email = (u.searchParams.get('filter[user_email]') || '').toLowerCase();
  r.writeHead(200, { 'content-type': 'application/vnd.api+json' });
  r.end(JSON.stringify({ data: u.pathname === '/v1/orders' && email === EMAIL ? [lsOrder] : [], links: {} }));
});
await new Promise(ok => fakeLs.listen(0, '127.0.0.1', ok));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
let syncWs = '';
const statics = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="${syncWs}">`)
      .replace('<meta name="cue-ls-checkout-url" content="">', `<meta name="cue-ls-checkout-url" content="${CHECKOUT}">`);
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => statics.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${statics.address().port}`, app = origin + '/index.html';
const dataDir = mkdtempSync(join(tmpdir(), 'cue-paywall-check-'));
const sync = await startServer({ port: 0, dataDir, logLevel: 'silent', corsOrigins: [origin], maxConnsPerIp: 64,
  lemonSqueezy: { secret: SECRET, variantId: VARIANT, apiKey: 'check-api-key', apiBase: `http://127.0.0.1:${fakeLs.address().port}` } });
const syncHttp = sync.httpUrl; syncWs = syncHttp.replace(/^http/, 'ws');

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
/** every request to our hosts (the static site, the sync server): what an access log would keep */
const ours = [];
async function newPage(name, phone = null) {
  const ctx = await browser.newContext(phone ? { viewport: phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  ctx.on('request', q => { if (q.url().startsWith(origin) || q.url().startsWith(syncHttp)) ours.push({ method: q.method(), url: q.url(), body: q.postData() || '' }); });
  let checkoutUrl = '';
  await ctx.route('**/*', async r => {
    const url = r.request().url();
    if (url.startsWith(CHECKOUT)) {
      // the stand-in checkout: the payment goes through, Lemon Squeezy calls the webhook, the buyer is sent back
      checkoutUrl = url;
      const claimId = new URL(url).searchParams.get('checkout[custom][claim_id]');
      const raw = JSON.stringify({ meta: { event_name: 'order_created', test_mode: true, custom_data: { claim_id: claimId } }, data: { type: 'orders', id: ORDER_ID, attributes: lsOrder.attributes } });
      await fetch(syncHttp + '/webhooks/lemonsqueezy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw });
      return r.fulfill({ status: 302, headers: { location: app + '?ls_claim=1' } });
    }
    return url.startsWith(origin) || url.startsWith(syncHttp) ? r.continue() : r.abort();
  });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = { off: true }; });
  const page = await ctx.newPage();
  page.on('console', m => consoleLog.push(`${name} ${m.type()}: ${m.text()}`)); page.on('pageerror', e => consoleLog.push(`${name} pageerror: ${e.message}`));
  await page.goto(app); await page.waitForSelector('#projname', { timeout: 10000 }); await sleep(600);
  return { ctx, page, checkout: () => checkoutUrl };
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const waitStep = (page, s, ms = 9000) => page.waitForSelector(`#dlgJoin[open][data-step="${s}"]`, { timeout: ms });
/** the stored collaboration settings' verified token (IndexedDB cueboard-local, settings, "collab") */
const verified = page => page.evaluate(() => new Promise(ok => {
  const r = indexedDB.open('cueboard-local');
  r.onsuccess = () => { const g = r.result.transaction('settings').objectStore('settings').get('collab'); g.onsuccess = () => ok(g.result && g.result.verified || null); g.onerror = () => ok(null); };
  r.onerror = () => ok(null);
}));
const toAccess = async (page, tap = false) => {
  await page[tap ? 'tap' : 'click']('#joinb'); await waitStep(page, 'collab');
  await page[tap ? 'tap' : 'click']('#jShareNew'); await waitStep(page, 'access');
};

try {
  // ---- A buys ----
  const A = await newPage('A');
  await toAccess(A.page);
  check('access step: invite code, $9, and "Already paid? Restore access"', await A.page.isVisible('#jHaveCode') && await A.page.isVisible('#jBuy') && await A.page.isVisible('#jRestore') && (await A.page.textContent('#jOptsA .hint')).trim() === 'Already paid? Restore access');
  await shot(A.page, 'desktop-access');
  await A.page.click('#jBuy');
  await A.page.waitForURL(/ls_claim=1/, { timeout: 10000 }); await A.page.waitForSelector('#projname', { timeout: 10000 });
  await waitStep(A.page, 'done', 15000);
  const claimId = new URL(A.checkout()).searchParams.get('checkout[custom][claim_id]');
  const vA = await verified(A.page);
  check('back from checkout: Payment confirmed, the token stored', /Payment confirmed/.test(await A.page.textContent('#jTitle')) && vA && /^[A-Za-z0-9_-]{40,}$/.test(vA.token), vA && vA.label);
  check('the ?ls_claim param is dropped from the address', !/ls_claim/.test(A.page.url()));
  const claims = ours.filter(q => q.url.startsWith(syncHttp + '/access/claim'));
  check('the claim is collected by POST with the id in the body', claims.length > 0 && claims.every(q => q.method === 'POST' && q.url === syncHttp + '/access/claim' && JSON.parse(q.body).claim_id === claimId), claims.length + ' polls');
  const leaked = ours.filter(q => q.url.includes(claimId));
  check('the claim id is in no URL requested from our hosts (page or sync server)', !!claimId && leaked.length === 0, leaked.map(q => q.method + ' ' + q.url).join(' | '));
  check('no GET to /access/claim at all', !ours.some(q => q.method === 'GET' && q.url.includes('/access/claim')));

  // ---- B: the same buyer on a new device ----
  const B = await newPage('B');
  await toAccess(B.page);
  await B.page.click('#jRestore'); await waitStep(B.page, 'restore');
  check('restore step: order number and email, Continue', await B.page.isVisible('#jOrder') && await B.page.isVisible('#jEmail') && (await B.page.textContent('#jGo')) === 'Continue' && await B.page.evaluate(() => document.activeElement?.id === 'jOrder'));
  await shot(B.page, 'desktop-restore');
  await B.page.click('#jGo');
  check('empty fields: asked to type both, stays', /order number and the email/.test(await B.page.textContent('#jMsg')));
  await B.page.fill('#jOrder', String(ORDER_NO + 1)); await B.page.fill('#jEmail', EMAIL); await B.page.click('#jGo');
  await waitStep(B.page, 'restore');
  await B.page.waitForFunction(() => /couldn't find a paid order/.test(document.getElementById('jMsg').textContent), null, { timeout: 5000 });
  check('a wrong number: the server\'s sentence, the fields stay', /couldn't find a paid order with that number and email/.test(await B.page.textContent('#jMsg')) && (await B.page.inputValue('#jEmail')) === EMAIL);
  await shot(B.page, 'desktop-restore-wrong');
  await B.page.fill('#jOrder', '#' + ORDER_NO); await B.page.fill('#jEmail', 'Buyer@Example.com'); await B.page.click('#jGo');
  await waitStep(B.page, 'name');
  const vB = await verified(B.page);
  check('the right number and email: verified, straight on to creating the room', !!vB && !!vA && vB.token === vA.token, 'same token as the buying browser: ' + (!!vB && !!vA && vB.token === vA.token));
  const tok = JSON.parse(readFileSync(join(dataDir, 'verified.json'), 'utf8')).tokens;
  check('still one token for the order on the server', tok.length === 1 && tok[0].orderId === ORDER_ID);
  const restores = ours.filter(q => q.url.includes('/access/restore'));
  check('restore is a POST with the fields in the body', restores.length === 2 && restores.every(q => q.method === 'POST' && q.url === syncHttp + '/access/restore' && !q.url.includes('@')));
  await A.ctx.close(); await B.ctx.close();

  // ---- the restore step on a phone ----
  for (const [w, h] of [[390, 844], [375, 667]]) {
    const P = await newPage('P' + h, { width: w, height: h });
    await P.page.tap('#proj'); await P.page.waitForSelector('#mProj[open]', { timeout: 5000 });
    await P.page.tap('#mJoin'); await waitStep(P.page, 'collab'); await sleep(300);
    await P.page.tap('#jShareNew'); await waitStep(P.page, 'access'); await sleep(300);
    await shot(P.page, `phone-${h}-access`);
    await P.page.tap('#jRestore'); await waitStep(P.page, 'restore'); await sleep(350);
    await shot(P.page, `phone-${h}-restore`);
    const box = await P.page.evaluate(() => { const b = document.getElementById('jGo').getBoundingClientRect(); return { vis: b.bottom <= innerHeight && b.top >= 0, over: document.documentElement.scrollWidth > innerWidth + 1 }; });
    check(`phone ${w}x${h}: restore fields and Continue on screen, no horizontal overflow`, box.vis && !box.over && await P.page.isVisible('#jEmail'));
    await P.ctx.close();
  }
} finally {
  await browser.close(); await sync.close(); statics.close(); fakeLs.close(); rmSync(dataDir, { recursive: true, force: true });
}
const errors = consoleLog.filter(l => /pageerror/.test(l));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(fails ? `${fails} FAIL` : 'ALL PASS');
process.exit(fails ? 1 : 0);
