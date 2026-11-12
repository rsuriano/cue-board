// Selection controls in the transport row, visible range handles on the ruler, Space always plays
// (docs/specs/selection-controls.md), one block per approval criterion 1-9 (10 is the other suites, run separately),
// then the hostile cases: Space keyup landing elsewhere, key repeat, a song replaced by a shorter one and the undo,
// a handle dragged past the other one, a long time at narrow widths. Screenshots go to <out-dir>
// (design/out/selection/ by convention).
//   node design/selection-check.mjs <repo-root> <out-dir>
// Paths: CUE_TESTKIT (a folder with playwright-core) and CUE_CHROMIUM override the defaults below
// (design/run-local.mjs sets both from ~/testkit and ~/.cache/ms-playwright).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.CUE_TESTKIT || '/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>blank</title>'); return; }
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [], foreign = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const section = async (name, fn) => { try { await fn(); } catch (e) { check(name + ': ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' ')); } };
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

function wav(sec, rate = 8000) { const n = Math.round(sec * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 330) * 6000), 44 + i * 2); return b; }
const sec = (id, start, o = {}) => ({ id, start, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', kind: '', clipDur: 0, takes: [], ...o });
function fixture(o = {}) {
  const d = o.dur || 6, song = wav(d, o.rate || 8000);
  return { format: 'cueboard', version: 1, exportedAt: '2026-01-01T00:00:00.000Z',
    project: { id: o.id || 'p-sel', title: o.title || 'Selection', created: 1, updated: 1, song: { name: 'tone.wav', duration: d, peaks: [] },
      sections: [sec('s1', 0, { title: 'One' }), sec('s2', 2, { title: 'Two' }), sec('s3', 4, { title: 'Three' })] },
    media: {}, song: { name: 'tone.wav', type: 'audio/wav', data: 'data:audio/wav;base64,' + song.toString('base64') } };
}

/* ---------- pages ---------- */
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...opts });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob):/.test(u)) return r.continue(); foreign.push(u); return r.abort(); });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(t)) errs.push(t); });
  page.on('pageerror', e => errs.push(e.message));
  return { ctx, page };
}
async function open(p) { await p.page.goto(origin + '/index.html'); await p.page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await p.page.evaluate(() => document.fonts.ready); await sleep(500); }
async function load(p, file) {
  await p.page.setInputFiles('#importf', { name: 'fixture.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.page.waitForFunction(([id, n]) => { const a = __A(); return a.cur() && a.cur().id === id && a.S().length === n && !document.getElementById('play').disabled; }, [file.project.id, file.project.sections.length], { timeout: 20000 });
  await sleep(400); await p.page.evaluate(() => document.activeElement && document.activeElement.blur());
}
const marks = page => page.evaluate(() => { const m = __A().io(); return [m.in, m.out]; });
const fields = page => page.evaluate(() => [document.getElementById('ioIn')?.value, document.getElementById('ioOut')?.value]);
const seekTo = (page, t) => page.evaluate(t => { const a = document.getElementById('audio'), p = new Promise(r => { a.addEventListener('seeked', () => r(), { once: true }); setTimeout(r, 800); }); __A().seek(t); return p; }, t);
const now = page => page.evaluate(() => document.getElementById('audio').currentTime);
const paused = page => page.evaluate(() => document.getElementById('audio').paused);
const pause = page => page.evaluate(() => document.getElementById('audio').pause());
const clearMarks = page => page.evaluate(() => __A().ioSet());
const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
const dlgOpen = page => page.evaluate(() => !!document.querySelector('dialog[open]'));
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
/* the desktop ruler: a time's x on screen, at the ruler's middle */
const ruler = page => page.evaluate(() => { const c = document.getElementById('tl'), r = c.getBoundingClientRect(), s = document.getElementById('tl-scroll').getBoundingClientRect(); return { left: r.left, w: r.width, top: r.top, vl: s.left, vr: s.right }; });
const tx = (R, d, t) => R.left + R.w * t / d;
async function drag(page, x0, x1, y) { await page.mouse.move(x0, y); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (x1 - x0) * i / 8, y); await page.mouse.up(); await sleep(150); }
const cursorAt = (page, x, y) => page.mouse.move(x, y).then(() => sleep(30)).then(() => page.$eval('#tl', c => c.style.cursor || getComputedStyle(c).cursor));
/* ruler pixel (device px) at css x, y: [r,g,b] */
const px = (page, x, y) => page.evaluate(([x, y]) => { const c = document.getElementById('tl'), k = c.width / c.getBoundingClientRect().width; return [...c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data].slice(0, 3); }, [x, y]);
/* the row's layout: each control's box, the row's box, overflow */
const layout = page => page.evaluate(() => {
  const tr = document.querySelector('.transport'), R = tr.getBoundingClientRect(), box = e => { if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const kids = [...tr.children].filter(e => !e.classList.contains('grow') && e.getClientRects().length && e.getBoundingClientRect().width > 0).map(e => ({ id: e.id || e.className, ...box(e) }));
  const clipped = [...tr.querySelectorAll('input,button,select,span,kbd')].filter(e => e.getClientRects().length && (e.scrollWidth > e.clientWidth + 1) && e.tagName !== 'SELECT').map(e => e.id || e.className);
  return { row: box(tr), sw: tr.scrollWidth, cw: tr.clientWidth, kids, speed: box(document.getElementById('speed')), sel: box(document.getElementById('iosel')), zoom: box(document.querySelector('.transport .seg[aria-label="Timeline zoom"]')),
    len: box(document.getElementById('ioLen')), kbdI: box(document.querySelector('#ioInB kbd')), clipped, docw: document.documentElement.scrollWidth, vw: innerWidth };
});
const shootRow = async (page, name) => { await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 4000 }).catch(() => {}); await page.locator('.transport').screenshot({ path: `${out}/${name}.png` }); };
const shootRuler = async (page, name) => { await page.mouse.move(5, 5); await sleep(50); await page.locator('.timeline').screenshot({ path: `${out}/${name}.png` }); };

try {
  const D = await newPage(); await open(D); await load(D, fixture()); const page = D.page, d = 6;

  /* ======== 1: order at 1440 / 1180 / 960; no overflow or wrap at 820-1440 ======== */
  await section('1 layout', async () => {
    for (const w of [1440, 1180, 960, 820]) {
      await page.setViewportSize({ width: w, height: 900 }); await sleep(250);
      for (const st of ['none', 'full']) {
        if (st === 'full') await page.evaluate(() => { const a = __A(); a.ioSet('in', 1.2); a.ioSet('out', 4.7); }); else await clearMarks(page);
        await sleep(120); const L = await layout(page);
        const order = !!(L.speed && L.sel && L.zoom) && L.speed.r <= L.sel.l && L.sel.r <= L.zoom.l;
        const last = !!L.zoom && L.kids.every(k => k.r <= L.zoom.r + .5) && L.zoom.r <= L.row.r + .5;
        const oneRow = L.kids.every(k => Math.abs(k.t - L.row.t) < 2 && k.b <= L.row.t + 34) && L.row.b - L.row.t <= 34;
        if (w !== 820) check(`1 · ${w}, ${st}: Selection sits between speed and zoom; zoom is last and inside the row`, order && last, JSON.stringify({ speed: L.speed, sel: L.sel, zoom: L.zoom, row: L.row }));
        check(`1 · ${w}, ${st}: one row, no overflow, nothing clipped`, oneRow && L.sw <= L.cw + 1 && L.docw <= L.vw && last && !L.clipped.length, JSON.stringify({ h: L.row.b - L.row.t, sw: L.sw, cw: L.cw, clipped: L.clipped, kids: L.kids.map(k => [k.id, Math.round(k.l), Math.round(k.r), Math.round(k.t)]) }));
        if (st === 'full' && w === 1440) check('1 · 1440, full selection: the length shows after Out in dim text', !!L.len && (await page.$eval('#ioLen', e => e.textContent.trim())) === '3.5s', JSON.stringify(L.len));
      }
    }
    /* Copy shot list leaves the row below 1100 and is in More instead (the app bar's pattern) */
    const more = async () => { await page.click('#moreb'); await page.waitForSelector('#moremenu:not([hidden])'); await sleep(100); const v = await vis(page, '#mCopyl'); await page.keyboard.press('Escape'); await sleep(100); return v; };
    await page.setViewportSize({ width: 960, height: 900 }); await sleep(250);
    check('1 · 960: Copy shot list is in More, not in the row', !(await vis(page, '#copylist')) && await more());
    await page.setViewportSize({ width: 1440, height: 900 }); await sleep(250);
    check('1 · 1440: Copy shot list is in the row, not in More', await vis(page, '#copylist') && !(await more()));
    await page.evaluate(() => document.activeElement && document.activeElement.blur()); await clearMarks(page);
  });

  /* ======== 2: set-from-playhead equals I / O; Clear equals Alt+X and shows only with a mark ======== */
  await section('2 buttons', async () => {
    const hints = await page.evaluate(() => { const k = s => document.querySelector(s), cs = e => { const c = getComputedStyle(e); return [c.font, c.color, c.borderColor, c.height, c.backgroundColor].join('|'); };
      const ico = b => { const u = b && b.querySelector('svg.ico use'), s = u && document.querySelector(u.getAttribute('href')); return !!s && s.getAttribute('viewBox') === '0 0 16 16' && getComputedStyle(b.querySelector('svg.ico')).strokeWidth === '1.5px' && getComputedStyle(b.querySelector('svg.ico')).width === '16px'; };
      return { i: k('#ioInB kbd')?.textContent, o: k('#ioOutB kbd')?.textContent, same: !!k('#ioInB kbd') && cs(k('#ioInB kbd')) === cs(k('#mark kbd')) && cs(k('#ioOutB kbd')) === cs(k('#mark kbd')),
        icons: ico(k('#ioInB')) && ico(k('#ioOutB')) && ico(k('#ioClr')), names: [k('#ioInB')?.getAttribute('aria-label'), k('#ioOutB')?.getAttribute('aria-label'), k('#ioClr')?.getAttribute('aria-label')] }; });
    check('2 · I and O key hints on the set buttons, styled like M on Cut', hints.i === 'I' && hints.o === 'O' && hints.same, JSON.stringify(hints));
    check('2 · set and clear icons from the 16px sprite, 1.5px stroke; each button has a name', hints.icons && hints.names.every(Boolean), JSON.stringify(hints.names));
    check('2 · no mark: Clear is hidden', !(await vis(page, '#ioClr')));
    await seekTo(page, 1); await page.click('#ioInB'); await seekTo(page, 3); await page.click('#ioOutB'); await sleep(80);
    const byBtn = await marks(page); await clearMarks(page);
    await page.evaluate(() => document.activeElement.blur());
    await seekTo(page, 1); await page.keyboard.press('i'); await seekTo(page, 3); await page.keyboard.press('o'); await sleep(80);
    const byKey = await marks(page);
    check('2 · the set buttons give the same marks as I and O', JSON.stringify(byBtn) === JSON.stringify(byKey) && byKey[0] === 1 && byKey[1] === 3, JSON.stringify({ byBtn, byKey }));
    check('2 · with a mark: Clear shows', await vis(page, '#ioClr'));
    await page.click('#ioClr'); await sleep(80);
    const c1 = await marks(page), hid = !(await vis(page, '#ioClr'));
    await page.evaluate(() => { const a = __A(); a.ioSet('in', 1); a.ioSet('out', 3); document.activeElement.blur(); }); await page.keyboard.press('Alt+KeyX'); await sleep(80);
    check('2 · Clear does what Alt+X does (both marks gone) and hides again', JSON.stringify(c1) === '[null,null]' && JSON.stringify(await marks(page)) === '[null,null]' && hid, JSON.stringify(c1));
    await page.evaluate(() => __A().ioSet('in', 2)); await sleep(60);
    check('2 · In only: Clear shows', await vis(page, '#ioClr')); await clearMarks(page);
  });

  /* ======== 3: typing times ======== */
  await section('3 typing', async () => {
    await page.click('#ioIn'); await page.keyboard.type('0:01.5'); await page.keyboard.press('Enter'); await sleep(80);
    check('3 · In "0:01.5" + Enter sets the In mark', (await marks(page))[0] === 1.5 && (await fields(page))[0] === '0:01.5', JSON.stringify([await marks(page), await fields(page)]));
    await page.click('#ioOut'); await page.keyboard.type('4'); await page.keyboard.press('Tab'); await sleep(80);
    check('3 · Out "4" (seconds) + leaving the field sets the Out mark', (await marks(page))[1] === 4 && (await fields(page))[1] === '0:04.0', JSON.stringify([await marks(page), await fields(page)]));
    await page.setViewportSize({ width: 1440, height: 900 }); await shootRow(page, 'row-full-1440');
    for (const [f, v, why] of [['#ioIn', '1:60', 'seconds past 59'], ['#ioIn', 'abc', 'not a time'], ['#ioOut', '0:09', 'past the song\'s end'], ['#ioOut', '1', 'Out before In'], ['#ioIn', '5', 'In after Out'], ['#ioIn', '4', 'In equal to Out']]) {
      const before = await marks(page);
      await page.click(f, { clickCount: 3 }); await page.keyboard.type(v); await page.keyboard.press('Enter'); await sleep(80);
      const st = await page.$eval(f, e => ({ inv: e.getAttribute('aria-invalid'), focus: document.activeElement === e, msg: e.title || e.getAttribute('aria-description') || '' }));
      check(`3 · ${f.slice(3)} "${v}" (${why}) is refused inline: marks unchanged, field keeps focus, aria-invalid, says why`, JSON.stringify(await marks(page)) === JSON.stringify(before) && st.inv === 'true' && st.focus && !!st.msg, JSON.stringify({ st, m: await marks(page) }));
      if (v === '1') { await page.setViewportSize({ width: 1440, height: 900 }); await shootRow(page, 'row-invalid-1440');
        await page.setViewportSize({ width: 1180, height: 900 }); await sleep(150); await shootRow(page, 'row-invalid-1180');
        await page.setViewportSize({ width: 960, height: 900 }); await sleep(150); await shootRow(page, 'row-invalid-960'); await page.setViewportSize({ width: 1440, height: 900 }); }
      await page.keyboard.press('Tab'); await sleep(120);
      const kept = await page.$eval(f, e => document.activeElement === e);
      check(`3 · ${f.slice(3)} "${v}": leaving the field is refused too (focus comes back, marks unchanged)`, kept && JSON.stringify(await marks(page)) === JSON.stringify(before), String(kept));
      await page.keyboard.press('Escape'); await sleep(60);
      const back = await page.$eval(f, e => ({ v: e.value, inv: e.getAttribute('aria-invalid') }));
      check(`3 · ${f.slice(3)} "${v}": Escape brings the old value back and clears the error`, back.v === (f === '#ioIn' ? fmt(before[0]) : fmt(before[1])) && back.inv !== 'true', JSON.stringify(back));
      await page.evaluate(() => document.activeElement.blur());
    }
    await page.fill('#ioOut', ''); await page.focus('#ioOut'); await page.keyboard.press('Enter'); await sleep(80);
    check('3 · clearing Out + Enter removes only the Out mark', JSON.stringify(await marks(page)) === '[1.5,null]' && (await fields(page))[1] === '', JSON.stringify(await marks(page)));
    await page.click('#ioIn', { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.keyboard.press('Tab'); await sleep(80);
    check('3 · clearing In + leaving removes the In mark', JSON.stringify(await marks(page)) === '[null,null]', JSON.stringify(await marks(page)));
    const ph = await page.$eval('#ioIn', e => [e.placeholder, document.getElementById('ioOut').placeholder, getComputedStyle(e).fontFamily, getComputedStyle(e).fontVariantNumeric]);
    check('3 · empty fields show the placeholders In / Out, mono tabular', ph[0] === 'In' && ph[1] === 'Out' && /Mono/i.test(ph[2]) && /tabular-nums/.test(ph[3]), JSON.stringify(ph));
    await page.evaluate(() => document.activeElement.blur());
  });

  /* ======== 4: fields follow the marks ======== */
  await section('4 fields follow', async () => {
    await seekTo(page, 2); await page.keyboard.press('i'); await sleep(60);
    check('4 · I at 2 s shows 0:02.0 in the In field', (await fields(page))[0] === '0:02.0', JSON.stringify(await fields(page)));
    const R = await ruler(page); await drag(page, tx(R, d, 2), tx(R, d, 1), R.top + 10);
    const m = await marks(page), f = await fields(page);
    check('4 · dragging the In handle updates the In field', m[0] != null && Math.abs(m[0] - 1) < .1 && f[0] === fmt(m[0]), JSON.stringify({ m, f }));
    await seekTo(page, 5); await page.keyboard.press('o'); await sleep(60);
    await page.keyboard.press('m'); await sleep(80); await page.evaluate(() => __A().doUndo('undo')); await sleep(150);
    check('4 · after an undo the fields still show the marks', JSON.stringify(await fields(page)) === JSON.stringify([fmt((await marks(page))[0]), '0:05.0']), JSON.stringify(await fields(page)));
    /* a shorter song: the fields show the marks clamped to it, the way the render reads them; undo brings them back */
    await page.setInputFiles('#song', { name: 'short.wav', mimeType: 'audio/wav', buffer: wav(3) });
    await page.waitForFunction(() => Math.abs(__A().cur().song.duration - 3) < .05, null, { timeout: 15000 }); await sleep(300);
    const sf = await fields(page), sm = await marks(page);
    check('4 · song replaced by a 3 s one: Out reads 0:04.5 (clamped to the song, which runs to the last cut + 0.5 s), In unchanged', sf[0] === fmt(sm[0]) && sf[1] === '0:04.5', JSON.stringify({ sf, sm }));
    await page.evaluate(() => __A().doUndo('undo')); await page.waitForFunction(() => Math.abs(__A().cur().song.duration - 6) < .05, null, { timeout: 15000 }); await sleep(300);
    check('4 · undoing the replace: Out reads 0:05.0 again', (await fields(page))[1] === '0:05.0', JSON.stringify(await fields(page)));
    const keep = await fields(page);
    await load(D, fixture({ id: 'p-other', title: 'Other' }));
    check('4 · switching to a project without marks empties both fields and hides Clear', JSON.stringify(await fields(page)) === '["",""]' && !(await vis(page, '#ioClr')), JSON.stringify(await fields(page)));
    await page.click('#proj'); await page.waitForSelector('#projmenu:not([hidden])'); await sleep(150);
    await page.click('#projmenu .mi:has-text("Selection")'); await page.waitForFunction(() => __A().cur().id === 'p-sel'); await sleep(400);
    check('4 · switching back shows that project\'s marks again', JSON.stringify(await fields(page)) === JSON.stringify(keep), JSON.stringify([await fields(page), keep]));
    await page.evaluate(() => document.activeElement && document.activeElement.blur()); await clearMarks(page);
  });

  /* ======== 5: resting handles, drag to create; the dialog agrees ======== */
  await section('5 resting handles', async () => {
    await page.setViewportSize({ width: 1440, height: 900 }); await sleep(200); await seekTo(page, 3);
    const R = await ruler(page), bg = await px(page, R.w / 2 + 30, 2);
    const a = await px(page, 0.5, 10), b = await px(page, R.w - 1, 10);
    check('5 · no marks: a handle is drawn at each end of the ruler', JSON.stringify(a) !== JSON.stringify(bg) && JSON.stringify(b) !== JSON.stringify(bg), JSON.stringify({ a, b, bg }));
    const cur = [await cursorAt(page, R.left + 1, R.top + 10), await cursorAt(page, R.left + 11, R.top + 10), await cursorAt(page, R.left + R.w - 2, R.top + 10), await cursorAt(page, R.left + R.w - 12, R.top + 10)];
    check('5 · resting handles: ≥ 12px hit area each, ew-resize cursor', cur.every(c => c === 'ew-resize'), JSON.stringify(cur));
    await shootRuler(page, 'ruler-resting-1440');
    await drag(page, R.left + 3, tx(R, d, 2), R.top + 10);
    let m = await marks(page);
    check('5 · dragging the start handle from rest creates In (≈ 2 s), Out stays open', m[0] != null && Math.abs(m[0] - 2) < .1 && m[1] == null, JSON.stringify(m));
    await drag(page, R.left + R.w - 3, tx(R, d, 4.5), R.top + 10);
    m = await marks(page);
    check('5 · dragging the end handle from rest sets Out (≈ 4.5 s)', Math.abs(m[1] - 4.5) < .1, JSON.stringify(m));
    const cur2 = [await cursorAt(page, tx(R, d, m[0]) - 6, R.top + 10), await cursorAt(page, tx(R, d, m[0]) + 6, R.top + 10), await cursorAt(page, tx(R, d, m[1]) - 6, R.top + 10), await cursorAt(page, tx(R, d, m[1]) + 6, R.top + 10)];
    check('5 · with marks: ≥ 12px hit area around each handle, ew-resize', cur2.every(c => c === 'ew-resize'), JSON.stringify(cur2));
    await shootRuler(page, 'ruler-selection-1440');
    await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(200);
    const dl = await page.evaluate(() => { const i = document.querySelector('#dlgRender input[name="rnRange"][value="sel"]'); return { dis: i.disabled, t: document.getElementById('rnSelT').textContent }; });
    check('5 · the render dialog enables Current selection with the same times', !dl.dis && dl.t.startsWith(`${fmt(m[0])} to ${fmt(m[1])}`), JSON.stringify(dl));
    await page.click('#rnCancel'); await sleep(150);
    /* a handle dragged past the other one stops short of it */
    await drag(page, tx(R, d, m[0]), tx(R, d, 5.5), R.top + 10);
    const m2 = await marks(page);
    check('5 · In dragged past Out stops short of it; Out unchanged', m2[0] < m2[1] && m2[1] === m[1], JSON.stringify(m2));
    await drag(page, tx(R, d, m2[0]), R.left - 30, R.top + 10);
    check('5 · In dragged back past the start is unset', (await marks(page))[0] === null, JSON.stringify(await marks(page)));
    await clearMarks(page);
  });

  /* ======== 6: dragging a handle neither seeks nor moves a shot or a cut ======== */
  await section('6 no seek', async () => {
    await page.evaluate(() => __A().ioSet('in', 2)); await seekTo(page, 0.5);
    const R = await ruler(page), before = await page.evaluate(() => ({ starts: __A().S().map(s => s.start), sel: document.querySelector('.card.sel')?.dataset.id }));
    await drag(page, tx(R, d, 2), tx(R, d, 3), R.top + 10);
    const after = await page.evaluate(() => ({ starts: __A().S().map(s => s.start), sel: document.querySelector('.card.sel')?.dataset.id }));
    check('6 · dragging the In handle (sitting on a cut) leaves the playhead, the cuts and the selected shot alone', Math.abs(await now(page) - .5) < .05 && JSON.stringify(after) === JSON.stringify(before) && Math.abs((await marks(page))[0] - 3) < .1, JSON.stringify({ before, after, now: await now(page) }));
    await drag(page, R.left + R.w - 3, tx(R, d, 4.2), R.top + 10);
    check('6 · dragging the resting end handle doesn\'t seek either', Math.abs(await now(page) - .5) < .05, String(await now(page)));
    await clearMarks(page);
  });

  /* ======== 7: hint texts ======== */
  await section('7 hints', async () => {
    await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(150);
    const h = await page.$eval('#rnSelHint', e => e.getClientRects().length ? e.textContent.trim() : '');
    check('7 · desktop hint', h === 'Set In and Out in the bar above the timeline, or press I and O', h);
    await page.click('#rnCancel'); await sleep(150);
    const M = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await open(M); await load(M, fixture());
    await M.page.click('#proj'); await M.page.waitForSelector('#mProj[open]'); await sleep(250); await M.page.click('#mRender'); await M.page.waitForSelector('#dlgRender[open]'); await sleep(200);
    const hp = await M.page.$eval('#rnSelHint', e => e.getClientRects().length ? e.textContent.trim() : '');
    check('7 · phone hint', hp === 'Drag the two handles on the timeline\'s ruler', hp);
    check('5 · phone: no Selection group in the transport (the phone keeps its own handles)', !(await vis(M.page, '#iosel')));
    await M.ctx.close();
  });

  /* ======== 8: Space plays after clicking things ======== */
  const spaceToggles = async (label, prep, extra) => {
    await pause(page); await sleep(60); await prep(); await sleep(120);
    const b = await paused(page); await page.keyboard.press('Space'); await sleep(250); const a = await paused(page);
    const x = extra ? await extra() : true;
    check(`8 · Space toggles play after ${label}`, b === true && a === false && x === true, JSON.stringify({ b, a, x, focus: await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName) }));
    await pause(page);
  };
  await section('8 Space plays', async () => {
    await seekTo(page, 1);
    const n0 = await page.evaluate(() => __A().S().length);
    await spaceToggles('clicking Cut', () => page.click('#mark'), async () => (await page.evaluate(() => __A().S().length)) === n0 + 1);
    await page.evaluate(() => __A().doUndo('undo')); await sleep(100);
    await spaceToggles('clicking Loop shot', () => page.click('#loop'), async () => (await page.$eval('#loop', e => e.getAttribute('aria-pressed'))) === 'true');
    await page.click('#loop'); await page.evaluate(() => document.activeElement.blur());
    await spaceToggles('clicking zoom in', () => page.click('#zin'));
    await spaceToggles('clicking Render and closing the dialog again', async () => { await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(150); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('dlgRender').open); },
      async () => !(await dlgOpen(page)));
    await spaceToggles('clicking a shot in the strip', () => page.click('.card:nth-child(2)'));
    await spaceToggles('focusing the speed select (closed)', () => page.focus('#speed'), async () => (await page.$eval('#speed', e => e.value)) === '1');
    await spaceToggles('clicking the set-In button', () => page.click('#ioInB'));
    await clearMarks(page);
    await spaceToggles('focusing the project menu button (closed)', () => page.focus('#proj'), async () => (await page.$eval('#projmenu', e => e.hidden)) === true);
    await page.evaluate(() => document.activeElement.blur());
  });

  /* ======== 9: where Space doesn't play; Space doesn't press a button; Enter does ======== */
  await section('9 Space stays', async () => {
    const stays = async (label, prep, extra) => { await pause(page); await prep(); await sleep(100); await page.keyboard.press('Space'); await sleep(250);
      check(`9 · Space doesn't toggle ${label}`, (await paused(page)) === true && (extra ? await extra() : true), JSON.stringify({ focus: await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName) }));
      await page.keyboard.press('Escape').catch(() => {}); await page.evaluate(() => document.activeElement && document.activeElement.blur()); await sleep(100); };
    await stays('while typing in the In field', () => page.click('#ioIn'), async () => (await page.$eval('#ioIn', e => e.value)) === ' ');
    await page.fill('#ioIn', ''); await clearMarks(page);
    await stays('while typing in the shot title', () => page.click('#f-title'));
    await stays('while typing in the shot notes', () => page.click('#f-notes'));
    await page.evaluate(() => __A().doUndo('undo')); await sleep(100); await page.evaluate(() => __A().doUndo('undo')); await sleep(100);
    await stays('with the render dialog open', async () => { await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); });
    await stays('with the keys panel open', async () => { await page.click('#keysb'); await page.waitForSelector('#dlgKeys[open]'); });
    await stays('inside the open project menu', async () => { await page.click('#proj'); await page.waitForSelector('#projmenu:not([hidden])'); await sleep(100); });
    await stays('inside the open More menu', async () => { await page.click('#moreb'); await page.waitForSelector('#moremenu:not([hidden])'); await sleep(100); });
    /* Space on a focused button: playback, not the button */
    await pause(page); await page.focus('#loop'); await page.keyboard.press('Space'); await sleep(200);
    check('9 · Space on a focused Loop shot doesn\'t press it', (await page.$eval('#loop', e => e.getAttribute('aria-pressed'))) === 'false' && !(await paused(page)));
    await pause(page); await page.focus('#loop'); await page.keyboard.press('Enter'); await sleep(150);
    check('9 · Enter on a focused Loop shot still presses it', (await page.$eval('#loop', e => e.getAttribute('aria-pressed'))) === 'true' && (await paused(page)));
    await page.keyboard.press('Enter'); await sleep(100);
    await page.focus('#renderb'); await page.keyboard.press('Space'); await sleep(250);
    check('9 · Space on a focused Render doesn\'t open the dialog (plays)', !(await dlgOpen(page)) && !(await paused(page)));
    await pause(page); await page.focus('#renderb'); await page.keyboard.press('Enter'); await sleep(250);
    check('9 · Enter on a focused Render opens the dialog', await dlgOpen(page)); await page.keyboard.press('Escape'); await sleep(150);
    /* keydown on one button, keyup on another: neither is pressed */
    await pause(page); const n0 = await page.evaluate(() => __A().S().length);
    await page.focus('#loop'); await page.keyboard.down('Space'); await page.focus('#mark'); await page.keyboard.up('Space'); await sleep(200);
    check('9 · Space down on Loop shot, up on Cut: no loop, no cut', (await page.$eval('#loop', e => e.getAttribute('aria-pressed'))) === 'false' && (await page.evaluate(() => __A().S().length)) === n0, String(await page.evaluate(() => __A().S().length)));
    await pause(page);
    /* a held Space: one toggle, not one per repeat */
    await page.evaluate(() => document.activeElement.blur()); await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.up('Space'); await sleep(250);
    check('9 · a held Space toggles once (repeats ignored)', !(await paused(page)));
    await pause(page);
    /* a summary (details) on side A: Space plays and doesn't open or close it */
    const sum = await page.evaluate(() => { const s = [...document.querySelectorAll('#sideA summary')].find(x => x.getClientRects().length); if (!s) return null; s.focus(); return s.parentNode.open; });
    if (sum !== null) { await page.keyboard.press('Space'); await sleep(250); check('9 · Space on a summary plays and leaves its details as they were', !(await paused(page)) && (await page.evaluate(() => document.activeElement.parentNode.open)) === sum); await pause(page); }
  });

  /* ======== screenshots: no marks, In only at three widths; long times at narrow widths ======== */
  await section('screens', async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    for (const w of [1440, 1180, 960]) {
      await page.setViewportSize({ width: w, height: 900 }); await sleep(200);
      await clearMarks(page); await shootRow(page, `row-none-${w}`);
      await page.evaluate(() => __A().ioSet('in', 1.2)); await shootRow(page, `row-in-${w}`);
      await page.evaluate(() => __A().ioSet('out', 4.7)); await shootRow(page, `row-full-${w}`);
    }
    await clearMarks(page); await page.setViewportSize({ width: 1440, height: 900 });
  });
  /* close-ups at 2x: the group and the ruler's two ends, resting and with a selection */
  await section('close-ups', async () => {
    const Z = await newPage({ deviceScaleFactor: 2 }); await open(Z); await load(Z, fixture()); const p = Z.page;
    const ends = async name => { await p.mouse.move(5, 5); await sleep(80); const r = await p.$eval('.timeline', e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top }; });
      await p.screenshot({ path: `${out}/${name}-start.png`, clip: { x: r.l, y: r.t, width: 140, height: 44 } }); await p.screenshot({ path: `${out}/${name}-end.png`, clip: { x: r.r - 140, y: r.t, width: 140, height: 44 } }); };
    await ends('zoom-ruler-resting');
    const grp = () => p.locator('#iosel').screenshot();
    await p.locator('#iosel').screenshot({ path: `${out}/zoom-group-none.png` });
    await p.evaluate(() => { const a = __A(); a.ioSet('in', 1.2); a.ioSet('out', 4.7); }); await sleep(100);
    await ends('zoom-ruler-selection'); await p.locator('#iosel').screenshot({ path: `${out}/zoom-group-full.png` });
    await Z.ctx.close(); void grp;
  });
  await section('long times', async () => {
    await load(D, fixture({ id: 'p-long', title: 'Long', dur: 640, rate: 2000 }));
    await page.evaluate(() => { const a = __A(); a.ioSet('in', 600.5); a.ioSet('out', 633.3); }); await sleep(100);
    for (const w of [1440, 1200, 1100, 1060, 1024, 960, 900, 820]) {
      await page.setViewportSize({ width: w, height: 900 }); await sleep(200); const L = await layout(page);
      const oneRow = L.kids.every(k => Math.abs(k.t - L.row.t) < 2) && L.row.b - L.row.t <= 34;
      check(`1 · ${w}, times past 10:00: one row, zoom inside, nothing clipped`, oneRow && L.sw <= L.cw + 1 && L.zoom && L.zoom.r <= L.row.r + .5 && !L.clipped.length, JSON.stringify({ h: L.row.b - L.row.t, clipped: L.clipped, f: await fields(page) }));
      if (w === 820 || w === 1060 || w === 1200) await shootRow(page, `row-long-${w}`);
    }
  });
} finally {
  const CATALOG = 'https://openrouter.ai/api/v1/videos/models';
  check('no requests outside the local server (only the app\'s model-list call at start, aborted)', foreign.every(u => u === CATALOG), foreign.filter(u => u !== CATALOG).slice(0, 3).join(' '));
  check('no script errors', !errs.length, errs.slice(0, 3).join(' | '));
  await browser.close(); srv.close();
  const f = results.filter(x => !x).length;
  console.log(`\n${results.length - f}/${results.length} passed`);
  process.exit(f ? 1 : 0);
}
