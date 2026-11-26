// Block shots and the marker export for DaVinci Resolve (an EDL of timeline markers).
// Block: the checkbox under Shot type, the BLOCK badge on the strip card (no clip length hint), the slate line, one undo
// step, kept by export/import and by a reload, old projects and odd values load as non-block, the phone sheet has it.
// Markers: the dialog section (rate, start timecode, inline error, no alert), the downloaded file byte for byte against
// an EDL built here from the example's shot starts (24 and 25 fps), the timecode formatter (23.976, 29.97, a start that
// crosses the hour) and hostile names (|, line breaks, empty title and shot type, zero-length shots).
//   node design/blocks-edl-check.mjs <repo-root> <out-dir>
// The example project, collaboration off (this repo's empty sync URL); every request outside the local server is aborted.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');
import { tapTile } from './mobile-b-lib.mjs';

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [], alerts = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });

// ---- the expected EDL, built here from the example's data, without the app's code ----
const example = (() => { const w = {}; new Function('window', readFileSync(join(root, 'example/example.js'), 'utf8'))(w); return w.CUEBOARD_EXAMPLE; })();
const REAL = { 23.976: 24000 / 1001, 24: 24, 25: 25, 29.97: 30000 / 1001, 30: 30 };
function tcOf(frames, base) {          // written differently from the app on purpose: hours, minutes, seconds, frames by division
  const hh = Math.floor(frames / (base * 3600)), r1 = frames - hh * base * 3600, mm = Math.floor(r1 / (base * 60)), r2 = r1 - mm * base * 60, ss = Math.floor(r2 / base), ff = r2 - ss * base;
  return [hh % 24, mm, ss, ff].map(n => (n < 10 ? '0' : '') + n).join(':');
}
function expectedEDL(title, shots, total, fps, startFrames, blocks = new Set()) {
  const real = REAL[fps], base = Math.round(real);
  let o = `TITLE: ${title}\r\nFCM: NON-DROP FRAME\r\n`;
  shots.forEach((s, i) => {
    const len = (i + 1 < shots.length ? shots[i + 1].start : total) - s.start;
    const at = startFrames + Math.round(s.start * real), d = Math.max(1, Math.round((s.start + len) * real) - Math.round(s.start * real));
    const nn = (i + 1 < 10 ? '0' : '') + (i + 1), ev = ('00' + (i + 1)).slice(-3);
    const name = nn + (s.title ? ' ' + s.title : '') + (s.shot ? ` (${s.shot})` : '');
    o += `\r\n${ev}  001      V     C        ${tcOf(at, base)} ${tcOf(at + 1, base)} ${tcOf(at, base)} ${tcOf(at + 1, base)}\r\n |C:${blocks.has(i) ? 'ResolveColorPurple' : 'ResolveColorBlue'} |M:${name} |D:${d}\r\n`;
  });
  return o;
}

async function newPage(opts) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1, acceptDownloads: true, ...opts });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(origin + '/index.html');
  return { ctx, page };
}
const download = async (page, click) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), click()]); const p = join(out, d.suggestedFilename()); await d.saveAs(p); return { name: d.suggestedFilename(), path: p, text: readFileSync(p, 'utf8') }; };
const blocks = page => page.evaluate(() => __A().S().map(s => s.block));

try {
  // ======== unit: the timecode formatter and parser (pure, window.cueEDL) ========
  const { page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await page.waitForSelector('.card', { timeout: 15000 }); await page.evaluate(() => document.fonts.ready); await sleep(600);
  const u = await page.evaluate(() => {
    const E = window.cueEDL, oneHour = r => Math.round(3600 * E.edlRate(r));
    return {
      r23: E.edlRate('23.976'), r29: E.edlRate(29.97), r25: E.edlRate('25'),
      h23: [oneHour('23.976'), E.edlTC(oneHour('23.976'), 24)], h29: [oneHour('29.97'), E.edlTC(oneHour('29.97'), 30)],
      z: E.edlTC(0, 24), last: E.edlTC(24 * 86400 - 1, 24), wrap: E.edlTC(24 * 86400, 24),
      p1: E.edlParseTC('01:00:00:00', 24), p2: E.edlParseTC('00:59:58:00', 24), bad: ['01:00:00:24', '1:00:00:00', '00:60:00:00', '00:00:60:00', '24:00:00:00', '01:00:00', 'ab:cd:ef:gh', ''].map(t => E.edlParseTC(t, 24)),
      ok25: E.edlParseTC('01:00:00:24', 25), ok30: E.edlParseTC('01:00:00:29', 30), bad30: E.edlParseTC('01:00:00:30', 30),
      cross: E.markersEDL({ title: 'X', song: { duration: 10 }, sections: [{ start: 0, title: 'a' }, { start: 1.5, title: 'b' }, { start: 4.4, title: 'c' }] }, 24, '00:59:58:00'),
      cross23: E.markersEDL({ title: 'X', song: { duration: 10 }, sections: [{ start: 0 }, { start: 2.5 }] }, '23.976', '00:59:58:00'),
    };
  });
  check('real rates: 23.976 is 24000/1001, 29.97 is 30000/1001, 25 is 25', u.r23 === 24000 / 1001 && u.r29 === 30000 / 1001 && u.r25 === 25);
  check('one hour at 23.976 is 86314 frames, 00:59:56:10 in a 24-frame count', u.h23[0] === 86314 && u.h23[1] === '00:59:56:10', JSON.stringify(u.h23));
  check('one hour at 29.97 is 107892 frames, 00:59:56:12 in a 30-frame count', u.h29[0] === 107892 && u.h29[1] === '00:59:56:12', JSON.stringify(u.h29));
  check('formatter: zero, the last frame of a day, a day wraps to 00', u.z === '00:00:00:00' && u.last === '23:59:59:23' && u.wrap === '00:00:00:00', [u.z, u.last, u.wrap].join(' '));
  check('parser: 01:00:00:00 and 00:59:58:00 at 24', u.p1 === 86400 && u.p2 === 3598 * 24, `${u.p1} ${u.p2}`);
  check('parser refuses FF ≥ base, short or bad fields, minutes/seconds ≥ 60, hours ≥ 24, empty', u.bad.every(v => v === null), JSON.stringify(u.bad));
  check('parser: FF 24 is fine at 25, FF 29 at 30, FF 30 is not', u.ok25 === 86400 / 24 * 25 + 24 && u.ok30 === 3600 * 30 + 29 && u.bad30 === null);
  const crossL = u.cross.split('\r\n').filter(l => /^\d{3} /.test(l)).map(l => l.slice(29, 40));
  // 00:59:58:00 = 86352 frames; +0, +36 (1.5 s), +106 (4.4 s × 24 = 105.6)
  check('a start of 00:59:58:00 crosses the hour: 00:59:58:00, 00:59:59:12, 01:00:02:10', crossL.join() === '00:59:58:00,00:59:59:12,01:00:02:10', crossL.join());
  const c23 = u.cross23.split('\r\n').filter(l => /^\d{3} /.test(l)).map(l => l.slice(29, 40));
  // 2.5 s at 23.976 = 59.94 → 60 frames → 00:59:58:00 + 60 frames (2 s 12 f) = 01:00:00:12
  check('23.976 from 00:59:58:00: a cut at 2.5 s is 60 frames later, 01:00:00:12', c23.join() === '00:59:58:00,01:00:00:12', c23.join());

  // ======== hostile shots: names, empty fields, zero length, old and odd block values ========
  const hostile = await page.evaluate(() => window.cueEDL.markersEDL({ title: 'Bad | title\nwith break', song: { duration: 3 }, sections: [
    { start: 0, title: 'a|b\nc\r\nd', shot: 'Close|up' }, { start: 1, title: '', shot: '' }, { start: 1, title: '  ', shot: 'Wide shot' }, { start: 2, title: 'T', shot: '', block: 'yes' },
    { start: 3, title: 'end', block: true }] }, 25, '10:00:00:00'));
  const hl = hostile.split('\r\n');
  check('names lose | and line breaks; the title line too', hl[0] === 'TITLE: Bad title with break' && hl.includes(' |C:ResolveColorBlue |M:01 a b c d (Close up) |D:25'), JSON.stringify(hl.slice(0, 5)));
  check('an empty title and shot type leave just the number; a blank title with a shot type has no double space', hl.includes(' |C:ResolveColorBlue |M:02 |D:1') && hl.includes(' |C:ResolveColorBlue |M:03 (Wide shot) |D:25'), JSON.stringify(hl));
  check('a zero-length shot (two cuts at one time) and a last shot at the song\'s end get D:1, never 0 or negative', !/\|D:(0|-)/.test(hostile) && hl.includes(' |C:ResolveColorPurple |M:05 end |D:1'));
  check('block:"yes" (not true) is a normal shot (blue); block:true is purple', hl.includes(' |C:ResolveColorBlue |M:04 T |D:25'));
  check('every line ends CRLF, no bare LF, no trailing spaces, file ends with CRLF', !/[^\r]\n/.test(hostile) && hostile.endsWith('\r\n') && !/ \r\n/.test(hostile));
  const noSongs = await page.evaluate(() => window.cueEDL.markersEDL({ sections: [{ start: 0 }] }, 24, '01:00:00:00'));
  check('no title and no song length: "Untitled project", one marker of D:1', noSongs.startsWith('TITLE: Untitled project\r\n') && noSongs.includes('|M:01 |D:1'), JSON.stringify(noSongs));
  const thrown = await page.evaluate(() => { try { window.cueEDL.markersEDL({ sections: [] }, 24, '01:00:00:24'); return false; } catch (e) { return true; } });
  check('a bad start timecode throws (the dialog never calls it with one)', thrown);

  // ======== desktop: the block toggle ========
  const ex = example.project, t0 = await page.evaluate(() => __A().cur().title);
  check('the example opens', /Mountain King/.test(t0), t0);
  await page.locator('.card').nth(1).click(); await sleep(300);
  const pos = await page.evaluate(() => { const y = id => document.getElementById(id).getBoundingClientRect().top; const l = document.getElementById('f-block').closest('label'); return { shot: y('f-shot'), blk: y('f-block'), notes: y('f-notes'), text: l.textContent.trim(), vis: l.getClientRects().length > 0, checked: document.getElementById('f-block').checked, cls: l.className }; });
  check('the checkbox is right under Shot type, above Notes, with the spec\'s label, in the app\'s .chk style', pos.vis && pos.blk > pos.shot && pos.blk < pos.notes && pos.text === "Block: a stretch you'll cut in your editor from several clips" && pos.cls === 'chk' && !pos.checked, JSON.stringify(pos));
  check('the example has no block field on any shot (an old project shape)', (await blocks(page)).every(b => b === undefined));
  const cs0 = await page.locator('.card').nth(1).locator('.cs').innerText();
  await page.click('#f-block'); await sleep(300);
  const card = await page.evaluate(() => { const c = document.querySelectorAll('.card')[1], b = c.querySelector('.cblk'); return { badge: b ? b.innerText : '', cs: c.querySelector('.cs').innerText }; });
  check('ticking it sets block: true on that shot only', JSON.stringify(await blocks(page)) === JSON.stringify(ex.sections.map((_, i) => (i === 1 ? true : undefined))));
  check('the strip card shows BLOCK in place of the clip length hint (the shot type stays)', card.badge === 'BLOCK' && !/generate|split or extend/.test(card.cs) && card.cs.includes(ex.sections[1].shot), JSON.stringify({ cs0, card }));
  const slate = await page.evaluate(() => { const els = [...document.querySelectorAll('#slate > *')]; const i = els.findIndex(e => e.textContent === 'Block · cut in your editor'), t = els.findIndex(e => e.classList.contains('t')); return { i, t, n: document.querySelector('#slate .n')?.textContent }; });
  check('the slate shows "Block · cut in your editor" above the title', slate.n === '02' && slate.i >= 0 && slate.i < slate.t, JSON.stringify(slate));
  await page.screenshot({ path: join(out, 'desktop-block.png') });
  const h = await page.evaluate(() => __A().hist().peek()?.label);
  check('the toggle is one undo step, "block of shot 02"', h === 'block of shot 02', h);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Control+z'); await sleep(250);
  const u1 = await page.evaluate(() => ({ b: __A().S()[1].block, has: 'block' in __A().S()[1], chk: document.getElementById('f-block').checked, badge: !!document.querySelectorAll('.card')[1].querySelector('.cblk'), slate: document.getElementById('slate').textContent.includes('Block ·') }));
  check('Ctrl+Z takes it off: no key left, box unticked, no badge, no slate line', !u1.has && !u1.chk && !u1.badge && !u1.slate, JSON.stringify(u1));
  await page.keyboard.press('Control+Shift+z'); await sleep(250);
  check('redo puts it back', (await page.evaluate(() => __A().S()[1].block === true && document.getElementById('f-block').checked)));
  // untick and tick through the UI again: off deletes the key
  await page.click('#f-block'); await sleep(150);
  check('unticking removes the key (the project is as it was)', !(await page.evaluate(() => 'block' in __A().S()[1])));
  await page.click('#f-block'); await sleep(150);
  // a second block, on shot 4, for the colors
  await page.locator('.card').nth(3).click(); await sleep(200); await page.click('#f-block'); await sleep(200);
  check('selecting another shot shows its own state; it can be a block too', JSON.stringify(await blocks(page)) === JSON.stringify(ex.sections.map((_, i) => (i === 1 || i === 3 ? true : undefined))));
  await page.locator('.card').nth(2).click(); await sleep(200);
  check('a normal shot shows the box unticked', !(await page.isChecked('#f-block')));

  // ======== the export dialog ========
  await page.evaluate(() => document.activeElement.blur());
  await page.click('#exportb'); await sleep(200);
  const dlg = await page.evaluate(() => { const d = document.getElementById('dlgExport'); return { open: d.open, legend: d.querySelector('legend')?.textContent, hint: d.querySelector('.edl-set .hint')?.textContent, fps: document.getElementById('edlFps').value, opts: [...document.getElementById('edlFps').options].map(o => o.value).join(), start: document.getElementById('edlStart').value, btn: document.getElementById('edlGo').textContent, dis: document.getElementById('edlGo').disabled, msg: getComputedStyle(document.getElementById('edlMsg')).display, w: d.scrollWidth - d.clientWidth }; });
  check('the dialog has "Markers for your editor": rates 23.976–30, default 24, start 01:00:00:00, the button', dlg.open && dlg.legend === 'Markers for your editor' && dlg.opts === '23.976,24,25,29.97,30' && dlg.fps === '24' && dlg.start === '01:00:00:00' && dlg.btn === 'Download markers (.edl)' && !dlg.dis && dlg.msg === 'none' && dlg.w <= 0, JSON.stringify(dlg));
  check('it says the import path in one line', /put the song at the start of a timeline/.test(dlg.hint) && /media pool, right-click the timeline → Timelines → Import → Timeline Markers from EDL/.test(dlg.hint), dlg.hint);
  await page.screenshot({ path: join(out, 'desktop-export-dialog.png') });
  // a bad start: inline, no alert
  await page.fill('#edlStart', '01:00:00:24'); await sleep(500);   // the border colour has a transition
  let v = await page.evaluate(() => ({ msg: document.getElementById('edlMsg').textContent, shown: getComputedStyle(document.getElementById('edlMsg')).display !== 'none', inv: document.getElementById('edlStart').getAttribute('aria-invalid'), dis: document.getElementById('edlGo').disabled, color: getComputedStyle(document.getElementById('edlMsg')).color, err: getComputedStyle(document.getElementById('rnCusMsg')).color, bc: getComputedStyle(document.getElementById('edlStart')).borderTopColor }));
  check('frame 24 at 24 fps: an inline error under the field, the field marked, the button off, no alert', v.shown && /00 to 23/.test(v.msg) && v.inv === 'true' && v.dis && alerts.length === 0, JSON.stringify(v));
  check('the error uses the render dialog\'s error colour (no new colour)', v.color === v.err && v.bc === v.color, JSON.stringify([v.color, v.err, v.bc]));
  await page.screenshot({ path: join(out, 'desktop-export-error.png') });
  await page.selectOption('#edlFps', '25'); await sleep(100);
  check('switching to 25 fps makes 01:00:00:24 valid', !(await page.evaluate(() => document.getElementById('edlGo').disabled)));
  for (const bad of ['1:00:00:00', 'abc', '']) { await page.fill('#edlStart', bad); await sleep(50); }
  check('a short or empty timecode is refused', await page.evaluate(() => document.getElementById('edlGo').disabled));
  await page.fill('#edlStart', '01:00:00:00'); await page.selectOption('#edlFps', '24'); await sleep(100);

  // ======== the markers file, 24 and 25 fps ========
  const title = await page.evaluate(() => __A().cur().title);
  const total = await page.evaluate(() => __A().cur().song.duration);
  const blk = new Set([1, 3]);
  const e24 = expectedEDL(title, ex.sections, total, 24, 86400, blk);
  const f24 = await download(page, () => page.click('#edlGo'));
  check('the file is <project-slug>-markers.edl', f24.name === 'the-mountain-king-example-markers.edl', f24.name);
  check('the dialog closes after the download', !(await page.evaluate(() => document.getElementById('dlgExport').open)));
  const ev = t => t.split('\r\n').filter(l => /^\d{3} /.test(l) || /^ \|C:/.test(l));
  // the first three shots by hand from the example's starts: 0, 4.4, 15.1 s
  const first3 = ev(f24.text).slice(0, 6), want3 = [
    '001  001      V     C        01:00:00:00 01:00:00:01 01:00:00:00 01:00:00:01', ' |C:ResolveColorBlue |M:01 The mountain (Wide shot) |D:106',
    '002  001      V     C        01:00:04:10 01:00:04:11 01:00:04:10 01:00:04:11', ' |C:ResolveColorPurple |M:02 Tiptoe (Close-up) |D:256',
    '003  001      V     C        01:00:15:02 01:00:15:03 01:00:15:02 01:00:15:03', ' |C:ResolveColorBlue |M:03 The gate (Medium shot) |D:281'];
  // 4.4 × 24 = 105.6 → 106; 15.1 × 24 = 362.4 → 362; 26.8 × 24 = 643.2 → 643
  check('24 fps: the first three markers at 01:00:00:00, 01:00:04:10, 01:00:15:02 with 106, 256, 281 frames; shot 2 purple', JSON.stringify(first3) === JSON.stringify(want3), JSON.stringify(first3));
  check('24 fps: the whole file matches the EDL built here, byte for byte', f24.text === e24, f24.text === e24 ? '' : JSON.stringify([f24.text.slice(0, 300), e24.slice(0, 300)]));
  check(`24 fps: one marker per shot (${ex.sections.length}), header as specified`, ev(f24.text).length === ex.sections.length * 2 && f24.text.startsWith(`TITLE: ${title}\r\nFCM: NON-DROP FRAME\r\n\r\n001  001`));
  writeFileSync(join(out, 'example-markers-24.edl'), f24.text);
  await page.click('#exportb'); await sleep(150); await page.selectOption('#edlFps', '25'); await sleep(50);
  const f25 = await download(page, () => page.click('#edlGo'));
  const e25 = expectedEDL(title, ex.sections, total, 25, 90000, blk);
  const want25 = ['001  001      V     C        01:00:00:00 01:00:00:01 01:00:00:00 01:00:00:01', ' |C:ResolveColorBlue |M:01 The mountain (Wide shot) |D:110',
    '002  001      V     C        01:00:04:10 01:00:04:11 01:00:04:10 01:00:04:11', ' |C:ResolveColorPurple |M:02 Tiptoe (Close-up) |D:268',
    '003  001      V     C        01:00:15:03 01:00:15:04 01:00:15:03 01:00:15:04', ' |C:ResolveColorBlue |M:03 The gate (Medium shot) |D:292'];
  // 4.4 × 25 = 110; 15.1 × 25 = 377.5 → 378 (15 s 3 f); 26.8 × 25 = 670
  check('25 fps: the first three markers (110, 268, 292 frames)', JSON.stringify(ev(f25.text).slice(0, 6)) === JSON.stringify(want25), JSON.stringify(ev(f25.text).slice(0, 6)));
  check('25 fps: the whole file matches, byte for byte', f25.text === e25);
  check('the rate is remembered in this browser', await page.evaluate(() => JSON.parse(localStorage.getItem('cueboard-edl') || '{}').fps === '25'));
  await page.click('#exportb'); await sleep(150); await page.selectOption('#edlFps', '29.97'); await sleep(50);
  const f29 = await download(page, () => page.click('#edlGo'));
  check('29.97 fps: the whole file matches (frames at 30000/1001, a 30-frame count)', f29.text === expectedEDL(title, ex.sections, total, 29.97, 108000, blk));
  await page.click('#exportb'); await sleep(150); await page.selectOption('#edlFps', '24'); await sleep(50); await page.click('#expCancel');

  // ======== export / import keeps the flag; a reload keeps it ========
  await page.click('#exportb'); await sleep(150);
  const fj = await download(page, () => page.click('#expGo')); await sleep(300);
  const pj = JSON.parse(fj.text);
  check('the project file carries block: true on shots 2 and 4 only', JSON.stringify(pj.project.sections.map(s => s.block)) === JSON.stringify(ex.sections.map((_, i) => (i === 1 || i === 3 ? true : undefined))));
  await page.setInputFiles('#importf', { name: 'blocks.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(fj.text) });
  await page.waitForFunction(() => /\(imported\)/.test(__A().cur().title), null, { timeout: 10000 }); await sleep(400);
  check('importing it gives the same blocks', JSON.stringify(await blocks(page)) === JSON.stringify(ex.sections.map((_, i) => (i === 1 || i === 3 ? true : undefined))));
  const impId = await page.evaluate(() => __A().cur().id);
  await page.evaluate(() => __A().flushNow()); await sleep(400);
  await page.reload(); await page.waitForSelector('.card', { timeout: 15000 }); await sleep(800);
  const after = await page.evaluate(() => ({ id: __A().cur().id, b: __A().S().map(s => s.block), badges: document.querySelectorAll('.card .cblk').length }));
  check('after a reload the blocks are still there, with their badges', after.id === impId && JSON.stringify(after.b) === JSON.stringify(ex.sections.map((_, i) => (i === 1 || i === 3 ? true : undefined))) && after.badges === 2, JSON.stringify(after));

  // an old file (no field) and an odd one (block: "true", 1): both load as non-block, the odd value is dropped
  const old = JSON.parse(JSON.stringify(pj)); old.project.id = 'p-old'; old.project.title = 'Old'; old.project.sections.forEach((s, i) => { delete s.block; if (i === 0) s.block = 'true'; if (i === 2) s.block = 1; });
  await page.setInputFiles('#importf', { name: 'old.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => __A().cur().title === 'Old', null, { timeout: 10000 }); await sleep(300);
  const ob = await page.evaluate(() => ({ keys: __A().S().filter(s => 'block' in s).length, badges: document.querySelectorAll('.card .cblk').length, chk: document.getElementById('f-block').checked }));
  check('an old file loads as non-block; non-boolean values are dropped on import', ob.keys === 0 && ob.badges === 0 && !ob.chk, JSON.stringify(ob));
  // a value that arrives without import (a collaborator on another build, an old store): only true counts
  await page.evaluate(() => { __A().S()[0].block = 'yes'; __A().renderAll(); });
  check('a stored block:"yes" shows no badge (only true is a block)', await page.evaluate(() => !document.querySelector('.card .cblk') && !document.getElementById('f-block').checked));
  // a new project's only shot: "Delete shot" clears its fields, the block too; undo brings it back
  await page.click('#newp'); await sleep(400); await page.keyboard.press('Escape'); await sleep(300);
  await page.locator('.card').first().click(); await sleep(150); await page.click('#f-block'); await sleep(150);
  const one0 = await page.evaluate(() => ({ n: __A().S().length, b: __A().S()[0].block }));
  await page.click('#f-del'); await sleep(100); await page.click('#f-del'); await sleep(300);
  const one1 = await page.evaluate(() => ({ n: __A().S().length, has: 'block' in __A().S()[0], chk: document.getElementById('f-block').checked, badge: !!document.querySelector('.card .cblk') }));
  check('deleting the only shot clears it, block included', one0.n === 1 && one0.b === true && one1.n === 1 && !one1.has && !one1.chk && !one1.badge, JSON.stringify({ one0, one1 }));
  await page.evaluate(() => { document.activeElement.blur(); __A().doUndo('undo'); }); await sleep(200);
  check('and its undo brings the block back', await page.evaluate(() => __A().S()[0].block === true && document.getElementById('f-block').checked));
  await page.context().close();

  // ======== phone: the same toggle in the shot sheet ========
  for (const [w, hh] of [[390, 844], [320, 568]]) {
    const { page: ph } = await newPage({ viewport: { width: w, height: hh }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1' });
    const tag = `phone-${w}x${hh}`;
    await ph.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.getElementById('mtDet'), null, { timeout: 15000 });
    await ph.evaluate(() => document.fonts.ready); await sleep(600);
    await ph.evaluate(() => { const a = document.getElementById('audio'), s = __A().S(); a.currentTime = (s[1].start + s[2].start) / 2; }); await sleep(300); await tapTile(ph);
    await ph.tap('#mtDet'); await sleep(400);
    const g = await ph.evaluate(() => { const chips = document.getElementById('mShotChips').getBoundingClientRect(), l = document.getElementById('f-block').closest('label'), r = l.getBoundingClientRect(), n = document.getElementById('f-notes').getBoundingClientRect(); return { open: document.body.classList.contains('m-ed'), chips: chips.bottom, top: r.top, h: Math.round(r.height), w: Math.round(r.width), right: r.right, notes: n.top, vw: innerWidth, ov: document.documentElement.scrollWidth - innerWidth }; });
    check(`[${tag}] the sheet has the Block toggle right under the shot type chips, a 44px row, no overflow`, g.open && g.top >= g.chips - 1 && g.top < g.notes && g.h >= 44 && g.right <= g.vw && g.ov <= 0, JSON.stringify(g));
    const sel = await ph.evaluate(() => __A().S().findIndex(s => s.id === document.querySelector('.card.sel, [aria-current]')?.dataset?.id));
    await ph.locator('#editor .chk:has(#f-block)').scrollIntoViewIfNeeded(); await ph.tap('#editor .chk:has(#f-block)'); await sleep(300);
    const pb = await ph.evaluate(() => { const s = __A().S().find(x => x.block === true); return { n: __A().S().filter(x => x.block === true).length, id: s && s.id, slate: document.getElementById('slate').textContent }; });
    check(`[${tag}] a tap on the row ticks it: one block, the slate says so`, pb.n === 1 && pb.slate.includes('Block · cut in your editor'), JSON.stringify({ pb, sel }));
    await ph.screenshot({ path: join(out, `${tag}-sheet-block.png`) });
    await ph.tap('#mEdClose'); await sleep(300);
    await ph.screenshot({ path: join(out, `${tag}-slate-block.png`) });
    // the export dialog on a phone: no overflow, fields stack
    await ph.evaluate(() => document.getElementById('dlgExport').showModal()); await sleep(200);
    const dov = await ph.evaluate(() => { const d = document.querySelector('#dlgExport .dlg'), b = document.getElementById('edlGo').getBoundingClientRect(), dr = d.getBoundingClientRect(); return { ov: d.scrollWidth - d.clientWidth, inside: b.left >= dr.left - 1 && b.right <= dr.right + 1, h: Math.round(b.height) }; });
    check(`[${tag}] the export dialog fits: the markers button inside, nothing wider than the dialog`, dov.ov <= 0 && dov.inside, JSON.stringify(dov));
    await ph.screenshot({ path: join(out, `${tag}-export.png`) });
    await ph.context().close();
  }
} catch (e) { check('ran without throwing', false, e.stack); }

check('no alert() anywhere', alerts.length === 0, alerts.join(' | '));
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close(); srv.close();
const fails = results.filter(r => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
