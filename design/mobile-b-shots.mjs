// Screenshots of the phone redesign (docs/specs/mobile-redesign-b.md) for a human to look at, next to .ref/out/B-*.png.
//   node design/run-local.mjs design/mobile-b-shots.mjs <repo-root> <out-dir>      (default out: design/out/mobile-b)
// 390x844, 390x667 and 430x932, then the landscape viewer at 844x390: the Cut side with nothing selected, a shot
// selected, a cut picked, the More sheet, the Takes side, the Project sheet, a 9:16 project, and a project with many
// shots. The example project gets a picture per shot: flat colour frames with the shot's title, drawn in the page.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { start, state, toShot, tapTile, sleep } from './mobile-b-lib.mjs';

const [root, out = join(root, 'design/out/mobile-b')] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const H = await start(root);
const COLORS = ['#7a4a32', '#2f4f6b', '#4d6b3a', '#6b3a55', '#3a5f66', '#6b5a2f', '#4a3f6b', '#2f6b52', '#6b2f3a', '#3f556b', '#5f6b2f', '#553a6b', '#2f5a4a'];

// a picture for every shot of the open project, through the same file input the Photo tool uses
async function pictures(page) {
  const n = (await state(page)).n;
  for (let i = 0; i < n; i++) {
    await toShot(page, i);
    const url = await page.evaluate(([i, c]) => { const s = window.__CUE_MEDIA_TEST.app.S()[i], cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const g = cv.getContext('2d');
      g.fillStyle = c; g.fillRect(0, 0, 640, 360); g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.moveTo(0, 360); g.lineTo(200 + i * 20, 120); g.lineTo(640, 360); g.fill();
      g.fillStyle = '#f2efe9'; g.font = '600 40px sans-serif'; g.textBaseline = 'middle'; g.fillText(String(i + 1).padStart(2, '0') + '  ' + (s.title || 'Untitled'), 32, 180); return cv.toDataURL('image/png'); }, [i, COLORS[i % COLORS.length]]);
    await page.setInputFiles('#f-img', { name: `shot-${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
    await page.waitForFunction(i => !!window.__CUE_MEDIA_TEST.app.S()[i].img, i, { timeout: 8000 });
  }
  await sleep(600);
}
const quiet = page => page.evaluate(() => { document.getElementById('toast').hidden = true; });
const many = { format: 'cueboard', version: 1, media: {}, project: { id: 'p-many', title: 'Forty shots, a long night drive across the salt flats', created: 1, updated: 1, song: null, refs: [],
  sections: Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, start: i * 3.5, title: ['The ridge', 'Night road', 'Headlights', 'A long title for a shot that has to truncate somewhere'][i % 4], shot: ['Wide shot', 'Close-up', '', 'Tracking shot'][i % 4], notes: i % 3 ? '' : 'The light drops while the horns hold.', img: '', kind: '', key: '', endKey: '', imgPrompt: '', vidPrompt: '', takes: [] })) } };

for (const [w, h] of [[390, 844], [390, 667], [430, 932]]) {
  const tag = `${w}x${h}`, { ctx, page, errs } = await H.open([w, h]);
  const shot = async n => { await quiet(page); await sleep(150); await page.screenshot({ path: join(out, `${tag}-${n}.png`) }); };
  await pictures(page);
  await toShot(page, 6); if (await page.isVisible('#mtMore')) await tapTile(page); await shot('1-cut-nothing-selected');
  await tapTile(page); await shot('2-cut-shot-selected');
  await page.tap('#mtMore'); await sleep(350); await shot('3-more-sheet');
  await page.evaluate(() => document.getElementById('mMore').close()); await sleep(200);
  const g = await page.evaluate(() => { const b = [...document.querySelectorAll('#mGrips .grip:not([hidden])')].filter(g => g.getBoundingClientRect().left > 60 && g.getBoundingClientRect().right < innerWidth - 8)[0], r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await page.touchscreen.tap(g[0], g[1]); await sleep(300); await shot('4-cut-picked');
  await page.tap('#mtDone'); await sleep(150);
  await page.tap('#mtDet'); await sleep(400); await shot('5-details-sheet');
  await page.tap('#mEdClose'); await sleep(250);
  await page.evaluate(() => { const A = window.__CUE_MEDIA_TEST.app, t = document.getElementById('audio').currentTime; A.ioSet('in', t - 6); A.ioSet('out', t + 9); }); await sleep(250); await shot('6-range-selection');
  await page.evaluate(() => window.__CUE_MEDIA_TEST.app.ioSet()); await sleep(150);
  await page.tap('#mTabs [data-side="b"]'); await sleep(500); await shot('7-takes');
  await page.evaluate(() => { const b = document.getElementById('sideB'); b.scrollTop = b.scrollHeight; }); await sleep(250); await shot('7-takes-end');
  await page.tap('#mTabs [data-side="a"]'); await sleep(300);
  await page.tap('#proj'); await sleep(400); await shot('8-project-sheet');
  await page.evaluate(() => { const d = document.getElementById('mProj'); d.scrollTop = d.scrollHeight; }); await sleep(200); await shot('8-project-sheet-end');
  await page.tap('#mSong'); await sleep(250); await page.$eval('#mSongOps', e => e.scrollIntoView({ block: 'center' })); await sleep(200); await shot('8-project-sheet-song');
  await page.evaluate(() => { document.getElementById('mProj').close(); const s = document.getElementById('mFrame'); s.value = '9:16'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(400);
  await toShot(page, 6); if (await page.isVisible('#mtMore')) await tapTile(page); await shot('9-vertical-9x16'); await tapTile(page); await shot('9-vertical-9x16-shot-selected');
  await page.tap('#mTabs [data-side="b"]'); await sleep(400); await shot('9-vertical-9x16-takes'); await page.tap('#mTabs [data-side="a"]'); await sleep(300);
  await page.evaluate(() => { const s = document.getElementById('mFrame'); s.value = '16:9'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300);
  if (w === 390 && h === 844) {
    await page.setViewportSize({ width: 844, height: 390 }); await sleep(400); await page.screenshot({ path: join(out, '844x390-landscape-viewer-hint.png') });
    await sleep(2300); await page.screenshot({ path: join(out, '844x390-landscape-viewer.png') });
    await page.touchscreen.tap(422, 180); await sleep(1200); await page.screenshot({ path: join(out, '844x390-landscape-viewer-playing.png') }); await page.touchscreen.tap(422, 180); await sleep(200);
    await page.evaluate(() => { const s = document.getElementById('mFrame'); s.value = '9:16'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300); await page.screenshot({ path: join(out, '844x390-landscape-viewer-9x16.png') });
    await page.evaluate(() => { const s = document.getElementById('mFrame'); s.value = '16:9'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.setViewportSize({ width: w, height: h }); await sleep(400);
  }
  // many shots, no song: the notice, the timeline, the rail
  await page.setInputFiles('#importf', { name: 'many.cueboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(many)) });
  await page.waitForFunction(() => /Forty/.test(document.getElementById('projname').textContent), null, { timeout: 15000 }); await sleep(500);
  await page.evaluate(() => { const sc = document.getElementById('tl-scroll'); sc.scrollLeft = Math.round((sc.scrollWidth - sc.clientWidth) * .4); }); await sleep(400);
  await shot('10-many-shots');
  const b = await page.evaluate(() => { const c = document.getElementById('tl').getBoundingClientRect(); return [c.x + c.width / 2 + 30, c.y + window.__CUE_MEDIA_TEST.app.mLayout(c.height).top + 20]; });
  await page.touchscreen.tap(b[0], b[1]); await sleep(300); await shot('10-many-shots-selected');
  await page.tap('#mTabs [data-side="b"]'); await sleep(400); await shot('10-many-shots-takes');
  await page.tap('#proj'); await sleep(400); await shot('10-many-shots-project-sheet');
  console.log(`${tag}: done${errs.length ? ' · page errors: ' + errs.join(' | ') : ''}`);
  await ctx.close();
}
await H.close();
