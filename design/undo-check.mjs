// Undo and redo in the browser: the keys on the desktop (Ctrl and ⌘ variants, native field undo untouched, the Delete
// key path, a dragged cut as one step, a held key), the history's life (redo cleared by a new edit, cleared by a project
// switch, media kept while a step holds it and freed after), and the phone's Undo button (present, disabled, enabled,
// hold for redo, no overflow, 44px targets) at 390×844, 390×700 and 320×568. Screenshots go to <out-dir>.
//   node design/undo-check.mjs <repo-root> <out-dir>
// The example project, collaboration off (this repo's empty sync URL); every request outside the local server is aborted.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });

async function newPage(opts) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1, ...opts });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
  await ctx.addInitScript(() => { window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(origin + '/index.html');
  return { ctx, page };
}
// what the user sees and what the history holds
const state = page => page.evaluate(() => { const a = __A(), h = a.hist(); return { n: a.S().length, ids: a.S().map(s => s.id), starts: a.S().map(s => s.start), sel: a.S().find(s => s.id === document.querySelector('.card.sel')?.dataset.id)?.id, undo: h.canUndo(), redo: h.canRedo(), size: h.size(), top: h.peek()?.label || '', toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent }; });
const blurAll = page => page.evaluate(() => document.activeElement && document.activeElement.blur());
const clearHist = page => page.evaluate(() => __A().hist().clear());
const hasBlob = (page, id) => page.evaluate(async id => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); return new Promise(r => { const g = d.transaction('media').objectStore('media').get(id); g.onsuccess = () => r(!!g.result); g.onerror = () => r(false); }); }, id);
const flush = page => page.evaluate(() => __A().flushNow());
const putBlob = (page, id) => page.evaluate(async id => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); }); return new Promise(r => { const t = d.transaction('media', 'readwrite'); t.objectStore('media').put({ blob: new Blob(['x'], { type: 'image/png' }), type: 'image/png' }, id); t.oncomplete = () => r(true); }); }, id);

try {
  // ======== desktop ========
  const { page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await page.waitForSelector('.card', { timeout: 15000 }); await page.evaluate(() => document.fonts.ready); await sleep(600);
  await blurAll(page);
  let a = await state(page);
  check('the example opens with an empty history', !a.undo && !a.redo, JSON.stringify(a));
  await page.keyboard.press('Control+z'); await sleep(150); a = await state(page);
  check('Ctrl+Z with nothing to undo says so', a.toast === 'Nothing to undo', a.toast);

  // a cut, then the four key variants
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ArrowRight'); await sleep(100);
  let s0 = await state(page); await page.keyboard.press('m'); await sleep(200); let s1 = await state(page);
  check('M adds a cut and records one step', s1.n === s0.n + 1 && s1.size === 1 && /^cut at /.test(s1.top), JSON.stringify([s0.n, s1.n, s1.top]));
  await page.keyboard.press('Control+z'); await sleep(200); a = await state(page);
  check('Ctrl+Z undoes the cut with a notice', a.n === s0.n && a.toast === 'Undone: ' + s1.top && a.redo && !a.undo, JSON.stringify(a));
  await page.keyboard.press('Control+Shift+z'); await sleep(200); a = await state(page);
  check('Ctrl+Shift+Z redoes it', a.n === s1.n && a.toast === 'Redone: ' + s1.top, JSON.stringify(a));
  await page.keyboard.press('Control+y'); await sleep(200); a = await state(page);
  check('Ctrl+Y with nothing to redo says so, and changes nothing', a.n === s1.n && a.toast === 'Nothing to redo', a.toast);
  await page.keyboard.press('Meta+z'); await sleep(200); a = await state(page);
  check('⌘Z undoes', a.n === s0.n && a.toast.startsWith('Undone'), a.toast);
  await page.keyboard.press('Control+y'); await sleep(200); a = await state(page);
  check('Ctrl+Y redoes', a.n === s1.n && a.toast.startsWith('Redone'), a.toast);
  await page.keyboard.press('Meta+z'); await sleep(150); await page.keyboard.press('Meta+Shift+z'); await sleep(200); a = await state(page);
  check('⌘⇧Z redoes', a.n === s1.n && a.toast.startsWith('Redone'), a.toast);
  // ⌘Y is the browser's History on a Mac: not redo, and not blocked
  await page.evaluate(() => window.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'y') window.__yBlocked = e.defaultPrevented; }));
  await page.keyboard.press('Meta+z'); await sleep(150); await page.keyboard.press('Meta+y'); await sleep(200); a = await state(page);
  const yBlocked = await page.evaluate(() => window.__yBlocked);
  check('⌘Y is not redo and is left to the browser', a.n === s0.n && a.redo && yBlocked === false, JSON.stringify({ n: a.n, redo: a.redo, yBlocked }));
  await page.keyboard.press('Control+y'); await sleep(200); a = await state(page);
  check('Ctrl+Y still redoes', a.n === s1.n && a.toast.startsWith('Redone') && await page.evaluate(() => window.__yBlocked) === true, a.toast);
  await page.screenshot({ path: join(out, 'desktop-redone.png') });

  // a new edit after an undo clears the redo stack
  await page.keyboard.press('Control+z'); await sleep(150); await page.keyboard.press('ArrowRight'); await page.keyboard.press('m'); await sleep(200); a = await state(page);
  check('a new edit after an undo clears the redo stack', a.undo && !a.redo && a.size === 1, JSON.stringify(a));
  await page.keyboard.press('Control+z'); await sleep(200);

  // typing: the field's own undo while focused; one step for the whole run once it blurs
  clearHist(page);
  const v0 = await page.inputValue('#f-notes');
  await page.click('#f-notes'); await page.keyboard.press('End'); await page.keyboard.type(' typed here'); await sleep(100);
  const typed = await page.inputValue('#f-notes'); a = await state(page);
  check('typing records one step for the field', a.size === 1 && /^notes of shot/.test(a.top), JSON.stringify([a.size, a.top]));
  await page.keyboard.press('Control+z'); await sleep(200);
  const afterNative = await page.inputValue('#f-notes'); a = await state(page);
  // the field's own undo removed the last character and the app's history did not move (still one step, nothing on redo)
  check('Ctrl+Z inside the field is the field\'s own undo: the app did nothing', afterNative !== typed && afterNative !== v0 && a.size === 1 && a.undo && !a.redo, JSON.stringify({ typed, afterNative, size: a.size }));
  await page.keyboard.press('Control+Shift+z'); await sleep(100);   // the field's own redo
  const back = await page.inputValue('#f-notes');
  await blurAll(page); await sleep(100);
  await page.keyboard.press('Control+z'); await sleep(200); a = await state(page);
  const val = await page.inputValue('#f-notes');
  check('after the field blurs, Ctrl+Z undoes the whole typed run as one step', val === v0 && a.toast.startsWith('Undone: notes of shot') && !a.undo, JSON.stringify({ v0, back, val, toast: a.toast }));
  await page.keyboard.press('Control+Shift+z'); await sleep(200);
  check('and redo brings the typed text back', (await page.inputValue('#f-notes')) === typed);
  await page.keyboard.press('Control+z'); await sleep(200); clearHist(page);

  // Delete key, twice, then Ctrl+Z: the shot is back with its image, and its file was never deleted.
  // Give shot 3 an image first (the example's shots carry side-B start frames, not a side-A image), one undoable step
  const withImg = 2;
  await page.locator('.card').nth(withImg).click(); await sleep(200);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAGklEQVR4nGP8z4AKmBgYGBgYGBgYGBgYGAAAkQABZyH5NwAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#f-img', { name: 'shot3.png', mimeType: 'image/png', buffer: PNG }); await sleep(600);
  clearHist(page); await blurAll(page);
  s0 = await state(page); const gone = await page.evaluate(() => { const s = __A().S().find(s => s.id === document.querySelector('.card.sel').dataset.id); return { id: s.id, img: s.img, title: s.title }; });
  check('the shot picked to delete has an image file', !!gone.img && await hasBlob(page, gone.img), JSON.stringify(gone));
  await page.keyboard.press('Delete'); await sleep(120); await page.keyboard.press('Delete'); await sleep(300); s1 = await state(page);
  check('Delete twice deletes the selected shot and records "delete shot NN"', s1.n === s0.n - 1 && !s1.ids.includes(gone.id) && s1.top === 'delete shot ' + String(withImg + 1).padStart(2, '0'), JSON.stringify([s1.n, s1.top]));
  await flush(page); await sleep(400);
  const parkedNow = await page.evaluate(id => __A().parked().has(id), gone.img);
  check('after the save the shot\'s image file is parked for the history, not deleted', parkedNow && await hasBlob(page, gone.img), JSON.stringify({ parkedNow, blob: await hasBlob(page, gone.img) }));
  await page.keyboard.press('Control+z'); await sleep(300); a = await state(page);
  const card = await page.evaluate(id => { const c = document.querySelector(`.card[data-id="${id}"]`); return c ? { sel: c.classList.contains('sel'), img: !!c.querySelector('.thumb img'), src: c.querySelector('.thumb img')?.getAttribute('src') || '' } : null; }, gone.id);
  check('Ctrl+Z brings the shot back, selected, with its image showing', a.n === s0.n && a.ids.includes(gone.id) && card && card.sel && card.img && /^blob:/.test(card.src) && a.toast === 'Undone: ' + s1.top, JSON.stringify({ a: a.toast, card }));
  check('its file is still in this browser', await hasBlob(page, gone.img));
  await page.screenshot({ path: join(out, 'desktop-undone-delete.png') });
  clearHist(page);

  // a dragged cut is one step
  await page.click('#zfit'); await sleep(200);
  const free = await page.evaluate(() => { const cv = document.getElementById('tl'), r = cv.getBoundingClientRect(), y = r.top + r.height * .7, xs = []; for (let x = Math.ceil(r.left) + 2; x < r.right - 2; x += 2) { cv.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true })); if (cv.style.cursor === 'ew-resize') xs.push(x); } return { xs, y }; });
  const run = free.xs.filter(x => x < (free.xs[0] || 0) + 16), grab = run[Math.floor(run.length / 2)];
  s0 = await state(page);
  await page.mouse.move(grab, free.y); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(grab + i * 6, free.y); await sleep(20); } await page.mouse.up(); await sleep(250); s1 = await state(page);
  check('dragging a cut through many moves records one step', !!grab && s1.starts[1] > s0.starts[1] + .1 && s1.size === 1 && s1.top === 'move cut' && !s0.undo, JSON.stringify([s0.starts[1], s1.starts[1], s1.size]));
  await page.keyboard.press('Control+z'); await sleep(250); a = await state(page);
  check('one Ctrl+Z puts the cut back where it was', Math.abs(a.starts[1] - s0.starts[1]) < .001 && a.toast === 'Undone: move cut', JSON.stringify([a.starts[1], s0.starts[1]]));
  clearHist(page);

  // a take on another shot finishes (the app's own poll, OpenRouter answered here) in the middle of a drag: the step is
  // the cut's start only, so the undo puts the cut back and the take stays completed with its file
  await page.route('https://openrouter.ai/api/v1/videos/job-drag', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ status: 'completed', unsigned_urls: ['data:video/mp4;base64,AAAAIGZ0eXBpc29t'] }) }));
  const tSid = await page.evaluate(() => { const a = __A(), s = a.S()[3]; s.takes = [...(s.takes || []), { id: 't-drag', jobId: 'job-drag', model: 'x', dur: 4, status: 'pending', media: '', note: '', error: '', created: Date.now() }]; a.scheduleSave(); a.hist().clear(); return s.id; });
  const take = () => page.evaluate(sid => { const t = __A().S().find(x => x.id === sid).takes.find(t => t.id === 't-drag'); return { status: t.status, media: t.media }; }, tSid);
  s0 = await state(page);
  await page.mouse.move(grab, free.y); await page.mouse.down(); for (let i = 1; i <= 4; i++) { await page.mouse.move(grab + i * 6, free.y); await sleep(20); }
  await page.evaluate(async sid => { const a = __A(), s = a.S().find(x => x.id === sid); await a.pollTake(s, s.takes.find(t => t.id === 't-drag'), a.cur().id); }, tSid);
  for (let i = 5; i <= 8; i++) { await page.mouse.move(grab + i * 6, free.y); await sleep(20); } await page.mouse.up(); await sleep(250); s1 = await state(page);
  const tk1 = await take();
  check('a take finishing during a drag completes, and the drag is one "move cut" step', tk1.status === 'completed' && !!tk1.media && s1.size === 1 && s1.top === 'move cut' && s1.starts[1] > s0.starts[1] + .1, JSON.stringify({ tk1, size: s1.size, top: s1.top }));
  await page.keyboard.press('Control+z'); await sleep(250); a = await state(page); await flush(page); await sleep(400);
  const tk2 = await take();
  check('undo puts the cut back; the take stays completed with its file', Math.abs(a.starts[1] - s0.starts[1]) < .001 && tk2.status === 'completed' && tk2.media === tk1.media && await hasBlob(page, tk1.media), JSON.stringify({ tk2, start: a.starts[1], was: s0.starts[1] }));
  await page.unroute('https://openrouter.ai/api/v1/videos/job-drag');
  clearHist(page);

  // Ctrl+Z in the middle of a drag is ignored: the earlier step stays done, the drag is its own step, nothing goes to redo
  const n0 = await page.inputValue('#f-notes');
  await page.click('#f-notes'); await page.keyboard.press('End'); await page.keyboard.type(' x'); await blurAll(page); await sleep(100);
  s0 = await state(page);
  await page.mouse.move(grab, free.y); await page.mouse.down(); for (let i = 1; i <= 4; i++) { await page.mouse.move(grab + i * 6, free.y); await sleep(20); }
  await page.keyboard.press('Control+z'); await sleep(150);
  for (let i = 5; i <= 8; i++) { await page.mouse.move(grab + i * 6, free.y); await sleep(20); } await page.mouse.up(); await sleep(250); s1 = await state(page);
  check('Ctrl+Z during a drag is ignored: the notes edit stays, the drag is a second step, redo is empty', s0.size === 1 && (await page.inputValue('#f-notes')) === n0 + ' x' && s1.size === 2 && s1.top === 'move cut' && !s1.redo, JSON.stringify({ s0: s0.size, s1: [s1.size, s1.top, s1.redo] }));
  await page.keyboard.press('Control+z'); await sleep(200); await page.keyboard.press('Control+z'); await sleep(200); a = await state(page);
  check('then two Ctrl+Z put back the cut and the notes', Math.abs(a.starts[1] - s0.starts[1]) < .001 && (await page.inputValue('#f-notes')) === n0, JSON.stringify([a.starts[1], s0.starts[1]]));
  clearHist(page);

  // holding Ctrl+Z: repeats, capped (each step is a cut, so count by shots undone)
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('m'); await sleep(60); }
  s0 = await state(page);
  const t0 = Date.now(); await page.keyboard.down('Control');
  for (let i = 0; i < 12; i++) { await page.keyboard.down('z'); await sleep(25); }
  await page.keyboard.up('z'); await page.keyboard.up('Control'); const held = Date.now() - t0; await sleep(300); s1 = await state(page);
  const undone = s1.n - s0.n + s0.n - s1.n < 0 ? 0 : s0.n - s1.n;
  check('holding Ctrl+Z steps back, at most one step per 150 ms', undone >= 1 && undone <= Math.ceil(held / 150) + 1 && undone < 12, JSON.stringify({ undone, held, before: s0.n, after: s1.n }));
  while ((await state(page)).undo) { await page.keyboard.press('Control+z'); await sleep(60); }
  await sleep(200); a = await state(page);
  check('undoing everything gets back to the project as opened', !a.undo && a.n === 13, JSON.stringify([a.n, a.size]));
  clearHist(page);

  // side B: the keys work there too, outside fields
  await page.click('.sidetab[data-side="b"]'); await sleep(300);
  const bp0 = await page.inputValue('#bPrompt');
  await page.click('#bPrompt'); await page.keyboard.press('End'); await page.keyboard.type(' pan left'); await blurAll(page); await sleep(100); s0 = await state(page);
  await page.keyboard.press('Control+z'); await sleep(200); a = await state(page);
  check('on Side B, Ctrl+Z outside a field undoes the prompt edit', s0.top.startsWith('motion prompt') && a.toast === 'Undone: ' + s0.top && (await page.inputValue('#bPrompt')) === bp0, JSON.stringify([s0.top, a.toast, bp0]));
  await page.click('.sidetab[data-side="a"]'); await sleep(300); clearHist(page);

  // a project switch clears the history, and frees the parked files nothing uses
  await page.locator('.card').nth(withImg).click(); await sleep(150); await blurAll(page);
  await page.keyboard.press('Delete'); await sleep(120); await page.keyboard.press('Delete'); await sleep(200); await flush(page); await sleep(400);
  check('the deleted shot\'s file is parked again', await page.evaluate(id => __A().parked().has(id), gone.img) && await hasBlob(page, gone.img));
  await page.click('#newp'); await sleep(400); await page.keyboard.press('Escape'); await sleep(300); a = await state(page);
  check('a new project starts with an empty history', !a.undo && !a.redo && a.n === 1, JSON.stringify(a));
  await page.keyboard.press('Control+z'); await sleep(150); a = await state(page);
  check('Ctrl+Z in the new project has nothing to undo (the old project\'s steps are gone)', a.toast === 'Nothing to undo' && a.n === 1, a.toast);
  await sleep(500);
  check('the parked file of the old project, now unused, was freed on the switch', !(await hasBlob(page, gone.img)) && !(await page.evaluate(id => __A().parked().has(id), gone.img)));
  await page.click('#proj'); await page.locator('#projmenu .mi[data-pid="p-example"]').click(); await sleep(500);
  a = await state(page);
  check('back in the example: its history is empty too, and the deleted shot stays deleted', !a.undo && a.n === 12, JSON.stringify([a.n, a.undo]));

  // Remove song, then an undo the moment the step exists: the song comes back with its file, and plays
  const rate = 8000, n = rate / 2, wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
  await page.setInputFiles('#song', { name: 'tone.wav', mimeType: 'audio/wav', buffer: wav });
  await page.waitForFunction(() => __A().cur().song && __A().cur().song.name === 'tone.wav', null, { timeout: 8000 }); await sleep(500);
  const songNow = () => page.evaluate(async () => { const s = await __A().song(); return { playing: s.playing, name: s.playingName, file: !!(s.rec && s.rec.blob), meta: __A().cur().song?.name || '' }; });
  const sg0 = await songNow(); clearHist(page);
  const fast = await page.evaluate(async () => {
    const a = __A(), h = a.hist(), b = document.getElementById('delsong'); b.hidden = false; b.click(); b.click();
    for (let i = 0; i < 200 && h.peek()?.label !== 'remove song'; i++) await new Promise(r => setTimeout(r, 0));
    const top = h.peek()?.label; a.doUndo('undo'); return top;
  });
  await sleep(600); const sg1 = await songNow();
  check('Remove song, then undo right away: the song is back and plays, with its file in storage', sg0.playing && sg0.file && fast === 'remove song' && sg1.meta === 'tone.wav' && sg1.playing && sg1.file, JSON.stringify({ sg0, fast, sg1 }));
  clearHist(page);

  // Replace song, then undo, redo, undo, with the player reading each file 0.5 s longer than it decoded (a VBR mp3):
  // its length correction isn't a change of the user's, so no step is skipped
  const wav2 = Buffer.from(wav); wav2.writeUInt32LE(rate, 24); wav2.writeUInt32LE(rate, 28); wav2.writeUInt16LE(1, 32); wav2.writeUInt16LE(8, 34);
  await page.setInputFiles('#song', { name: 'tone2.wav', mimeType: 'audio/wav', buffer: wav2 });
  await page.waitForFunction(() => __A().cur().song && __A().cur().song.name === 'tone2.wav', null, { timeout: 8000 }); await sleep(500);
  await page.evaluate(() => { const g = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration').get; Object.defineProperty(HTMLAudioElement.prototype, 'duration', { configurable: true, get() { const d = g.call(this); return isFinite(d) ? d + 0.5 : d; } }); });
  const rs = [];
  for (const dir of ['undo', 'redo', 'undo']) {
    await page.evaluate(d => __A().doUndo(d), dir); await sleep(900);
    rs.push(await page.evaluate(() => ({ song: __A().cur().song?.name, dur: +(__A().cur().song?.duration || 0).toFixed(2), toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent })));
  }
  await page.evaluate(() => delete HTMLAudioElement.prototype.duration);
  const sg2 = await songNow();
  check('Replace song, undo, redo, undo with a length correction in between: every step runs, the first song is back and plays', rs[0].song === 'tone.wav' && rs[1].song === 'tone2.wav' && rs[2].song === 'tone.wav' && rs.every(r => !/changed since/.test(r.toast)) && sg2.name === 'tone.wav' && sg2.file, JSON.stringify({ rs, sg2 }));
  clearHist(page);

  // parked files don't outlive the tab: delete a shot with an image, save, reload: the file goes (a boot sweep). While
  // another tab is open, a booting tab leaves what the other one parked (its undo may still need it)
  await page.locator('.card').nth(1).click(); await sleep(200);
  await page.setInputFiles('#f-img', { name: 'shot2.png', mimeType: 'image/png', buffer: PNG }); await sleep(600);
  clearHist(page); await blurAll(page);
  const leak = await page.evaluate(() => __A().S().find(s => s.id === document.querySelector('.card.sel').dataset.id).img);
  await page.keyboard.press('Delete'); await sleep(120); await page.keyboard.press('Delete'); await sleep(200); await flush(page); await sleep(400);
  const parkedLs = () => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('cueboard-parked:')).map(k => localStorage.getItem(k)).join('|'));
  check('a deleted shot\'s image is parked, and the parked list is in localStorage', !!leak && await hasBlob(page, leak) && (await parkedLs()).includes(leak), JSON.stringify({ leak, ls: await parkedLs() }));
  // an unused file nobody parked (mid-import, or another version's upload) is never swept, with or without another tab
  const orphan = 'm_orphan_test';
  await putBlob(page, orphan);
  const tab2 = await page.context().newPage(); await tab2.goto(origin + '/index.html'); await tab2.waitForSelector('.card'); await sleep(3800);
  check('another tab booting while this one is open leaves its parked file alone', await hasBlob(page, leak));
  check('another tab booting leaves an unused file nobody parked alone', await hasBlob(page, orphan));
  await tab2.close(); await sleep(300);
  await page.reload(); await page.waitForSelector('.card', { timeout: 15000 }); await sleep(3800);
  check('after a reload (no other tab open) the parked file is gone from browser storage, and so is the list', !(await hasBlob(page, leak)) && !(await parkedLs()).includes(leak), JSON.stringify({ blob: await hasBlob(page, leak), ls: await parkedLs() }));
  check('after a reload alone, an unused file nobody parked is still in browser storage', await hasBlob(page, orphan));
  a = await state(page);
  const kept = await page.evaluate(() => [...new Set([...(__A().cur().refs || []), ...__A().S().flatMap(s => [s.img, s.key, s.endKey, ...(s.takes || []).map(t => t.media)])].filter(Boolean))]);
  const missing = []; for (const id of kept) if (!(await hasBlob(page, id))) missing.push(id);
  check('the project itself is as saved: the shot stays deleted, every file it uses is still here', a.n === 11 && !a.undo && kept.length > 0 && !missing.length, JSON.stringify({ n: a.n, files: kept.length, missing }));
  await page.context().close();

  // without the Web Locks API an open tab can't be told from a closed one: a second tab opening sweeps nothing
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/*', r => (r.request().url().startsWith(origin) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
    await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true }); window.__CUE_MEDIA_TEST = {}; window.__A = () => window.__CUE_MEDIA_TEST.app; });
    const p1 = await ctx.newPage(); p1.on('pageerror', e => errs.push(e.message));
    await p1.goto(origin + '/index.html'); await p1.waitForSelector('.card', { timeout: 15000 }); await sleep(600);
    await p1.locator('.card').nth(1).click(); await sleep(200);
    await p1.setInputFiles('#f-img', { name: 'shot3.png', mimeType: 'image/png', buffer: PNG }); await sleep(600);
    await clearHist(p1); await blurAll(p1);
    const held = await p1.evaluate(() => __A().S().find(s => s.id === document.querySelector('.card.sel').dataset.id).img);
    await p1.keyboard.press('Delete'); await sleep(120); await p1.keyboard.press('Delete'); await sleep(200); await flush(p1); await sleep(400);
    const parkedOk = await p1.evaluate(id => !navigator.locks && __A().parked().has(id), held);
    const p2 = await ctx.newPage(); await p2.goto(origin + '/index.html'); await p2.waitForSelector('.card'); await sleep(3800);
    check('without the locks API, a second tab opening leaves the first tab\'s parked file alone', parkedOk && await hasBlob(p1, held), JSON.stringify({ parkedOk, blob: await hasBlob(p1, held) }));
    await ctx.close();
  }

  // ======== phone ========
  for (const [w, h] of [[390, 844], [390, 700], [320, 568]]) {
    const { page: ph } = await newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    const tag = `phone-${w}x${h}`;
    await ph.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent) && document.getElementById('mtUndo'), null, { timeout: 15000 });
    await ph.evaluate(() => document.fonts.ready); await sleep(600);
    const tool = () => ph.evaluate(() => {
      const bs = [...document.querySelectorAll('#mTool > button')].filter(b => b.getClientRects().length), u = document.getElementById('mtUndo');
      const box = b => { const r = b.getBoundingClientRect(), i = b.querySelector('.ico').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), icon: Math.round(i.width), stroke: getComputedStyle(b.querySelector('.ico')).strokeWidth, clipped: b.scrollWidth > b.clientWidth + 1, label: b.textContent.trim() }; };
      return { labels: bs.map(b => b.textContent.trim()), undo: box(u), others: bs.filter(b => b !== u).map(box), disabled: u.disabled, aria: u.getAttribute('aria-label'), overflow: document.documentElement.scrollWidth - innerWidth, color: getComputedStyle(u).color };
    });
    let t = await tool();
    check(`[${tag}] Undo sits in the shot toolbar, before Delete, with the five others`, t.labels.join('|') === 'Cut here|Details|Photo|Move|Undo|Delete', t.labels.join('|'));
    check(`[${tag}] same size, icon and stroke as the other toolbar buttons, nothing clipped`, t.others.every(o => o.w === t.undo.w && o.h === t.undo.h && o.icon === t.undo.icon && o.stroke === t.undo.stroke) && !t.undo.clipped && t.others.every(o => !o.clipped) && t.undo.icon === 20, JSON.stringify({ undo: t.undo, others: t.others }));
    check(`[${tag}] disabled while there is nothing to undo; named for the hold`, t.disabled && /hold to redo/i.test(t.aria), JSON.stringify([t.disabled, t.aria]));
    check(`[${tag}] no horizontal overflow`, t.overflow <= 0, String(t.overflow));
    check(`[${tag}] every toolbar button is at least 44×44`, [t.undo, ...t.others].every(o => o.w >= 44 && o.h >= 44), JSON.stringify([t.undo, ...t.others].map(o => [o.label, o.w, o.h])));
    await ph.screenshot({ path: join(out, `${tag}-toolbar-disabled.png`), clip: { x: 0, y: h - 130, width: w, height: 130 } });
    await ph.screenshot({ path: join(out, `${tag}-full.png`) });
    // a cut from the toolbar enables it; a tap undoes; a hold redoes
    await ph.evaluate(() => { const a = document.getElementById('audio'), s = __A().S(); a.currentTime = (s[1].start + s[2].start) / 2; }); await sleep(300);
    let p0 = await state(ph); await ph.tap('#mtCut'); await sleep(300); let p1 = await state(ph); t = await tool();
    check(`[${tag}] Cut here records a step and enables Undo`, p1.n === p0.n + 1 && !t.disabled, JSON.stringify([p0.n, p1.n, t.disabled]));
    await ph.screenshot({ path: join(out, `${tag}-toolbar-enabled.png`), clip: { x: 0, y: h - 130, width: w, height: 130 } });
    await ph.tap('#mtUndo'); await sleep(300); a = await state(ph); t = await tool();
    check(`[${tag}] a tap undoes the cut with a notice; the button stays on for the redo`, a.n === p0.n && a.toast === 'Undone: ' + p1.top && !t.disabled, JSON.stringify([a.n, a.toast, t.disabled]));
    await ph.screenshot({ path: join(out, `${tag}-undone.png`) });
    await ph.tap('#mtUndo'); await sleep(300); a = await state(ph);
    check(`[${tag}] a tap with nothing to undo points at the hold`, a.toast === 'Nothing to undo. Hold Undo to redo' && a.n === p0.n, a.toast);
    const bb = await ph.locator('#mtUndo').boundingBox();
    const cdp = await ph.context().newCDPSession(ph);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await sleep(300); a = await state(ph); t = await tool();
    check(`[${tag}] holding Undo redoes the cut`, a.n === p1.n && a.toast === 'Redone: ' + p1.top && !t.disabled, JSON.stringify([a.n, a.toast]));
    check(`[${tag}] still no horizontal overflow`, (await tool()).overflow <= 0);
    // undo the cut again and leave it: the button is on (redo), which the hold reaches
    await ph.tap('#mtUndo'); await sleep(200); await ph.evaluate(() => __A().hist().clear()); await sleep(100); t = await tool();
    check(`[${tag}] with the history cleared the button is disabled again`, t.disabled);
    // a second finger taps Undo while a cut's grip is being dragged: ignored, and the drag is its own step
    await ph.tap('#mtCut'); await sleep(300); p0 = await state(ph);
    const gr = await ph.evaluate(() => {
      const g = [...document.querySelectorAll('#mGrips .grip')].find(b => +b.dataset.i >= 1 && b.getBoundingClientRect().width && b.getBoundingClientRect().left > 40 && b.getBoundingClientRect().right < innerWidth - 80);
      if (!g) return null; const r = g.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, i = +g.dataset.i;
      const ev = (t, dx) => g.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x + dx, clientY: y, bubbles: true, isPrimary: true, pointerType: 'touch' }));
      const a = __A(), s0 = a.S()[i].start; ev('pointerdown', 0); ev('pointermove', 20); ev('pointermove', 30);
      a.doUndo('undo'); ev('pointermove', 40); ev('pointerup', 40);
      return { i, s0, s1: a.S()[i].start };
    });
    p1 = await state(ph);
    check(`[${tag}] Undo during a grip drag is ignored: the cut stays, the drag is a second step, redo is empty`, !!gr && gr.s1 > gr.s0 && p1.n === p0.n && p1.size === 2 && p1.top === 'move cut' && !p1.redo, JSON.stringify({ gr, p0: [p0.n, p0.size], p1: [p1.n, p1.size, p1.top, p1.redo] }));
    await ph.context().close();
  }
} catch (e) { check('ran without throwing', false, e.stack); }

check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close(); srv.close();
const fails = results.filter(r => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
