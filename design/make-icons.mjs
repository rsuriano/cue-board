// The home screen icons (icons/icon-192.png, icons/icon-512.png) from one SVG, drawn with the app's tokens:
// bg tile, neutral waveform bars, the orange playhead. Full bleed, the mark inside the maskable safe zone (80%).
//   node design/make-icons.mjs <repo-root>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const root = process.argv[2] || '.';
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="#121110"/>
<g transform="translate(16 16) scale(.62) translate(-16 -16)">
<g fill="#5f5b56"><rect x="2" y="18" width="4" height="8" rx="2"/><rect x="8" y="14" width="4" height="16" rx="2"/></g>
<g fill="#858179"><rect x="20" y="12" width="4" height="18" rx="2"/><rect x="26" y="17" width="4" height="10" rx="2"/></g>
<rect x="14" y="8" width="4" height="22" rx="2" fill="#f0a33a"/><path d="M6 2h20L16 13z" fill="#f0a33a"/>
</g></svg>`;
mkdirSync(join(root, 'icons'), { recursive: true });
const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
for (const n of [192, 512]) {
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(`<style>html,body{margin:0;background:#121110}svg{display:block;width:${n}px;height:${n}px}</style>${SVG}`);
  writeFileSync(join(root, 'icons', `icon-${n}.png`), await page.screenshot({ type: 'png' }));
}
await browser.close();
console.log('icons/icon-192.png, icons/icon-512.png');
