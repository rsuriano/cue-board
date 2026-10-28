/* Real-browser check of the demo:
     npm run build:demo && node demo/browser-check.mjs [--playwright <path to playwright-core>] [--chromium <executable>]
   (or PLAYWRIGHT_CORE / CHROMIUM in the environment). Throwaway data dir, server on 127.0.0.1:3360. Writes demo/shot.png. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import { startServer } from '../src/server.mjs';
import { ProjectStore } from '../src/store.mjs';
import { initProject } from '../src/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { playwright: { type: 'string' }, chromium: { type: 'string' } } });
const { chromium } = createRequire(import.meta.url)(args.playwright || process.env.PLAYWRIGHT_CORE || 'playwright-core');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sync-browser-'));
const doc = new Y.Doc(); initProject(doc, { title: 'Browser check' });
const { id, token } = new ProjectStore(dir).createProject('Browser check', doc);
const srv = await startServer({ port: Number(process.env.PORT || 3360), dataDir: dir, serveDemo: true, logLevel: 'warn' });
const browser = await chromium.launch({ executablePath: args.chromium || process.env.CHROMIUM || undefined, headless: true, args: ['--no-sandbox'] });
let failed = false;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`); if (!ok) failed = true; };

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 520 } });
  page.on('pageerror', e => check('no page errors', false, e.message));
  await page.goto(`http://127.0.0.1:${srv.port}/demo/?room=${id}&token=${token}`);
  await page.waitForSelector('#p1[data-ready="1"]'); await page.waitForSelector('#p2[data-ready="1"]');
  const val = sel => page.locator(sel).inputValue();
  const same = async () => (await val('#p1 .title')) === (await val('#p2 .title')) && (await val('#p1 .notes')) === (await val('#p2 .notes'));
  const settle = async () => { for (let i = 0; i < 100 && !(await same()); i++) await page.waitForTimeout(30); return same(); };

  // 1. both panes type into the same notes field, keystrokes interleaved
  const a = 'Horns hold a low note. ', b = 'Cut on the first pizzicato. ';
  await page.locator('#p1 .notes').click(); await page.locator('#p2 .notes').click();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) await page.locator('#p1 .notes').press(a[i] === ' ' ? 'Space' : a[i]);
    if (b[i]) await page.locator('#p2 .notes').press(b[i] === ' ' ? 'Space' : b[i]);
  }
  await page.locator('#p1 .title').pressSequentially('The mountain');
  check('concurrent typing converges', await settle(), JSON.stringify(await val('#p1 .notes')));
  const n1 = await val('#p1 .notes');
  check('no keystroke lost', n1.length === a.length + b.length && [...a + b].sort().join() === [...n1].sort().join());

  // 2. pane 2 goes offline, both edit, pane 2 comes back
  await page.locator('#p2 .toggle').click();
  await page.waitForSelector('#p2[data-state="offline"]');
  await page.locator('#p2 .title').press('End'); await page.locator('#p2 .title').pressSequentially(' at night');
  await page.locator('#p2 .notes').press('End'); await page.locator('#p2 .notes').pressSequentially('(offline note)');
  await page.locator('#p1 .title').press('Home'); await page.locator('#p1 .title').pressSequentially('Wide: ');
  await page.waitForTimeout(300);
  check('offline edits stay local', !(await val('#p1 .title')).includes('night') && (await val('#p2 .title')) === 'The mountain at night');
  await page.locator('#p2 .toggle').click();
  await page.waitForSelector('#p2[data-state="online"]');
  const ok = await settle();
  const title = await val('#p1 .title'), notes = await val('#p1 .notes');
  check('after reconnect both panes match', ok, `title=${JSON.stringify(title)}`);
  check('both sides kept', title === 'Wide: The mountain at night' && notes.endsWith('(offline note)'), JSON.stringify(notes));
  await page.screenshot({ path: path.join(here, 'shot.png') });
} catch (e) {
  check('browser run', false, e.message);
} finally {
  await browser.close(); await srv.close(); fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
