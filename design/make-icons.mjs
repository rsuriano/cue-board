// The home screen icons from one mark, drawn with the app's tokens: bg tile, neutral waveform bars, the orange playhead.
//   icons/icon-192.png, icon-512.png: full bleed, the mark inside the maskable safe zone (the 80% circle). The manifest's
//     "maskable" entries, and iOS's apple-touch-icon (iOS rounds the corners itself)
//   icons/icon-any-192.png, icon-any-512.png: a rounded tile on transparent, the mark larger. The manifest's "any" entries
//   node design/make-icons.mjs <repo-root>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const root = process.argv[2] || '.';
const MARK = `<g fill="#5f5b56"><rect x="2" y="18" width="4" height="8" rx="2"/><rect x="8" y="14" width="4" height="16" rx="2"/></g>
<g fill="#858179"><rect x="20" y="12" width="4" height="18" rx="2"/><rect x="26" y="17" width="4" height="10" rx="2"/></g>
<rect x="14" y="8" width="4" height="22" rx="2" fill="#f0a33a"/><path d="M6 2h20L16 13z" fill="#f0a33a"/>`;
const svg = (tile, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile}
<g transform="translate(16 16) scale(${scale}) translate(-16 -16)">${MARK}</g></svg>`;
const ICONS = {
  icon: svg('<rect width="32" height="32" fill="#121110"/>', 0.62),
  'icon-any': svg('<rect x="1" y="1" width="30" height="30" rx="7" fill="#121110"/>', 0.78),
};
mkdirSync(join(root, 'icons'), { recursive: true });
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const out = [];
for (const [name, s] of Object.entries(ICONS)) for (const n of [192, 512]) {
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${n}px;height:${n}px}</style>${s}`);
  writeFileSync(join(root, 'icons', `${name}-${n}.png`), await page.screenshot({ type: 'png', omitBackground: true }));
  out.push(`icons/${name}-${n}.png`);
}
await browser.close();
console.log(out.join(', '));
