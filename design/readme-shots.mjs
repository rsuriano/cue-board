// Screenshots for the README (docs/readme/*.png), on the example project:
//   node design/run-local.mjs design/readme-shots.mjs <repo-root> [out-dir]      (default out: docs/readme)
// The example has no pictures, so every shot gets a painted keyframe (drawn in the page with canvas, from its
// frame prompt's palette), a few shots get takes (a slow push-in on the keyframe, recorded in the page), and the
// collaboration view uses a stubbed /collab.js with one other person in the room. Every request outside the local
// server is aborted: nothing reaches OpenRouter or a sync server.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
import { png8 } from './png8.mjs';
import { toShot, tapTile } from './mobile-b-lib.mjs';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out = join(root, 'docs/readme')] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [] };
  const media = { files: () => [], summary: () => ({ total: 0, here: 0, active: 0, unavailable: 0, skipped: 0, failed: 0, relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0, direct: 1, relayed: 0 }), progress: () => null, pause() {}, refresh() {}, downloadAll() {}, download() {}, retry() {} };
  S.ping = () => { if (S.pid) { app.onStatus(S.pid, S.status); app.onPeers(S.pid, S.peers); app.onMedia(S.pid); } };
  return { open(pid) { S.pid = pid; setTimeout(S.ping, 30); return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {}, probe: async () => ({ ok: false }), seed: async () => {} };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/collab.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(STUB); return; }
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', '<meta name="cue-sync-url" content="ws://127.0.0.1:9">');
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];

// ---- in the page: paint 13 keyframes, record takes, write it all to IndexedDB ----
const cache = {};
async function seed(page, { room = false } = {}) {
  Object.assign(cache, await page.evaluate(async ([room, cache]) => {
    const W = 960, H = 540;
    const rnd = s => () => (s = (s * 16807) % 2147483647) / 2147483647;
    const cv = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return [c, c.getContext('2d')]; };
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
    const blob = c => new Promise(r => c.toBlob(r, 'image/jpeg', .9));
    const db = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const st = (n, m) => db.transaction(n, m).objectStore(n), req = q => new Promise(r => { q.onsuccess = () => r(q.result); });
    const p = await req(st('projects', 'readonly').get('p-example')), imgs = [];
    for (let i = 0; i < p.sections.length; i++) {
      const [c, g] = cv(); P[i](g); finish(g); imgs.push(c);
      const b = await blob(c); await req(st('media', 'readwrite').put({ blob: b, type: 'image/jpeg' }, 'm-key-' + i));
      const s = p.sections[i]; s.key = 'm-key-' + i; s.img = 'm-key-' + i; s.kind = 'image';
    }
    // takes: a slow push-in on the keyframe, recorded live (shots 3, 4 and 9)
    // shot 3's end frame: the same door, she is gone
    { const [c2, g2] = cv(); hall(g2); g2.fillStyle = '#23252e'; g2.fillRect(140, 20, 330, H); g2.fillRect(500, 20, 330, H); glow(g2, 485, 300, 70, 'rgba(255,150,60,.45)'); finish(g2);
      const b = await blob(c2); await req(st('media', 'readwrite').put({ blob: b, type: 'image/jpeg' }, 'm-end-2')); p.sections[2].endKey = 'm-end-2'; }
    // takes: a slow push-in (or pull-out) on the keyframe, recorded live once as long as the take, then reused from the cache
    const take = async (src, secs, dir) => { const [c, g] = cv(); const rec = new MediaRecorder(c.captureStream(24), { mimeType: 'video/webm', videoBitsPerSecond: 3e6 }), parts = [];
      rec.ondataavailable = e => parts.push(e.data); const done = new Promise(r => rec.onstop = r); rec.start(); const t0 = performance.now();
      while (performance.now() - t0 < secs * 1000) { const f = (performance.now() - t0) / (secs * 1000), k = 1.02 + .08 * (dir ? f : 1 - f); g.drawImage(src, (W - W * k) / 2, (H - H * k) / 2, W * k, H * k); await new Promise(r => setTimeout(r, 40)); }
      rec.stop(); await done; return new Blob(parts, { type: 'video/webm' }); };
    const b64 = async b => { const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); };
    const unb64 = s => new Blob([Uint8Array.from(atob(s), ch => ch.charCodeAt(0))], { type: 'video/webm' });
    const now = Date.now(), made = {};
    const base = { jobId: '', audio: false, seed: '', start: true, end: false, error: '', note: '', status: 'completed' };
    // Wan 3.0 costs 0.05 USD a second at 480p and 0.10 at 720p (the app's built-in price list)
    for (const [i, list] of [[2, [['720p', 12, 1.2, 1], ['480p', 12, 0.6, 0], ['480p', 12, 0.6, 1]]], [3, [['480p', 14, 0.7, 1]]], [9, [['480p', 27, 1.35, 1]]]]) {
      const s = p.sections[i]; s.takes = [];
      for (let k = 0; k < list.length; k++) { const [res, dur, cost, dir] = list[k], id = `m-take-${i}-${k}`;
        const b = cache[id] ? unb64(cache[id]) : await take(imgs[i], dur, dir); if (!cache[id]) made[id] = await b64(b);
        await req(st('media', 'readwrite').put({ blob: b, type: 'video/webm' }, id));
        s.takes.push({ ...base, id: `t-${i}-${k}`, model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res, dur, clipDur: dur, prompt: s.vidPrompt, est: cost, cost, created: now - (k + 1) * 7 * 60000, media: id }); }
      s.img = s.takes[0].media; s.kind = 'video'; s.clipDur = s.takes[0].dur;
    }
    p.updated = now;
    await req(st('projects', 'readwrite').put(p, p.id));
    await req(st('settings', 'readwrite').put('sk-or-v1-readme-screenshots', 'apiKey'));
    if (room) await req(st('settings', 'readwrite').put({ name: 'Lucía Ferrer', rooms: { 'p-example': { roomId: 'r'.repeat(22), token: 't'.repeat(22), name: 'Lucía Ferrer', owner: true } } }, 'collab'));
    return made;
  }, [room, cache]));
}

async function open(viewport, phone = false, room = false) {
  const ctx = await browser.newContext(phone ? { viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS } : { viewport, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => { const u = r.request().url();
    if (u === 'https://openrouter.ai/api/v1/credits') return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' }, body: JSON.stringify({ data: { total_credits: 20, total_usage: 4.45 } }) });
    return u.startsWith(origin) || /^(data|blob):/.test(u) ? r.continue() : r.abort(); });
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) errs.push(m.text()); });
  const ready = () => page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.getElementById('audio').duration > 0, null, { timeout: 20000 });
  await page.goto(origin + '/index.html'); await ready();
  await seed(page, { room });
  await page.reload(); await ready(); await page.evaluate(() => document.fonts.ready); await sleep(800);
  return { ctx, page };
}
const quiet = page => page.evaluate(() => { document.getElementById('toast').hidden = true; });
const shot = async (page, name, fullPage = false) => { await quiet(page); await sleep(200); const raw = await page.screenshot({ fullPage }), small = [0.3, 0.15, 0].map(k => png8(raw, k)).find((b, i) => b.length < 290e3 || i === 2), buf = small.length < raw.length ? small : raw;
  writeFileSync(join(out, name + '.png'), buf); console.log('shot', name, Math.round(raw.length / 1024) + ' KB →', Math.round(buf.length / 1024) + ' KB'); };
const seekTo = (page, t) => page.evaluate(t => window.__CUE_MEDIA_TEST.app.seek(t), t);
const top = async page => { await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(5, 5); await sleep(400); };
const D = { width: 1440, height: 1000 };

try {
  // ---- desktop: Cut side with a shot selected and an in/out selection; Takes; Render ----
  {
    const { ctx, page } = await open(D);
    console.log('desktop page height', await page.evaluate(() => document.documentElement.scrollHeight));
    await page.locator('.card').nth(3).click(); await sleep(300);
    await page.evaluate(() => { const A = window.__CUE_MEDIA_TEST.app; A.ioSet('in', 26.8); A.ioSet('out', 64.3); }); await seekTo(page, 33);
    await top(page);
    await shot(page, 'cut', true);
    await page.click('.sidetab[data-side="b"]'); await sleep(400); await page.locator('.bitem').nth(2).click(); await sleep(900); await top(page);
    await shot(page, 'takes');
    await page.click('.sidetab[data-side="a"]'); await sleep(300); await page.locator('.card').nth(3).click(); await top(page);
    await page.click('#renderb'); await page.waitForSelector('#dlgRender[open]'); await sleep(500);
    await shot(page, 'render');
    await ctx.close();
  }
  // ---- desktop, in a room with one other person ----
  {
    const { ctx, page } = await open(D, false, true);
    await page.waitForFunction(() => window.__STUB && window.__STUB.pid);
    await page.evaluate(() => { const S = window.__STUB; S.peers = [{ id: 2, name: 'Tomás Ibarra', initials: 'TI', sel: 's-ex-12' }]; S.ping(); });
    await page.locator('.card').nth(9).click(); await sleep(400); await seekTo(page, 108); await top(page);
    await shot(page, 'room', true);
    await ctx.close();
  }
  // ---- phone 390x844: Cut with a shot selected, the Project sheet ----
  {
    const { ctx, page } = await open({ width: 390, height: 844 }, true);
    await toShot(page, 3); await tapTile(page); await sleep(400);
    await shot(page, 'phone-cut');
    await page.tap('#mTabs [data-side="b"]'); await sleep(600);
    await shot(page, 'phone-takes');
    await page.tap('#mTabs [data-side="a"]'); await sleep(300);
    await page.tap('#proj'); await sleep(500);
    await shot(page, 'phone-project');
    await ctx.close();
  }
} catch (e) { console.log('FAIL', e.stack); }
console.log(errs.length ? 'page errors: ' + errs.join(' | ') : 'no page errors');
await browser.close(); srv.close();
