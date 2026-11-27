// Clip speed, Shift-drag, held region, framing move, end frame on side A, slip (docs/specs/speed-slip-framing.md).
// One block per acceptance criterion, then the hostile cases. The judge is the rendered MP4 read back with ffmpeg: the
// shot clips are made here with ffmpeg and carry their own frame number as an 8-bit barcode in their top band.
//   node design/speed-check.mjs <repo-root> <out-dir>
// Desktop Chromium, every request outside the local server aborted. Screenshots: <out-dir>/speed-*.png
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.CUE_TESTKIT || process.env.TESTKIT || '/home/talos/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const FF = '/usr/bin/ffmpeg';
const ff = args => { const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 }); if (r.status) throw new Error('ffmpeg: ' + String(r.stderr)); return r.stdout; };

/* ---------- the rawest material: clips that show their own frame number ---------- */
// 320x180, 24 fps: top 60 px = 8 bars of 40 px, bar k white when bit k of the frame index is set; testsrc2 below
function clip(sec) {
  const f = join(out, `speed-clip-${sec}s.mp4`);
  ff(['-f', 'lavfi', '-i', `color=black:s=320x60:r=24:d=${sec},format=gray,geq=lum='255*mod(floor(N/pow(2\\,floor(X/40)))\\,2)'`,
    '-f', 'lavfi', '-i', `testsrc2=s=320x120:r=24:d=${sec}`,
    '-filter_complex', '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]vstack', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', f]);
  return readFileSync(f);
}
const still = (name, src) => { const f = join(out, `speed-${name}.png`); ff(['-f', 'lavfi', '-i', src, '-frames:v', '1', f]); return readFileSync(f); };
// a gradient: red = x, green = y (0..255 across the image), so a pixel tells where in the image it came from
const grad = still('grad', "color=black:s=1280x720,format=rgb24,geq=r='X/W*255':g='Y/H*255':b=0");
const red = still('red', 'color=0xd02020:s=320x180'), blue = still('blue', 'color=0x2030d0:s=320x180');
const C = { 6: clip(6), 5: clip(5), 4: clip(4), 3: clip(3) };
/* which source frame a gray frame shows: bit k from the bar k's middle, in the band's middle row */
function frameNo(gray, w, h) { const y = Math.round(h * 30 / 180), bw = w / 8; let n = 0;
  for (let k = 0; k < 8; k++) { const x = Math.round(bw * k + bw / 2); if (gray[y * w + x] > 128) n |= 1 << k; } return n; }
/* the rendered file, frame n: gray (for the barcode) and rgb (for the gradient) */
const outFrame = (file, n, fmt) => ff(['-i', file, '-vf', `select=eq(n\\,${n})`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', fmt, '-']);

/* ---------- the local server, with the test-only hook ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    let body = readFileSync(p);
    // test-only hook: the app's functions live in its script scope, so the served copy exposes a few of them
    if (p.endsWith('index.html')) body = String(body).replace('window.cueEDL=', 'window.__t={get S(){return S},get setSide(){return setSide},get select(){return select},get seek(){return seek},get srcTime(){return srcTime},get heldAt(){return heldAt},get cropAt(){return cropAt},get cropOf(){return cropOf},get openReframe(){return openReframe},get P(){return P},get cur(){return cur}};window.cueEDL=');
    r.end(body); }
  catch { r.writeHead(404); r.end(); }
});
let port = 3420;
for (;; port++) {
  if (port > 3439) throw new Error('no free port');
  const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });
  if (ok) break;
}
const origin = `http://127.0.0.1:${port}`;
// CUE_CHROMIUM overrides (design/run-local.mjs sets it to Playwright's headless shell, which plays and encodes H.264)
const browser = await chromium.launch({ executablePath: process.env.CUE_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
let fails = 0;
// the clip/end-frame fields live in the shot settings popover: open it for the selected shot (idempotent)
const pop = async () => { await page.evaluate(() => { const p = document.getElementById('shotPop'); if (p && !p.hidden) return; const g = document.querySelector('#strip .card.sel [data-set]'); if (g) g.click(); }); await new Promise(r => setTimeout(r, 150)); };
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());   // a focused field keeps Ctrl+Z for itself

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
await ctx.route('**/*', r => (/^(data|blob):/.test(r.request().url()) || r.request().url().startsWith(origin) ? r.continue() : r.abort()));
const page = await ctx.newPage(), errs = [];
page.on('pageerror', e => { errs.push(String(e)); console.log('PAGEERR', String(e)); });
await page.goto(origin + '/index.html');
await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });

const b64 = (buf, type) => ({ type, data: `data:${type};base64,` + buf.toString('base64') });
const sec = (id, start, o = {}) => ({ id, start, title: id, shot: '', notes: '', img: '', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: '', clipDur: 0, takes: [], ...o });
async function importProject(title, sections, media) {
  const data = { format: 'cueboard', version: 1, project: { id: 'p-' + title.replace(/\W/g, ''), title, created: 1, updated: 1, song: null, refs: [], sections }, media };
  await page.setInputFiles('#importf', { name: 'x.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForFunction(t => document.getElementById('projname').textContent.includes(t), title, { timeout: 15000 });
  await sleep(400);
}
const shotI = id => page.evaluate(id => __t.S().findIndex(s => s.id === id), id);
const field = (id, f) => page.evaluate(([id, f]) => { const s = __t.S().find(x => x.id === id); return s ? s[f] : 'NO SHOT'; }, [id, f]);
async function selectShot(id) { await page.evaluate(id => { __t.setSide('a'); __t.select(id, true); }, id); await sleep(300); }
async function seekTo(t) { await page.evaluate(t => __t.seek(t), t); await page.waitForFunction(() => { const v = document.getElementById('mvid'); return v.hidden || (!v.seeking && v.readyState >= 2); }, null, { timeout: 8000 }); await sleep(250); }
/* the monitor's clip, frame number read from the pixels the browser decoded */
const monitorFrame = () => page.evaluate(() => { const v = document.getElementById('mvid'); if (v.hidden || !v.videoWidth) return { n: -1 };
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, y = Math.round(c.height * 30 / 180), bw = c.width / 8; let n = 0;
  for (let k = 0; k < 8; k++) { const x = Math.round(bw * k + bw / 2); if (d[(y * c.width + x) * 4] > 128) n |= 1 << k; }
  return { n, t: v.currentTime, rate: v.playbackRate }; });

/* ================= unit: the one time map and the one crop function ================= */
const unit = await page.evaluate(() => {
  const bad = [];
  for (const fps of [24, 25, 30]) for (const speed of [0.5, 1, 2.37]) for (const off of [0, 1.2]) {
    const s = { speed, clipOff: off, clipDur: 100 };
    for (let k = Math.ceil(off * fps); k < Math.ceil(off * fps) + 200; k++) {
      const atB = __t.srcTime(s, (k / fps - off) / speed), mid = __t.srcTime(s, ((k + .5) / fps - off) / speed);
      if (Math.floor(atB.t * fps) !== k || Math.floor(mid.t * fps) !== k) { bad.push({ fps, speed, off, k, b: atB.t * fps, m: mid.t * fps }); break; }
    }
  }
  const s = { speed: 0.5, clipDur: 6 }, o = { speed: 1, clipOff: 2, clipDur: 5 };
  const r = {
    bad: bad.slice(0, 3),
    half10: __t.srcTime(s, 10), endJustBefore: __t.srcTime(s, 11.99), endAfter: __t.srcTime(s, 12.5),
    off0: __t.srcTime(o, 0), off25: __t.srcTime(o, 2.5), offEnd: __t.srcTime(o, 3.1),
    old: __t.srcTime({ clipDur: 6 }, 2), junk: [__t.srcTime({ speed: 'x', clipDur: 6 }, 2).t, __t.srcTime({ speed: 0, clipDur: 6 }, 2).t, __t.srcTime({ speed: -2, clipOff: -1, clipDur: 6 }, 2).t, __t.srcTime({ speed: 50, clipDur: 60 }, 2).t],
    held3: __t.heldAt({ clipDur: 3 }), held15: __t.heldAt({ clipDur: 3, speed: 1.5 }), heldOff: __t.heldAt({ clipDur: 5, clipOff: 2 }), heldNone: __t.heldAt({ clipDur: 0 }),
  };
  return r;
});
check('unit · srcTime: every frame boundary and mid-frame lands on its frame (24/25/30 fps × 0.5/1/2.37 × offset 0/1.2)', unit.bad.length === 0, JSON.stringify(unit.bad));
check('unit · srcTime: 0.5x at 10 s = 5 s, not held', near(unit.half10.t, 5, 1e-3) && !unit.half10.held, JSON.stringify(unit.half10));
check('unit · srcTime: end clamp (held once the clip ran out, not before)', !unit.endJustBefore.held && unit.endAfter.held && unit.endAfter.t === 6, JSON.stringify([unit.endJustBefore, unit.endAfter]));
check('unit · srcTime: offset 2 s: 2 s at shot start, 4.5 s at 2.5 s, held past 3 s', near(unit.off0.t, 2, 1e-3) && near(unit.off25.t, 4.5, 1e-3) && unit.offEnd.held, JSON.stringify([unit.off0, unit.off25, unit.offEnd]));
check('unit · srcTime: no speed field = 1x; junk speed = 1x; out-of-range clamped to 10x; negative offset = 0', near(unit.old.t, 2, 1e-3) && near(unit.junk[0], 2, 1e-3) && near(unit.junk[1], 2, 1e-3) && near(unit.junk[2], 2, 1e-3) && near(unit.junk[3], 20, 1e-3), JSON.stringify([unit.old, unit.junk]));
check('unit · heldAt: 3 s clip → 3 s; at 1.5x → 2 s; 5 s clip offset 2 → 3 s; unknown length → never', near(unit.held3, 3, 1e-6) && near(unit.held15, 2, 1e-6) && near(unit.heldOff, 3, 1e-6) && unit.heldNone === null, JSON.stringify(unit));

/* ================= the render project ================= */
// A 0-12: 6 s clip at 0.5x · B 12-15: 5 s clip, offset 2 · F 15-19: still with a framing move · E 19-23: still with an end frame from 1 s · Z 23-
const R = { A: 'sa', B: 'sb', F: 'sf', E: 'se', Z: 'sz' };
await importProject('Speed render', [
  sec(R.A, 0, { img: 'c6', kind: 'video', clipDur: 6, speed: 0.5 }),
  sec(R.B, 12, { img: 'c5', kind: 'video', clipDur: 5, clipOff: 2 }),
  sec(R.F, 15, { img: 'g', kind: '', imgCrop: '16:9 0 0 0.5 0.5', imgCrop2: '16:9 0.5 0.5 0.5 0.5' }),
  sec(R.E, 19, { img: 'r', kind: '', endKey: 'b', endAt: 1 }),
  sec(R.Z, 23),
], { c6: b64(C[6], 'video/mp4'), c5: b64(C[5], 'video/mp4'), g: b64(grad, 'image/png'), r: b64(red, 'image/png'), b: b64(blue, 'image/png') });

/* --- Speed: the monitor --- */
await selectShot(R.A); await seekTo(10);
const mA = await monitorFrame();
check('Speed · monitor at 10 s (0.5x): clip time 5 s, source frame 120 ±1', near(mA.t, 5, .05) && near(mA.n, 120, 1), JSON.stringify(mA));
check('Speed · monitor plays the clip at 0.5x the song', near(mA.rate, .5, 1e-6), String(mA.rate));
await seekTo(11.9); const mA2 = await monitorFrame();
check('Speed · at 11.9 s (5.95 s into a 6 s clip) still moving, frame 142-143', mA2.n >= 141 && mA2.n <= 143, JSON.stringify(mA2));
await pop();
const edSpeed = await page.evaluate(() => ({ v: document.getElementById('f-speed').value, vis: !!document.getElementById('f-speed').getClientRects().length }));
check('Speed · side A editor shows the speed next to the clip', edSpeed.vis && Math.abs(+edSpeed.v - .5) < 1e-6, JSON.stringify(edSpeed));

/* --- Slip: the monitor --- */
await selectShot(R.B); await seekTo(12);
const mB0 = await monitorFrame(); await seekTo(14.5); const mB1 = await monitorFrame();
check('Slip · monitor at shot start shows the clip at 2 s (frame 48 ±1)', near(mB0.n, 48, 1), JSON.stringify(mB0));
check('Slip · monitor 2.5 s into the shot shows the clip at 4.5 s (frame 108 ±1)', near(mB1.n, 108, 1), JSON.stringify(mB1));
await pop();
const offUI = await page.evaluate(() => document.getElementById('f-off').value);
check('Slip · editor field "Clip starts at" shows 2', Math.abs(+offUI - 2) < 1e-6, offUI);

/* --- Framing: the monitor --- */
const cssCrop = () => page.evaluate(() => { const im = document.getElementById('mimg'); if (im.hidden) return null; const st = im.style; if (!st.width) return 'static';
  const w = parseFloat(st.width) / 100, h = parseFloat(st.height) / 100; return [-parseFloat(st.left) / 100 / w, -parseFloat(st.top) / 100 / h, 1 / w, 1 / h]; });
await selectShot(R.F);
const fr = {};
for (const [k, t] of [['s', 15], ['m', 17], ['e', 18.999]]) { await seekTo(t); fr[k] = await cssCrop(); }
const cl = (a, b) => Array.isArray(a) && a.every((v, i) => near(v, b[i], .01));
check('Framing · monitor at shot start = start framing', cl(fr.s, [0, 0, .5, .5]), JSON.stringify(fr.s));
check('Framing · monitor halfway = midpoint', cl(fr.m, [.25, .25, .5, .5]), JSON.stringify(fr.m));
check('Framing · monitor at shot end = end framing', cl(fr.e, [.5, .5, .5, .5]), JSON.stringify(fr.e));
const fu = await page.evaluate(() => { const s = __t.S().find(x => x.id === 'sf'); return [__t.cropAt(s, 'img', 0), __t.cropAt(s, 'img', 2), __t.cropAt(s, 'img', 4)]; });
check('Framing · cropAt: start, midpoint, end', cl(fu[0], [0, 0, .5, .5]) && cl(fu[1], [.25, .25, .5, .5]) && cl(fu[2], [.5, .5, .5, .5]), JSON.stringify(fu));

/* --- End frame: the monitor --- */
await selectShot(R.E);
const endShows = () => page.evaluate(() => { const a = document.getElementById('mimg'), b = document.getElementById('mimg2');
  return { a: !a.hidden, b: !!b && !b.hidden && +getComputedStyle(b).opacity, bsrc: b ? b.getAttribute('src') : '' }; });
await seekTo(19.5); const e1 = await endShows(); await seekTo(20.5); const e2 = await endShows();
check('End frame · monitor before the switch point: start image only', e1.a && !e1.b, JSON.stringify(e1));
check('End frame · monitor after the switch point: end image on top', e2.b === 1, JSON.stringify(e2));
await seekTo(20); const e3 = await endShows();
check('End frame · at the switch point: mid-dissolve', e3.b > .2 && e3.b < .8, JSON.stringify(e3));
await page.screenshot({ path: join(out, 'speed-monitor-end.png') });

/* --- the render, read back with ffmpeg --- */
await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(400);
await page.evaluate(() => { const F = document.getElementById('rnForm').elements; F.rnRange.value = 'custom'; document.getElementById('rnStart').value = '0'; document.getElementById('rnEnd').value = '23';
  document.getElementById('rnForm').dispatchEvent(new Event('change')); });
await sleep(800);
const dl = page.waitForEvent('download', { timeout: 300000 });
await page.click('#rnGo');
const file = join(out, 'speed-render.mp4');
await (await dl).saveAs(file);
const probe = JSON.parse(String(spawnSync('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames', '-of', 'json', file]).stdout)).streams[0];
check('render · an MP4 at 30 fps came out', probe && probe.r_frame_rate === '30/1', JSON.stringify(probe));
const W = probe.width, Hh = probe.height, rf = n => frameNo(outFrame(file, n, 'gray'), W, Hh);
const r300 = rf(300);
check('Speed · RENDER at 10 s shows source frame 120 ±1 (5 s × 24 fps)', near(r300, 120, 1), `frame ${r300}`);
check('Speed · RENDER at 6 s shows source frame 72 ±1', near(rf(180), 72, 1), `frame ${rf(180)}`);
const r360 = rf(360), r435 = rf(435);
check('Slip · RENDER at shot start shows the clip at 2 s (frame 48 ±1)', near(r360, 48, 1), `frame ${r360}`);
check('Slip · RENDER 2.5 s into the shot shows the clip at 4.5 s (frame 108 ±1)', near(r435, 108, 1), `frame ${r435}`);
/* the gradient's centre pixel: red = x of the crop's centre, green = y */
const centre = n => { const b = outFrame(file, n, 'rgb24'), i = (Math.round(Hh / 2) * W + Math.round(W / 2)) * 3; return [b[i] / 255, b[i + 1] / 255]; };
const g0 = centre(450), g1 = centre(510), g2 = centre(569);
check('Framing · RENDER at shot start: crop centred at (.25,.25) like the monitor', near(g0[0], .25, .03) && near(g0[1], .25, .03), JSON.stringify(g0));
check('Framing · RENDER halfway: crop centred at (.5,.5) like the monitor', near(g1[0], .5, .03) && near(g1[1], .5, .03), JSON.stringify(g1));
check('Framing · RENDER at shot end: crop centred at (.75,.75) like the monitor', near(g2[0], .75, .03) && near(g2[1], .75, .03), JSON.stringify(g2));
const px = n => { const b = outFrame(file, n, 'rgb24'), i = (Math.round(Hh / 3) * W + Math.round(W / 3)) * 3; return [b[i], b[i + 1], b[i + 2]]; };
const pe1 = px(585), pe2 = px(615);
check('End frame · RENDER before the switch point: the start image (red)', pe1[0] > 150 && pe1[2] < 90, JSON.stringify(pe1));
check('End frame · RENDER after the switch point: the end image (blue)', pe2[2] > 150 && pe2[0] < 90, JSON.stringify(pe2));
await page.click('#rnCancel').catch(() => {}); await sleep(300);

/* ================= the edit project: drags, held regions, fields, undo ================= */
const take = (id, media, dur) => ({ id, jobId: 'j' + id, model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur, audio: false, seed: '', prompt: 'p', start: true, end: false, est: 0, cost: 0, status: 'completed', created: 1, media, clipDur: dur, error: '', note: '' });
const E = { D: 'ed', N: 'en', H: 'eh', L: 'el', K: 'ek', O: 'eo', Z: 'ez' };
await importProject('Speed edit', [
  sec(E.D, 0, { img: 'c4', kind: 'video', clipDur: 4, takes: [take('td', 'c4', 4)] }),   // 0-4: shift-drag its end to 8
  sec('f1', 4),
  sec(E.N, 9, { img: 'c4b', kind: 'video', clipDur: 4 }),   // 9-13: plain drag
  sec('f2', 13),
  sec(E.H, 14, { img: 'c3', kind: 'video', clipDur: 3, takes: [take('th', 'c3', 3)] }),   // 14-19: 3 s clip in a 5 s shot
  sec(E.L, 19, { img: 'c5', kind: 'video', clipDur: 5 }),   // 19-22: slip
  sec(E.K, 22, { img: 'r', kind: '' }),   // 22-26: end frame on side A
  sec(E.O, 26, { img: 'r2', kind: '' }),   // 26-30: end frame set on side B
  sec(E.Z, 30),
], { c4: b64(C[4], 'video/mp4'), c4b: b64(C[4], 'video/mp4'), c3: b64(C[3], 'video/mp4'), c5: b64(C[5], 'video/mp4'), r: b64(red, 'image/png'), r2: b64(red, 'image/png') });
const tl = async () => { const b = await page.locator('#tl').boundingBox(); const P = await page.evaluate(() => __t.P); const sl = await page.evaluate(() => document.getElementById('tl-scroll').scrollLeft); return { x: t => b.x + t * P - sl, y: b.y, h: b.height, P }; };
await selectShot(E.D); await page.evaluate(() => { document.getElementById('tl-scroll').scrollLeft = 0; });
let T = await tl();
const startOf = id => page.evaluate(id => __t.S().find(s => s.id === id).start, id);
const ids = await page.evaluate(() => __t.S().map(s => s.id));
const nAfter = ids[ids.indexOf(E.D) + 1];

/* --- Shift-drag --- */
const y = T.y + 80;
await page.mouse.move(T.x(4), y); await page.keyboard.down('Shift'); await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(T.x(4 + i * .5), y); await sleep(20); }
const readout = await page.evaluate(() => { const r = document.getElementById('tlRead'); return r && !r.hidden ? r.textContent : ''; });
await page.screenshot({ path: join(out, 'speed-shiftdrag.png'), clip: { x: 0, y: T.y - 30, width: 900, height: T.h + 40 } });
await page.mouse.up(); await page.keyboard.up('Shift'); await sleep(300);
const sd = { start: await startOf(nAfter), speed: await field(E.D, 'speed'), tSpeed: await page.evaluate(() => __t.S().find(s => s.id === 'ed').takes[0].speed) };
check('Shift-drag · 4 s clip dragged to 8 s with Shift: speed 0.5x', near(sd.start, 8, .03) && near(+sd.speed, .5, .01), JSON.stringify(sd));
check('Shift-drag · the take in the cut gets the same speed', near(+sd.tSpeed, .5, .01), JSON.stringify(sd));
check('Shift-drag · a readout shows the speed while dragging', /0\.5\d?x/.test(readout), readout);
check('Shift-drag · the readout is gone after the drag', await page.evaluate(() => document.getElementById('tlRead').hidden));
await page.keyboard.press('Control+z'); await sleep(300);
const un = { start: await startOf(nAfter), speed: await field(E.D, 'speed'), tSpeed: await page.evaluate(() => __t.S().find(s => s.id === 'ed').takes[0].speed) };
check('Shift-drag · one undo restores both the cut and the speed (shot and take)', near(un.start, 4, .001) && un.speed === undefined && un.tSpeed === undefined, JSON.stringify(un));
await page.keyboard.press('Control+Shift+z'); await sleep(300);
const re = { start: await startOf(nAfter), speed: await field(E.D, 'speed') };
check('Shift-drag · redo brings both back', near(re.start, 8, .03) && near(+re.speed, .5, .01), JSON.stringify(re));
await page.keyboard.press('Control+z'); await sleep(300);

/* --- plain drag: speed unchanged; Shift let go mid-drag: back to the speed it had --- */
const nAfterN = ids[ids.indexOf(E.N) + 1];
T = await tl();
await page.mouse.move(T.x(13), y); await page.mouse.down();
for (let i = 1; i <= 4; i++) { await page.mouse.move(T.x(13 - i * .25), y); await sleep(20); }
await page.mouse.up(); await sleep(300);
const pd = { start: await startOf(nAfterN), speed: await field(E.N, 'speed') };
check('Shift-drag · without Shift the cut moves and the speed stays 1x', near(pd.start, 12, .03) && pd.speed === undefined, JSON.stringify(pd));
T = await tl();
await page.mouse.move(T.x(12), y); await page.keyboard.down('Shift'); await page.mouse.down();
for (let i = 1; i <= 4; i++) { await page.mouse.move(T.x(12 - i * .25), y); await sleep(20); }
await page.keyboard.up('Shift'); await page.mouse.move(T.x(10.9), y); await sleep(20); await page.mouse.move(T.x(10.8), y); await page.mouse.up(); await sleep(300);
const pd2 = { start: await startOf(nAfterN), speed: await field(E.N, 'speed') };
check('Shift-drag · Shift let go before the drop: speed back to 1x, the cut still moves', near(pd2.start, 10.8, .03) && pd2.speed === undefined, JSON.stringify(pd2));
await page.keyboard.press('Control+z'); await sleep(200); await page.keyboard.press('Control+z'); await sleep(200);
// hostile: Shift-drag a cut after a still (no clip): the cut moves, nothing gets a speed
T = await tl();
await page.mouse.move(T.x(26), y); await page.keyboard.down('Shift'); await page.mouse.down();
for (let i = 1; i <= 4; i++) { await page.mouse.move(T.x(26 - i * .25), y); await sleep(20); }
const stillRead = await page.evaluate(() => document.getElementById('tlRead').hidden);
await page.mouse.up(); await page.keyboard.up('Shift'); await sleep(300);
check('Shift-drag · after a still: the cut moves, no speed written, no readout', near(await startOf(E.O), 25, .03) && (await field(E.K, 'speed')) === undefined && stillRead);
await page.keyboard.press('Control+z'); await sleep(200);
check('Shift-drag · undo after a still: the cut is back', (await startOf(E.O)) === 26);

/* --- Short clip: the held region --- */
await selectShot(E.H); T = await tl();
const tip = async t => { await page.mouse.move(T.x(t), T.y + T.h - 4); await sleep(60); return page.evaluate(() => document.getElementById('tl').title); };
const tips = [await tip(16.8), await tip(17.2), await tip(18.8)];
check('Short clip · timeline tooltip only past 3 s: "Clip ends at 3.0 s: holds the last frame"', !/Clip ends/.test(tips[0]) && tips[1] === 'Clip ends at 3.0 s: holds the last frame' && tips[2] === tips[1], JSON.stringify(tips));
/* the hatch, in the timeline's bottom rows (under the waveform): pixels in 3-5 s differ from the shot's plain fill, none in 0-3 s */
const hatch = async (a, b, c) => page.evaluate(([a, b, c]) => { const cv = document.getElementById('tl'), g = cv.getContext('2d'), d = devicePixelRatio, P = __t.P, H = cv.height;
  const row = (t0, t1) => { const x0 = Math.ceil(t0 * P * d) + 3, x1 = Math.floor(t1 * P * d) - 3; const px = g.getImageData(x0, H - 3 * d, x1 - x0, 1).data, v = new Set(); for (let i = 0; i < px.length; i += 4) v.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2]); return v.size; };
  return { plain: row(a, b), held: row(b, c) }; }, [a, b, c]);
const h1 = await hatch(14, 17, 19);
check('Short clip · timeline: hatched from 3 s to 5 s, plain before', h1.plain === 1 && h1.held > 1, JSON.stringify(h1));
const heldBox = async (sel) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const h = el.querySelector('.held'); if (!h) return { none: true };
  const tb = h.parentElement.getBoundingClientRect(), r = h.getBoundingClientRect(); return { l: (r.left - tb.left) / tb.width, r: (r.right - tb.left) / tb.width, title: h.title }; }, sel);
const cardSel = `#strip .card[data-id="${E.H}"]`;
const c1 = await heldBox(cardSel);
check('Short clip · strip card: hatched region from 3/5 to the end, with the tooltip', c1 && near(c1.l, .6, .02) && near(c1.r, 1, .01) && c1.title === 'Clip ends at 3.0 s: holds the last frame', JSON.stringify(c1));
await page.screenshot({ path: join(out, 'speed-card-held.png'), clip: await page.locator(cardSel).boundingBox() });
// 1.5x from the editor's field
await pop();
await page.fill('#f-speed', '1.5'); await page.press('#f-speed', 'Enter'); await sleep(300);
check('Speed · after Enter the field keeps focus; Tab goes on to "Clip starts at"', await page.evaluate(() => document.activeElement.id) === 'f-speed' && (await page.keyboard.press('Tab'), await page.evaluate(() => document.activeElement.id)) === 'f-off');
await blur();
const c2 = await heldBox(cardSel), h2 = await hatch(14, 16, 19);
check('Short clip · at 1.5x the card region starts at 2 s (2/5)', c2 && near(c2.l, .4, .02) && /Clip ends at 2\.0 s/.test(c2.title), JSON.stringify(c2));
check('Short clip · at 1.5x the timeline hatch starts at 2 s', h2.plain === 1 && h2.held > 1, JSON.stringify(h2));
check('Speed · the editor field sets the shot and the take in the cut', near(+(await field(E.H, 'speed')), 1.5, 1e-6) && near(+(await page.evaluate(() => __t.S().find(s => s.id === 'eh').takes[0].speed)), 1.5, 1e-6));
await page.keyboard.press('Control+z'); await sleep(300);
check('Speed · undo of the field: back to 1x on shot and take', (await field(E.H, 'speed')) === undefined && (await page.evaluate(() => __t.S().find(s => s.id === 'eh').takes[0].speed)) === undefined);
// side B: the take in the cut has the same fields and the same region
await page.evaluate(() => __t.setSide('b')); await sleep(200); await page.click(`#bList .bitem[data-id="${E.H}"]`); await sleep(400);
const tb1 = await heldBox('#bTakes .take.incut .tv');
check('Short clip · side B: the take in the cut shows the region from 3/5', tb1 && near(tb1.l, .6, .02) && /Clip ends at 3\.0 s/.test(tb1.title), JSON.stringify(tb1));
const under = await page.evaluate(() => { const h = document.querySelector('#bTakes .take.incut .held').getBoundingClientRect(); const el = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2); return el && el.tagName; });
check('Short clip · side B: the region never blocks a click on the take (the video gets it)', under === 'VIDEO', under);
await page.fill('#bTakes .take.incut input[data-f="speed"]', '1.5'); await page.press('#bTakes .take.incut input[data-f="speed"]', 'Enter'); await sleep(300); await blur();
const tb2 = await heldBox('#bTakes .take.incut .tv');
check('Speed · side B: speed on the take in the cut sets the shot (region now from 2/5)', near(+(await field(E.H, 'speed')), 1.5, 1e-6) && tb2 && near(tb2.l, .4, .02), JSON.stringify(tb2));
await page.screenshot({ path: join(out, 'speed-take-incut.png'), clip: await page.locator('#bTakes .take.incut').boundingBox() });
await page.keyboard.press('Control+z'); await sleep(300);

/* --- Slip: Alt-drag --- */
await selectShot(E.L); T = await tl();
await page.mouse.move(T.x(21), y); await page.keyboard.down('Alt'); await page.mouse.down();
for (let i = 1; i <= 6; i++) { await page.mouse.move(T.x(21 - i * .25), y); await sleep(20); }
const slipRead = await page.evaluate(() => document.getElementById('tlRead').textContent);
await page.mouse.up(); await page.keyboard.up('Alt'); await sleep(300);
const off1 = await field(E.L, 'clipOff'), st1 = await startOf(E.L), cutsSame = await page.evaluate(() => __t.S().map(s => s.start).join());
check('Slip · Alt-drag 1.5 s left inside the shot: the clip starts 1.5 s later', near(+off1, 1.5, .03) && st1 === 19, JSON.stringify({ off1, st1 }));
check('Slip · a readout shows "Clip starts at" while dragging', /Clip starts at 1\.[45]/.test(slipRead), slipRead);
await pop();
check('Slip · the editor field follows', near(+(await page.evaluate(() => document.getElementById('f-off').value)), 1.5, .03));
await page.keyboard.press('Control+z'); await sleep(300);
check('Slip · undo restores the offset', (await field(E.L, 'clipOff')) === undefined && (await page.evaluate(() => __t.S().map(s => s.start).join())) === cutsSame);
await pop();
await page.fill('#f-off', '9'); await page.press('#f-off', 'Enter'); await sleep(200);
check('Slip · the field shows the clamped value it took', +(await page.inputValue('#f-off')) === 4.95, await page.inputValue('#f-off'));
await blur();
check('Slip · the field clamps inside the clip', +(await field(E.L, 'clipOff')) < 5 && +(await field(E.L, 'clipOff')) >= 4.9, String(await field(E.L, 'clipOff')));
await page.keyboard.press('Control+z'); await sleep(200);
// hostile: slip a shot whose clip is a take in the cut: shot and take move together, undo and redo restore both
await selectShot(E.H); T = await tl();
await page.mouse.move(T.x(16), y); await page.keyboard.down('Alt'); await page.mouse.down();
for (let i = 1; i <= 4; i++) { await page.mouse.move(T.x(16 - i * .25), y); await sleep(20); }
await page.mouse.up(); await page.keyboard.up('Alt'); await sleep(300);
const offs = () => page.evaluate(() => { const s = __t.S().find(s => s.id === 'eh'); return [s.clipOff, s.takes[0].clipOff]; });
const o1 = await offs(); await page.keyboard.press('Control+z'); await sleep(300); const o2 = await offs(); await page.keyboard.press('Control+Shift+z'); await sleep(300); const o3 = await offs();
check('Slip · a take in the cut: Alt-drag sets shot and take, undo clears both, redo sets both', near(+o1[0], 1, .03) && o1[0] === o1[1] && o2[0] === undefined && o2[1] === undefined && o3[0] === o1[0] && o3[1] === o1[1], JSON.stringify([o1, o2, o3]));
await page.keyboard.press('Control+z'); await sleep(300);
// plain click-drag inside a shot (no Alt) still scrubs and never slips
T = await tl(); await page.mouse.move(T.x(20), y); await page.mouse.down(); await page.mouse.move(T.x(21), y); await page.mouse.up(); await sleep(200);
check('Slip · a drag without Alt scrubs, offset untouched', (await field(E.L, 'clipOff')) === undefined);

/* --- End frame on side A --- */
await selectShot(E.K);
await pop();
check('End frame · the checkbox sits in the editor, off for a shot without one', await page.isVisible('#f-endon') && !(await page.isChecked('#f-endon')) && await page.isHidden('#f-endrow'));
await page.check('#f-endon'); await sleep(200);
check('End frame · on: a second image slot appears', await page.isVisible('#f-endrow'));
await page.setInputFiles('#f-endimg', { name: 'blue.png', mimeType: 'image/png', buffer: blue });
await page.waitForFunction(() => __t.S().find(s => s.id === 'ek').endKey, null, { timeout: 10000 }); await sleep(400);
const eA = await page.evaluate(() => { const s = __t.S().find(s => s.id === 'ek'); return { endKey: s.endKey, card: !!document.querySelector('#strip .card[data-id="ek"] .endtn img'), at: document.getElementById('f-endat').value }; });
check('End frame · set on side A: stored as endKey, the card shows its corner thumbnail, "End frame from" = the middle', !!eA.endKey && eA.card && near(+eA.at, 2, .01), JSON.stringify(eA));
await page.locator('#f-endrow').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(out, 'speed-editor-end.png'), clip: await page.locator('#editor').boundingBox() });
await page.evaluate(() => __t.setSide('b')); await sleep(200); await page.click(`#bList .bitem[data-id="${E.K}"]`); await sleep(400);
check('End frame · side B shows it as its end frame', await page.evaluate(() => !!document.querySelector('#fEndImg img')));
await page.click(`#bList .bitem[data-id="${E.O}"]`); await sleep(300);
await page.setInputFiles('#fEndIn', { name: 'blue.png', mimeType: 'image/png', buffer: blue });
await page.waitForFunction(() => __t.S().find(s => s.id === 'eo').endKey, null, { timeout: 10000 }); await sleep(300);
await page.evaluate(() => { const d = document.getElementById('dlgFrame'); if (d.open) d.close(); });
await selectShot(E.O);
await pop();
check('End frame · set on side B: side A shows the checkbox on and the slot', await page.isChecked('#f-endon') && await page.isVisible('#f-endrow') && await page.evaluate(() => !!document.querySelector('#f-endth img')));
// the marker on the timeline: drag it from the middle (2 s) to 3 s
await selectShot(E.K); T = await tl();
const my = T.y + T.h - 6;
await page.mouse.move(T.x(24), my); await sleep(60);
const mtip = await page.evaluate(() => document.getElementById('tl').title);
check('End frame · the switch marker is on the timeline at the middle of the shot (tooltip)', /End frame from 2\.0 s/.test(mtip), mtip);
await page.mouse.down(); for (let i = 1; i <= 4; i++) { await page.mouse.move(T.x(24 + i * .25), my); await sleep(20); } await page.mouse.up(); await sleep(300);
const at1 = await field(E.K, 'endAt'), st2 = await page.evaluate(() => __t.S().map(s => s.start).join());
check('End frame · dragging the marker moves the switch to 3 s, the cuts stay', near(+at1, 3, .03) && st2 === cutsSame, String(at1));
check('End frame · the editor number follows', near(+(await page.evaluate(() => document.getElementById('f-endat').value)), 3, .03));
await page.keyboard.press('Control+z'); await sleep(300);
check('End frame · undo puts the switch back', (await field(E.K, 'endAt')) === undefined);
await pop();
await page.fill('#f-endat', '0.8'); await page.press('#f-endat', 'Enter'); await sleep(200); await blur();
check('End frame · "End frame from 0.8 s" typed in the editor', near(+(await field(E.K, 'endAt')), .8, 1e-6));
// off asks before clearing
await pop();
await page.uncheck('#f-endon'); await sleep(200);
check('End frame · off asks first; nothing cleared yet', await page.isVisible('#f-endask') && !!(await field(E.K, 'endKey')));
await page.click('#f-endkeep'); await sleep(200);
check('End frame · Keep: the end frame stays, the checkbox is back on', await page.isChecked('#f-endon') && !!(await field(E.K, 'endKey')) && await page.isHidden('#f-endask'));
await page.uncheck('#f-endon'); await sleep(150); await page.click('#f-endclr'); await sleep(300);
check('End frame · Clear: the end frame is gone on both sides', (await field(E.K, 'endKey')) === '' && !(await page.isChecked('#f-endon')) && await page.isHidden('#f-endrow'));
await page.keyboard.press('Control+z'); await sleep(300);
check('End frame · undo brings it back', !!(await field(E.K, 'endKey')));

/* --- Framing move from the Reframe dialog --- */
await selectShot(E.K);
await page.click('#f-imgrf'); await page.waitForSelector('#dlgFrame[open]'); await sleep(500);
check('Framing · the Reframe dialog has a Move toggle, off for a shot with one framing', await page.isVisible('#rfMove') && !(await page.isChecked('#rfMove')) && await page.isHidden('#rfWhich'));
await page.evaluate(() => { const z = document.getElementById('rfZoom'); z.value = 2; z.dispatchEvent(new Event('input')); });
await page.check('#rfMove'); await sleep(100);
check('Framing · Move on: Start and End to pick which framing you set', await page.isVisible('#rfWhich'));
await page.click('#rfWhich [data-w="1"]'); await sleep(100);
await page.focus('#rfStage'); for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
await page.screenshot({ path: join(out, 'speed-reframe-move.png'), clip: await page.locator('#dlgFrame').boundingBox() });
await page.click('#rfOk'); await sleep(400);
const mv = await page.evaluate(() => { const s = __t.S().find(s => s.id === 'ek'); return { a: s.imgCrop, b: s.imgCrop2, c0: __t.cropAt(s, 'img', 0), c1: __t.cropAt(s, 'img', 4) }; });
check('Framing · saved: a start framing and a different end framing', !!mv.a && !!mv.b && mv.a !== mv.b.replace(/ ease$/, '') && mv.c1[0] > mv.c0[0], JSON.stringify(mv));
await page.click('#f-imgrf'); await page.waitForSelector('#dlgFrame[open]'); await sleep(400);
check('Framing · reopened: Move is on', await page.isChecked('#rfMove'));
await page.uncheck('#rfMove'); await page.click('#rfOk'); await sleep(300);
check('Framing · Move off and saved: one framing again', (await field(E.K, 'imgCrop2')) === undefined && !!(await field(E.K, 'imgCrop')));
await page.keyboard.press('Control+z'); await sleep(300);
check('Framing · undo brings the move back (both framings)', !!(await field(E.K, 'imgCrop2')) && (await field(E.K, 'imgCrop')) === mv.a);

/* --- action rows stay on one line --- */
for (const w of [1280, 1920]) {
  await page.setViewportSize({ width: w, height: 900 }); await sleep(250);
  for (const id of [E.L, E.K]) { await selectShot(id);
    await pop();
    const rows = await page.evaluate(() => ['f-cliprow', 'f-endrow', 'f-imgrow'].map(r => { const el = document.getElementById(r); if (!el || !el.getClientRects().length) return null;
      const tops = new Set([...el.children].filter(c => c.getBoundingClientRect().width > 0).map(c => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
      return { r, tops: tops.size, over: el.scrollWidth > el.clientWidth + 1 }; }).filter(Boolean));
    check(`one line · ${w}px, shot ${id}: ${rows.map(x => x.r).join(', ')}`, rows.length && rows.every(x => x.tops === 1 && !x.over), JSON.stringify(rows)); }
  // the ask when the end frame is turned off, and side B's speed row on the take in the cut
  const oneLine = sel => page.evaluate(sel => { const el = document.querySelector(sel); if (!el || !el.getClientRects().length) return null;
    const tops = new Set([...el.querySelectorAll(':scope > *, :scope > label > *')].filter(c => c.getBoundingClientRect().width > 0).map(c => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)));
    return { tops: tops.size, over: el.scrollWidth > el.clientWidth + 1 }; }, sel);
  await pop();
  await page.uncheck('#f-endon'); await sleep(150); const ask = await oneLine('#f-endask'); await page.click('#f-endkeep'); await sleep(100);
  check(`one line · ${w}px: the ask (text, Clear, Keep)`, ask && ask.tops === 1 && !ask.over, JSON.stringify(ask));
  await page.evaluate(() => __t.setSide('b')); await sleep(200); await page.click(`#bList .bitem[data-id="${E.H}"]`); await sleep(400);
  const sp = await oneLine('#bTakes .take.incut .tspd');
  check(`one line · ${w}px: side B speed row on the take in the cut`, sp && sp.tops === 1 && !sp.over, JSON.stringify(sp));
  await page.evaluate(() => __t.setSide('a')); await sleep(200);
}
await page.setViewportSize({ width: 1440, height: 900 });

/* ================= old projects, export/import ================= */
await importProject('Old one', [sec('o1', 0, { img: 'c3', kind: 'video', clipDur: 3, clipCrop: '16:9 0 0 1 1' }), sec('o2', 5, { img: 'r', kind: '', imgCrop: '16:9 0.1 0.1 0.5 0.5' }), sec('o3', 9)], { c3: b64(C[3], 'video/mp4'), r: b64(red, 'image/png') });
const old = await page.evaluate(() => { const s = __t.S(); return { keys: s.map(x => Object.keys(x).sort().join()), t: __t.srcTime(s[0], 2).t, c: [__t.cropAt(s[1], 'img', 0), __t.cropAt(s[1], 'img', 3.9)] }; });
check('Old project · opens with no new fields written', !old.keys.some(k => /speed|clipOff|endAt|endOn|Crop2/.test(k)), JSON.stringify(old.keys));
check('Old project · plays at 1x from the clip start, single framing stays put', near(old.t, 2, 1e-3) && JSON.stringify(old.c[0]) === JSON.stringify(old.c[1]), JSON.stringify(old));
await selectShot('o1'); await seekTo(1);
const om = await monitorFrame();
check('Old project · monitor: frame 24 at 1 s, rate 1', near(om.n, 24, 1) && om.rate === 1, JSON.stringify(om));
await pop();
check('Old project · editor speed shows 1, clip start 0', await page.evaluate(() => +document.getElementById('f-speed').value === 1 && +document.getElementById('f-off').value === 0));
const oc = await heldBox('#strip .card[data-id="o1"]');
check('Old project · a 3 s clip in a 5 s shot shows its held region (old projects get the new hint, nothing else)', oc && near(oc.l, .6, .02));
// round trip: export the render project, import it again
await importProject('Speed render', [
  sec('x1', 0, { img: 'c6', kind: 'video', clipDur: 6, speed: 0.5, clipOff: 1.25 }),
  sec('x2', 12, { img: 'g', kind: '', imgCrop: '16:9 0 0 0.5 0.5', imgCrop2: '16:9 0.5 0.5 0.5 0.5 ease', endKey: 'b', endAt: 1, endOn: true }), sec('x3', 16),
], { c6: b64(C[6], 'video/mp4'), g: b64(grad, 'image/png'), b: b64(blue, 'image/png') });
const dlx = page.waitForEvent('download', { timeout: 30000 });
await page.evaluate(() => document.getElementById('expGo').click());
let exported = null;
try { const d = await dlx; const f = join(out, 'speed-export.json'); await d.saveAs(f); exported = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.log('export click failed:', e.message); }
const ex = exported && exported.project.sections;
check('Export · the new fields are in the file', ex && ex[0].speed === .5 && ex[0].clipOff === 1.25 && ex[1].imgCrop2 === '16:9 0.5 0.5 0.5 0.5 ease' && ex[1].endAt === 1, ex ? JSON.stringify(ex.map(s => [s.speed, s.clipOff, s.imgCrop2, s.endAt])) : 'no export');
if (exported) {
  exported.project.title = 'Round trip';
  await page.setInputFiles('#importf', { name: 'rt.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.waitForFunction(() => /Round trip/.test(document.getElementById('projname').textContent), null, { timeout: 15000 }); await sleep(300);
  const rt = await page.evaluate(() => { const s = __t.S(); return [s[0].speed, s[0].clipOff, s[1].imgCrop2, s[1].endAt, s[1].endKey ? 1 : 0, __t.cropAt(s[1], 'img', 2)]; });
  check('Import · the fields come back; the eased move halfway is the midpoint', rt[0] === .5 && rt[1] === 1.25 && rt[2] === '16:9 0.5 0.5 0.5 0.5 ease' && rt[3] === 1 && rt[4] === 1 && near(rt[5][0], .25, .01), JSON.stringify(rt));
}
check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
