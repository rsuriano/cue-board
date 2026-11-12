// Video render, project frame ratio and in/out marks (docs/specs/export-render.md), one block per approval criterion:
// 1 ratio default, import, save and reload · 3 the monitor's frame · 4 the generation request · 5 marks (keys, drag,
// reload, typing, dialogs, key repeat) · 6 whole song per ratio (the file is parsed here: duration, tracks, codecs)
// · 7 a selection · 8 720p + watermark without an account, 1080p clean with one · 9 the real-time fallback · 10 cancel
// · 11 the muxer loads with the dialog, nothing third-party · 12 the phone · 14 the same from server.mjs · then the
// hostile cases (second render, closing mid-render, a missing take, a song replaced mid-render, a shot under one frame,
// memory on a longer song). Criterion 2 is packages/collab-client/test/history.test.mjs; a second tab in a room (1, 5)
// is design/render-collab-check.mjs. Screenshots go to <out-dir>.
//   node design/render-check.mjs <repo-root> <out-dir>
// Paths: CUE_TESTKIT (a folder with playwright-core) and CUE_CHROMIUM override the defaults below.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
const results = [], errs = [], warns = [], foreign = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(60); } }
const section = async (name, fn) => { try { await fn(); } catch (e) { check(name + ': ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' ')); } };
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--js-flags=--expose-gc', '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });

/* ---------- reading the produced file: an MP4's duration, tracks, sizes and codecs, straight from its boxes ---------- */
function boxes(b, s, e) { const o = []; while (s + 8 <= e) { let n = b.readUInt32BE(s), h = 8; const t = b.toString('latin1', s + 4, s + 8); if (n === 1) { n = Number(b.readBigUInt64BE(s + 8)); h = 16; } else if (n === 0) n = e - s; if (n < h) break; o.push({ t, s: s + h, e: s + n }); s += n; } return o; }
function mp4info(b) {
  const top = boxes(b, 0, b.length), moov = top.find(x => x.t === 'moov'); if (!moov) return { boxes: top.map(x => x.t), tracks: [] };
  const inner = boxes(b, moov.s, moov.e), mvhd = inner.find(x => x.t === 'mvhd'), v1 = b[mvhd.s] === 1;
  const scale = b.readUInt32BE(mvhd.s + (v1 ? 20 : 12)), d = v1 ? Number(b.readBigUInt64BE(mvhd.s + 24)) : b.readUInt32BE(mvhd.s + 16);
  const tracks = inner.filter(x => x.t === 'trak').map(tr => {
    const tb = boxes(b, tr.s, tr.e), tkhd = tb.find(x => x.t === 'tkhd'), w = tkhd.s + (b[tkhd.s] === 1 ? 88 : 76);
    const mdia = boxes(b, ...Object.values(tb.find(x => x.t === 'mdia')).slice(1)), hdlr = mdia.find(x => x.t === 'hdlr'), mdhd = mdia.find(x => x.t === 'mdhd'), m1 = b[mdhd.s] === 1;
    const minf = mdia.find(x => x.t === 'minf'), stbl = boxes(b, minf.s, minf.e).find(x => x.t === 'stbl'), stsd = boxes(b, stbl.s, stbl.e).find(x => x.t === 'stsd');
    return { type: b.toString('latin1', hdlr.s + 8, hdlr.s + 12), codec: b.toString('latin1', stsd.s + 12, stsd.s + 16), width: b.readUInt32BE(w) / 65536, height: b.readUInt32BE(w + 4) / 65536,
      duration: (m1 ? Number(b.readBigUInt64BE(mdhd.s + 24)) : b.readUInt32BE(mdhd.s + 16)) / b.readUInt32BE(mdhd.s + (m1 ? 20 : 12)) };
  });
  return { boxes: top.map(x => x.t), duration: d / scale, tracks, video: tracks.find(t => t.type === 'vide'), audio: tracks.find(t => t.type === 'soun') };
}
/* a mono 16-bit WAV: a quiet tone */
function wav(sec, rate = 8000) { const n = Math.round(sec * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 330) * 6000), 44 + i * 2); return b; }

/* ---------- pages ---------- */
async function newPage(opts = {}, init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, ...opts });
  const reqs = [], mine = [];
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob):/.test(u)) return r.continue(); foreign.push(u); mine.push(u); return r.abort(); });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('request', q => reqs.push(q.url()));
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(t)) errs.push(t); if (m.type() === 'warning' || /VideoFrame/.test(t)) warns.push(t); });
  page.on('pageerror', e => errs.push(e.message));
  return { ctx, page, reqs, foreign: mine };
}
const RED = [208, 32, 32], BLUE = [32, 48, 208], GREEN = [32, 192, 64], BLACK = [0, 0, 0];
const near = (a, b, tol = 40) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/* the fixture's media, made in a blank page: a 1.5 s H.264 clip (red, then blue from 0.75 s) and a green still */
async function makeMedia() {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const m = await page.evaluate(async ([RED, BLUE, GREEN]) => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'), css = a => `rgb(${a})`;
    g.fillStyle = css(GREEN); g.fillRect(0, 0, 320, 180); const image = c.toDataURL('image/png');
    const b64 = async blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    let clip = null;
    try {
      await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/mp4-muxer.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
      const mux = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width: 320, height: 180, frameRate: 30 }, fastStart: 'in-memory' });
      const enc = new VideoEncoder({ output: (ch, meta) => mux.addVideoChunk(ch, meta), error: () => {} });
      enc.configure({ codec: 'avc1.42001f', width: 320, height: 180, bitrate: 1e6, framerate: 30 });
      for (let f = 0; f < 45; f++) { g.fillStyle = css(f < 22 ? RED : BLUE); g.fillRect(0, 0, 320, 180); const vf = new VideoFrame(c, { timestamp: f * 1e6 / 30, duration: 1e6 / 30 }); enc.encode(vf, { keyFrame: f % 15 === 0 }); vf.close(); }
      await enc.flush(); mux.finalize(); clip = await b64(new Blob([mux.target.buffer], { type: 'video/mp4' }));
    } catch (e) { clip = null; }
    return { image, clip };
  }, [RED, BLUE, GREEN]);
  await ctx.close(); return m;
}
const sec = (id, start, o = {}) => ({ id, start, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', kind: '', clipDur: 0, takes: [], ...o });
function fixture(media, o = {}) {
  const d = o.dur || 6, song = wav(d);
  const sections = o.sections || [
    sec('s1', 0, { title: 'Clip', img: 'mv', kind: 'video', clipDur: 1.5, takes: [{ id: 't1', status: 'completed', media: 'mv', model: 'x/y', modelName: 'Y', res: '480p', dur: 4, prompt: '', created: 1 }] }),
    sec('s2', 2, { title: 'Still', img: 'mi', kind: 'image' }), sec('s3', 4, { title: 'Empty' })];
  const file = { format: 'cueboard', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', project: { id: o.id || 'p-render', title: o.title || 'Fixture: a/b', created: 1, updated: 1, song: { name: 'tone.wav', duration: d, peaks: [] }, sections },
    media: { mi: { type: 'image/png', data: media.image }, ...(media.clip ? { mv: { type: 'video/mp4', data: media.clip } } : {}) },
    song: { name: 'tone.wav', type: 'audio/wav', data: 'data:audio/wav;base64,' + song.toString('base64') } };
  return file;
}
async function open(p, url = origin + '/index.html') {
  await p.page.goto(url); await p.page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await p.page.evaluate(() => document.fonts.ready); await sleep(500);
}
async function load(p, file) {
  await p.page.setInputFiles('#importf', { name: 'fixture.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.page.waitForFunction(n => { const a = __A(); return a.cur() && a.S().length === n && !document.getElementById('play').disabled; }, file.project.sections.length, { timeout: 15000 });
  await sleep(400); await p.page.evaluate(() => document.activeElement && document.activeElement.blur());
}
/* the project's frame ratio: radio items under Frame in the More menu (the bar has no room for a selector) */
const setFrame = async (page, r) => { await page.click('#moreb'); await page.click(`#moremenu [data-ratio="${r}"]`); await sleep(120); };
const shown = page => page.evaluate(() => { const c = [...document.querySelectorAll('#moremenu [data-ratio][aria-checked="true"]')]; return c.length === 1 ? c[0].dataset.ratio : 'none or several'; });
const stored = (page, pid) => page.evaluate(async pid => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
  return new Promise(r => { const g = d.transaction('projects').objectStore('projects').get(pid); g.onsuccess = () => r(g.result || null); g.onerror = () => r(null); }); }, pid);
const pid = page => page.evaluate(() => __A().cur().id);
const marks = page => page.evaluate(() => { const m = __A().io(); return [m.in, m.out]; });
const seekTo = (page, t) => page.evaluate(t => { const a = document.getElementById('audio'), p = new Promise(r => { a.addEventListener('seeked', () => r(), { once: true }); setTimeout(r, 800); }); __A().seek(t); return p; }, t);
const mode = page => page.$eval('#dlgRender', d => (d.open ? d.dataset.mode : 'closed'));
const shoot = async (page, name) => { await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 3000 }).catch(() => {}); await page.screenshot({ path: `${out}/${name}.png` }); };
const openDialog = async page => { if (await page.isVisible('#renderb')) await page.click('#renderb'); else { await page.click('#proj'); await page.click('#mRender'); } await page.waitForSelector('#dlgRender[open]', { timeout: 4000 }); await sleep(250); };
/* one render through the dialog: the download, the file's bytes, and what the dialog said at the end */
async function render(page, o = {}) {
  if (!(await page.$eval('#dlgRender', d => d.open))) await openDialog(page);
  if (o.range) await page.check(`#dlgRender input[name="rnRange"][value="${o.range}"]`);
  if (o.res) await page.check(`#dlgRender input[name="rnRes"][value="${o.res}"]`);
  const t0 = Date.now(), dl = page.waitForEvent('download', { timeout: o.timeout || 90000 });
  await page.click('#rnGo'); if (o.onStart) await o.onStart();
  const d = await dl, path = await d.path(), buf = readFileSync(path);
  await page.waitForSelector('#dlgRender[data-mode="done"]', { timeout: 20000 });
  const said = await page.$eval('#dlgRender', el => el.innerText.replace(/\s+/g, ' ').trim()), msg = await page.$eval('#rnMsg', el => el.textContent);
  if (o.shot) await shoot(page, o.shot);
  if (!o.keep) { await page.click('#rnCancel'); await page.waitForFunction(() => !document.getElementById('dlgRender').open); }
  return { name: d.suggestedFilename(), buf, said, msg, ms: Date.now() - t0, info: /\.mp4$/.test(d.suggestedFilename()) ? mp4info(buf) : null };
}
/* play the produced file in a blank page and read pixels: the centre, and how far the bottom-right corner strays from it */
async function probe(buf, name, times) {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const r = await page.evaluate(async ([b64, type, times]) => {
    const blob = await (await fetch(`data:${type};base64,${b64}`)).blob(), v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
    const ok = await new Promise(r => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 10000); });
    if (!ok) return { ok: false, err: v.error && v.error.message };
    if (!isFinite(v.duration)) { v.currentTime = 1e6; await new Promise(r => { v.onseeked = r; setTimeout(r, 4000); }); }
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d', { willReadFrequently: true }), out = [];
    for (const t of times) {
      v.currentTime = t < 0 ? Math.max(0, v.duration + t) : t; await new Promise(r => { v.onseeked = r; setTimeout(r, 4000); }); await new Promise(r => setTimeout(r, 60));
      g.drawImage(v, 0, 0); const W = c.width, H = c.height, px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3), centre = px(W >> 1, H >> 1);
      const x0 = Math.round(W * .7), y0 = Math.round(H * .9), d = g.getImageData(x0, y0, W - x0, H - y0).data; let stray = 0;
      for (let i = 0; i < d.length; i += 4) stray = Math.max(stray, Math.abs(d[i] - centre[0]), Math.abs(d[i + 1] - centre[1]), Math.abs(d[i + 2] - centre[2]));
      out.push({ t, centre, left: px(4, H >> 1), right: px(W - 5, H >> 1), top: px(W >> 1, 4), bottom: px(W >> 1, H - Math.round(H * .2)), stray });
    }
    return { ok: true, duration: v.duration, w: v.videoWidth, h: v.videoHeight, audio: v.webkitAudioDecodedByteCount, frames: out };
  }, [buf.toString('base64'), /\.webm$/.test(name) ? 'video/webm' : 'video/mp4', times]);
  await ctx.close(); return r;
}
const ACCOUNT = () => { try { localStorage.setItem('cue.account', JSON.stringify({ session: 'test-session', email: 'tester@example.com' })); } catch (e) {} };
const DIMS = { '16:9': [[1280, 720], [1920, 1080]], '9:16': [[720, 1280], [1080, 1920]], '1:1': [[720, 720], [1080, 1080]], '4:3': [[960, 720], [1440, 1080]] };

let media = { image: '', clip: null };
try {
  media = await makeMedia();
  check('fixture: the page can make an H.264 clip with the vendored muxer (mp4-muxer.js is served from the repo)', !!media.clip);
  const fx = fixture(media);

  /* ======== 1 · ratio: default, old files, save and reload ======== */
  const D = await newPage(); await open(D);
  await section('1 ratio', async () => {
    const page = D.page;
    check('1 · the example (no `ratio`) opens as 16:9', await shown(page) === '16:9' && !('ratio' in await page.evaluate(() => __A().cur())), await shown(page));
    await load(D, fx); await page.evaluate(() => __A().flushNow()); await sleep(500);
    const id = await pid(page), st = await stored(page, id);
    check('1 · an old .cueboard.json imports unchanged: no `ratio` added, same shots, shown as 16:9', st && !('ratio' in st) && st.sections.map(s => s.title).join() === 'Clip,Still,Empty' && await shown(page) === '16:9', st && Object.keys(st).join());
    await setFrame(page, '9:16'); await page.evaluate(() => __A().flushNow()); await sleep(600);
    check('1 · setting 9:16 saves it in the project', (await stored(page, id))?.ratio === '9:16', JSON.stringify((await stored(page, id))?.ratio));
    await page.reload(); await page.waitForSelector('.card'); await sleep(700);
    check('1 · after a reload the project is still 9:16', await shown(page) === '9:16' && (await page.evaluate(() => __A().cur().ratio)) === '9:16');
    await setFrame(page, '1:1'); await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('Control+z'); await sleep(250);
    check('2 · in the app: Ctrl+Z after changing the ratio puts the previous one back', await shown(page) === '9:16', await shown(page));
    await setFrame(page, '16:9'); await sleep(200);
  });

  /* ======== 3 · the monitor's frame ======== */
  const frameOf = page => page.evaluate(() => { const r = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; }, f = document.getElementById('mframe'), m = document.getElementById('monitor');
    const el = [document.getElementById('mimg'), document.getElementById('mvid')].find(e => !e.hidden); return { vw: innerWidth, f: r(f), m: r(m), el: el ? r(el) : null, fit: el ? getComputedStyle(el).objectFit : '', tag: el ? el.tagName : '' }; });
  const frameChecks = async (P, label, sel) => {
    for (const [ratio, want] of [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3]]) {
      await sel(ratio); await sleep(250);
      for (const [sid, tag] of [['s2', 'IMG'], ['s1', 'VIDEO']]) {
        await P.page.evaluate(sid => { const a = __A(), s = a.S().find(x => x.id === sid); a.seek(s.start + .3); }, sid); await sleep(350);
        const v = await frameOf(P.page), [fx0, fy0, fw, fh] = v.f, [mx, my, mw, mh] = v.m, a = fw / fh;
        const inside = fx0 >= mx - 1 && fy0 >= my - 1 && fx0 + fw <= mx + mw + 1 && fy0 + fh <= my + mh + 1 && mx >= -1 && mx + mw <= v.vw + 1, fills = Math.abs(fw - mw) < 2.5 || Math.abs(fh - mh) < 2.5;   // the monitor's hairline border
        const covers = v.el && v.fit === 'cover' && v.el.every((n, i) => Math.abs(n - v.f[i]) < 1.5);
        check(`3 · ${label} ${ratio} (${tag.toLowerCase()}): the frame is ${ratio}, as large as the monitor allows, on screen, and the media covers it`, Math.abs(a / want - 1) < .012 && inside && fills && covers && v.tag === tag && fw > 60, `frame ${fw.toFixed(1)}×${fh.toFixed(1)} = ${a.toFixed(4)} (want ${want.toFixed(4)}), monitor ${mw.toFixed(0)}×${mh.toFixed(0)}, ${v.tag} ${v.fit} ${v.el && v.el.map(n => n.toFixed(0))}`);
      }
      if (ratio === '9:16') await shoot(P.page, `monitor-9x16-${label.replace(/\W+/g, '-')}`);
    }
  };
  await section('3 monitor', async () => {
    await frameChecks(D, 'desktop 1440×900', r => setFrame(D.page, r));
    await setFrame(D.page, '16:9');
    await D.page.click('#moreb'); await sleep(200);
    const fr = await D.page.evaluate(() => ({ label: (document.querySelector('#moremenu .mlbl') || {}).textContent, items: [...document.querySelectorAll('#moremenu [data-ratio]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim() + (e.getAttribute('aria-checked') === 'true' ? '*' : '') + '/' + e.getAttribute('role')).join(' '), inSettings: !!document.querySelector('#dlgSettings [data-ratio], #dlgSettings #mFrame') }));
    check('1 · desktop: Frame is with the project, in More: a labelled group of the four ratios, the current one checked; not in Settings', fr.label === 'Frame' && fr.items === '16:9*/menuitemradio 9:16/menuitemradio 1:1/menuitemradio 4:3/menuitemradio' && !fr.inSettings, JSON.stringify(fr));
    await shoot(D.page, 'frame-selector-desktop-1440x900'); await D.page.keyboard.press('Escape');
    await D.page.evaluate(() => document.activeElement.blur());
  });

  /* ======== 5 · in/out marks ======== */
  await section('5 marks', async () => {
    const page = D.page; await page.evaluate(() => scrollTo(0, 0)); const hist0 = await page.evaluate(() => __A().hist().size());
    await seekTo(page, 1); await page.keyboard.press('i'); await seekTo(page, 3); await page.keyboard.press('o'); await sleep(150);
    let m = await marks(page);
    check('5 · I and O set the marks at the playhead', Math.abs(m[0] - 1) < .05 && Math.abs(m[1] - 3) < .05, JSON.stringify(m));
    await shoot(page, 'timeline-marks-desktop-1440x900');
    const geo = await page.evaluate(() => { const c = document.getElementById('tl'), r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, d: __A().cur().song.duration }; }), P = geo.w / geo.d;
    await page.mouse.move(geo.x + m[1] * P, geo.y + 9); await page.mouse.down(); await page.mouse.move(geo.x + 3.6 * P, geo.y + 9, { steps: 6 }); await page.mouse.move(geo.x + 4.5 * P, geo.y + 9, { steps: 6 }); await page.mouse.up(); await sleep(150);
    let m2 = await marks(page);
    check('5 · the out handle drags along the ruler', Math.abs(m2[1] - 4.5) < .06 && Math.abs(m2[0] - 1) < .05, JSON.stringify(m2));
    await page.mouse.move(geo.x + m2[0] * P, geo.y + 9); await page.mouse.down(); await page.mouse.move(geo.x + 2.5 * P, geo.y + 9, { steps: 8 }); await page.mouse.up(); await sleep(150);
    m2 = await marks(page);
    check('5 · the in handle drags too, and the playhead and the cuts stay where they were', Math.abs(m2[0] - 2.5) < .06 && Math.abs(m2[1] - 4.5) < .06 && (await page.evaluate(() => __A().S().map(s => s.start).join())) === '0,2,4', JSON.stringify(m2));
    const hist1 = await page.evaluate(() => __A().hist().size());
    await page.reload(); await page.waitForSelector('.card'); await page.waitForFunction(() => !document.getElementById('play').disabled); await sleep(500);
    m = await marks(page);
    check('5 · marks survive a reload, and are not in the project or its undo history', Math.abs(m[0] - 2.5) < .06 && Math.abs(m[1] - 4.5) < .06 && !/"(in|out|marks|io)"/.test(JSON.stringify(await stored(page, await pid(page)))) && hist0 === hist1, JSON.stringify(m) + ` history ${hist0} → ${hist1}`);
    await seekTo(page, .5); await page.click('#f-title'); await page.keyboard.type('io'); await sleep(100);
    check('5 · typing i and o in a field types, it sets no mark', JSON.stringify(await marks(page)) === JSON.stringify(m) && /io$/.test(await page.$eval('#f-title', e => e.value)), JSON.stringify(await marks(page)));
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('?'); await page.waitForSelector('#dlgKeys[open]'); await page.keyboard.press('i'); await page.keyboard.press('o'); await page.keyboard.press('Alt+x'); await page.keyboard.press('Escape'); await sleep(150);
    check('5 · with a dialog open, I, O and Alt+X do nothing', JSON.stringify(await marks(page)) === JSON.stringify(m), JSON.stringify(await marks(page)));
    check('5 · the shortcuts panel lists the marks', /Mark in/.test(await page.$eval('#dlgKeys', d => d.textContent)));
    await page.evaluate(() => { document.activeElement.blur(); for (const key of ['i', 'o']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), repeat: true, bubbles: true, cancelable: true })); }); await sleep(100);
    check('5 · a held key (auto-repeat) sets nothing', JSON.stringify(await marks(page)) === JSON.stringify(m), JSON.stringify(await marks(page)));
    await page.keyboard.press('Alt+x'); await sleep(100);
    check('5 · Alt+X clears both marks', JSON.stringify(await marks(page)) === '[null,null]', JSON.stringify(await marks(page)));
  });

  /* ======== 11 · the muxer loads with the dialog; 6 · the whole song, per ratio ======== */
  await section('6 whole song', async () => {
    const page = D.page;
    check('11 · no request for the muxer before the render dialog opens', !D.reqs.some(u => /mp4-muxer/.test(u)), D.reqs.filter(u => /mux/.test(u)).join());
    check('3/desktop · Render sits in the bar with its icon and its word', await page.isVisible('#renderb') && await page.$eval('#renderb', b => !!b.querySelector('svg') && /Render/.test(b.innerText) && b.querySelector('.lbl,span').getBoundingClientRect().width > 20));
    const barAt = async w => { await page.setViewportSize({ width: w, height: 900 }); await sleep(200); return page.evaluate(() => { const b = document.getElementById('renderb'), l = b.querySelector('.lbl').getBoundingClientRect(), t = document.querySelector('.top').getBoundingClientRect(), s = document.querySelector('.sides').getBoundingClientRect();
      return { word: l.width > 20 && l.height > 8, name: b.textContent.trim(), title: b.title, w: Math.round(b.getBoundingClientRect().width), off: Math.abs(s.left + s.width / 2 - t.left - t.width / 2), over: document.documentElement.scrollWidth - innerWidth, next: b.nextElementSibling.className, group: b.parentNode.className }; }); };
    const b19 = await barAt(1920), b14 = await barAt(1440), b12 = await barAt(1280), b8 = await barAt(820); await page.setViewportSize({ width: 1440, height: 900 }); await sleep(200);
    check('bar · Render is one of the project operations (before More), with its word at 1920 and 1440, the side switch still on the centre, no overflow', /projops/.test(b14.group) && b14.next === 'more' && b19.word && b14.word && b19.off <= 2 && b14.off <= 2 && [b19, b14, b12, b8].every(b => b.over <= 0), JSON.stringify([b19, b14]));
    check('bar · below 1440 Render is its icon alone (32px), still named Render with a tooltip', !b12.word && !b8.word && b12.w === 32 && b8.w === 32 && b12.name === 'Render' && !!b12.title, JSON.stringify([b12, b8]));
    await openDialog(page);
    check('11 · opening the dialog loads the muxer, from this origin', await until(() => D.reqs.some(u => u === origin + '/mp4-muxer.js'), 4000), D.reqs.filter(u => /mux/.test(u)).join());
    check('8 · without an account 1080p is disabled, with the hint', await page.$eval('#dlgRender input[name="rnRes"][value="1080"]', e => e.disabled) && await page.$eval('#dlgRender input[name="rnRes"][value="720"]', e => e.checked && !e.disabled) && /Log in or use your invite code for 1080p without watermark/.test(await page.$eval('#dlgRender', d => d.innerText)));
    check('6 · no marks: only Whole song is offered, with its length', !(await page.isVisible('#dlgRender input[name="rnRange"][value="sel"]')) && /0:06\.0/.test(await page.$eval('#rnAllT', e => e.textContent)), await page.$eval('#rnAllT', e => e.textContent));
    const box = await page.$eval('#dlgRender .dlg', e => { const c = getComputedStyle(e); return [c.paddingLeft, c.paddingTop, c.paddingRight, c.paddingBottom].join(); });
    check('dialog · 20px inset like the other dialogs', box === '20px,20px,20px,20px' && box === await page.$eval('#dlgExport .dlg', e => { const c = getComputedStyle(e); return [c.paddingLeft, c.paddingTop, c.paddingRight, c.paddingBottom].join(); }), box);
    await shoot(page, 'dialog-idle-desktop-1440x900');
    await page.click('#rnCancel');
    for (const ratio of Object.keys(DIMS)) {
      await setFrame(page, ratio); await sleep(150);
      const r = await render(page, ratio === '16:9' ? { shot: 'dialog-done-desktop-1440x900', onStart: async () => { await page.waitForSelector('#dlgRender[data-mode="run"]', { timeout: 3000 }).catch(() => {}); await shoot(page, 'dialog-progress-desktop-1440x900'); } } : {}), i = r.info || { tracks: [] }, [w, h] = DIMS[ratio][0];
      check(`6 · ${ratio}: an MP4 as long as the song (6 s ± 0.1), ${w}×${h} H.264, with an audio track`, i.video && Math.abs(i.duration - 6) <= .1 && Math.abs(i.video.duration - 6) <= .1 && i.video.width === w && i.video.height === h && i.video.codec === 'avc1' && i.audio && Math.abs(i.audio.duration - 6) <= .1, JSON.stringify(i) + ` in ${r.ms} ms`);
      check(`6 · ${ratio}: the file is named after the project, the ratio and the range`, r.name === `Fixture a b - ${ratio.replace(':', 'x')} - full.mp4` && r.said.includes(r.name) && /Done/.test(r.said) && /\d(\.\d)? (KB|MB)/.test(r.said), r.name + ' | ' + r.said);
      if (ratio === '16:9') check('6 · audio codec (AAC where the browser can encode it, else Opus in the same MP4)', i.audio && /^(mp4a|Opus)$/.test(i.audio.codec), i.audio && i.audio.codec);
      const p = await probe(r.buf, r.name, [.2, 1.2, 1.9, 2.5, 5]), f = p.frames || [];
      check(`6 · ${ratio}: plays; the take (red, then blue, last frame held), the still (green), the empty shot (black)`, p.ok && p.w === w && p.h === h && near(f[0].centre, RED) && near(f[1].centre, BLUE) && near(f[2].centre, BLUE) && near(f[3].centre, GREEN) && near(f[4].centre, BLACK, 24), JSON.stringify(f.map(x => x.centre)));
      check(`6 · ${ratio}: media covers the frame edge to edge (no bars)`, p.ok && ['left', 'right', 'top'].every(k => near(f[0][k], RED) && near(f[3][k], GREEN)), JSON.stringify([f[0], f[3]].map(x => x && [x.left, x.right, x.top])));
      if (ratio === '16:9') {
        check('8 · no account: 720p with the watermark in the bottom-right corner', i.video.height === 720 && f[3].stray > 60 && f[0].stray > 60 && near(f[3].bottom, GREEN), `stray ${f[0].stray}, ${f[3].stray}`);
        check('6 · audio is decodable', p.audio > 0, String(p.audio));
      }
    }
    await setFrame(page, '16:9');
    check('no VideoFrame is left open (no leak warning after a forced collection)', await (async () => { await page.evaluate(() => { gc(); gc(); }); await sleep(600); return !warns.some(w => /VideoFrame/.test(w)); })(), warns.filter(w => /VideoFrame/.test(w)).join(' | '));
  });

  /* ======== 7 · a selection ======== */
  await section('7 selection', async () => {
    const page = D.page;
    await seekTo(page, 2.5); await page.keyboard.press('i'); await seekTo(page, 4.5); await page.keyboard.press('o'); await sleep(100);
    await openDialog(page);
    check('7 · with marks the dialog offers Selection, selected, with its times', await page.isVisible('#dlgRender input[name="rnRange"][value="sel"]') && await page.$eval('#dlgRender input[name="rnRange"][value="sel"]', e => e.checked) && /0:02\.5.*0:04\.5/.test(await page.$eval('#rnSelT', e => e.textContent)) && await page.$eval('#rnSelT', e => /tabular-nums/.test(getComputedStyle(e).fontVariantNumeric) && /Mono/i.test(getComputedStyle(e).fontFamily)), await page.$eval('#rnSelT', e => e.textContent));
    const r = await render(page, { range: 'sel' }), i = r.info || {}, p = await probe(r.buf, r.name, [0, 1, -0.05]), f = p.frames || [];
    check('7 · the file lasts out minus in (2 s ± 0.1)', i.video && Math.abs(i.duration - 2) <= .1 && Math.abs(i.video.duration - 2) <= .1 && Math.abs(i.audio.duration - 2) <= .1 && /2\.5s-4\.5s\.mp4$/.test(r.name), JSON.stringify(i) + ' ' + r.name);
    check('7 · its first frame is the shot at the in point (green), its last the empty shot (black)', p.ok && near(f[0].centre, GREEN) && near(f[1].centre, GREEN) && near(f[2].centre, BLACK, 24), JSON.stringify(f.map(x => x.centre)));
    await openDialog(page); await page.click('#rnClear'); await sleep(100);
    check('7 · Clear in the dialog removes the marks and the Selection choice', JSON.stringify(await marks(page)) === '[null,null]' && !(await page.isVisible('#dlgRender input[name="rnRange"][value="sel"]')) && await page.$eval('#dlgRender input[name="rnRange"][value="all"]', e => e.checked));
    await page.click('#rnCancel');
    await seekTo(page, 1); await openDialog(page); await page.click('#rnIn'); await sleep(100);
    check('5/phone path · Set in from the dialog marks the playhead', Math.abs((await marks(page))[0] - 1) < .05 && await page.isVisible('#dlgRender input[name="rnRange"][value="sel"]'), JSON.stringify(await marks(page)));
    await page.click('#rnClear'); await page.click('#rnCancel');
  });

  /* ======== 10 · cancel; a second render; closing the dialog; a song replaced mid-render; memory ======== */
  await section('10 cancel', async () => {
    const page = D.page, long = fixture(media, { id: 'p-long', title: 'Long', dur: 40, sections: [sec('l1', 0, { img: 'mv', kind: 'video', clipDur: 1.5 }), sec('l2', 10, { img: 'mi', kind: 'image' }), sec('l3', 20, { img: 'mv', kind: 'video', clipDur: 1.5 }), sec('l4', 30)] });
    await load(D, long);
    let downloads = 0; page.on('download', () => downloads++);
    await openDialog(page); await page.click('#rnGo');
    await page.waitForFunction(() => parseInt(document.getElementById('rnPct').textContent) >= 5, null, { timeout: 30000 });
    check('10 · while it runs: a progress bar with percent, Render is not available', await page.isVisible('#rnProg') && /^\d+%$/.test(await page.$eval('#rnPct', e => e.textContent.trim())) && !(await page.isEnabled('#rnGo').catch(() => false) && await page.isVisible('#rnGo')));
    await page.evaluate(() => document.getElementById('rnGo').click()); await sleep(50);
    const t0 = Date.now(); await page.click('#rnCancel'); await page.waitForFunction(() => document.getElementById('dlgRender').dataset.mode !== 'run', null, { timeout: 5000 }); const took = Date.now() - t0;
    await sleep(1200);
    check('10 · Cancel stops within 1 s and nothing is downloaded', took < 1000 && downloads === 0 && await mode(page) === 'idle', `${took} ms, ${downloads} downloads, mode ${await mode(page)}`);
    /* closing the dialog mid-render (Escape) cancels too */
    await page.click('#rnGo'); await page.waitForFunction(() => parseInt(document.getElementById('rnPct').textContent) >= 3, null, { timeout: 30000 });
    await page.keyboard.press('Escape'); await sleep(1300);
    check('hostile · closing the dialog mid-render cancels it: no download, nothing left running', downloads === 0 && await mode(page) === 'closed' && !(await page.evaluate(() => __A().rendering())), `${downloads} downloads, mode ${await mode(page)}`);
    /* a new one right after, with the song replaced while it runs: it finishes on the song it started with */
    const heap0 = await page.evaluate(() => { gc(); return performance.memory.usedJSHeapSize; });
    const r = await render(page, { timeout: 180000, onStart: async () => { await page.waitForFunction(() => parseInt(document.getElementById('rnPct').textContent) >= 10, null, { timeout: 60000 }); await page.setInputFiles('#song', { name: 'other.wav', mimeType: 'audio/wav', buffer: wav(12) }); } });
    const heap1 = await page.evaluate(() => { gc(); gc(); return performance.memory.usedJSHeapSize; }), i = r.info || {};
    check('10 · a new render starts right after a cancel and finishes', i.video && Math.abs(i.duration - 40) <= .1, JSON.stringify(i) + ` in ${r.ms} ms`);
    check('hostile · the song replaced mid-render: the file keeps the length and sound it started with', i.audio && Math.abs(i.audio.duration - 40) <= .1 && Math.abs(i.video.duration - 40) <= .1 && downloads === 1, JSON.stringify(i));
    check('hostile · memory: a 40 s render leaves the JS heap where it was (± 48 MB), the file is not kept in it', heap1 - heap0 < 48e6, `${((heap1 - heap0) / 1e6).toFixed(1)} MB over, file ${(r.buf.length / 1e6).toFixed(1)} MB`);
    await page.evaluate(() => { gc(); gc(); }); await sleep(600);
    check('10 · no VideoFrame leak warnings after cancels', !warns.some(w => /VideoFrame/.test(w)), warns.filter(w => /VideoFrame/.test(w)).join(' | '));
  });

  /* ======== hostile: a take whose file is gone, a shot shorter than one frame ======== */
  await section('hostile media', async () => {
    const page = D.page, odd = fixture(media, { id: 'p-odd', title: 'Odd', dur: 3, sections: [sec('o1', 0, { img: 'mv', kind: 'video', clipDur: 1.5 }), sec('o2', 1, { img: 'mi', kind: 'image' }), sec('o3', 1.02, { img: 'mi', kind: 'image' }), sec('o4', 2)] });
    await load(D, odd);
    /* the take's file goes away (a collaborator deleted the take, the browser dropped it): storage and the page's cache */
    await page.evaluate(async () => { const a = __A(), id = a.S()[0].img; await a.assets().delete(id); });
    const r = await render(page, { keep: true }), i = r.info || {}, p = await probe(r.buf, r.name, [.3, 1.5, 2.5]), f = p.frames || [];
    check('hostile · a take that can\'t be read renders black, the render goes on, and the dialog names the shot', i.video && Math.abs(i.duration - 3) <= .1 && p.ok && near(f[0].centre, BLACK, 24) && near(f[1].centre, GREEN) && /Shot 01.*could not be read; it rendered black/.test(r.msg), r.msg + ' ' + JSON.stringify(f.map(x => x.centre)));
    check('hostile · a shot shorter than one frame (0.02 s) renders without a gap', i.video && Math.abs(i.video.duration - 3) <= .1 && near(f[2].centre, BLACK, 24), JSON.stringify(i));
    await shoot(page, 'dialog-done-with-note-desktop-1440x900'); await page.click('#rnCancel');
  });
  await D.ctx.close();

  /* ======== 8 · with an account ======== */
  await section('8 account', async () => {
    const A = await newPage({}, ACCOUNT); await open(A); await load(A, fx); const page = A.page;
    await openDialog(page);
    check('8 · with an account 1080p can be chosen, no hint', await page.$eval('#dlgRender input[name="rnRes"][value="1080"]', e => !e.disabled) && !/Log in or use your invite code/.test(await page.$eval('#dlgRender', d => d.innerText)));
    for (const res of ['720', '1080']) {
      const r = await render(page, { res }), i = r.info || {}, p = await probe(r.buf, r.name, [.2, 2.5]), f = p.frames || [];
      check(`8 · account, ${res}p: ${res === '720' ? '1280×720' : '1920×1080'}, no watermark`, i.video && i.video.height === +res && i.video.width === +res * 16 / 9 && p.ok && f[0].stray < 30 && f[1].stray < 30 && near(f[1].centre, GREEN), `${i.video && i.video.width}×${i.video && i.video.height}, stray ${f.map(x => x.stray)}`);
    }
    await setFrame(page, '9:16'); const r = await render(page, { res: '1080' });
    check('8 · account, 9:16 at 1080p is 1080×1920', r.info.video && r.info.video.width === 1080 && r.info.video.height === 1920, JSON.stringify(r.info.video));
    await A.ctx.close();
  });

  /* ======== 4 · the generation request ======== */
  await section('4 generation', async () => {
    const G = await newPage(); const bodies = [];
    const model = (id, ratios) => ({ id, name: id, supported_durations: [4], supported_resolutions: ['480p'], supported_frame_images: [], generate_audio: false, seed: false, pricing_skus: {}, ...(ratios ? { supported_aspect_ratios: ratios } : {}) });
    await G.ctx.route('https://openrouter.ai/**', r => { const q = r.request(), u = q.url();
      if (/\/videos\/models$/.test(u)) return r.fulfill({ json: { data: [model('test/ratios', ['16:9', '9:16', '1:1']), model('test/plain')] } });
      if (/\/videos$/.test(u) && q.method() === 'POST') { bodies.push(JSON.parse(q.postData())); return r.fulfill({ json: { id: 'job' + bodies.length, status: 'pending' } }); }
      return r.fulfill({ json: { status: 'pending', data: {} } }); });
    await open(G); await load(G, fx); const page = G.page;
    await page.click('#settingsb'); await page.fill('#setKey', 'sk-or-test'); await page.check('#setAll'); await page.click('#setForm button[type=submit]'); await sleep(600);
    await page.click('.sidetab[data-side="b"]'); await sleep(300); await page.fill('#bPrompt', 'the camera holds');
    const send = async (ratio, m) => { await page.click('.sidetab[data-side="a"]'); await setFrame(page, ratio); await page.click('.sidetab[data-side="b"]'); await sleep(150); await page.selectOption('#gModel', m); const n = bodies.length; await page.click('#gGo'); await until(() => bodies.length > n, 4000); return bodies[bodies.length - 1] || {}; };
    const a = await send('9:16', 'test/ratios'), b = await send('9:16', 'test/plain'), c = await send('4:3', 'test/ratios'), d = await send('16:9', 'test/ratios');
    check('4 · a model whose ratios include the project\'s gets it (9:16)', a.model === 'test/ratios' && a.aspect_ratio === '9:16', JSON.stringify(a.aspect_ratio));
    check('4 · a model without a ratios list gets 16:9', b.model === 'test/plain' && b.aspect_ratio === '16:9', JSON.stringify(b.aspect_ratio));
    check('4 · a model whose list lacks the project\'s ratio (4:3) gets 16:9; a 16:9 project sends 16:9', c.aspect_ratio === '16:9' && d.aspect_ratio === '16:9', JSON.stringify([c.aspect_ratio, d.aspect_ratio]));
    check('4 · no real API call left the page (every OpenRouter request was answered by the stub)', !G.foreign.length && bodies.length === 4, G.foreign.join());
    await G.ctx.close();
  });

  /* ======== 9 · the fallback: no WebCodecs ======== */
  await section('9 fallback', async () => {
    const F = await newPage({}, () => { try { delete window.VideoEncoder; } catch (e) {} window.VideoEncoder = undefined; }); await open(F); await load(F, fx); const page = F.page;
    await openDialog(page);
    check('9 · without VideoEncoder the dialog says it renders in real time', /real time/i.test(await page.$eval('#dlgRender', d => d.innerText)), await page.$eval('#dlgRender', d => d.innerText.replace(/\s+/g, ' ')));
    await shoot(page, 'dialog-idle-fallback-desktop-1440x900');
    const r = await render(page, { timeout: 60000 }), p = await probe(r.buf, r.name, [.3, 2.6]), f = p.frames || [];
    check('9 · it still makes a file that plays: 1280×720, about the song\'s length, the right shots, sound', p.ok && p.w === 1280 && p.h === 720 && p.duration > 5 && p.duration < 7.5 && near(f[0].centre, RED, 60) && near(f[1].centre, GREEN, 60) && p.audio > 0 && /\.(mp4|webm)$/.test(r.name) && r.ms > 5500, `${r.name}, ${p.ok ? p.duration.toFixed(2) : p.err} s, ${JSON.stringify(f.map(x => x.centre))}, audio ${p.audio}, ${r.ms} ms`);
    await F.ctx.close();
  });

  /* ======== 12 · the phone ======== */
  for (const [w, h] of [[390, 844], [390, 667]]) await section(`12 phone ${w}×${h}`, async () => {
    const M = await newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await open(M); await load(M, fx); const page = M.page, tag = `phone-${w}x${h}`;
    if (h === 844) await frameChecks(M, `phone ${w}×${h}`, async r => { await page.evaluate(r => { const s = document.getElementById('mFrame'); s.value = r; s.dispatchEvent(new Event('change', { bubbles: true })); }, r); });
    await page.evaluate(() => { const s = document.getElementById('mFrame'); s.value = '16:9'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await seekTo(page, 1); await page.tap('#proj'); await page.waitForSelector('#mProj[open]'); await sleep(300);
    check(`12 · ${w}×${h}: the Projects sheet has the Frame selector and a Render video row`, await page.isVisible('#mFrame') && await page.isVisible('#mRender') && /Render video/.test(await page.$eval('#mRender', e => e.innerText)));
    await page.$eval('#mRender', e => e.scrollIntoView({ block: 'center' })); await sleep(150); await shoot(page, `frame-selector-${tag}`);
    await page.tap('#mRender'); const two = await page.waitForSelector('#dlgRender[open]', { timeout: 3000 }).then(() => true, () => false); await sleep(350);
    check(`12 · ${w}×${h}: the render dialog is two taps away (the project name, then Render video)`, two);
    const audit = async state => {
      const a = await page.evaluate(() => { const d = document.getElementById('dlgRender'), vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
        const small = [...d.querySelectorAll('button,label.chk,select,a')].filter(vis).filter(e => !e.disabled || e.tagName === 'LABEL').map(e => { const r = e.getBoundingClientRect(); return [e.id || e.textContent.trim().slice(0, 16), Math.round(r.width), Math.round(r.height)]; }).filter(x => x[2] < 44 || x[1] < 44);
        const texts = [...d.querySelectorAll('*')].filter(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())), hits = [];
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) { const a = texts[i], b = texts[j]; if (a.contains(b) || b.contains(a)) continue; const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
          const ox = Math.min(x.right, y.right) - Math.max(x.left, y.left), oy = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top); if (ox > 1 && oy > 1) hits.push(a.textContent.trim().slice(0, 14) + ' / ' + b.textContent.trim().slice(0, 14)); }
        const r = d.getBoundingClientRect(); return { small, hits, wide: document.documentElement.scrollWidth > innerWidth + 1 || d.scrollWidth > d.clientWidth + 1 || r.left < -1 || r.right > innerWidth + 1, onScreen: r.bottom <= innerHeight + 1 && r.top >= -1 }; });
      check(`12 · ${w}×${h} ${state}: no horizontal scroll, on screen, touch targets ≥ 44px, no text overlapping`, !a.wide && a.onScreen && !a.small.length && !a.hits.length, JSON.stringify(a));
    };
    await audit('idle'); await shoot(page, `dialog-idle-${tag}`);
    await page.tap('#rnIn'); await seekTo(page, 3); await page.tap('#rnOut'); await sleep(200);
    check(`12 · ${w}×${h}: Set in and Set out mark the playhead without a keyboard`, JSON.stringify((await marks(page)).map(v => Math.round(v))) === '[1,3]' && await page.$eval('#dlgRender input[name="rnRange"][value="sel"]', e => e.checked), JSON.stringify(await marks(page)));
    await audit('with a selection'); await shoot(page, `dialog-selection-${tag}`);
    await page.check('#dlgRender input[name="rnRange"][value="all"]');
    const dl = page.waitForEvent('download', { timeout: 90000 }); await page.tap('#rnGo');
    await page.waitForSelector('#dlgRender[data-mode="run"]', { timeout: 3000 }).catch(() => {}); await audit('in progress'); await shoot(page, `dialog-progress-${tag}`);
    const d = await dl, info = mp4info(readFileSync(await d.path())); await page.waitForSelector('#dlgRender[data-mode="done"]'); await sleep(200);
    check(`12 · ${w}×${h}: the phone renders the fixture (6 s, 1280×720)`, info.video && Math.abs(info.duration - 6) <= .1 && info.video.width === 1280, JSON.stringify(info));
    await audit('done'); await shoot(page, `dialog-done-${tag}`);
    await page.tap('#rnCancel'); await sleep(300); await shoot(page, `timeline-marks-${tag}`);
    await M.ctx.close();
  });

  /* ======== 14 · smoke: the app from server.mjs ======== */
  await section('14 smoke', async () => {
    const port = 5290 + Math.floor(Math.random() * 400), sv = spawn(process.execPath, [join(root, 'server.mjs')], { env: { ...process.env, PORT: String(port), OPENROUTER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let svLog = ''; sv.stdout.on('data', d => { svLog += d; }); sv.stderr.on('data', d => { svLog += d; });
    try {
      await until(() => /localhost/.test(svLog), 5000);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }), base = `http://127.0.0.1:${port}`, bad = [], perr = [];
      /* server.mjs proxies api/openrouter to OpenRouter: answered here, so this check never reaches the network */
      await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(base + '/api/openrouter/')) return r.fulfill({ status: 503, json: {} }); if (u.startsWith(base) || /^(data|blob):/.test(u)) return r.continue(); bad.push(u); return r.abort(); });
      await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
      const page = await ctx.newPage(); page.on('pageerror', e => perr.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) perr.push(m.text()); });
      await open({ page }, base + '/'); await load({ page }, fx);
      const r = await render(page), i = r.info || {};
      check('14 · served by server.mjs: loads with zero page errors and renders the fixture end to end', !perr.length && i.video && Math.abs(i.duration - 6) <= .1 && i.video.width === 1280 && !!i.audio, JSON.stringify(perr) + ' ' + JSON.stringify(i));
      check('11 · no third-party request at any point (server.mjs run)', !bad.length, bad.join());
      await ctx.close();
    } finally { sv.kill('SIGTERM'); }
  });
  /* the app asks OpenRouter for its model list when it starts (as before this feature; aborted here): nothing else may leave */
  const CATALOG = 'https://openrouter.ai/api/v1/videos/models';
  check('11 · no third-party request at any point: nothing but the app\'s own model-list call at start, none from the render', foreign.every(u => u === CATALOG), [...new Set(foreign.filter(u => u !== CATALOG))].join());
  check('no console errors or page errors in any run', !errs.length, errs.slice(0, 6).join(' | '));
} catch (e) {
  check('run completed', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' '));
} finally {
  await browser.close(); srv.close();
  const fails = results.filter(x => !x).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exitCode = fails ? 1 : 0;
}
