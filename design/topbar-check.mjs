// The app bar: layout (Side A/B on the true centre, one row 1920 to 820 px), the project zone (rename pencil, project
// menu, More), the room controls (Join / Leave, presence with your own bubble), the sync icon and the saved state.
//   node design/topbar-check.mjs <repo-root> <out-dir>
// No sync server: like design/inline-shots.mjs, /collab.js is a stub whose status and peers the script sets, and
// index.html gets a sync URL nothing listens on. Every other request is aborted. Screenshots at 1440x900 unless named.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const STUB = `export const parseIce = () => [];
export function createCollab(app) {
  const S = window.__STUB = { app, pid: null, status: 'synced', peers: [] };
  const media = { files: () => [], summary: () => ({ total: 0, here: 0, active: 0, unavailable: 0, skipped: 0, failed: 0, relay: 0, paused: false, storageFull: false, storageBusy: '', storage: { persisted: true, free: 5e10 }, foreign: 0 }),
    progress: () => null, pause() {}, refresh() {}, downloadAll() {}, download() {}, retry() {} };
  S.ping = () => { if (S.pid) { app.onStatus(S.pid, S.status); app.onPeers(S.pid, S.peers); } };
  return {
    open(pid) { S.pid = pid; setTimeout(S.ping, 30);
      return { status: () => S.status, select() {}, changed() {}, mark() {}, saved() {}, stop() { S.pid = null; }, media: () => media }; },
    forget() {}, dropMedia() {}, probe: async () => ({ ok: false }), seed: async () => {},
  };
}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = createServer((q, r) => {
  const path = q.url.split('?')[0];
  if (path === '/collab.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(STUB); return; }
  const p = join(root, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  try {
    if (!statSync(p).isFile()) throw 0;
    let body = readFileSync(p);
    if (p.endsWith('index.html')) body = String(body).replace('<meta name="cue-sync-url" content="">', '<meta name="cue-sync-url" content="ws://127.0.0.1:9">');
    r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(body);
  } catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const results = [], errs = [];
const check = (name, ok, ev = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' · ' + ev : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route('**/*', r => (r.request().url().startsWith(origin) || /^(data|blob):/.test(r.request().url()) ? r.continue() : r.abort()));
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));

const bar = async (name, extra = 0) => { await page.evaluate(() => scrollTo(0, 0)); await sleep(50); const b = await page.locator('.top').boundingBox(); const w = page.viewportSize().width;
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: w, height: Math.ceil(b.height) + extra } }); };
const geo = () => page.evaluate(() => { const t = document.querySelector('.top').getBoundingClientRect(), s = document.querySelector('.sides').getBoundingClientRect();
  const kids = [...document.querySelectorAll('.top .tzone > *, .top .tgroup > *, .top .sides')].filter(e => e.getClientRects().length && getComputedStyle(e).position !== 'absolute');
  const tops = new Set(kids.map(e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
  const zones = [...document.querySelectorAll('.tleft, .sides, .tright')].map(e => e.getBoundingClientRect());
  const content = z => [...z.querySelectorAll(':scope > *')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect());
  const L = content(document.querySelector('.tleft')), R = content(document.querySelector('.tright'));
  return { off: (s.left + s.width / 2) - (t.left + t.width / 2), h: Math.round(t.height), rows: tops.size, scroll: document.documentElement.scrollWidth - innerWidth,
    gapL: Math.round(s.left - Math.max(...L.map(r => r.right))), gapR: Math.round(Math.min(...R.map(r => r.left)) - s.right), zones: zones.length };
});
const status = () => page.evaluate(() => { const s = document.getElementById('status'); return { k: s.dataset.k, t: s.textContent, ico: s.querySelector('use').getAttribute('href'), tip: s.title }; });
const db = fn => page.evaluate(fn);

try {
  await page.goto(origin + '/index.html'); await page.waitForSelector('.card', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready); await sleep(800); await page.mouse.move(700, 600);

  // ---------- a local project ----------
  check('local project: Join collaboration in the bar, no This room, no bubbles, no sync indicator', await page.isVisible('#joinb') && !(await page.isVisible('#roomb')) && !(await page.isVisible('#presence')) && !(await page.isVisible('#mstat')));
  await bar('01-bar-local');
  for (const w of [1440, 1920]) {
    await page.setViewportSize({ width: w, height: 900 }); await sleep(150); const g = await geo();
    check(`Side A/B on the bar's centre at ${w}px`, Math.abs(g.off) <= 2, `off by ${g.off.toFixed(1)}px`);
  }
  await bar('01-bar-local-1920');
  check('at 1920 New, Import and Export show their labels', await page.evaluate(() => ['newp', 'importb', 'exportb'].every(id => document.getElementById(id).getBoundingClientRect().width > 40)));
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(150);
  const ie = await page.evaluate(() => ['importb', 'exportb'].map(id => { const b = document.getElementById(id); return [b.querySelector('svg[aria-hidden="true"] use')?.getAttribute('href'), b.textContent.trim(), b.title, b.tagName]; }));
  check('Import and Export have icons, accessible labels and tooltips (and are real buttons)', JSON.stringify(ie.map(x => x.slice(0, 2))) === '[["#i-import","Import"],["#i-export","Export"]]' && ie.every(x => x[2] && x[3] === 'BUTTON'), JSON.stringify(ie));
  check('the Example button is gone', await page.locator('#examplep').count() === 0);

  // ---------- saved state: saving, saved, error ----------
  await page.locator('.card').nth(1).click(); await page.click('#f-title'); await page.keyboard.type(' x');
  const s1 = await status(); await bar('02-saved-saving');
  await sleep(1200); const s2 = await status(); await page.mouse.move(700, 600); await bar('02-saved-saved');
  check('saved state: "Saving…" (dots) right after an edit, then "Saved" (check)', s1.t === 'Saving…' && s1.k === 'busy' && s1.ico === '#i-more' && s2.t === 'Saved' && s2.k === 'ok' && s2.ico === '#i-check', `${JSON.stringify(s1)} → ${JSON.stringify(s2)}`);
  await db(() => { const put = IDBObjectStore.prototype.put; window.__put = put; IDBObjectStore.prototype.put = function (v, k) { if (this.name === 'projects') throw new DOMException('quota', 'QuotaExceededError'); return put.call(this, v, k); }; });
  await page.keyboard.type('y'); await sleep(1200); const s3 = await status();
  await page.evaluate(() => document.activeElement.blur()); await page.mouse.move(700, 600); await bar('02-saved-error');
  check('saved state: a failed save shows an error (alert icon, error colour, why in the tooltip)', s3.k === 'err' && s3.ico === '#i-alert' && /Couldn't save/.test(s3.t) && /export/.test(s3.tip)
    && await page.evaluate(() => getComputedStyle(document.getElementById('status')).color === getComputedStyle(document.documentElement).getPropertyValue('--error').trim().replace(/^#(..)(..)(..)$/, (m, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`)), JSON.stringify(s3));
  await db(() => { IDBObjectStore.prototype.put = window.__put; });
  await page.click('#f-title'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.evaluate(() => document.activeElement.blur()); await sleep(1200);
  check('saved state recovers once a save works again; never orange', (await status()).t === 'Saved' && !(await page.evaluate(() => /240, 163, 58/.test(getComputedStyle(document.getElementById('status')).color + getComputedStyle(document.querySelector('#status .ico')).color))));

  // ---------- rename and the project menu ----------
  await page.click('#renamep'); await page.keyboard.type('Renaming in place'); await page.mouse.move(700, 600); await bar('03-rename-in-progress');
  await page.keyboard.press('Escape'); await sleep(100);
  await page.click('#proj'); await sleep(150); await page.mouse.move(700, 600); await bar('04-project-menu-open', 120);
  await page.keyboard.press('Escape');
  await page.click('#moreb'); await sleep(150); await page.mouse.move(700, 600);
  const more = await page.evaluate(() => [...document.querySelectorAll('#moremenu .mi')].filter(e => e.getClientRects().length).map(e => e.textContent));
  check('More at 1440: Replace song, Remove song, the four Frame ratios, Delete project (Import/Export are in the bar; Report a problem is next to Settings)', more.join('|') === 'Replace song…|Remove song|16:9|9:16|1:1|4:3|Delete project', more.join(' | '));
  await bar('05-more-menu-1440', 140); await page.keyboard.press('Escape');

  // ---------- in a room: you and others ----------
  const peers = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: ['Nacho Pérez', 'Ana Ruiz', 'Cleo Park', 'Dev Rao', 'Eli Moss', 'Fay Lin', 'Gus Hale'][i], initials: ['NP', 'AR', 'CP', 'DR', 'EM', 'FL', 'GH'][i], sel: '' }));
  await db(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    await new Promise(r => { const q = d.transaction('settings', 'readwrite').objectStore('settings').put({ name: 'Rami', rooms: { 'p-example': { roomId: 'r'.repeat(22), token: 't'.repeat(22), name: 'Rami' } } }, 'collab'); q.onsuccess = r; }); });
  await page.reload(); await page.waitForSelector('.card'); await page.waitForFunction(() => window.__STUB && window.__STUB.pid);
  await page.evaluate(p => { window.__STUB.peers = p; window.__STUB.ping(); }, peers(1)); await sleep(300); await page.mouse.move(700, 600);
  const row = () => page.evaluate(() => [...document.querySelectorAll('#presence .pchip')].map(c => [c.textContent, c.dataset.tip, c.getAttribute('aria-label'), c.className]));
  const r1 = await row();
  check('in a room: This room instead of Collaborate, no Leave in the bar; own bubble first ("Rami (you)"), then the collaborator', !(await page.isVisible('#joinb')) && await page.isVisible('#roomb') && !(await page.$('#leaveb'))
    && JSON.stringify(r1.map(x => [x[0], x[1], x[2] === x[1]])) === '[["RA","Rami (you)",true],["NP","Nacho Pérez",true]]' && /self/.test(r1[0][3]), JSON.stringify(r1));
  const tip = sel => page.evaluate(sel => { const a = getComputedStyle(document.querySelector(sel), '::after'); return a.display !== 'none' && a.visibility === 'visible' ? a.content.replace(/^"|"$/g, '') : ''; }, sel);
  await page.hover('#presence .pchip.self'); await sleep(150);
  check('own bubble: name on hover', await tip('#presence .pchip.self') === 'Rami (you)');
  await bar('06-room-two-users-own-hover', 40);
  await page.hover('#presence .pchip:not(.self)'); await sleep(150);
  check('collaborator bubble: name on hover', await tip('#presence .pchip:not(.self)') === 'Nacho Pérez');
  await page.mouse.move(700, 600); await page.focus('#presence .pchip.self'); await page.keyboard.press('ArrowRight'); await sleep(150);
  check('keyboard: one tab stop, arrows move along the row, the name shows on focus', await page.evaluate(() => document.activeElement?.textContent) === 'NP' && await tip('#presence .pchip:not(.self)') === 'Nacho Pérez'
    && await page.evaluate(() => [...document.querySelectorAll('#presence .pchip')].map(c => c.tabIndex).join()) === '-1,0');
  await bar('07-room-bubble-focus', 40);
  // the focused collaborator leaves: no tooltip left behind, focus goes to your own bubble
  await page.evaluate(() => { window.__STUB.peers = []; window.__STUB.ping(); }); await sleep(200);
  check('a focused bubble that disappears hands focus to your own; no stray tooltip', await page.evaluate(() => document.activeElement?.classList.contains('self') && document.querySelectorAll('#presence .pchip').length === 1));
  await page.evaluate(() => document.activeElement.blur());
  await page.hover('#presence .pchip.self'); await page.evaluate(p => { window.__STUB.peers = p; window.__STUB.ping(); }, peers(7)); await sleep(200);
  const r7 = await row();
  check('many collaborators: you + 4 + "+3" listing the rest', r7.length === 6 && r7[5][0] === '+3' && r7[5][1] === 'Eli Moss, Fay Lin, Gus Hale', JSON.stringify(r7.map(x => x[0])));
  await page.mouse.move(700, 600);
  const sync = await page.evaluate(() => document.querySelector('#mstat use').getAttribute('href'));
  check('the sync indicator uses the circular arrows icon', sync === '#i-sync' && await page.locator('#i-tray').count() === 0, sync);
  await page.evaluate(() => { window.__STUB.status = 'offline'; window.__STUB.ping(); }); await sleep(150);
  const off = await page.evaluate(() => [document.getElementById('mstat').dataset.k, getComputedStyle(document.querySelector('#mstat .mdot')).display]);
  const sOff = await status();
  await page.evaluate(() => { window.__STUB.status = 'unreachable'; window.__STUB.ping(); }); await sleep(150);
  const err = await page.evaluate(() => [document.getElementById('mstat').dataset.k, getComputedStyle(document.querySelector('#mstat .mdot')).backgroundColor]);
  check('its dot states still work (hollow offline, error when the room can\'t be reached); saved state says "Saved locally"', off.join() === 'off,block' && err[0] === 'err' && err[1] !== 'rgba(0, 0, 0, 0)' && sOff.t === 'Saved locally' && sOff.k === 'local', `${off} / ${err} / ${sOff.t}`);
  await bar('08-room-offline');
  await page.evaluate(() => { window.__STUB.status = 'synced'; window.__STUB.ping(); }); await sleep(150);
  check('room synced: saved state "Saved", tooltip says synced with the room', (await status()).t === 'Saved' && /synced with the room/.test((await status()).tip));
  await bar('09-room-many');
  // This room with you + 7: everyone listed, you first; the room drops while it's open: it says so, only you listed
  await page.click('#roomb'); await page.waitForSelector('#dlgRoom[open]');
  const ppl = await page.$$eval('#rmPeople .nm', l => l.map(n => n.textContent));
  check('This room lists you first, then all 7 (no +N here)', ppl.length === 8 && ppl[0] === 'Rami (you)' && ppl[7] === 'Gus Hale', ppl.join(', '));
  await page.evaluate(() => { window.__STUB.status = 'offline'; window.__STUB.peers = []; window.__STUB.ping(); }); await sleep(200);
  check('the room goes offline with the panel open: it says so, only you listed, panel stays', /Offline/.test(await page.textContent('#rmState')) && (await page.$$eval('#rmPeople li', l => l.length)) === 1 && await page.isVisible('#dlgRoom'), await page.textContent('#rmState'));
  await page.evaluate(p => { window.__STUB.status = 'synced'; window.__STUB.peers = p; window.__STUB.ping(); }, peers(7)); await sleep(200);
  check('back online: the state line goes, the people come back', (await page.textContent('#rmState')) === '' && (await page.$$eval('#rmPeople li', l => l.length)) === 8);
  await page.keyboard.press('Escape'); await sleep(150);
  check('Escape closes This room, focus back on its button', await page.evaluate(() => !document.getElementById('dlgRoom').open && document.activeElement?.id === 'roomb'));
  await page.evaluate(() => document.activeElement.blur());

  // ---------- keyboard order: left to right ----------
  await page.mouse.click(700, 600); await page.focus('#proj');
  const order = [];
  for (let i = 0; i < 14; i++) { const e = await page.evaluate(() => { const a = document.activeElement; if (!a.closest('.top')) return null; const r = a.getBoundingClientRect(); return [a.id || a.className, Math.round(r.left)]; }); if (!e) break; order.push(e); await page.keyboard.press('Tab'); }
  check('keyboard order runs left to right across the bar', order.length >= 10 && order.every((e, i) => !i || e[1] > order[i - 1][1]), order.map(e => e[0]).join(' → '));

  // ---------- long name, many collaborators: one row, no overlap, 1920 to 820 ----------
  await page.click('#renamep'); await page.keyboard.press('Control+a'); await page.keyboard.type('The Mountain King (example) — the extended director’s cut, final final v3'); await page.keyboard.press('Enter'); await sleep(300);
  const bad = [];
  for (const w of [1920, 1440, 1280, 1024, 900, 820]) {
    await page.setViewportSize({ width: w, height: 900 }); await sleep(200); await page.mouse.move(5, 300); await page.evaluate(() => document.activeElement.blur());
    const g = await geo();
    if (g.rows !== 1 || g.h !== 49 || g.scroll > 0 || g.gapL < 16 || g.gapR < 16) bad.push(`${w}:${JSON.stringify(g)}`);
    if ([1280, 1024, 820].includes(w)) await bar(`10-narrow-${w}`);
    if (w === 1280 || w === 820) { await page.click('#moreb'); await sleep(150);
      const m = await page.evaluate(() => [...document.querySelectorAll('#moremenu .mi')].filter(e => e.getClientRects().length).map(e => e.textContent));
      if (!m.includes('Import…') || !m.includes('Export…')) bad.push(`${w}: More lacks Import/Export: ${m}`);
      await bar(`11-more-${w}`, 160); await page.keyboard.press('Escape'); await page.evaluate(() => document.activeElement.blur()); }
  }
  check('one row, no overlap with the centre, no page overflow, 1920 to 820 (long name, you + 7 others, This room)', !bad.length, bad.join(' | '));
  await page.setViewportSize({ width: 1280, height: 900 }); await sleep(150); await page.click('#moreb'); await page.click('#moremenu [data-for="exportb"]'); await sleep(250);
  check('Export from More (narrow bar) opens the export dialog', await page.isVisible('#dlgExport')); await page.click('#expCancel');
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(150);

  // ---------- race: renaming while the project switches underneath (an invite link for another project) ----------
  await page.click('#newp'); await sleep(400); await page.keyboard.type('Scratch'); await page.keyboard.press('Enter'); await sleep(400);
  await page.click('#renamep'); await page.keyboard.press('Control+a'); await page.keyboard.type('Scratch renamed');
  await page.evaluate(() => { location.hash = '#join=' + 'r'.repeat(22) + '.' + 't'.repeat(22); }); await sleep(800);
  const names = await page.evaluate(() => [document.getElementById('projname').textContent, document.getElementById('ptitle').hidden, document.getElementById('renamep').getAttribute('aria-label')]);
  await page.click('#proj'); await sleep(150);
  const list = await page.locator('#projmenu [role="menuitemradio"]').allTextContents(); await page.keyboard.press('Escape');
  check('a switch during a rename ends it, saving into the project it was started on', /^The Mountain King/.test(names[0]) && names[1] && names[2] === 'Rename project' && list.includes('Scratch renamed'), `${names} / ${list.join(' | ')}`);

  // ---------- Leave, from This room: two taps, then Collaborate (focus follows) ----------
  await page.focus('#roomb'); await page.keyboard.press('Enter'); await page.waitForSelector('#dlgRoom[open]');
  check('This room from the keyboard: the panel opens with focus inside, named by the room', await page.evaluate(() => document.getElementById('dlgRoom').contains(document.activeElement)) && /The Mountain King/.test(await page.textContent('#rmName')));
  await page.click('#rmLeave'); await sleep(100);
  check('Leave room asks for a second tap ("Tap again to leave"), still in the room', await page.textContent('#rmLeave') === 'Tap again to leave' && await page.isVisible('#presence'));
  await page.focus('#rmLeave'); await page.keyboard.press('Enter'); await sleep(300);
  check('after Leave: panel closed, Collaborate in the bar with the focus, no bubbles, no indicator', await page.evaluate(() => document.activeElement?.id === 'joinb' && document.getElementById('presence').hidden && document.getElementById('mstatw').hidden));
  await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur()); await bar('13-join');
  await page.click('#joinb'); await sleep(250);
  check('Collaborate opens the panel (Share this project / Join with a link)', await page.isVisible('#dlgJoin') && await page.evaluate(() => document.getElementById('dlgJoin').dataset.step) === 'collab');
  await page.keyboard.press('Escape'); await sleep(150);
  check('cancelling Join hands focus back to Join', await page.evaluate(() => document.activeElement?.id) === 'joinb');

  // ---------- Settings: the gear and the word, like Join; below 1280 the gear alone, named on hover and on focus ----------
  await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur());
  const gearAt = () => page.evaluate(() => { const s = document.getElementById('settingsb'), m = document.getElementById('moreb'), j = document.getElementById('joinb'), r = s.getBoundingClientRect(), mr = m.getBoundingClientRect(), l = s.querySelector('.lbl').getBoundingClientRect();
    return { ico: s.querySelector('svg[aria-hidden="true"] use')?.getAttribute('href'), aria: s.getAttribute('aria-label'), title: s.title, text: s.textContent.trim(), lw: Math.round(l.width), w: r.width, h: r.height, mw: mr.width, mh: mr.height,
      font: getComputedStyle(s).font === getComputedStyle(j).font && getComputedStyle(s).color === getComputedStyle(m).color,
      sw: getComputedStyle(s.querySelector('.ico')).strokeWidth, msw: getComputedStyle(m.querySelector('.ico')).strokeWidth, tag: s.tagName, last: s === [...document.querySelectorAll('.tright button')].pop() }; });
  const gear = await gearAt(), named = await page.getByRole('button', { name: 'Settings', exact: true }).count();
  check('Settings: the gear then the word "Settings" (aria-label matches the word), styled like Join, same height and stroke as More, last in the bar', gear.ico === '#i-gear' && gear.text === 'Settings' && gear.lw > 40 && named === 1 && gear.aria === "Settings" && !gear.title && gear.font
    && gear.tag === 'BUTTON' && gear.h === gear.mh && gear.sw === gear.msw && gear.last && await page.locator('#i-sliders').count() === 0, JSON.stringify(gear));
  await page.hover('#settingsb'); await sleep(150);
  check('with its word showing, no tooltip on Settings (at rest or on hover)', await tip('#settingsb') === '');
  await bar('14-settings-label-hover', 40);
  await page.mouse.move(700, 600); await page.focus('#reportb'); await page.keyboard.press('Tab'); await sleep(150);
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.id, s.outlineStyle, s.outlineWidth, s.outlineColor]; });
  await page.focus('#moreb'); const mring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth, s.outlineColor]; });
  check('Settings: the same focus ring as More, no tooltip while its word shows', ring[0] === 'settingsb' && ring[1] !== 'none' && JSON.stringify(ring.slice(1)) === JSON.stringify(mring), `${ring} / ${mring}`);
  await page.setViewportSize({ width: 1024, height: 900 }); await sleep(200); await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur());
  const narrow = await gearAt();
  check('below 1280: the gear alone, same size as More, still named "Settings"', narrow.w === narrow.mw && narrow.h === narrow.mh && narrow.lw <= 1 && await page.getByRole('button', { name: 'Settings', exact: true }).count() === 1 && await tip('#settingsb') === '', JSON.stringify(narrow));
  await page.hover('#settingsb'); await sleep(150);
  check('below 1280: its name on hover', await tip('#settingsb') === 'Settings');
  await bar('14-settings-gear-hover-1024', 40);
  await page.mouse.move(700, 600); await page.focus('#reportb'); await page.keyboard.press('Tab'); await sleep(150);
  check('below 1280: its name on keyboard focus', await page.evaluate(() => document.activeElement?.id) === 'settingsb' && await tip('#settingsb') === 'Settings');
  await bar('15-settings-gear-focus-1024', 40);
  await page.keyboard.press('Enter'); await sleep(250);
  check('the gear opens Settings', await page.isVisible('#dlgSettings')); await page.keyboard.press('Escape'); await sleep(150);
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(150);

  // ---------- Report a problem: a flag right before Settings, icon only at every width, named on hover and on focus ----------
  const flagAt = () => page.evaluate(() => { const f = document.getElementById('reportb'), m = document.getElementById('moreb'), s = document.getElementById('settingsb'), r = f.getBoundingClientRect(), mr = m.getBoundingClientRect(), sr = s.getBoundingClientRect();
    return { ico: f.querySelector('use')?.getAttribute('href'), aria: f.getAttribute('aria-label'), text: f.textContent.trim(), w: r.width, h: r.height, mw: mr.width, mh: mr.height, top: r.top === sr.top,
      sw: getComputedStyle(f.querySelector('.ico')).strokeWidth, msw: getComputedStyle(m.querySelector('.ico')).strokeWidth, color: getComputedStyle(f).color === getComputedStyle(m).color,
      before: f.nextElementSibling === s, gap: Math.round(sr.left - r.right), inMore: !!document.querySelector('#moremenu #reportb, #moremenu [data-for="reportb"]'), barH: document.querySelector('.top').getBoundingClientRect().height }; });
  const flags = {};
  for (const w of [1920, 1440, 1280, 1024, 820]) { await page.setViewportSize({ width: w, height: 900 }); await sleep(150); flags[w] = await flagAt(); }
  check('Report a problem: a flag right before Settings (4px), same size, stroke and colour as More, no word, not in More, one row at 1920–820',
    Object.values(flags).every(f => f.ico === '#i-flag' && f.aria === 'Report a problem' && f.text === '' && f.w === f.mw && f.h === f.mh && f.sw === f.msw && f.color && f.before && f.gap === 4 && f.top && !f.inMore && f.barH === flags[1920].barH)
    && await page.getByRole('button', { name: 'Report a problem', exact: true }).count() === 1, JSON.stringify(flags[820]));
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(150); await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur());
  check('Report a problem: no tooltip at rest', await tip('#reportb') === '');
  await page.hover('#reportb'); await sleep(150);
  check('Report a problem: its name on hover', await tip('#reportb') === 'Report a problem');
  await bar('17-report-hover-1440', 40);
  await page.mouse.move(700, 600); await page.focus('#joinb'); await page.keyboard.press('Tab'); await sleep(150);
  check('Report a problem: reached by Tab before Settings, its name on keyboard focus', await page.evaluate(() => document.activeElement?.id) === 'reportb' && await tip('#reportb') === 'Report a problem');
  await page.keyboard.press('Enter'); await sleep(300);
  check('the flag opens the report dialog', await page.isVisible('#dlgReport'));
  await page.keyboard.press('Escape'); await sleep(200);
  check('closing the report dialog hands focus back to the flag', await page.evaluate(() => document.activeElement?.id) === 'reportb');
  await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur());

  // ---------- an armed Leave does not outlive its panel or follow you into another room ----------
  await db(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    const ids = await new Promise(r => { const q = d.transaction('projects').objectStore('projects').getAllKeys(); q.onsuccess = () => r(q.result); });
    const rooms = Object.fromEntries(ids.map((id, i) => [id, { roomId: String(i).repeat(22), token: 't'.repeat(22), name: 'Rami' }]));
    await new Promise(r => { const q = d.transaction('settings', 'readwrite').objectStore('settings').put({ name: 'Rami', rooms }, 'collab'); q.onsuccess = r; }); });
  await page.reload(); await page.waitForSelector('.card'); await page.waitForFunction(() => window.__STUB && window.__STUB.pid); await sleep(300);
  await page.click('#roomb'); await page.waitForSelector('#dlgRoom[open]'); await page.click('#rmLeave'); await sleep(100);
  const armedIn = await page.textContent('#projname');
  await page.evaluate(() => window.__STUB.ping()); await sleep(100);
  check('an armed Leave survives a re-render of the same room', await page.textContent('#rmLeave') === 'Tap again to leave');
  await page.keyboard.press('Escape'); await sleep(150);
  await page.click('#proj'); await sleep(150); await page.locator('#projmenu [role="menuitemradio"][aria-checked="false"]').first().click(); await sleep(400);
  await page.click('#roomb'); await page.waitForSelector('#dlgRoom[open]');
  const other = await page.evaluate(() => [document.getElementById('projname').textContent, document.getElementById('rmName').textContent, document.getElementById('rmLeave').textContent, document.getElementById('rmLeave').hasAttribute('data-armed')]);
  check('closing the panel disarms Leave; another room project\'s panel shows that room, unarmed', other[0] !== armedIn && other[1] === other[0] && other[2] === 'Leave room' && !other[3], `${armedIn} → ${JSON.stringify(other)}`);
  const pidBefore = await page.evaluate(() => window.__STUB.pid);
  await page.click('#rmLeave'); await sleep(100);
  check('so one tap there only arms it (still in that room)', await page.textContent('#rmLeave') === 'Tap again to leave' && await page.evaluate(() => window.__STUB.pid) === pidBefore && await page.isVisible('#presence'));
  await page.keyboard.press('Escape'); await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur()); await sleep(300);

  // ---------- no project: More holds nothing usable on a wide bar, so it isn't there ----------
  await db(async () => { const d = await new Promise(r => { const q = indexedDB.open('cueboard-local', 1); q.onsuccess = () => r(q.result); });
    await new Promise(r => { const q = d.transaction('projects', 'readwrite').objectStore('projects').clear(); q.onsuccess = r; }); });
  await page.reload(); await page.waitForFunction(() => document.getElementById('projname').textContent === 'No projects', null, { timeout: 15000 }); await sleep(300);
  const moreAt = async w => { await page.setViewportSize({ width: w, height: 900 }); await sleep(150); return page.isVisible('#moreb'); };
  const vis = { 1920: await moreAt(1920), 1440: await moreAt(1440), 1280: await moreAt(1280), 900: await moreAt(900) };
  check('no project: More is hidden at 1440 and 1920 (only a disabled Delete project), back below 1440 (Import, Export)', !vis[1920] && !vis[1440] && vis[1280] && vis[900], JSON.stringify(vis));
  // Report a problem works without a project (that's when something may be broken): it's in the bar, not in More
  check('no project: Report a problem is still in the bar, enabled', await page.isVisible('#reportb') && await page.isEnabled('#reportb'));
  await page.setViewportSize({ width: 1280, height: 900 }); await sleep(150);
  await page.focus('#moreb'); await page.keyboard.press('ArrowDown'); await sleep(150);
  check('no project, narrow bar: opening More by keyboard focuses its first enabled entry', await page.evaluate(() => document.activeElement?.closest('#moremenu') && !document.activeElement.disabled && document.activeElement.textContent) === 'Import…');
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 }); await sleep(150);
  const ord = []; await page.focus('#proj');
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); const id = await page.evaluate(() => document.activeElement?.closest('.top') ? document.activeElement.id : null); if (!id) break; ord.push(id); }
  check('no project, wide bar: Tab skips straight from the project zone past the missing More', !ord.includes('moreb') && ord.includes('newp'), ord.join(' → '));
  await page.mouse.move(700, 600); await page.evaluate(() => document.activeElement.blur()); await bar('16-no-project-1440');
} catch (e) { check('run completed', false, e.stack.split('\n').slice(0, 3).join(' ')); }
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close(); srv.close();
