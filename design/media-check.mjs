// Peer-to-peer media in real browsers: node design/media-check.mjs <repo root> <out dir>
// A local sync server on 3360 (rooms from the CLI), a recording pass-through on 3363, up to three browser contexts at a time.
// docs/media-p2p.md, "Checks", lists what each step shows.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SYNC_PORT = 3360, TAP_PORT = 3363, dataDir = mkdtempSync(join(tmpdir(), 'cue-media-check-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], measures = [], cons = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const measure = (name, v) => { measures.push([name, v]); console.log('MEASURE ' + name + ': ' + v); };
async function until(fn, ms = 60000) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } }
const MARK = 'CUE-PLAINTEXT-' + randomBytes(6).toString('hex');   // written into every 64 KiB of the take

// a pass-through that scans everything the server sends to clients on it for the take's plaintext
const tapStat = { bytes: 0, saw: 0 };
const tap = tcpServer(c => {
  const up = connect(SYNC_PORT, '127.0.0.1'); let tail = '';
  up.on('data', d => { tapStat.bytes += d.length; const s = tail + d.toString('latin1'); if (s.includes(MARK)) tapStat.saw++; tail = s.slice(-MARK.length); });
  c.pipe(up); up.pipe(c); c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
});
await new Promise(ok => tap.listen(TAP_PORT, '127.0.0.1', ok));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = createServer((q, r) => {
  const [path, qs = ''] = q.url.split('?');
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', `<meta name="cue-sync-url" content="ws://127.0.0.1:${/sync=tap/.test(qs) ? TAP_PORT : SYNC_PORT}">`);
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, app = origin + '/index.html';
const env = { ...process.env, PORT: String(SYNC_PORT), DATA_DIR: dataDir, MAX_CONNS_PER_IP: '64', LOG_LEVEL: 'debug', APP_URL: app };
const r0 = spawnSync(process.execPath, [join(root, 'packages/sync-server/bin/create-project.mjs'), 'Media check'], { env, encoding: 'utf8' });
const m0 = /#join=([^.]+)\.(\S+)$/m.exec(r0.stdout);
const room = { room: m0[1], token: m0[2] }, link = q => `${app}${q || ''}#join=${room.room}.${room.token}`;
const server = spawn(process.execPath, [join(root, 'packages/sync-server/src/main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50 && !/listening/.test(serverLog); i++) await sleep(100);
/** the server's CPU seconds and resident memory, from /proc */
const proc = () => { const st = readFileSync(`/proc/${server.pid}/stat`, 'utf8').split(') ')[1].split(' '); const rss = +/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${server.pid}/status`, 'utf8'))[1]; return { cpu: (+st[11] + +st[12]) / 100, rssMB: rss / 1024 }; };

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-precise-memory-info'] });
const pages = {};
async function open(name, init = {}, q = '', ctxOpts = { viewport: { width: 1440, height: 900 } }) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  await ctx.addInitScript(init => {
    window.__CUE_MEDIA_TEST = { ...init };
    if (init.denyPersist && navigator.storage) { navigator.storage.persist = async () => false; navigator.storage.persisted = async () => false; }
  }, init);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') cons.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => cons.push(`${name} pageerror: ${e.message}`));
  const chips = new Set(), arriving = { seen: false, ring: false };
  const pg = { name, ctx, page, chips, arriving, timer: null };
  pg.timer = setInterval(async () => {
    try {
      // the indicator's state in words (its panel header) and look; in place, "Arriving · N%" with a progress line on a file that is on its way
      const [c, a, r] = await page.evaluate(() => {
        const w = document.getElementById('mstatw'), b = document.getElementById('mstat'), m = window.__CUE_MEDIA_TEST.app.cmedia();
        const on = new Set((m ? m.files() : []).filter(f => f.state === 'downloading' || f.state === 'queued').map(f => 'sha256-' + f.hex));
        const arr = [...document.querySelectorAll('[data-miss]')].filter(e => /^Arriving · \d+%$/.test(e.querySelector('.mpt')?.textContent || ''));
        return [w && !w.hidden ? document.getElementById('mhead').textContent : '', arr.length > 0 && arr.every(e => e.querySelector('.mbar b') && on.has(e.dataset.miss)), b.dataset.k === 'ring' && !!b.style.getPropertyValue('--p')];
      });
      if (c) chips.add(c); if (a) arriving.seen = true; if (r) arriving.ring = true;
    } catch { /* navigating */ }
  }, 150);
  pages[name] = pg;
  return pg;
}
async function close(pg) { clearInterval(pg.timer); await pg.ctx.close(); }
async function joinRoom(pg, name, q) {
  await pg.page.goto(link(q));
  await pg.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 15000 });
  await pg.page.fill('#jName', name); await pg.page.click('#jGo');
  await pg.page.waitForSelector('.card', { timeout: 15000 });
}
const media = pg => pg.page.evaluate(() => { const m = window.__CUE_MEDIA_TEST.app.cmedia(); return m ? { s: m.summary(), stats: { ...m.stats }, files: m.files() } : null; });
const fileState = async (pg, hex) => ((await media(pg))?.files.find(f => f.hex === hex) || {}).state;
const progress = (pg, hex) => pg.page.evaluate(h => { const m = window.__CUE_MEDIA_TEST.app.cmedia(); return m ? m.progress(h) : null; }, hex);
/** the app shows the file under its local id and its bytes hash to `hex` */
const landedOk = (pg, hex) => pg.page.evaluate(async hex => {
  const ids = [...new Set(window.__CUE_MEDIA_TEST.app.cur().sections.flatMap(s => [s.img, ...(s.takes || []).map(t => t.media)]).filter(Boolean))];
  for (const id of ids) {
    if (id.startsWith('sha256-')) continue;
    const b = await window.__CUE_MEDIA_TEST.app.mediaBlob(id); if (!b) continue;
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (h === hex) return !!window.__CUE_MEDIA_TEST.app.mediaURL(id);
  }
  return false;
}, hex);
/** wait for the files list to say "here" (cheap), then check the bytes once */
const got = async (pg, hexes, ms = 120000) => !!(await until(async () => { for (const h of hexes) if ((await fileState(pg, h)) !== 'here') return false; return true; }, ms)) &&
  (await Promise.all(hexes.map(h => landedOk(pg, h)))).every(Boolean);
const heap = pg => pg.page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0);
/** a ~400 KB WAV of noise (8 kHz mono 16-bit, 25 s), different for each seed */
function wav(seed) {
  const n = 8000 * 25, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  randomBytes(n * 2).copy(b, 44); b.writeUInt32LE(seed, 44);
  return b;
}

let A, B, C, D, E, F, G, H;
const TAKE = 30 * 1024 * 1024 + 4321;
try {
  /* ---- A shares a project and adds a large frame image and a 30 MB take ---- */
  A = await open('A');
  await A.page.goto(app); await A.page.waitForSelector('.card');
  await A.page.evaluate(async () => { localStorage.clear(); });
  await joinRoom(A, 'Ana Torres');
  await A.page.waitForSelector('#dlgJoin[open][data-step="choose"]', { timeout: 15000 }); await A.page.click('#jShare');
  await until(async () => /Synced|All files here/.test([...A.chips].join('|')), 15000);
  const png = await A.page.evaluate(async () => {
    const c = new OffscreenCanvas(1400, 1400), x = c.getContext('2d'), d = x.createImageData(1400, 1400);
    for (let i = 0; i < d.data.length; i += 65536) crypto.getRandomValues(d.data.subarray(i, i + 65536));
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
    x.putImageData(d, 0, 0);
    const b = await c.convertToBlob({ type: 'image/png' });
    return new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result).split(',')[1]); f.readAsDataURL(b); });
  });
  await A.page.click('.card >> nth=0');
  await A.page.setInputFiles('#f-img', { name: 'secret-frame-name.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const takeHex = await A.page.evaluate(async ([n, mark]) => {
    const u = new Uint8Array(n), m = new TextEncoder().encode(mark);
    for (let i = 0; i < n; i += 65536) { crypto.getRandomValues(u.subarray(i, Math.min(n, i + 65536))); if (i + m.length <= n) u.set(m, i); }
    const r = await window.__CUE_MEDIA_TEST.app.assets().upload(new Blob([u], { type: 'video/mp4' }), { type: 'video/mp4' });
    window.__CUE_MEDIA_TEST.app.S()[1].takes.push({ id: 't-big', jobId: 'job-big', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 4, audio: false, seed: '', prompt: 'big take', start: false, end: false, est: 0, cost: null, status: 'completed', created: Date.now(), media: r.id, dev: window.__CUE_MEDIA_TEST.app.dev() });
    window.__CUE_MEDIA_TEST.app.scheduleSave(); window.__CUE_MEDIA_TEST.app.renderAll();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map(x => x.toString(16).padStart(2, '0')).join('');
  }, [TAKE, MARK]);
  const frameBytes = Buffer.from(png, 'base64').length;
  // the app may re-encode an uploaded frame, so it's found by its label, not its size
  const frameHex = await until(async () => (await media(A))?.files.find(f => f.state === 'here' && f.hex !== takeHex && /^Shot 01 · image$/.test(f.label))?.hex, 20000);
  check('A: both new files are hashed and announced', !!frameHex && (await fileState(A, takeHex)) === 'here', `frame ${(frameBytes / 1e6).toFixed(1)} MB, take ${(TAKE / 1e6).toFixed(1)} MB`);
  check('A: the indicator is quiet and says All files here', await until(async () => (await A.page.$eval('#mhead', e => e.textContent)) === 'All files here' && (await A.page.$eval('#mstat', e => e.dataset.k)) === 'ok', 10000));

  /* ---- B replicates both automatically; the placeholders turn into the media ---- */
  B = await open('B');
  const t0 = Date.now(); let bHeap = 0;
  await joinRoom(B, 'Ben Ito');
  const hb = setInterval(async () => { bHeap = Math.max(bHeap, await heap(B).catch(() => 0)); }, 300);
  const bDone = await until(async () => (await fileState(B, takeHex)) === 'here' && (await fileState(B, frameHex)) === 'here', 120000);
  clearInterval(hb);
  const bSecs = (Date.now() - t0) / 1000, bm = await media(B);
  check('B: replicates the frame and the take automatically', !!bDone, `${bSecs.toFixed(1)} s, direct peers ${bm.s.direct}, relayed ${bm.s.relayed}`);
  measure('throughput, A -> B, frame + 30 MB take (join to verified)', `${((TAKE + frameBytes) / 1e6 / bSecs).toFixed(1)} MB/s over ${bm.s.direct ? 'WebRTC' : 'the relay'}`);
  measure('B JS heap peak while receiving', `${bHeap.toFixed(0)} MB`);
  check('B: the bytes hash to the content id and the app shows them under a local id', (await landedOk(B, takeHex)) && (await landedOk(B, frameHex)));
  check('B: the placeholder of the file arriving showed its progress (text and line)', B.arriving.seen);
  check('B: the indicator showed its ring and went Downloading N files -> All files here', B.arriving.ring && [...B.chips].some(c => /^Downloading \d files?$/.test(c)) && (await B.page.$eval('#mhead', e => e.textContent)) === 'All files here', [...B.chips].join(' | '));
  check('B: no "not on this device yet" placeholder left', await B.page.evaluate(() => !document.querySelector('[data-miss]')));

  /* ---- the song: A loads one and B gets it; A replaces it and B gets the new one, never playing the old one under the
     new name meanwhile; B replaces it and keeps its own (A's older one doesn't come back); a concurrent replace converges ---- */
  const loadSong = (pg, name, buf) => pg.page.setInputFiles('#song', { name, mimeType: 'audio/wav', buffer: buf });
  const songOf = pg => pg.page.evaluate(async () => {
    const s = await window.__CUE_MEDIA_TEST.app.song(), b = s.rec && s.rec.blob;
    const hex = b ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('') : '';
    const f = (window.__CUE_MEDIA_TEST.app.cmedia()?.files() || []).find(x => x.song);
    return { stale: s.stale, playing: s.playing, playingName: s.playingName, name: s.rec ? s.rec.name : '', hex, file: f ? { label: f.label, state: f.state, hex: f.hex } : null,
      bar: document.getElementById('songbar').hidden ? '' : document.getElementById('songbar').textContent, title: window.__CUE_MEDIA_TEST.app.cur().song?.name || '' };
  });
  const wavs = [1, 2, 3, 4, 5].map(i => wav(i)), [song1, song2, song3, song4, song5] = wavs;
  const [h1, h2, h3, h4, h5] = wavs.map(b => createHash('sha256').update(b).digest('hex'));
  const hasSong = (pg, hex, name) => until(async () => { const s = await songOf(pg); return s.hex === hex && s.name === name && s.playing && !s.stale && s.playingName === name && s.file?.state === 'here' ? s : null; }, 60000);
  await loadSong(A, 'first-song.wav', song1);
  check('song: B gets the song A loaded, stores and plays it', !!(await hasSong(B, h1, 'first-song.wav')));
  // slow A's sending down so B's in-between state can be seen
  await A.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 150; });
  const seen = { stale: null, playedOld: false };
  const watch = setInterval(async () => {
    const s = await songOf(B).catch(() => null); if (!s) return;
    if (s.title === 'second-song.wav' && s.playing && s.playingName === 'first-song.wav') seen.playedOld = true;
    if (s.stale && !seen.stale) seen.stale = s;
  }, 50);
  await loadSong(A, 'second-song.wav', song2);
  const gotNew = await hasSong(B, h2, 'second-song.wav');
  clearInterval(watch);
  await A.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 0; });
  check('song: A replaces it; B fetches the new file, verifies it and replaces its stored song with it (old blob gone)', !!gotNew, gotNew ? `${gotNew.name} ${gotNew.hex.slice(0, 8)}` : JSON.stringify(await songOf(B)));
  check('song: meanwhile B shows the new song as arriving (Files list, song bar) and doesn\'t play the old one under the new name',
    !!seen.stale && !seen.stale.playing && seen.stale.file?.hex === h2 && seen.stale.file.state !== 'here' && /Song · second-song\.wav/.test(seen.stale.file.label) && /replaced with second-song\.wav/.test(seen.stale.bar) && !seen.playedOld,
    JSON.stringify({ ...seen.stale, playedOld: seen.playedOld }).slice(0, 300));
  // A undoes the replace: the room announces the first file again and B, whose copy of it is gone, gets it back from A;
  // A redoes it: B gets the second one again
  const aTop = await A.page.evaluate(() => window.__CUE_MEDIA_TEST.app.hist().peek()?.label || '');
  await A.page.evaluate(() => window.__CUE_MEDIA_TEST.app.doUndo('undo'));
  const bUndo = await hasSong(B, h1, 'first-song.wav'), aUndo = await songOf(A);
  check('song: A undoes "replace song"; the room announces the first file and B gets it back, verified, and plays it', aTop === 'replace song' && !!bUndo && aUndo.hex === h1 && aUndo.file?.hex === h1 && aUndo.playing,
    JSON.stringify({ aTop, b: bUndo ? 'ok' : await songOf(B), a: { ...aUndo, bar: undefined } }).slice(0, 400));
  await A.page.evaluate(() => window.__CUE_MEDIA_TEST.app.doUndo('redo'));
  const bRedo = await hasSong(B, h2, 'second-song.wav'), aRedo = await songOf(A);
  check('song: A redoes it; the room announces the second file again and B plays it', !!bRedo && aRedo.hex === h2 && aRedo.file?.hex === h2 && aRedo.playing,
    JSON.stringify({ b: bRedo ? 'ok' : await songOf(B), a: { ...aRedo, bar: undefined } }).slice(0, 400));
  await loadSong(B, 'third-song.wav', song3);
  const aGot3 = await hasSong(A, h3, 'third-song.wav');
  await sleep(2000);
  const b3 = await songOf(B);
  check('song: B\'s own replacement wins over the older one in the room: B keeps it, A gets it', !!aGot3 && b3.hex === h3 && b3.name === 'third-song.wav' && !b3.stale && b3.playing, JSON.stringify({ ...b3, bar: undefined }));
  // both replace at once: the doc's order picks one, and both end up with that one
  await Promise.all([loadSong(A, 'fourth-song.wav', song4), loadSong(B, 'fifth-song.wav', song5)]);
  const conv = await until(async () => { const a = await songOf(A), b = await songOf(B); return a.hex && a.hex === b.hex && [h4, h5].includes(a.hex) && a.playing && b.playing && !a.stale && !b.stale && a.file?.state === 'here' && b.file?.state === 'here' ? [a, b] : null; }, 60000);
  check('song: a concurrent replace on A and B converges on one file on both', !!conv, conv ? conv[0].name : JSON.stringify([await songOf(A), await songOf(B)].map(s => ({ ...s, bar: undefined }))));

  /* ---- A goes offline: C still gets everything, from B ---- */
  await close(A); A = null;
  C = await open('C');
  await joinRoom(C, 'Cleo Park');
  check('C: gets both files from B with A gone', !!(await got(C, [takeHex, frameHex])));

  /* ---- D: interrupted twice (its source's connection killed, then D's own page reloaded); it resumes and verifies ---- */
  for (const p of [B, C]) await p.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 25; });
  D = await open('D');
  await joinRoom(D, 'Dev Rao');
  await until(async () => (await progress(D, takeHex)) > 0.2, 60000);
  const sentB = (await media(B)).stats.sent, sentC = (await media(C)).stats.sent, srcIsB = sentB >= sentC;
  const killed = srcIsB ? B : C, keep = srcIsB ? C : B;
  await close(killed); if (srcIsB) B = null; else C = null;
  const p1 = await progress(D, takeHex);
  await until(async () => (await progress(D, takeHex)) > Math.min(0.6, p1 + 0.2), 60000);
  const p2 = await progress(D, takeHex);
  check('D: its source left mid-transfer (connection killed); the other peer carries on', p2 > p1, `${(p1 * 100).toFixed(0)}% -> ${(p2 * 100).toFixed(0)}%`);
  await D.page.reload(); await D.page.waitForSelector('.card');
  const resumed = await got(D, [takeHex, frameHex]);
  const dRecv = (await media(D)).stats.recv;
  check('D: after a reload mid-transfer it resumes from the stored chunks and verifies', !!resumed && dRecv < TAKE * (1 - p2) + 2 * 1024 * 1024, `received ${(dRecv / 1e6).toFixed(1)} MB after the reload, ${(TAKE * (1 - p2) / 1e6).toFixed(1)} MB were missing`);
  await keep.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 0; });
  await D.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 0; });

  /* ---- E: one peer corrupts a chunk; E rejects it, drops that peer and refetches from the other ---- */
  await close(keep); if (keep === B) B = null; else C = null;
  // D is now the only one online with the files, and it corrupts the first chunk it serves
  await D.page.evaluate(() => { const t = window.__CUE_MEDIA_TEST; t.corrupt = new Set(Array.from({ length: 2000 }, (_, i) => i)); t.corrupted = false; });
  E = await open('E');
  await joinRoom(E, 'Eli Moss');
  const eBan = await until(async () => (await media(E))?.stats.banned >= 1, 60000);
  check('E: a corrupted chunk fails authentication and its sender is dropped for the session', !!eBan, JSON.stringify((await media(E))?.stats));
  // with D dropped by E, nobody else E trusts has the files: the chip says so
  const eNobody = () => E.page.evaluate(() => ({ head: document.getElementById('mhead').textContent, k: document.getElementById('mstat').dataset.k,
    ph: [...document.querySelectorAll('[data-miss] .mpt.nob')].map(e => e.textContent) }));
  check('E: while nobody online it trusts has the files: hollow dot, "N files not available yet", "Nobody online has it" in place',
    !!(await until(async () => { const s = await eNobody(); return /^\d files? not available yet$/.test(s.head) && s.k === 'off' && s.ph.length && s.ph.every(t => t === 'Nobody online has it'); }, 20000)), JSON.stringify(await eNobody()));

  /* ---- F: direct WebRTC blocked (no ICE candidates at all): everything goes through the relay, which only sees ciphertext ---- */
  F = await open('F', { noDirect: true }, '?sync=tap');
  const s0 = proc(), tapBefore = tapStat.bytes; let rssMax = s0.rssMB, fHeap = 0;
  const pr = setInterval(async () => { rssMax = Math.max(rssMax, proc().rssMB); fHeap = Math.max(fHeap, await heap(F).catch(() => 0)); }, 250);
  const tf = Date.now();
  await joinRoom(F, 'Fay Lin', '?sync=tap');
  const fOk = await got(F, [takeHex, frameHex]);
  clearInterval(pr);
  const fSecs = (Date.now() - tf) / 1000, s1 = proc(), fm = await media(F);
  check('F: with direct connections blocked, both files arrive through the relay and verify', !!fOk && fm.s.direct === 0 && fm.s.relayed >= 1, `${fSecs.toFixed(1)} s, direct ${fm.s.direct}, relayed ${fm.s.relayed}`);
  check('relay: the server sent ciphertext only (the take\'s plaintext marker never crossed the server -> F link)', tapStat.bytes - tapBefore > TAKE && tapStat.saw === 0, `${((tapStat.bytes - tapBefore) / 1e6).toFixed(1)} MB through, marker seen ${tapStat.saw}x`);
  measure('relay throughput (frame + take, D -> server -> F)', `${((TAKE + frameBytes) / 1e6 / fSecs).toFixed(1)} MB/s`);
  measure('server under relay', `CPU ${((s1.cpu - s0.cpu) / fSecs * 100).toFixed(0)}% of one core, RSS ${s0.rssMB.toFixed(0)} -> peak ${rssMax.toFixed(0)} MB`);
  measure('F JS heap peak while receiving via the relay', `${fHeap.toFixed(0)} MB`);
  const files = []; const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))));
  walk(dataDir);
  check('server disk: no file in DATA_DIR holds any of the relayed plaintext', files.every(f => !readFileSync(f).includes(MARK)), `${files.length} files`);
  check('E: refetches what it rejected from F, an honest peer, and verifies', !!(await got(E, [takeHex, frameHex])));
  await close(E); E = null;

  /* ---- G: storage persistence denied, per-file limit 100 MB; a 110 MB clip is skipped with a message ---- */
  G = await open('G', { denyPersist: true });
  await joinRoom(G, 'Gus Hale');
  await got(G, [takeHex]);
  // the files panel from the keyboard: Enter opens it onto the first file, arrows move, Escape closes it back onto the indicator
  await G.page.focus('#mstat'); await G.page.keyboard.press('Enter');
  const kb1 = await G.page.evaluate(() => !document.getElementById('mpanel').hidden && !!document.activeElement?.classList.contains('mrow') && document.getElementById('mstat').getAttribute('aria-expanded') === 'true');
  await G.page.keyboard.press('ArrowDown');
  const kb2 = await G.page.evaluate(() => !!document.activeElement?.closest('#mpanel') && document.activeElement !== document.querySelector('#fList li'));
  await G.page.keyboard.press('Escape');
  const kb3 = await G.page.evaluate(() => document.getElementById('mpanel').hidden && document.activeElement?.id === 'mstat');
  check('G: the files panel opens from the keyboard onto the first file, arrows move, Escape closes it onto the indicator', kb1 && kb2 && kb3, JSON.stringify([kb1, kb2, kb3]));
  await G.page.click('#mstat'); await G.page.waitForSelector('#mpanel:not([hidden])');
  await G.page.selectOption('#fLimF', '100');
  const warn = await G.page.$eval('#fWarn', e => (e.hidden ? '' : e.textContent));
  check('G: persistent storage denied: a quiet warning in the files panel', /may clear these files/.test(warn), warn);
  const list = await G.page.$$eval('#fList li', l => l.map(li => li.textContent));
  check('G: the files list shows name, size, state and who has it', list.length >= 2 && list.some(t => /take 1/.test(t) && /MB/.test(t) && /Here/.test(t) && /also with/.test(t)), list.join(' / ').slice(0, 200));
  await G.page.screenshot({ path: `${out}/files-panel.png` });
  await G.page.click('.brand');
  check('G: a click outside closes the panel', await G.page.$eval('#mpanel', e => e.hidden));
  for (const p of [D, F]) await p.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 10; });
  const bigHex = await D.page.evaluate(async () => {
    window.__CUE_MEDIA_TEST.corrupt = null;
    const n = 110 * 1024 * 1024, u = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, Math.min(n, i + 65536)));
    const r = await window.__CUE_MEDIA_TEST.app.assets().upload(new Blob([u], { type: 'video/mp4' }), { type: 'video/mp4' });
    window.__CUE_MEDIA_TEST.app.S()[2].takes.push({ id: 't-huge', jobId: 'job-huge', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 4, audio: false, seed: '', prompt: 'huge', start: false, end: false, est: 0, cost: null, status: 'completed', created: Date.now(), media: r.id, dev: window.__CUE_MEDIA_TEST.app.dev() });
    window.__CUE_MEDIA_TEST.app.scheduleSave(); window.__CUE_MEDIA_TEST.app.renderAll();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map(x => x.toString(16).padStart(2, '0')).join('');
  });
  const skipped = await until(async () => (await fileState(G, bigHex)) === 'skipped' && /^1 file skipped: over the size limit$/.test(await G.page.$eval('#mhead', e => e.textContent)), 30000);
  check('G: a file over its 100 MB limit is skipped, the indicator says so', !!skipped, await G.page.$eval('#mhead', e => e.textContent));
  await sleep(1500);
  check('G: nothing of the skipped file was fetched', (await progress(G, bigHex)) === null);
  // in place: the take's placeholder on side B offers Download, which fetches just that file
  await G.page.click('.sidetab[data-side="b"]'); await G.page.locator('.bitem').nth(2).click();
  const dl = `.take [data-miss="sha256-${bigHex}"] [data-mact="download"]`;
  const offered = await until(() => G.page.$(dl), 10000);
  check('G: the skipped take\'s placeholder says "Over the size limit" and offers Download', !!offered && /^Over the size limit$/.test(await G.page.$eval(`.take [data-miss="sha256-${bigHex}"] .mpt`, e => e.textContent)));
  const r0 = (await media(G)).stats.recv;
  if (offered) await G.page.click(dl);
  check('G: Download in place starts it', !!(await until(async () => (await progress(G, bigHex)) > 0.05, 30000)));
  // Pause in the panel: no new requests, the stored chunks stay, the placeholder says "Paused · N%"
  await G.page.click('#mstat'); await G.page.waitForSelector('#mpanel:not([hidden])'); await G.page.click('#fPause');
  await sleep(1500); const q1 = await progress(G, bigHex); await sleep(1500); const q2 = await progress(G, bigHex);
  const pausedTxt = await G.page.$eval(`.take [data-miss="sha256-${bigHex}"] .mpt`, e => e.textContent).catch(() => '');
  check('G: Pause keeps the partial file and asks for nothing more', q1 != null && q2 != null && q2 - q1 < 0.02 && q2 < 1 && /^Paused · \d+%$/.test(pausedTxt) && (await G.page.$eval('#fPause', e => e.textContent)) === 'Resume', `${q1} -> ${q2}, "${pausedTxt}"`);
  for (const p of [D, F]) await p.page.evaluate(() => { window.__CUE_MEDIA_TEST.chunkDelay = 0; });
  await G.page.click('#fAll');
  const bigOk = await got(G, [bigHex]), r1 = (await media(G)).stats.recv;
  check('G: "Download all now" resumes it from the stored chunks and it lands', !!bigOk && r1 - r0 < 110 * 1024 * 1024 + 4 * 1024 * 1024, `${((r1 - r0) / 1e6).toFixed(1)} MB received for a 115.3 MB file`);
  check('G: the placeholder is gone once it landed', !!(await until(() => G.page.evaluate(h => !document.querySelector(`[data-miss="sha256-${h}"]`), bigHex), 10000)));

  /* ---- H: a phone (layout below 820px, touch) with Wi-Fi only on. D adds a GIF frame and a song stored as video/mp4:
     only the video/* takes are held; the images (PNG, GIF) and the song still arrive, as the files sheet's hint says ---- */
  const gifHex = await D.page.evaluate(async () => {
    const u = new Uint8Array(60000); crypto.getRandomValues(u); u.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const r = await window.__CUE_MEDIA_TEST.app.assets().upload(new Blob([u], { type: 'image/gif' }), { type: 'image/gif' });
    window.__CUE_MEDIA_TEST.app.S()[3].key = r.id; window.__CUE_MEDIA_TEST.app.scheduleSave(); window.__CUE_MEDIA_TEST.app.renderAll();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map(x => x.toString(16).padStart(2, '0')).join('');
  });
  const song6 = wav(6), h6 = createHash('sha256').update(song6).digest('hex');
  await D.page.setInputFiles('#song', { name: 'video-song.mp4', mimeType: 'video/mp4', buffer: song6 });
  const dSong = await until(async () => { const s = await songOf(D); return s.hex === h6 && s.file?.state === 'here' ? s : null; }, 20000);
  H = await open('H', {}, '', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await H.page.goto(link());
  await H.page.waitForSelector('#dlgJoin[open][data-step="name"]', { timeout: 15000 });
  await H.page.fill('#jName', 'Hana Mori'); await H.page.tap('#jGo');
  await H.page.waitForSelector('#dlgJoin[open] #jNew:visible', { timeout: 3000 }).then(() => H.page.tap('#jNew')).catch(() => {});
  await until(() => H.page.evaluate(() => !!window.__CUE_MEDIA_TEST.app.cmedia()), 15000);
  const hState = async () => { const f = (await media(H))?.files || []; const st = h => (f.find(x => x.hex === h) || {}); const s = f.find(x => x.song) || {};
    return { wifi: await H.page.evaluate(() => matchMedia('not all and (min-width:820px)').matches), take: [st(takeHex).state, st(takeHex).skip], big: [st(bigHex).state, st(bigHex).skip], frame: st(frameHex).state, gif: st(gifHex).state, song: [s.hex === h6, s.state] }; };
  const hOk = await until(async () => { const s = await hState(); return s.frame === 'here' && s.gif === 'here' && s.song[0] && s.song[1] === 'here' ? s : null; }, 60000);
  await sleep(1500);
  const hs = await hState();
  check('H: phone, Wi-Fi only: the PNG and GIF frames and the video/mp4 song arrive; the video/* takes are held for Wi-Fi',
    !!dSong && !!hOk && hs.wifi && hs.take.join() === 'skipped,video' && hs.big.join() === 'skipped,video' && (await progress(H, takeHex)) === null, JSON.stringify(hs));

  check('server log: no token, no file name, no plaintext', !serverLog.includes(room.token) && !serverLog.includes('secret-frame-name') && !serverLog.includes(MARK) && !/take 1|Shot 0/.test(serverLog), `${serverLog.split('\n').length} lines`);
  // as in collab-check: requests the route blocks (OpenRouter) and 404 probes are not errors of the app
  const errs = cons.filter(c => !/Failed to load resource/.test(c));
  check('no console errors in any context (besides blocked/404 probes)', errs.length === 0, errs.slice(0, 3).join(' / '));
  console.log('chips seen: ' + [...new Set(Object.values(pages).flatMap(p => [...p.chips]))].join(' | '));
} catch (e) {
  check('media check ran to the end', false, e.stack);
} finally {
  for (const p of Object.values(pages)) clearInterval(p.timer);
  await browser.close().catch(() => {}); server.kill('SIGTERM'); srv.close(); tap.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
