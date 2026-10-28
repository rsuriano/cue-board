// Spacing/rhythm audit for the design pass. Reads computed styles from the running page; never talks to OpenRouter.
//   node design/measure.mjs <repo-root> [out.json]
// Reports: spacing values off the 4px scale, control heights per toolbar row, panel insets, radii, font sizes,
// clipped text (project selector, timeline labels) and horizontal overflow.
import { createRequire } from 'node:module';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const [root, outFile] = process.argv.slice(2);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };
const srv = createServer((q, r) => {
  const p = join(root, normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  try { if (!statSync(p).isFile()) throw 0; r.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); r.end(readFileSync(p)); }
  catch { r.writeHead(404); r.end(); }
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
const page = await ctx.newPage();
await page.goto(origin + '/index.html'); await page.waitForSelector('.card'); await page.evaluate(() => document.fonts.ready);
await page.locator('.card').nth(2).click(); await page.waitForTimeout(300);

const audit = async label => page.evaluate(label => {
  const SCALE = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40]);
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const offScale = {};
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']) {
      const v = parseFloat(cs[p]); if (isNaN(v) || p.startsWith('margin') && cs[p] === 'auto') continue;
      if (/margin(Left|Right)/.test(p) && cs.display !== 'inline' && Math.abs(v) > 40) continue; // auto-centering
      if (!SCALE.has(Math.abs(Math.round(v * 100) / 100))) (offScale[name(el)] ||= []).push(`${p}=${cs[p]}`);
    }
  }
  const rows = {};
  for (const sel of ['.top', '.transport', '.ed-head', '.bbar', '.genrow', '.frame .row', '.tbody .row', '.dlg .row', '.chips', '.songbar']) {
    document.querySelectorAll(sel).forEach((row, i) => {
      if (!vis(row)) return;
      const kids = [...row.children].filter(vis).filter(k => k.matches('button,select,input,label,.btn,.chip,nav,.sidetab,.ed-n,.clip,.status,kbd'));
      rows[`${sel}[${i}]`] = kids.map(k => `${name(k)}:${Math.round(k.getBoundingClientRect().height)}`);
    });
  }
  const panels = {};
  for (const sel of ['.top', '.editor', '.genbox', '.frame', '.blist', '.bempty', '.songbar', '.dlg', 'dialog', '.cbody', '.tbody', '.bitem', '.timeline', '.monitor', '.take', '.card']) {
    const el = [...document.querySelectorAll(sel)].find(vis); if (!el) continue;
    const cs = getComputedStyle(el);
    panels[sel] = { pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`, radius: cs.borderTopLeftRadius, gap: cs.rowGap + '/' + cs.columnGap };
  }
  const radii = {}, sizes = {};
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue; const cs = getComputedStyle(el);
    if (cs.borderTopLeftRadius !== '0px') radii[cs.borderTopLeftRadius] = (radii[cs.borderTopLeftRadius] || 0) + 1;
    if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) sizes[cs.fontSize] = (sizes[cs.fontSize] || 0) + 1;
  }
  const proj = document.getElementById('proj');
  const optText = proj.selectedOptions[0]?.text || '';
  const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(proj).font;
  const projClip = { width: proj.clientWidth, textWidth: Math.round(c.measureText(optText).width), text: optText, title: proj.title || '' };
  return { label, offScale, rows, panels, radii, sizes, projClip, overflow: document.documentElement.scrollWidth - innerWidth };
}, label);

const res = [];
res.push(await audit('sideA 1440'));
await page.click('.sidetab[data-side="b"]'); await page.waitForTimeout(400);
res.push(await audit('sideB 1440'));
await page.click('.sidetab[data-side="a"]'); await page.waitForTimeout(200);
await page.click('#settingsb'); await page.waitForTimeout(300);
res.push(await audit('settings'));
await page.keyboard.press('Escape');
console.log(JSON.stringify(res, null, 1));
if (outFile) writeFileSync(outFile, JSON.stringify(res, null, 2));
await browser.close(); srv.close();
