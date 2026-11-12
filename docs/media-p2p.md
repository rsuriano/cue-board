# Media between collaborators (v1)

Heavy media (song, frames, clips, takes, reference images) is never hosted by us. The room's doc refers to each file by the sha256 of its bytes (unchanged since collaboration v1); the bytes travel **between collaborators**. Every collaborator's browser replicates every file the doc references, in the background, from any online peer that has it, so a file stays available after the person who added it goes offline.

| Where | What |
|---|---|
| `packages/collab-client/src/media-core.mjs` | Crypto envelope, frame format, validation of peer messages, the receive-side bookkeeping of one file (`Download`), incremental SHA-256. No DOM, no network; unit-tested under Node. |
| `packages/collab-client/src/media.mjs` | One instance per open room session: peers, WebRTC, the relay fallback, scheduling, serving, verification, limits. |
| `packages/collab-client/src/collab.mjs` | Wires it in: which files the doc references (`wanted()`), IndexedDB stores `parts` and `chunks`, landing a verified file in the app (`storeMedia` / `storeSong`), `parseIce()`. |
| `packages/sync-server/src/media-relay.mjs` | Signaling and the store-nothing relay (message type 10), with caps. |
| `index.html` | `<meta name="cue-ice-urls">`, the media status indicator next to Settings and its non-modal files panel (state, list with who has each file, Retry / Download per file, limits, Pause, Download all now), the in-place placeholders (progress, "Nobody online has it", Download, Retry). |

## Protocol

A small purpose-made protocol instead of BitTorrent: with 2-5 people per project a swarm (piece rarity, choking, trackers, DHT) buys nothing. No new dependency: WebRTC is the browser's own `RTCPeerConnection`, signaling goes through the room's existing WebSocket.

**Peers.** On join the server gives each connection a peer id (`WELCOME`, with the ids already there and the relay's per-file cap) and tells the others (`JOINED`, `LEFT`). The newcomer sends each peer a sealed `hi` (its awareness client id, for names in the files list); the other answers with `hi` too. Each side then sends `have` (the hashes it holds, ≤ 200 per message). The lower peer id offers a WebRTC data channel (`offer` / `answer` / `ice` as sealed `SIGNAL`s); until it opens, and whenever it can't, everything goes through the relay (`RELAY`). One attempt per peer per session, 10 s timeout.

**Transfer.** Files are cut into 64 KiB chunks. The receiver drives: per file it picks one source (the least-loaded peer that has it), asks for up to 16 chunks at a time (`get {h, i:[…]}`, ≤ 32 indexes), stores each chunk as it's verified and asks for more. At most 3 files at once, smallest first. A request unanswered for 8 s is asked again, elsewhere if possible. A source that leaves, says `nf` or `lost`, or is dropped, is replaced and the file continues from the chunks already stored. The sender reads only the requested slice of the file (`Blob.slice`), seals it, and waits while the transport's queue is over 1 MiB (data channel `bufferedAmount`, or the WebSocket's; backpressure); through the relay it also paces itself at 3 MB/s, under the server's per-IP cap.

**Lost control frames.** The relay may drop any frame (rate caps, the receiver's queue) and a reconnect loses what was in flight; nothing answers `have`, `hi` or `cancel`. So every peer sends its whole `have` list again to each peer every 20 s, and about 1 s after the server says it dropped one of its frames to that peer (`DROPPED`, at most every 3 s); `hi` goes again every 20 s to a peer never heard from; `cancel` goes again (once a second at most) when chunks of a cancelled file keep coming. All idempotent; a handful of small frames per peer per period. `nf` and `lost` answer a `get`, which is asked again after 8 s anyway. A chunk that arrives after its request was given up on (timeout, cancel) is ignored, not counted against the sender.

**Too big for the relay.** The relay carries files up to its cap (2 GiB by default, `RELAY_MAX_FILE` in `packages/sync-server/src/media-limits.mjs`, shared by server and client; the server sends its own value in `WELCOME`). That covers every automatic per-file limit (up to 2 GB). A bigger file (only fetched through **Download all now**) is asked for only over an open data channel; with none open or coming it's shown as "too large to relay: needs a direct connection" instead of "Downloading" forever, and if a data channel closes mid-file the file stops with its chunks kept. A server too old to send its cap is assumed to carry 500 MiB.

**Verification.** A file reaches the app only after all chunks are in and the sha256 of the whole thing equals its content id (incremental SHA-256 over 4 MiB slices, never the whole file in memory). If it doesn't match, everything stored of it is thrown away; if a single peer sent all of it, that peer is dropped; after three failures the file is marked "couldn't be verified" until **Download all now**.

**Storage.** `cueboard-collab` (now version 2): `parts` (sha256 → `{ size, mime, pid, t }`) and `chunks` (`[sha256, i]` → Blob, plaintext, already verified). Each chunk is one IndexedDB transaction, so a crash leaves whole chunks only, and a reload resumes from the last verified chunk. When the file verifies it's stored like any other media file in the app's own `cueboard-local` / `media` (a new id, as if uploaded; ids are never reused), its hash goes into `hashes`, the parts are dropped, and the session pulls: the field's `sha256-…` id becomes the local id and the placeholder becomes the media. A song lands in `songs` for that project. Parts of a file the doc no longer references are dropped (at the first sync of a session, and as soon as it happens).

**A replaced song.** Each project stores one song, under its own id in `songs`. When the doc's song is another file than the stored one (its sha256 differs) and no replacement made on this device is waiting to go out (being hashed, or before the first sync), the doc's song is newer: a collaborator replaced it, or won a concurrent replace. The doc's own order decides (the Yjs map entry; a replace made after seeing another one wins over it), never a clock. That song is then wanted like any missing file: the Files list shows "Song · <name>" downloading, the chip counts it, and the song bar says it was replaced and plays once it arrives. The stored song stays in place but isn't played under the new name (`onSong(pid, true)`; its length isn't taken as the song's). When the new file verifies, `storeSong` replaces the stored one in a single write and playback switches to it. Since songs are stored per project, nothing else can point at the old blob, so nothing more is released (the media `mediaInUse` check is about frame and take ids, which projects can share). A stored song older than the doc's never goes back out: a metadata edit (the length) sends the doc's file, and only a song that changed name here is sent as a replacement. Known limit: replacing a song with a different file of the same name is only noticed on the next session start.

**An old tab blocking the upgrade.** A tab still running the previous version holds `cueboard-collab` at version 1 and never lets go, so the upgrade to 2 waits until it closes. After 2.5 s (`onblocked`) the new tab goes on without the database: the doc connects and syncs (without the offline copy), file transfers wait and the chip says "Storage busy, close other tabs", and local files aren't re-hashed meanwhile (their stored hashes aren't loaded yet; the fields wait). Once the old tab goes, the upgrade runs, this tab picks the database up and everything resumes. Every connection now sets `onversionchange` to close itself, so a later version never waits on this one; the tab that let go says "Storage busy, reload this tab".

## Crypto envelope

- **Key.** `HKDF-SHA256(ikm = invite token, salt = "cue-board media v1", info = "aes-256-gcm|" + roomId)` → AES-256-GCM key, on the clients only. The server stores only `sha256(token)`, from which HKDF can't be computed. A short key id (HKDF, info `key-id|roomId`) is kept for comparisons.
- **Chunk i of a file** (size `n`, content id `H` = sha256 of the PLAINTEXT): AES-256-GCM, nonce = base nonce XOR `i` (last 4 bytes), AAD = `"cue-media-v1" ‖ H (32 bytes) ‖ u32 i ‖ u32 count ‖ u64 n`. A chunk can't be moved to another index, file or size; each one is authenticated on its own.
- **At rest** (the format a future always-on seed would hold): `[12-byte base nonce][sealed chunk 0][sealed chunk 1]…`, each sealed chunk `len + 16` bytes. Dedup and the existing refs keep working because the id is the plaintext's hash. `sealFile()` / `openFile()` implement it; nothing stores it yet.
- **On the wire** a chunk travels with its index and base nonce (`[2][first 8 bytes of H][u32 i][12-byte base][ciphertext+tag]`), so any peer (or a seed) can serve any chunk; each sender picks a fresh random base per (receiver, file). Control messages are JSON sealed under a random nonce with AAD `"cue-ctl-v1" ‖ u32 from ‖ u32 to` (`[1][8 zero bytes][nonce][ciphertext+tag]`), with a per-peer replay guard on their sequence numbers. WebRTC signaling (SDP, candidates) is sealed the same way, so the server doesn't see candidate addresses either.
- **Every frame is sealed, on every path** (data channel too, not only the relay), so one code path, and a non-member can't produce a frame anyone accepts.
- Known-answer tests: HKDF (RFC 5869 case 1), AES-256-GCM (GCM spec test case 14), SHA-256; the room key and chunk sealing are checked against `node:crypto` as an independent implementation.

What it protects against: the relay, the signaling path and anything that records them (proxy logs, a disk image of the server) only ever hold ciphertext; a stolen copy of `project.json` doesn't give the key. What it doesn't: **a modified sync server** sees each token when a client joins (it has to, to check it) and could derive the key. Any member can derive it (they hold the token): encryption is against outsiders, not against members, which is why the whole-file hash is checked as well.

**Several invite tokens per room** (`create-project --invite` adds tokens) give several keys: people who joined through different links can't exchange files. Their `hi` doesn't open, they're counted as "joined with another invite link" (said in the files panel next to Settings), and nothing is exchanged with them; everything else (the doc) works. Hand out one link per room for now. A shared room key wrapped per token would fix it (not done).

## Untrusted input

Every header, chunk and signal from a peer: sizes, indexes and counts checked (`checkCtl()`: hashes 64 hex, ≤ 32 indexes, SDP ≤ 12,000 chars (Chromium's data-channel offer is 458 chars as sent, 715 with its candidates; each candidate line ~130 chars, so ~88 fit; measured by `design/sdp-size.mjs`; a sealed offer at the limit still fits the 16 KiB signal cap, tested), candidates ≤ 1,024; `parseChunk()`: ≤ 64 KiB + header + tag); a chunk is accepted only if it was asked of that peer, isn't stored yet and authenticates, and its length matches its index. A peer is **dropped for the session** for: a chunk that fails authentication or has the wrong length, a control frame that fails after it was readable before, an index out of range, more than 128 queued requests, more than 96 frames waiting to be processed, or more than 48 unasked/duplicate/replayed frames. At most 4096 announced hashes and 32 peers are kept. A peer is served only hashes **the room's doc references**, only if this device has the file and its size equals the doc's (otherwise `nf`); joining the room needs a valid token. File names in the files list are built from the doc (shot number, "take 2", the song's name) and rendered with `textContent`.

## Server: signaling and relay

Message type 10 on the room's WebSocket (`media-relay.mjs`, wire format in its header comment). The server forwards sealed frames between two online peers of the same room and **never stores them**: each frame is sent on at once or dropped.

| Cap | Default | Env |
|---|---|---|
| Signal message | 16 KiB (bigger: ignored) | |
| Signals | 40/s per connection, 200/s per room (2 s burst; over: dropped) | |
| Relay frame | 80 KiB (bigger: ignored) | |
| Relay bandwidth | 8 MiB/s per room, 4 MiB/s per IP (2 s burst) | `RELAY_ROOM_BYTES_PER_SEC`, `RELAY_IP_BYTES_PER_SEC` |
| Relay totals | 16 MiB/s for the whole server; per account (every room it created; a room without an account counts alone) 20 GiB a day and 32 files at once (a file idle 30 s stops counting). Over: dropped with reason 1, like the rate cap. In memory: a restart resets the day | `RELAY_TOTAL_BYTES_PER_SEC`, `RELAY_ACCOUNT_BYTES_PER_DAY`, `RELAY_ACCOUNT_TRANSFERS` |
| Per file: a chunk frame's index must be `< ceil(cap / 64 KiB)`, so a file up to the cap always fits and a chunk sent again never counts twice | 2 GiB (`RELAY_MAX_FILE`), sent to clients in `WELCOME` | `RELAY_MAX_TRANSFER_BYTES` |
| Receiver's queue | 2 MiB: frame dropped, sender told (`DROPPED`) | |
| Per-IP buckets | forgotten once idle (swept at most every 10 s) | |

Over a cap the frame is dropped and the sender gets `DROPPED` with the reason and the frame's 8-byte tag (on the per-file cap it stops sending that file to that peer); drops are logged as one line per room every 10 s with counts only. Nothing about contents, tokens or file names is logged.

A type-10 frame the server doesn't take (a kind it doesn't know, a kind only the server sends, a signal or relay frame over its size cap, a relay frame too short to carry a tag, trailing bytes) is **ignored**: not forwarded, counted (`mediaStats.ignored`), and logged at debug level as one line per room every 10 s. It never closes the socket, so a newer client that adds a media kind or raises a cap, against a server that wasn't redeployed, loses only media and keeps doc sync (the client lists 4400 as "rejected" and would stop retrying). Only a frame that can't be read at all (truncated varints) still closes with 4400, as does any malformed doc message or unknown message type. The client likewise ignores media kinds it doesn't know.

Tests: `packages/sync-server/test/media-relay.test.mjs` (ids and fan-out, no cross-room delivery, byte-for-byte relay, nothing on disk or in the log, each cap, frames ignored and logged once (m3), unreadable ones still 4400, doc edits still flowing on the same socket after an unknown kind (m7)); `packages/collab-client/test/media.test.mjs` "a media frame the client doesn't know".

## ICE servers (owner to choose)

`<meta name="cue-ice-urls" content="">`, space or comma separated (`stun:host:port`). Nothing is hardcoded. The client also parses `turn:user:secret@host:port`, but never put a fixed TURN login there: the page is public, so anyone could relay through that TURN server. TURN only with short-lived credentials (below).

| Option | Who connects directly | Privacy |
|---|---|---|
| **None** (empty, the default) | Peers on the same network (host candidates). Everyone else uses the relay. | No third party learns anything. The relay costs our bandwidth (capped above) and is slower. |
| **Public STUN** (e.g. a big provider's) | Most home networks (server-reflexive candidates). | The STUN operator sees every collaborator's public IP and when they open a project. Peers see each other's public IP (true of any direct connection). |
| **Own coturn** (STUN, optionally TURN) | Like public STUN; with TURN, even strict NATs, through our box. | Nobody new learns anything; we run one more service. TURN credentials in a public page are visible to anyone: use coturn's time-limited REST credentials (needs a small endpoint, not built) or keep TURN off and let the relay do that job. |

## Limits and UX

- Per project, in the **files panel** (the icon next to Settings): files up to 100 MB / **500 MB** / 2 GB download automatically, up to **5 GB** / 20 GB / 50 GB for the whole project (stored in this browser's `collab` setting, `rooms[pid].limits`). Bigger ones are skipped: the panel says "1 file skipped: over the size limit", the file's row and its placeholder say "Over the size limit" with a **Download** that fetches just that file (`media.download(hex)`, past the limits for the rest of the session); **Download all now** fetches them all (and retries failed ones), for the rest of the session. A file that failed its hash three times gets **Retry** (`media.retry(hex)`: three more tries). **Pause** stops new requests (serving others goes on: they may depend on this browser) and keeps "Download all now" on, so Resume continues. A file that stops being fetched only because of the limits (Pause, a lowered limit, a newly added smaller file taking the project budget) keeps its stored chunks and resumes from them when it's allowed again; only a file the doc no longer references, or that's here already, has its chunks dropped.
- Indicator and panel header, when connected: "Downloading 3 files" (ring) · "All files here" (quiet) · "2 files not available yet" · "1 file skipped: over the size limit" · "1 file too large to relay" · "Paused, 2 files to get" · "Storage busy, close other tabs" (hollow dot) · "Storage full, downloads paused" · "1 file couldn't be verified" (error dot). A project without files still says "Synced". The line under the header explains each. The old top-left chip and the **Files…** dialog are gone.
- Placeholders, in place (strip card, monitor, start/end frame slots, takes, references, the song bar): "Arriving · 42%" with a progress line while a file is coming, "Waiting its turn", "Paused · 42%" (the stored chunks stay), "Nobody online has it", "Over the size limit" + Download, "Couldn't be verified" + Retry, "Needs a direct connection"; "… not on this device yet" outside a room. A strip card is a button, so it shows the state without the action.
- Storage: `navigator.storage.persist()` is asked once per session; if it's denied, the files panel and its header line say the browser may clear the files when space runs low (collaborators keep theirs, and they come back from them). Under 1 GB free (`estimate()`) is said too. A write that fails (quota) pauses downloads with "Storage full"; **Download all now** retries. A file the browser cleared is noticed when someone asks for it: announced as `lost` and fetched again.

## Races and failure paths (red team)

Each has a test (Node: `packages/collab-client/test/media.test.mjs`; browser: `design/media-check.mjs`):

| Case | What happens | Test |
|---|---|---|
| Two peers have the file | One source per file at a time; chunks from anyone not asked are refused | Download unit test; E/F steps |
| Source leaves mid-transfer | Its requests are released, another holder continues from the stored chunks | Node "races"; browser step D |
| Receiver reloads / crashes mid-transfer | Resumes from the last stored chunk, re-verifies the whole file | Node "resume"; browser step D (reload) |
| Corrupted chunk | Fails GCM, sender dropped, chunk asked elsewhere | Node "resume"; browser step E |
| Whole file doesn't hash (a member sent consistent garbage) | All parts dropped, single source dropped, 3 tries | `finish()`; not reproduced in a test (needs a member forging GCM with the key) |
| Remote delete while downloading | Stops, `cancel` to the source, parts dropped; a chunk in flight is not written back | Node "races" |
| Leave or delete the project mid-transfer | Session stops, `forget()` drops that project's parts; a write in flight leaves orphan chunks the startup sweep removes; nothing lands after `stop()` | code path; startup `parts.gc()` |
| Crash after landing, before parts are dropped | First tick drops parts of files that are here | code path |
| Quota exceeded writing a chunk, or storing the file | Downloads pause ("Storage full"), nothing half-written reaches the app | Node "races" (chunk write); storing: code path |
| Storage cleared by the browser | Missing blob noticed when serving: `lost` announced, fetched again under a new id; the old id is released as usual | code path, not tested |
| Same file referenced twice, or already here under another id | One entry per hash; landing skipped if it's already here | `finish()` |
| Peer with another invite token | Not readable, counted, ignored, never dropped as hostile | Node "relay path" |
| Relay abuse by a member | Per-room and per-IP byte rates, per-file chunk-index cap, receiver queue cap; floods are dropped, not queued | `media-relay.test.mjs` |
| Pause after Download all, limit lowered, budget taken by a new smaller file | Stopped without dropping; resumes from the stored chunks (each chunk fetched once) | Node "Download all now, then Pause…" |
| File bigger than the relay's cap, no direct connection | Never asked over the relay; "too large to relay"; smaller files still come | Node "bigger than the relay's cap"; server (m5) |
| Relayed `have` / `get` / `cancel` dropped (silently or with `DROPPED`) | Re-announced; the transfer completes | Node "relayed control frames…" (fault-injecting proxy) |
| An old tab holds the database at version 1 | Session connects and syncs; "Storage busy"; switches over when the old tab goes; a newer version gets the database at once | `test/idb-blocked.test.mjs` |
| Scheduler poked while it awaits storage | One tick at a time, at most one timer pending, none after `stop()` | Node "one tick at a time" |
| A collaborator replaces the song others already have | Fetched like a missing file, verified, then replaces the stored one; the old one isn't played meanwhile | browser "song" steps |
| A replace here while the room still has an older song, or both replace at once | The replace here goes out and stays; at once: the doc's order picks one and both end with it | browser "song" steps |
| A newer client sends a media kind or size this server doesn't take | Ignored and counted; doc sync on the same socket goes on | server (m3, m7); Node "a media frame the client doesn't know" |

## Not done

- The request window (up to 3 files × 16 chunks) isn't sized to the relay's 2 MiB per-receiver queue: a slow receiver's chunks can be dropped there and are asked again after 8 s (control frames are re-announced, above). Slower, never stuck.
- No always-on seed: when nobody online has a file, it waits ("not available yet"). The at-rest format is designed for it.
- One key per invite token (see above); no key rotation; revoking a token doesn't re-key files already exchanged.
- Partial files are kept in IndexedDB in plaintext, like the app's own media (the browser's storage is the trust boundary, as before).
- No TURN credential endpoint; WebRTC across strict NATs without TURN falls back to the relay.
- No per-chunk hashes: a member who forges chunks with the room key is only caught at the whole-file hash.
- Firefox and Safari not tested (Chromium only).
- The relay shares the doc's WebSocket: a big relayed transfer can delay doc updates by up to ~1 MiB of queue (about 0.3 s at the paced rate).

## Measured (this machine, headless Chromium, everything on 127.0.0.1)

From `design/media-check.mjs`, a 6.7 MB frame plus a 31.5 MB take plus the example's song:

- WebRTC, A → B: about **9 MB/s** from join to verified (4.3 s); B's JS heap peaked at 37 MB (chunks go to IndexedDB as they arrive, and the hash is computed over 4 MiB slices).
- Relay, D → server → F (direct blocked): **3.3 MB/s**, which is the clients' own pacing (3 MB/s, under the server's 4 MiB/s per-IP cap). F's heap peaked at 40 MB. The sync server used **8% of one core**, RSS 83 → 97 MB peak, and nothing in its data dir or log held any of the plaintext.
- After the last review round (re-announce, single-flight scheduler) eight runs gave 5.8 to 9.4 MB/s over WebRTC (one identical bundle gave both 6.4 and 9.4) and 3.2 to 3.3 MB/s over the relay; the bundle before that round measured 8.9 MB/s in the same session, so the spread is this machine, not the change.
- A first build ran at ~1.1 MB/s on both paths: the scheduler's 1 s fallback timer blocked the immediate refills, so the request window was refilled once a second. Fixed in `schedule()`; the number above is after the fix.

Incognito contexts keep IndexedDB blobs in memory, so these heap numbers say nothing about a normal profile's disk use.

## Checks

- `npm test -w @cue-board/collab-client`: `test/media.test.mjs` (KATs, envelope, validation, `Download`, backpressure, and end to end through the real server's relay: replication, offline originator, foreign key, resume, corruption, source leaving, remote delete, storage full, limits, unreferenced hash, partial downloads kept through Pause and limits, too large to relay, dropped control frames, single-flight scheduler, SDP limit vs signal cap); `test/idb-blocked.test.mjs` (an old tab holding the database).
- `npm test -w @cue-board/sync-server`: `test/media-relay.test.mjs` (also the per-file cap against the app's limit options, re-sends not counted, IP buckets swept).
- `node design/sdp-size.mjs`: Chromium's SDP sizes for the media data channel.
- `node design/media-check.mjs . <out>`: three browser contexts at a time against a server on 3360, listed in its output. The "song" steps (A replaces the song, B gets it and never plays the old one under the new name; B's own replace stays; a concurrent replace converges) fail on the bundle before this fix (23/28). It reads the indicator (`#mstat` look, `#mhead` text) and the placeholders: B's arriving file shows "Arriving · N%" with a progress line on that file's placeholder and the ring; E sees the hollow dot, "N files not available yet" and "Nobody online has it" in place; G opens the panel from the keyboard, sees the 110 MB take skipped with Download in its placeholder, downloads it, pauses (the stored chunks stay, "Paused · N%"), and Download all now finishes it.
- `node design/inline-shots.mjs . design/shots/inline`: every indicator, panel and placeholder state against a stub `collab.js` (so "failed" and "skipped" can be shown on demand), plus keyboard, deleted take while downloading, leaving with the panel open, 1920 → 820 px, AA contrast, hit targets, reduced motion; the screenshots go to `design/shots/inline/`.
- `design/collab-check.mjs` runs with media transfers off (`__CUE_MEDIA_TEST.off`), since it checks the doc side ("not on this device yet" stays).
