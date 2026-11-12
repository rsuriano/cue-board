// The phone redesign, direction B (docs/specs/mobile-redesign-b.md): one check per approval criterion, 1 to 11 and 15,
// plus the hostile cases of the task (a tap during a drag, a pinch that scrolls the page, rotation mid-drag, mid-playback
// and with a sheet open, a remote delete of the selected shot, an armed Delete and a selection change, a save error
// with the sheet closed, long names). Criteria 12 to 14 are the existing desktop, phone and collaboration checks.
//   node design/run-local.mjs design/mobile-b-check.mjs <repo-root> <out-dir>
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { start, touch, state, toShot, tapTile, overflow, sleep } from './mobile-b-lib.mjs';

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const H = await start(root);
const results = [];
const check = (name, ok, ev = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ev ? ' · ' + ev : ''}`); };
const guard = async (name, fn) => { try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, String(e).split('\n')[0]); } };
const ONLY = process.argv[4] || '';   // a part to run alone: a size ("390x844"), "land", "desk" or "server"
const SIZES = [[390, 844], [390, 667], [430, 932], [360, 640]].filter(s => !ONLY || ONLY === s.join('x'));
const BAR = { none: 'mtUndo|mtCut|mtTip', shot: 'mtUndo|mtCut|mtDet|mtImg|mtMove|mtMore', cut: 'mtMinus|mtRead|mtPlus|mtDone' };
const bar = async page => (await state(page)).bar.join('|');

// every control a finger could press right now: shown, inside the viewport and not covered by something else
const controls = page => page.evaluate(() => {
  const q = 'button,a[href],select,input:not([type=file]),textarea,label.btn,[role=slider],[role=tab],summary';
  return [...document.querySelectorAll(q)].filter(e => { if (!e.getClientRects().length || getComputedStyle(e).visibility === 'hidden' || e.disabled && !e.id) return false;
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const top = document.elementFromPoint(x, y); return !!top && (e.contains(top) || top.contains(e)); })
    .map(e => { const r = e.getBoundingClientRect(), af = getComputedStyle(e, '::after'), hit = af.content !== 'none' && af.position === 'absolute' ? parseFloat(af.height) || 0 : 0; return { id: e.id || (e.dataset.side ? 'tab-' + e.dataset.side : e.dataset.mk ? 'mk-' + e.dataset.mk : e.className || e.tagName), tl: !!e.closest('.timeline'), w: Math.round(r.width), h: Math.round(Math.max(r.height, hit)), x: Math.round(r.left), y: Math.round(r.top), b: Math.round(r.bottom) }; });
});
const shown = (page, sel) => page.evaluate(sel => [...document.querySelectorAll(sel)].some(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'), sel);
const rect = (page, sel) => page.evaluate(sel => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
// text blocks that must not touch each other: [selector…] → the pairs that intersect
const hits = (page, sels) => page.evaluate(sels => { const rs = sels.flatMap(s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length && e.textContent.trim()).map(e => { const g = document.createRange(); g.selectNodeContents(e); const r = g.getBoundingClientRect(); const b = e.getBoundingClientRect(); return { s, x: Math.max(r.left, b.left), y: Math.max(r.top, b.top), r: Math.min(r.right, b.right), b: Math.min(r.bottom, b.bottom) }; }));
  const o = []; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const A = rs[i], B = rs[j]; if (A.x < B.r - .5 && B.x < A.r - .5 && A.y < B.b - .5 && B.y < A.b - .5) o.push(A.s + ' × ' + B.s); } return o; }, sels);
const setRatio = (page, r) => page.evaluate(r => { const s = document.getElementById('mFrame'); s.value = r; s.dispatchEvent(new Event('change', { bubbles: true })); }, r);

for (const [w, h] of SIZES) await guard(`${w}x${h}`, async () => {
  const tag = `${w}x${h}`, { ctx, page, errs } = await H.open([w, h]);
  await toShot(page, 2);
  /* ---- 1 · the always-visible controls ---- */
  let c = await controls(page);
  const names = c.filter(x => !x.tl).map(x => x.id).sort().join('|');
  check(`1 · ${tag}: nothing selected, the controls are the top row (project, Cut, Takes, Report, Settings), Undo and Cut here: 7, plus the picture`, names === 'mtCut|mtUndo|proj|reportb|settingsb|tab-a|tab-b' && await shown(page, '#monitor'), names);
  check(`1 · ${tag}: inside the timeline only its own handles (cut grips, the two range handles)`, c.filter(x => x.tl).every(x => /^(grip|mk-in|mk-out)$/.test(x.id)), c.filter(x => x.tl).map(x => x.id).join('|'));
  const gone = await page.evaluate(() => { const v = s => [...document.querySelectorAll(s)].some(e => e.getClientRects().length > 0); const tabs = document.getElementById('mTabs').getBoundingClientRect();
    return { transport: v('.transport,.transport *'), peek: v('.m-peekb'), zoom: v('#zin,#zout,#zfit'), tabsAtBottom: tabs.top > innerHeight / 2, oneRow: tabs.bottom <= document.querySelector('.top').getBoundingClientRect().bottom + 1 && Math.abs(tabs.top + tabs.height / 2 - (document.getElementById('proj').getBoundingClientRect().top + document.getElementById('proj').getBoundingClientRect().height / 2)) < 3 }; });
  check(`1 · ${tag}: no transport row, peek row, zoom buttons or bottom tab bar; Cut / Takes sit in the top row`, !gone.transport && !gone.peek && !gone.zoom && !gone.tabsAtBottom && gone.oneRow, JSON.stringify(gone));
  check(`1 · ${tag}: the bar is Undo, Cut here (the wide one) and a hint`, await bar(page) === BAR.none && await page.evaluate(() => document.getElementById('mtCut').getBoundingClientRect().width > document.getElementById('mtUndo').getBoundingClientRect().width * 1.5 && /Cut here/.test(document.getElementById('mtCut').textContent) && !!document.querySelector('#mtCut .ico')), await bar(page));

  /* ---- 7 · sizes ---- */
  const mon = await rect(page, '#monitor'), tlr = await rect(page, '.timeline'), tool = await rect(page, '#mTool'), fr = await rect(page, '#mframe');
  check(`7 · ${tag}: the 16:9 picture is the full width with no bars (${w}x${Math.round(w * 9 / 16)})`, mon && fr && Math.abs(fr.w - w) < 1 && Math.abs(fr.h - w * 9 / 16) < 1.5 && Math.abs(mon.h - fr.h) < 1.5, JSON.stringify(fr));
  const minTl = h === 844 ? 330 : h === 667 ? 190 : 150;
  check(`7 · ${tag}: the timeline fills the rest, at least ${minTl}px`, tlr && tlr.h >= minTl && Math.abs(tlr.b - tool.y) < 2 && Math.abs(tlr.y - mon.b) < 4, tlr && `${Math.round(tlr.h)}px, monitor ${Math.round(mon.h)}px, bar ${Math.round(tool.h)}px`);
  check(`7 · ${tag}: the bar is 60px (plus the safe area) at the bottom edge`, tool && Math.abs(tool.h - 60) < 1.5 && Math.abs(tool.b - h) < 1, JSON.stringify(tool));
  if (w === 390 && h === 844) console.log(`MEASURED 390x844: picture ${Math.round(fr.w)}x${Math.round(fr.h)}, timeline ${Math.round(tlr.h)}px, always-visible controls ${c.filter(x => !x.tl).length} (+ the picture)`);
  await setRatio(page, '9:16'); await sleep(300);
  const fr9 = await rect(page, '#mframe'), tl9 = await rect(page, '.timeline');
  check(`7 · ${tag}: a 9:16 picture is at least 50% of the screen height, the timeline keeps 150px`, fr9.h >= h * .5 && Math.abs(fr9.w / fr9.h - 9 / 16) < .01 && tl9.h >= 150, `${Math.round(fr9.w)}x${Math.round(fr9.h)} = ${Math.round(fr9.h / h * 100)}%, timeline ${Math.round(tl9.h)}px`);
  if (w === 390 && h === 844) console.log(`MEASURED 390x844 9:16: picture ${Math.round(fr9.w)}x${Math.round(fr9.h)} (${Math.round(fr9.h / h * 100)}%), timeline ${Math.round(tl9.h)}px`);
  await setRatio(page, '16:9'); await sleep(300);

  /* ---- 2 · tap the picture ---- */
  const glyph = () => page.evaluate(() => { const g = document.getElementById('mPlayG'); return !!g && g.getClientRects().length > 0 && +getComputedStyle(g).opacity > .5; });
  const timeTxt = () => page.evaluate(() => (document.getElementById('mTime') || {}).textContent || '');
  const t0 = await timeTxt(), g0 = await glyph(), tm = await rect(page, '#mTime');
  check(`2 · ${tag}: paused, the play glyph is centred on the picture and the time reads current / total on its lower edge (mono, tabular)`, g0 && /^\d+:\d\d\.\d \/ \d+:\d\d\.\d/.test(t0) && tm && tm.b <= fr.b + 1 && tm.y > fr.y + fr.h / 2
    && await page.evaluate(() => { const g = document.getElementById('mPlayG').getBoundingClientRect(), f = document.getElementById('mframe').getBoundingClientRect(), cs = getComputedStyle(document.getElementById('mTime'));
      return Math.abs(g.left + g.width / 2 - (f.left + f.width / 2)) < 2 && Math.abs(g.top + g.height / 2 - (f.top + f.height / 2)) < 2 && /Mono/.test(cs.fontFamily) && /tabular-nums/.test(cs.fontVariantNumeric); }), t0);
  await page.touchscreen.tap(mon.x + mon.w / 2, mon.y + mon.h * .3); await sleep(900);
  let s = await state(page); const t1 = await timeTxt(), g1 = await glyph();
  check(`2 · ${tag}: a tap on the picture plays; the time moves; the glyph is gone`, !s.paused && t1 !== t0 && !g1, `${t0} → ${t1}`);
  await page.touchscreen.tap(mon.x + mon.w / 2, mon.y + mon.h * .3); await sleep(500);
  s = await state(page);
  check(`2 · ${tag}: a second tap pauses; the glyph is back`, s.paused && await glyph());

  /* ---- 3 · the bar's three states ---- */
  await toShot(page, 2); await tapTile(page);
  check(`3 · ${tag}: tapping a shot swaps the bar to Undo, Cut here, Details, Photo, Move, More`, await bar(page) === BAR.shot, await bar(page));
  check(`3 · ${tag}: six equal tools, icon and label each, none clipped`, await page.evaluate(() => { const b = [...document.querySelectorAll('#mTool > button')].filter(e => e.getClientRects().length); const ws = b.map(e => Math.round(e.getBoundingClientRect().width));
    return b.length === 6 && Math.max(...ws) - Math.min(...ws) <= 1 && b.every(e => e.querySelector('.ico') && e.textContent.trim() && e.scrollWidth <= e.clientWidth + 1); }));
  c = await controls(page);
  const small = c.filter(x => x.w < 44 || x.h < 44);
  check(`11 · ${tag}: every control on the Cut side is at least 44px (a shot selected)`, !small.length, JSON.stringify(small));
  check(`11 · ${tag}: no horizontal overflow; the bar's and the top row's labels do not touch`, await overflow(page) <= 0 && !(await hits(page, ['#projname', '#mTabs button', '#mTool > button:not([hidden]) span'])).length, (await hits(page, ['#projname', '#mTabs button', '#mTool > button:not([hidden]) span'])).join(', '));
  check(`11 · ${tag}: on the picture, the slate's lines and the time do not touch`, !(await hits(page, ['#slate > *', '#mTime'])).length, (await hits(page, ['#slate > *', '#mTime'])).join(', '));
  if (h === 844) await page.screenshot({ path: join(out, `check-${tag}-shot.png`) });
  const grip = await page.evaluate(() => { const b = [...document.querySelectorAll('#mGrips .grip:not([hidden])')].filter(g => g.getBoundingClientRect().left > 8 && g.getBoundingClientRect().right < innerWidth - 8)[0]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, i: +b.dataset.i }; });
  await page.touchscreen.tap(grip.x, grip.y); await sleep(250);
  check(`3 · ${tag}: tapping a cut swaps the bar to −0.1 s, the cut's time and both lengths, +0.1 s, Done`, await bar(page) === BAR.cut && /^\d+:\d\d\.\d.*is .* s · .* is .* s/.test(await page.textContent('#mtRead')), await bar(page) + ' ' + await page.textContent('#mtRead'));
  let a = await state(page); await page.tap('#mtPlus'); await sleep(150); let b = await state(page);
  check(`3 · ${tag}: +0.1 s moves that cut by 0.1 s`, Math.abs(b.starts[grip.i] - a.starts[grip.i] - .1) < .011, `${a.starts[grip.i]} → ${b.starts[grip.i]}`);
  await page.tap('#mtDone'); await sleep(150);
  check(`3 · ${tag}: Done goes back to the shot's tools`, await bar(page) === BAR.shot, await bar(page));
  await toShot(page, 2); await tapTile(page);
  check(`3 · ${tag}: tapping the selected shot again deselects: Undo and Cut here`, await bar(page) === BAR.none, await bar(page));
  await tapTile(page); a = await state(page);
  await page.touchscreen.tap(a.cv.x + a.cv.w * .5 + 6, a.wave); await sleep(250);
  check(`3 · ${tag}: a tap on the waveform deselects too`, await bar(page) === BAR.none, await bar(page));

  /* ---- 6 · range handles and Clear ---- */
  const grabbable = () => page.evaluate(() => [...document.querySelectorAll('.mkgrip')].map(g => { const r = g.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return { k: g.dataset.mk, on: x >= 0 && x <= innerWidth, top: x >= 0 && x <= innerWidth ? document.elementFromPoint(x, y) === g : null, w: r.width, h: r.height }; }));
  await page.evaluate(() => { document.getElementById('tl-scroll').scrollLeft = 0; }); await sleep(300); let gr = await grabbable();
  await page.evaluate(() => { const sc = document.getElementById('tl-scroll'); sc.scrollLeft = sc.scrollWidth; }); await sleep(300); let gr2 = await grabbable();
  check(`6 · ${tag}: at rest both range handles are 44px and nothing covers them (start of the song, end of the song)`, gr.find(x => x.k === 'in').top === true && gr2.find(x => x.k === 'out').top === true && [...gr, ...gr2].every(x => x.w >= 44 && x.h >= 44 && x.top !== false) && await page.$eval('#mkClear', e => e.hidden), JSON.stringify([gr, gr2]));
  // labels under the place Clear takes: some with no selection, none once Clear is there
  await toShot(page, 2);
  const lit = () => page.evaluate(() => { const c = document.getElementById('tl'), g = c.getContext('2d'), d = devicePixelRatio, b = c.getBoundingClientRect(), k = document.getElementById('mkClear'), was = k.hidden; k.hidden = false; const r = k.getBoundingClientRect(); k.hidden = was;
    const px = g.getImageData(Math.round((r.left - b.left) * d), 0, Math.round(r.width * d), Math.round(r.height * d)).data; let n = 0; for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - px[0]) + Math.abs(px[i + 1] - px[1]) + Math.abs(px[i + 2] - px[2]) > 40) n++; return { n, right: Math.round(innerWidth - r.right), y: Math.round(r.top - b.top), h: Math.round(r.height), w: Math.round(r.width) }; });
  let l0 = await lit();
  for (let k = 0; k < 12 && !l0.n; k++) { await page.evaluate(() => { document.getElementById('tl-scroll').scrollLeft += 9; }); await sleep(120); l0 = await lit(); }
  await page.evaluate(() => { const A = window.__CUE_MEDIA_TEST.app, t = document.getElementById('audio').currentTime; A.ioSet('in', t - 4); A.ioSet('out', t - 1); }); await sleep(250);
  const l1 = await lit(), clr = await rect(page, '#mkClear'); gr = await grabbable();
  check(`6 · ${tag}: Clear appears only with a selection, at the ruler's right end, in the ruler row, 44px`, clr && l1.right <= 12 && l1.y === 0 && l1.h >= 44 && l1.w >= 44 && /Clear/.test(await page.textContent('#mkClear')), JSON.stringify(l1));
  check(`6 · ${tag}: Clear covers no ruler label (labels were drawn there without it: ${l0.n} px; with it: ${l1.n})`, l0.n > 0 && l1.n === 0, JSON.stringify([l0.n, l1.n]));
  check(`6 · ${tag}: with a selection both handles are still what a finger grabs`, gr.filter(x => x.on).length === 2 && gr.every(x => x.top !== false), JSON.stringify(gr));
  const stack = await page.evaluate(() => { const c = document.getElementById('mkClear').getBoundingClientRect(), g = document.querySelector('.mkgrip[data-mk="out"]'), was = g.style.left, box = g.parentElement.getBoundingClientRect(); g.style.left = (c.left + c.width / 2 - box.left) + 'px';
    const top = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2) === g; g.style.left = was; return top; });
  check(`6 · ${tag}: a handle passing behind Clear is still the thing a finger grabs`, stack);
  await page.tap('#mkClear'); await sleep(200);
  check(`6 · ${tag}: Clear removes the selection and goes away`, await page.$eval('#mkClear', e => e.hidden) && await page.evaluate(() => { const m = window.__CUE_MEDIA_TEST.app.io(); return m.in == null && m.out == null; }));

  /* ---- 5 · pinch and double-tap ---- */
  await toShot(page, 4); a = await state(page);
  const cx = a.cv.x + a.cv.w * .7, tAt = st => (st.left - st.cv.w / 2 + (cx - st.cv.x)) / st.P, ta = tAt(a);
  await touch(page, [[[cx - 20, a.wave], [cx + 20, a.wave]], [[cx - 80, a.wave], [cx + 80, a.wave]]], { steps: 10 }); await sleep(300);
  b = await state(page);
  const ph = await page.evaluate(() => { const p = document.getElementById('ph').getBoundingClientRect(), c = document.getElementById('tl').getBoundingClientRect(); return Math.abs(p.left + p.width / 2 - (c.left + c.width / 2)); });
  const pg = await page.evaluate(() => ({ y: scrollY, x: scrollX, scale: visualViewport.scale, top: document.querySelector('.top').getBoundingClientRect().top }));
  check(`5 · ${tag}: a pinch out zooms the timeline in (px per second up)`, b.P > a.P * 2, `${a.P.toFixed(1)} → ${b.P.toFixed(1)} px/s`);
  check(`5 · ${tag}: around the pinch centre: the time under the fingers stays there (±0.4 s); the playhead stays centred`, Math.abs(tAt(b) - ta) < .4 && ph <= 2, `${ta.toFixed(2)} s → ${tAt(b).toFixed(2)} s, playhead off centre by ${ph.toFixed(1)}px`);
  check(`hostile · ${tag}: the pinch neither scrolls nor zooms the page`, pg.y === 0 && pg.x === 0 && pg.scale === 1 && pg.top === 0 && await overflow(page) <= 0, JSON.stringify(pg));
  await touch(page, [[[cx - 90, b.wave], [cx + 90, b.wave]], [[cx - 30, b.wave], [cx + 30, b.wave]]], { steps: 10 }); await sleep(300);
  const b2 = await state(page);
  check(`5 · ${tag}: a pinch in zooms out`, b2.P < b.P * .6, `${b.P.toFixed(1)} → ${b2.P.toFixed(1)} px/s`);
  const rx = await page.evaluate(() => { const c = document.getElementById('tl').getBoundingClientRect(); for (const k of [.3, .2, .4, .6, .1]) { const x = c.left + c.width * k; if (document.elementFromPoint(x, c.top + 20) === document.getElementById('tl')) return x; } return null; });
  await page.touchscreen.tap(rx, a.cv.y + 20); await sleep(60); await page.touchscreen.tap(rx, a.cv.y + 20); await sleep(400);
  const f = await state(page);
  check(`5 · ${tag}: a double tap on the ruler fits the whole song`, Math.abs(f.P - f.cv.w / f.d) < .05, `${f.P.toFixed(2)} px/s, fit is ${(f.cv.w / f.d).toFixed(2)}`);
  await touch(page, [[[cx - 20, a.wave], [cx + 20, a.wave]], [[cx - 90, a.wave], [cx + 90, a.wave]]], { steps: 10 }); await sleep(300);

  /* ---- 4 · the More sheet ---- */
  await toShot(page, 3); await tapTile(page); if (await bar(page) !== BAR.shot) await tapTile(page);
  await page.tap('#mtMore').catch(() => {}); await sleep(350);
  const more = await page.evaluate(() => { const d = document.getElementById('mMore'); if (!d || !d.open) return null; const bs = [...d.querySelectorAll('button')].filter(e => e.getClientRects().length && !e.hasAttribute('data-close')), last = bs[bs.length - 1], prev = bs[bs.length - 2];
    return { ids: bs.map(e => e.id).join('|'), gap: Math.round(last.getBoundingClientRect().top - prev.getBoundingClientRect().bottom), rowGap: Math.round(bs[1].getBoundingClientRect().top - bs[0].getBoundingClientRect().bottom), undoIn: !!d.querySelector('#mtUndo,[id*=Undo]'), small: bs.filter(e => e.getBoundingClientRect().height < 44).length, head: d.querySelector('h3').textContent }; });
  check(`4 · ${tag}: More opens a sheet for the shot: Loop this shot, Playback speed, then Delete shot last and apart`, more && more.ids === 'mmLoop|mmSpeed|mmDel' && more.gap >= more.rowGap + 12 && !more.small && /^04/.test(more.head), JSON.stringify(more));
  check(`4 · ${tag}: Delete is not next to Undo: none in the bar, no Undo in the sheet`, more && !more.undoIn && !(await page.evaluate(() => [...document.querySelectorAll('#mTool > *')].some(e => /delete/i.test(e.textContent)))));
  if (h === 844) await page.screenshot({ path: join(out, `check-${tag}-more.png`) });
  if (more) {
    await page.tap('#mmLoop'); await sleep(200);
    const lp = await page.evaluate(() => [document.getElementById('mmLoop').getAttribute('aria-pressed'), document.getElementById('loop').getAttribute('aria-pressed'), document.getElementById('mmLoop').textContent]);
    await page.tap('#mmLoop'); await sleep(150);
    check(`4 · ${tag}: Loop this shot turns the same loop on, and says so`, lp[0] === 'true' && lp[1] === 'true' && /On/.test(lp[2]) && await page.$eval('#loop', e => e.getAttribute('aria-pressed')) === 'false', JSON.stringify(lp));
    await page.tap('#mmSpeed'); await sleep(150); const r1 = (await state(page)).rate, v1 = await page.textContent('#mmSpeed');
    await page.tap('#mmSpeed'); await sleep(100); const r2 = (await state(page)).rate; await page.tap('#mmSpeed'); await sleep(100); const r3 = (await state(page)).rate;
    check(`4 · ${tag}: Playback speed steps 1× → 0.75× → 0.5× → 1× and shows it`, r1 === .75 && r2 === .5 && r3 === 1 && /0\.75×/.test(v1), JSON.stringify([r1, r2, r3, v1]));
    a = await state(page); await page.tap('#mmDel'); await sleep(120); b = await state(page);
    const armed = await page.$eval('#mmDel', e => e.hasAttribute('data-armed') && /again/i.test(e.textContent));
    check(`4 · ${tag}: Delete shot asks again: one tap deletes nothing`, b.n === a.n && armed, `${a.n} → ${b.n}`);
    // the selection changes under the armed button (a collaborator's edit moves it, playback crosses a cut): disarmed
    await page.evaluate(() => { const sc = document.getElementById('tl-scroll'), A = window.__CUE_MEDIA_TEST.app, s = A.S(), d = document.getElementById('audio').duration, P = (sc.scrollWidth - sc.clientWidth) / d; sc.scrollLeft = Math.round((s[5].start + s[6].start) / 2 * P); }); await sleep(350);
    const dis = !(await page.$eval('#mmDel', e => e.hasAttribute('data-armed')));
    if (await page.$eval('#mMore', d => d.open)) { await page.tap('#mmDel'); await sleep(150); }
    b = await state(page);
    check(`hostile · ${tag}: Delete armed, then the selection changes: disarmed, the next tap deletes nothing`, dis && b.n === a.n, `disarmed ${dis}, ${a.n} → ${b.n}`);
    await sleep(2700);
    if (!(await page.$eval('#mMore', d => d.open))) { await page.tap('#mtMore'); await sleep(300); }
    a = await state(page); const victim = a.ids[a.at];
    await page.tap('#mmDel'); await sleep(120); await page.tap('#mmDel'); await sleep(300); b = await state(page);
    check(`4 · ${tag}: the second tap deletes that shot, closes the sheet and leaves nothing selected`, b.n === a.n - 1 && !b.ids.includes(victim) && !(await page.$eval('#mMore', d => d.open)) && await bar(page) === BAR.none, `${a.n} → ${b.n}, bar ${await bar(page)}`);
    await page.tap('#mtUndo'); await sleep(300); b = await state(page);
    check(`9 · ${tag}: Undo is enabled once there is something to undo, and brings the shot back`, b.n === a.n && b.ids.includes(victim));
  }

  /* ---- hostile: a remote delete of the selected shot ---- */
  await toShot(page, 6); await tapTile(page); if (await bar(page) !== BAR.shot) await tapTile(page);
  await page.tap('#mtMore').catch(() => {}); await sleep(300);
  await page.evaluate(() => { const A = window.__CUE_MEDIA_TEST.app, p = JSON.parse(JSON.stringify(A.cur())), a = document.getElementById('audio'), i = p.sections.findLastIndex(x => x.start <= a.currentTime); p.sections.splice(i, 1);
    const S = window.__STUB; if (S && S.pid) S.app.applyRemote(S.pid, p); else { A.S().splice(i, 1); A.renderAll(); } }); await sleep(300);
  check(`hostile · ${tag}: a collaborator deletes the selected shot: the More sheet closes and the bar goes back to Undo and Cut here`, await bar(page) === BAR.none && !(await page.evaluate(() => { const d = document.getElementById('mMore'); return d && d.open; })), await bar(page));

  /* ---- hostile: a second finger taps the picture while a cut is being dragged ---- */
  await toShot(page, 2);
  const drag = await page.evaluate(async () => { const g = [...document.querySelectorAll('#mGrips .grip:not([hidden])')].find(b => b.getBoundingClientRect().left > 30 && b.getBoundingClientRect().right < innerWidth - 60); if (!g) return null;
    const r = g.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, ev = (t, dx) => g.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x + dx, clientY: y, bubbles: true, isPrimary: true, pointerType: 'touch' }));
    const a = document.getElementById('audio'); ev('pointerdown', 0); ev('pointermove', 12); ev('pointermove', 24);
    document.getElementById('monitor').click(); await new Promise(r => setTimeout(r, 250)); const playing = !a.paused; ev('pointerup', 24); if (playing) a.pause(); return { playing }; });
  check(`hostile · ${tag}: a tap on the picture while a cut is being dragged does not start playback`, drag && !drag.playing, JSON.stringify(drag));
  await page.tap('#mtDone').catch(() => {}); await sleep(100);

  /* ---- 8 · the Project sheet ---- */
  await page.tap('#proj'); await sleep(350);
  const sheet = await page.evaluate(() => { const d = document.getElementById('mProj'), vis = e => e.getClientRects().length > 0, R = e => e.getBoundingClientRect();
    const heads = [...d.querySelectorAll('.m-sh')].filter(vis).map(e => e.textContent.trim()), rows = [...d.querySelectorAll('.m-row')].filter(vis), bs = [...d.querySelectorAll('button,select')].filter(vis);
    const order = ['mNew', 'mImport', 'mRename', 'mSong', 'mFrame', 'mRender', 'mCopy', 'mExport', 'mJoin', 'mDelp'].map(id => { const e = document.getElementById(id); return e && vis(e) ? R(e).top : -1; });
    const chev = rows.filter(r => r.querySelector('.ico[data-chev]')).map(r => Math.round(R(r.querySelector('.ico[data-chev]')).right));
    return { open: d.open, heads, hs: [...new Set(rows.map(r => Math.round(R(r).height)))], xs: [...new Set(rows.map(r => Math.round(R(r.querySelector('span')).left)))], chev: [...new Set(chev)], order, sorted: order.every((y, i) => y >= 0 && (!i || y >= order[i - 1])),
      last: bs.sort((p, q) => R(p).top - R(q).top).pop().id, song: document.getElementById('mSong').textContent, frame: document.getElementById('mFrameRow').textContent, save: document.getElementById('mExport').textContent.trim(), list: d.querySelectorAll('#mProjList [data-pid]').length,
      small: bs.filter(e => R(e).height < 44 || R(e).width < 44).map(e => e.id), wide: d.scrollWidth > d.clientWidth + 1, delGap: Math.round(R(document.getElementById('mDelp')).top - Math.max(...rows.filter(r => r.id !== 'mDelp').map(r => R(r).bottom))) }; });
  check(`8 · ${tag}: four titled sections in order: Projects, This project, Output, Collaboration`, sheet.open && sheet.heads.join('|') === 'Projects|This project|Output|Collaboration', sheet.heads.join('|'));
  check(`8 · ${tag}: uniform rows: one height, labels on one left edge, chevrons on one right edge`, sheet.hs.length === 1 && sheet.hs[0] >= 44 && sheet.xs.length === 1 && sheet.chev.length === 1, JSON.stringify([sheet.hs, sheet.xs, sheet.chev]));
  check(`8 · ${tag}: every old action is there, in order: New, Import, Rename, Song, Frame, Render video, Copy shot list, Save project file, Collaborate, Delete project (last and apart)`, sheet.sorted && sheet.last === 'mDelp' && sheet.delGap >= 12 && sheet.list >= 1 && /Save project file/.test(sheet.save), JSON.stringify([sheet.order.map(Math.round), sheet.last, sheet.delGap, sheet.save]));
  check(`8 · ${tag}: the Song row shows the song's name, the Frame row the ratio`, /Song/.test(sheet.song) && /Mountain|Grieg|\.mp3|\.m4a|\.ogg/i.test(sheet.song) && /Frame/.test(sheet.frame) && /16:9/.test(sheet.frame), sheet.song + ' / ' + sheet.frame);
  check(`11 · ${tag}: the Project sheet: 44px targets, no horizontal scroll`, !sheet.small.length && !sheet.wide && await overflow(page) <= 0, JSON.stringify(sheet.small));
  if (h === 844) await page.screenshot({ path: join(out, `check-${tag}-project.png`) });
  if (w === 390) {
    await page.tap('#mSong'); await sleep(200);
    const ops = await page.evaluate(() => ['mSongRep', 'mDelsong'].map(id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0 && e.textContent.trim(); }));
    check(`8 · ${tag}: tapping Song opens Replace and Remove`, /Replace/.test(ops[0]) && /Remove/.test(ops[1]), JSON.stringify(ops));
    const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.tap('#mSongRep').catch(() => {})]);
    check(`8 · ${tag}: Replace opens the song picker`, !!fc);
    if (!(await page.$eval('#mProj', d => d.open))) { await page.tap('#proj'); await sleep(300); }
    await page.tap('#mExport'); await sleep(300);
    const ex = await page.$eval('#dlgExport', d => d.open);
    let file = null; if (ex) { const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null); await page.tap('#expGo'); const d = await dl; if (d) { const p = join(out, 'saved.cueboard.json'); await d.saveAs(p); file = { name: d.suggestedFilename(), j: JSON.parse(readFileSync(p, 'utf8')) }; } }
    check(`8 · ${tag}: Save project file is the same export: the dialog, then a .cueboard.json in the same format`, ex && file && /\.cueboard\.json$/.test(file.name) && file.j.format === 'cueboard' && file.j.version === 1 && Array.isArray(file.j.project.sections) && !!file.j.media, file ? file.name + ' ' + Object.keys(file.j).join(',') : 'no file');
    // 14 · a project made before this change opens unchanged: what was saved is what loads back
    await page.reload(); await page.waitForFunction(() => /Mountain/.test(document.getElementById('projname').textContent), null, { timeout: 15000 }); await sleep(400);
    const same = await page.evaluate(j => { const p = window.__CUE_MEDIA_TEST.app.cur(); return JSON.stringify(p.sections.map(s => [s.id, s.start, s.title])) === JSON.stringify(j.sections.map(s => [s.id, s.start, s.title])) && Object.keys(p).sort().join() === Object.keys(j).sort().join(); }, file ? file.j.project : { sections: [] });
    check(`14 · ${tag}: the stored project loads back with the same shape and shots (no new fields, no migration)`, same);
  } else { await page.evaluate(() => document.getElementById('mProj').close()); }

  /* ---- 9 · what the old layout showed is still reachable ---- */
  if (await page.evaluate(() => document.getElementById('mProj').open)) await page.evaluate(() => document.getElementById('mProj').close());
  await sleep(200);
  const se = await page.evaluate(async () => { const A = window.__CUE_MEDIA_TEST.app, store = A.store(), set0 = store.set, t = document.getElementById('toast');
    store.set = () => Promise.reject(Object.assign(new Error('x'), { code: 'quota_exceeded' })); A.scheduleSave(); A.flushNow(); await new Promise(r => setTimeout(r, 250));
    const p = document.getElementById('proj'), dot = getComputedStyle(p, '::after'), tr = t.getBoundingClientRect(), bar = document.getElementById('mTool').getBoundingClientRect();
    const o = { toast: t.hidden ? '' : t.textContent, toastClear: tr.bottom <= bar.top && tr.left >= 0 && tr.right <= innerWidth, dot: dot.content !== 'none' && parseFloat(dot.width) > 0 ? dot.backgroundColor : '', err: getComputedStyle(document.documentElement).getPropertyValue('--error').trim() };
    t.hidden = true; p.click(); await new Promise(r => setTimeout(r, 300)); const n = document.getElementById('mSaveErr'), nr = n.getBoundingClientRect(); o.note = n.hidden ? '' : n.textContent; o.noteSeen = nr.height > 0 && nr.top >= 0 && nr.bottom <= innerHeight;
    document.getElementById('mProj').close(); store.set = set0; A.scheduleSave(); A.flushNow(); await new Promise(r => setTimeout(r, 250));
    const dot2 = getComputedStyle(p, '::after'); o.after = t.hidden ? '' : t.textContent; o.dotAfter = dot2.content !== 'none' && parseFloat(dot2.width) > 0; return o; });
  check(`9 · ${tag}: a failed save with the sheet closed: a toast with the full text, above the bar`, /^Out of storage space/.test(se.toast) && /only in this tab/.test(se.toast) && se.toastClear, se.toast);
  check(`9 · ${tag}: …and it stays: a red dot on the project's name, the notice at the top of the Project sheet; both go once saving works`, !!se.dot && se.note === se.toast && se.noteSeen && se.after === 'Saved again' && !se.dotAfter, JSON.stringify(se));
  check(`9 · ${tag}: Report a problem and Settings are in the top row; Undo shows whether there is history`, (await controls(page)).filter(x => /^(reportb|settingsb)$/.test(x.id)).length === 2 && await page.$eval('#mtUndo', e => /hold to redo/i.test(e.getAttribute('aria-label'))));

  /* ---- 11 · long names; the Takes side ---- */
  await page.evaluate(() => { const A = window.__CUE_MEDIA_TEST.app, p = A.cur(); p.title = 'A very long project name that goes on far past what a phone bar can hold, and then some more'; if (p.song) p.song.name = 'A song file with an unreasonably long name, the live version, remastered twice (final) (really final).mp3';
    p.sections[2].title = 'A shot title long enough to wrap twice on the slate of a small phone screen, easily'; p.sections[2].notes = 'Notes that go on for a while: the light drops while the horns hold, then the camera finds her at the gate.'; p.sections[2].shot = 'Extreme close-up'; A.renderAll(); });
  await toShot(page, 2); await tapTile(page); if (await bar(page) !== BAR.shot) await tapTile(page);
  const top = await page.evaluate(() => { const R = id => document.getElementById(id).getBoundingClientRect(), p = R('proj'), t = R('mTabs'), f = R('reportb'), g = R('settingsb'), n = document.getElementById('projname'); return { order: p.right <= t.left + .5 && t.right <= f.left + .5 && f.right <= g.left + .5 && g.right <= innerWidth, cut: n.scrollWidth > n.clientWidth, pw: Math.round(p.width) }; });
  check(`hostile · ${tag}: a very long project name: ellipsis, the switch and both icons stay on screen, no overflow`, top.order && top.cut && top.pw >= 60 && await overflow(page) <= 0, JSON.stringify(top));
  check(`hostile · ${tag}: a long title, type and notes on the slate: nothing touches the time, nothing overflows`, !(await hits(page, ['#slate > *', '#mTime'])).length && await overflow(page) <= 0 && await page.evaluate(() => { const f = document.getElementById('mframe').getBoundingClientRect(); return [...document.querySelectorAll('#slate > *')].every(e => e.getBoundingClientRect().bottom <= f.bottom + 1 && e.getBoundingClientRect().top >= f.top - 1); }), (await hits(page, ['#slate > *', '#mTime'])).join(', '));
  await page.tap('#proj'); await sleep(300);
  const ln = await page.evaluate(() => { const d = document.getElementById('mProj'), v = document.querySelector('#mSong .muted'), r = document.getElementById('mSong').getBoundingClientRect(); return { wide: d.scrollWidth > d.clientWidth + 1, cut: v.scrollWidth > v.clientWidth, h: Math.round(r.height), item: (() => { const e = document.querySelector('#mProjList [aria-current="true"] span'); return e.scrollWidth > e.clientWidth; })() }; });
  check(`hostile · ${tag}: long project and song names in the sheet: ellipsis, rows keep their height, no sideways scroll`, !ln.wide && ln.cut && ln.item && ln.h === sheet.hs[0] && await overflow(page) <= 0, JSON.stringify(ln));
  await page.evaluate(() => document.getElementById('mProj').close()); await sleep(150);
  await page.tap('#mTabs [data-side="b"]'); await sleep(500);
  const tk = await page.evaluate(() => { const vis = e => !!e && e.getClientRects().length > 0, R = e => e.getBoundingClientRect(), m = document.getElementById('monitor'), b = document.getElementById('sideB');
    return { mon: vis(m) && R(m).top < 60 && Math.round(R(m).height), rail: vis(document.getElementById('bList')) && R(document.getElementById('bList')).top >= R(m).bottom - 1, head: vis(document.querySelector('.bshot')), deck: vis(document.querySelector('.timeline')), bar: vis(document.getElementById('mTool')), gen: vis(document.querySelector('.genbox')), sel: document.querySelector('#mTabs [data-side="b"]').getAttribute('aria-selected'), fits: R(b).bottom <= innerHeight + 1,
      n: document.getElementById('bN').textContent, slate: (document.querySelector('#slate .n') || {}).textContent }; });
  check(`Takes · ${tag}: same top row, the monitor on top showing the picked shot, then the rail, the header and the column; no timeline, no bar, no generation`, tk.mon > 100 && tk.rail && tk.head && !tk.deck && !tk.bar && !tk.gen && tk.sel === 'true' && tk.fits && tk.n === tk.slate, JSON.stringify(tk));
  c = await controls(page);
  check(`11 · ${tag}: the Takes side: 44px targets, no horizontal overflow`, !c.filter(x => x.w < 44 || x.h < 44).length && await overflow(page) <= 0, JSON.stringify(c.filter(x => x.w < 44 || x.h < 44)));
  await page.locator('.bitem').nth(4).tap(); await sleep(300);
  const tk2 = await page.evaluate(() => [document.getElementById('bN').textContent, (document.querySelector('#slate .n') || {}).textContent]);
  check(`Takes · ${tag}: picking another shot on the rail moves the monitor to it`, tk2[0] === '05' && tk2[1] === '05', tk2.join(' / '));
  await page.tap('#mTabs [data-side="a"]'); await sleep(300);

  /* ---- 11 · safe areas ---- */
  const cdp = await ctx.newCDPSession(page);
  const safe = await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34 } }).then(() => true, () => false);
  if (safe) { await sleep(300); c = await controls(page); const under = c.filter(x => x.b > h - 34 + 1 || x.y < 47 - 1);
    check(`11 · ${tag}: safe areas (47px top, 34px bottom emulated): nothing to press under the notch or the home indicator`, !under.length && await page.evaluate(() => innerHeight - document.getElementById('mTool').getBoundingClientRect().bottom < 1), JSON.stringify(under));
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} }).catch(() => {}); }
  else { const css = readFileSync(join(root, 'index.html'), 'utf8'); console.log(`SKIP 11 · ${tag}: this Chromium cannot emulate safe-area insets; checking the source instead`);
    check(`11 · ${tag}: safe areas, from the source: the bar pads by the bottom inset, the top row by the top inset`, /\.m-tool\{[^}]*var\(--safe-b\)/.test(css) && /\.top\{[^}]*var\(--safe-t\)/.test(css)); }
  check(`15 · ${tag}: no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
  await ctx.close();
});

/* ---- 10 · the landscape viewer ---- */
for (const [lw, lh] of ONLY && ONLY !== 'land' ? [] : [[844, 390], [667, 375]]) await guard(`landscape ${lw}x${lh}`, async () => {
  const tag = `${lw}x${lh}`, { ctx, page, errs } = await H.open([lh, lw]);
  await toShot(page, 3); await tapTile(page);
  const before = await state(page);
  await page.tap('#proj'); await sleep(300);
  await page.setViewportSize({ width: lw, height: lh }); await sleep(500);
  const v = await page.evaluate(() => { const vis = s => [...document.querySelectorAll(s)].some(e => e.getClientRects().length > 0), m = document.getElementById('monitor').getBoundingClientRect(), f = document.getElementById('mframe').getBoundingClientRect(), hint = document.getElementById('mRot');
    return { mon: [m.left, m.top, m.width, m.height].map(Math.round), frame: [f.width, f.height].map(Math.round), others: ['.top', '.deck', '#mTool', '#sideB', '.strip', '.keys', '.editor', '.songbar', '#mPeek'].filter(vis), sheet: document.getElementById('mProj').open, hint: !!hint && hint.getClientRects().length > 0 && hint.textContent.trim(),
      bg: getComputedStyle(document.getElementById('monitor')).backgroundColor, ow: document.documentElement.scrollWidth - innerWidth, oh: document.documentElement.scrollHeight - innerHeight }; });
  check(`10 · ${tag}: turned to landscape, only the viewer shows: the monitor fills the screen, the frame fitted in it`, v.mon.join() === [0, 0, lw, lh].join() && !v.others.length && v.frame[1] === lh && Math.abs(v.frame[0] - lh * 16 / 9) < 2 && v.ow <= 0 && v.oh <= 0, JSON.stringify(v));
  check(`hostile · ${tag}: rotated with the Project sheet open: the sheet is closed`, !v.sheet);
  check(`10 · ${tag}: "Rotate to edit" shows, then goes after 2 s`, v.hint === 'Rotate to edit' && await sleep(2400).then(() => page.evaluate(() => { const e = document.getElementById('mRot'); return !e.getClientRects().length || +getComputedStyle(e).opacity === 0; })), String(v.hint));
  const ctl = await controls(page);
  check(`10 · ${tag}: nothing to edit with: the only control is the scrub bar`, ctl.map(x => x.id).join('|') === 'mScrub', ctl.map(x => x.id).join('|'));
  await page.touchscreen.tap(lw / 2, lh / 2); await sleep(800); let s = await state(page);
  const tt = await page.evaluate(() => { const e = document.getElementById('mTime'), r = e.getBoundingClientRect(); return { t: e.textContent, on: r.width > 0 && r.bottom <= innerHeight && r.right <= innerWidth }; });
  check(`10 · ${tag}: a tap plays; the time is overlaid`, !s.paused && s.t > before.t + .3 && tt.on && /\//.test(tt.t), `${before.t.toFixed(2)} → ${s.t.toFixed(2)} ${tt.t}`);
  // mid-playback: back to portrait and to landscape again, it keeps playing
  await page.setViewportSize({ width: lh, height: lw }); await sleep(400); const mid = await state(page);
  await page.setViewportSize({ width: lw, height: lh }); await sleep(400); s = await state(page);
  check(`hostile · ${tag}: rotation mid-playback, both ways: it keeps playing, the portrait bar still has the shot's tools`, !mid.paused && !s.paused && s.t > mid.t && /mtUndo\|mtCut\|mtDet/.test(mid.bar.join('|')), `${mid.bar.join('|')}`);
  await page.touchscreen.tap(lw / 2, lh / 2); await sleep(300); s = await state(page);
  check(`10 · ${tag}: a second tap pauses`, s.paused);
  const sb = await rect(page, '#mScrub');
  check(`10 · ${tag}: a thin scrub bar along the bottom edge, 44px to grab`, sb && sb.h >= 44 && Math.abs(sb.b - lh) < 1 && sb.w >= lw - 1 && await page.evaluate(() => { const b = document.querySelector('#mScrub b'), t = b.parentElement.getBoundingClientRect(); return b.getBoundingClientRect().height <= 4 && Math.abs(b.getBoundingClientRect().bottom - t.bottom) <= 12; }), JSON.stringify(sb));
  await touch(page, [[lw * .2, lh - 10], [lw * .5, lh - 10]]); await sleep(300); s = await state(page);
  check(`10 · ${tag}: dragging the scrub bar seeks (to the middle: half the song), without playing`, Math.abs(s.t - s.d / 2) < s.d * .03 && s.paused, `${s.t.toFixed(1)} of ${s.d.toFixed(1)}`);
  await page.evaluate(t => window.__CUE_MEDIA_TEST.app.seek(t), before.t); await sleep(300);
  await page.setViewportSize({ width: lh, height: lw }); await sleep(500);
  const after = await state(page);
  check(`10 · ${tag}: turning back restores the portrait screen: same position, same selected shot, its tools in the bar`, Math.abs(after.t - before.t) < .15 && after.at === before.at && after.bar.join('|') === BAR.shot && Math.abs(after.left - before.left) <= 2 && await shown(page, '.top') && await shown(page, '.timeline'), `${before.t.toFixed(2)} → ${after.t.toFixed(2)}, shot ${before.at} → ${after.at}, scroll ${before.left} → ${after.left}, bar ${after.bar.join('|')}`);
  // mid-drag: a cut's grip held while the phone turns: the drag ends, nothing stays stuck
  const dragged = await page.evaluate(() => { const g = [...document.querySelectorAll('#mGrips .grip:not([hidden])')].find(b => b.getBoundingClientRect().left > 30 && b.getBoundingClientRect().right < innerWidth - 60); if (!g) return null;
    const r = g.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; for (const [t, dx] of [['pointerdown', 0], ['pointermove', 12], ['pointermove', 24]]) g.dispatchEvent(new PointerEvent(t, { pointerId: 9, clientX: x + dx, clientY: y, bubbles: true, isPrimary: true, pointerType: 'touch' })); return true; });
  await page.setViewportSize({ width: lw, height: lh }); await sleep(400); await page.setViewportSize({ width: lh, height: lw }); await sleep(400);
  await page.tap('#mtDone').catch(() => {}); await sleep(100); await toShot(page, 5); const a2 = await state(page); await page.tap('#mtUndo'); await sleep(300); const u2 = await state(page);
  check(`hostile · ${tag}: rotation in the middle of a cut drag: the drag ends as one step that Undo takes back`, dragged && /^Undone/.test(u2.toast) && u2.n === a2.n, u2.toast);
  // straight into landscape, on the Takes side
  await page.tap('#mTabs [data-side="b"]'); await sleep(300); await page.setViewportSize({ width: lw, height: lh }); await sleep(500);
  const vb = await page.evaluate(() => { const m = document.getElementById('monitor').getBoundingClientRect(); return [m.left, m.top, m.width, m.height].map(Math.round).join(); });
  check(`10 · ${tag}: from the Takes side too: the viewer`, vb === [0, 0, lw, lh].join(), vb);
  check(`15 · ${tag}: no page errors`, !errs.length, errs.slice(0, 3).join(' | '));
  await ctx.close();
});

/* ---- 12 (sanity) · 820px and up: none of the phone pieces show; the existing desktop checks do the rest ---- */
for (const [w, h] of ONLY && ONLY !== 'desk' ? [] : [[820, 900], [1280, 800]]) await guard(`desktop ${w}`, async () => {
  const { ctx, page, errs } = await H.open([w, h], { phone: false });
  const d = await page.evaluate(() => { const vis = s => [...document.querySelectorAll(s)].some(e => e.getClientRects().length > 0); return { phone: ['#mTabs', '#mTool', '#mPlayG', '#mTime', '#mScrub', '#mRot', '#mPeek', '#mGrips', '#mkClear', '.mkgrip'].filter(vis), desk: ['.transport', '#play', '#zfit', '.sides', '#strip', '#tc'].filter(s => !vis(s)) }; });
  check(`12 · ${w}px: no phone piece shows (tabs, bar, glyph, time, scrub, hint); transport, zoom, side switch and strip are there`, !d.phone.length && !d.desk.length, JSON.stringify(d));
  await page.click('#monitor'); await sleep(300);
  check(`12 · ${w}px: a click on the monitor does not play (desktop keeps its Play button)`, (await state(page)).paused);
  check(`15 · ${w}px: no page errors`, !errs.length, errs.join(' | '));
  await ctx.close();
});

/* ---- 15 · smoke from server.mjs ---- */
if (!ONLY || ONLY === 'server') await guard('server.mjs', async () => {
  const port = 5700 + Math.floor(Math.random() * 200), sv = spawn(process.execPath, [join(root, 'server.mjs')], { env: { ...process.env, PORT: String(port), OPENROUTER_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((ok, no) => { sv.stdout.on('data', d => /localhost/.test(String(d)) && ok()); sv.on('exit', () => no(new Error('server.mjs exited'))); setTimeout(() => no(new Error('server.mjs did not start')), 8000); });
    for (const [w, h, phone] of [[390, 844, true], [844, 390, true], [1280, 800, false]]) {
      const { ctx, page, errs } = await H.open([w, h], { phone, url: `http://127.0.0.1:${port}/` });
      if (phone && w < h) { await toShot(page, 1); await tapTile(page); await page.tap('#mtMore').catch(() => {}); await sleep(200); await page.evaluate(() => { const d = document.getElementById('mMore'); if (d && d.open) d.close(); }); await page.tap('#proj'); await sleep(200); }
      check(`15 · served by server.mjs at ${w}x${h}: loads, zero page errors`, !errs.length && /Mountain/.test(await page.textContent('#projname')), errs.slice(0, 2).join(' | '));
      await ctx.close();
    }
  } finally { sv.kill(); }
});

await H.close();
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
