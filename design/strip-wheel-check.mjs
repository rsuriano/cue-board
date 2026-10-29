// The mouse wheel over the shot strip (Side A, bottom) scrolls it sideways, and nothing else changes.
//   node design/strip-wheel-check.mjs <repo-root> <out-dir>
// The example project, collaboration off (this repo's empty sync URL). Every request outside the local server is
// aborted. Real wheel turns go through the mouse; the deltaMode / end cases dispatch a WheelEvent and read
// defaultPrevented (swallowed or not), which is what decides whether the page scrolls instead.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route('**/*', r => (r.request().url().startsWith(origin) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));

const sl = () => page.evaluate(() => document.getElementById('strip').scrollLeft);
const setSl = v => page.evaluate(v => { document.getElementById('strip').scrollTo({ left: v, behavior: 'instant' }); }, v);
const pageY = () => page.evaluate(() => scrollY);
// a synthetic wheel event on an element: was it swallowed (preventDefault) and where did the strip end up
const fire = (sel, init) => page.evaluate(async ([sel, init]) => {
  const el = document.querySelector(sel), r = el.getBoundingClientRect();
  const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...init });
  el.dispatchEvent(ev); await new Promise(r => setTimeout(r, 600));
  return { swallowed: ev.defaultPrevented, left: document.getElementById('strip').scrollLeft };
}, [sel, init]);
const centre = async sel => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

try {
  await page.goto(origin + '/index.html'); await page.waitForSelector('.card', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready); await sleep(600);
  const geo = await page.evaluate(() => { const s = document.getElementById('strip'); return { max: s.scrollWidth - s.clientWidth, cards: s.querySelectorAll('.card').length }; });
  check('the example strip overflows sideways at 1440x900', geo.max > 200, JSON.stringify(geo));
  // the strip in view, with room for the page to scroll both ways
  await page.evaluate(() => { const s = document.getElementById('strip'); const max = document.documentElement.scrollHeight - innerHeight; scrollTo(0, Math.min(max - 120, Math.max(0, s.getBoundingClientRect().top + scrollY - 400))); }); await sleep(200);
  const room = await page.evaluate(() => [scrollY, document.documentElement.scrollHeight - innerHeight - scrollY]);
  check('test setup: the page can still scroll down from here', room[1] >= 100, JSON.stringify(room));
  await setSl(0);

  // a real mouse wheel over the strip: sideways, the page stays put
  const [sx, sy] = await centre('#strip'); await page.mouse.move(sx, sy);
  const y0 = await pageY();
  await page.mouse.wheel(0, 100); await sleep(600);
  const l1 = await sl();
  check('wheel down over the strip scrolls it right (no Shift), the page does not move', l1 >= 90 && await pageY() === y0, `scrollLeft 0 → ${l1}, page ${y0} → ${await pageY()}`);
  await page.mouse.wheel(0, -100); await sleep(600);
  check('wheel up scrolls it back left', await sl() < l1, `${l1} → ${await sl()}`);
  await page.mouse.wheel(0, 100); await page.mouse.wheel(0, 100); await page.mouse.wheel(0, 100); await sleep(700);
  check('a quick series of notches adds up (glides to one target)', Math.abs(await sl() - 300) <= 2, `→ ${await sl()}`);
  await page.screenshot({ path: `${out}/strip-wheel-1440.png` });

  // the waveform (and anything else) is untouched
  await setSl(120);
  const wf = await fire('#tl-scroll', { deltaY: 100 });
  check('wheel over the waveform: not swallowed, the strip does not move', !wf.swallowed && wf.left === 120, JSON.stringify(wf));
  const ed = await fire('#editor', { deltaY: 100 });
  check('wheel over the shot editor: not swallowed', !ed.swallowed && ed.left === 120, JSON.stringify(ed));

  // trackpad: a sideways swipe stays native (not swallowed, nothing translated)
  const tp = await fire('#strip', { deltaX: 40, deltaY: 12 });
  check('trackpad-like deltaX (|deltaX| >= |deltaY|) is left to the browser', !tp.swallowed && tp.left === 120, JSON.stringify(tp));
  const tp2 = await fire('#strip', { deltaX: 30, deltaY: 30 });
  check('a diagonal swipe (equal deltas) is left alone too', !tp2.swallowed && tp2.left === 120, JSON.stringify(tp2));
  const sh = await fire('#strip', { deltaY: 100, shiftKey: true });
  check('Shift+wheel and pinch-zoom (Ctrl) keep the browser\'s own behaviour', !sh.swallowed && !(await fire('#strip', { deltaY: 100, ctrlKey: true })).swallowed, JSON.stringify(sh));

  // deltaMode: lines count as lines, pages as pages
  await setSl(0); await sleep(300);
  const ln = await fire('#strip', { deltaY: 3, deltaMode: 1 });
  check('deltaMode lines: 3 lines move 120px, not 3px', ln.swallowed && Math.abs(ln.left - 120) <= 1, JSON.stringify(ln));
  await setSl(0); await sleep(300);
  const pg = await fire('#strip', { deltaY: 1, deltaMode: 2 });
  const cw = await page.evaluate(() => document.getElementById('strip').clientWidth);
  check('deltaMode pages: one page moves most of the strip\'s width', pg.swallowed && Math.abs(pg.left - Math.min(geo.max, cw * 0.9)) <= 1, `${JSON.stringify(pg)} width ${cw}`);

  // the ends: the event goes through, so the page scrolls
  await setSl(geo.max); await sleep(300);
  const endR = await fire('#strip', { deltaY: 100 });
  check('at the right end, wheel down is not swallowed (the page scrolls)', !endR.swallowed && Math.abs(endR.left - geo.max) <= 1, JSON.stringify(endR));
  await setSl(0); await sleep(300);
  const endL = await fire('#strip', { deltaY: -100 });
  check('at the left end, wheel up is not swallowed', !endL.swallowed && endL.left === 0, JSON.stringify(endL));
  await setSl(geo.max - 30); await sleep(300);
  const near = await fire('#strip', { deltaY: 100 });
  check('near the end it stops exactly at the end', near.swallowed && Math.abs(near.left - geo.max) <= 1, JSON.stringify(near));
  await setSl(geo.max); await sleep(300); await page.mouse.move(sx, sy);
  const yb = await pageY(); await page.mouse.wheel(0, 100); await sleep(600);
  check('real wheel at the end scrolls the page instead', await pageY() > yb, `page ${yb} → ${await pageY()}`);

  // a strip that fits: nothing to do, nothing swallowed
  await page.setViewportSize({ width: 1440, height: 900 });
  const fits = await page.evaluate(async () => { const s = document.getElementById('strip'), w = s.style.width; s.style.width = s.scrollWidth + 400 + 'px';
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }); s.dispatchEvent(ev); s.style.width = w; return ev.defaultPrevented; });
  check('a strip that does not overflow never swallows the wheel', !fits);

  // keyboard and click still select shots
  await page.evaluate(() => scrollTo(0, 0)); await setSl(0);
  await page.locator('.card').nth(2).click(); await sleep(200);
  check('clicking a card still selects it', await page.evaluate(() => document.querySelectorAll('.card')[2].classList.contains('sel')));
} catch (e) { check('run completed', false, e.stack.split('\n').slice(0, 3).join(' ')); }
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close(); srv.close();
