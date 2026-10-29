// The phone layout's Cut tab at six phone sizes, with the example song and 12 shots: the timeline's heights and
// widths, measured. Screenshots of every size go to <out-dir>/<w>x<h>.png (look at them).
//   node design/mobile-sizes-check.mjs <repo-root> <out-dir>
// Collaboration stays off (index.html as is, no sync URL). Every request outside the local server is aborted.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
const check = (dev, name, ok, ev = '') => { results.push({ dev, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} [${dev}] ${name}${ev ? ' · ' + ev : ''}`); };
const SIZES = [[360, 640], [375, 667], [390, 700], [390, 844], [412, 915], [430, 932]];
// the canvas' rows, as mBand() in index.html lays them out (read from the page, not repeated here)
for (const [w, h] of SIZES) {
  const dev = `${w}x${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.querySelector('#mPeek .m-peekb'), null, { timeout: 15000 });
  // 12 shots over the song, then a playhead in the middle of it (the waveform is drawn on both sides of the centre)
  await page.evaluate(() => { const a = window.__CUE_MEDIA_TEST.app, s = a.S(), d = document.getElementById('audio').duration || 120;
    while (s.length < 12) s.push({ ...s[s.length - 1], id: 'x' + s.length, title: 'Shot ' + (s.length + 1), takes: [] });
    s.length = 12; s.forEach((x, i) => { x.start = +(i * d / 12).toFixed(2); }); a.renderAll(); });
  await page.waitForFunction(() => document.getElementById('audio').duration > 0, null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { const sc = document.getElementById('tl-scroll'); sc.scrollLeft = Math.round((sc.scrollWidth - sc.clientWidth) * .3); });
  await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${dev}.png`) });
  // at the song's start the playhead is still centred: the left half is before 0:00, ruled, not an empty column
  const sl = await page.evaluate(() => document.getElementById('tl-scroll').scrollLeft);
  await page.evaluate(() => { document.getElementById('tl-scroll').scrollLeft = 0; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${dev}-start.png`) });
  await page.evaluate(x => { document.getElementById('tl-scroll').scrollLeft = x; }, sl);
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const R = id => { const e = document.getElementById(id) || document.querySelector(id); return e && e.getClientRects().length ? e.getBoundingClientRect() : null; };
    const tl = R('.timeline'), cv = R('tl'), ph = R('ph'), mon = R('monitor'), tabs = R('mTabs'), tool = R('mTool'), zoom = R('.transport .seg');
    const L = window.__CUE_MEDIA_TEST.app.mLayout(cv.height), grips = [...document.querySelectorAll('#mGrips .grip:not([hidden])')].map(g => g.getBoundingClientRect());
    return { iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      tl: [tl.left, tl.right], cv: [cv.left, cv.right, cv.top], ph: ph.left + ph.width / 2, mon: mon.height, tabs: tabs.bottom, tool: [tool.top, tool.bottom], L,
      zoom: zoom && [zoom.left, zoom.top, zoom.right, zoom.bottom, zoom.height], grips: grips.map(g => [g.left, g.top, g.width, g.height]),
      drawn: (() => { const c = document.getElementById('tl'), g = c.getContext('2d'), d = devicePixelRatio, px = g.getImageData(Math.round(2 * d), Math.round(4 * d), 1, 1).data; return px[0] + px[1] + px[2]; })() };
  });
  check(dev, 'waveform at most its cap (120px)', m.L.waveH <= 120, `${m.L.waveH}px`);
  check(dev, 'shot strip thumbnails at least 44px tall', m.L.h >= 44, `${m.L.h}px`);
  check(dev, 'timeline spans the full width (ruler drawn from the left edge)', m.tl[0] <= 8 && m.cv[0] <= 8 && m.tl[1] >= m.iw - 1 && m.drawn > 0, `timeline ${m.tl.map(Math.round)}, canvas ${m.cv.map(Math.round)}`);
  check(dev, 'playhead at the centre of the visible timeline (±2px)', Math.abs(m.ph - (m.cv[0] + m.cv[1]) / 2) <= 2, `${m.ph.toFixed(1)} vs ${((m.cv[0] + m.cv[1]) / 2).toFixed(1)}`);
  check(dev, 'preview at least 30% of the viewport height', m.mon >= m.ih * .3, `${Math.round(m.mon)}px of ${m.ih}`);
  check(dev, 'no horizontal or vertical overflow', m.sw <= m.iw && m.sh <= m.ih, `${m.sw}x${m.sh}`);
  check(dev, 'toolbar and tabs fully visible', m.tool[1] <= m.ih && m.tabs <= m.ih + .5, `toolbar ${m.tool.map(Math.round)}, tabs end ${Math.round(m.tabs)}`);
  check(dev, 'cut grips at least 44px tall and wide', m.grips.length && m.grips.every(g => g[2] >= 44 && g[3] >= 44), JSON.stringify(m.grips.slice(0, 2).map(g => g.map(Math.round))));
  const wTop = m.cv[2] + m.L.wave, cover = m.zoom && m.grips.some(g => g[0] < m.zoom[2] && g[0] + g[2] > m.zoom[0] && g[1] < m.zoom[3] && g[1] + g[3] > m.zoom[1]);
  check(dev, 'zoom control 44px tall, off the shot strip and the waveform', m.zoom && m.zoom[4] >= 44 && !cover && (m.zoom[3] <= m.cv[2] + m.L.top || m.zoom[1] >= wTop + m.L.waveH), JSON.stringify(m.zoom && m.zoom.map(Math.round)));
  check(dev, 'no page errors', !errs.length, errs.join(' | '));
  // scrub with a finger still seeks
  const c = await page.context().newCDPSession(page), y = m.cv[2] + m.L.wave + m.L.waveH / 2, t0 = await page.evaluate(() => document.getElementById('audio').currentTime);
  const tp = x => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(w * .75) });
  for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(w * .75 - w * .5 * i / 8) }); await page.waitForTimeout(16); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(500);
  const t1 = await page.evaluate(() => document.getElementById('audio').currentTime);
  check(dev, 'dragging the waveform scrubs', t1 > t0 + 1, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);
  await ctx.close();
}
await browser.close(); srv.close();
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
