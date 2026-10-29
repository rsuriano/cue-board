# Media between collaborators (v1)

Heavy media (song, frames, clips, takes, reference images) is never hosted by us. The room's doc refers to each file by the sha256 of its bytes (unchanged since collaboration v1); the bytes travel **between collaborators**. Every collaborator's browser replicates every file the doc references, in the background, from any online peer that has it, so a file stays available after the person who added it goes offline.

| Where | What |
|---|---|
| `packages/collab-client/src/media-core.mjs` | Crypto envelope, frame format, validation of peer messages, the receive-side bookkeeping of one file (`Download`), incremental SHA-256. No DOM, no network; unit-tested under Node. |
| `packages/collab-client/src/media.mjs` | One instance per open room session: peers, WebRTC, the relay fallback, scheduling, serving, verification, limits. |
| `packages/collab-client/src/collab.mjs` | Wires it in: which files the doc references (`wanted()`), IndexedDB stores `parts` and `chunks`, landing a verified file in the app (`storeMedia` / `storeSong`), `parseIce()`. |
| `packages/sync-server/src/media-relay.mjs` | Signaling and the store-nothing relay (message type 10), with caps. |
| `index.html` | `<meta name="cue-ice-urls">`, chip texts, progress in the "not on this device yet" placeholders, **Files…** in the project menu (list, limits, Pause, Download all now). |

## Protocol

A small purpose-made protocol instead of BitTorrent: with 2-5 people per project a swarm (piece rarity, choking, trackers, DHT) buys nothing. No new dependency: WebRTC is the browser's own `RTCPeerConnection`, signaling goes through the room's existing WebSocket.

**Peers.** On join the server gives each connection a peer id (`WELCOME`, with the ids already there) and tells the others (`JOINED`, `LEFT`). The newcomer sends each peer a sealed `hi` (its awareness client id, for names in the files list); the other answers with `hi` too. Each side then sends `have` (the hashes it holds, ≤ 200 per message). The lower peer id offers a WebRTC data channel (`offer` / `answer` / `ice` as sealed `SIGNAL`s); until it opens, and whenever it can't, everything goes through the relay (`RELAY`). One attempt per peer per session, 10 s timeout.

**Transfer.** Files are cut into 64 KiB chunks. The receiver drives: per file it picks one source (the least-loaded peer that has it), asks for up to 16 chunks at a time (`get {h, i:[…]}`, ≤ 32 indexes), stores each chunk as it's verified and asks for more. At most 3 files at once, smallest first. A request unanswered for 8 s is asked again, elsewhere if possible. A source that leaves, says `nf` or `lost`, or is dropped, is replaced and the file continues from the chunks already stored. The sender reads only the requested slice of the file (`Blob.slice`), seals it, and waits while the transport's queue is over 1 MiB (data channel `bufferedAmount`, or the WebSocket's; backpressure); through the relay it also paces itself at 3 MB/s, under the server's per-IP cap.

**Verification.** A file reaches the app only after all chunks are in and the sha256 of the whole thing equals its content id (incremental SHA-256 over 4 MiB slices, never the whole file in memory). If it doesn't match, everything stored of it is thrown away; if a single peer sent all of it, that peer is dropped; after three failures the file is marked "couldn't be verified" until **Download all now**.

**Storage.** `cueboard-collab` (now version 2): `parts` (sha256 → `{ size, mime, pid, t }`) and `chunks` (`[sha256, i]` → Blob, plaintext, already verified). Each chunk is one IndexedDB transaction, so a crash leaves whole chunks only, and a reload resumes from the last verified chunk. When the file verifies it's stored like any other media file in the app's own `cueboard-local` / `media` (a new id, as if uploaded; ids are never reused), its hash goes into `hashes`, the parts are dropped, and the session pulls: the field's `sha256-…` id becomes the local id and the placeholder becomes the media. A song lands in `songs` for that project.

## Crypto envelope

- **Key.** `HKDF-SHA256(ikm = invite token, salt = "cue-board media v1", info = "aes-256-gcm|" + roomId)` → AES-256-GCM key, on the clients only. The server stores only `sha256(token)`, from which HKDF can't be computed. A short key id (HKDF, info `key-id|roomId`) is kept for comparisons.
- **Chunk i of a file** (size `n`, content id `H` = sha256 of the PLAINTEXT): AES-256-GCM, nonce = base nonce XOR `i` (last 4 bytes), AAD = `"cue-media-v1" ‖ H (32 bytes) ‖ u32 i ‖ u32 count ‖ u64 n`. A chunk can't be moved to another index, file or size; each one is authenticated on its own.
- **At rest** (the format a future always-on seed would hold): `[12-byte base nonce][sealed chunk 0][sealed chunk 1]…`, each sealed chunk `len + 16` bytes. Dedup and the existing refs keep working because the id is the plaintext's hash. `sealFile()` / `openFile()` implement it; nothing stores it yet.
- **On the wire** a chunk travels with its index and base nonce (`[2][first 8 bytes of H][u32 i][12-byte base][ciphertext+tag]`), so any peer (or a seed) can serve any chunk; each sender picks a fresh random base per (receiver, file). Control messages are JSON sealed under a random nonce with AAD `"cue-ctl-v1" ‖ u32 from ‖ u32 to` (`[1][8 zero bytes][nonce][ciphertext+tag]`), with a per-peer replay guard on their sequence numbers. WebRTC signaling (SDP, candidates) is sealed the same way, so the server doesn't see candidate addresses either.
- **Every frame is sealed, on every path** (data channel too, not only the relay), so one code path, and a non-member can't produce a frame anyone accepts.
- Known-answer tests: HKDF (RFC 5869 case 1), AES-256-GCM (GCM spec test case 14), SHA-256; the room key and chunk sealing are checked against `node:crypto` as an independent implementation.

What it protects against: the relay, the signaling path and anything that records them (proxy logs, a disk image of the server) only ever hold ciphertext; a stolen copy of `project.json` doesn't give the key. What it doesn't: **a modified sync server** sees each token when a client joins (it has to, to check it) and could derive the key. Any member can derive it (they hold the token): encryption is against outsiders, not against members, which is why the whole-file hash is checked as well.

**Several invite tokens per room** (`create-project --invite` adds tokens) give several keys: people who joined through different links can't exchange files. Their `hi` doesn't open, they're counted as "joined with another invite link" (said in Files…), and nothing is exchanged with them; everything else (the doc) works. Hand out one link per room for now. A shared room key wrapped per token would fix it (not done).

## Untrusted input

Every header, chunk and signal from a peer: sizes, indexes and counts checked (`checkCtl()`: hashes 64 hex, ≤ 32 indexes, SDP ≤ 12,000 chars, candidates ≤ 1,024; `parseChunk()`: ≤ 64 KiB + header + tag); a chunk is accepted only if it was asked of that peer, isn't stored yet and authenticates, and its length matches its index. A peer is **dropped for the session** for: a chunk that fails authentication or has the wrong length, a control frame that fails after it was readable before, an index out of range, more than 128 queued requests, more than 96 frames waiting to be processed, or more than 48 unasked/duplicate/replayed frames. At most 4096 announced hashes and 32 peers are kept. A peer is served only hashes **the room's doc references**, only if this device has the file and its size equals the doc's (otherwise `nf`); joining the room needs a valid token. File names in the files list are built from the doc (shot number, "take 2", the song's name) and rendered with `textContent`.

## Server: signaling and relay

Message type 10 on the room's WebSocket (`media-relay.mjs`, wire format in its header comment). The server forwards sealed frames between two online peers of the same room and **never stores them**: each frame is sent on at once or dropped.

| Cap | Default | Env |
|---|---|---|
| Signal message | 16 KiB (bigger: 4400) | |
| Signals | 40/s per connection, 200/s per room (2 s burst; over: dropped) | |
| Relay frame | 80 KiB (bigger: 4400) | |
| Relay bandwidth | 8 MiB/s per room, 4 MiB/s per IP (2 s burst) | `RELAY_ROOM_BYTES_PER_SEC`, `RELAY_IP_BYTES_PER_SEC` |
| Per transfer (sender, receiver, file tag) | 600 MiB | `RELAY_MAX_TRANSFER_BYTES` |
| Transfers per connection | 256 | |
| Receiver's queue | 2 MiB: frame dropped, sender told (`DROPPED`) | |

Over a cap the frame is dropped and the sender gets `DROPPED` with the reason; drops are logged as one line per room every 10 s with counts only. Nothing about contents, tokens or file names is logged. Tests: `packages/sync-server/test/media-relay.test.mjs` (ids and fan-out, no cross-room delivery, byte-for-byte relay, nothing on disk or in the log, each cap, malformed and oversized messages).

## ICE servers (owner to choose)

`<meta name="cue-ice-urls" content="">`, space or comma separated (`stun:host:port`, `turn:user:secret@host:port`). Nothing is hardcoded.

| Option | Who connects directly | Privacy |
|---|---|---|
| **None** (empty, the default) | Peers on the same network (host candidates). Everyone else uses the relay. | No third party learns anything. The relay costs our bandwidth (capped above) and is slower. |
| **Public STUN** (e.g. a big provider's) | Most home networks (server-reflexive candidates). | The STUN operator sees every collaborator's public IP and when they open a project. Peers see each other's public IP (true of any direct connection). |
| **Own coturn** (STUN, optionally TURN) | Like public STUN; with TURN, even strict NATs, through our box. | Nobody new learns anything; we run one more service. TURN credentials in a public page are visible to anyone: use coturn's time-limited REST credentials (needs a small endpoint, not built) or keep TURN off and let the relay do that job. |

## Limits and UX

- Per project, in **Files…**: files up to 100 MB / **500 MB** / 2 GB download automatically, up to **5 GB** / 20 GB / 50 GB for the whole project (stored in this browser's `collab` setting, `rooms[pid].limits`). Bigger ones are skipped: the chip says "1 file skipped: over the size limit", the list says "Skipped: over the size limit", **Download all now** fetches them anyway (and retries failed ones). **Pause** stops new requests (serving others goes on: they may depend on this browser).
- Chip, when connected: "Syncing 3 files" · "All files here" · "2 files not available yet: nobody online has them" · "1 file skipped: over the size limit" · "Paused, 2 files to get" · "Storage full, downloads paused" · "1 file couldn't be verified". A project without files still says "Synced". Tooltips explain each.
- Placeholders: "Arriving · 42%" while a file is coming, back to "… not on this device yet" when nothing is.
- Storage: `navigator.storage.persist()` is asked once per session; if it's denied, Files… and the chip's tooltip say the browser may clear the files when space runs low (collaborators keep theirs, and they come back from them). Under 1 GB free (`estimate()`) is said too. A write that fails (quota) pauses downloads with "Storage full"; **Download all now** retries. A file the browser cleared is noticed when someone asks for it: announced as `lost` and fetched again.

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
| Relay abuse by a member | Per-room and per-IP byte rates, per-transfer total, per-connection transfer count, receiver queue cap; floods are dropped, not queued | `media-relay.test.mjs` |

## Not done

- No always-on seed: when nobody online has a file, it waits ("not available yet"). The at-rest format is designed for it.
- One key per invite token (see above); no key rotation; revoking a token doesn't re-key files already exchanged.
- Partial files are kept in IndexedDB in plaintext, like the app's own media (the browser's storage is the trust boundary, as before).
- No TURN credential endpoint; WebRTC across strict NATs without TURN falls back to the relay.
- No per-chunk hashes: a member who forges chunks with the room key is only caught at the whole-file hash.
- Firefox and Safari not tested (Chromium only).
- The relay shares the doc's WebSocket: a big relayed transfer can delay doc updates by up to ~1 MiB of queue (about 0.3 s at the paced rate).

## Checks

- `npm test -w @cue-board/collab-client`: `test/media.test.mjs` (KATs, envelope, validation, `Download`, backpressure, and end to end through the real server's relay: replication, offline originator, foreign key, resume, corruption, source leaving, remote delete, storage full, limits, unreferenced hash).
- `npm test -w @cue-board/sync-server`: `test/media-relay.test.mjs`.
- `node design/media-check.mjs . <out>`: three browser contexts at a time against a server on 3360, listed in its output.
- `design/collab-check.mjs` runs with media transfers off (`__CUE_MEDIA_TEST.off`), since it checks the doc side ("not on this device yet" stays).
