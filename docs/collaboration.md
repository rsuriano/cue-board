# Collaboration v1: how the app talks to a room

User-facing summary and limits: README, "Collaboration v1". Server and doc layout: `packages/sync-server/SPIKE.md` and `packages/sync-server/docs/data-model.md`.

## Pieces

| Where | What |
|---|---|
| `index.html` | `<meta name="cue-sync-url">` (empty = off), the join dialog, status chip, presence, "Join collaboration…" / "Leave collaboration", the bindings, `applyRemote()`. Imports `./collab.js` only when a project is bound or being joined. |
| `packages/collab-client/src/collab.mjs` | One session per open bound project: Y.Doc, y-websocket provider, offline copy of the doc, media hashing, caret-preserving pulls, awareness. |
| `packages/collab-client/src/convert.mjs` | Project ⇄ doc. Doc → project is the sync server's `docToCueboard()` plus `sanitizeProject()`. Project → doc is `pushProject()`, a field-level diff; writing a whole project into an empty doc gives the same doc as the server's `cueboardToDoc()` (tested). |
| `collab.js` | The two above, Yjs and y-websocket bundled by esbuild (`npm run build:collab`), committed. |

**Media** (frames, clips, takes, the song) now travels between collaborators, peer to peer, encrypted, verified by hash: `docs/media-p2p.md`. `packages/collab-client/src/media.mjs` and `media-core.mjs`, `packages/sync-server/src/media-relay.mjs`, `<meta name="cue-ice-urls">`, and **Files…** in the project menu.

## Storage (all in the browser)

- `cueboard-local` (the app's own database, schema unchanged): projects as before. A bound project is an ordinary local project; leaving the room leaves it as it is.
- `cueboard-local` / `settings` / `collab`: `{ name, rooms: { <projectId>: { roomId, token, name, share? } } }`. `share` is set until a "Share into the room" has gone through, so a reload in between retries the share instead of pulling the empty room over the project.
- `cueboard-local` / `settings` / `deviceId`: a random id for this browser. Takes record it (`take.dev`) so only the browser that started a generation polls OpenRouter for it, and presence hides this browser's other tabs and stale sessions. In a project bound to a room, a take without `dev` (older, or imported) is polled by nobody, and a 404 never marks someone else's take failed. Outside a room every pending take is polled, whatever its `dev` (a project imported from another device or origin). Sharing a project into a room first stamps this browser's id on its takes that have none.
- `cueboard-local` / `settings` / `collab`, per room: `limits` (`{ file, project }` in MB) once set in Files….
- `cueboard-collab` version 2 adds `parts` and `chunks` (files being received from peers; `docs/media-p2p.md`). Leaving a room drops that project's parts.
- `cueboard-collab` (new database): `docs` (projectId → `{ u, base }`: the Y.Doc state, saved 300 ms after each change, and the push base that goes with the app's saved project; see "Reopening") and `hashes` (local media id → `{ sha256, bytes, mime }`). A bare Y.Doc state (written by `seed()`, or by an older version) has no base. Leaving a room deletes its `docs` entry, also from a tab that never loaded `collab.js` (`index.html` deletes it directly and never creates the database), and a save still in flight never writes it back.
- Presence is one person per browser: awareness states with the same device id (two tabs, or a tab and its session from before a reload) show once.

## Data flow

- **Local → room.** Every `scheduleSave()` also calls `session.changed()`: text typed into a shared field is pushed at once (so the doc and the textarea never disagree and remote edits merge around the caret), everything else after 150 ms. `pushProject(doc, last, cur)` writes only what differs between `last` (the project as the doc had it after the previous push or pull) and the app's `cur`: text fields as minimal Y.Text edits, media ids as hash refs, takes matched by id, other keys last-writer-wins. A media file whose hash isn't known yet is hashed (SubtleCrypto) and pushed on the next round; until then that field keeps its old value in `last`, so it's retried.
- **Pending hash.** While a media field waits for its hash (a new frame, a take that just downloaded, a reference, a new song), the doc still has the old value and this device the new one. `pushProject()` reports each such field (shot id, take id, field) and the session keeps them as *holds*, rebuilt on every push. A pull puts this device's value over the doc's for held fields (`keepPending()`, with an image's `kind` and `clipDur`) and merges everything else, so a collaborator's typing can't undo the change. Once the hash is known the next push writes it and the hold is gone. A second change to the same field wins: pushes always read the app's current value, so a stale hash is never written. A shot or take deleted elsewhere meanwhile stays deleted. A file that can't be read or hashed (error, aborted) isn't retried this session: it stays here, the chip says "Synced, N file(s) not shared", and once someone else changes that field their value wins.
- **Releasing media.** An old blob is deleted only after the project that no longer points at it has been saved locally, never before, and only if no project in this browser points at it anymore (a room maps a hash to whichever local copy this browser has, so two projects can share one). This covers remote changes too: `applyRemote()` releases the local files a pull dropped (a take or shot deleted elsewhere, a frame replaced); while another shot or take still uses the same file it stays. Deleting a project goes through the same check (`mediaInUse()` in `index.html`, the one check before any media file is deleted), so a room project that points at another project's files can be deleted without taking them along. A deleted file's hash is dropped from `hashes` (`dropMedia()`, or directly from a tab without `collab.js`), so a remote ref to the same content resolves to a copy added later instead of the dead id.
- **Room → local.** After a remote transaction, a microtask pushes pending local changes first, then reads the doc with `docToProject()` (sanitized) and hands it to `applyRemote()`. That updates `cur` in place (section and take objects keep their identity, since a running poll or generation holds them), re-renders, and schedules a local save (300 ms, as soon as the doc's own copy) without pushing back, so nothing echoes. Remote changes wait while a cut or card is being dragged.
- **Reopening.** The offline copy and the app's project live in two databases and can't be written atomically. On reopen, `start()` pushes what differs between the app's saved project and the stored *base*, then pulls. The base is `last` as it was when the app last saved its project: `flush()` calls `session.mark()` (push what's unsent, take `last`) before its snapshot and `session.saved()` after the write, which stores the doc and that base together. The doc's own 300 ms saves keep the previous base. So the base is never ahead of the saved project: if the page dies after the copy took a remote change and before the app saved it, the change is in the doc and not in the base, and the reopen pulls it instead of pushing the old value back over it (which would have undone it in the room for everyone). The base can be behind the doc (local edits already pushed): re-pushing those is a no-op (same value, or text that already reads the same). A copy without a base takes the doc as it loads, as before. `pagehide` and `visibilitychange` (hidden) flush a pending app save and the doc's pending save.
- **First visit through an invite.** If the join is cancelled or fails and there are still no projects, the example opens, as on any first visit.
- **Caret.** Before a remote transaction is applied (`beforeTransaction`), the focused shared field's selection is stored as Yjs relative positions; after the pull the field gets the new text and the selection is put back where those positions now are.
- **Order.** Shots are ordered by `start` (ties by id), as in the schema; a swap or slide edits `start` values, a new cut is a new key. Concurrent inserts and moves both survive.
- **Concurrent delete vs edit.** A shot or take deleted elsewhere while it was being edited here stays deleted.

## Untrusted input

Everything in the doc and in awareness came from another browser. `sanitizeProject()` keeps known fields only with the right type and within limits (500 shots, 200 takes per shot, 20,000 characters per text field, media ids must be `sha256-<hex>` or a plain id), drops unknown non-scalar keys, and returns `null` for anything that isn't a project; a pull that fails validation is ignored and the last good state stays. Names in awareness are stripped of control and bidi characters and cut to 40 characters; shot ids are checked before use. All of it is rendered with `textContent` or `esc()`.

## Status chip

| Chip | When |
|---|---|
| Synced | connected and the first sync is done |
| Synced, N file(s) not shared | as Synced, but N media files couldn't be read or hashed here (see "Pending hash") |
| Syncing… | connecting, or connected and waiting for the first sync |
| Offline, changes will sync | the browser is offline (the provider is disconnected until it's back) |
| Syncing N files · All files here · N files not available yet: nobody online has them · N files skipped: over the size limit · … | as Synced, in a project with media files: their transfer state (`docs/media-p2p.md`, "Limits and UX") |
| Can't reach the room | the connection fails (it keeps retrying, up to every 10 s), or the server refused the token or room (4400/4401/4404: it stops retrying) |

## Server change

The browser can't put headers on a WebSocket, and a token in the URL lands in reverse-proxy access logs and in the browser console whenever a connection fails. The server now also accepts the token as the second WebSocket subprotocol (`cueboard, <token>`) and only ever echoes `cueboard` back; the `?token=` query parameter still works. Test: `packages/sync-server/test/token-protocol.test.mjs`. `create-project` prints an app link (`#join=`, token in the fragment, which browsers don't send to the server) when `APP_URL` is set.

So the token stays out of URLs, the browser console and the sync server's own log (it never logs request headers or the token; tested). **A reverse proxy's access log is another matter:** Caddy's JSON access log records every request header and by default redacts only `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization`, so `Sec-WebSocket-Protocol` (and so the token) would be written as is. The sync site needs one of these:

```caddyfile
# a) no access log for the sync site: Caddy writes access logs only for sites with a `log` directive, so leave it out
sync.example.dev {
	reverse_proxy 127.0.0.1:3300
}

# b) an access log with the token taken out: the subprotocol header deleted, and ?token= deleted from the URI (older links)
sync.example.dev {
	log {
		output file /var/log/caddy/sync-access.log
		format filter {
			wrap json
			fields {
				request>headers>Sec-Websocket-Protocol delete
				request>uri query {
					delete token
				}
			}
		}
	}
	reverse_proxy 127.0.0.1:3300
}
```

The header key is the canonical Go form Caddy logs it under (`Sec-Websocket-Protocol`, lowercase `s` in `Websocket`). Not checked against a running Caddy or the hephaestus config: after deploying, open a room once and grep the log for the token. Any other proxy or CDN in front needs the same treatment.

## Checks

- `npm test -w @cue-board/collab-client`: conversion, equivalence with `cueboardToDoc()`, merge of concurrent edits, validation, `keepPending()`; `test/session.test.mjs` runs a session against a real server on port 3385 while another client types: media pending a hash (frame and take), a hash failure, two quick changes, a remote delete. `test/reopen.test.mjs` (port 3386, an in-memory IndexedDB) kills a session after its offline copy took a remote change the app never saved (notes, title, a new take) and reopens it: the change stays in the room and reaches the app, nothing is doubled; and leaving while a save is in flight doesn't bring the copy back. The three reopen cases fail on the code before this fix (the change is deleted from the room).
- `packages/sync-server/test/token-protocol.test.mjs` (t): joins, wrong tokens, unknown room, malformed message, too many connections, all at log level debug: neither the token nor the subprotocol header appears in any log line. (The server never logged them; this guards it.)
- `node design/collab-check.mjs . design/shots/collab`: two and three browser contexts against a real server on port 3360 (rooms from the CLI): join, share, new device, concurrent typing with carets, adding and swapping shots, presence, offline and reconnect, reload, media placeholder, a frame and a take (fake OpenRouter job, routed in the page) landing under a slowed SHA-256 while the other side types, two tabs of one browser, wrong and revoked token, the handshake as the server receives it (through a recording pass-through on 3361: token only in `Sec-WebSocket-Protocol`, only `cueboard` echoed), leaving (also from a tab without `collab.js`), layout from 1920 to 820 px, and the token's absence from URLs, `localStorage`, page text, console, server log and exports. Also, with a plain Yjs client in the room where needed: sharing stamps `dev` on older takes; B's renderer crashed (CDP `Page.crash`) right after its offline copy took A's change, then reopened: the change survives in A and B; a take deleted elsewhere keeps its file while the shot still uses it and frees it after; a pending take without `dev` is polled by nobody (B has a key; a 404 is routed for it) and stays "pending"; a first visit through an invite with the join cancelled opens the example; `mediaInUse()` on its own (taken from `index.html`); leaving, rejoining as a new project and deleting it keeps every file of the first project; a project in no room imported with another device's `dev` on a pending take still polls it. All eight fail on the code before these fixes. In the browser run the crash usually lands after both saves (they now happen at the same time), so the "copy ahead of the project" case itself is covered by `reopen.test.mjs`.
- `collab.js` is reproducible: `npm run build:collab` twice gives the same bytes, and rebuilding a commit's source gives that commit's `collab.js`.
