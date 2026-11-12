// Render range options and AAC audio (docs/specs/export-render-range.md), one block per approval criterion A1-A8
// (A9 is the whole suite, run separately), then the hostile cases: garbage in the Custom fields, the selection changed
// while the dialog is open, the song replaced while Custom holds old times, cancel while the encoder is loading, a
// second render started during the first. Screenshots go to <out-dir> (design/out/render-range/ by convention).
//   node design/render-range-check.mjs <repo-root> <out-dir>
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
let delayMuxer = 0;
const srv = createServer(async (q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>blank</title>'); return; }
  if (path === '/mp4-muxer.js' && delayMuxer) await new Promise(ok => setTimeout(ok, delayMuxer));
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [], foreign = [], own = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const section = async (name, fn) => { try { await fn(); } catch (e) { check(name + ': ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' ')); } };
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

/* ---------- the produced file: duration, tracks, the audio sample entry (and an AAC one's object type) ---------- */
function boxes(b, s, e) { const o = []; while (s + 8 <= e) { let n = b.readUInt32BE(s), h = 8; const t = b.toString('latin1', s + 4, s + 8); if (n === 1) { n = Number(b.readBigUInt64BE(s + 8)); h = 16; } else if (n === 0) n = e - s; if (n < h) break; o.push({ t, s: s + h, e: s + n }); s += n; } return o; }
function mp4info(b) {
  const top = boxes(b, 0, b.length), moov = top.find(x => x.t === 'moov'); if (!moov) return { tracks: [] };
  const inner = boxes(b, moov.s, moov.e), mvhd = inner.find(x => x.t === 'mvhd'), v1 = b[mvhd.s] === 1;
  const scale = b.readUInt32BE(mvhd.s + (v1 ? 20 : 12)), d = v1 ? Number(b.readBigUInt64BE(mvhd.s + 24)) : b.readUInt32BE(mvhd.s + 16);
  const tracks = inner.filter(x => x.t === 'trak').map(tr => {
    const tb = boxes(b, tr.s, tr.e), mb = tb.find(x => x.t === 'mdia'), mdia = boxes(b, mb.s, mb.e), hdlr = mdia.find(x => x.t === 'hdlr'), mdhd = mdia.find(x => x.t === 'mdhd'), m1 = b[mdhd.s] === 1;
    const minf = mdia.find(x => x.t === 'minf'), stbl = boxes(b, minf.s, minf.e).find(x => x.t === 'stbl'), stsd = boxes(b, stbl.s, stbl.e).find(x => x.t === 'stsd');
    const entry = { s: stsd.s + 8, e: stsd.s + 8 + b.readUInt32BE(stsd.s + 8) }, codec = b.toString('latin1', entry.s + 4, entry.s + 8);
    let oti = null, aot = null;
    if (codec === 'mp4a') { const i = b.indexOf('esds', entry.s, 'latin1'); if (i > 0 && i < entry.e) {
      let p = i + 8; const len = () => { let n = 0, c; do { c = b[p++]; n = n << 7 | c & 127; } while (c & 128); return n; };
      if (b[p++] === 3) { len(); p += 2; const f = b[p++]; if (f & 128) p += 2; if (f & 64) p += 1 + b[p]; if (f & 32) p += 2;
        if (b[p++] === 4) { len(); oti = b[p]; p += 13; if (b[p++] === 5) { len(); aot = b[p] >> 3; } } } } }
    return { type: b.toString('latin1', hdlr.s + 8, hdlr.s + 12), codec, oti, aot, duration: (m1 ? Number(b.readBigUInt64BE(mdhd.s + 24)) : b.readUInt32BE(mdhd.s + 16)) / b.readUInt32BE(mdhd.s + (m1 ? 20 : 12)) };
  });
  return { duration: d / scale, tracks, video: tracks.find(t => t.type === 'vide'), audio: tracks.find(t => t.type === 'soun') };
}
function wav(sec, rate = 8000) { const n = Math.round(sec * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 330) * 6000), 44 + i * 2); return b; }

/* ---------- pages ---------- */
const DESK = { viewport: { width: 1440, height: 900 } }, PHONE = (h = 844) => ({ viewport: { width: 390, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
async function newPage(opts = {}, init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, ...opts });
  const reqs = [];
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob):/.test(u)) { own.push(u); reqs.push(u); return r.continue(); } foreign.push(u); return r.abort(); });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(t)) errs.push(t); });
  page.on('pageerror', e => errs.push(e.message));
  return { ctx, page, reqs };
}
const GREEN = [32, 192, 64], RED = [208, 32, 32];
const near = (a, b, tol = 40) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/* the fixture's media: a red still (shot 1) and a green still (shot 2, from 2 s); no clip needed here */
async function makeMedia() {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const m = await page.evaluate(([RED, GREEN]) => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
    const png = col => { g.fillStyle = `rgb(${col})`; g.fillRect(0, 0, 320, 180); return c.toDataURL('image/png'); }; return { red: png(RED), green: png(GREEN) }; }, [RED, GREEN]);
  await ctx.close(); return m;
}
const sec = (id, start, o = {}) => ({ id, start, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', kind: '', clipDur: 0, takes: [], ...o });
function fixture(media, o = {}) {
  const d = o.dur || 6, song = o.noSong ? null : wav(d);
  return { format: 'cueboard', version: 1, exportedAt: '2026-01-01T00:00:00.000Z',
    project: { id: o.id || 'p-range', title: o.title || 'Range', created: 1, updated: 1, song: song ? { name: 'tone.wav', duration: d, peaks: [] } : null,
      sections: [sec('s1', 0, { title: 'Red', img: 'mr', kind: 'image' }), sec('s2', 2, { title: 'Green', img: 'mg', kind: 'image' }), sec('s3', 4, { title: 'Empty' })] },
    media: { mr: { type: 'image/png', data: media.red }, mg: { type: 'image/png', data: media.green } },
    ...(song ? { song: { name: 'tone.wav', type: 'audio/wav', data: 'data:audio/wav;base64,' + song.toString('base64') } } : {}) };
}
async function open(p) { await p.page.goto(origin + '/index.html'); await p.page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await p.page.evaluate(() => document.fonts.ready); await sleep(500); }
async function load(p, file) {
  await p.page.setInputFiles('#importf', { name: 'fixture.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.page.waitForFunction(n => { const a = __A(); return a.cur() && a.S().length === n && (!document.getElementById('play').disabled); }, file.project.sections.length, { timeout: 15000 });
  await sleep(400); await p.page.evaluate(() => document.activeElement && document.activeElement.blur());
}
const marks = page => page.evaluate(() => { const m = __A().io(); return [m.in, m.out]; });
const seekTo = (page, t) => page.evaluate(t => { const a = document.getElementById('audio'), p = new Promise(r => { a.addEventListener('seeked', () => r(), { once: true }); setTimeout(r, 800); }); __A().seek(t); return p; }, t);
const shoot = async (page, name) => { await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 3000 }).catch(() => {}); await page.screenshot({ path: `${out}/${name}.png` }); };
const isOpen = page => page.$eval('#dlgRender', d => d.open);
const openDialog = async page => { if (await isOpen(page)) return; if (await page.isVisible('#renderb')) await page.click('#renderb'); else { await page.click('#proj'); await page.waitForSelector('#mProj[open]'); await sleep(250); await page.click('#mRender'); } await page.waitForSelector('#dlgRender[open]', { timeout: 4000 }); await sleep(250); };
const closeDialog = async page => { if (await isOpen(page)) { await page.click('#rnCancel'); await page.waitForFunction(() => !document.getElementById('dlgRender').open); } };
const radio = (page, v) => `#dlgRender input[name="rnRange"][value="${v}"]`;
const state = page => page.evaluate(() => { const q = s => document.querySelector(s), vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const msg = q('#rnCusMsg');
  return { range: (q('#dlgRender input[name="rnRange"]:checked') || {}).value, go: !q('#rnGo').disabled && vis(q('#rnGo')), msg: msg && vis(msg) ? msg.textContent.trim() : '', cusT: (q('#rnCusT') || {}).textContent || '',
    start: (q('#rnStart') || {}).value, end: (q('#rnEnd') || {}).value, fields: vis(q('#rnStart')) && vis(q('#rnEnd')), mode: q('#dlgRender').dataset.mode }; });
const typeIn = async (page, sel, v) => { await page.fill(sel, ''); if (v) await page.fill(sel, v); await sleep(60); };
async function render(page, o = {}) {
  await openDialog(page);
  if (o.range) await page.check(radio(page, o.range));
  if (o.start != null) { await typeIn(page, '#rnStart', o.start); await typeIn(page, '#rnEnd', o.end); }
  const dl = page.waitForEvent('download', { timeout: o.timeout || 90000 });
  await page.click('#rnGo');
  const d = await dl, buf = readFileSync(await d.path());
  await page.waitForSelector('#dlgRender[data-mode="done"]', { timeout: 20000 });
  const said = await page.$eval('#dlgRender', el => el.innerText.replace(/\s+/g, ' ').trim());
  if (o.shot) await shoot(page, o.shot);
  if (!o.keep) await closeDialog(page);
  return { name: d.suggestedFilename(), buf, said, info: mp4info(buf) };
}
async function firstFrame(buf) {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const r = await page.evaluate(async b64 => { const blob = await (await fetch(`data:video/mp4;base64,${b64}`)).blob(), v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
    if (!await new Promise(r => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 10000); })) return null;
    v.currentTime = 0; await new Promise(r => { v.onseeked = r; setTimeout(r, 3000); });
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data].slice(0, 3); }, buf.toString('base64'));
  await ctx.close(); return r;
}
/* the phone's ruler grips: where they are (centre x, size), and a drag of one to time t, as pointer events on the grip */
const grips = page => page.evaluate(() => [...document.querySelectorAll('.mkgrip')].map(b => { const r = b.getBoundingClientRect(); return { k: b.dataset.mk, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, shown: !b.hidden && r.width > 0 }; }));
async function dragGrip(page, k, toX) {
  await page.evaluate(([k, toX]) => { const b = document.querySelector(`.mkgrip[data-mk="${k}"]`), r = b.getBoundingClientRect(), y = r.top + r.height / 2, x0 = r.left + r.width / 2;
    const ev = (t, x) => b.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    ev('pointerdown', x0); for (let i = 1; i <= 8; i++) ev('pointermove', x0 + (toX - x0) * i / 8); ev('pointerup', toX); }, [k, toX]);
  await sleep(150);
}
/* the time→x map of the phone ruler, from the two grips at rest (0 and the song's end) */
const ruler = async (page, d) => { const g = await grips(page), a = g.find(x => x.k === 'in'), b = g.find(x => x.k === 'out'); return t => a.x + (b.x - a.x) * t / d; };

let media;
try {
  media = await makeMedia();
  const fx = fixture(media), long = fixture(media, { id: 'p-long', title: 'Long', dur: 90 });

  /* ======== A1, A2 (desktop), A4, A5 ======== */
  const D = await newPage(DESK); await open(D); await load(D, fx);
  await section('A1', async () => {
    const page = D.page; await openDialog(page);
    const a = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#dlgRender input[name="rnRange"]')].map(i => [i.value, i.closest('label').querySelector('span').textContent.trim()]),
      setBtns: [...document.querySelectorAll('#dlgRender button')].filter(b => /\b(set|mark) (in|out)\b/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') || ''))).map(b => b.id || b.textContent.trim()),
      old: ['rnIn', 'rnOut', 'rnClear', 'rnNow'].filter(id => document.getElementById(id)) }));
    check('A1 · the dialog has no set-in / set-out buttons (the transport has them since docs/specs/selection-controls.md)', !a.setBtns.length && !a.old.length, JSON.stringify(a));
    check('A1 · Range is exactly All, Current selection, Custom, in that order', JSON.stringify(a.rows) === JSON.stringify([['all', 'All'], ['sel', 'Current selection'], ['custom', 'Custom']]), JSON.stringify(a.rows));
    await shoot(page, 'dialog-all-desktop-1440x900');
  });
  await section('A2 desktop', async () => {
    const page = D.page; await openDialog(page);
    const off = await page.evaluate(() => { const i = document.querySelector('#dlgRender input[name="rnRange"][value="sel"]'), h = document.getElementById('rnSelHint');
      return { disabled: i.disabled, hint: h && h.getClientRects().length ? h.textContent.trim() : '', checked: document.querySelector('#dlgRender input[name="rnRange"]:checked').value }; });
    check('A2 · desktop, no selection: Current selection disabled with the desktop hint; All is chosen', off.disabled && off.hint === 'Set In and Out in the bar above the timeline, or press I and O' && off.checked === 'all', JSON.stringify(off));
    await closeDialog(page);
    await seekTo(page, 1); await page.keyboard.press('i'); await seekTo(page, 3); await page.keyboard.press('o'); await sleep(100);
    await openDialog(page);
    const on = await page.evaluate(() => { const i = document.querySelector('#dlgRender input[name="rnRange"][value="sel"]'), t = document.getElementById('rnSelT'), h = document.getElementById('rnSelHint'), cs = getComputedStyle(t);
      return { disabled: i.disabled, checked: i.checked, t: t.textContent, mono: /Mono/i.test(cs.fontFamily) && /tabular-nums/.test(cs.fontVariantNumeric), hint: !!(h && h.getClientRects().length), inputs: i.closest('label').querySelectorAll('input:not([type=radio])').length }; });
    check('A2 · desktop, with I at 1 s and O at 3 s: Current selection enabled, chosen by default, its two times read-only in mono', !on.disabled && on.checked && /^0:01\.0 to 0:03\.0/.test(on.t) && on.mono && !on.hint && !on.inputs, JSON.stringify(on));
    await shoot(page, 'dialog-selection-desktop-1440x900');
  });
  await section('A4 + A5', async () => {
    const page = D.page; await openDialog(page);
    await page.check(radio(page, 'custom')); await sleep(80);
    let s = await state(page);
    check('A4 · Custom pre-fills with the current selection (0:01.0 to 0:03.0) and shows its fields', s.fields && s.start === '0:01.0' && s.end === '0:03.0' && s.go && !s.msg, JSON.stringify(s));
    await shoot(page, 'dialog-custom-desktop-1440x900');
    /* A5: a Custom render: 2.5 to 4.5 (typed two ways); the marks stay at 1 and 3 */
    const r = await render(page, { range: 'custom', start: '0:02.5', end: '4.5' }), i = r.info;
    check('A5 · a Custom render lasts End minus Start (2 s ± 0.1), video and audio, named after its times', i.video && Math.abs(i.duration - 2) <= .1 && Math.abs(i.video.duration - 2) <= .1 && i.audio && Math.abs(i.audio.duration - 2) <= .1 && /2\.5s-4\.5s\.mp4$/.test(r.name), JSON.stringify({ d: i.duration, v: i.video && i.video.duration, a: i.audio && i.audio.duration }) + ' ' + r.name);
    const f = await firstFrame(r.buf);
    check('A5 · its first frame is the shot at Start (green, from 2 s)', near(f, GREEN), JSON.stringify(f));
    check('A5 · the timeline marks are unchanged afterwards (1 s and 3 s)', JSON.stringify(await marks(page)) === '[1,3]', JSON.stringify(await marks(page)));
    check('A6/fallback · the Done state says the audio is Opus, plainly (this browser has no AAC encoder)', i.audio && (i.audio.codec === 'mp4a' ? i.audio.aot === 2 : /Audio is Opus: plays in Chrome and VLC, not in iPhone Photos or QuickTime/.test(r.said)), (i.audio && i.audio.codec) + ' | ' + r.said);
    /* no selection: Custom pre-fills 0 and the song's end; default goes back to All */
    await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('Alt+x'); await sleep(100);
    await openDialog(page); s = await state(page);
    check('A4 · without a selection the dialog opens on All', s.range === 'all', JSON.stringify(s));
    await page.check(radio(page, 'custom')); await sleep(80); s = await state(page);
    check('A4 · without a selection Custom pre-fills 0:00.0 and the song\'s end (0:06.0)', s.start === '0:00.0' && s.end === '0:06.0' && s.go, JSON.stringify(s));
    await closeDialog(page);
  });
  await section('A4 parsing', async () => {
    const page = D.page; await load(D, long); await openDialog(page); await page.check(radio(page, 'custom')); await sleep(80);
    const seen = {};
    for (const v of ['1:15', '75', '1:15.5', '75.5']) { await typeIn(page, '#rnStart', v); await typeIn(page, '#rnEnd', '1:20'); const s = await state(page); seen[v] = s; }
    const t = v => seen[v].cusT;
    check('A4 · 1:15 and 75 parse to the same instant (1:15.0), 1:15.5 and 75.5 to 1:15.5; Render enabled', /^1:15\.0 to 1:20\.0/.test(t('1:15')) && t('1:15') === t('75') && /^1:15\.5 to 1:20\.0/.test(t('1:15.5')) && t('1:15.5') === t('75.5') && Object.values(seen).every(s => s.go && !s.msg), JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, s]) => [k, s.cusT + (s.go ? '' : ' (off)')]))));
    const mono = await page.evaluate(() => ['rnCusT', 'rnStart', 'rnEnd'].every(id => { const c = getComputedStyle(document.getElementById(id)); return /Mono/i.test(c.fontFamily) && /tabular-nums/.test(c.fontVariantNumeric); }));
    check('A4 · the parsed value and the fields use the app\'s mono tabular style', mono);
    await typeIn(page, '#rnStart', '75,5'); await typeIn(page, '#rnEnd', '80');
    check('A4 · a decimal comma (a phone keyboard in Spanish) reads as a point: 75,5 = 1:15.5', /^1:15\.5/.test((await state(page)).cusT), (await state(page)).cusT);
    const bad = [['End before Start', '1:20', '1:15'], ['End equal to Start', '75', '1:15'], ['End past the song\'s end', '1:00', '1:31'], ['Start past the end', '95', '100'], ['under 0.2 s', '10', '10.1'],
      ['letters', 'abc', '1:20'], ['seconds over 59', '1:75', '1:80'], ['a negative', '-3', '10'], ['an exponent', '1e3', '10'], ['empty Start', '', '10'], ['empty End', '10', ''], ['spaces only', '   ', '10'], ['two colons', '1:2:3', '10'], ['pasted junk', '0:10 to 0:20', '30'], ['Infinity', 'Infinity', '10'], ['hex', '0x10', '30']];
    const fails = [];
    for (const [what, a, b] of bad) { await typeIn(page, '#rnStart', a); await typeIn(page, '#rnEnd', b); const s = await state(page);
      if (!s.msg || s.go || s.msg.length > 60) fails.push(`${what}: msg "${s.msg}" go ${s.go}`); }
    check('A4 · rejects End ≤ Start, values past the song\'s end, ranges under 0.2 s and pasted garbage: a short inline message, Render disabled', !fails.length, fails.join(' | '));
    await typeIn(page, '#rnStart', '10'); await typeIn(page, '#rnEnd', '10.1'); await page.focus('#rnEnd'); await page.keyboard.press('Enter'); await sleep(300);
    check('A4 · Enter in an invalid field starts nothing', (await state(page)).mode === 'idle' && !(await page.evaluate(() => __A().rendering())));
    await shoot(page, 'dialog-custom-invalid-desktop-1440x900');
    await typeIn(page, '#rnStart', 'io'); await sleep(50);
    check('hostile · typing I or O in a Custom field doesn\'t move the timeline\'s marks', JSON.stringify(await marks(page)) === '[null,null]', JSON.stringify(await marks(page)));
    await closeDialog(page);
  });
  /* the selection changed while the dialog is open; the song replaced while Custom holds old times */
  await section('hostile desktop', async () => {
    const page = D.page; await load(D, fixture(media, { id: 'p-h' })); await seekTo(page, 1); await page.keyboard.press('i'); await seekTo(page, 3); await page.keyboard.press('o'); await sleep(80);
    await openDialog(page);
    await page.evaluate(() => __A().ioSet()); await sleep(100);
    let s = await state(page), dis = await page.$eval(radio(page, 'sel'), e => e.disabled);
    check('hostile · the selection cleared while the dialog is open: Current selection turns disabled and All is chosen', dis && s.range === 'all' && s.go, JSON.stringify(s));
    await page.evaluate(() => { __A().ioSet('in', 2); __A().ioSet('out', 5); }); await sleep(100);
    const t = await page.$eval('#rnSelT', e => e.textContent); dis = await page.$eval(radio(page, 'sel'), e => e.disabled);
    check('hostile · a selection made while the dialog is open shows up with its times', !dis && /^0:02\.0 to 0:05\.0/.test(t), t);
    await page.check(radio(page, 'custom')); await typeIn(page, '#rnStart', '2'); await typeIn(page, '#rnEnd', '5.5');
    await page.evaluate(() => { __A().cur().song.duration = 4.2; __A().renderAll(); }); await sleep(150);
    s = await state(page);
    check('hostile · the song replaced by a shorter one while Custom holds 2 to 5.5: inline message, Render disabled', !!s.msg && !s.go, JSON.stringify(s));
    await page.evaluate(() => document.getElementById('rnForm').requestSubmit()); await sleep(300);
    check('hostile · and a forced submit starts nothing', (await state(page)).mode === 'idle' && !(await page.evaluate(() => __A().rendering())));
    await closeDialog(page);
  });
  await D.ctx.close();

  /* ======== A6, A7: AAC stubbed off ======== */
  await section('A6 + A7', async () => {
    const S = await newPage(DESK, () => { if (window.AudioEncoder) { const f = AudioEncoder.isConfigSupported.bind(AudioEncoder); AudioEncoder.isConfigSupported = c => /^mp4a/.test(c.codec) ? Promise.resolve({ supported: false, config: c }) : f(c); } });
    await open(S); const page = S.page, atLoad = S.reqs.length; await load(S, fx);
    const r = await render(page, { keep: true, shot: 'done-opus-desktop-1440x900' }), a = r.info.audio;
    const aac = a && a.codec === 'mp4a' && a.oti === 0x40 && a.aot === 2;
    check('A6 · AudioEncoder AAC stubbed off: the audio is AAC-LC (mp4a, object type 0x40, AOT 2), or the Done state shows the Opus notice', aac || (a && a.codec === 'Opus' && /Audio is Opus: plays in Chrome and VLC, not in iPhone Photos or QuickTime/.test(r.said)), JSON.stringify(a) + ' | ' + r.said);
    await closeDialog(page);
    const names = S.reqs.map(u => new URL(u, origin).pathname), extra = names.filter(p => /aac|encoder|\.wasm/i.test(p));
    const muxAt = S.reqs.findIndex(u => /mp4-muxer\.js$/.test(u));
    check('A7 · no encoder file is fetched on page load or dialog open; only the muxer, once a render needs it (fallback: no AAC file exists)', !extra.length && muxAt >= atLoad, JSON.stringify({ extra, muxAt, atLoad }));
    /* a render without a song: no audio, so no Opus notice */
    await load(S, fixture(media, { id: 'p-silent', noSong: true }));
    const q = await render(page, { keep: true });
    check('A6 · a render with no song has no audio track and no Opus notice', !q.info.audio && !/Opus/.test(q.said), q.said);
    await closeDialog(page);
    await S.ctx.close();
  });

  /* ======== cancel while the encoder (the muxer) is loading; a second render during the first ======== */
  await section('hostile cancel', async () => {
    delayMuxer = 1500;
    const C = await newPage(DESK); await open(C); await load(C, fx); const page = C.page; let downloads = 0; page.on('download', () => downloads++);
    await openDialog(page); await page.click('#rnGo'); await sleep(200);
    const running = (await state(page)).mode === 'run'; await page.click('#rnCancel'); await sleep(2500);
    const s = await state(page);
    check('hostile · Cancel while the encoder file is still loading: back to idle, no download, nothing left running', running && s.mode === 'idle' && !downloads && !(await page.evaluate(() => __A().rendering())), JSON.stringify({ running, s, downloads }));
    delayMuxer = 0;
    const r = await render(page, { keep: true }), i = r.info;
    check('hostile · the next render after that cancel works (6 s file)', i.video && Math.abs(i.duration - 6) <= .1, JSON.stringify(i.duration));
    await closeDialog(page); downloads = 0;
    await openDialog(page); await page.evaluate(() => { const g = document.getElementById('rnGo'); g.click(); g.click(); document.getElementById('rnForm').requestSubmit(); });
    await page.waitForSelector('#dlgRender[data-mode="done"]', { timeout: 60000 }); await sleep(800);
    check('hostile · a second render started during the first (double click, a submit) makes exactly one file', downloads === 1, String(downloads));
    await C.ctx.close();
  });

  /* ======== A2 (phone), A3: the phone's ruler ======== */
  for (const h of [844, 667]) await section(`A3 phone 390×${h}`, async () => {
    const M = await newPage(PHONE(h)); await open(M); await load(M, fx); const page = M.page, tag = `phone-390x${h}`;
    await seekTo(page, 3); await sleep(200);
    let g = await grips(page);
    const atRest = g.length === 2 && g.every(x => x.shown) && JSON.stringify(await marks(page)) === '[null,null]';
    check(`A3 · ${tag}: both handles are on the ruler with no selection, resting at the start and the end of the song`, atRest && g.find(x => x.k === 'in').x < g.find(x => x.k === 'out').x, JSON.stringify(g));
    check(`A3 · ${tag}: grips are ≥ 44px`, g.every(x => x.w >= 44 && x.h >= 44), JSON.stringify(g.map(x => [x.w, x.h])));
    await openDialog(page);
    let dis = await page.$eval(radio(page, 'sel'), e => e.disabled), hint = await page.$eval('#rnSelHint', e => e.getClientRects().length ? e.textContent.trim() : '');
    check(`A2 · ${tag}, no selection: Current selection disabled with the hint`, dis && hint === "Drag the two handles on the timeline's ruler", JSON.stringify({ dis, hint }));
    await shoot(page, `dialog-all-${tag}`); await closeDialog(page);
    const X = await ruler(page, 6);
    await dragGrip(page, 'in', X(1)); let m = await marks(page);
    check(`A3 · ${tag}: dragging the start handle from its resting end creates the selection (in ≈ 1 s)`, m[0] != null && Math.abs(m[0] - 1) < .15 && m[1] == null, JSON.stringify(m));
    await dragGrip(page, 'out', X(4)); m = await marks(page);
    check(`A3 · ${tag}: dragging the end handle sets the out point (≈ 4 s)`, Math.abs(m[0] - 1) < .15 && Math.abs(m[1] - 4) < .15, JSON.stringify(m));
    const clr = await page.evaluate(() => { const b = document.getElementById('mkClear'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, text: b.textContent.trim(), onScreen: r.left >= 0 && r.right <= innerWidth }; });
    check(`A3 · ${tag}: a Clear affordance is on the ruler while a selection exists (≥ 44px, on screen)`, clr && clr.w >= 44 && clr.h >= 44 && clr.onScreen && /Clear/.test(clr.text), JSON.stringify(clr));
    await shoot(page, `ruler-selection-${tag}`);
    /* stacking: a handle passing behind Clear stays draggable; one passing behind the zoom buttons doesn't take their taps */
    const stack = await page.evaluate(() => { const c = document.getElementById('mkClear').getBoundingClientRect(), f = document.getElementById('zfit').getBoundingClientRect(), g = document.querySelector('.mkgrip[data-mk="in"]'), was = g.style.left, top = (x, y) => document.elementFromPoint(x, y);
      const box = g.parentElement.getBoundingClientRect(), at = r => { g.style.left = (r.left + r.width / 2 - box.left) + 'px'; return top(r.left + r.width / 2, r.top + r.height / 2); };
      const overClear = at(c) === g, overFit = !!at(f).closest('#zfit'); g.style.left = was; return { overClear, overFit }; });
    check(`A3 · ${tag}: a handle behind Clear is still the thing a finger grabs; the zoom buttons keep their taps`, stack.overClear && stack.overFit, JSON.stringify(stack));
    await openDialog(page);
    dis = await page.$eval(radio(page, 'sel'), e => e.disabled); const st = await page.$eval('#rnSelT', e => e.textContent), chosen = (await state(page)).range;
    check(`A2 · ${tag}, with a selection: Current selection enabled and chosen, with its times`, !dis && chosen === 'sel' && /^0:01\.\d to 0:04\.\d/.test(st), JSON.stringify({ dis, st, chosen }));
    await shoot(page, `dialog-selection-${tag}`);
    await page.check(radio(page, 'custom')); await sleep(100); await shoot(page, `dialog-custom-${tag}`);
    const audit = await page.evaluate(() => { const d = document.getElementById('dlgRender'), r = d.getBoundingClientRect();
      const small = [...d.querySelectorAll('button,label.chk,input:not([type=radio])')].filter(e => e.getClientRects().length && !e.disabled).map(e => { const b = e.getBoundingClientRect(); return [e.id || e.textContent.trim().slice(0, 14), Math.round(b.width), Math.round(b.height)]; }).filter(x => x[2] < 44 || x[1] < 44);
      return { small, wide: document.documentElement.scrollWidth > innerWidth + 1 || d.scrollWidth > d.clientWidth + 1, onScreen: r.top >= -1 && r.bottom <= innerHeight + 1 }; });
    check(`${tag} · the dialog on Custom: touch targets ≥ 44px, no horizontal scroll, on screen`, !audit.small.length && !audit.wide && audit.onScreen, JSON.stringify(audit));
    await typeIn(page, '#rnStart', '5'); await typeIn(page, '#rnEnd', '2'); await shoot(page, `dialog-custom-invalid-${tag}`);
    await closeDialog(page);
    await page.tap('#mkClear'); await sleep(150);
    check(`A3 · ${tag}: Clear removes the selection; the handles go back to rest`, JSON.stringify(await marks(page)) === '[null,null]' && (await grips(page)).every(x => x.shown) && await page.$eval('#mkClear', b => b.hidden), JSON.stringify(await marks(page)));
    await dragGrip(page, 'in', X(2)); await dragGrip(page, 'out', X(5));
    await dragGrip(page, 'in', X(0) - 30); await dragGrip(page, 'out', X(6) + 30);
    check(`A3 · ${tag}: dragging both handles back to the ends clears the selection`, JSON.stringify(await marks(page)) === '[null,null]', JSON.stringify(await marks(page)));
    await M.ctx.close();
  });

  /* ======== A8: the side switch on the bar's centre ======== */
  await section('A8', async () => {
    const B = await newPage(DESK); await open(B); const page = B.page, offs = [];
    for (const proj of ['example', 'fixture']) {
      if (proj === 'fixture') await load(B, fixture(media, { id: 'p-bar', title: 'A project with a fairly long title' }));
      for (const w of [960, 1180, 1440, 1920]) { await page.setViewportSize({ width: w, height: w === 1920 ? 1080 : 900 }); await sleep(250);
        offs.push([proj, w, await page.evaluate(() => { const s = document.querySelector('.sides').getBoundingClientRect(), t = document.querySelector('.top').getBoundingClientRect(); return +(s.left + s.width / 2 - (t.left + t.width / 2)).toFixed(1); })]); }
    }
    check('A8 · Side A/B centred within 2px at 960, 1180, 1440 and 1920 (the example and a long-titled project)', offs.every(o => Math.abs(o[2]) <= 2), JSON.stringify(offs));
    await B.ctx.close();
  });

  const CATALOG = 'https://openrouter.ai/api/v1/videos/models';
  check('A7 · no third-party request at any point (only the app\'s own model-list call at start, aborted)', foreign.every(u => u === CATALOG), [...new Set(foreign.filter(u => u !== CATALOG))].join());
  check('no console errors or page errors in any run', !errs.length, errs.slice(0, 6).join(' | '));
} catch (e) {
  check('run completed', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' '));
} finally {
  await browser.close(); srv.close();
  const fails = results.filter(x => !x).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exitCode = fails ? 1 : 0;
}
