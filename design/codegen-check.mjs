// Generate with code + Connect with OpenRouter, through the UI, with OpenRouter stubbed by fixtures (real animation code
// written for these checks; no paid model is ever called): the request body and what reaches the sandbox, the card's
// steps, the MP4 parsed (codec, size, fps, length), costs and Project spend, Stop, versions and Ask for a change, a
// throw and Fix it, an endless loop, the real-time fallback, the Code tab without OffscreenCanvas, OAuth URL, return,
// failures, the phone layout at 390x844 and 390x667, and screenshots of every state.
//   node design/codegen-check.mjs <repo-root> <out-dir>
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdefa1f3';

// ---- fixtures: what a model answers ----
const GOOD = `function animation({ canvas, ctx, width, height, fps, duration, random, beats, energy, lib }) {
  const hits = beats.length ? beats : lib.grid(duration, 0.5);
  const dots = Array.from({ length: 24 }, (_, i) => ({ a: (i / 24) * Math.PI * 2, r: 0.18 + random() * 0.2, s: 0.5 + random() }));
  return function draw(t) {
    ctx.fillStyle = '#1b3a6b'; ctx.fillRect(0, 0, width, height);
    let last = -1; for (const b of hits) { if (b <= t) last = b; else break; }
    const pulse = last < 0 ? 0 : Math.max(0, 1 - (t - last) / 0.3), e = energy ? energy(t) : 0.5, m = Math.min(width, height);
    ctx.fillStyle = '#f0b44c';
    for (const d of dots) { const a = d.a + t * 0.4 * d.s; ctx.beginPath(); ctx.arc(width / 2 + Math.cos(a) * d.r * m, height / 2 + Math.sin(a) * d.r * m, m * (0.012 + 0.02 * pulse + 0.01 * e), 0, Math.PI * 2); ctx.fill(); }
    ctx.font = '600 ' + Math.round(m * 0.08) + 'px "Instrument Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff';
    ctx.fillText('Up the steps', width / 2, height * 0.9);
  };
}`;
const GOOD2 = GOOD.replace("'#1b3a6b'", "'#5a2a1b'").replace('t * 0.4', 't * 0.2');
const THROWS = `function animation({ ctx, width, height }) {
  const pts = [];
  return function draw(t, i) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
    const p = pts[3];
    ctx.fillRect(p.x, 0, 10, 10);
  };
}`;
const LOOP = `function animation({ ctx }) { return function draw(t) { while (true) {} }; }`;
const sse = (code, cost = 0.0123, text) => {
  const content = text != null ? text : 'Here is the animation.\n```js\n' + code + '\n```\nIt loops smoothly.';
  const parts = []; for (let i = 0; i < content.length; i += 300) parts.push(content.slice(i, i + 300));
  return parts.map(p => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') +
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 3100, completion_tokens: 1400, cost } }) + '\n\n: keepalive\n\ndata: [DONE]\n\n';
};

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function newPage(name, { phone = null, init = null } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const st = { answers: [], chat: [], ext: [], keys: [], hold: null };
  await ctx.route('**/*', async r => {
    const u = r.request().url();
    if (u.startsWith(origin)) return r.continue();
    st.ext.push(r.request().method() + ' ' + u);
    if (u === 'https://openrouter.ai/api/v1/chat/completions') {
      st.chat.push({ body: r.request().postData(), auth: (await r.request().allHeaders()).authorization || '' });
      const a = st.answers.shift();
      if (a === 'hold') { st.hold = r; return; }
      if (!a) return r.fulfill({ status: 500, body: '{}' });
      return r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: a });
    }
    if (u === 'https://openrouter.ai/api/v1/auth/keys') { st.keys.push(r.request().postData()); const k = st.keyAnswer || { status: 200, body: { key: 'sk-or-v1-fromoauth0000000000000000000000beef' } };
      if (k === 'net') return r.abort(); return r.fulfill({ status: k.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(k.body) }); }
    if (u.startsWith('https://openrouter.ai/auth?')) { st.auth = u; return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>OpenRouter (stub)</p>' }); }
    return r.abort();
  });
  await ctx.addInitScript(() => {
    window.__CUE_MEDIA_TEST = { off: true }; window.__CUE_CG_TEST = {};
    // every message the app sends to a sandbox, as text (fonts are byte arrays: skipped)
    window.__cgSent = [];
    const keep = d => { try { window.__cgSent.push(JSON.stringify(d, (k, v) => v instanceof ArrayBuffer ? '[bytes]' : v)); } catch (e) {} };
    const wp = Window.prototype.postMessage; Window.prototype.postMessage = function (d, ...a) { if (this !== window) keep(d); return wp.call(this, d, ...a); };
    const mp = MessagePort.prototype.postMessage; MessagePort.prototype.postMessage = function (d, ...a) { keep(d); return mp.call(this, d, ...a); };
    const f = window.fetch; window.__aborted = 0; window.fetch = function (u, o) { if (o && o.signal) o.signal.addEventListener('abort', () => window.__aborted++); return f.call(this, u, o); };
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.st = st; page.ctx = ctx;
  return page;
}
const onSideB = async (page, shot = 2) => {
  const phone = await page.evaluate(() => !matchMedia('(min-width:820px)').matches);
  for (let k = 0; k < 50 && !(await page.evaluate(() => !document.getElementById('sideB').hidden && !!document.querySelector('#bList .bitem'))); k++) {
    await page.click(phone ? '#mTabs [data-side="b"]' : '.sidetab[data-side="b"]').catch(() => {}); await sleep(200); }
  await page.evaluate(n => document.querySelectorAll('#bList .bitem')[n - 1].click(), shot); await sleep(400);
};
const openExample = async page => {
  await page.goto(app); await page.waitForSelector('#projname');
  for (let i = 0; i < 100 && !(await page.evaluate(() => /Mountain/.test(document.getElementById('projname').textContent) && document.getElementById('audio').duration > 0)); i++) await sleep(150);
  await sleep(600);
};
const setKey = async page => { await page.evaluate(async k => { document.getElementById('settingsb').click(); await new Promise(r => setTimeout(r, 100)); document.getElementById('setKey').value = k; document.querySelector('#setForm [type=submit]').click(); }, KEY); await sleep(400); };
const card = page => page.evaluate(() => { const c = document.querySelector('#bTakes .take'); return c ? { text: c.innerText, id: c.dataset.id, vers: [...c.querySelectorAll('.cg-v')].map(v => v.innerText.replace(/\s+/g, ' ')), cur: (c.querySelector('.cg-v[aria-current="true"]') || {}).innerText } : null; });
const waitCard = async (page, re, ms = 90000) => { const t0 = Date.now(); let c; while (Date.now() - t0 < ms) { c = await card(page); if (c && re.test(c.text)) return c; await sleep(150); } return c; };
const shot = (page, n) => page.screenshot({ path: join(out, n + '.png') });
const take = (page, id) => page.evaluate(id => { const p = window.__cgProject && window.__cgProject(); return null; }, id);
const mp4 = page => page.evaluate(async () => {
  const v = document.querySelector('#bTakes .take video'); if (!v) return null;
  const b = new DataView(await (await fetch(v.src)).arrayBuffer()), o = { bytes: b.byteLength };
  const walk = (p, e) => { while (p + 8 <= e) { let sz = b.getUint32(p), h = 8; const ty = String.fromCharCode(...[4, 5, 6, 7].map(k => b.getUint8(p + k))); if (sz === 1) { sz = Number(b.getBigUint64(p + 8)); h = 16; } if (sz === 0) sz = e - p;
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(ty)) { if (ty !== 'trak' || o.tracks === undefined) walk(p + h, p + sz); o.tracks = (o.tracks || 0) + (ty === 'trak'); }
    else if (ty === 'ftyp') o.brand = String.fromCharCode(...[0, 1, 2, 3].map(k => b.getUint8(p + h + k)));
    else if (ty === 'mdhd' && !o.ts) { const v1 = b.getUint8(p + h); o.ts = b.getUint32(p + h + (v1 ? 20 : 12)); o.dur = v1 ? Number(b.getBigUint64(p + h + 24)) : b.getUint32(p + h + 16); }
    else if (ty === 'stsd' && !o.codec) { const q = p + h + 8; o.codec = String.fromCharCode(...[4, 5, 6, 7].map(k => b.getUint8(q + k))); o.w = b.getUint16(q + 32); o.h = b.getUint16(q + 34); }
    else if (ty === 'stts' && !o.frames) { const n = b.getUint32(p + h + 4); let c = 0, d = 0; for (let k = 0; k < n; k++) { c += b.getUint32(p + h + 8 + k * 8); d = b.getUint32(p + h + 12 + k * 8); } o.frames = c; o.delta = d; }
    p += sz; } };
  walk(0, b.byteLength); o.fps = o.ts / o.delta; o.secs = o.dur / o.ts; return o; });
const shotLen = page => page.evaluate(() => { const t = document.getElementById('bTime').textContent; return +/·\s*([\d.]+)\s*s/.exec(t)[1]; });

// ================= desktop: the whole flow =================
{
  const page = await newPage('desk');
  await openExample(page);
  const loadExt = page.st.ext.filter(u => !/\/videos\/models$/.test(u));
  check('19 page load: no new third-party request (only the existing video catalog)', loadExt.length === 0, loadExt.join(' '));
  await onSideB(page, 2);
  await page.click('[data-mk="code"]'); await sleep(1500);
  await page.fill('#cgPrompt', 'Gold dots circle a deep blue night and pulse on each beat. The words "Up the steps" at the bottom.');
  await sleep(300);
  const box = await page.evaluate(() => ({ tok: document.getElementById('cgTok').textContent, est: document.getElementById('cgEst').textContent, beat: document.getElementById('cgBeatL').textContent, ai: getComputedStyle(document.getElementById('bPrompt')).display }));
  check('13 estimate before Send: tokens and USD in the box', /^About [\d,]+ tokens$/.test(box.tok) && /^≈ \d+\.\d\d USD$/.test(box.est), JSON.stringify(box));
  check('code mode: the beat option counts this shot’s beats', /Follow the song’s beat \(\d+ beats in this shot\)/.test(box.beat), box.beat);
  await shot(page, 'desktop-1440x900-1-b-side-code');
  // no key: Generate opens Settings with the new message
  await page.click('#cgGo'); await sleep(300);
  const noKey = await page.evaluate(() => ({ open: document.getElementById('dlgSettings').open, msg: document.getElementById('setMsg').textContent }));
  check('no key: Generate opens Settings with "Connect OpenRouter to generate takes."', noKey.open && noKey.msg === 'Connect OpenRouter to generate takes.', JSON.stringify(noKey));
  await page.evaluate(() => document.getElementById('dlgSettings').close());
  await setKey(page);
  const spend0 = await page.textContent('#bSpent');
  // ---- a good take, with the progress shot ----
  page.st.answers.push(sse(GOOD, 0.0123));
  await page.click('#cgGo');
  const prog = await waitCard(page, /Recording\n?.*\d+ \/ \d+/, 20000);
  await sleep(700); await shot(page, 'desktop-1440x900-3-progress');
  check('card steps: Writing → Testing → Recording with a frame count', prog && /Writing the code/.test(prog.text) && /Testing in the sandbox/.test(prog.text) && /\d+ \/ \d+/.test(prog.text), prog && prog.text.slice(0, 200));
  const done = await waitCard(page, /Use in cut|Play in cut|failed|Stopped/i);
  check('a code take completes: versions, Ask for a change, Use in cut', await page.evaluate(() => !!document.querySelector('#bTakes .take .cgask')) && /Use in cut/.test(done.text) && done.vers.length === 1, done.text.slice(0, 300));
  const body = JSON.parse(page.st.chat[0].body), user = body.messages.find(m => m.role === 'user').content, sys = body.messages.find(m => m.role === 'system').content;
  const s2 = await page.evaluate(() => { const t = document.getElementById('bTitle').textContent; return { title: t, notes: document.getElementById('bNotes').textContent, vid: document.getElementById('bPrompt').value }; });
  const len = await shotLen(page);
  check('10 body: model, stream, max_tokens, usage', body.model === 'anthropic/claude-sonnet-5.5' && body.stream === true && body.max_tokens === 8000 && body.usage && body.usage.include === true, JSON.stringify({ model: body.model, s: body.stream, m: body.max_tokens }));
  check('10 body: the shot’s title, notes, video prompt, words, duration, fps, size, seed', user.includes(s2.title) && (!s2.notes || user.includes(s2.notes.trim())) && (!s2.vid || user.includes(s2.vid.trim())) && user.includes('Gold dots circle') && user.includes(`duration: ${len}`) && /fps: 30/.test(user) && /size: 1920x1080/.test(user) && /seed: \d+/.test(user), user.slice(0, 400));
  check('10 body: beats and loudness with the beat on', /beats \(seconds from the shot's start\): \[\d/.test(user) && /loudness \(10 values per second/.test(user));
  check('10 body: Authorization header, no key in the body', page.st.chat[0].auth === 'Bearer ' + KEY && !page.st.chat[0].body.includes(KEY));
  check('system prompt: the contract and the example, about 1,800 tokens', sys.includes('function animation({ canvas, ctx') && sys.length > 4500 && sys.length < 9000, sys.length + ' chars');
  // what reached the sandbox
  const sent = await page.evaluate(() => window.__cgSent.concat((window.__CUE_CG_TEST.sent || []).map(m => JSON.stringify(m, (k, v) => v instanceof ArrayBuffer ? '[bytes]' : v))).join('\n'));
  const pid = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cueboard-last') || 'null'); } catch (e) { return null; } });
  const others = await page.evaluate(() => [...document.querySelectorAll('#bList .bitem .ct')].map(x => x.textContent).filter((t, i) => i !== 1 && t.length > 6));
  check('2 scan: no key, no other shot’s title in any message to the sandbox', sent.length > 0 && !sent.includes(KEY) && !sent.includes('sk-or') && others.every(t => !sent.includes(t)), others.find(t => sent.includes(t)) || '');
  const job = sent.split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).find(m => m && m.type === 'job');
  check('2 scan: the job has only the listed fields', job && Object.keys(job).join() === 'type,code,width,height,fps,duration,seed,beats,energy,fonts', job && Object.keys(job).join());
  // the file
  const f = await mp4(page);
  check('8 output: MP4 / H.264, 30 fps, 1920x1080', f && f.codec === 'avc1' && f.w === 1920 && f.h === 1080 && Math.abs(f.fps - 30) < 0.01, JSON.stringify(f));
  check('8 output: the shot’s length ± 1 frame', f && Math.abs(f.frames - Math.round(len * 30)) <= 1, `${f && f.frames} frames for ${len} s`);
  check('8 output: about 6 Mbit/s', f && f.bytes * 8 / f.secs < 9e6, f && Math.round(f.bytes * 8 / f.secs / 1e3) + ' kbit/s');
  // cost
  const c1 = await page.evaluate(() => document.querySelector('#bTakes .take .tmeta').innerText);
  const spend1 = await page.textContent('#bSpent');
  check('13 the take’s cost is usage.cost; Project spend goes up by it', /0\.01 USD/.test(c1) && Math.abs(parseFloat(spend1) - parseFloat(spend0) - 0.01) < 0.006, `${c1} · ${spend0} → ${spend1}`);
  // Use in cut → side A plays it
  await page.click('#bTakes .take [data-act="use"]'); await sleep(400);
  const inCut = await page.evaluate(() => /in cut/.test(document.querySelector('#bTakes .take').innerText));
  check('8 Use in cut: the version on screen is in the cut', inCut);
  // ---- Ask for a change → v2 ----
  page.st.answers.push(sse(GOOD2, 0.02));
  await page.fill('#bTakes .take .cgask', 'warmer colours, slower');
  const askHint = await page.textContent('#bTakes .take .cg-ask .muted');
  check('Ask for a change: hint with v2 from v1, tokens and USD', /Makes v2 from v1: about [\d,]+ tokens, ≈ \d+\.\d\d USD/.test(askHint), askHint);
  await page.press('#bTakes .take .cgask', 'Enter');
  let v2; for (let i = 0; i < 600; i++) { v2 = await card(page); if (v2 && v2.vers.length === 2 && /^v2/.test(v2.cur || '') && /Use in cut|Play in cut/.test(v2.text)) break; await sleep(150); }
  if (!page.st.chat[1]) { console.log('DEBUG', errors, await page.textContent('#toast'), JSON.stringify(v2)); process.exit(1); }
  const b2 = JSON.parse(page.st.chat[1].body).messages[1].content;
  check('12 v2: the body has v1’s code and the words', b2.includes("ctx.fillStyle = '#1b3a6b'") && b2.includes('warmer colours, slower'), b2.slice(-200));
  check('12 one card lists both versions, v2 on screen', v2.vers.length === 2 && /^v2/.test(v2.cur || '') && /in cut/.test(v2.vers[1]), JSON.stringify(v2.vers));
  check('takes count: each version counts', await page.evaluate(() => /2 takes/.test(document.querySelectorAll('#bList .bitem')[1].innerText)));
  await shot(page, 'desktop-1440x900-4-done-versions');
  // pick v1 on screen, then delete v2 from it? no: pick v2, delete it, v1 stays
  await page.reload(); await page.waitForSelector('#projname'); await sleep(1500); await onSideB(page, 2);
  const re = await card(page);
  check('12 a reload keeps both versions and the cut', re && re.vers.length === 2 && re.vers.some(v => /in cut/.test(v)), JSON.stringify(re && re.vers));
  await page.click('#bTakes .take .cg-v >> nth=1'); await sleep(300);
  const v1on = await card(page);
  check('versions: picking v1 puts it on screen (orange row)', /^v1/.test(v1on.cur || ''), v1on.cur);
  await page.click('#bTakes .take .cg-v >> nth=0'); await sleep(300);
  await page.click('#bTakes .take [data-act="use"]'); await sleep(300);
  const v2cut = await card(page);
  check('12 Use in cut uses the version on screen (v2)', /in cut/.test(v2cut.vers[0]) && !/in cut/.test(v2cut.vers[1]), JSON.stringify(v2cut.vers));
  await page.click('#bTakes .take [data-act="del"]'); await page.click('#bTakes .take [data-act="del"]'); await sleep(400);
  const after = await card(page);
  check('12 Delete v2 keeps v1', after.vers.length === 1 && /^v1/.test(after.vers[0]), JSON.stringify(after.vers));
  // ---- a throw, Fix it ----
  await page.fill('#cgPrompt', 'A grid of squares.');
  page.st.answers.push(sse(THROWS, 0.03));
  await page.click('#cgGo');
  const er = await waitCard(page, /The code failed|Fix it/);
  check('4 a throw: message, line and frame on the card', /The code failed/.test(er.text) && /TypeError/.test(er.text) && /line 6/.test(er.text) && /frame 0 \(0\.0 s\)/.test(er.text), er.text.slice(0, 300));
  check('4 nothing recorded (no video on the card)', !(await page.evaluate(() => !!document.querySelector('#bTakes .take').querySelector('video'))));
  await shot(page, 'desktop-1440x900-5-error');
  page.st.answers.push(sse(GOOD, 0.01));
  const nChat = page.st.chat.length;
  await page.click('#bTakes .take [data-act="cgfix"]');
  for (let i = 0; i < 40 && page.st.chat.length === nChat; i++) await sleep(100);
  const fb = page.st.chat[nChat] ? JSON.parse(page.st.chat[nChat].body).messages[1].content : '';
  check('4 Fix it sends the code and the error', fb.includes('const p = pts[3];') && /TypeError/.test(fb) && /line 6/.test(fb), fb.slice(-300));
  await waitCard(page, /Use in cut|Play in cut|failed/i);
  // ---- an endless loop ----
  page.st.answers.push(sse(LOOP, 0.01));
  const tl0 = Date.now(); await page.click('#cgGo');
  const lp = await waitCard(page, /more than 1 s/, 20000);
  check('3 loop through the UI: the "more than 1 s" message, no video', /One frame took more than 1 s/.test(lp.text) && !(await page.evaluate(() => !!document.querySelector('#bTakes .take').querySelector('video'))), `${Date.now() - tl0} ms`);
  // ---- no code block ----
  page.st.answers.push(sse('', 0.01, 'I cannot do that.'));
  await page.click('#cgGo');
  const nc = await waitCard(page, /right form/, 15000);
  check('6 an answer with no code block: the right-form message', /The model did not return code in the right form\./.test(nc.text));
  // ---- Stop during the stream ----
  page.st.answers.push('hold');
  await page.click('#cgGo'); await waitCard(page, /Writing the code/, 5000); await sleep(400);
  await page.click('#bTakes .take [data-act="cgstop"]');
  const st = await waitCard(page, /Stopped/, 5000);
  check('13 Stop during the stream aborts the request and says so', (await page.evaluate(() => window.__aborted)) >= 1 && /OpenRouter can still bill the tokens written before the stop/.test(st.text), st.text.slice(0, 200));
  if (page.st.hold) page.st.hold.abort().catch(() => {});
  // ---- Show code is text ----
  await page.evaluate(() => { const b = [...document.querySelectorAll('#bTakes [data-act="cgcode"]')][0]; if (b) b.click(); }); await sleep(400);
  const sc = await page.evaluate(() => ({ open: document.getElementById('dlgCode').open, kids: document.getElementById('cgCode').children.length, t: document.getElementById('cgCode').textContent.slice(0, 20) }));
  check('Show code: plain text in a dialog', sc.open && sc.kids === 0 && /function animation/.test(sc.t), JSON.stringify(sc));
  await page.evaluate(() => document.getElementById('dlgCode').close());
  // ---- Settings: connected ----
  await page.click('#settingsb'); await sleep(300);
  await shot(page, 'desktop-1440x900-7-settings-connected');
  const conn = await page.evaluate(() => ({ on: !document.getElementById('orOn').hidden, key: document.getElementById('orKey').textContent, paste: document.getElementById('setKeyF').hidden, test: document.getElementById('setTest').textContent, link: document.getElementById('orLink').href }));
  const hx = createHash('sha256').update(KEY).digest('hex');
  check('Settings with a key: Connected, masked key, paste hidden, Test connection, deep link', conn.on && conn.key === 'key sk-or-v1-…a1f3' && conn.paste && conn.test === 'Test connection' && conn.link === 'https://openrouter.ai/keys/' + hx, JSON.stringify(conn));
  await page.click('#orDisc'); await sleep(200);
  const disc = await page.evaluate(() => ({ off: !document.getElementById('orOff').hidden, paste: !document.getElementById('setKeyF').hidden }));
  check('Disconnect: the key is gone, Connect and the paste field are back', disc.off && disc.paste);
  await shot(page, 'desktop-1440x900-6-settings-connect');
  // ---- OAuth: Connect ----
  await Promise.all([page.waitForURL(/openrouter\.ai\/auth/, { timeout: 8000 }).catch(() => {}), page.click('#orConnect')]);
  const au = new URL(page.st.auth || 'http://x/');
  await page.goBack(); await page.waitForSelector('#projname');
  const pk = await page.evaluate(() => sessionStorage.getItem('cueboard-or-pkce')).catch(() => null);
  const ver = pk && JSON.parse(pk);
  const s256 = ver && createHash('sha256').update(ver.verifier).digest('base64url');
  check('14 Connect goes to openrouter.ai/auth with callback = the page, no query', au.hostname === 'openrouter.ai' && au.searchParams.get('callback_url') === app && au.searchParams.get('code_challenge_method') === 'S256', page.st.auth);
  check('14 code_challenge = S256 of the stored verifier; state stored', ver && au.searchParams.get('code_challenge') === s256 && au.searchParams.get('state') === ver.state && /^Cue Board \(/.test(au.searchParams.get('key_label')), JSON.stringify(ver && { state: ver.state }));
  // the return: right code and state
  await page.goto(app + '?code=good-code-123&state=' + (ver && ver.state)); await page.waitForSelector('#projname'); await sleep(1200);
  const ex = page.st.keys[0] ? JSON.parse(page.st.keys[0]) : {};
  const loc = await page.evaluate(() => location.href);
  check('14 the return posts code, verifier and S256', ex.code === 'good-code-123' && ex.code_verifier === ver.verifier && ex.code_challenge_method === 'S256', JSON.stringify(ex));
  check('14 no code left in the address', !/code=|state=/.test(loc), loc);
  await page.evaluate(() => { document.getElementById('dlgSettings').close(); document.getElementById('settingsb').click(); }); await sleep(300);
  check('14 the key is stored and Settings says Connected', await page.evaluate(() => !document.getElementById('orOn').hidden && /beef$/.test(document.getElementById('orKey').textContent)));
  await page.evaluate(() => document.getElementById('orDisc').click());
  // failures
  const back = async (q, keyAnswer) => { page.st.keyAnswer = keyAnswer; const n = page.st.keys.length;
    await page.evaluate(() => sessionStorage.setItem('cueboard-or-pkce', JSON.stringify({ verifier: 'v'.repeat(86), state: 'right', created: Date.now() })));
    await page.goto(app + q); await page.waitForSelector('#projname'); await sleep(1200);
    return { sent: page.st.keys.length - n, msg: await page.evaluate(() => document.getElementById('dlgSettings').open ? document.getElementById('setMsg').textContent : ''), paste: await page.evaluate(() => !document.getElementById('setKeyF').hidden && !document.getElementById('setKey').disabled) }; };
  const w = await back('?code=c1&state=wrong');
  check('15 a wrong state sends no exchange and says so; paste works', w.sent === 0 && /did not match/.test(w.msg) && w.paste, JSON.stringify(w));
  const f403 = await back('?code=c2&state=right', { status: 403, body: { error: { message: 'Invalid code' } } });
  check('15 a 403 shows its message; paste works', f403.sent === 1 && /refused the sign-in/.test(f403.msg) && f403.paste, JSON.stringify(f403));
  const fnet = await back('?code=c3&state=right', 'net');
  check('15 a network error shows its message; paste works', fnet.sent === 1 && /Could not reach OpenRouter/.test(fnet.msg) && fnet.paste, JSON.stringify(fnet));
  check('19 openrouter.ai only on generate, test or connect', page.st.ext.every(u => /openrouter\.ai\/(api\/v1\/(chat\/completions|auth\/keys|videos\/models|credits)|auth\?)/.test(u)), page.st.ext.filter(u => !/openrouter/.test(u)).join(' '));
  await page.ctx.close();
}
// ================= fallbacks =================
{
  const page = await newPage('rt', { init: () => { delete window.VideoEncoder; } });
  await openExample(page); await setKey(page); await onSideB(page, 2);
  await page.click('[data-mk="code"]'); await page.fill('#cgPrompt', 'Dots.');
  page.st.answers.push(sse(GOOD, 0.01)); await page.click('#cgGo');
  const c = await waitCard(page, /Use in cut|Play in cut|failed/i, 120000);
  const ok = await page.evaluate(async () => { const v = document.querySelector('#bTakes .take video'); if (!v) return 0; await new Promise(r => { if (v.readyState >= 1) r(); else v.onloadedmetadata = r; setTimeout(r, 4000); }); return v.duration; });
  check('9 without VideoEncoder: a playable file and "Records in real time"', ok > 1 && /Records in real time/.test(c.text), `${ok} s · ${c.text.slice(0, 160)}`);
  await page.ctx.close();
  const p2 = await newPage('nooc', { init: () => { delete window.OffscreenCanvas; } });
  await openExample(p2); await onSideB(p2, 2);
  const off = await p2.evaluate(() => ({ dis: document.getElementById('cgTab').disabled, title: document.getElementById('cgTab').title }));
  check('9 without OffscreenCanvas: the Code tab is disabled with its hint', off.dis && /cannot run code takes safely/.test(off.title), JSON.stringify(off));
  await p2.ctx.close();
}
// ================= phone =================
for (const vp of [{ width: 390, height: 844 }, { width: 390, height: 667 }]) {
  const tag = `phone-${vp.width}x${vp.height}`, page = await newPage(tag, { phone: vp });
  await openExample(page); await setKey(page); await onSideB(page, 2);
  const ent = await page.evaluate(() => { const b = document.getElementById('cgMGo').getBoundingClientRect(), t = document.getElementById('bTakes').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, vis: b.height > 0, takes: t.top, ih: innerHeight }; });
  check(`18 ${tag}: the entry is on screen above the takes, 44 px tall`, ent.vis && ent.bottom <= ent.ih && ent.top < ent.takes && ent.h >= 44, JSON.stringify(ent));
  if (vp.height === 844) await shot(page, `${tag}-1-b-side-code`);
  await page.click('#cgMGo'); await sleep(1200);
  const sh = await page.evaluate(() => { const d = document.getElementById('cgSheet'), small = [...d.querySelectorAll('button,select,textarea,input:not([type=checkbox]),.chk,.chip')].filter(e => e.getClientRects().length && e.getBoundingClientRect().height < 44 && !e.closest('.chips')).map(e => e.id || e.textContent.trim().slice(0, 20));
    return { open: d.open, hscroll: d.scrollWidth > d.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth, small, font: getComputedStyle(document.getElementById('cgPrompt')).fontSize }; });
  check(`18 ${tag}: the sheet opens, no horizontal scroll, targets 44 px, 16 px text`, sh.open && !sh.hscroll && sh.small.length === 0 && sh.font === '16px', JSON.stringify(sh));
  if (vp.height === 844) await shot(page, `${tag}-2-code-sheet`);
  await page.fill('#cgPrompt', 'Gold dots circle a deep blue night and pulse on each beat.');
  page.st.answers.push(sse(GOOD, 0.0123)); await page.click('#cgGo');
  const pr = await waitCard(page, /Recording[\s\S]*\d+ \/ \d+/, 20000);
  const closed = await page.evaluate(() => !document.getElementById('cgSheet').open);
  check(`18 ${tag}: the sheet closes on Generate, the card shows its steps`, closed && !!pr);
  if (vp.height === 844) { await sleep(500); await shot(page, `${tag}-3-progress`); }
  const dn = await waitCard(page, /Use in cut|Play in cut|failed/i);
  const ph = await page.evaluate(() => { const c = document.querySelector('#bTakes .take'), i = c.querySelector('.cgask');
    const small = [...c.querySelectorAll('button,input')].filter(e => e.getClientRects().length && e.getBoundingClientRect().height < 44).map(e => e.textContent.trim() || e.className);
    return { font: i && getComputedStyle(i).fontSize, small, over: document.documentElement.scrollWidth > innerWidth }; });
  check(`18 ${tag}: the done card: 16 px input, 44 px targets, no overflow`, /Use in cut|Play in cut/.test(dn.text) && ph.font === '16px' && ph.small.length === 0 && !ph.over, JSON.stringify(ph));
  if (vp.height === 844) {
    await page.evaluate(() => { const sb = document.getElementById('sideB'), c = document.querySelector('#bTakes .take'); sb.scrollTop += c.getBoundingClientRect().top - sb.getBoundingClientRect().top - 12; }); await sleep(300);
    await shot(page, `${tag}-4-done-versions`);
    page.st.answers.push(sse(THROWS, 0.03)); await page.click('#cgMGo'); await sleep(500); await page.click('#cgGo');
    await waitCard(page, /The code failed/, 20000); await sleep(300);
    await page.evaluate(() => { const sb = document.getElementById('sideB'), c = document.querySelector('#bTakes .take'); sb.scrollTop += c.getBoundingClientRect().top - sb.getBoundingClientRect().top - 12; }); await sleep(300);
    await shot(page, `${tag}-5-error`);
    await page.evaluate(() => document.getElementById('settingsb') && document.getElementById('settingsb').click()); await sleep(400);
    await page.evaluate(() => { if (!document.getElementById('dlgSettings').open) { const b = [...document.querySelectorAll('button')].find(b => /Settings/.test(b.textContent) && b.getClientRects().length); if (b) b.click(); } }); await sleep(400);
    await shot(page, `${tag}-7-settings-connected`);
    await page.evaluate(() => document.getElementById('orDisc').click()); await sleep(200);
    await shot(page, `${tag}-6-settings-connect`);
  }
  await page.ctx.close();
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
