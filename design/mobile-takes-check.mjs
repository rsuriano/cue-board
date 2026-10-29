// The phone's Takes tab (side B below 820px): the shots rail, the shot header, spend, notes, frames and takes.
//   node design/mobile-takes-check.mjs <repo-root> <out-dir>
// Three phone sizes, each as an iPhone (touch, DPR 3) and as a plain narrow Chromium, with the example project (no
// frames) and with a 12-shot project whose shots carry images (imported from a .cueboard.json with data URLs).
// Collaboration is off (no sync URL) and every request outside the local server is aborted.
// Screenshots go to <out-dir>/<size>-<profile>-<project>.png (top of the tab) and ...-end.png (scrolled to the end).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p));
  } catch { r.writeHead(404); r.end(); }
});
// ports 3380-3399: the first free one
let port = 3380;
for (;; port++) {
  if (port > 3399) throw new Error('no free port in 3380-3399');
  const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });
  if (ok) break;
}
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
const check = (tag, name, ok, ev = '') => { results.push({ tag, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} [${tag}] ${name}${ev ? ' · ' + ev : ''}`); };
const SIZES = [[390, 844], [375, 667], [430, 932]];
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const PROFILES = {
  iphone: ([width, height]) => ({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS }),
  narrow: ([width, height]) => ({ viewport: { width, height } }),
};

// a project of 12 shots, every other one with a start frame and shot 3 with a picture in the cut: data URLs drawn in the page
async function imageProject(page) {
  const urls = await page.evaluate(() => ['#c86b3c', '#3c7ac8', '#5aa05a'].map((c, i) => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; const g = cv.getContext('2d');
    g.fillStyle = c; g.fillRect(0, 0, 320, 180); g.fillStyle = '#f2efe9'; g.beginPath(); g.moveTo(20, 170); g.lineTo(120 + i * 40, 40); g.lineTo(300, 170); g.fill();
    return cv.toDataURL('image/png'); }));
  const media = Object.fromEntries(urls.map((d, i) => ['m' + i, { type: 'image/png', data: d }]));
  const sections = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, start: i * 6, title: ['The ridge', 'Night road', 'A long title for the third shot that has to truncate'][i % 3] + ' ' + (i + 1), shot: 'Wide shot',
    notes: i % 2 ? '' : 'The light drops while the horns hold, then the camera finds her at the gate.', img: i === 2 ? 'm2' : '', kind: i === 2 ? 'image' : '', key: i % 2 ? '' : 'm' + (i % 3), endKey: '', imgPrompt: '', vidPrompt: '', takes: [] }));
  const data = { format: 'cueboard', version: 1, project: { id: 'p-imgs', title: 'Twelve shots', created: 1, updated: 1, song: null, refs: [], sections }, media };
  await page.setInputFiles('#importf', { name: 'twelve.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForFunction(() => /Twelve/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
}

// the share of a box's pixels that differ from its first pixel, from a screenshot decoded in the page
async function variety(page, box) {
  const png = await page.screenshot({ clip: box });
  return page.evaluate(async b64 => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) { if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24) n++; if (d[i] + d[i + 1] + d[i + 2] > 90) lit++; }
    return { varied: n / (d.length / 4), lit: lit / (d.length / 4) };
  }, png.toString('base64'));
}

for (const size of SIZES) for (const [prof, mk] of Object.entries(PROFILES)) for (const proj of ['example', 'images']) {
  const tag = `${size.join('x')} ${prof} ${proj}`, file = `${size.join('x')}-${prof}-${proj}`;
  const ctx = await browser.newContext(mk(size));
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
  if (proj === 'images') await imageProject(page);
  // straight to Takes, the Cut tab's timeline and tiles never drawn in between
  await page.click('#mTabs [data-side="b"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, file + '.png') });

  const g = await page.evaluate(() => {
    const R = e => { if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; };
    const union = l => { const rs = l.map(R).filter(Boolean); if (!rs.length) return null; const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y)), r = Math.max(...rs.map(r => r.r)), b = Math.max(...rs.map(r => r.b)); return { x, y, w: r - x, h: b - y, b, r }; };
    return { strip: R(document.getElementById('bList')), title: R(document.querySelector('.bshot')), spend: union([...document.querySelectorAll('.bbar .statbox')]), notes: R(document.getElementById('bNotes')),
      frames: R(document.querySelector('.frames')), sel: R(document.querySelector('.bitem.sel .bt')),
      thumbs: [...document.querySelectorAll('.bitem .bt')].map(R).filter(r => r && r.r <= innerWidth && r.x >= 0) };
  });
  const blocks = Object.entries({ strip: g.strip, title: g.title, spend: g.spend, notes: g.notes, frames: g.frames }).filter(([, r]) => r);
  const hits = [];
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const [a, A] = blocks[i], [b, B] = blocks[j];
    if (A.x < B.r - 0.5 && B.x < A.r - 0.5 && A.y < B.b - 0.5 && B.y < A.b - 0.5) hits.push(`${a}×${b}`);
  }
  check(tag, 'strip, title row, spend row, notes and frames never overlap', !hits.length && blocks.length >= (proj === 'example' ? 5 : 4), hits.join(' ') || blocks.map(([k]) => k).join(','));
  check(tag, 'the strip ends above the shot header (with a gap)', g.strip && g.title && g.strip.b + 8 <= g.title.y, g.strip && g.title ? `${Math.round(g.strip.b)} / ${Math.round(g.title.y)}` : 'missing');
  check(tag, 'the strip is tall enough for its thumbnails and labels', g.strip && g.sel && g.strip.h >= g.sel.h + 30, g.strip && `${Math.round(g.strip.h)}px`);
  // every thumbnail on screen shows something: a frame, or the shot's title on the screen colour
  const v = [];
  for (const t of g.thumbs) v.push(await variety(page, { x: t.x + 1, y: t.y + 1, width: t.w - 2, height: t.h - 2 }));
  check(tag, 'thumbnails on screen are not blank', v.length >= 2 && v.every(x => x.varied > 0.01), v.map(x => x.varied.toFixed(3)).join(' '));
  if (proj === 'images') check(tag, 'a shot with a start frame shows it in its thumbnail', v.some(x => x.lit > 0.3), v.map(x => x.lit.toFixed(2)).join(' '));
  const ovf = await page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.getElementById('sideB').scrollWidth - document.getElementById('sideB').clientWidth]);
  check(tag, 'no horizontal overflow (page and the tab)', ovf.every(x => x <= 0), ovf.join(','));

  // the end of the tab: the last control sits above the tab bar
  await page.evaluate(() => { const b = document.getElementById('sideB'); b.scrollTop = b.scrollHeight; });
  await page.waitForTimeout(250);
  const end = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('#sideB button, #sideB label.btn, #sideB input:not([type=file]), #sideB textarea, #sideB select')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('#bList'));
    const last = vis.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).pop(), tabs = document.getElementById('mTabs').getBoundingClientRect();
    return { name: last && (last.id || last.textContent.trim().slice(0, 20)), bottom: last && last.getBoundingClientRect().bottom, tabs: tabs.top, onScreen: tabs.bottom <= innerHeight + 1 };
  });
  check(tag, 'scrolled to the end, the last control is above the tab bar', end.name && end.bottom + 8 <= end.tabs && end.onScreen, `${end.name} ${Math.round(end.bottom)} / ${Math.round(end.tabs)}`);
  await page.screenshot({ path: join(out, file + '-end.png') });
  check(tag, 'no page errors', !errs.length, errs.slice(0, 2).join(' | '));
  await ctx.close();
}
await browser.close(); srv.close();
const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
