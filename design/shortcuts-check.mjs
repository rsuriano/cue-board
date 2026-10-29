// The shortcut hint under the strip (one line) and the shortcuts panel it opens (? or the button), and that every
// key and gesture the panel lists does what it says.
//   node design/shortcuts-check.mjs <repo-root> <out-dir>
// The example project, collaboration off (this repo's empty sync URL). Every request outside the local server is
// aborted. Screenshots of the hint and the panel at 1440x900 go to <out-dir>.
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
// the app's test hook (see the end of index.html): __S() is the open project's shots
await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__S = () => window.__CUE_MEDIA_TEST.app.S(); });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));

const isOpen = () => page.evaluate(() => document.getElementById('dlgKeys').open);
const active = () => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
// what the user sees: the timecode (0.1 s), the shots, the selected card, Loop and Play, the waveform's width and scroll
const state = () => page.evaluate(() => ({ t: +document.getElementById('tc').textContent.split(':').reduce((m, x) => m * 60 + +x, 0).toFixed(1), n: __S().length, sel: document.querySelector('.card.sel')?.dataset.id, loop: document.getElementById('loop').getAttribute('aria-pressed') === 'true', playing: document.getElementById('play').textContent.trim() !== 'Play', w: document.getElementById('tl').width, sl: document.getElementById('tl-scroll').scrollLeft }));
// keys go to the page body, the way they would after clicking empty space
const blurAll = () => page.evaluate(() => document.activeElement && document.activeElement.blur());

try {
  await page.goto(origin + '/index.html'); await page.waitForSelector('.card', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready); await sleep(600);

  // ---- the hint: one line, no wrap, nothing cut off; gone below 820
  for (const w of [1920, 1440, 1024, 820]) {
    await page.setViewportSize({ width: w, height: 900 }); await sleep(250);
    const g = await page.evaluate(() => {
      const k = document.getElementById('keys'), r = k.getBoundingClientRect(), lh = parseFloat(getComputedStyle(k).lineHeight);
      const tops = [...k.children].map(c => Math.round(c.getBoundingClientRect().top));
      return { h: Math.round(r.height), lh, rows: new Set(tops).size, over: k.scrollWidth - k.clientWidth, right: Math.round(r.right), vw: innerWidth, items: k.children.length };
    });
    check(`the hint is one line at ${w}px`, g.rows === 1 && g.h <= g.lh + 1 && g.over <= 0 && g.right <= g.vw && g.items === 5, JSON.stringify(g));
  }
  for (const w of [819, 390]) {
    await page.setViewportSize({ width: w, height: 900 }); await sleep(250);
    check(`the hint is hidden at ${w}px`, await page.evaluate(() => getComputedStyle(document.getElementById('keys')).display === 'none'));
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(250);
  const hint = await page.evaluate(() => document.getElementById('keys').textContent.replace(/\s+/g, ' ').trim());
  check('the hint names Space, M, L, ←→ and ?', ['Space play', 'M cut', 'L loop', '←→ step', '? All shortcuts'].every(t => hint.includes(t)), hint);
  await page.locator('#keys').scrollIntoViewIfNeeded(); await sleep(200);
  const kb = await page.locator('#keys').boundingBox();
  await page.screenshot({ path: join(out, 'footer-1440.png'), clip: { x: 0, y: Math.max(0, kb.y - 240), width: 1440, height: 300 } });

  // ---- ? opens, Escape closes, focus goes back
  await page.focus('#loop'); await page.keyboard.press('Shift+Slash'); await sleep(200);
  check('? opens the panel', await isOpen());
  check('focus moves into the panel', await page.evaluate(() => document.getElementById('dlgKeys').contains(document.activeElement)), await active());
  const lab = await page.evaluate(() => { const d = document.getElementById('dlgKeys'); return document.getElementById(d.getAttribute('aria-labelledby'))?.textContent; });
  check('the panel is labelled', lab === 'Shortcuts', lab);
  await page.screenshot({ path: join(out, 'panel-1440.png') });
  // modal: Tab stays inside (or leaves to the browser UI, which reads as body), never reaches the page behind
  let leaked = '';
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); const a = await page.evaluate(() => { const e = document.activeElement; return e === document.body || document.getElementById('dlgKeys').contains(e) ? '' : (e.id || e.tagName); }); if (a) leaked = a; }
  check('Tab does not leave the panel for the page', !leaked, leaked);
  // keys pressed in the panel don't drive the editor
  const s0 = await state();
  await page.keyboard.press('m'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space'); await page.keyboard.press('?'); await sleep(150);
  const s1 = await state();
  check('M, →, Space and ? inside the panel do nothing behind it, and it stays open', s1.n === s0.n && s1.t === s0.t && !s1.playing && await isOpen(), JSON.stringify([s0, s1]));
  await page.focus('#kBody'); await page.keyboard.press('Escape'); await sleep(200);
  check('Escape closes the panel', !(await isOpen()));
  check('focus goes back to where it was', await active() === 'loop', await active());
  check('closing with Escape left loop as it was', (await state()).loop === s0.loop);

  // ---- the hint's button, a click outside, the Close button
  await page.click('#keysb'); await sleep(200);
  check('the hint button opens the panel', await isOpen());
  const db = await page.locator('#dlgKeys').boundingBox();
  await page.mouse.click(Math.max(4, db.x - 20), db.y + 10); await sleep(200);
  check('a click outside closes it', !(await isOpen()));
  check('focus goes back to the hint button', await active() === 'keysb', await active());
  await page.click('#keysb'); await sleep(200); await page.mouse.click(db.x + 40, db.y + db.height - 20); await sleep(150);
  check('a click inside keeps it open', await isOpen());
  await page.click('#kClose'); await sleep(200);
  check('Close closes it', !(await isOpen()));

  // ---- no shortcut fires while typing
  for (const sel of ['#f-title', '#f-notes']) {
    await page.focus(sel); const a = await state(), v0 = await page.inputValue(sel);
    await page.keyboard.type('?ml[] '); await page.keyboard.press('ArrowLeft'); await sleep(200);
    const b = await state();
    check(`typing in ${sel} fires no shortcut`, !(await isOpen()) && a.n === b.n && a.loop === b.loop && a.sel === b.sel && a.playing === b.playing && a.t === b.t, JSON.stringify([a, b]));
    await page.fill(sel, v0); await page.dispatchEvent(sel, 'input');
  }
  await page.keyboard.press('Escape'); await sleep(100);

  // ---- the panel keeps every fact of the old footer, in four sections
  const panel = await page.evaluate(() => document.getElementById('dlgKeys').textContent.replace(/\s+/g, ' '));
  const missing = ['Play / pauseSpace', 'Loop the selected shotL', 'Back / forward 1 s←→', 'Back / forward 5 sShift+←→', 'Cut at the playheadM', 'Previous / next shot[]', 'Move a cutdrag its triangle', 'Swap two shotsdrag a card onto another', 'Slide a shot in betweenit gets half of that slotdrag its card onto an edge or gap', 'Scrubdrag on the waveform', 'Move sidewaysscroll over the waveform', 'ZoomCtrl/⌘+scroll', 'Move along the shotsa mouse wheel works tooscroll over the shot cards', 'Load the songdrop an mp3', 'Media for the selected shotdrop an image, GIF or clip', 'Import a projectdrop a .cueboard.json'].filter(t => !panel.includes(t));
  check('the panel lists every shortcut from the old footer', !missing.length, missing.join(' | '));
  const heads = await page.evaluate(() => [...document.querySelectorAll('#dlgKeys [role=heading]')].map(e => e.textContent));
  check('sections: Playback, Cuts and shots, Timeline, Files', heads.join('|') === 'Playback|Cuts and shots|Timeline|Files', heads.join('|'));

  // ---- each key does what the panel says; time is read from the timecode, 0.1 s precision
  await blurAll(); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await sleep(100);
  let a = await state();
  await page.keyboard.press('ArrowRight'); let b = await state();
  check('→ moves 1 s forward', Math.abs(b.t - a.t - 1) < .05, `${a.t} → ${b.t}`);
  await page.keyboard.press('ArrowLeft'); a = await state();
  check('← moves 1 s back', Math.abs(b.t - a.t - 1) < .05, `${b.t} → ${a.t}`);
  await page.keyboard.press('Shift+ArrowRight'); b = await state();
  check('Shift+→ moves 5 s forward', Math.abs(b.t - a.t - 5) < .05, `${a.t} → ${b.t}`);
  await page.keyboard.press('Shift+ArrowLeft'); a = await state();
  check('Shift+← moves 5 s back', Math.abs(b.t - a.t - 5) < .05, `${b.t} → ${a.t}`);

  a = await state(); await page.keyboard.press('l'); await sleep(100); b = await state();
  check('L toggles the loop', b.loop === !a.loop, `${a.loop} → ${b.loop}`);
  await page.keyboard.press('l'); await sleep(100);

  const selIdx = () => page.evaluate(() => __S().findIndex(s => s.id === document.querySelector('.card.sel')?.dataset.id));
  // the first ] goes to the shot after the one under the playhead and puts the playhead at its start
  await page.keyboard.press(']'); await sleep(150);
  const iA = await selIdx(); await page.keyboard.press(']'); await sleep(150);
  const iB = await selIdx(); await page.keyboard.press('['); await sleep(150);
  const iC = await selIdx();
  check('] selects the next shot, [ the previous one', iB === iA + 1 && iC === iA, `${iA} → ${iB} → ${iC}`);

  // M: a cut where the playhead is ([ put it at the start of the shot; 1 s in is away from its edges)
  await page.keyboard.press('ArrowRight'); await sleep(100);
  a = await state();
  await page.keyboard.press('m'); await sleep(200); b = await state();
  const at = await page.evaluate(t => __S().map(s => s.start).filter(x => Math.abs(x - t) < .1), a.t);
  check('M adds a cut at the playhead', b.n === a.n + 1 && at.length === 1, `${a.n} → ${b.n} at ${a.t}: ${at}`);
  a = await state(); await page.keyboard.press('Space'); await sleep(400); b = await state();
  await page.keyboard.press('Space'); await sleep(200); const c = await state();
  check('Space plays and pauses', !a.playing && b.playing && !c.playing && c.t > a.t, JSON.stringify([a, b, c].map(x => [x.playing, x.t])));

  // the waveform: wheel moves sideways, Ctrl + wheel zooms
  await page.locator('#tl-scroll').scrollIntoViewIfNeeded();
  const tb = await page.locator('#tl-scroll').boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  a = await state(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -400); await page.keyboard.up('Control'); await sleep(250); b = await state();
  check('Ctrl + scroll over the waveform zooms', b.w > a.w, `${a.w} → ${b.w}`);
  await page.evaluate(() => { document.getElementById('tl-scroll').scrollLeft = 0; }); a = await state();
  await page.mouse.wheel(0, 300); await sleep(250); b = await state();
  check('scroll over the waveform moves sideways', b.sl > a.sl, `${a.sl} → ${b.sl}`);
  await page.click('#zfit'); await sleep(200);
  // where the cuts are: the cursor turns into ew-resize over a triangle
  const free = await page.evaluate(() => {
    const cv = document.getElementById('tl'), r = cv.getBoundingClientRect(), y = r.top + r.height * .7, xs = [];
    for (let x = Math.ceil(r.left) + 2; x < r.right - 2; x += 2) { cv.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true })); if (cv.style.cursor === 'ew-resize') xs.push(x); }
    return { xs, y, left: r.left, right: r.right };
  });
  // dragging on the waveform scrubs (between cuts, so it doesn't grab a triangle)
  const clear = (x0, x1) => free.xs.every(x => x < x0 - 10 || x > x1 + 10);
  let sx = free.left + 40; while (sx < free.right - 200 && !clear(sx, sx + 120)) sx += 10;
  a = await state();
  await page.mouse.move(sx, free.y); await page.mouse.down(); await sleep(50); const down = await state();
  await page.mouse.move(sx + 120, free.y, { steps: 6 }); await sleep(50); await page.mouse.up(); b = await state();
  check('dragging on the waveform scrubs', b.t > down.t + .5 && b.n === a.n, `${down.t} → ${b.t}`);
  // dragging a triangle moves that cut: the middle of the first ew-resize run is the first cut
  const run = free.xs.filter(x => x < (free.xs[0] || 0) + 16), grab = run[Math.floor(run.length / 2)];
  const c0 = await page.evaluate(() => __S().map(s => s.start));
  await page.mouse.move(grab, free.y); await page.mouse.down(); await page.mouse.move(grab + 40, free.y, { steps: 6 }); await page.mouse.up(); await sleep(200);
  const c1 = await page.evaluate(() => __S().map(s => s.start));
  check('dragging a triangle moves the cut', !!grab && c1[1] > c0[1] + .1 && c1.length === c0.length && c1[2] === c0[2], `${c0.slice(0, 3)} → ${c1.slice(0, 3)}`);
  // a card dropped on the middle of another swaps them; on an edge it slides in and gets half of that slot
  const ids = () => page.evaluate(() => __S().map(s => s.id));
  const drag = async (from, to, rx) => {
    const f = await page.locator('.card').nth(from).boundingBox(), t = await page.locator('.card').nth(to).boundingBox();
    await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2); await page.mouse.down();
    await page.mouse.move(t.x + t.width * rx, t.y + t.height / 2, { steps: 10 }); await sleep(100); await page.mouse.up(); await sleep(300);
  };
  await page.locator('#strip').scrollIntoViewIfNeeded(); await page.evaluate(() => { document.getElementById('strip').scrollLeft = 0; }); await sleep(100);
  let o0 = await ids(); await drag(0, 2, .5); let o1 = await ids();
  check('a card dropped on the middle of another swaps the two', o1[0] === o0[2] && o1[2] === o0[0] && o1[1] === o0[1] && o1.length === o0.length, JSON.stringify([o0.slice(0, 3), o1.slice(0, 3)]));
  o0 = await ids(); const slot = await page.evaluate(() => { const s = __S(); return [s[2].start, s[3].start]; });
  await drag(0, 3, .05); o1 = await ids();
  const half = await page.evaluate(id => { const s = __S(), i = s.findIndex(x => x.id === id); return [s[i].start, s[i + 1].start]; }, o0[0]);
  check('a card dropped on an edge slides in and gets half of that slot', o1.indexOf(o0[0]) === 2 && Math.abs(half[1] - half[0] - (slot[1] - slot[0]) / 2) < .05, JSON.stringify({ o0: o0.slice(0, 4), o1: o1.slice(0, 4), slot, half }));
  console.log('NOTE not verified here: the strip wheel (strip-wheel-check.mjs covers it), dropping files');
} catch (e) { check('ran without throwing', false, e.stack); }

check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close(); srv.close();
const fails = results.filter(r => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
