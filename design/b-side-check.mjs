// Side B (Takes) layout and review flow: one group of checks per item of docs/b-side/PLAN.md, and screenshots.
//   node design/b-side-check.mjs <repo-root> <out-dir> [--shots-only]
// Desktop Chromium at 1440x900 and 1280x720, phone at 390x844 and 375x667; every request outside the local server
// aborted. --shots-only takes the screenshots and skips the checks (for the "before" set, from a checkout of main).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire(process.env.TESTKIT || '/home/talos/testkit/')('playwright-core');

const [root, out, flag] = process.argv.slice(2);
const shotsOnly = flag === '--shots-only';
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  const p = join(root, normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    let body = readFileSync(p);
    // test-only hook: the app's functions live in its script scope, so the served copy exposes a few of them
    if (p.endsWith('index.html')) body = String(body).replace('window.cueEDL=', 'window.__t={get S(){return S},get setSide(){return setSide},get select(){return select},get selId(){return selId},get now(){return now()},get hasAudio(){return hasAudio},get audio(){return audio},get side(){return side}};window.cueEDL=');
    r.end(body); }
  catch { r.writeHead(404); r.end(); }
});
let port = 3440;
for (;; port++) {
  if (port > 3459) throw new Error('no free port');
  const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '127.0.0.1', () => res(true)); });
  if (ok) break;
}
const origin = `http://127.0.0.1:${port}`;
// the snap launcher refuses to start from some service cgroups; the binary inside the snap is the same browser
const launch = executablePath => chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const browser = await launch(process.env.CHROMIUM || '/snap/bin/chromium').catch(() => launch('/snap/chromium/current/usr/lib/chromium-browser/chrome'));
let fails = 0;
const check = (name, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };

// ---- the editor's session: 8 shots, 40 s, 0 to 4 takes each, one in the cut, one failed, two shots with nothing yet
const media = {}, file = f => readFileSync(join(root, 'example/media', f)).toString('base64');
const jpg = (id, f) => { media[id] = { type: 'image/jpeg', data: 'data:image/jpeg;base64,' + file(f) }; return id; };
const mp4 = (id, f) => { media[id] = { type: 'video/mp4', data: 'data:video/mp4;base64,' + file(f) }; return id; };
let tn = 0;
const take = (o = {}) => ({ id: 'tk' + (++tn), jobId: 'j' + tn, model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 5, audio: false, seed: '', prompt: 'Slow push-in toward the cave mouth. Torchlight flickers.', start: true, end: false, est: 0.25, cost: 0.25, status: 'completed', created: 1, media: '', error: '', note: '', ...o });
const sec = (id, start, title, shot, o = {}) => ({ id, start, title, shot, notes: '', img: '', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: '', takes: [], ...o });
const sections = [
  sec('s1', 0, 'Dawn over the ridge', 'Wide', { img: jpg('k1', 'key-01.jpg'), vidPrompt: 'Static camera. Mist drifts over the ridge.', takes: [take({ media: mp4('v1b', 'take-03-b.mp4') }), take({ media: mp4('v1a', 'take-04-a.mp4'), modelName: 'Seedance 2.5', model: 'bytedance/seedance-2.5', cost: 0.4 })] }),
  sec('s2', 6, 'Walk to the cave', 'Tracking'),
  sec('s3', 11, 'Cave mouth', 'Push-in', { notes: 'Light from inside.', kind: 'video', img: 'v3d', key: jpg('k3', 'key-03.jpg'), endKey: jpg('e3', 'end-03.jpg'), clipDur: 5, vidPrompt: 'Slow push-in toward the cave mouth. Torchlight flickers.',
    takes: [take({ media: mp4('v3d', 'take-03-a.mp4') }), take({ media: mp4('v3c', 'take-03-b.mp4'), model: 'google/veo-3.1', modelName: 'Veo 3.1', res: '720p', dur: 6, cost: 1.2, prompt: 'Slow push-in toward the cave mouth. Torchlight flickers. No cuts.' }),
      take({ media: mp4('v3b', 'take-03-c.mp4'), model: 'bytedance/seedance-2.5', modelName: 'Seedance 2.5', end: true, cost: 0.4, prompt: 'Push-in, ends on the cave interior frame.' }), take({ media: mp4('v3a', 'take-10-a.mp4'), prompt: 'Static camera. Torchlight flickers on the rock.' })] }),
  sec('s4', 17, 'Trolls gather', 'Medium', { img: jpg('k4', 'key-04.jpg'), takes: [take({ media: mp4('v4a', 'take-04-a.mp4') })] }),
  sec('s5', 21, 'Drum hits', 'Close', { img: jpg('k5', 'key-05.jpg'), vidPrompt: 'The crown shakes on each hit.', takes: [take({ status: 'failed', error: 'The provider returned an error', cost: null }), take({ media: mp4('v5b', 'take-03-c.mp4') }), take({ media: mp4('v5a', 'take-03-b.mp4') })] }),
  sec('s6', 24.5, 'Eyes in the dark', 'ECU', { img: jpg('k6', 'key-06.jpg') }),
  sec('s7', 28, 'The chase', 'Tracking', { img: jpg('k7', 'key-07.jpg'), takes: [take({ media: mp4('v7b', 'take-10-a.mp4') }), take({ media: mp4('v7a', 'take-04-a.mp4') })] }),
  sec('s8', 34, 'The fall', 'Wide', { img: jpg('k8', 'key-08.jpg'), takes: [take({ media: mp4('v8a', 'take-03-c.mp4') })] }),
];
const data = { format: 'cueboard', version: 1, project: { id: 'p-bside', title: 'Mountain King, editor test', created: 1, updated: 1, song: null, refs: [], sections }, media };
// 40 s of a quiet click every half second, as the song (8 kHz, 8 bit, mono)
const wav = (() => { const sr = 8000, n = sr * 40, b = Buffer.alloc(44 + n, 128); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) if (i % (sr / 2) < 80) b[44 + i] = 128 + Math.round(40 * Math.sin(i / 3)); return b; })();

async function open(viewport, phone) {
  const ctx = await browser.newContext(phone ? { viewport, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1' } : { viewport });
  await ctx.route('**/*', r => (r.request().url().startsWith(origin) ? r.continue() : r.abort()));
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', e => { errs.push(String(e)); console.log('PAGEERR', String(e)); });
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 });
  await page.setInputFiles('#importf', { name: 'bside.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await page.waitForFunction(() => /editor test/.test(document.getElementById('projname').textContent), null, { timeout: 20000 });
  await page.setInputFiles('#song', { name: 'click.wav', mimeType: 'audio/wav', buffer: wav });
  await page.waitForFunction(() => __t.hasAudio && __t.audio.readyState >= 1, null, { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.toast.show,.toast:not([hidden])') || true); await page.waitForTimeout(3600);   // the "song loaded" toast is gone
  const shot =async i => { await page.evaluate(i => { if (__t.side !== 'b') __t.setSide('b'); document.querySelectorAll('#bList .bitem')[i].click(); window.scrollTo(0, 0); const sb = document.getElementById('sideB'); sb.scrollTop = 0; }, i); await page.waitForTimeout(700); };
  const snap = (name, full) => page.screenshot({ path: join(out, name + '.png'), fullPage: !!full });
  return { ctx, page, errs, shot, snap };
}
// boxes and facts of side B, in viewport coordinates
const facts = page => page.evaluate(() => {
  const box = e => { if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)], shown = e => !!e.getClientRects().length;
  const cards = qa('#bTakes .take').map(c => { const row = [...c.querySelectorAll('.tbody .row button')].filter(shown);
    return { box: box(c), tv: box(c.querySelector('.tv')), incut: c.classList.contains('incut'), border: getComputedStyle(c).borderTopColor, failed: !!c.querySelector('.tbusy.err'),
      controls: !!c.querySelector('video[controls]'), buttons: row.map(b => ({ act: b.dataset.act, text: b.textContent.trim(), label: b.getAttribute('aria-label') || '', title: b.title, y: Math.round(b.getBoundingClientRect().top), bg: getComputedStyle(b).backgroundColor, box: box(b) })) }; });
  const accent = (() => { const d = document.createElement('i'); d.style.color = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })();
  return { vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, cards, accent, list: box(q('#bList')), bar: box(q('.bbar')), takes: box(q('#bTakes')), gen: box(q('#bGen')), genbox: box(q('#genbox')), go: box(q('#gGo')), prompt: box(q('#bPrompt')),
    fStart: box(q('#fStart')), keys: box(q('#bKeys')), spent: box(q('#bSpent')), conn: box(q('#bConn')), acctInGen: !!q('#bGen #bSpent') && !!q('#bGen #bCredits') && !!q('#bGen #bConn'), acctInBar: !!q('.bbar #bSpent,.bbar #bConn'),
    model: (() => { const s = q('#gModel'); return s && shown(s) ? { w: Math.round(s.getBoundingClientRect().width), sw: s.scrollWidth, cw: s.clientWidth } : null; })(),
    rows: qa('#bList .bitem').map(b => b.querySelector('.bi').innerText.replace(/\s+/g, ' ').trim()) };
});
const inView = (b, f) => !!b && b.x >= 0 && b.y >= 0 && b.r <= f.vw && b.b <= f.vh;
const apart = (a, b) => !a || !b || a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y;

// ================= desktop =================
for (const [w, h] of [[1440, 900], [1280, 720]]) {
  const d = `d${w}`, { ctx, page, errs, shot, snap } = await open({ width: w, height: h });
  await shot(2); await snap(`${d}-shot3-takes`); await snap(`${d}-shot3-full`, true);
  await shot(1); await snap(`${d}-shot2-empty`);
  await shot(4); await snap(`${d}-shot5-failed`);
  if (shotsOnly) { await ctx.close(); continue; }

  // 1. takes first, the generator beside them
  await shot(2);
  let f = await facts(page);
  const done = f.cards.filter(c => !c.failed);
  check(`${d} 1 no sideways scroll`, f.sw <= f.vw, `${f.sw} <= ${f.vw}`);
  check(`${d} 1 the takes start right under the shot header`, f.takes.y - f.bar.b <= 20 && f.takes.y < 200, `takes y=${f.takes.y}, header bottom=${f.bar.b}`);
  check(`${d} 1 all 4 pictures of shot 3 are on the first screen`, done.length === 4 && done.every(c => inView(c.tv, f)), JSON.stringify(done.map(c => [c.tv.y, c.tv.b])));
  check(`${d} 1 the prompt and Generate are on the same screen as the takes`, inView(f.go, f) && inView(f.prompt, f), `go ${JSON.stringify(f.go)}`);
  check(`${d} 1 three columns, tops aligned, none overlapping`, Math.abs(f.list.y - f.bar.y) <= 1 && Math.abs(f.gen.y - f.bar.y) <= 1 && f.list.r < f.takes.x && f.takes.r < f.gen.x && apart(f.takes, f.gen), `tops ${f.list.y}/${f.bar.y}/${f.gen.y}`);
  check(`${d} 1 the generator panel ends inside the window`, f.gen.b <= f.vh && f.gen.r <= f.vw, `bottom ${f.gen.b} of ${f.vh}`);
  const sc = await page.evaluate(() => { const g = document.getElementById('bGen'); return [g.scrollHeight, g.clientHeight]; });
  if (h >= 900) check(`${d} 1 at 900 px tall the whole panel shows without scrolling`, sc[0] <= sc[1], `${sc[0]} in ${sc[1]}`);
  check(`${d} 1 frame rows: at most 2 lines of buttons each`, await page.evaluate(() => [...document.querySelectorAll('#bGen .frame')].every(fr => new Set([...fr.querySelectorAll(':scope>.row>:is(button,label)')].filter(b => b.getClientRects().length).map(b => Math.round(b.getBoundingClientRect().top))).size <= 2)));
  check(`${d} 1 Generate row: price and button on one line`, await page.evaluate(() => Math.abs(document.getElementById('gEst').getBoundingClientRect().bottom - document.getElementById('gGo').getBoundingClientRect().bottom) < 12));
  check(`${d} 1 the Model select shows its whole name`, f.model && f.model.w >= 180, JSON.stringify(f.model));
  await shot(1);
  let e = await facts(page);
  check(`${d} 1 a shot with no takes: the generator is still on screen`, inView(e.go, e) && inView(e.fStart, e));

  // 2. take cards: small, one labelled button, the rest icons in one row; orange only on the take in the cut
  check(`${d} 2 at least 2 takes per row, cards at most 380 px wide`, done[0].box.y === done[1].box.y && done.every(c => c.box.w <= 380 && c.box.w >= 280), done.map(c => c.box.w).join(','));
  check(`${d} 2 no native player controls`, f.cards.every(c => !c.controls));
  check(`${d} 2 each card: buttons on one line, inside the card`, done.every(c => new Set(c.buttons.map(b => b.y)).size <= 2 && Math.max(...c.buttons.map(b => b.box.b)) - Math.min(...c.buttons.map(b => b.y)) <= 30 && c.buttons.every(b => b.box.r <= c.box.r && b.box.x >= c.box.x)), JSON.stringify(done.map(c => c.buttons.map(b => b.y))));
  check(`${d} 2 each card: exactly one labelled button`, done.every(c => c.buttons.filter(b => b.text).length === 1), JSON.stringify(done.map(c => c.buttons.filter(b => b.text).map(b => b.text))));
  check(`${d} 2 every icon button has a name and a tooltip`, done.every(c => c.buttons.filter(b => !b.text).every(b => b.label && b.title)));
  check(`${d} 2 old names kept on the icon buttons`, ['Remove from cut', 'Last frame → next shot', 'Reframe', 'Download', 'Delete'].every(n => done[0].buttons.some(b => b.label === n)), done[0].buttons.map(b => b.label || b.text).join(' | '));
  check(`${d} 2 the take in the cut has the orange edge, the others don't`, done.filter(c => c.incut).length === 1 && done.every(c => (c.border === f.accent) === c.incut), done.map(c => c.border).join(' '));
  check(`${d} 2 "Use in cut" is not orange`, done.filter(c => !c.incut).every(c => c.buttons.find(b => b.act === 'use').bg !== f.accent));
  await shot(4);
  let g = await facts(page);
  const bad = g.cards.find(c => c.failed), good = g.cards.find(c => !c.failed);
  check(`${d} 2 a failed take has no black picture`, bad && bad.tv.h <= 60 && good.tv.h > 150, `failed ${bad && bad.tv.h} px, done ${good.tv.h} px`);
  // two-step delete keeps its icon
  await page.click('#bTakes .take:not(:has(.tbusy.err)) [data-act="del"]'); await page.waitForTimeout(100);
  const armed = await page.textContent('#bTakes [data-armed="1"]');
  await page.waitForTimeout(2900);
  check(`${d} 2 Delete arms ("${armed}") and goes back to its icon`, armed === 'Tap again' && await page.evaluate(() => !document.querySelector('#bTakes [data-armed="1"]') && !!document.querySelector('#bTakes .take:not(:has(.tbusy.err)) [data-act="del"] svg')));

  // 3. a take plays with the song, inside side B, and stops at the end of the shot
  await shot(4);   // 3.5 s slot
  const t0 = await page.evaluate(() => __t.now), sel0 = await page.evaluate(() => __t.selId);
  await page.click('#bTakes .take:not(:has(.tbusy.err)) video[data-act="pv"]'); await page.waitForTimeout(900);
  const p1 = await page.evaluate(() => { const v = document.querySelector('#bTakes .take.playing video'); return { v: !!v && !v.paused, vt: v ? v.currentTime : -1, a: !__t.audio.paused, at: __t.audio.currentTime, side: __t.side }; });
  check(`${d} 3 click: the take and the song play together, on side B`, p1.v && p1.a && p1.side === 'b' && p1.at >= 21 && p1.at < 24.5 && p1.vt > 0.2, JSON.stringify(p1));
  await page.waitForFunction(() => __t.audio.paused, null, { timeout: 6000 });
  const p2 = await page.evaluate(() => ({ v: [...document.querySelectorAll('#bTakes video')].every(v => v.paused), playing: !!document.querySelector('.take.playing'), now: __t.now, sel: __t.selId, side: __t.side }));
  check(`${d} 3 it stops at the end of the shot; shot and playhead are where they were`, p2.v && !p2.playing && p2.sel === sel0 && Math.abs(p2.now - t0) < 0.05 && p2.side === 'b', JSON.stringify({ ...p2, t0 }));
  // "Play in cut" while a take plays: the take stops, and side A plays on past the shot's end without jumping back
  await shot(4);
  await page.click('#bTakes .take:not(:has(.tbusy.err)) video[data-act="pv"]'); await page.waitForTimeout(400);
  await page.evaluate(() => __t.setSide('a')); await page.waitForTimeout(300);
  const p3 = await page.evaluate(() => ({ a: __t.audio.paused, playing: !!document.querySelector('.take.playing'), now: __t.now }));
  check(`${d} 3 leaving side B stops the take and the song, playhead back`, p3.a && !p3.playing && Math.abs(p3.now - t0) < 0.05, JSON.stringify(p3));
  await shot(4);
  // the pointer across a card scrubs it
  const vb = await page.locator('#bTakes .take:not(:has(.tbusy.err)) .tv').first().boundingBox();
  await page.mouse.move(vb.x + vb.width * 0.1, vb.y + vb.height / 2); await page.waitForTimeout(250);
  const sA = await page.evaluate(() => document.querySelector('#bTakes .take:not(:has(.tbusy.err)) video').currentTime);
  await page.mouse.move(vb.x + vb.width * 0.9, vb.y + vb.height / 2); await page.waitForTimeout(250);
  const sB = await page.evaluate(() => { const v = document.querySelector('#bTakes .take:not(:has(.tbusy.err)) video'); return [v.currentTime, v.duration, v.paused]; });
  check(`${d} 3 the pointer across a take scrubs it`, sB[0] > sA + 1 && sB[2], `${sA.toFixed(2)} s -> ${sB[0].toFixed(2)} s of ${sB[1].toFixed(2)} s`);
  await page.mouse.move(5, 5);

  // 4. keyboard: [ ] shot, arrows take, Space play, Enter use in cut, ? shortcuts; the hint row
  await shot(0);
  const selIdx = () => page.evaluate(() => [...document.querySelectorAll('#bList .bitem')].findIndex(b => b.classList.contains('sel')));
  await page.keyboard.press(']'); await page.keyboard.press(']'); await page.waitForTimeout(300);
  const k1 = await selIdx(); await page.keyboard.press('['); await page.waitForTimeout(200); const k2 = await selIdx();
  check(`${d} 4 ] and [ change the shot`, k1 === 2 && k2 === 1, `${k1}, ${k2}`);
  await page.keyboard.press(']'); await page.waitForTimeout(400);   // shot 3
  const focusNo = () => page.evaluate(() => { const c = document.activeElement.closest && document.activeElement.closest('#bTakes .take'); return c ? [...document.querySelectorAll('#bTakes .take')].indexOf(c) : -1; });
  await page.keyboard.press('ArrowRight'); const a1 = await focusNo(); await page.keyboard.press('ArrowRight'); const a2 = await focusNo(); await page.keyboard.press('ArrowRight'); const a3 = await focusNo(); await page.keyboard.press('ArrowLeft'); const a4 = await focusNo();
  check(`${d} 4 arrows walk the takes, starting on the one in the cut`, a1 === 0 && a2 === 1 && a3 === 2 && a4 === 1, [a1, a2, a3, a4].join(','));
  const ring = await page.evaluate(() => { const c = document.activeElement, s = getComputedStyle(c); return s.outlineStyle + ' ' + s.outlineWidth; });
  check(`${d} 4 the focused take shows a ring`, /solid/.test(ring) && parseFloat(ring.split(' ')[1]) >= 2, ring);
  await page.keyboard.press('Space'); await page.waitForTimeout(700);
  const sp1 = await page.evaluate(() => ({ card: [...document.querySelectorAll('#bTakes .take')].findIndex(c => c.classList.contains('playing')), a: !__t.audio.paused, at: __t.audio.currentTime }));
  await page.keyboard.press('Space'); await page.waitForTimeout(300);
  const sp2 = await page.evaluate(() => ({ playing: !!document.querySelector('.take.playing'), a: !__t.audio.paused }));
  check(`${d} 4 Space plays the focused take with the song, Space again stops it`, sp1.card === 1 && sp1.a && sp1.at >= 11 && sp1.at < 17 && !sp2.playing && !sp2.a, JSON.stringify([sp1, sp2]));
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const en = await page.evaluate(() => { const s = __t.S()[2]; return { img: s.img, want: s.takes[1].media, kind: s.kind, focus: [...document.querySelectorAll('#bTakes .take')].indexOf(document.activeElement), incut: [...document.querySelectorAll('#bTakes .take')].findIndex(c => c.classList.contains('incut')) }; });
  check(`${d} 4 Enter puts the focused take in the cut and keeps the focus on it`, en.img === en.want && en.kind === 'video' && en.focus === 1 && en.incut === 1, JSON.stringify(en));
  f = await facts(page);
  check(`${d} 4 list says which take is in the cut now`, /take 3 in cut/.test(f.rows[2]), f.rows[2]);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check(`${d} 4 undo puts the first take back`, await page.evaluate(() => __t.S()[2].img === __t.S()[2].takes[0].media));
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('?'); await page.waitForTimeout(300);
  const dlg = await page.evaluate(() => ({ open: document.getElementById('dlgKeys').open, b: !!document.getElementById('kTakes') && document.getElementById('kTakes').getClientRects().length > 0 }));
  await snap(`${d}-shortcuts`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(`${d} 4 ? opens the shortcuts on side B, with side B's keys in it`, dlg.open && dlg.b);
  // typing in the prompt is still typing
  await page.click('#bPrompt'); await page.keyboard.type(' ]['); await page.keyboard.press('Space');
  check(`${d} 4 keys typed in the prompt stay in the prompt`, (await selIdx()) === 2 && /\]\[ $/.test(await page.inputValue('#bPrompt')) && await page.evaluate(() => __t.audio.paused));
  await page.keyboard.press('Control+z'); await page.evaluate(() => document.activeElement.blur());
  check(`${d} 4 the hint row is there, under the takes, 5 hints`, f.keys && f.keys.y >= f.takes.b && f.keys.x === f.takes.x && await page.evaluate(() => document.querySelectorAll('#bKeys>*').length) === 5, JSON.stringify(f.keys));

  // 5. the shot list as a to-do list
  f = await facts(page);
  check(`${d} 5 shot 3: which take is in the cut`, /4 takes · take 4 in cut/.test(f.rows[2]), f.rows[2]);
  check(`${d} 5 shot 1: nothing in the cut`, /2 takes · nothing in cut/.test(f.rows[0]), f.rows[0]);
  check(`${d} 5 shot 2: no takes, no start frame`, /no takes/.test(f.rows[1]) && /no start frame/.test(f.rows[1]), f.rows[1]);
  check(`${d} 5 shot 5: one failed`, /3 takes · nothing in cut/.test(f.rows[4]) && /1 failed/.test(f.rows[4]), f.rows[4]);
  check(`${d} 5 shot 6 (start frame, no takes): nothing extra`, /no takes$/.test(f.rows[5]), f.rows[5]);

  // 6. the file name carries the number on the card
  await shot(2);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#bTakes .take:nth-child(1) [data-act="dl"]')]);
  check(`${d} 6 take 4 of shot 03 downloads as …-shot03-take4-wan-30.mp4`, /-shot03-take4-wan-30\.mp4$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#bTakes .take:nth-child(4) [data-act="dl"]')]);
  check(`${d} 6 take 1 downloads as …-take1-…`, /-shot03-take1-wan-30\.mp4$/.test(dl2.suggestedFilename()), dl2.suggestedFilename());

  // 7. spend, credits and the connection sit with the generator, not in the shot header
  f = await facts(page);
  check(`${d} 7 spend, credits and API status are in the generator panel`, f.acctInGen && !f.acctInBar && !!f.spent && !!f.conn && f.conn.x >= f.gen.x && f.conn.r <= f.gen.r, JSON.stringify(f.conn));
  check(`${d} 7 the shot header is title, time and notes only`, f.bar.h <= 110 && f.bar.r <= f.gen.x, `${f.bar.h} px tall`);
  check(`${d} no script errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ================= phone =================
for (const [w, h] of [[390, 844], [375, 667]]) {
  const d = `p${w}`, { ctx, page, errs, shot, snap } = await open({ width: w, height: h }, true);
  await page.evaluate(() => __t.setSide('b')); await page.waitForTimeout(500);
  const pick = async i => { await page.evaluate(i => { document.querySelectorAll('#bList .bitem')[i].click(); document.getElementById('sideB').scrollTop = 0; }, i); await page.waitForTimeout(700); };
  await pick(2); await snap(`${d}-shot3`);
  // the whole Takes side, scrolled: the page itself doesn't scroll on the phone, #sideB does
  const sbH = await page.evaluate(() => document.getElementById('sideB').scrollHeight);
  await page.evaluate(() => { document.getElementById('sideB').scrollTop = 420; }); await page.waitForTimeout(300); await snap(`${d}-shot3-scrolled`);
  await page.evaluate(() => { document.getElementById('sideB').scrollTop = 0; });
  await pick(4); await snap(`${d}-shot5-failed`);
  if (shotsOnly) { console.log(`${d} side B scroll height ${sbH}`); await ctx.close(); continue; }
  await pick(2);
  const f = await facts(page);
  const done = f.cards.filter(c => !c.failed);
  check(`${d} 8 no sideways scroll`, f.sw <= f.vw, `${f.sw} <= ${f.vw}`);
  check(`${d} 8 the takes come before the frames`, f.takes.y < f.fStart.y && f.takes.y > f.bar.b, `header ends ${f.bar.b}, takes y=${f.takes.y}, frames y=${f.fStart.y}`);
  check(`${d} 8 the first take's picture starts on the first screen`, done[0].tv.y < f.vh, `y=${done[0].tv.y} of ${f.vh}`);
  check(`${d} 8 native player controls stay on the phone`, done.every(c => c.controls));
  check(`${d} 8 each card: buttons on one line, inside the card, 36 px tall or more`, done.every(c => new Set(c.buttons.map(b => b.y)).size === 1 && c.buttons.every(b => b.box.r <= c.box.r && b.box.h >= 36)), JSON.stringify(done.map(c => c.buttons.map(b => [b.y, b.box.h]))));
  check(`${d} 8 no generator, no hint row; the spend line is under the header`, !f.genbox && !f.keys && !!f.spent && f.spent.y < f.takes.y && f.spent.y > f.bar.y, JSON.stringify(f.spent));
  check(`${d} 8 the rail keeps its short text`, /^03 4 takes · in cut$/.test(f.rows[2]) && /^02 no takes$/.test(f.rows[1]), JSON.stringify(f.rows.slice(1, 3)));
  check(`${d} no script errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close(); srv.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
