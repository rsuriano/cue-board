# Cue Board

Single-file web app: everything is in `index.html`, with no build step and no dependencies. `server.mjs` is an optional local relay that only listens on `127.0.0.1`. See `README.md` for what the app does.

## Deploying

The live copy is at https://cue.bedrocklabs.dev. It's served by the
[hephaestus](https://github.com/rsuriano/hephaestus) repo, as a copy of this
repo's `index.html` and `example/` at `pages/cue/`. Pushing here does **not** update the live site.

After changing `index.html` or `example/` here:

1. Commit and push this repo.
2. Copy `index.html` and `example/` into `hephaestus/pages/cue/` (clone `rsuriano/hephaestus` if needed).
3. Commit in hephaestus, e.g. `cue: sync with rsuriano/cue-board <short sha>`, and push to `main`.
4. A webhook deploys it on the VPS in about 30 s. Check that https://cue.bedrocklabs.dev serves the new version.

Only `index.html` and `example/` go to hephaestus. Never deploy `server.mjs` or `.env`: the hosted copy is static, and each visitor uses their own OpenRouter key, stored in their browser.

## Don't commit

- `.env` (OpenRouter key for `server.mjs`)
- `*.cueboard.json` (project exports, may include personal media)

Both are in `.gitignore`.
