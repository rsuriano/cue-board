# Cue Board

Single-file web app: everything is in `index.html`, with no build step and no dependencies. `server.mjs` is an optional local relay that only listens on `127.0.0.1`. See `README.md` for what the app does.
The app (`index.html`) still has no build step and no dependencies; the repo now also has a root `package.json` with npm workspaces for `packages/`, which are never deployed to hephaestus.

## Deploying

The live copy is at https://cue.bedrocklabs.dev. It's served by the
[hephaestus](https://github.com/rsuriano/hephaestus) repo, as a copy of this
repo's `index.html`, `collab.js`, `example/` and `fonts/` at `pages/cue/`. Pushing here does **not** update the live site.

After changing `index.html`, `collab.js`, `example/` or `fonts/` here (`collab.js` is built from `packages/collab-client` with `npm run build:collab` and committed; rebuild it after changing that package):

1. Commit and push this repo.
2. Copy `index.html`, `collab.js`, `example/` and `fonts/` into `hephaestus/pages/cue/` (clone `rsuriano/hephaestus` if needed).
3. Commit in hephaestus, e.g. `cue: sync with rsuriano/cue-board <short sha>`, and push to `main`.
4. A webhook deploys it on the VPS in about 30 s. Check that https://cue.bedrocklabs.dev serves the new version.

Only `index.html`, `collab.js`, `example/` and `fonts/` go to hephaestus (without `fonts/` the hosted copy falls back to system fonts; without `collab.js` joining a room fails, everything else works).

The sync server URL is set by `<meta name="cue-sync-url" content="">` in `index.html`. It's empty in this repo, which turns collaboration off (no network, `collab.js` never loads). The hosted copy sets it, in hephaestus only, to `wss://sync.bedrocklabs.dev`. The sync server itself (`packages/sync-server`) is not deployed by hephaestus' pages; see its `SPIKE.md`. Never deploy `server.mjs` or `.env`: the hosted copy is static, and each visitor uses their own OpenRouter key, stored in their browser.

## Don't commit

- `.env` (OpenRouter key for `server.mjs`)
- `*.cueboard.json` (project exports, may include personal media)

Both are in `.gitignore`.
