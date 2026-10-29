// Screenshot + smoke run for the design pass. Never talks to OpenRouter: every request that is not
// to the local static server is aborted (and logged), except Google Fonts when --allow-fonts is passed (BEFORE build).
//   node design/shoot.mjs <repo-root> <out-dir> [--allow-fonts]
// Serves <repo-root> itself on a free 127.0.0.1 port (same as python3 -m http.server).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out, flag] = process.argv.slice(2);
const allowFonts = flag === '--allow-fonts';
mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`, url = origin + '/index.html';
const log = { console: [], external: [], checks: [] };
const check = (name, ok, ev = '') => { log.checks.push({ name, ok: !!ok, ev }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

async function newPage(w = 1440, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    if (allowFonts && /fonts\.(googleapis|gstatic)\.com/.test(u)) return r.continue();
    log.external.push(u); return r.abort();
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') log.console.push(m.text()); });
  page.on('pageerror', e => log.console.push('pageerror: ' + e.message));
  return { ctx, page };
}
// Delete project lives in the More menu: open it, then two taps (the menu stays open between them)
async function delProject(page) {
  if (await page.getAttribute('#moreb', 'aria-expanded') !== 'true') await page.click('#moreb');
  await sleep(100); await page.click('#delp'); await sleep(150); await page.click('#delp'); await sleep(800);
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const settle = page => page.evaluate(() => document.fonts.ready).then(() => sleep(400));

// Adds four takes (done + in cut, done, rendering, failed) to shot 03 of the example, straight into IndexedDB.
// Busy takes get no jobId, so the app never polls for them.
async function seedTakes(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(24), { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = e => parts.push(e.data);
    const done = new Promise(r => rec.onstop = r); rec.start();
    for (let i = 0; i < 24; i++) {
      const gr = g.createLinearGradient(0, 0, 320, 180); gr.addColorStop(0, '#2b2a33'); gr.addColorStop(1, `hsl(${30 + i},40%,${18 + i / 3}%)`);
      g.fillStyle = gr; g.fillRect(0, 0, 320, 180); g.fillStyle = '#0d0d10'; g.beginPath(); g.moveTo(0, 180); g.lineTo(90 + i * 2, 70); g.lineTo(200, 130); g.lineTo(320, 60); g.lineTo(320, 180); g.fill();
      await new Promise(r => setTimeout(r, 40));
    }
    rec.stop(); await done; const blob = new Blob(parts, { type: 'video/webm' });
    const db = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const tx = (n, m) => db.transaction(n, m).objectStore(n);
    const req = q => new Promise(r => { q.onsuccess = () => r(q.result); });
    await req(tx('media', 'readwrite').put({ blob, type: 'video/webm' }, 'm-seed-1'));
    await req(tx('media', 'readwrite').put({ blob, type: 'video/webm' }, 'm-seed-2'));
    const p = await req(tx('projects', 'readonly').get('p-example'));
    const s = p.sections[2], now = Date.now();
    const base = { jobId: '', model: 'alibaba/wan-3.0', modelName: 'Wan 3.0', res: '480p', dur: 6, audio: false, seed: '', prompt: s.vidPrompt || 'The camera pushes in slowly.', start: true, end: false, error: '', note: '' };
    s.takes = [
      { ...base, id: 't-seed-4', status: 'in_progress', est: 0.3, cost: null, created: now - 47000, media: '' },
      { ...base, id: 't-seed-3', status: 'failed', est: 0.3, cost: null, created: now - 600000, media: '', error: 'Content moderation: the request was rejected' },
      { ...base, id: 't-seed-2', status: 'completed', est: 0.3, cost: 0.3, created: now - 900000, media: 'm-seed-2', clipDur: 6, res: '720p', modelName: 'Seedance 2.5' },
      { ...base, id: 't-seed-1', status: 'completed', est: 0.3, cost: 0.3, created: now - 1200000, media: 'm-seed-1', clipDur: 6 },
    ];
    s.img = 'm-seed-1'; s.kind = 'video'; s.clipDur = 6; p.updated = now;
    await req(tx('projects', 'readwrite').put(p, p.id));
  });
}

try {
  // ---------- main flow at 1440x900 ----------
  const { ctx, page } = await newPage();
  await page.goto(url); await page.waitForSelector('.card', { timeout: 15000 });
  await settle(page); await sleep(800);
  check('example loads on first visit', await page.locator('.card').count() >= 10, (await page.locator('.card').count()) + ' cards');
  await page.locator('.card').nth(2).click(); await settle(page);
  check('clicking a card selects it', await page.locator('.card.sel').count() === 1 && (await page.inputValue('#f-title')).length > 0, await page.inputValue('#f-title'));
  await page.mouse.move(5, 5);
  await shot(page, '01-sideA-shot-selected');

  // pass 2: rows of controls share one height; every control sits on the 20/28/32/36 ladder
  const heights = await page.evaluate(() => [...document.querySelectorAll('.transport .btn, .transport select')].map(e => e.getBoundingClientRect().height));
  check('transport controls share one height', new Set(heights).size === 1, heights.join(','));
  const offLadder = await page.evaluate(() => [...document.querySelectorAll('.btn, .chip, select, input:not([type=checkbox]), .sidetab, kbd:not(.keys kbd)')]
    .filter(e => e.getBoundingClientRect().height > 0).map(e => [e.id || e.className, e.getBoundingClientRect().height]).filter(([, h]) => ![20, 28, 32, 36].includes(h)));
  check('controls on the 20/28/32/36 ladder', offLadder.length === 0, JSON.stringify(offLadder.slice(0, 5)));
  const proj = await page.evaluate(() => { const s = document.getElementById('proj'); return { title: s.title, text: document.getElementById('projname').textContent }; });
  check('project selector carries the full name as a tooltip', proj.title && proj.title === proj.text, proj.title);
  check('no unicode glyph icons left in the UI', !(await page.evaluate(() => /[▶❚⇄]/.test(document.body.innerText))));
  // pass 3: the monitor no longer repeats the transport timecode or the shot count; the name shows once
  check('monitor has no own timecode / shot count', await page.locator('#monitor .mbar, #mtc, #msec').count() === 0);
  check('project name appears once in the header', await page.evaluate(() => { const n = document.getElementById('projname').textContent; return [...document.querySelectorAll('.top *')].filter(e => e.offsetParent && e.children.length === 0 && (e.textContent === n || e.value === n)).length; }) === 1);

  // ---------- project menu (switches projects only) + rename with the pencil ----------
  const name0 = proj.text, pname = () => page.textContent('#projname'), focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className);
  await page.locator('.top').screenshot({ path: `${out}/hdr-1-closed.png` });
  await page.click('#proj'); await sleep(150);
  check('project menu opens on click, current project checked and focused', await page.isVisible('#projmenu') && await page.evaluate(() => document.activeElement?.getAttribute('aria-checked') === 'true'));
  const menuText = await page.locator('#projmenu .mi').allTextContents();
  check('project menu only switches projects: the projects, New project (no Rename, Join or Leave)', await page.locator('#projmenu [data-act="rename"], #projmenu [data-act="join"], #projmenu [data-act="leave"]').count() === 0
    && menuText.join('|') === `${name0}|New project`, menuText.join(' | '));
  await page.keyboard.press('Space'); await sleep(100);
  check('Space in the menu does not start playback', await page.evaluate(() => document.getElementById('play').textContent.trim()) === 'Play' && !(await page.isVisible('#projmenu')));
  await page.focus('#proj'); await page.keyboard.press('ArrowDown'); await sleep(100); await page.keyboard.press('ArrowDown'); await sleep(50);
  check('ArrowDown moves to New project', await page.evaluate(() => document.activeElement?.dataset.act) === 'new');
  await page.mouse.move(5, 5); await page.locator('.projpick').hover(); await sleep(100);
  await shot(page, 'hdr-2-menu-open');
  await page.keyboard.press('Escape'); await sleep(100);
  check('Escape closes the menu and focus returns to the picker', !(await page.isVisible('#projmenu')) && await focused() === 'proj' && await page.getAttribute('#proj', 'aria-expanded') === 'false');
  const pencil = () => page.evaluate(() => { const b = document.getElementById('renamep'); return b.querySelector('use').getAttribute('href') + '|' + b.getAttribute('aria-label'); });
  check('the pencil next to the name is labelled Rename project', await pencil() === '#i-pencil|Rename project', await pencil());
  await page.click('#renamep'); await sleep(100);
  check('the pencil turns the name into a selected field and itself into a check', await page.isVisible('#ptitle') && !(await page.isVisible('#proj')) && await pencil() === '#i-check|Save name' && await page.evaluate(() => { const t = document.getElementById('ptitle'); return document.activeElement === t && t.selectionEnd - t.selectionStart === t.value.length; }));
  await page.keyboard.type('Pass three rename'); await page.mouse.move(5, 5);
  await shot(page, 'hdr-3-renaming');
  await page.keyboard.press('Enter'); await sleep(400);
  check('Enter saves the new name, focus back on the pencil', await pname() === 'Pass three rename' && await focused() === 'renamep' && await pencil() === '#i-pencil|Rename project', await pname());
  await page.reload(); await page.waitForSelector('.card', { timeout: 15000 }); await settle(page);
  check('renamed project keeps its name after reload', await pname() === 'Pass three rename', await pname());
  await page.click('#renamep'); await page.keyboard.type('Should not stick'); await page.keyboard.press('Escape'); await sleep(200);
  check('Escape cancels the rename', await pname() === 'Pass three rename' && await focused() === 'renamep', await pname());
  await page.click('#renamep'); await page.keyboard.type('By the check'); await page.click('#renamep'); await sleep(400);
  check('the check saves (and does not start another rename)', await pname() === 'By the check' && !(await page.isVisible('#ptitle')) && await pencil() === '#i-pencil|Rename project', await pname());
  await page.click('#renamep'); await page.keyboard.type(name0); await page.mouse.click(700, 500); await sleep(400);
  check('leaving the field (blur) saves', await pname() === name0, await pname());
  // New, then switch back through the menu with the keyboard
  await page.click('#newp'); await sleep(500);
  check('New opens a project and starts renaming it', await page.isVisible('#ptitle') && await page.locator('.card').count() <= 1);
  await page.keyboard.type('Scratch'); await page.keyboard.press('Enter'); await sleep(300);
  check('after naming a new project, focus is back on New', await focused() === 'newp', await focused());
  await page.focus('#proj'); await page.keyboard.press('ArrowDown'); await sleep(100);
  const items = await page.locator('#projmenu [role="menuitemradio"]').allTextContents();
  check('menu lists both projects', items.includes('Scratch') && items.includes(name0), items.join(' | '));
  for (let i = 0; i < 5 && await page.evaluate(() => document.activeElement?.textContent) !== name0; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); await page.waitForSelector('.card >> nth=5', { timeout: 5000 }); await settle(page);
  check('choosing a project in the menu switches to it', await pname() === name0 && await page.locator('.card').count() >= 10 && !(await page.isVisible('#projmenu')));
  // remove the scratch project again so the rest of the run sees the same data as before
  await page.click('#proj'); await page.click('#projmenu [role="menuitemradio"]:has-text("Scratch")'); await sleep(500);
  await delProject(page);
  await page.click('#proj'); await sleep(100);
  const left = await page.locator('#projmenu [role="menuitemradio"]').allTextContents(); await page.keyboard.press('Escape');
  check('Delete (in More, two taps) removes the open project', await pname() === name0 && !left.includes('Scratch'), left.join(' | '));
  await page.locator('.card').nth(2).click(); await settle(page); await page.mouse.move(5, 5);

  const t0 = await page.textContent('#tc');
  await page.click('#play'); await sleep(1600);
  const t1 = await page.textContent('#tc');
  check('animatic plays (timecode advances)', t0 !== t1, `${t0} → ${t1}`);
  const playing = await page.evaluate(() => ({ ico: document.querySelector('#play use')?.getAttribute('href'), text: document.getElementById('play').textContent.trim() }));
  check('Play turns into Pause (icon + label)', playing.ico === '#i-pause' && playing.text === 'Pause', JSON.stringify(playing));
  await shot(page, '02-sideA-playing');
  await page.click('#play'); await sleep(200);
  const paused = await page.evaluate(() => document.querySelector('#play use')?.getAttribute('href'));
  check('Pause turns back into Play', paused === '#i-play', paused);
  // zoom and a click on the canvas (scrub) still work
  const cw = () => page.evaluate(() => document.getElementById('tl').getBoundingClientRect().width);
  const w0 = await cw(); await page.click('#zin'); await sleep(100); const w1 = await cw();
  await page.click('#zout'); await page.click('#zfit'); await sleep(100); const w2 = await cw();
  check('zoom in widens the timeline, Fit restores it', w1 > w0 && w2 === w0, `${w0} → ${w1} → ${w2}`);
  const tcA = await page.textContent('#tc');
  const box = await page.locator('#tl').boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + 80); await sleep(200);
  const tcB = await page.textContent('#tc');
  check('clicking the waveform moves the playhead', tcA !== tcB, `${tcA} → ${tcB}`);
  await page.locator('.card').nth(2).click(); await sleep(200); await page.mouse.move(5, 5);
  await page.keyboard.press('l'); await sleep(150);
  await shot(page, '03-toast');
  await page.keyboard.press('l'); await sleep(1900);

  await page.locator('.card').nth(2).hover(); await sleep(250);
  await page.focus('#mark'); await page.keyboard.press('Tab');
  await shot(page, '04-sideA-focus-hover');

  await page.click('#settingsb'); await sleep(300);
  await shot(page, '05-settings');
  await page.click('#setClose'); await sleep(150);
  await page.click('#exportb'); await sleep(300);
  await shot(page, '06-export-modal');
  await page.click('#expCancel'); await sleep(150);

  await page.click('.sidetab[data-side="b"]'); await sleep(500);
  check('side B shows the shot list', await page.locator('.bitem').count() >= 10);
  await shot(page, '07-sideB-no-takes');
  await page.click('#fStartGen'); await sleep(250);
  await shot(page, '08-sideB-frame-panel');
  await page.click('#fStartCancel');

  await seedTakes(page); await page.reload(); await page.waitForSelector('.bitem', { timeout: 15000 }); await settle(page);
  await page.locator('.bitem').nth(2).click(); await sleep(900);
  check('side B renders seeded takes', await page.locator('.take').count() === 4);
  await page.mouse.move(5, 5);
  await shot(page, '09-sideB-takes');
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await sleep(300);
  await shot(page, '10-sideB-takes-scrolled');
  await page.evaluate(() => scrollTo(0, 0));

  await page.click('.sidetab[data-side="a"]'); await sleep(500);
  await page.locator('.card').nth(2).click(); await sleep(500); await page.mouse.move(5, 5);
  await shot(page, '11-sideA-clip-in-cut');

  // ---------- empty states ----------
  await page.click('#newp'); await sleep(700); await page.mouse.move(5, 5);
  await shot(page, '12-sideA-empty');
  await page.click('.sidetab[data-side="b"]'); await sleep(400);
  await shot(page, '13-sideB-empty');
  await page.click('.sidetab[data-side="a"]'); await sleep(200);
  // delete every project (two-tap Delete) to reach the no-project states
  for (let i = 0; i < 5 && await page.isEnabled('#delp'); i++) await delProject(page);
  await page.mouse.move(5, 5); await sleep(1900);
  check('no-project empty state shows', await page.isVisible('#ed-empty'));
  await shot(page, '14-sideA-no-project');
  await page.click('.sidetab[data-side="b"]'); await sleep(400);
  check('side B empty state shows', await page.isVisible('#bEmpty'));
  await shot(page, '15-sideB-no-project');
  await page.click('#proj'); await sleep(150);
  const none = await page.locator('#projmenu .mi').allTextContents();
  check('with no projects the picker says so and offers New project and the example', await pname() === 'No projects' && none.join('|') === 'New project|Example project' && await page.isDisabled('#renamep'), none.join(' | '));
  check('the Example button is gone from the bar', await page.locator('#examplep').count() === 0 && !(await page.evaluate(() => [...document.querySelectorAll('.top .btn')].some(b => b.offsetParent && /example/i.test(b.textContent)))));
  await page.click('#projmenu [data-act="example"]'); await page.waitForSelector('.bitem', { timeout: 15000 }); await sleep(500);
  check('the project menu loads the example from the no-project state', await page.locator('.bitem').count() >= 10 && await page.isEnabled('#renamep') && /example/.test(await pname()), await pname());
  await ctx.close();

  // ---------- 2x crops for pixel alignment, then the Cut button ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : (log.external.push(r.request().url()), r.abort()));
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') log.console.push(m.text()); });
    await page.goto(url); await page.waitForSelector('.card', { timeout: 15000 }); await settle(page);
    await page.locator('.card').nth(2).click(); await sleep(300);
    await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(5, 5); await sleep(200);
    await page.locator('.top').screenshot({ path: `${out}/crop2x-toolbar.png` });
    await page.locator('.deck').screenshot({ path: `${out}/crop2x-transport-timeline.png` });
    await page.click('.sidetab[data-side="b"]'); await sleep(400); await page.mouse.move(5, 5);
    const lb = await page.locator('#bList').boundingBox();
    await page.screenshot({ path: `${out}/crop2x-shotlist.png`, clip: { x: lb.x, y: lb.y, width: lb.width, height: 360 } });
    await page.click('.sidetab[data-side="a"]'); await sleep(300);
    const n0 = await page.locator('.card').count();
    const tb = await page.locator('#tl').boundingBox();   // a card click seeks onto an existing cut; move into the middle of a shot first
    await page.mouse.click(tb.x + tb.width * 0.43, tb.y + 80); await sleep(200);
    await page.click('#mark'); await sleep(300);
    check('Cut button adds a shot', await page.locator('.card').count() === n0 + 1, `${n0} → ${await page.locator('.card').count()}`);
    await ctx.close();
  }

  // ---------- narrower widths ----------
  for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [900, 1000], [820, 1180]]) {
    const { ctx, page } = await newPage(w, h);
    await page.goto(url); await page.waitForSelector('.card', { timeout: 15000 }); await settle(page); await sleep(500);
    await page.locator('.card').nth(2).click(); await sleep(300); await page.mouse.move(5, 5);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`no horizontal overflow at ${w}px (side A)`, ov <= 0, `overflow ${ov}px`);
    await shot(page, `w${w}-sideA`);
    await page.click('.sidetab[data-side="b"]'); await sleep(400);
    const ovb = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`no horizontal overflow at ${w}px (side B)`, ovb <= 0, `overflow ${ovb}px`);
    await shot(page, `w${w}-sideB`);
    await ctx.close();
  }
  // ---------- double-click case: file:// still gets the local fonts ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : (log.external.push(r.request().url()), r.abort()));
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(resolve(root, 'index.html')).href);   // resolve, not join(cwd, root): root may be absolute
    await page.waitForSelector('.card', { timeout: 15000 });
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map(f => f.family + ':' + f.status); });
    const want = await page.evaluate(() => document.querySelector('link[href*="fonts.googleapis"]') ? 'cdn' : 'local');
    check('file:// load: fonts resolve', want === 'cdn' || fonts.some(f => /Instrument Sans.*loaded/.test(f)) && fonts.some(f => /JetBrains Mono.*loaded/.test(f)), [...new Set(fonts)].join(' '));
    await ctx.close();
  }
} catch (e) { check('run completed', false, e.message); }

// Expected noise: the app probes api/health (404 without server.mjs) and asks OpenRouter for its model list (aborted here).
const errs = log.console.filter(t => !/Failed to load resource/.test(t));
check('no console errors (besides blocked/404 probes)', errs.length === 0, errs.slice(0, 5).join(' | '));
const ext = [...new Set(log.external)].filter(u => !u.startsWith('https://openrouter.ai/'));
check('no external requests besides OpenRouter (blocked)', ext.length === 0, ext.slice(0, 5).join(' | '));
console.log('INFO OpenRouter calls blocked:', [...new Set(log.external)].filter(u => u.startsWith('https://openrouter.ai/')).join(' ') || 'none');
writeFileSync(`${out}/results.json`, JSON.stringify(log, null, 2));
await browser.close(); srv.close();
// a FAIL fails the run (a broken boot, file:// included, stops at "run completed")
process.exit(log.checks.some(c => !c.ok) ? 1 : 0);
