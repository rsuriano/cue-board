// Bundles src/collab.mjs (Yjs, y-websocket, the sync server's schema and export code) into one ES module at the repo
// root: collab.js, committed and deployed next to index.html. No CDN, nothing loaded at runtime from anywhere else.
// import-cueboard.mjs imports node:crypto for the server-side import; the browser only uses its export half
// (docToCueboard), so node:crypto is stubbed out.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
await build({
  entryPoints: [here('src/collab.mjs')],
  outfile: here('../../collab.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'eof',
  banner: { js: '/* Cue Board collaboration client. Built from packages/collab-client (npm run build:collab); do not edit. */' },
  plugins: [{
    name: 'no-node-crypto',
    setup(b) {
      b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'node:crypto', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function createHash() { throw new Error("not in the browser"); }' }));
    },
  }],
  logLevel: 'warning',
});
