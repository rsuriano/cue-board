// fal.ai as a second video provider (docs/specs/fal-provider.md): one check per acceptance criterion, plus the
// hostile-review risks. OpenRouter and fal are mocked with page.route; no real key, no real network.
//   node design/fal-check.mjs <repo-root> <out-dir>
// Criterion 1 compares the OpenRouter request against `git show main:index.html` served as /base.html.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.TESTKIT || '/home/talos/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const HOOK = 'window.__t={get S(){return S},get setSide(){return setSide},get select(){return select},get pollOnce(){return pollOnce},get polling(){return !!pollTimer},get modelById(){return modelById}};window.cueEDL=';
let base = '';
try { base = execFileSync('git', ['-C', root, 'show', 'main:index.html'], { encoding: 'utf8', maxBuffer: 64e6 }); } catch {}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/base.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(base.replace('window.cueEDL=', HOOK)); }
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('window.cueEDL=', HOOK);
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
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };

const FAL_KEY = 'falkey-0123456789abcdef:secretpart', OR_KEY = 'sk-or-v1-testkey0000';
const VIDEO = readFileSync(join(root, 'example/media/take-03-a.mp4'));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS' };
// mock state, shared by every context
const reqs = [];            // every non-local request: {url, method, auth, body}
let falStatus = 'IN_QUEUE', falStatusErr = null, falSubmitErr = null, falResultCode = 200;
async function route(r) {
  const q = r.request(), u = q.url();
  if (u.startsWith(origin)) return r.continue();
  if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
  const h = await q.allHeaders();
  const rec = { url: u, method: q.method(), auth: h.authorization || '', body: q.postData() || '' };
  reqs.push(rec);
  const json = (status, o) => r.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(o) });
  if (/^https:\/\/openrouter\.ai\/api\/v1\/videos$/.test(u) && q.method() === 'POST') return json(200, { id: 'or-job-1', status: 'pending' });
  if (u.startsWith('https://queue.fal.run/')) {
    const path = u.slice('https://queue.fal.run/'.length);
    if (q.method() === 'POST') { if (falSubmitErr) return json(falSubmitErr[0], falSubmitErr[1]);
      const id = 'req-' + reqs.filter(x => x.method === 'POST' && x.url.startsWith('https://queue.fal.run/')).length;
      const app = path.split('/').slice(0, 2).join('/');
      return json(200, { request_id: id, status_url: `https://queue.fal.run/${app}/requests/${id}/status`, response_url: `https://queue.fal.run/${app}/requests/${id}`, queue_position: 0 }); }
    if (/\/requests\/[\w-]+\/status$/.test(path)) return json(200, { status: falStatus, request_id: 'x', ...(falStatus === 'COMPLETED' && falStatusErr ? { error: falStatusErr, error_type: 'runner_failed' } : {}) });
    if (/\/requests\/[\w-]+$/.test(path)) return falResultCode === 200 ? json(200, { video: { url: 'https://v3.fal.media/files/test/take.mp4', content_type: 'video/mp4' }, seed: 7 }) : json(falResultCode, { detail: 'Result gone' });
  }
  if (u === 'https://v3.fal.media/files/test/take.mp4') return r.fulfill({ status: 200, contentType: 'video/mp4', headers: CORS, body: VIDEO });
  return r.abort();
}

const errs = [];
async function newPage(path = '/index.html') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.route('**/*', route);
  const page = await ctx.newPage();
  page.on('pageerror', e => { errs.push(String(e)); console.log('PAGEERR', String(e)); });
  await page.goto(origin + path);
  await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
  return { ctx, page };
}
const img = 'data:image/png;base64,' + Buffer.from(execFileSync('node', ['-e', `
  const {deflateSync}=require('zlib');const w=64,h=36,raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=y*(w*3+1)+1+x*3;raw[o]=200;raw[o+1]=107;raw[o+2]=60}
  const crc=b=>{let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}c=0xffffffff;for(const x of b)c=t[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0};
  const ch=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])};
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
  process.stdout.write(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch('IHDR',ih),ch('IDAT',deflateSync(raw)),ch('IEND',Buffer.alloc(0))]).toString('base64'))`]).toString(), 'base64').toString('base64');
const project = (extra = {}) => ({ format: 'cueboard', version: 1, project: { id: 'p-fal', title: 'Fal test', created: 1, updated: 1, song: null, refs: [], sections: [
  { id: 'a', start: 0, title: 'One', shot: 'Wide shot', notes: '', img: 'm0', kind: '', key: '', endKey: 'm1', imgPrompt: '', vidPrompt: 'slow push in', negPrompt: 'blurry text', takes: extra.takes || [] },
  { id: 'b', start: 6, title: 'Two', shot: 'Wide shot', notes: '', img: 'm0', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: 'pan left', takes: [] }] },
  media: { m0: { type: 'image/png', data: img }, m1: { type: 'image/png', data: img } } });
async function load(page, data = project()) {
  await page.setInputFiles('#importf', { name: 'fal.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForFunction(() => /Fal test/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
  await page.evaluate(() => __t.setSide('b')); await page.waitForTimeout(300);
}
async function setKeys(page, { or, fal }) {
  await page.click('#settingsb'); await page.waitForTimeout(150);
  if (or != null) await page.evaluate(k => { const f = document.getElementById('setKey'); if (f.closest('[hidden]')) return; f.value = k; }, or);
  if (fal != null) await page.fill('#setFal', fal);
  await page.click('#setForm button[type=submit]'); await page.waitForTimeout(300);
}
const pick = (page, id) => page.evaluate(id => { const s = document.getElementById('gModel'); s.value = id; s.dispatchEvent(new Event('change', { bubbles: true })); }, id);
const opts = page => page.evaluate(() => [...document.getElementById('gModel').options].map(o => [o.value, o.textContent]));
const orPosts = () => reqs.filter(x => x.method === 'POST' && x.url === 'https://openrouter.ai/api/v1/videos');
const falPosts = () => reqs.filter(x => x.method === 'POST' && x.url.startsWith('https://queue.fal.run/'));
const takes = (page, i = 0) => page.evaluate(i => __t.S()[i].takes.map(t => ({ ...t })), i);
async function genTake(page, model) { await pick(page, model); await page.waitForTimeout(150); await page.click('#gGo'); await page.waitForTimeout(700); }

// ---------- 1. no fal key: same model list and same OpenRouter body as main ----------
async function orRun(path, fal) {
  const { ctx, page } = await newPage(path);
  await load(page); await setKeys(page, { or: OR_KEY, fal });
  const list = await opts(page);
  const n = orPosts().length;
  await genTake(page, 'alibaba/wan-3.0');
  const p = orPosts()[n];
  await ctx.close();
  return { list, body: p ? JSON.parse(p.body) : null, auth: p && p.auth };
}
if (!base) check('main:index.html available for the baseline', false);
const before = await orRun('/base.html');
const now = await orRun('/index.html');
check('1. no fal key: same model list as main', JSON.stringify(before.list) === JSON.stringify(now.list), JSON.stringify(now.list.map(x => x[1])));
check('1. no fal key: same OpenRouter body for a Wan take as main', !!before.body && JSON.stringify(before.body) === JSON.stringify(now.body), JSON.stringify(now.body && { ...now.body, frame_images: (now.body.frame_images || []).length }));
const withFal = await orRun('/index.html', FAL_KEY);
check('risk: with a fal key set, an OpenRouter Wan take still goes to OpenRouter with the same body', !!withFal.body && JSON.stringify(withFal.body) === JSON.stringify(before.body));
check('risk: the OpenRouter request carries the OpenRouter key, never the fal key', withFal.auth === 'Bearer ' + OR_KEY && !withFal.auth.includes(FAL_KEY));

// ---------- 2. settings: fal key adds and removes the fal models ----------
const { ctx, page } = await newPage();
await load(page);
await setKeys(page, { or: OR_KEY });
check('2. Settings has a fal key field', await page.evaluate(() => { const f = document.getElementById('setFal'); return !!f && f.type === 'password' && /fal\.ai/i.test(document.querySelector('label[for=setFal]').textContent); }));
await setKeys(page, { fal: FAL_KEY });
let list = await opts(page);
const falOpts = list.filter(x => x[0].startsWith('fal:'));
check('2. saving a fal key adds the fal models, labelled with the provider', falOpts.length >= 2 && falOpts.every(x => / · fal$/.test(x[1])), JSON.stringify(falOpts.map(x => x[1])));
check('2. the OpenRouter models are still there, first', list[0][0] === 'alibaba/wan-3.0' && list.filter(x => !x[0].startsWith('fal:')).length === now.list.length);
await page.screenshot({ path: join(out, 'fal-picker.png'), clip: await page.locator('.genfoot').first().boundingBox().catch(() => null) || undefined });
await setKeys(page, { fal: '' });
list = await opts(page);
check('2. clearing the key removes them', !list.some(x => x[0].startsWith('fal:')) && JSON.stringify(list) === JSON.stringify(now.list));
await setKeys(page, { fal: FAL_KEY });

// ---------- 3. a fal take: queue submit, key in the header, model fields ----------
const W25 = 'fal:fal-ai/wan-25-preview/image-to-video', W30 = 'fal:alibaba/wan-3.0/image-to-video', H3 = 'fal:minimax/h3-max/image-to-video';
await pick(page, W25); await page.waitForTimeout(150);
check('3. Wan 2.5 · fal shows the Avoid field', await page.isVisible('#gNegWrap'));
let n0 = falPosts().length;
await page.click('#gGo'); await page.waitForTimeout(800);
let fp = falPosts()[n0], fb = fp ? JSON.parse(fp.body) : {};
check('3. submits to fal\'s queue for the model', !!fp && fp.url === 'https://queue.fal.run/fal-ai/wan-25-preview/image-to-video', fp && fp.url);
check('3. key in the Authorization header, not in the URL', !!fp && fp.auth === 'Key ' + FAL_KEY && !fp.url.includes(FAL_KEY) && !fp.url.includes('falkey'));
check('3. the prompt, duration and resolution the model accepts', fb.prompt === 'slow push in' && fb.duration === '10' && fb.resolution === '480p', JSON.stringify({ ...fb, image_url: undefined }));
check('3. the start frame as a data URI', typeof fb.image_url === 'string' && fb.image_url.startsWith('data:image/'));
check('3. Wan: prompt expansion off and the Avoid text as negative_prompt', fb.enable_prompt_expansion === false && fb.negative_prompt === 'blurry text');
check('3. Wan 2.5 takes no end frame: none sent', !('end_image_url' in fb) && !('last_frame' in fb));
n0 = falPosts().length;
await genTake(page, W30);
fp = falPosts()[n0]; fb = fp ? JSON.parse(fp.body) : {};
check('3. Wan 3.0 · fal: start and end frame, integer duration, expansion off', !!fp && fp.url === 'https://queue.fal.run/alibaba/wan-3.0/image-to-video' && fb.start_image_url?.startsWith('data:image/') && fb.end_image_url?.startsWith('data:image/') && fb.duration === 6 && fb.enable_prompt_expansion === false && fb.audio === false && !('negative_prompt' in fb), JSON.stringify({ ...fb, start_image_url: !!fb.start_image_url, end_image_url: !!fb.end_image_url }));
n0 = falPosts().length;
await genTake(page, H3);
fp = falPosts()[n0]; fb = fp ? JSON.parse(fp.body) : {};
check('3. H3 Max · fal: resolution in fal\'s spelling, prompt expansion disabled', !!fp && fb.resolution === '480P' && fb.prompt_expansion_mode === 'disabled' && fb.duration === 6 && fb.image_url?.startsWith('data:image/'), JSON.stringify({ ...fb, image_url: !!fb.image_url, end_image_url: !!fb.end_image_url }));
let tk = await takes(page);
check('3. the takes record their provider and fal request id', tk.length === 3 && tk.every(t => t.prov === 'fal' && /^req-\d+$/.test(t.jobId) && t.status === 'pending'), JSON.stringify(tk.map(t => [t.prov, t.jobId, t.status, t.error])));
check('3. the estimate uses fal\'s price (Wan 3.0, 480p, 6 s = 0.30)', tk.some(t => t.model === W30 && Math.abs(t.est - 0.3) < 1e-9));

// ---------- 4. polling to done; Use in cut, Download ----------
falStatus = 'IN_PROGRESS';
await page.evaluate(() => __t.pollOnce()); await page.waitForTimeout(300);
tk = await takes(page);
check('4. status IN_PROGRESS shows as rendering', tk.every(t => t.status === 'in_progress'), tk.map(t => t.status).join());
falStatus = 'COMPLETED';
await page.evaluate(() => __t.pollOnce());
await page.waitForFunction(() => __t.S()[0].takes.every(t => t.status === 'completed'), null, { timeout: 15000 }).catch(() => {});
tk = await takes(page);
check('4. COMPLETED: the result is fetched and the video stored', tk.every(t => t.status === 'completed' && t.media), tk.map(t => t.status + ':' + t.error + t.note).join());
check('4. the card shows the video', await page.locator('#bTakes .take video').count() === 3);
const resGets = reqs.filter(x => x.method === 'GET' && /queue\.fal\.run\/.+\/requests\/req-\d+$/.test(x.url));
check('4. status and result URLs use owner/app only', resGets.length >= 3 && reqs.filter(x => x.url.includes('/requests/')).every(x => /^https:\/\/queue\.fal\.run\/(fal-ai\/wan-25-preview|alibaba\/wan-3\.0|minimax\/h3-max)\/requests\/req-\d+(\/status)?$/.test(x.url)), resGets.map(x => x.url).join(' '));
await page.click('#bTakes .take:first-child [data-act="use"]'); await page.waitForTimeout(300);
check('4. Use in cut works on a fal take', await page.evaluate(() => { const s = __t.S()[0]; return s.kind === 'video' && s.img === s.takes[0].media; }));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#bTakes .take:first-child [data-act="dl"]')]);
check('4. Download works on a fal take', !!dl && /-fal-\w{4}\.mp4$/.test(dl.suggestedFilename()), dl && dl.suggestedFilename());
await page.waitForTimeout(500);
check('risk: polling stops once every fal job is done', await page.evaluate(async () => { await __t.pollOnce(); return !__t.polling; }));
await page.screenshot({ path: join(out, 'fal-takes.png'), fullPage: false });

// ---------- 6. fal errors on the card; Retry goes back to fal ----------
falSubmitErr = [422, { detail: [{ loc: ['body', 'image_url'], msg: 'Image is too large', type: 'image_too_large' }] }];
await genTake(page, W25);
tk = await takes(page);
check('6. a 4xx on submit shows fal\'s message on the take', tk[0].status === 'failed' && /Image is too large/.test(tk[0].error), tk[0].error);
check('6. the card shows it', /Image is too large/.test(await page.textContent('#bTakes .take:first-child')));
falSubmitErr = null; n0 = falPosts().length;
await page.click('#bTakes .take:first-child [data-act="retry"]'); await page.waitForTimeout(800);
tk = await takes(page);
check('4. Retry on a fal take submits to fal again', falPosts().length === n0 + 1 && falPosts()[n0].url.endsWith('/fal-ai/wan-25-preview/image-to-video') && tk[0].prov === 'fal' && tk[0].status === 'pending');
falStatus = 'COMPLETED'; falStatusErr = 'The model could not render this prompt';
await page.evaluate(() => __t.pollOnce()); await page.waitForTimeout(500);
tk = await takes(page);
check('6. a failed job (COMPLETED with error) shows the error', tk[0].status === 'failed' && /could not render/.test(tk[0].error), tk[0].status + ' ' + tk[0].error);
falStatusErr = null;
check('6. the app still works after the errors', await page.isVisible('#gGo') && await page.isEnabled('#gGo'));

// ---------- 7. the fal key never leaves settings ----------
await page.click('#exportb'); await page.waitForTimeout(150);
const [ex] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('#expGo')]);
const exTxt = ex ? readFileSync(await ex.path(), 'utf8') : '';
check('7. not in an exported project', exTxt.length > 100 && !exTxt.includes(FAL_KEY) && !exTxt.includes('secretpart'));
const store = await page.evaluate(async key => {
  const ls = Object.keys(localStorage).filter(k => (localStorage.getItem(k) || '').includes(key));
  const db = await new Promise(r => { const q = indexedDB.open('cueboard-local'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
  const names = db ? [...db.objectStoreNames] : [], hits = [];
  for (const n of names) { const all = await new Promise(r => { const t = db.transaction(n).objectStore(n), keys = t.getAllKeys(), vals = t.getAll(); vals.onsuccess = () => r(keys.result.map((k, i) => [k, vals.result[i]])); vals.onerror = () => r([]); });
    for (const [k, v] of all) { let s = ''; try { s = typeof v === 'string' ? v : JSON.stringify(v) || ''; } catch {} if (s.includes(key)) hits.push(n + ':' + k); } }
  return { ls, hits, names };
}, FAL_KEY);
check('7. not in localStorage; only under the settings key "falKey"', store.ls.length === 0 && JSON.stringify(store.hits) === '["settings:falKey"]', JSON.stringify(store));
check('7. never in any request URL', reqs.every(x => !x.url.includes(FAL_KEY) && !x.url.includes('secretpart')));
check('risk: the fal key goes only to queue.fal.run', reqs.filter(x => x.auth.includes(FAL_KEY)).every(x => x.url.startsWith('https://queue.fal.run/')) && reqs.filter(x => x.url.includes('fal.media')).every(x => !x.auth));
check('risk: no fal request carries the OpenRouter key', reqs.filter(x => x.url.includes('fal.')).every(x => !x.auth.includes(OR_KEY)));

// ---------- 5. a fal job in progress survives a reload ----------
falStatus = 'IN_PROGRESS';
await genTake(page, W30);
const jid = (await takes(page))[0].jobId;
await page.evaluate(() => __t.pollOnce()); await page.waitForTimeout(400);
check('5. before reload: in progress', (await takes(page))[0].status === 'in_progress');
await page.waitForTimeout(1200);   // the save debounce
await page.reload();
await page.waitForFunction(() => /Fal test/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
falStatus = 'COMPLETED';
await page.waitForFunction(id => __t.S()[0].takes.some(t => t.jobId === id && t.status === 'completed'), jid, { timeout: 20000 }).catch(() => {});
const after = (await takes(page)).find(t => t.jobId === jid);
check('5. after reload, polling resumes and the take finishes', !!after && after.status === 'completed' && !!after.media, after && after.status + ' ' + after.error + after.note);

// ---------- risks: a hostile or stale take can't steer the key or poll forever ----------
const hostile = project({ takes: [
  { id: 'h1', jobId: '../../evil.example/x', prov: 'fal', model: W30, modelName: 'Wan 3.0 · fal', res: '480p', dur: 5, prompt: 'x', status: 'pending', created: Date.now(), media: '', error: '', note: '' },
  { id: 'h2', jobId: 'req-ok', prov: 'fal', model: 'fal:evil.example/x', modelName: 'X', res: '480p', dur: 5, prompt: 'x', status: 'pending', created: Date.now(), media: '', error: '', note: '' },
  { id: 'h3', jobId: 'req-old', prov: 'fal', model: W30, modelName: 'Wan 3.0 · fal', res: '480p', dur: 5, prompt: 'x', status: 'pending', created: Date.now() - 4 * 3600e3, media: '', error: '', note: '' },
  { id: 'h4', jobId: '', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 6, audio: false, seed: '', prompt: 'or retry', status: 'failed', created: Date.now(), media: '', error: 'HTTP 500', note: '' }] });
hostile.project.id = 'p-hostile';
const r0 = reqs.length;
await load(page, hostile);
falStatus = 'IN_QUEUE';
await page.evaluate(() => __t.pollOnce()); await page.waitForTimeout(600);
tk = await takes(page);
const late = reqs.slice(r0);
check('risk: a take with a bad request id or a model not on the list fails, no request', tk.filter(t => t.jobId !== 'req-old').every(t => t.status === 'failed') && late.every(x => !x.url.includes('evil')), JSON.stringify(tk.map(t => [t.jobId, t.status, t.error])));
check('risk: a fal job older than 3 hours stops polling and says so', tk.find(t => t.jobId === 'req-old').status === 'failed' && /3 hours/.test(tk.find(t => t.jobId === 'req-old').error));
check('risk: then polling stops', await page.evaluate(async () => { await __t.pollOnce(); return !__t.polling; }));
const o0 = orPosts().length, f0 = falPosts().length;
await page.click('#bTakes .take:last-child [data-act="retry"]'); await page.waitForTimeout(800);
const orRetry = orPosts()[o0];
check('risk: Retry on an OpenRouter take (fal key set) goes to OpenRouter, not fal', !!orRetry && JSON.parse(orRetry.body).model === 'alibaba/wan-3.0' && JSON.parse(orRetry.body).prompt === 'or retry' && falPosts().length === f0 && !(await takes(page)).find(t => t.prompt === 'or retry').prov);
check('7. never in any request URL (whole run)', reqs.every(x => !x.url.includes(FAL_KEY) && !x.url.includes('secretpart')));

check('no page errors', errs.length === 0, errs.join(' | '));
await ctx.close(); await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
