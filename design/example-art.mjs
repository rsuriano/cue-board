// Paints the example project's pictures and writes them next to it, then points example/example.js at them:
//   node design/run-local.mjs design/example-art.mjs <repo-root>
// Writes example/media/key-01.jpg … key-13.jpg (each shot's start frame, painted with canvas from its frame prompt's
// palette), end-03.jpg (shot 3's end frame: the same door, she is gone) and five takes as MP4 (H.264, no sound: a slow
// push-in or pull-out on the keyframe) for shots 3, 4 and 10. The takes are encoded frame by frame with WebCodecs and
// the vendored mp4-muxer.js, so the output is the same on every run. Then it rewrites example/example.js: each shot's
// key / img / endKey / takes, and a `media` map of { type, url } that index.html fetches when the example opens.
// Run it again after changing a painter; the README screenshots (design/readme-shots.mjs) use the result as shipped.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
import vm from 'node:vm';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root] = process.argv.slice(2);
if (!root) { console.log('usage: node design/run-local.mjs design/example-art.mjs <repo-root>'); process.exit(2); }
const dir = join(root, 'example/media');
mkdirSync(dir, { recursive: true });

// [shot index, [resolution, seconds, cost in USD, 1 = push in / 0 = pull out]]. Wan 3.0 costs 0.05 USD a second at
// 480p and 0.10 at 720p (the app's built-in price list).
const TAKES = [[2, [['720p', 12, 1.2, 1], ['480p', 12, 0.6, 0], ['480p', 12, 0.6, 1]]], [3, [['480p', 14, 0.7, 1]]], [9, [['480p', 27, 1.35, 1]]]];

const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': extname(p) === '.js' ? 'text/javascript' : 'text/html' }); r.end(readFileSync(p)); }
  catch { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>art</title>'); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('page error', String(e)));
await page.goto(`http://127.0.0.1:${srv.address().port}/blank`);
await page.addScriptTag({ url: '/mp4-muxer.js' });

const art = await page.evaluate(async TAKES => {
  // every painter draws on a 960x540 plane; the canvas is twice that, so the takes stay sharp while they zoom
  const W = 960, H = 540, S = 2;
  const rnd = s => () => (s = (s * 16807) % 2147483647) / 2147483647;
  const cv = (w = W * S, h = H * S) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
  const lin = (g, y0, y1, stops) => { const gr = g.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; };
  const glow = (g, x, y, r, c, a = 1) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.globalAlpha = a; g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); g.globalAlpha = 1; };
  const ridge = (g, seed, y, amp, col, jag = 9) => { const R = rnd(seed); g.fillStyle = col; g.beginPath(); g.moveTo(0, H); let yy = y; for (let x = 0; x <= W; x += W / (jag * 4)) { yy = y + (R() - .5) * amp * 2 + Math.sin(x / 140 + seed) * amp * .6; g.lineTo(x, yy); } g.lineTo(W, H); g.fill(); };
  const peak = (g, cx, top, w, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(cx - w, H); g.lineTo(cx - w * .35, top + 110); g.lineTo(cx - w * .12, top + 40); g.lineTo(cx, top); g.lineTo(cx + w * .1, top + 50); g.lineTo(cx + w * .3, top + 90); g.lineTo(cx + w, H); g.fill(); };
  const cave = (g, seed, col = '#07080d') => { const R = rnd(seed); g.fillStyle = col; g.beginPath(); g.moveTo(0, 0); for (let x = 0; x <= W; x += 40) g.lineTo(x, 40 + R() * 70 + Math.abs(x - W / 2) / 5); g.lineTo(W, 0); g.fill();
    g.beginPath(); g.moveTo(0, 0); for (let y = 0; y <= H; y += 40) g.lineTo(60 + R() * 60, y); g.lineTo(0, H); g.fill(); g.beginPath(); g.moveTo(W, 0); for (let y = 0; y <= H; y += 40) g.lineTo(W - 60 - R() * 60, y); g.lineTo(W, H); g.fill(); };
  const torch = (g, x, y, s = 1) => { glow(g, x, y, 170 * s, 'rgba(240,150,60,.55)'); g.fillStyle = '#2a1a10'; g.fillRect(x - 3 * s, y, 6 * s, 34 * s); g.fillStyle = '#ffd38a'; g.beginPath(); g.ellipse(x, y - 4 * s, 7 * s, 13 * s, 0, 0, 7); g.fill(); g.fillStyle = '#ff9a3a'; g.beginPath(); g.ellipse(x, y, 9 * s, 8 * s, 0, 0, 7); g.fill(); };
  const figure = (g, x, y, h, col = '#24331f', lean = 0) => { g.fillStyle = col; g.beginPath(); g.moveTo(x - h * .26 + lean, y); g.quadraticCurveTo(x - h * .2, y - h * .6, x - h * .09 + lean * .3, y - h * .8); g.quadraticCurveTo(x, y - h * 1.02, x + h * .1 + lean * .3, y - h * .8); g.quadraticCurveTo(x + h * .2, y - h * .6, x + h * .26 + lean, y); g.fill(); g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.ellipse(x + lean * .3, y - h * .78, h * .055, h * .07, 0, 0, 7); g.fill(); };
  const troll = (g, x, y, s, col = '#0b0c10') => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, 120 * s, 70 * s, 0, Math.PI, 0); g.fill(); g.beginPath(); g.arc(x - 90 * s, y - 40 * s, 42 * s, 0, 7); g.fill(); };
  const crown = (g, x, y, s) => { glow(g, x, y - 20 * s, 150 * s, 'rgba(255,200,90,.6)'); g.fillStyle = '#d9a63c'; g.beginPath(); g.moveTo(x - 60 * s, y); g.lineTo(x - 64 * s, y - 52 * s); g.lineTo(x - 34 * s, y - 24 * s); g.lineTo(x, y - 64 * s); g.lineTo(x + 34 * s, y - 24 * s); g.lineTo(x + 64 * s, y - 52 * s); g.lineTo(x + 60 * s, y); g.fill();
    g.fillStyle = '#f3cf72'; g.fillRect(x - 60 * s, y - 12 * s, 120 * s, 12 * s); g.fillStyle = '#3f9a5a'; [-34, 0, 34].forEach(d => { g.beginPath(); g.arc(x + d * s, y - 6 * s, 5 * s, 0, 7); g.fill(); }); };
  const pedestal = (g, x, y) => { g.fillStyle = '#1b1d26'; g.fillRect(x - 80, y, 160, H - y); g.fillStyle = '#2a2d39'; g.fillRect(x - 100, y - 14, 200, 18); };
  const fog = (g, y, a = .25) => { g.fillStyle = lin(g, y - 80, y + 80, [[0, 'rgba(120,140,190,0)'], [.5, `rgba(120,140,190,${a})`], [1, 'rgba(120,140,190,0)']]); g.fillRect(0, y - 80, W, 160); };
  const finish = g => { const v = g.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, W * .65); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.6)'); g.fillStyle = v; g.fillRect(0, 0, W, H); };
  const night = g => { g.fillStyle = lin(g, 0, H, [[0, '#0a1024'], [.6, '#1a2850'], [1, '#2a3560']]); g.fillRect(0, 0, W, H); };
  const hall = g => { g.fillStyle = lin(g, 0, H, [[0, '#0c0d14'], [.55, '#2a1c16'], [1, '#120d0b']]); g.fillRect(0, 0, W, H); };
  const P = [
    g => { night(g); glow(g, 720, 110, 160, 'rgba(220,230,255,.35)'); g.fillStyle = '#e9edf7'; g.beginPath(); g.arc(720, 110, 34, 0, 7); g.fill(); ridge(g, 3, 400, 30, '#141c36'); peak(g, 430, 120, 420, '#0b1022'); glow(g, 450, 300, 60, 'rgba(255,140,50,.9)'); g.strokeStyle = '#ffb060'; g.lineWidth = 3; g.beginPath(); g.moveTo(446, 250); g.lineTo(452, 290); g.lineTo(444, 330); g.stroke(); fog(g, 430, .3); ridge(g, 8, 480, 14, '#05070f'); },
    g => { hall(g); for (let i = 0; i < 5; i++) { g.fillStyle = `hsl(220,12%,${9 + i * 3}%)`; g.fillRect(0, 300 + i * 50, W, 50); g.fillStyle = 'rgba(255,170,90,.18)'; g.fillRect(0, 300 + i * 50, W, 3); } torch(g, 820, 130, 1.2); g.fillStyle = '#3a2618'; g.beginPath(); g.ellipse(400, 395, 95, 34, -.08, 0, 7); g.fill(); g.fillRect(330, 300, 70, 90); g.beginPath(); g.ellipse(600, 445, 95, 34, .05, 0, 7); g.fill(); g.fillRect(560, 360, 70, 80); },
    g => { hall(g); g.fillStyle = '#23252e'; g.fillRect(140, 20, 330, H); g.fillRect(500, 20, 330, H); g.strokeStyle = 'rgba(255,170,80,.35)'; g.lineWidth = 3; for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(190 + (i % 3) * 90, 70 + Math.floor(i / 3) * 140); g.lineTo(220 + (i % 3) * 90, 120 + Math.floor(i / 3) * 140); g.lineTo(200 + (i % 3) * 90, 150 + Math.floor(i / 3) * 140); g.stroke(); } glow(g, 485, 300, 120, 'rgba(255,150,60,.7)'); figure(g, 488, 520, 330, '#2d4a28', 10); },
    g => { hall(g); cave(g, 11); [180, 380, 580, 780].forEach(x => torch(g, x, 180, .8)); troll(g, 200, 470, 1.1); troll(g, 760, 480, 1.2, '#0d0e12'); g.fillStyle = 'rgba(255,170,90,.12)'; g.fillRect(0, 440, W, 100); figure(g, 480, 430, 70, '#2d4a28'); },
    g => { g.fillStyle = lin(g, 0, H, [[0, '#08090e'], [1, '#18130f']]); g.fillRect(0, 0, W, H); pedestal(g, 480, 380); crown(g, 480, 368, 1.6); figure(g, 486, 352, 50, 'rgba(20,30,20,.6)'); finish(g); },
    g => { g.fillStyle = lin(g, 0, H, [[0, '#3a3f38'], [1, '#22261f']]); g.fillRect(0, 0, W, H); const R = rnd(5); for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(${60 + R() * 40},${80 + R() * 40},${50 + R() * 20},.35)`; g.beginPath(); g.arc(R() * W, R() * H, 6 + R() * 30, 0, 7); g.fill(); } g.fillStyle = '#e8d9a0'; g.beginPath(); g.ellipse(480, 280, 250, 70, 0, 0, 7); g.fill(); g.fillStyle = '#7a5a12'; g.beginPath(); g.arc(480, 280, 66, 0, 7); g.fill(); g.fillStyle = '#0a0806'; g.beginPath(); g.ellipse(480, 280, 14, 52, 0, 0, 7); g.fill(); g.fillStyle = '#2c3127'; g.beginPath(); g.ellipse(480, 190, 280, 120, 0, 0, Math.PI); g.fill(); },
    g => { g.fillStyle = lin(g, 0, H, [[0, '#08090e'], [1, '#1c150f']]); g.fillRect(0, 0, W, H); pedestal(g, 480, 420); crown(g, 480, 410, 1.5); g.fillStyle = '#1b1a1f'; g.beginPath(); g.moveTo(960, 200); g.lineTo(620, 300); g.quadraticCurveTo(520, 300, 500, 360); g.lineTo(560, 400); g.quadraticCurveTo(640, 380, 960, 360); g.fill(); finish(g); },
    g => { hall(g); g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.ellipse(250, 200, 200, 260, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(700, 170, 230, 300, 0, 0, 7); g.fill(); torch(g, 470, 160, 1); g.fillStyle = '#2b2a2f'; g.fillRect(560, 0, 110, H); figure(g, 545, 520, 270, '#2d4a28'); crown(g, 520, 380, .35); },
    g => { g.fillStyle = lin(g, 0, H, [[0, '#2a120c'], [1, '#0b0607']]); g.fillRect(0, 0, W, H); glow(g, 480, 130, 300, 'rgba(255,120,40,.4)'); g.fillStyle = '#070607'; g.beginPath(); g.moveTo(140, H); g.lineTo(240, 200); g.lineTo(360, 120); g.lineTo(480, 60); g.lineTo(600, 120); g.lineTo(720, 200); g.lineTo(820, H); g.fill(); g.beginPath(); g.moveTo(560, 160); g.lineTo(920, 360); g.lineTo(900, 400); g.lineTo(560, 230); g.fill(); g.fillStyle = '#ff8a3a'; g.beginPath(); g.arc(450, 120, 6, 0, 7); g.arc(510, 120, 6, 0, 7); g.fill(); },
    g => { hall(g); g.fillStyle = '#0a0a0e'; g.beginPath(); g.moveTo(0, 0); g.lineTo(380, 220); g.lineTo(380, 330); g.lineTo(0, H); g.fill(); g.beginPath(); g.moveTo(W, 0); g.lineTo(580, 220); g.lineTo(580, 330); g.lineTo(W, H); g.fill(); glow(g, 480, 270, 90, 'rgba(255,190,110,.6)'); torch(g, 160, 170, .9); torch(g, 800, 170, .9); figure(g, 470, 500, 240, '#2d4a28', 30); troll(g, 480, 300, .3); },
    g => { hall(g); const R = rnd(13); g.fillStyle = 'rgba(200,170,130,.15)'; g.fillRect(0, 0, W, H); for (let i = 0; i < 26; i++) { g.fillStyle = `hsl(25,10%,${8 + R() * 10}%)`; g.beginPath(); g.arc(R() * W, R() * H * .9, 14 + R() * 40, 0, 7); g.fill(); } for (let i = 0; i < 60; i++) { g.fillStyle = '#ffb060'; g.fillRect(R() * W, R() * H, 2, 2); } ridge(g, 4, 470, 20, '#0b0908'); },
    g => { hall(g); cave(g, 21); g.fillStyle = '#ffeccc'; g.beginPath(); g.ellipse(820, 230, 80, 140, 0, 0, 7); g.fill(); glow(g, 820, 230, 300, 'rgba(255,230,180,.5)'); g.fillStyle = '#050407'; g.fillRect(0, 380, 330, 160); g.fillRect(640, 400, 320, 140); figure(g, 470, 300, 150, '#2d4a28', -40); },
    g => { g.fillStyle = lin(g, 0, H, [[0, '#f2b26a'], [.5, '#f6d7a0'], [1, '#c98a52']]); g.fillRect(0, 0, W, H); glow(g, 760, 330, 260, 'rgba(255,240,200,.9)'); ridge(g, 2, 330, 26, '#a6735a'); ridge(g, 6, 390, 22, '#7d5545'); ridge(g, 9, 450, 18, '#4f3a32'); g.fillStyle = '#2a201c'; g.beginPath(); g.moveTo(0, 420); g.lineTo(380, 400); g.lineTo(420, H); g.lineTo(0, H); g.fill(); figure(g, 250, 410, 190, '#2d4a28'); crown(g, 300, 220, .35); },
  ];
  // shot 3's end frame: the same door, she is gone
  const END = g => { hall(g); g.fillStyle = '#23252e'; g.fillRect(140, 20, 330, H); g.fillRect(500, 20, 330, H); glow(g, 485, 300, 70, 'rgba(255,150,60,.45)'); };
  const paint = fn => { const [c, g] = cv(); g.scale(S, S); fn(g); finish(g); return c; };
  const b64 = async b => { const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); };
  const jpeg = async src => { const [c, g] = cv(W, H); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, W, H); return b64(await new Promise(r => c.toBlob(r, 'image/jpeg', .86))); };
  // a take: the keyframe scaled from 1.02 to 1.10 (or back) around its centre, 24 frames a second, H.264 in MP4
  const take = async (src, res, secs, dir) => {
    const [w, h] = res === '720p' ? [1280, 720] : [854, 480], fps = 24, n = secs * fps, [c, g] = cv(w, h);
    const M = window.Mp4Muxer, mux = new M.Muxer({ target: new M.ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
    let err = null;
    const enc = new VideoEncoder({ output: (ch, meta) => mux.addVideoChunk(ch, meta), error: e => { err = e; } });
    enc.configure({ codec: 'avc1.4d0028', width: w, height: h, bitrate: res === '720p' ? 300e3 : 150e3, bitrateMode: 'variable', framerate: fps, avc: { format: 'avc' } });
    g.imageSmoothingQuality = 'high';
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1), k = 1.02 + .08 * (dir ? f : 1 - f);
      g.drawImage(src, (w - w * k) / 2, (h - h * k) / 2, w * k, h * k);
      const fr = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(fr, { keyFrame: i % (fps * 2) === 0 }); fr.close();
      if (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
    }
    await enc.flush(); enc.close(); if (err) throw err; mux.finalize();
    return b64(new Blob([mux.target.buffer]));
  };
  const pics = P.map(paint), out = { keys: [], end: await jpeg(paint(END)), takes: {} };
  for (const c of pics) out.keys.push(await jpeg(c));
  for (const [i, list] of TAKES) for (let k = 0; k < list.length; k++) { const [res, dur, , dir] = list[k]; out.takes[`${i}-${k}`] = await take(pics[i], res, dur, dir); }
  return out;
}, TAKES);
await browser.close(); srv.close();

// ---- the files ----
const pad = n => String(n).padStart(2, '0');
const sizes = [];
const put = (name, b64) => { const b = Buffer.from(b64, 'base64'); writeFileSync(join(dir, name), b); sizes.push([name, b.length]); };
art.keys.forEach((b, i) => put(`key-${pad(i + 1)}.jpg`, b));
put('end-03.jpg', art.end);
for (const [i, list] of TAKES) list.forEach((_, k) => put(`take-${pad(i + 1)}-${'abc'[k]}.mp4`, art.takes[`${i}-${k}`]));

// ---- example/example.js: the shots point at the files ----
const file = join(root, 'example/example.js'), src = readFileSync(file, 'utf8'), at = src.indexOf('window.CUEBOARD_EXAMPLE=');
const box = { window: {} }; vm.runInNewContext(src, box);
const data = box.window.CUEBOARD_EXAMPLE, p = data.project, media = {};
const url = name => 'example/media/' + name;
p.sections.forEach((s, i) => {
  const id = `ex-key-${pad(i + 1)}`; media[id] = { type: 'image/jpeg', url: url(`key-${pad(i + 1)}.jpg`) };
  Object.assign(s, { key: id, img: id, kind: 'image', endKey: '', clipDur: 0, takes: [] });
});
media['ex-end-03'] = { type: 'image/jpeg', url: url('end-03.jpg') }; p.sections[2].endKey = 'ex-end-03';
const base = { jobId: '', audio: false, seed: '', start: true, end: false, error: '', note: '', status: 'completed' };
for (const [i, list] of TAKES) {
  const s = p.sections[i];
  list.forEach(([res, dur, cost], k) => {
    const id = `ex-take-${pad(i + 1)}-${'abc'[k]}`; media[id] = { type: 'video/mp4', url: url(`take-${pad(i + 1)}-${'abc'[k]}.mp4`) };
    s.takes.push({ ...base, id: `t-ex-${pad(i + 1)}-${'abc'[k]}`, model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res, dur, clipDur: dur, prompt: s.vidPrompt, est: cost, cost, created: p.created - (k + 1) * 7 * 60000, media: id });
  });
  Object.assign(s, { img: s.takes[0].media, kind: 'video', clipDur: s.takes[0].dur });
}
data.media = media;
let head = src.slice(0, at);
if (!/example-art\.mjs/.test(head)) head = head.replace(/\*\/\s*$/, '\n   Pictures and takes: example/media/, made by design/example-art.mjs and fetched when the example opens. */\n');
writeFileSync(file, head + 'window.CUEBOARD_EXAMPLE=' + JSON.stringify(data) + ';\n');

const total = sizes.reduce((a, [, n]) => a + n, 0);
for (const [n, b] of sizes) console.log(n.padEnd(16), Math.round(b / 1024) + ' KB');
console.log('total', Math.round(total / 1024) + ' KB');
