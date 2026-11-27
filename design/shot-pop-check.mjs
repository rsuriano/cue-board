// Shot settings popover: opens from the card's gear and from a right-click on the timeline; the editor no longer scrolls.
//   node design/shot-pop-check.mjs <repo-root> <out-dir>
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.CUE_TESTKIT || process.env.TESTKIT || '/home/ramiro/testkit/')('playwright-core');
const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const T = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => { const u = q.url.split('?')[0]; const p = join(root, normalize(decodeURIComponent(u === '/' ? '/index.html' : u)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': T[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); } catch { r.writeHead(404); r.end(); } });
let port = 3380;
for (;; port++) { if (port > 3399) throw new Error('no free port'); const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); }); if (ok) break; }
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
await page.goto(origin + '/index.html');
await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
const img = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); g.fillStyle = '#c86b3c'; g.fillRect(0, 0, 320, 180); return c.toDataURL('image/png'); });
const sections = [0, 1, 2].map(i => ({ id: 's' + i, start: i * 6, title: 'Shot ' + (i + 1), shot: 'Wide shot', notes: 'Notes long enough to fill the box a little, like a real shot would have.', img: i < 2 ? 'm0' : '', kind: '', key: '', endKey: i === 1 ? 'm0' : '', imgPrompt: '', vidPrompt: '', takes: [] }));
await page.setInputFiles('#importf', { name: 'pop.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'cueboard', version: 1, project: { id: 'p-pop', title: 'Pop', created: 1, updated: 1, song: null, refs: [], sections }, media: { m0: { type: 'image/png', data: img } } })) });
await page.waitForFunction(() => /Pop/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
const hidden = id => page.evaluate(id => { const e = document.getElementById(id); return !e || !!e.closest('[hidden]') || !e.getClientRects().length; }, id);
check('the editor has no speed, clip start or end frame fields', await page.evaluate(() => !document.querySelector('#editor #f-speed,#editor #f-endon')));
check('shot 2 (end frame set) shows its settings button lit', await page.evaluate(() => document.querySelector('#strip .card[data-id] :is(.cset.on)') !== null));
await page.click('#strip .card:nth-child(1)'); await page.waitForTimeout(200);
await page.hover('#strip .card:nth-child(1)'); await page.click('#strip .card:nth-child(1) [data-set]'); await page.waitForTimeout(250);
check('the gear opens the popover for that shot', !(await hidden('shotPop')) && /01/.test(await page.textContent('#shotPopNo')));
check('a still image shows the End frame option', !(await hidden('f-endon')));
await page.screenshot({ path: join(out, 'shot-pop.png') });
await page.mouse.click(5, 5); await page.waitForTimeout(150);
check('a click outside closes it', await hidden('shotPop'));
const cv = await page.locator('canvas').first().boundingBox();
const tl = await page.evaluate(() => { const c = document.querySelector('#tlwrap canvas, .timeline canvas, canvas'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.click(tl.x + tl.w * 0.5, tl.y + tl.h * 0.5, { button: 'right' }); await page.waitForTimeout(250);
check('a right-click on the timeline opens it', !(await hidden('shotPop')));
await page.keyboard.press('Escape'); await page.waitForTimeout(150);
check('Escape closes it', await hidden('shotPop'));
// the editor fits without scrolling on common laptop and desktop sizes (shorter windows still scroll by design)
for (const [w, h] of [[1920, 1080], [1536, 864], [1440, 900]]) {
  await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250);
  await page.click('#strip .card:nth-child(2)'); await page.waitForTimeout(200);
  const m = await page.evaluate(() => { const e = document.getElementById('editor'); return e.scrollHeight - e.clientHeight; });
  check(`${w}x${h}: the editor does not scroll for a shot with an image`, m <= 1, `${m}px`);
}
check('no page errors', errs.length === 0, errs.join(' | '));
await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
