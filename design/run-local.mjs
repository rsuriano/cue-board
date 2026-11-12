// Runs one design check with the Playwright headless shell under ~/.cache/ms-playwright and the testkit next to it,
// for machines where the env-prefixed form is awkward:  node design/run-local.mjs design/<check>.mjs <args…>
// CUE_TESTKIT / CUE_CHROMIUM already set win; otherwise the newest headless shell found is used.
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const pw = join(homedir(), '.cache/ms-playwright');
if (!process.env.CUE_CHROMIUM && existsSync(pw)) {
  const d = readdirSync(pw).filter(n => n.startsWith('chromium_headless_shell-')).sort().pop();
  if (d) process.env.CUE_CHROMIUM = join(pw, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
}
if (!process.env.CUE_TESTKIT && existsSync(join(homedir(), 'testkit/node_modules/playwright-core'))) process.env.CUE_TESTKIT = join(homedir(), 'testkit') + '/';
await import('./local-env.mjs');
const [script, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], resolve(script), ...rest];
await import(pathToFileURL(resolve(script)).href);
