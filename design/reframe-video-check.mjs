// Reframe for videos, and side B's boxes in the project's ratio. One block per criterion:
// a · side B's frame boxes, frame variants and take tiles measure the project's ratio (16:9, 9:16, 1:1; desktop and
//     phone), a tall ratio stays within the screen · b · a clip on side A and a take on side B are reframed in the same
//     dialog (first frame, a scrubber, fixed crop), the crop persists after a reload and the monitor shows the cropped
//     region (pixels), the tile and the strip too; Undo and Use in cut follow · c · the render draws the cropped region
//     · d · an old project without crops shows and renders as before · e · hostile cases: a crop for another ratio, a
//     portrait clip in a landscape project (offered on upload), a very short clip, the clip still loading, a
//     collaborator changing the clip while the dialog is open · f · the take's crop syncs to a second browser.
//   node design/reframe-video-check.mjs <repo-root> <out-dir>      (or through design/run-local.mjs)
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { IOS } from './mobile-b-lib.mjs';
const { chromium } = createRequire(process.env.CUE_TESTKIT || '/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3373, dataDir = mkdtempSync(join(tmpdir(), 'cue-reframe-video-check-'));
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
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(origin) || /^(data|blob):/.test(u)) return r.continue(); return r.abort(); });
  await ctx.addInitScript(init || (() => { window.__CUE_MEDIA_TEST = {}; }));
  await ctx.addInitScript(() => { window.__A = () => window.__CUE_MEDIA_TEST.app; });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(t)) errs.push(t); });
  page.on('pageerror', e => errs.push(e.message));
  return { ctx, page };
}
const RED = [208, 32, 32], GREEN = [32, 192, 64], BLUE = [32, 48, 208], GREY = [128, 128, 128];
const near = (a, b, tol = 48) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/* the clips (H.264, made with the vendored muxer): a 360×360 square in three bands, red, green, blue from the top for
   the first second, then blue, green, red (so a 16:9 crop at the top is red, then blue; the centred one green); a
   180×320 portrait one, 3 frames long; a 320×180 grey one in 16:9. And a 16:9 grey still for the start frames */
async function makeMedia() {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const m = await page.evaluate(async ([RED, GREEN, BLUE, GREY]) => {
    const b64 = async blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/mp4-muxer.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    const css = a => `rgb(${a})`;
    async function clip(w, h, n, paint) {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      const mux = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: 30 }, fastStart: 'in-memory' });
      const enc = new VideoEncoder({ output: (ch, meta) => mux.addVideoChunk(ch, meta), error: () => {} });
      enc.configure({ codec: 'avc1.42001f', width: w, height: h, bitrate: 1e6, framerate: 30 });
      for (let f = 0; f < n; f++) { paint(g, w, h, f); const vf = new VideoFrame(c, { timestamp: f * 1e6 / 30, duration: 1e6 / 30 }); enc.encode(vf, { keyFrame: f % 15 === 0 }); vf.close(); }
      await enc.flush(); mux.finalize(); return b64(new Blob([mux.target.buffer], { type: 'video/mp4' }));
    }
    const bands = (g, w, h, f) => (f < 30 ? [RED, GREEN, BLUE] : [BLUE, GREEN, RED]).forEach((col, i) => { g.fillStyle = css(col); g.fillRect(0, Math.round(h * i / 3), w, Math.ceil(h / 3) + 1); });
    const fill = col => (g, w, h) => { g.fillStyle = css(col); g.fillRect(0, 0, w, h); };
    const still = document.createElement('canvas'); still.width = 640; still.height = 360; fill(GREY)(still.getContext('2d'), 640, 360);
    return { square: await clip(360, 360, 60, bands), portrait: await clip(180, 320, 3, bands), wide: await clip(320, 180, 30, fill(GREY)), still: still.toDataURL('image/png') };
  }, [RED, GREEN, BLUE, GREY]);
  await ctx.close(); return m;
}
function wav(sec, rate = 8000) { const n = Math.round(sec * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 330) * 6000), 44 + i * 2); return b; }
const sec = (id, start, o = {}) => ({ id, start, title: '', shot: '', notes: '', img: '', imgPrompt: '', vidPrompt: '', key: '', endKey: '', kind: '', clipDur: 0, takes: [], ...o });
const take = (id, media) => ({ id, status: 'completed', media, model: 'x/y', modelName: 'Y', res: '480p', dur: 2, clipDur: 2, prompt: 'a take', created: 1 });
/* s1: the square clip in the cut, uploaded on side A · s2: a start frame and a take of the square clip (another copy),
   not in the cut · s3: empty */
const fixture = (m, o = {}) => ({ format: 'cueboard', version: 1, exportedAt: '2026-01-01T00:00:00.000Z',
  project: { id: o.id || 'p-rfv', title: 'Reframe video', created: 1, updated: 1, song: { name: 'tone.wav', duration: 6, peaks: [] },
    sections: [sec('s1', 0, { title: 'Clip', img: 'mv', kind: 'video', clipDur: 2, ...(o.s1 || {}) }), sec('s2', 2, { title: 'Take', key: 'mk', takes: [take('t2', 'mw')] }), sec('s3', 4, { title: 'Empty' })] },
  media: { mv: { type: 'video/mp4', data: m.square }, mw: { type: 'video/mp4', data: m.square }, mk: { type: 'image/png', data: m.still } },
  song: { name: 'tone.wav', type: 'audio/wav', data: 'data:audio/wav;base64,' + wav(6).toString('base64') } });
async function open(p, url = app) { await p.page.goto(url); await p.page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await p.page.evaluate(() => document.fonts.ready); await sleep(400); }
async function load(p, file) {
  await p.page.setInputFiles('#importf', { name: 'fixture.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.page.waitForFunction(n => { const a = __A(); return a.cur() && a.S().length === n && !document.getElementById('play').disabled; }, file.project.sections.length, { timeout: 15000 });
  await sleep(400); await p.page.evaluate(() => document.activeElement && document.activeElement.blur());
}
const shotOf = (page, id) => page.evaluate(id => JSON.parse(JSON.stringify(__A().S().find(s => s.id === id))), id);
const setRatio = async (page, r) => { await page.click('#moreb'); await page.click(`#moremenu [data-ratio="${r}"]`); await sleep(250); };
const toB = async page => { await page.click('.sidetab[data-side="b"]'); await sleep(250); };
const toA = async page => { await page.click('.sidetab[data-side="a"]'); await sleep(250); };
const pickB = async (page, id) => { await page.evaluate(id => document.querySelector(`.bitem[data-id="${id}"]`).click(), id); await sleep(250); };
const pickA = async (page, id) => { await page.click(`.card[data-id="${id}"]`); await sleep(250); };
const dlgOpen = page => page.$eval('#dlgFrame', d => d.open);
const shoot = async (page, name) => { await page.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 3000 }).catch(() => {}); await page.screenshot({ path: `${out}/${name}.png` }); };
const crop = v => (typeof v === 'string' ? v.split(' ') : null);
const cropOk = (v, ratio, iw, ih) => { const c = crop(v); if (!c || c[0] !== ratio) return false; const [x, y, w, h] = c.slice(1).map(Number), [a, b] = ratio.split(':').map(Number);
  return x >= 0 && y >= 0 && x + w <= 1.0002 && y + h <= 1.0002 && Math.abs((w * iw) / (h * ih) / (a / b) - 1) < .01; };
const geo = page => page.evaluate(() => { const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  const box = r('rfBox'), v = r('rfVid');
  return { box, v, covers: v[2] - v[0] > 1 && v[0] <= box[0] + .5 && v[1] <= box[1] + .5 && v[2] >= box[2] - .5 && v[3] >= box[3] - .5, title: document.getElementById('rfTitle').textContent }; });
const drag = async (page, dx, dy) => { const b = await page.$eval('#rfStage', e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(b[0], b[1]); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(b[0] + dx * i / 8, b[1] + dy * i / 8); await page.mouse.up(); await sleep(80); };
/* the colour on screen at a point of an element (fractions of its box), read from a screenshot */
async function pixel(page, sel, fx = .5, fy = .5) {
  const r = await page.$eval(sel, e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
  const png = await page.screenshot({ clip: { x: Math.round(r[0] + r[2] * fx), y: Math.round(r[1] + r[3] * fy), width: 1, height: 1 } });
  return page.evaluate(async b64 => { const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode(); const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); }, png.toString('base64'));
}
const seekTo = async (page, t) => { await page.evaluate(t => __A().seek(t), t); await sleep(500); };
const monitorIs = async (page, col, ms = 5000) => { let last; const ok = await until(async () => near(last = await pixel(page, '#monitor .mframe'), col), ms); return [ok, last]; };
async function render(page) {
  await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(300);
  const dl = page.waitForEvent('download', { timeout: 90000 }); await page.click('#rnGo');
  const buf = readFileSync(await (await dl).path()); await page.waitForSelector('#dlgRender[data-mode="done"]', { timeout: 30000 }); await page.click('#rnCancel'); return buf;
}
async function probe(buf, times) {
  const { ctx, page } = await newPage(); await page.goto(origin + '/blank.html');
  const r = await page.evaluate(async ([b64, times]) => {
    const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(await (await fetch('data:video/mp4;base64,' + b64)).blob());
    if (!await new Promise(r => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 10000); })) return null;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d', { willReadFrequently: true }), o = [];
    for (const t of times) { v.currentTime = t; await new Promise(r => { v.onseeked = r; setTimeout(r, 4000); }); await new Promise(r => setTimeout(r, 80)); g.drawImage(v, 0, 0);
      const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3); o.push({ t, centre: px(c.width >> 1, c.height >> 1), top: px(c.width >> 1, 6) }); }
    return { w: c.width, h: c.height, f: o };
  }, [buf.toString('base64'), times]);
  await ctx.close(); return r;
}
/* side B's boxes: their width over height, and the tallest one against the screen */
const boxes = page => page.evaluate(() => {
  /* the variants' panel is closed until Generate: a probe row of the same classes in the start frame's card */
  const vs = document.createElement('div'); vs.className = 'vars'; vs.dataset.probe = '1'; vs.innerHTML = '<span class="var"></span>';
  document.getElementById('fStart').appendChild(vs); const v = vs.firstChild;
  const m = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { r: b.width / b.height, w: b.width, h: b.height }; };
  const o = { start: m(document.getElementById('fStartImg')), end: m(document.getElementById('fEndImg')), tile: m(document.querySelector('#bTakes .take .tv')), var: m(v), vh: innerHeight, over: document.documentElement.scrollWidth - innerWidth };
  document.querySelectorAll('[data-probe]').forEach(e => e.remove()); return o; });

let server = null;
try {
  const media = await makeMedia();
  check('fixture: the page made the H.264 clips', !!media.square && !!media.portrait && !!media.wide);
  const D = await newPage(), page = D.page;
  await open(D); await load(D, fixture(media));

  /* ======== d · an old project without crops: as before ======== */
  let oldRender = null;
  await section('d old project', async () => {
    await pickA(page, 's1'); await seekTo(page, .5);
    const st = await page.$eval('#mvid', v => v.getAttribute('style') || '');
    check('d · the monitor\'s clip has no crop style, the strip no crop wrapper', !/width/.test(st) && !(await page.$('.vcrop')), st);
    const [g, px] = await monitorIs(page, GREEN);
    check('d · the monitor shows the clip centred (cover): green', g, JSON.stringify(px));
    check('d · side A offers Reframe on a clip', await page.isVisible('#f-imgrf'));
    oldRender = await probe(await render(page), [.5, 1.5]);
    check('d · the render of the old project: the clip centred, green at .5 s and 1.5 s', oldRender && near(oldRender.f[0].centre, GREEN) && near(oldRender.f[1].centre, GREEN), JSON.stringify(oldRender));
  });

  /* ======== a · side B's boxes in the project's ratio ======== */
  const ratioBlock = async (pg, label, tabB) => {
    for (const r of ['16:9', '9:16', '1:1']) {
      if (tabB) { await pg.click('#mTabs [data-side="a"]').catch(() => {}); await sleep(200); }
      await (tabB ? pg.evaluate(r => { const s = document.getElementById('mFrame'); s.value = r; s.dispatchEvent(new Event('change')); }, r) : setRatio(pg, r));
      if (tabB) { await pg.click('#mTabs [data-side="b"]'); await sleep(300); } else await toB(pg);
      await pickB(pg, 's2'); await sleep(300);
      const [a, b] = r.split(':').map(Number), want = a / b, b0 = await boxes(pg), ok = x => x && Math.abs(x.r / want - 1) < .03;
      check(`a · ${label} ${r}: start and end frame boxes, a variant and the take tile measure ${r}`, ok(b0.start) && ok(b0.end) && ok(b0.var) && ok(b0.tile), JSON.stringify(b0));
      const tall = Math.max(b0.start.h, b0.end.h, b0.tile.h);
      check(`a · ${label} ${r}: nothing taller than ${tabB ? '60' : '62'}% of the screen, no sideways scroll`, tall <= b0.vh * (tabB ? .6 : .62) && b0.over <= 0, `${Math.round(tall)} of ${b0.vh}, over ${b0.over}`);
      if (r === '9:16') await shoot(pg, `takes-9x16-${label}`);
      if (!tabB) await toA(pg);
    }
  };
  await section('a desktop', () => ratioBlock(page, 'desktop 1440×900', false));
  await section('a phone', async () => {
    const P = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS });
    await open(P); await load(P, fixture(media, { id: 'p-rfv-phone' }));
    await ratioBlock(P.page, 'phone 390×844', true); await P.ctx.close();
  });
  await setRatio(page, '16:9');

  /* ======== b · reframe a clip on side A ======== */
  let c1 = '';
  await section('b side A', async () => {
    await pickA(page, 's1'); await page.click('#f-imgrf'); await until(() => dlgOpen(page));
    const loaded = await until(async () => (await geo(page)).covers, 6000), g = await geo(page);
    const ui = await page.evaluate(() => ({ img: document.getElementById('rfImg').hidden, vid: !document.getElementById('rfVid').hidden, scrub: !document.getElementById('rfScrub').hidden, max: +document.getElementById('rfTime').max }));
    check('b · Reframe on a clip opens the same dialog with the clip (no image), its first frame, and a scrubber over its length', loaded && ui.img && ui.vid && ui.scrub && Math.abs(ui.max - 2) < .1 && g.title === 'Reframe for 16:9', JSON.stringify([ui, g]));
    await shoot(page, 'dialog-clip-1440x900');
    const at = await page.evaluate(async () => { const v = document.getElementById('rfVid'), r = document.getElementById('rfTime'); r.value = '1.5'; r.dispatchEvent(new Event('input'));
      await new Promise(ok => { v.onseeked = ok; setTimeout(ok, 3000); }); return [v.currentTime, v.paused]; });
    check('b · the scrubber moves through the clip, paused', Math.abs(at[0] - 1.5) < .05 && at[1], JSON.stringify(at));
    await drag(page, 0, 900); const g2 = await geo(page);
    check('b · dragging works on the clip as on an image (stops at the edge)', g2.covers && Math.abs(g2.v[1] - g2.box[1]) < .6, JSON.stringify(g2));
    await page.click('#rfOk'); await until(async () => !(await dlgOpen(page)));
    c1 = (await shotOf(page, 's1')).clipCrop;
    check('b · Use this framing saves one crop for the whole clip, "16:9 x y w h", next to the clip, at the top', cropOk(c1, '16:9', 360, 360) && crop(c1)[2] === '0', c1);
    await seekTo(page, .5); let [ok, px] = await monitorIs(page, RED);
    check('b · the monitor shows the cropped region: red (the top band) at .5 s', ok, JSON.stringify(px));
    await seekTo(page, 1.5); [ok, px] = await monitorIs(page, BLUE);
    check('b · and at 1.5 s the same region of the clip: blue (the crop is fixed over time)', ok, JSON.stringify(px));
    check('b · the strip\'s card wraps the clip in the crop', !!(await page.$('.card[data-id="s1"] .vcrop video')));
    await shoot(page, 'monitor-clip-reframed-1440x900');
    await page.evaluate(() => __A().doUndo('undo')); await sleep(300); const undone = !('clipCrop' in await shotOf(page, 's1'));
    await seekTo(page, .5); const [g3] = await monitorIs(page, GREEN);
    await page.evaluate(() => __A().doUndo('redo')); await sleep(300);
    check('b · Undo takes the framing back (the monitor is centred again), Redo puts it back', undone && g3 && (await shotOf(page, 's1')).clipCrop === c1);
    await page.evaluate(() => __A().flushNow()); await sleep(400);
    await page.reload(); await page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await sleep(800);
    check('b · after a reload the crop is still there', (await shotOf(page, 's1')).clipCrop === c1);
    await pickA(page, 's1'); await seekTo(page, .5); [ok, px] = await monitorIs(page, RED);
    check('b · after a reload the monitor still shows the cropped region', ok, JSON.stringify(px));
  });

  /* ======== b · reframe a take on side B ======== */
  let c2 = '';
  await section('b side B take', async () => {
    await toB(page); await pickB(page, 's2');
    const btn = '#bTakes .take[data-id="t2"] [data-act="rf"]';
    check('b · a finished take has a Reframe button', await page.isVisible(btn));
    await page.click(btn); await until(() => dlgOpen(page)); await until(async () => (await geo(page)).covers, 6000);
    await drag(page, 0, 900); await page.click('#rfOk'); await until(async () => !(await dlgOpen(page)));
    const s = await shotOf(page, 's2'); c2 = s.takes[0].clipCrop;
    check('b · the crop is saved on the take, next to its media', cropOk(c2, '16:9', 360, 360) && crop(c2)[2] === '0' && !('clipCrop' in s), c2);
    const tl = await page.$eval('#bTakes .take[data-id="t2"] .tv', e => { const v = e.querySelector('video'), a = e.getBoundingClientRect(), b = v.getBoundingClientRect(); return { r: b.height / a.height, top: b.top - a.top, controls: v.controls }; });
    check('b · the take tile shows the cropped region (the clip is larger than the tile, its top at the tile\'s top)', Math.abs(tl.r - 1 / .5625) < .02 && Math.abs(tl.top) < 1, JSON.stringify(tl));
    await sleep(500); const tp = await pixel(page, '#bTakes .take[data-id="t2"] .tv', .5, .5);
    check('b · the tile\'s pixels: red in the middle', near(tp, RED), JSON.stringify(tp));
    await shoot(page, 'take-reframed-1440x900');
    await page.click('#bTakes .take[data-id="t2"] [data-act="next"]'); await until(async () => (await shotOf(page, 's3')).key, 8000);
    const n3 = await shotOf(page, 's3');
    check('b · Last frame → next shot: the grabbed frame (the clip\'s size) keeps the take\'s framing as its crop', !!n3.key && n3.keyCrop === c2, JSON.stringify([n3.key, n3.keyCrop]));
    await page.click('#bTakes .take[data-id="t2"] [data-act="use"]'); await sleep(400);
    const u = await shotOf(page, 's2');
    check('b · Use in cut carries the take\'s crop to the shot', u.img === u.takes[0].media && u.kind === 'video' && u.clipCrop === c2, JSON.stringify([u.img, u.clipCrop]));
    await page.evaluate(() => __A().flushNow()); await sleep(400);
    await page.reload(); await page.waitForSelector('.card', { timeout: 15000, state: 'attached' }); await sleep(800);
    const r = await shotOf(page, 's2');
    check('b · after a reload the take and the shot keep the crop', r.takes[0].clipCrop === c2 && r.clipCrop === c2);
    await toA(page); await seekTo(page, 2.5); const [ok, px] = await monitorIs(page, RED);
    check('b · the monitor plays the take cropped', ok, JSON.stringify(px));
    await toB(page); await pickB(page, 's2'); await page.click('#bTakes .take[data-id="t2"] [data-act="rf"]'); await until(() => dlgOpen(page)); await until(async () => (await geo(page)).covers, 6000);
    await drag(page, 0, -900); await page.click('#rfOk'); await sleep(400);
    const b2 = await shotOf(page, 's2');
    check('b · reframing the take that is in the cut moves the cut\'s crop too (same clip)', b2.takes[0].clipCrop === b2.clipCrop && b2.clipCrop !== c2 && cropOk(b2.clipCrop, '16:9', 360, 360), JSON.stringify([b2.takes[0].clipCrop, b2.clipCrop]));
    await page.evaluate(() => __A().doUndo('undo')); await sleep(300); const b3 = await shotOf(page, 's2');
    check('b · one Undo puts both back', b3.takes[0].clipCrop === c2 && b3.clipCrop === c2, JSON.stringify([b3.takes[0].clipCrop, b3.clipCrop]));
    await toA(page);
  });

  /* ======== c · the render draws the crop ======== */
  await section('c render', async () => {
    const v = await probe(await render(page), [.5, 1.5, 2.5]);
    check('c · the reframed clip renders cropped: red in the middle at .5 s, blue at 1.5 s (old: green)', v && v.w === 1280 && near(v.f[0].centre, RED) && near(v.f[0].top, RED) && near(v.f[1].centre, BLUE), JSON.stringify(v));
    check('c · the reframed take in the cut renders cropped too: red at 2.5 s', v && near(v.f[2].centre, RED), JSON.stringify(v && v.f[2]));
    check('c · and differs from the old project\'s render where expected', oldRender && v && !near(oldRender.f[0].centre, v.f[0].centre, 60));
  });

  /* ======== e · hostile cases ======== */
  await section('e crop for another ratio', async () => {
    await setRatio(page, '9:16'); await pickA(page, 's1'); await seekTo(page, .5);
    const st = await page.$eval('#mvid', v => v.getAttribute('style') || ''), s = await shotOf(page, 's1');
    const [g, px] = await monitorIs(page, GREEN);
    check('e · 9:16: the 16:9 crop is kept but unused: the monitor shows the clip centred', s.clipCrop === c1 && !/width/.test(st) && g, JSON.stringify([st, px]));
    await page.click('#f-imgrf'); await until(() => dlgOpen(page)); await until(async () => (await geo(page)).covers, 6000);
    check('e · Reframe opens for 9:16', (await geo(page)).title === 'Reframe for 9:16');
    await page.keyboard.press('Escape'); await sleep(200);
    await setRatio(page, '16:9'); await seekTo(page, .5); const [r2] = await monitorIs(page, RED);
    check('e · back to 16:9 the kept crop applies again', r2);
  });
  await section('e still loading', async () => {
    await pickA(page, 's1');
    const r = await page.evaluate(() => { document.getElementById('f-imgrf').click(); document.getElementById('rfOk').click(); return [document.getElementById('dlgFrame').open, JSON.stringify(__A().S()[0].clipCrop)]; });
    await sleep(300);
    check('e · Use this framing before the clip has loaded saves nothing and keeps the dialog open', r[0] && r[1] === JSON.stringify(c1), JSON.stringify(r));
    await until(async () => (await geo(page)).covers, 6000); await page.keyboard.press('Escape'); await sleep(200);
  });
  await section('e collaborator changes the clip', async () => {
    await pickA(page, 's1'); await page.click('#f-imgrf'); await until(() => dlgOpen(page)); await until(async () => (await geo(page)).covers, 6000);
    await drag(page, 0, -900);
    const was = await page.evaluate(() => { const s = __A().S()[0], o = s.img; s.img = __A().S()[1].takes[0].media; return o; });
    await page.click('#rfOk'); await sleep(300);
    const s = await shotOf(page, 's1');
    check('e · the clip changed while the dialog was open: the crop meant for the old clip is not saved on the new one', s.clipCrop === c1 && !(await dlgOpen(page)), s.clipCrop);
    await page.evaluate(o => { __A().S()[0].img = o; __A().renderAll(); }, was);
    await toB(page); await pickB(page, 's2'); await page.click('#bTakes .take[data-id="t2"] [data-act="rf"]'); await until(() => dlgOpen(page)); await until(async () => (await geo(page)).covers, 6000);
    const gone = await page.evaluate(() => { const s = __A().S()[1], t = s.takes.splice(0, 1)[0]; return t; });
    await page.click('#rfOk'); await sleep(300);
    check('e · the take was deleted while the dialog was open: Use this framing closes it, nothing saved, no error', !(await dlgOpen(page)) && (await shotOf(page, 's2')).takes.length === 0);
    await page.evaluate(t => { __A().S()[1].takes.unshift(t); __A().renderAll(); }, gone); await toA(page);
  });
  await section('e portrait clip, short clip, upload offer', async () => {
    await pickA(page, 's3');
    await page.setInputFiles('#f-img', { name: 'wide.mp4', mimeType: 'video/mp4', buffer: Buffer.from(media.wide.split(',')[1], 'base64') });
    await until(async () => (await shotOf(page, 's3')).kind === 'video', 8000); await sleep(1200);
    check('e · a 16:9 clip uploaded in a 16:9 project: no dialog', !(await dlgOpen(page)));
    await page.setInputFiles('#f-img', { name: 'portrait.mp4', mimeType: 'video/mp4', buffer: Buffer.from(media.portrait.split(',')[1], 'base64') });
    check('e · a portrait clip uploaded in a 16:9 project: the Reframe dialog opens', !!(await until(() => dlgOpen(page), 8000)));
    const ok = await until(async () => (await geo(page)).covers, 6000), mx = await page.$eval('#rfTime', e => +e.max);
    check('e · a 3-frame clip loads, the scrubber spans it', !!ok && mx > 0 && mx < .2, String(mx));
    await page.evaluate(async () => { const r = document.getElementById('rfTime'); r.value = r.max; r.dispatchEvent(new Event('input')); await new Promise(ok => setTimeout(ok, 300)); });
    await drag(page, 0, 900); await page.click('#rfOk'); await sleep(400);
    const s = await shotOf(page, 's3');
    check('e · the portrait clip\'s crop: full width, 16:9 of its pixels, at the top', cropOk(s.clipCrop, '16:9', 180, 320) && crop(s.clipCrop)[3] === '1' && crop(s.clipCrop)[2] === '0', s.clipCrop);
    await page.setInputFiles('#f-img', { name: 'wide.mp4', mimeType: 'video/mp4', buffer: Buffer.from(media.wide.split(',')[1], 'base64') });
    await until(async () => !(await shotOf(page, 's3')).clipCrop, 8000);
    check('e · replacing the clip drops its crop', !('clipCrop' in await shotOf(page, 's3')));
  });

  /* ======== f · sync between two browsers ======== */
  await section('f sync', async () => {
    const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', LOG_LEVEL: 'warn', APP_URL: app + '?sync=1' };
    const r = spawnSync(process.execPath, [join(root, 'packages/sync-server/bin/create-project.mjs'), 'Reframe video check'], { env, encoding: 'utf8' });
    const link = /app: +(\S+)/.exec(r.stdout)?.[1];
    if (!link) throw new Error('create-project printed no link: ' + r.stdout + r.stderr);
    server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
    for (let i = 0; i < 50 && !/listening/.test(log); i++) await sleep(100);
    const off = () => { window.__CUE_MEDIA_TEST = { off: true }; };
    const A = await newPage({}, off), B = await newPage({}, off);
    const chip = p => p.evaluate(() => (document.getElementById('mstatw').hidden ? '' : document.getElementById('mhead').textContent));
    await open(A, app + '?sync=1'); await load(A, fixture(media, { id: 'p-rfv-sync' }));
    await A.page.goto(link); await A.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 9000 }); await A.page.fill('#jName', 'Ana'); await A.page.click('#jGo');
    await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 9000 }); await A.page.click('#jShare');
    await until(async () => (await chip(A.page)) === 'Synced', 9000);
    await B.page.goto(link); await B.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 9000 }); await B.page.fill('#jName', 'Ben'); await B.page.click('#jGo');
    await B.page.waitForFunction(() => document.querySelectorAll('.card').length === 3, null, { timeout: 9000 }); await until(async () => (await chip(B.page)) === 'Synced', 9000);
    await toB(A.page); await pickB(A.page, 's2'); await A.page.click('#bTakes .take[data-id="t2"] [data-act="rf"]'); await until(() => dlgOpen(A.page)); await until(async () => (await geo(A.page)).covers, 6000);
    await drag(A.page, 0, 900); await A.page.click('#rfOk');
    const want = await until(async () => (await shotOf(A.page, 's2')).takes[0].clipCrop);
    const got = await until(async () => { const t = (await shotOf(B.page, 's2')).takes[0]; return t && t.clipCrop === want && t.clipCrop; }, 8000);
    check('f · A reframes a take; B gets the same crop on the same take', !!want && got === want, JSON.stringify([want, got]));
    await A.ctx.close(); await B.ctx.close();
  });

  check('no page errors', !errs.length, errs.slice(0, 5).join(' | '));
} finally {
  if (server) server.kill();
  await browser.close(); srv.close(); rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
