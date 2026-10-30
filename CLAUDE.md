# Cue Board

Single-file web app: everything is in `index.html`, with no build step and no dependencies. `server.mjs` is an optional local relay that only listens on `127.0.0.1`. See `README.md` for what the app does.
The app (`index.html`) still has no build step and no dependencies; the repo now also has a root `package.json` with npm workspaces for `packages/`, which are never deployed to hephaestus.

## Deploying

The live copy is at https://cue.bedrocklabs.dev. It's served by the
[hephaestus](https://github.com/rsuriano/hephaestus) repo, as a copy of this
repo's `index.html`, `collab.js`, `manifest.webmanifest`, `icons/`, `example/` and `fonts/` at `pages/cue/`. Pushing here does **not** update the live site.

After changing any of those here (`collab.js` is built from `packages/collab-client` with `npm run build:collab` and committed; rebuild it after changing that package):

1. Commit and push this repo.
2. Copy `index.html`, `collab.js`, `manifest.webmanifest`, `icons/`, `example/` and `fonts/` into `hephaestus/pages/cue/` (clone `rsuriano/hephaestus` if needed).
   **Then set the sync URL in the copied file** (this repo's `index.html` has it empty, and copying it as is would silently turn collaboration off on the live site):
   `sed -i 's|<meta name="cue-sync-url" content="[^"]*">|<meta name="cue-sync-url" content="wss://sync.bedrocklabs.dev">|' hephaestus/pages/cue/index.html`
   **And set the build id** to this repo's short sha (problem reports carry it; empty means `dev`):
   `sed -i "s|<meta name=\"cue-build\" content=\"[^\"]*\">|<meta name=\"cue-build\" content=\"$(git -C <this repo> rev-parse --short HEAD)\">|" hephaestus/pages/cue/index.html`
3. Commit in hephaestus, e.g. `cue: sync with rsuriano/cue-board <short sha>`, and push to `main`.
4. A webhook deploys it on the VPS in about 30 s. Check that https://cue.bedrocklabs.dev serves the new version **and** that `curl -s https://cue.bedrocklabs.dev/ | grep cue-sync-url` shows `wss://sync.bedrocklabs.dev`, and `grep cue-build` shows the sha.

`manifest.webmanifest` and `icons/` are the phone install: without them the app can't be added to a home screen as an app, and iOS may clear a phone's projects after a week. Their paths are all relative (`start_url`, `scope` and `id` are `./`, resolved against the manifest's URL), so they work at the host's root, where `pages/cue/` is served, or under any subpath. Only `index.html`, `collab.js`, `manifest.webmanifest`, `icons/`, `example/` and `fonts/` go to hephaestus (without `fonts/` the hosted copy falls back to system fonts; without `collab.js` joining a room fails, everything else works).

Media between collaborators (`docs/media-p2p.md`) uses `<meta name="cue-ice-urls" content="">` for WebRTC ICE servers. Empty (this repo and, until the owner picks an option, the hosted copy) means no STUN/TURN: peers on one network connect directly, everyone else goes through the sync server's encrypted relay. If the owner picks STUN or coturn, set it in the hephaestus copy only, like the sync URL: `sed -i 's|<meta name="cue-ice-urls" content="[^"]*">|<meta name="cue-ice-urls" content="stun:…">|' hephaestus/pages/cue/index.html`.

**Sync server changes need a redeploy in `/opt/cue-sync`** (hephaestus doesn't deploy it): `packages/sync-server/src/media-relay.mjs` and `media-limits.mjs` are new and `server.mjs` / `main.mjs` changed (message type 10: media signaling and relay). Update the checkout there and restart the service; no new dependency, no data migration. Optional env: `RELAY_ROOM_BYTES_PER_SEC` (8 MiB), `RELAY_IP_BYTES_PER_SEC` (4 MiB), `RELAY_MAX_TRANSFER_BYTES` (2 GiB: the largest file relayed; the server tells clients, so don't set it below 2000 MB or files the app downloads automatically would need a direct connection). Behind the proxy keep `TRUST_PROXY=1` so the per-IP relay cap sees real client IPs. An old server still syncs the doc with the new app; only media transfers won't happen (no peer ids).

**Rooms from the app (feat/create-rooms) need a sync server redeploy in `/opt/cue-sync`** (`docs/collaboration.md`, "Rooms from the app"): new `src/api.mjs`, `src/access.mjs`, `bin/create-code.mjs`, `list-codes.mjs`, `revoke-code.mjs`, `attach-owner.mjs`; `server.mjs`, `store.mjs`, `main.mjs` changed. No new dependency, no data migration (legacy rooms keep working, without an owner). Then, in that order: (1) set `CORS_ORIGINS=https://cue.bedrocklabs.dev` in the service's env (without it the app can't create rooms: every browser call is refused), keep `TRUST_PROXY=1` (the redeem rate limit is per client IP); optional `MAX_ROOMS` (10000), `MAX_ROOM_BYTES` (64 MiB), `CREATE_PER_HOUR` (30); (2) restart the service; (3) make the first code: `cd /opt/cue-sync && DATA_DIR=<the service's DATA_DIR> npm run create-code -w @cue-board/sync-server -- --label "Nacho"` and hand the printed code to that person (it's shown once; `list-codes`, `revoke-code <id>`); (4) check `curl -s -X POST https://sync.bedrocklabs.dev/verify -H 'content-type: application/json' -d '{"code":"x"}'` answers 401 `bad_code`, and from the app "Share this project" asks for the code. Caddy already redacts `Authorization` in its access log; nothing else to filter.

**Problem reports (feat/report-problem) need a sync server redeploy in `/opt/cue-sync`** (`docs/reports.md`): new `src/reports.mjs`, `bin/list-reports.mjs`, `show-report.mjs`, `clear-reports.mjs`; `api.mjs` (`POST /reports`), `access.mjs`, `server.mjs`, `main.mjs` changed. No new dependency, no data migration; reports land in `DATA_DIR/reports/`. Keep `CORS_ORIGINS` and `TRUST_PROXY=1` as they are (the per-IP report limit needs real IPs); optional `REPORTS_PER_HOUR` (5 per IP), `REPORTS_PER_DAY` (200 for everyone), `MAX_REPORTS` (500 kept). Restart the service, then send one report from the live app (More → Report a problem…) and read it: `cd /opt/cue-sync && DATA_DIR=<the service's DATA_DIR> npm run list-reports -w @cue-board/sync-server` and `show-report <id>`; its `build` must be the deployed sha. An old server answers the app's Send with 404: the app then offers Copy and Download, nothing breaks.

The sync server URL is set by `<meta name="cue-sync-url" content="">` in `index.html`. It's empty in this repo, which turns collaboration off (no network, `collab.js` never loads). The hosted copy sets it, in hephaestus only, to `wss://sync.bedrocklabs.dev`. The sync server itself (`packages/sync-server`) is not deployed by hephaestus' pages; see its `SPIKE.md`. Never deploy `server.mjs` or `.env`: the hosted copy is static, and each visitor uses their own OpenRouter key, stored in their browser.

## Don't commit

- `.env` (OpenRouter key for `server.mjs`)
- `*.cueboard.json` (project exports, may include personal media)

Both are in `.gitignore`.
