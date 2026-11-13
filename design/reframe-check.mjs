// Reframe: a frame image whose shape isn't the project's ratio gets a crop the user chooses, saved next to the image
// (the original stays). One block per approval criterion: 1 the dialog opens only on a mismatch · 2 drag and zoom stay
// in bounds (mouse, wheel, slider, keys; pinch on the phone) · 3 the crop shows in the monitor, the strip, the frame
// cards and the rendered video's pixels · 4 the generation request gets the cropped picture in the project's ratio
// (OpenRouter stubbed) · 5 after a ratio change the crop is kept but unused, the frame says so, Reframe fixes it ·
// 6 an old project opens unchanged · 7 the crop syncs between two browsers in a room (real sync server) · 8 the phone.
// Screenshots go to <out-dir>.
//   node design/reframe-check.mjs <repo-root> <out-dir>      (or through design/run-local.mjs)
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { touch, IOS } from './mobile-b-lib.mjs';
const { chromium } = createRequire(process.env.CUE_TESTKIT || '/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3372, dataDir = mkdtempSync(join(tmpdir(), 'cue-reframe-check-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const srv = createServer((q, r) => {
  const [path, qs = ''] = q.url.split('?');
  if (path === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>blank</title>'); return; }
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html') && /sync=1/.test(qs)) body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="ws://127.0.0.1:${SYNC_PORT}">`);
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
const results = [], errs = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(60); } }
const section = async (name, fn) => { try { await fn(); } catch (e) { check(name + ': ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' ')); } };
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

async function newPage(opts = {}, init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, ...opts });
  const foreign = [];
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob):/.test(u)) return r.continue(); foreign.push(u); return r.abort(); });
  await ctx.addInitScript(init || (() => { window.__CUE_MEDIA_TEST = {}; }));
  await ctx.addInitScript(() => { window.__A = () => window.__CUE_MEDIA_TEST.app; });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(t)) errs.push(t); });
  page.on('pageerror', e => errs.push(e.message));
  return { ctx, page, foreign };
}
const RED = [208, 32, 32], GREEN = [32, 192, 64], BLUE = [32, 48, 208], GREY = [128, 128, 128];
const near = (a, b, tol = 40) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/* the pictures: a 16:9 grey, one 1.4% off 16:9 (inside the warning's tolerance), and a square in three bands (red,
   green, blue from the top): a 16:9 crop at the top has red in the middle, the centred one green */
async function makeImages() {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const m = await page.evaluate(([RED, GREEN, BLUE, GREY]) => {
    const mk = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); f(g, w, h); return c.toDataURL('image/png').split(',')[1]; };
    const css = a => `rgb(${a})`, bands = (g, w, h) => [RED, GREEN, BLUE].forEach((col, i) => { g.fillStyle = css(col); g.fillRect(0, Math.round(h * i / 3), w, Math.ceil(h / 3) + 1); });
    return { grey: mk(1600, 900, (g, w, h) => { g.fillStyle = css(GREY); g.fillRect(0, 0, w, h); }), nearly: mk(1280, 730, (g, w, h) => { g.fillStyle = css(GREY); g.fillRect(0, 0, w, h); }),
      square: mk(900, 900, bands), small: mk(320, 180, (g, w, h) => { g.fillStyle = css(GREEN); g.fillRect(0, 0, w, h); }) };
  }, [RED, GREEN, BLUE, GREY]);
  await ctx.close(); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}
function wav(sec, rate = 8000) { const n = Math.round(sec * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 330) * 6000), 44 + i * 2); return b; }
const sec = (id, start, o = {}) => ({ id, start, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', kind: '', clipDur: 0, takes: [], ...o });
/* s1 a 16:9 still, s2 the square still (side A: the monitor, the strip and the render show it), s3 empty */
const fixture = (im, o = {}) => ({ format: 'cueboard', version: 1, exportedAt: '2026-01-01T00:00:00.000Z',
  project: { id: o.id || 'p-reframe', title: 'Reframe fixture', created: 1, updated: 1, song: { name: 'tone.wav', duration: 6, peaks: [] },
    sections: [sec('s1', 0, { title: 'Wide', img: 'mi', kind: 'image' }), sec('s2', 2, { title: 'Square', img: 'mq', kind: 'image', ...(o.s2 || {}) }), sec('s3', 4, { title: 'Empty' })] },
  media: { mi: { type: 'image/png', data: 'data:image/png;base64,' + im.small.toString('base64') }, mq: { type: 'image/png', data: 'data:image/png;base64,' + im.square.toString('base64') } },
  song: { name: 'tone.wav', type: 'audio/wav', data: 'data:audio/wav;base64,' + wav(6).toString('base64') } });
async function open(p, url = app) { await p.page.goto(url); await p.page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await p.page.evaluate(() => document.fonts.ready); await sleep(400); }
async function load(p, file) {
  await p.page.setInputFiles('#importf', { name: 'fixture.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.page.waitForFunction(n => { const a = __A(); return a.cur() && a.S().length === n && !document.getElementById('play').disabled; }, file.project.sections.length, { timeout: 15000 });
  await sleep(400); await p.page.evaluate(() => document.activeElement && document.activeElement.blur());
}
const stored = (page, pid) => page.evaluate(async pid => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
  return new Promise(r => { const g = d.transaction('projects').objectStore('projects').get(pid); g.onsuccess = () => r(g.result || null); g.onerror = () => r(null); }); }, pid);
const shotOf = (page, id) => page.evaluate(id => JSON.parse(JSON.stringify(__A().S().find(s => s.id === id))), id);
const setRatio = async (page, r) => { await page.click('#moreb'); await page.click(`#moremenu [data-ratio="${r}"]`); await sleep(200); };
const toB = async page => { await page.click('.sidetab[data-side="b"]'); await sleep(250); };
const toA = async page => { await page.click('.sidetab[data-side="a"]'); await sleep(250); };
const pickB = async (page, id) => { await page.evaluate(id => document.querySelector(`.bitem[data-id="${id}"]`).click(), id); await sleep(200); };
const dlgOpen = page => page.$eval('#dlgFrame', d => d.open);
const shoot = async (page, name) => { await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 3000 }).catch(() => {}); await page.screenshot({ path: `${out}/${name}.png` }); };
/* a picture by URL (blob/data): size, and the colour at the centre, near the top and near the bottom */
const sample = (page, url) => page.evaluate(async url => {
  const im = new Image(); im.src = url; await im.decode(); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0); const px = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
  return { w: c.width, h: c.height, centre: px(c.width / 2, c.height / 2), top: px(c.width / 2, c.height * .04), bottom: px(c.width / 2, c.height * .96) };
}, url);
/* the dialog's geometry: the box, the image, and whether the image still covers the box */
const geo = page => page.evaluate(() => { const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  const box = r('rfBox'), img = r('rfImg'), st = r('rfStage');
  return { box, img, st, zoom: +document.getElementById('rfZoom').value, covers: img[0] <= box[0] + .5 && img[1] <= box[1] + .5 && img[2] >= box[2] - .5 && img[3] >= box[3] - .5,
    fits: Math.abs(img[0] - box[0]) < .6 && Math.abs(img[2] - box[2]) < .6 || Math.abs(img[1] - box[1]) < .6 && Math.abs(img[3] - box[3]) < .6, title: document.getElementById('rfTitle').textContent }; });
const crop = v => (typeof v === 'string' ? v.split(' ') : null);
const cropOk = (v, ratio, iw, ih) => { const c = crop(v); if (!c || c[0] !== ratio) return false; const [x, y, w, h] = c.slice(1).map(Number), [a, b] = ratio.split(':').map(Number);
  return x >= 0 && y >= 0 && x + w <= 1.0002 && y + h <= 1.0002 && Math.abs((w * iw) / (h * ih) / (a / b) - 1) < .01; };
const drag = async (page, dx, dy) => { const b = await page.$eval('#rfStage', e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(b[0], b[1]); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(b[0] + dx * i / 8, b[1] + dy * i / 8); await page.mouse.up(); await sleep(80); };
const upload = (page, input, name, buf) => page.setInputFiles(input, { name, mimeType: 'image/png', buffer: buf });
/* play the produced MP4 in a blank page and read the centre pixel at time t */
async function probe(buf, t) {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const r = await page.evaluate(async ([b64, t]) => {
    const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(await (await fetch('data:video/mp4;base64,' + b64)).blob());
    if (!await new Promise(r => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 10000); })) return null;
    v.currentTime = t; await new Promise(r => { v.onseeked = r; setTimeout(r, 4000); }); await new Promise(r => setTimeout(r, 80));
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { w: c.width, h: c.height, centre: px(c.width >> 1, c.height >> 1), top: px(c.width >> 1, 8), bottom: px(c.width >> 1, c.height - 40) };
  }, [buf.toString('base64'), t]);
  await ctx.close(); return r;
}

let server = null;
try {
  const im = await makeImages();
  const D = await newPage(), page = D.page;
  await open(D); await load(D, fixture(im));

  /* ======== 6 · an old project opens unchanged ======== */
  await section('6 old project', async () => {
    await page.evaluate(() => __A().flushNow()); await sleep(400);
    const st = await stored(page, 'p-reframe'), keys = st ? st.sections.flatMap(s => Object.keys(s)).filter(k => /Crop$/.test(k)) : ['no project'];
    check('6 · a project without crops imports and saves without any crop field', st && !keys.length, keys.join());
    await page.evaluate(() => __A().seek(3)); await sleep(350);
    const m = await page.evaluate(() => { const s = __A().S()[1]; return { src: document.getElementById('mimg').getAttribute('src'), orig: __A().mediaURL(s.img), card: document.querySelector('.card[data-id="s2"] img').getAttribute('src') }; });
    check('6 · the monitor and the strip show the original image (centred crop, as before)', m.src === m.orig && m.card === m.orig && !!m.orig);
    check('6 · opening it opened no dialog', !(await dlgOpen(page)));
    await toB(page); await pickB(page, 's2'); await sleep(300);
    const w = await page.$eval('#fStartWarn', e => e.textContent);
    check('6 · side B still warns about the square start frame (from side A), and offers Reframe', /^900×900, not 16:9: it may get cropped$/.test(w) && await page.isVisible('#fStartRf'), JSON.stringify(w));
  });

  /* ======== 1 · the dialog opens only on a mismatch ======== */
  await section('1 dialog on mismatch', async () => {
    await pickB(page, 's3');
    await upload(page, '#fStartIn', 'grey.png', im.grey); await until(async () => (await shotOf(page, 's3')).key, 6000); await sleep(800);
    check('1 · a 16:9 picture in a 16:9 project: no dialog', !(await dlgOpen(page)) && !!(await shotOf(page, 's3')).key);
    await upload(page, '#fStartIn', 'nearly.png', im.nearly); await sleep(1500);
    check('1 · 1280×730 (1.4% off, inside the warning\'s 3.4%): no dialog', !(await dlgOpen(page)));
    await upload(page, '#fStartIn', 'square.png', im.square);
    check('1 · a square picture in a 16:9 project: the Reframe dialog opens', !!(await until(() => dlgOpen(page), 6000)));
    await sleep(300); const g = await geo(page);
    check('1 · it says the target ratio, and starts at the smallest zoom: the box fits inside the picture (cover)', g.title === 'Reframe for 16:9' && g.zoom === 1 && g.covers && g.fits, JSON.stringify(g));
    await shoot(page, 'dialog-desktop-1440x900');
  });

  /* ======== 2 · drag and zoom bounds ======== */
  await section('2 bounds', async () => {
    await drag(page, 0, 900); let g = await geo(page);
    check('2 · dragging far past the edge stops at the picture\'s edge (the box never leaves the picture)', g.covers && Math.abs(g.img[1] - g.box[1]) < .6, JSON.stringify(g));
    await drag(page, 600, -2000); g = await geo(page);
    check('2 · the other way too (and sideways at zoom 1, the width is pinned)', g.covers && Math.abs(g.img[3] - g.box[3]) < .6 && Math.abs(g.img[0] - g.box[0]) < .6, JSON.stringify(g));
    const c = await page.$eval('#rfStage', e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.move(...c); for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -600); await sleep(30); } g = await geo(page);
    check('2 · wheel zooms in up to 4×, and the picture still covers the box', g.zoom === 4 && g.covers, JSON.stringify(g.zoom));
    await drag(page, 3000, 3000); g = await geo(page);
    check('2 · zoomed in, a drag past the corner stops at the corner', g.covers && Math.abs(g.img[0] - g.box[0]) < .6 && Math.abs(g.img[1] - g.box[1]) < .6, JSON.stringify(g));
    await page.mouse.move(...c); for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 900); await sleep(30); } g = await geo(page);
    check('2 · wheel back out stops at cover (zoom 1)', g.zoom === 1 && g.covers && g.fits, JSON.stringify(g.zoom));
    await page.$eval('#rfZoom', e => { e.value = '2'; e.dispatchEvent(new Event('input')); }); g = await geo(page);
    check('2 · the slider zooms (2×: the picture is twice the box\'s width)', Math.abs((g.img[2] - g.img[0]) / (g.box[2] - g.box[0]) - 2) < .02 && g.covers, JSON.stringify(g));
    await page.focus('#rfStage'); for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft'); g = await geo(page);
    check('2 · arrow keys move it, and stop at the edge', g.covers && Math.abs(g.img[0] - g.box[0]) < .6, JSON.stringify(g));
    await page.$eval('#rfZoom', e => { e.value = '1'; e.dispatchEvent(new Event('input')); }); await drag(page, 0, 900);
    await page.click('#rfOk'); await until(async () => !(await dlgOpen(page)));
    const s = await shotOf(page, 's3');
    check('2 · Use this framing saves "16:9 x y w h" next to the start frame: inside the picture, 16:9 in its pixels, at the top', cropOk(s.keyCrop, '16:9', 900, 900) && crop(s.keyCrop)[2] === '0', s.keyCrop);
    check('2 · the original stays: the start frame is the uploaded square', (await page.evaluate(id => __A().mediaBlob(id).then(b => createImageBitmap(b)).then(x => x.width + '×' + x.height), s.key)) === '900×900');
    await page.click('#fStartRf'); await until(() => dlgOpen(page)); await sleep(250); g = await geo(page);
    check('2 · Reframe on the card reopens it where it was (at the top)', Math.abs(g.img[1] - g.box[1]) < .6 && g.zoom === 1, JSON.stringify(g));
    await drag(page, 0, -300); await page.keyboard.press('Escape'); await sleep(200);
    check('2 · Esc closes it and changes nothing', !(await dlgOpen(page)) && (await shotOf(page, 's3')).keyCrop === s.keyCrop);
    await upload(page, '#fEndIn', 'square.png', im.square); await until(() => dlgOpen(page), 6000); await page.click('#rfAsIs'); await sleep(500);
    const e = await shotOf(page, 's3'), w = await page.$eval('#fEndWarn', el => el.textContent);
    check('2 · Use as is: no crop saved, the card keeps the usual warning', !!e.endKey && !('endCrop' in e) && /not 16:9: it may get cropped/.test(w), JSON.stringify([e.endCrop, w]));
  });

  /* ======== 3 · the crop in the monitor, strip, cards and the render ======== */
  let s2crop = '';
  await section('3 monitor, strip, render', async () => {
    await pickB(page, 's2'); await page.click('#fStartRf'); await until(() => dlgOpen(page)); await sleep(250);
    await drag(page, 0, 900); await page.click('#rfOk'); await until(async () => !(await dlgOpen(page)));
    s2crop = (await shotOf(page, 's2')).imgCrop;
    check('3 · Reframe on a start frame that comes from side A saves the crop on side A\'s image', cropOk(s2crop, '16:9', 900, 900), s2crop);
    await toA(page); await page.evaluate(() => __A().seek(3)); await sleep(300);
    const src = await until(() => page.evaluate(() => { const m = document.getElementById('mimg'), o = __A().mediaURL(__A().S()[1].img); return m.getAttribute('src') !== o && !m.hidden && m.complete && m.naturalWidth ? m.getAttribute('src') : ''; }));
    const m = src ? await sample(page, src) : null;
    check('3 · the monitor shows the crop: 16:9 pixels, red (the top band) in the middle, not the centred green', m && Math.abs(m.w / m.h - 16 / 9) < .01 && near(m.centre, RED) && near(m.top, RED) && near(m.bottom, GREEN), JSON.stringify(m));
    const card = await page.$eval('.card[data-id="s2"] img', e => e.getAttribute('src'));
    check('3 · the strip\'s card shows the same cropped picture', card === src);
    await shoot(page, 'monitor-reframed-1440x900');
    await toB(page); await pickB(page, 's2'); await sleep(300);
    const fc = await page.$eval('#fStartImg img', e => e.getAttribute('src')), bl = await page.$eval('.bitem[data-id="s2"] img', e => e.getAttribute('src')), w = await page.$eval('#fStartWarn', e => e.textContent);
    check('3 · side B: the start frame card and the shot list show the crop, and the warning is gone', fc === src && bl === src && w === '', JSON.stringify(w));
    await page.evaluate(() => __A().doUndo('undo')); await sleep(300);
    const undone = !('imgCrop' in await shotOf(page, 's2'));
    await page.evaluate(() => __A().doUndo('redo')); await sleep(300);
    check('3 · Undo takes the framing back, Redo puts it back', undone && (await shotOf(page, 's2')).imgCrop === s2crop);
    await toA(page);
    await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(300);
    const dl = page.waitForEvent('download', { timeout: 90000 }); await page.click('#rnGo');
    const buf = readFileSync(await (await dl).path()); await page.waitForSelector('#dlgRender[data-mode="done"]', { timeout: 20000 }); await page.click('#rnCancel');
    const v = await probe(buf, 3), v1 = await probe(buf, 1);
    check('3 · the rendered video shows the crop on shot 2: red in the middle at 3 s, 1280×720', v && v.w === 1280 && v.h === 720 && near(v.centre, RED) && near(v.top, RED), JSON.stringify(v));
    check('3 · a shot without a crop renders as before (shot 1, 16:9 green)', v1 && near(v1.centre, GREEN), JSON.stringify(v1));
  });

  /* ======== 4 · the generation request ======== */
  await section('4 generation', async () => {
    const bodies = [];
    await D.ctx.route('https://openrouter.ai/**', r => { const q = r.request(), u = q.url();
      if (/\/videos\/models$/.test(u)) return r.fulfill({ json: { data: [{ id: 'test/frames', name: 'Frames', supported_durations: [4], supported_resolutions: ['480p'], supported_frame_images: ['first_frame', 'last_frame'], generate_audio: false, seed: false, pricing_skus: {}, supported_aspect_ratios: ['16:9', '9:16', '1:1', '4:3'] }] } });
      if (/\/videos$/.test(u) && q.method() === 'POST') { bodies.push(JSON.parse(q.postData())); return r.fulfill({ json: { id: 'job' + bodies.length, status: 'pending' } }); }
      return r.fulfill({ json: { status: 'pending', data: {} } }); });
    await page.click('#settingsb'); await page.fill('#setKey', 'sk-or-test'); await page.check('#setAll'); await page.click('#setForm button[type=submit]'); await sleep(700);
    await toB(page); await pickB(page, 's3'); await page.fill('#bPrompt', 'the camera holds'); await page.selectOption('#gModel', 'test/frames').catch(() => {});
    await page.click('#gGo'); await until(() => bodies.length > 0, 6000);
    const b = bodies[0] || {}, fr = b.frame_images || [], first = fr.find(f => f.frame_type === 'first_frame'), last = fr.find(f => f.frame_type === 'last_frame');
    const a = first ? await sample(page, first.image_url.url) : null, z = last ? await sample(page, last.image_url.url) : null;
    check('4 · the start frame sent is the crop: 16:9 pixels, red in the middle (the top of the square)', a && Math.abs(a.w / a.h - 16 / 9) < .01 && near(a.centre, RED) && near(a.top, RED), JSON.stringify(a));
    check('4 · the end frame left "as is" goes as it is (900×900)', z && z.w === 900 && z.h === 900 && near(z.centre, GREEN), JSON.stringify(z && [z.w, z.h]));
    check('4 · the request asks for the project\'s ratio', b.aspect_ratio === '16:9', b.aspect_ratio);
    await pickB(page, 's2'); await page.fill('#bPrompt', 'the camera holds'); const n = bodies.length; await page.click('#gGo'); await until(() => bodies.length > n, 6000);
    const f2 = (bodies[n] || {}).frame_images?.find(f => f.frame_type === 'first_frame'), c2 = f2 ? await sample(page, f2.image_url.url) : null;
    check('4 · a start frame from side A goes with side A\'s crop', c2 && Math.abs(c2.w / c2.h - 16 / 9) < .01 && near(c2.centre, RED), JSON.stringify(c2));
    check('4 · no generation request left the page (the stub answered every one)', !D.foreign.some(u => /\/videos$/.test(u)) && bodies.length === 2, D.foreign.join());
  });

  /* ======== 5 · reframe after a ratio change ======== */
  await section('5 ratio change', async () => {
    await toA(page); await setRatio(page, '9:16'); await toB(page); await pickB(page, 's3'); await sleep(400);
    const s = await shotOf(page, 's3'), w = await page.$eval('#fStartWarn', e => e.textContent), src = await page.$eval('#fStartImg img', e => e.getAttribute('src'));
    check('5 · 9:16: the 16:9 crop is kept in the project (nothing lost) but not used: the card shows the original', crop(s.keyCrop)?.[0] === '16:9' && src === await page.evaluate(id => __A().mediaURL(id), s.key), s.keyCrop);
    check('5 · the card says so and offers Reframe', w === 'Framed for 16:9: reframe it for 9:16' && await page.isVisible('#fStartRf'), JSON.stringify(w));
    await shoot(page, 'reframe-hint-9x16-1440x900');
    await page.click('#fStartRf'); await until(() => dlgOpen(page)); await sleep(250); const g = await geo(page);
    check('5 · the dialog opens for 9:16, at cover', g.title === 'Reframe for 9:16' && g.zoom === 1 && g.covers && g.fits && (g.box[3] - g.box[1]) > (g.box[2] - g.box[0]), JSON.stringify(g));
    await shoot(page, 'dialog-9x16-desktop-1440x900');
    await page.click('#rfOk'); await sleep(400);
    const s9 = await shotOf(page, 's3');
    check('5 · Use this framing saves a 9:16 crop', cropOk(s9.keyCrop, '9:16', 900, 900), s9.keyCrop);
    await toA(page); await page.evaluate(() => __A().seek(3)); await sleep(400);
    const m = await page.evaluate(() => [document.getElementById('mimg').getAttribute('src'), __A().mediaURL(__A().S()[1].img)]);
    check('5 · side A\'s 16:9 crop on shot 2 isn\'t used in 9:16: the monitor shows the original, centred', m[0] === m[1]);
    await setRatio(page, '16:9'); await sleep(400);
    const m2 = await until(() => page.evaluate(() => { const a = document.getElementById('mimg').getAttribute('src'); return a !== __A().mediaURL(__A().S()[1].img) && a; }));
    check('5 · back to 16:9, shot 2\'s kept crop applies again', !!m2 && (await shotOf(page, 's2')).imgCrop === s2crop);
  });

  /* ======== 8 · the phone ======== */
  await section('8 phone 390×844', async () => {
    const P = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS });
    await open(P); await load(P, fixture(im, { id: 'p-phone' })); const pg = P.page;
    await pg.click('#mTabs [data-side="b"]'); await sleep(400); await pickB(pg, 's3');
    await upload(pg, '#fStartIn', 'square.png', im.square);
    check('8 · phone: a square start frame opens the Reframe dialog', !!(await until(() => dlgOpen(pg), 6000))); await sleep(400);
    const lay = await pg.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(), d = r('dlgFrame'), st = r('rfStage');
      return { sheet: Math.abs(d.bottom - innerHeight) < 2 && Math.abs(d.width - innerWidth) < 2, inView: d.top >= 0, st: [st.width, st.height], hs: ['rfOk', 'rfAsIs', 'rfZoom'].map(i => Math.round(r(i).height)), over: document.documentElement.scrollWidth - innerWidth }; });
    check('8 · phone: it is a bottom sheet, on screen, the stage usable, 44px targets, no sideways scroll', lay.sheet && lay.inView && lay.st[0] > 300 && lay.st[1] > 200 && lay.hs.every(h => h >= 44) && lay.over <= 0, JSON.stringify(lay));
    await shoot(pg, 'dialog-phone-390x844');
    const c = await pg.$eval('#rfStage', e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await touch(pg, [[[c[0] - 30, c[1]], [c[0] + 30, c[1]]], [[c[0] - 110, c[1]], [c[0] + 110, c[1]]]]);
    let g = await geo(pg);
    check('8 · phone: pinch zooms in, the picture still covers the box', g.zoom > 1.5 && g.covers, JSON.stringify(g.zoom));
    for (let i = 0; i < 3; i++) await touch(pg, [[c[0], c[1] - 150], [c[0], c[1] + 200]]);
    g = await geo(pg);
    check('8 · phone: a one-finger drag moves it and stops at the edge', g.covers && Math.abs(g.img[1] - g.box[1]) < .6, JSON.stringify(g));
    await pg.tap('#rfOk'); await sleep(500);
    const s = await shotOf(pg, 's3');
    check('8 · phone: Use this framing saves the crop', cropOk(s.keyCrop, '16:9', 900, 900) && !(await dlgOpen(pg)), s.keyCrop);
    await shoot(pg, 'frame-card-phone-390x844');
    await P.ctx.close();
  });

  /* ======== 7 · sync between two browsers ======== */
  await section('7 sync', async () => {
    const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', LOG_LEVEL: 'warn', APP_URL: app + '?sync=1' };
    const r = spawnSync(process.execPath, [join(root, 'packages/sync-server/bin/create-project.mjs'), 'Reframe check'], { env, encoding: 'utf8' });
    const link = /app: +(\S+)/.exec(r.stdout)?.[1], mm = /#join=([^.]+)\.(\S+)$/.exec(link || '');
    if (!mm) throw new Error('create-project printed no link: ' + r.stdout + r.stderr);
    server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
    for (let i = 0; i < 50 && !/listening/.test(log); i++) await sleep(100);
    const off = () => { window.__CUE_MEDIA_TEST = { off: true }; };
    const A = await newPage({}, off), B = await newPage({}, off);
    const chip = p => p.evaluate(() => (document.getElementById('mstatw').hidden ? '' : document.getElementById('mhead').textContent));
    await open(A, app + '?sync=1'); await load(A, fixture(im, { id: 'p-sync' }));
    await A.page.goto(link); await A.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 9000 }); await A.page.fill('#jName', 'Ana'); await A.page.click('#jGo');
    await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 }); await A.page.click('#jShare');
    await until(async () => (await chip(A.page)) === 'Synced', 9000);
    await B.page.goto(link); await B.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 9000 }); await B.page.fill('#jName', 'Ben'); await B.page.click('#jGo');
    await B.page.waitForFunction(() => document.querySelectorAll('.card').length === 3, null, { timeout: 9000 }); await until(async () => (await chip(B.page)) === 'Synced', 9000);
    check('7 · two browsers in one room, the project shared', (await B.page.$$eval('.card .ct', e => e.map(x => x.textContent))).join() === 'Wide,Square,Empty');
    await toB(A.page); await pickB(A.page, 's2'); await A.page.click('#fStartRf'); await until(() => dlgOpen(A.page)); await sleep(250);
    await drag(A.page, 0, 900); await A.page.click('#rfOk');
    const want = await until(async () => (await shotOf(A.page, 's2')).imgCrop);
    const got = await until(async () => { const s = await shotOf(B.page, 's2'); return s.imgCrop === want && s.imgCrop; }, 8000);
    check('7 · A reframes shot 2; B gets the same crop on the same shot', !!want && got === want, JSON.stringify([want, got]));
    const Y = await import('yjs'), { WebsocketProvider } = await import('y-websocket'), { shotsMap } = await import('@cue-board/sync-server/schema');
    const doc = new Y.Doc(), pv = new WebsocketProvider(`ws://127.0.0.1:${SYNC_PORT}/r`, mm[1], doc, { protocols: ['cueboard', mm[2]], disableBc: true });
    await until(() => pv.synced, 6000); const raw = shotsMap(doc).get('s2')?.get('imgCrop'), img = shotsMap(doc).get('s2')?.get('img');
    check('7 · in the room\'s doc it is a plain string next to the image ref (an older app keeps it as an unknown field), the media ref is untouched', raw === want && img && typeof img === 'object' && /^[0-9a-f]{64}$/.test(img.sha256 || ''), JSON.stringify([raw, img && Object.keys(img)]));
    await B.page.click('.sidetab[data-side="a"]').catch(() => {}); await setRatio(B.page, '9:16');
    await until(async () => (await A.page.evaluate(() => __A().cur().ratio)) === '9:16', 8000);
    check('7 · B changes the ratio: A follows, the crop stays in both (kept, unused)', (await shotOf(A.page, 's2')).imgCrop === want && (await shotOf(B.page, 's2')).imgCrop === want && await A.page.$eval('#fStartWarn', e => e.textContent) === 'Framed for 16:9: reframe it for 9:16');
    pv.destroy(); doc.destroy(); await A.ctx.close(); await B.ctx.close();
  });

  check('no page errors', !errs.length, errs.slice(0, 5).join(' | '));
} finally {
  if (server) server.kill();
  await browser.close(); srv.close(); rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
