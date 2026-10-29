// Screenshots for docs/mobile: the mocks (one per ?screen=) and, for comparison, today's app on a phone.
//   node docs/mobile/shoot.mjs [<repo-root>] [--only=mocks|today]
// The committed today-*.png are the app before the phone layout (PLAN.md "today"); running today overwrites them.
// Serves the repo on 127.0.0.1:3371 (falls back to 3372-3379). Mobile emulation: 390x844, DPR 2, touch.
// Every request that isn't to the local server is aborted and listed (the mocks must make none).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || join(here, '../..'));
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const out = join(here, 'shots');
mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
let port = 3371;
for (;; port++) {
  if (port > 3379) throw new Error('no free port in 3371-3379');
  const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });
  if (ok) break;
}
const origin = `http://127.0.0.1:${port}`;
const external = [];

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function phone(w = 390, h = 844) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    external.push(u); return r.abort();
  });
  return ctx.newPage();
}

export const SCREENS = ['cut', 'details', 'takes', 'project', 'trim', 'reorder', 'generate', 'safari', 'cut@360'];

if (only !== 'today') for (const s of SCREENS) {
  const [w, h] = s === 'safari' ? [390, 664] : s.endsWith('@360') ? [360, 800] : [390, 844];
  const page = await phone(w, h);
  await page.goto(`${origin}/docs/mobile/mocks.html?screen=${s.split('@')[0]}`);
  await page.evaluate(() => document.fonts.ready);
  const bad = await page.evaluate(() => window.__mockCheck ? window.__mockCheck() : []);
  if (bad.length) console.log(`CHECK ${s}: ${bad.join(' | ')}`);
  await page.screenshot({ path: join(out, `${s.replace('@', '-')}.png`) });
  console.log('shot', s);
  await page.context().close();
}

if (only !== 'mocks') {
  // today's app: first visit opens the example project
  const page = await phone();
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 3, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, 'today-a.png') });
  const m = await page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    timelineTop: Math.round(document.querySelector('.timeline').getBoundingClientRect().top),
    tlCanvasPx: (() => { const c = document.getElementById('tl'); return c ? `${c.width}x${c.height}` : ''; })(),
    small: [...document.querySelectorAll('button, label.btn, select, input:not([type=file]):not([hidden])')]
      .filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length,
    total: [...document.querySelectorAll('button, label.btn, select, input:not([type=file]):not([hidden])')].filter(e => e.offsetParent).length,
    inputFont: getComputedStyle(document.getElementById('f-title')).fontSize,
  }));
  console.log('today side A:', JSON.stringify(m));
  // the phone layout's tab bar (#mTabs); the desktop .sidetab before it existed
  await page.locator('#mTabs [data-side="b"]:visible, .sidetab[data-side="b"]:visible').first().tap();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, 'today-b.png') });
  await page.context().close();
}

console.log(external.length ? `EXTERNAL REQUESTS (aborted): ${external.join(', ')}` : 'external requests: none');
await browser.close(); srv.close();
