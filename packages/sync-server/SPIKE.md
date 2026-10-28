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

### Behind a reverse proxy (`TRUST_PROXY`)

Without `TRUST_PROXY=1`, every user behind the proxy shares the proxy's IP for the per-IP limit. With it, the client IP comes from **`X-Forwarded-For`**, read **from the right**: the client IP is the entry `TRUSTED_PROXY_HOPS` places from the right (default 1, the last entry). Each proxy appends the address it saw, so anything to the left of our own proxies' entries was written by the client and is ignored. No other header (`X-Real-IP`, `Forwarded`) is read.

The proxy must set or append `X-Forwarded-For` with the peer address it saw, and the server must be reachable only through it (keep `HOST=127.0.0.1`). Otherwise a client can connect directly and send any header. Caddy, as our only hop:

```caddyfile
sync.example.dev {                  # placeholder host
	reverse_proxy 127.0.0.1:3300    # sets X-Forwarded-For with the client address Caddy saw; WebSocket upgrades just work
}
```

Run it with `TRUST_PROXY=1` (`TRUSTED_PROXY_HOPS=1` is the default). Caddy keeps an incoming `X-Forwarded-For` and appends to it only when the peer is listed in `trusted_proxies`. Otherwise it replaces the header. In both cases the rightmost entry is the address Caddy saw, so leave `trusted_proxies` unset. If you add a CDN or a second proxy of your own in front, set `TRUSTED_PROXY_HOPS=2`. The hephaestus proxy config hasn't been checked against this yet.

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

`npm test` (Node 22, `node:test`, throwaway temp data dirs, ports 3350-3358 and 3361-3367). 19/19 pass, 3 runs in a row:

| | Test | Result |
|---|---|---|
| a | Two clients type 50 chars each into one Y.Text, interleaved, with no waiting | converge, no char lost |
| b | Client B goes offline, edits title and notes and adds a shot, while A edits the title; B reconnects | both sides have everything: `"The Opening shot"`, B's notes, B's new shot |
| c | 20 edits with compaction every 7 records; state read from disk while the server still runs; restart; then a torn record appended to the log, restart again | text identical every time; torn tail cut off, original copied to `updates.bin.torn-<time>` byte for byte |
| d | Wrong token, missing token, unknown room, path traversal in the room id | 4401, 4401, 4404, 4404; a valid client still joins |
| e | 100 KB frame with a 64 KB limit; garbage frame; per-IP limit of 3 | 1009, 4400, 4429; the server keeps serving and the room still syncs |
| f | Example project → Y.Doc → over the wire → `.cueboard.json` | equal to the original with payloads replaced by hashes; byte-identical `project` when payloads are handed back; no payload bytes in the doc |
| f | Synthetic export with takes, frames, references and an unknown key | lossless; `useInCut` derived correctly; identical files deduplicate to one hash |
| g | `project.json` with hash typos (`"abc"`, 64 non-hex chars, no `sha256`, 63 chars), and one that isn't valid JSON | malformed entries never match: wrong token 4401, real token still joins; invalid JSON 4500 three times; other rooms keep serving; refusals don't use up per-IP slots |
| h | `updates.bin` with a garbage record between valid ones, and with a `0xffffffff` length header mid-file | 4500 on every join, both files byte-identical, no `.torn` copy, nothing loaded; other rooms keep serving; after an operator restores the file the room opens |
| i | `TRUST_PROXY=1`, limit 1: `X-Forwarded-For: 10.0.0.1, 192.0.2.7`, then `10.0.0.2, 192.0.2.7`, then `10.0.0.1, 192.0.2.8`; also `TRUSTED_PROXY_HOPS=2` | joined, 4429, joined: the limit follows the proxy-added entry; same with two hops |
| j | 3 rounds of: join, 5 edits, leave, wait for the unload (`unloadAfterMs` 50), rejoin | state intact every round; the log is the compacted record plus 5 appends while loaded and exactly 1 record after each unload and after shutdown |
| k | Stubbed store: appends and compactions for room A throw `ENOSPC`; A has two clients, B one | A's sender closed 4500, the other A client keeps its socket and gets the edit; new joins to A 4500; no further append attempted; `/health` shows `degraded: 1`; B syncs and persists; one `append failed` and one `compaction failed` line over several ticks. Disk "freed": the next tick writes A as 1 record holding both clients' edits, joins and appends resume |
| l | Real `EACCES`: the room folder made read-only (`0555`) while a client edits, then the client leaves | appends still land; the compaction tick and the unload fail, logged once; the room stays loaded, another room still serves. Folder writable again: the tick retries the unload, 1 record, text intact |
| m | No `TRUST_PROXY`, limit 2, three different `X-Forwarded-For` values; then clean close, abrupt terminates | joined, joined, 4429 (header ignored); each close frees its slot; after all close, 2 join and the 3rd is refused again |
| n | A raw socket sends a presence; a late joiner arrives; the raw socket is terminated without a goodbye | the other client sees it, the late joiner gets it in the greeting, both (and the server) drop it after the terminate |
| o | `TRUST_PROXY=1`, `TRUSTED_PROXY_HOPS=2`, limit 1: XFF `1.1.1.1`, `2.2.2.2`, none, then `3.3.3.3, 192.0.2.9` | joined, 4429, 4429, joined: short headers fall back to the socket address; one warning |
| p | `maxBufferedBytes` 256 KiB, a client that stops reading its socket, another one inserting 100 KB chunks | the slow reader is terminated (one `slow reader` warning), the other client is unaffected |
| q | `pingMs` 40: a client that stops reading but sends its own pongs every 10 ms, next to a normal client | the pong spammer is terminated; the normal client is still connected 5 ping periods later |
| r | Child processes with the safety net: one rejection + the same throw from a timer 2 times, then 3 times | 3 `UNCAUGHT` lines and the process keeps running; with 3 repeats it logs `UNCAUGHT: same error 3 times in 10 s, exiting` and exits 1 |

(g), (h) and (i) were also run against the code before the review fixes: (g) and (h) killed the process (`RangeError` in `timingSafeEqual`, `Unexpected end of array` in `loadDoc`), and (i) let the spoofed address through. Likewise (k), (l), (o), (p) and (q) fail against the code before the second round of fixes ((l) crashes the test process from the compaction timer); (m) and (n) cover behaviour that was already correct.

Browser (`demo/browser-check.mjs`, testkit's playwright-core + `/snap/bin/chromium`, port 3360): 5/5 PASS. Both panes type into the same notes field with keystrokes interleaved: they converge and no keystroke is lost. Pane 2 goes offline and both panes edit: the edits stay local. Pane 2 comes back: both panes show `"Wide: The mountain at night"` and the same notes. Screenshot: `demo/shot.png`.

Also run by hand: `create-project` (plain, `--import example/example.js`, `--data-dir`), and `npm start` followed by SIGTERM (logs `listening` / `shutting down` / `stopped`).

## Review fixes (PR #2)

- **A broken room can't crash the server.** The token check and room load run in a try/catch. On failure the socket closes with **4500** and one `error` log line is written (no stack; for errors that aren't ours, only the error name, because `JSON.parse` messages quote `project.json`). Everyone else keeps being served. The per-IP slot is taken only after the room loads, so refusals don't leak it.
- **Malformed token hashes** in `project.json` (anything other than 64 hex chars, or a missing `sha256`) never match and never throw. Each room logs a warning about them once.
- **`X-Forwarded-For` is read from the right**, with `TRUSTED_PROXY_HOPS` (see above), not from the client-controlled left.
- **Torn tail vs corruption in `updates.bin`.** A tail is treated as torn only if it is a partial header, or a header (at most 256 MiB) whose record runs past the end of the file, *and* every record before it decodes. Then the whole file is first copied to `updates.bin.torn-<ISO time>` and only then truncated. Anything else (an undecodable record, or an impossible length) throws `CorruptLogError`: the file is not touched, and every join to that room gets 4500 until an operator fixes the file. No restart is needed, because each join retries the load.

Second round:

- **Disk errors outside the join path don't crash the server.** `compact()` never throws: on a failure (ENOSPC, EACCES, `DATA_DIR` gone) it logs one `error` line per failure burst, leaves the room loaded, and the compaction tick (`compactIntervalMs`, 60 s) retries. A failed unload keeps the room in memory and the tick retries it; a recovery is logged once at `info`.
- **A failed append degrades the room.** The error is caught inside the Yjs `update` handler (so it never escapes the transaction or looks like a 4400 "malformed message"), logged as a server fault, and the sender is closed with 4500. The room is marked `degraded`: nothing more is appended (the log may now have a torn tail), new joins get 4500, existing clients stay and keep editing in memory, and the next successful compaction rewrites the log with the whole doc and clears the flag. `/health` reports the number of degraded rooms. If the process stops while a room is degraded and its last compaction fails, its unsaved changes are lost (logged), though the clients still hold them and resend them on reconnect.
- **Slow readers are dropped** once their send queue would pass `MAX_BUFFERED_BYTES` (8 MiB). A message onto an empty queue always goes, so a large first sync isn't refused.
- **Pings carry a random 8-byte nonce**; only a pong echoing the outstanding one counts, so unsolicited pongs don't keep a dead reader alive.
- **A short `X-Forwarded-For`** (fewer entries than `TRUSTED_PROXY_HOPS`) is ignored entirely: the socket address is used, with one warning per process.
- **Process-level safety net** (`src/safety-net.mjs`, installed by `main.mjs` only, not by `startServer()`). The timer and socket paths above have their own handlers, so whatever reaches `uncaughtException` / `unhandledRejection` is a bug. It is logged as one `error` line with the message prefix `UNCAUGHT` and the top 5 stack frames, and the process keeps serving. If the same error (name, message and throwing frame) comes 3 times within 10 s, it logs `UNCAUGHT: same error 3 times in 10 s, exiting`, closes the server (2 s grace) and exits 1, so a supervisor restarts it.

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
- **y-websocket's client retries rejected connections forever**, with backoff up to 2.5 s. The demo stops on 44xx close codes; the real client must too, and it should back off on 4500 (room unavailable).

## Risks

- **Doc growth and GC.** Yjs keeps a small tombstone per deleted run forever, and GC can't drop deleted items while anyone could still need them. In the measurement above, a note with 13 K visible characters cost about 160 KB of doc after 20 K keystrokes, because each typing session with backspaces fragments the text. That's fine at cue-board scale. If it ever matters: periodically snapshot into a fresh doc for a new room epoch (clients reload).
- **Auth model.** A bearer invite token is all-or-nothing: anyone with the link can read and write, forever, until the hash is removed from `project.json` (which revokes all holders at once if they share one token). There are no users, no roles (viewer/editor) and no per-person revocation or audit. Tokens travel in the URL, so they end up in proxy logs and browser history. Fine for friends; not for strangers.
- **Durability.** Appends are synchronous writes but not fsynced, so a clean restart or a process crash loses nothing, while a power loss can lose the last seconds. Compaction itself is fsync + rename. One process owns the files: there is no locking, so running two servers on one `DATA_DIR`, or running `create-project --invite` against a room the server has loaded, races.
- **Reconnect storms.** After a deploy every client reconnects within ~2.5 s, each loads its room from disk and does a full state-vector sync. 100 rooms took 0.7 s here. Thousands would need jittered backoff and maybe a loading queue. Nothing stops a valid token holder from opening 16 sockets or sending 2 MB updates in a loop: there's no rate limit per message, only per size.
- **Malicious clients with a valid token** can write anything the schema allows, or things it doesn't: the server doesn't validate doc structure. They can also delete everything, and the CRDT will faithfully sync the deletion. Backups and snapshots are the defence (see next steps).
- **Single process, in-memory rooms.** Horizontal scaling needs room-to-process affinity (sticky routing by room id). Fine for a long time.

## Not done

- Integration with `index.html` (the app still uses IndexedDB only). No `apps/web` move. *Since done (collaboration v1): see `docs/collaboration.md` at the repo root. The app sends the token as a WebSocket subprotocol, which the server now accepts too (test s).*
- Media of any kind: no P2P transfer, WebTorrent/WebRTC, seed or encryption. Refs are hashes only; nothing fetches media by hash.
- Users, accounts, roles, read-only links, revoking a single person, token expiry, an admin UI. `--invite` adds tokens; revoking means editing `project.json` by hand.
- Server-side schema validation of updates; history, snapshots or undo; backups.
- Awareness/presence in the demo (the server relays it, but nothing renders it). `Y.UndoManager` wiring.
- Hashing in the browser (import uses `node:crypto`; the app will need SubtleCrypto).
- Rate limiting per message, metrics, TLS (expected from the reverse proxy), Docker/systemd, deploy. Not run on the VPS.
- `fsync` per append (deliberately skipped; see Durability).
- **Torn vs corrupt is a heuristic.** A mangled mid-file header that still claims a plausible length (≤ 256 MiB) running past EOF, with every earlier record decodable, looks like a torn tail and gets truncated. The `.torn-*` copy keeps the dropped bytes, but nothing re-applies them, and `.torn-*` files are never cleaned up. A record checksum per frame would make this exact.
- A degraded room only recovers on a compaction tick (60 s by default). Until then new joins get 4500, and there's no alert beyond the error log line and `/health`. Nothing checks free disk space up front.
- The safety net (`main.mjs`) is tested in a child process with its own fixture, not by crashing a real `npm start`. The 2 s close-and-exit grace isn't tested.
- `maxBufferedBytes` is checked only when we send. A reader that stops while nothing is being broadcast is caught by the ping reaper instead, within two `pingMs` periods (60 s).
- A room refused with 4500 re-reads its whole `updates.bin` on every join attempt. There's no backoff or cache of the failure, and y-websocket clients retry forever unless they stop on 4xxx (see above).
- The hephaestus reverse proxy config hasn't been checked against `TRUST_PROXY` / `TRUSTED_PROXY_HOPS`.

## Recommendation: next two steps

1. **Wire the app to a room, behind a flag, after the design branch lands.** Move `index.html` to `apps/web`, keep IndexedDB for media and offline (`y-indexeddb` for the doc), and replace the `cur` project object with a Y.Doc view through `schema.mjs`. On the first connect, import the local project via `cueboardToDoc`. Done means two friends editing the same cut live, with media still local and only hashes shared. Do `docToCueboard` export from the doc at the same time so nothing is ever locked in.
2. **Make it safe to run for friends before adding media.** Nightly snapshot of each room (a copy of `updates.bin`), per-person invite tokens with a label and `--revoke`, `TRUST_PROXY` behind the real proxy, a systemd unit, and the client stopping on 44xx. Then start the P2P media phase, with the hash refs already in place.
