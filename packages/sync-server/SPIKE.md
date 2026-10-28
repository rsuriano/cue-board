# Sync spike: Yjs server for multi-user cue boards

Branch `feat/monorepo-sync`, 2026-10-28. A WebSocket server speaking the standard Yjs protocol, one Y.Doc per project room, file persistence, invite tokens, a cue board schema that is a superset of today's `.cueboard.json`, and a two-pane demo. `index.html`, `example/` and `server.mjs` are untouched.

## Run it

```bash
npm install                                                         # at the repo root (workspaces)
npm run create-project -w @cue-board/sync-server -- "My video"      # prints the room id and an invite link
npm run demo -w @cue-board/sync-server                              # builds the demo, serves it on http://127.0.0.1:3300/demo/
```

Open the printed invite link. `--import file.cueboard.json` (or `example/example.js`) seeds the room from an export. Tests: `npm test`. Browser check: `npm run build:demo -w @cue-board/sync-server`, then `node packages/sync-server/demo/browser-check.mjs --playwright <playwright-core dir> --chromium <chromium binary>`.

Settings are environment variables, listed at the top of `src/main.mjs`. It listens on `127.0.0.1:3300` by default; put a reverse proxy in front for TLS.

## Layout

| Path | What |
|---|---|
| `src/server.mjs` | `startServer()`: HTTP + WebSocket, rooms, sync and awareness relay, limits, compaction, shutdown |
| `src/store.mjs` | `ProjectStore`: `DATA_DIR/<room>/project.json` (hashed tokens) and `updates.bin` (framed Yjs updates) |
| `src/schema.mjs` | The Y.Doc layout and helpers. See `docs/data-model.md` |
| `src/import-cueboard.mjs` | `.cueboard.json` ⇄ Y.Doc |
| `bin/create-project.mjs` | CLI: new room + invite link, `--import`, `--invite <room>` for another token |
| `demo/` | Dev-only two-pane page (`client.mjs` → esbuild → `dist/client.js`, not committed) and `browser-check.mjs` |
| `test/` | `node --test` suites, `measure.mjs` for the numbers below |

## What was verified

`npm test` (Node 22, `node:test`, throwaway temp data dirs, ports 3350-3354). 7/7 pass, stable over repeated runs:

| | Test | Result |
|---|---|---|
| a | Two clients type 50 chars each into one Y.Text, interleaved, with no waiting | converge, no char lost |
| b | Client B goes offline, edits title and notes and adds a shot, while A edits the title; B reconnects | both sides have everything: `"The Opening shot"`, B's notes, B's new shot |
| c | 20 edits with compaction every 7 records; state read from disk while the server still runs; restart; then a torn record appended to the log, restart again | text identical every time; torn tail cut off |
| d | Wrong token, missing token, unknown room, path traversal in the room id | 4401, 4401, 4404, 4404; a valid client still joins |
| e | 100 KB frame with a 64 KB limit; garbage frame; per-IP limit of 3 | 1009, 4400, 4429; the server keeps serving and the room still syncs |
| f | Example project → Y.Doc → over the wire → `.cueboard.json` | equal to the original with payloads replaced by hashes; byte-identical `project` when payloads are handed back; no payload bytes in the doc |
| f | Synthetic export with takes, frames, references and an unknown key | lossless; `useInCut` derived correctly; identical files deduplicate to one hash |

Browser (`demo/browser-check.mjs`, testkit's playwright-core + `/snap/bin/chromium`, port 3360): 5/5 PASS. Both panes type into the same notes field with keystrokes interleaved: they converge and no keystroke is lost. Pane 2 goes offline and both panes edit: the edits stay local. Pane 2 comes back: both panes show `"Wide: The mountain at night"` and the same notes. Screenshot: `demo/shot.png`.

Also run by hand: `create-project` (plain, `--import example/example.js`, `--data-dir`), and `npm start` followed by SIGTERM (logs `listening` / `shutting down` / `stopped`).

## Numbers (this machine, loopback)

- **Example project as a Yjs update: 17,738 bytes** (13 shots). 4.9 KB of that is the song's waveform `peaks`. The 2.4 MB song is only a hash.
- **Sync latency** a → server → b: **median 0.5 ms, p95 0.7 ms** (200 edits). Over a real network it's RTT plus about 1 ms.
- **Memory: about 290 KB per loaded room** (heap, 100 example rooms with one client each, client docs included). RSS was 173 MB for the whole test process. Rooms unload 30 s after their last client leaves.
- **Doc growth:** 20,000 keystrokes into one note (a third of them deleted) plus 200 nudges of a cut grow the doc from 17.7 KB to **180 KB** after GC.
- **Reconnect storm:** 100 clients reconnect at once to a freshly started server: 100 rooms loaded from disk and synced in **0.7 s**.

## What surprised me

- **y-websocket syncs browser tabs over BroadcastChannel by default.** Two panes on one page would have "synced" without the server, offline toggle included. The demo and tests pass `disableBc: true`. The real app should probably keep BroadcastChannel (it's free), but tests of server sync have to turn it off.
- **The per-IP connection limit trips easily.** Every local client shares 127.0.0.1, and behind a reverse proxy every user shares the proxy's IP unless `TRUST_PROXY=1` is set. With the default of 16 and no `TRUST_PROXY`, the 17th user anywhere is refused. My own measurement script hit this.
- **Two people typing at the same caret position interleave character by character** ("HCourtn so nh…" in the screenshot). This is correct CRDT behaviour, not a bug, but on a shared notes field it will happen. Presence (show where the other person's caret is) is the usual fix.
- **The current format maps onto a CRDT cleanly.** Shots are already ordered by `start`, not by array position, and "use in cut" is already a single pointer (`section.img`). Neither needed a model change.
- **y-websocket's client retries rejected connections forever**, with backoff up to 2.5 s. The demo stops on 44xx close codes; the real client must too.

## Risks

- **Doc growth and GC.** Yjs keeps a small tombstone per deleted run forever, and GC can't drop deleted items while anyone could still need them. In the measurement above, a note with 13 K visible characters cost about 160 KB of doc after 20 K keystrokes, because each typing session with backspaces fragments the text. That's fine at cue-board scale. If it ever matters: periodically snapshot into a fresh doc for a new room epoch (clients reload).
- **Auth model.** A bearer invite token is all-or-nothing: anyone with the link can read and write, forever, until the hash is removed from `project.json` (which revokes all holders at once if they share one token). There are no users, no roles (viewer/editor) and no per-person revocation or audit. Tokens travel in the URL, so they end up in proxy logs and browser history. Fine for friends; not for strangers.
- **Durability.** Appends are synchronous writes but not fsynced, so a clean restart or a process crash loses nothing, while a power loss can lose the last seconds. Compaction itself is fsync + rename. One process owns the files: there is no locking, so running two servers on one `DATA_DIR`, or running `create-project --invite` against a room the server has loaded, races.
- **Reconnect storms.** After a deploy every client reconnects within ~2.5 s, each loads its room from disk and does a full state-vector sync. 100 rooms took 0.7 s here. Thousands would need jittered backoff and maybe a loading queue. Nothing stops a valid token holder from opening 16 sockets or sending 2 MB updates in a loop: there's no rate limit per message, only per size.
- **Malicious clients with a valid token** can write anything the schema allows, or things it doesn't: the server doesn't validate doc structure. They can also delete everything, and the CRDT will faithfully sync the deletion. Backups and snapshots are the defence (see next steps).
- **Single process, in-memory rooms.** Horizontal scaling needs room-to-process affinity (sticky routing by room id). Fine for a long time.

## Not done

- Integration with `index.html` (the app still uses IndexedDB only). No `apps/web` move.
- Media of any kind: no P2P transfer, WebTorrent/WebRTC, seed or encryption. Refs are hashes only; nothing fetches media by hash.
- Users, accounts, roles, read-only links, revoking a single person, token expiry, an admin UI. `--invite` adds tokens; revoking means editing `project.json` by hand.
- Server-side schema validation of updates; history, snapshots or undo; backups.
- Awareness/presence in the demo (the server relays it, but nothing renders it). `Y.UndoManager` wiring.
- Hashing in the browser (import uses `node:crypto`; the app will need SubtleCrypto).
- Rate limiting per message, metrics, TLS (expected from the reverse proxy), Docker/systemd, deploy. Not run on the VPS.
- `fsync` per append (deliberately skipped; see Durability).

## Recommendation: next two steps

1. **Wire the app to a room, behind a flag, after the design branch lands.** Move `index.html` to `apps/web`, keep IndexedDB for media and offline (`y-indexeddb` for the doc), and replace the `cur` project object with a Y.Doc view through `schema.mjs`. On the first connect, import the local project via `cueboardToDoc`. Done means two friends editing the same cut live, with media still local and only hashes shared. Do `docToCueboard` export from the doc at the same time so nothing is ever locked in.
2. **Make it safe to run for friends before adding media.** Nightly snapshot of each room (a copy of `updates.bin`), per-person invite tokens with a label and `--revoke`, `TRUST_PROXY` behind the real proxy, a systemd unit, and the client stopping on 44xx. Then start the P2P media phase, with the hash refs already in place.
