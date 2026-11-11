// Runs the design checks on a machine without /home/ramiro/testkit or the chromium snap, without editing them:
//   CUE_TESTKIT=<dir with node_modules/playwright-core>/ CUE_CHROMIUM=<chromium binary> \
//     node --import ./design/local-env.mjs design/undo-check.mjs . <out-dir>
// It swaps the two hard-coded paths as each check script loads. With neither variable set it changes nothing.
import { registerHooks } from 'node:module';
const swaps = [['/home/ramiro/testkit/', process.env.CUE_TESTKIT], ['/snap/bin/chromium', process.env.CUE_CHROMIUM]].filter(s => s[1]);
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (swaps.length && /\/design\/[^/]+\.mjs$/.test(url) && r.source) r.source = swaps.reduce((s, [a, b]) => s.replaceAll(a, b), String(r.source));
    return r;
  },
});
