// Side B frame rows never wrap and never overflow: every visible action of a frame on ONE line, inside its column,
// at common desktop widths, for every shot of the example plus a shot with both frames set.
//   node design/frame-rows-check.mjs <repo-root> <out-dir>
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

for (const [w, h] of [[1920, 1080], [1680, 1050], [1536, 864], [1440, 900], [1366, 768], [1280, 720]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
  // a project where shot 1 has a start AND an end frame (the case that wrapped)
  const img = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); g.fillStyle = '#3c7ac8'; g.fillRect(0, 0, 320, 180); return c.toDataURL('image/png'); });
  const sections = [0, 1, 2].map(i => ({ id: 's' + i, start: i * 6, title: 'Shot ' + (i + 1), shot: 'Wide shot', notes: '', img: i === 0 ? 'm0' : '', kind: '', key: i === 1 ? 'm0' : '', endKey: i < 2 ? 'm0' : '', imgPrompt: '', vidPrompt: '', takes: [] }));
  await page.setInputFiles('#importf', { name: 'rows.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'cueboard', version: 1, project: { id: 'p-rows', title: 'Rows', created: 1, updated: 1, song: null, refs: [], sections }, media: { m0: { type: 'image/png', data: img } } })) });
  await page.waitForFunction(() => /Rows/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
  await page.click('.sides [data-side="b"]'); await page.waitForTimeout(500);
  const n = await page.locator('#bList .bitem').count();
  for (let i = 0; i < n; i++) {
    await page.click(`#bList .bitem:nth-child(${i + 1})`); await page.waitForTimeout(300);
    const r = await page.evaluate(() => ['fStart', 'fEnd'].map(id => {
      const row = document.querySelector(`#${id} > .row`), rb = row.getBoundingClientRect(), col = row.parentElement.getBoundingClientRect();
      const bs = [...row.children].filter(e => e.offsetParent && e.tagName !== 'INPUT' && e.getBoundingClientRect().width > 0);
      const tops = [...new Set(bs.map(e => Math.round(e.getBoundingClientRect().top)))];
      const right = Math.max(...bs.map(e => e.getBoundingClientRect().right));
      return { id, n: bs.length, tops: tops.length, over: Math.round(right - col.right), names: bs.map(e => e.getAttribute('aria-label') || e.textContent.trim()) };
    }));
    for (const x of r) check(`${w} shot ${i + 1} ${x.id}: one line, inside its column`, x.tops <= 1 && x.over <= 0, `${x.names.join(' | ')} · lines ${x.tops} · overflow ${x.over}px`);
    if (i === 0 && w === 1440) { const a = await page.locator('#fStart').boundingBox(), z = await page.locator('#fEnd').boundingBox();
      await page.screenshot({ path: join(out, 'frames-1440.png'), clip: { x: a.x - 8, y: a.y - 8, width: Math.max(a.width, z.width) + 16, height: z.y + z.height - a.y + 16 } }); }
  }
  await page.close();
}
await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
