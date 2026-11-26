// A take in the cut can leave the cut again, and video models get "don't rewrite my prompt" only where OpenRouter allows it.
//   node design/take-out-check.mjs <repo-root> <out-dir>
// Desktop Chromium, every request outside the local server aborted. Screenshot: <out-dir>/take-out-*.png
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.TESTKIT || '/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    let body = readFileSync(p);
    // test-only hook: the app's functions live in its script scope, so the served copy exposes a few of them
    if (p.endsWith('index.html')) body = String(body).replace('window.cueEDL=', 'window.__t={get S(){return S},get setSide(){return setSide},get select(){return select},get literalPrompt(){return literalPrompt},get modelById(){return modelById}};window.cueEDL=');
    r.end(body); }
  catch { r.writeHead(404); r.end(); }
});
let port = 3380;
for (;; port++) {
  if (port > 3399) throw new Error('no free port');
  const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });
  if (ok) break;
}
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
const page = await ctx.newPage(), errs = [];
page.on('pageerror', e => { errs.push(String(e)); console.log('PAGEERR', String(e)); });
await page.goto(origin + '/index.html');
await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });

const img = await page.evaluate(() => { const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; const g = cv.getContext('2d'); g.fillStyle = '#c86b3c'; g.fillRect(0, 0, 320, 180); return cv.toDataURL('image/png'); });
const take = (id, media) => ({ id, jobId: 'j' + id, model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 5, audio: false, seed: '', prompt: 'slow push in', start: true, end: false, est: 0.25, cost: 0.25, status: 'completed', created: 1, media, error: '', note: '' });
const sections = [
  { id: 'a', start: 0, title: 'With keyframe', shot: 'Wide shot', notes: '', img: 'm0', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: '', takes: [take('t1', 'v1')] },
  { id: 'b', start: 6, title: 'No keyframe', shot: 'Wide shot', notes: '', img: '', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: '', takes: [take('t2', 'v2')] },
  { id: 'c', start: 12, title: 'Delete in cut', shot: 'Wide shot', notes: '', img: 'm0', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: '', takes: [take('t3', 'v3')] },
];
const vid = n => ({ type: 'video/webm', data: 'data:video/webm;base64,' + Buffer.from('GkXf' + n).toString('base64') });
const data = { format: 'cueboard', version: 1, project: { id: 'p-out', title: 'Out of cut', created: 1, updated: 1, song: null, refs: [], sections }, media: { m0: { type: 'image/png', data: img }, v1: vid(1), v2: vid(2), v3: vid(3) } };
await page.setInputFiles('#importf', { name: 'out.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
await page.waitForFunction(() => /Out of cut/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });

const shot = i => page.evaluate(i => { const s = __t.S()[i]; return { img: s.img, kind: s.kind, key: s.key || '', imgCrop: s.imgCrop || null }; }, i);
const card = () => '#bTakes .take';   // one take per shot; ids are remapped on import
async function open(i) { await page.evaluate(() => __t.setSide('b')); await page.waitForTimeout(200); await page.click(`#bList .bitem:nth-child(${i + 1})`); await page.waitForTimeout(400); }

// shot 1: image -> use take -> remove from cut -> back to the same image
await open(0);
const before = await shot(0);
await page.click(card('t1') + ' [data-act="use"]'); await page.waitForTimeout(300);
const inCut = await shot(0);
check('use in cut puts the take in the shot', inCut.kind === 'video' && inCut.key === before.img, JSON.stringify(inCut));
check('the card offers Remove from cut', await page.isVisible(card('t1') + ' [data-act="out"]'));
await page.screenshot({ path: join(out, 'take-out-incut.png'), clip: await page.locator(card('t1')).boundingBox() });
await page.click(card('t1') + ' [data-act="out"]'); await page.waitForTimeout(300);
const after = await shot(0);
check('remove from cut brings the keyframe back', after.img === before.img && after.kind === '', JSON.stringify(after));
check('the take stays in the list', await page.isVisible(card('t1')));
check('the card offers Use in cut again', await page.isVisible(card('t1') + ' [data-act="use"]'));
await page.screenshot({ path: join(out, 'take-out-after.png'), clip: await page.locator(card('t1')).boundingBox() });
// undo puts the take back in the cut
await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
check('undo puts the take back in the cut', (await shot(0)).kind === 'video');

// shot 2: no picture at all -> use -> remove -> empty slate again
await open(1);
await page.click(card('t2') + ' [data-act="use"]'); await page.waitForTimeout(300);
await page.click(card('t2') + ' [data-act="out"]'); await page.waitForTimeout(300);
const b2 = await shot(1);
check('a shot with no keyframe goes back to its slate', b2.img === '' && b2.kind === '', JSON.stringify(b2));

// shot 3: deleting the take that is in the cut keeps the keyframe (it used to blank the shot)
await open(2);
const img3 = (await shot(2)).img;
await page.click(card('t3') + ' [data-act="use"]'); await page.waitForTimeout(300);
await page.click(card('t3') + ' [data-act="del"]'); await page.click(card('t3') + ' [data-act="del"]'); await page.waitForTimeout(300);
const c3 = await shot(2);
check('deleting the take in the cut keeps the keyframe', c3.img === img3 && !!img3 && c3.kind === '', JSON.stringify(c3));

// a new image on side A becomes side B's start frame, even when an older start frame was set (or turned off)
const png = async c => Buffer.from((await page.evaluate(c => { const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 320, 180); return cv.toDataURL('image/png'); }, c)).split(',')[1], 'base64');
async function sideAImage(i, color) {
  await page.evaluate(i => { __t.setSide('a'); __t.select(__t.S()[i].id, true); }, i); await page.waitForTimeout(300);
  const prev = (await shot(i)).img;
  await page.setInputFiles('#f-img', { name: color.slice(1) + '.png', mimeType: 'image/png', buffer: await png(color) });
  await page.waitForFunction(([i, prev]) => __t.S()[i].img && __t.S()[i].img !== prev, [i, prev], { timeout: 10000 });
}
const startOf = i => page.evaluate(i => { const s = __t.S()[i]; return { img: s.img, key: s.key || '', keyOff: !!s.keyOff }; }, i);
// shot 1 still has the take in the cut (undo above) and its old image copied as start frame
check('before: shot 1 has an older start frame', !!(await startOf(0)).key);
await sideAImage(0, '#3c7ac8');
let k1 = await startOf(0);
check('new side A image: start frame follows it', k1.key === '' && !k1.keyOff, JSON.stringify(k1));
await open(0);
check('side B shows it as the start frame, "from side A"', /from side A/.test(await page.textContent('#fStartNote')));
// a start frame turned off with "Don't use": a new side A image brings it back
await page.click('#fStartClr'); await page.waitForTimeout(200);
check('start frame turned off', (await startOf(0)).keyOff);
await sideAImage(0, '#5aa05a');
k1 = await startOf(0);
check('new side A image after "Don\'t use": start frame is back', k1.key === '' && !k1.keyOff, JSON.stringify(k1));
await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
check('undo brings the previous state back', (await startOf(0)).keyOff);

// prompt rewrite switches
const lit = await page.evaluate(() => ({
  wanNow: __t.literalPrompt({ id: 'alibaba/wan-3.0', pass: [] }),
  wanLater: __t.literalPrompt({ id: 'alibaba/wan-3.0', pass: ['negative_prompt', 'prompt_extend'] }),
  veo: __t.literalPrompt({ id: 'google/veo-3.1', pass: ['personGeneration', 'enhancePrompt'] }),
  hailuo: __t.literalPrompt({ id: 'minimax/hailuo-2.3', pass: ['prompt_optimizer', 'fast_pretreatment'] }),
  seed: __t.literalPrompt({ id: 'bytedance/seedance-2.5', pass: ['watermark'] }),
  builtin: __t.literalPrompt(__t.modelById('alibaba/wan-3.0')),
}));
check('Wan without the switch in the catalog: nothing sent', lit.wanNow === null && lit.builtin === null);
check('Wan with prompt_extend listed: alibaba.prompt_extend=false', JSON.stringify(lit.wanLater) === '{"alibaba":{"prompt_extend":false}}', JSON.stringify(lit.wanLater));
check('Veo: google-vertex.parameters.enhancePrompt=false', JSON.stringify(lit.veo) === '{"google-vertex":{"parameters":{"enhancePrompt":false}}}', JSON.stringify(lit.veo));
check('Hailuo 2.3: minimax.prompt_optimizer=false', JSON.stringify(lit.hailuo) === '{"minimax":{"prompt_optimizer":false}}', JSON.stringify(lit.hailuo));
check('Seedance (no rewrite switch): nothing sent', lit.seed === null);
check('no page errors', errs.length === 0, errs.join(' | '));

await browser.close(); srv.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
