# Collaboration v1: how the app talks to a room

User-facing summary and limits: README, "Collaboration v1". Server and doc layout: `packages/sync-server/SPIKE.md` and `packages/sync-server/docs/data-model.md`.

## Pieces

| Where | What |
|---|---|
| `index.html` | `<meta name="cue-sync-url">` (empty = off), the join dialog, status chip, presence, "Join collaboration…" / "Leave collaboration", the bindings, `applyRemote()`. Imports `./collab.js` only when a project is bound or being joined. |
| `packages/collab-client/src/collab.mjs` | One session per open bound project: Y.Doc, y-websocket provider, offline copy of the doc, media hashing, caret-preserving pulls, awareness. |
| `packages/collab-client/src/convert.mjs` | Project ⇄ doc. Doc → project is the sync server's `docToCueboard()` plus `sanitizeProject()`. Project → doc is `pushProject()`, a field-level diff; writing a whole project into an empty doc gives the same doc as the server's `cueboardToDoc()` (tested). |
| `collab.js` | The two above, Yjs and y-websocket bundled by esbuild (`npm run build:collab`), committed. |

## Storage (all in the browser)

- `cueboard-local` (the app's own database, schema unchanged): projects as before. A bound project is an ordinary local project; leaving the room leaves it as it is.
- `cueboard-local` / `settings` / `collab`: `{ name, rooms: { <projectId>: { roomId, token, name, share? } } }`. `share` is set until a "Share into the room" has gone through, so a reload in between retries the share instead of pulling the empty room over the project.
- `cueboard-local` / `settings` / `deviceId`: a random id for this browser. Takes record it (`take.dev`) so only the browser that started a generation polls OpenRouter for it, and presence hides this browser's other tabs and stale sessions.
- `cueboard-collab` (new database): `docs` (projectId → Y.Doc state, saved 300 ms after each change) and `hashes` (local media id → `{ sha256, bytes, mime }`). Leaving a room deletes its `docs` entry, also from a tab that never loaded `collab.js` (`index.html` deletes it directly and never creates the database).
- Presence is one person per browser: awareness states with the same device id (two tabs, or a tab and its session from before a reload) show once.

## Data flow

- **Local → room.** Every `scheduleSave()` also calls `session.changed()`: text typed into a shared field is pushed at once (so the doc and the textarea never disagree and remote edits merge around the caret), everything else after 150 ms. `pushProject(doc, last, cur)` writes only what differs between `last` (the project as the doc had it after the previous push or pull) and the app's `cur`: text fields as minimal Y.Text edits, media ids as hash refs, takes matched by id, other keys last-writer-wins. A media file whose hash isn't known yet is hashed (SubtleCrypto) and pushed on the next round; until then that field keeps its old value in `last`, so it's retried.
- **Pending hash.** While a media field waits for its hash (a new frame, a take that just downloaded, a reference, a new song), the doc still has the old value and this device the new one. `pushProject()` reports each such field (shot id, take id, field) and the session keeps them as *holds*, rebuilt on every push. A pull puts this device's value over the doc's for held fields (`keepPending()`, with an image's `kind` and `clipDur`) and merges everything else, so a collaborator's typing can't undo the change. Once the hash is known the next push writes it and the hold is gone. A second change to the same field wins: pushes always read the app's current value, so a stale hash is never written. A shot or take deleted elsewhere meanwhile stays deleted. A file that can't be read or hashed (error, aborted) isn't retried this session: it stays here, the chip says "Synced, N file(s) not shared", and once someone else changes that field their value wins.
- **Releasing media.** An old blob is deleted only after the project that no longer points at it has been saved locally, never before.
- **Room → local.** After a remote transaction, a microtask pushes pending local changes first, then reads the doc with `docToProject()` (sanitized) and hands it to `applyRemote()`. That updates `cur` in place (section and take objects keep their identity, since a running poll or generation holds them), re-renders, and schedules a local save without pushing back, so nothing echoes. Remote changes wait while a cut or card is being dragged.
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

- `npm test -w @cue-board/collab-client`: conversion, equivalence with `cueboardToDoc()`, merge of concurrent edits, validation, `keepPending()`; `test/session.test.mjs` runs a session against a real server on port 3385 while another client types: media pending a hash (frame and take), a hash failure, two quick changes, a remote delete.
- `node design/collab-check.mjs . design/shots/collab`: two and three browser contexts against a real server on port 3360 (rooms from the CLI): join, share, new device, concurrent typing with carets, adding and swapping shots, presence, offline and reconnect, reload, media placeholder, a frame and a take (fake OpenRouter job, routed in the page) landing under a slowed SHA-256 while the other side types, two tabs of one browser, wrong and revoked token, the handshake as the server receives it (through a recording pass-through on 3361: token only in `Sec-WebSocket-Protocol`, only `cueboard` echoed), leaving (also from a tab without `collab.js`), layout from 1920 to 820 px, and the token's absence from URLs, `localStorage`, page text, console, server log and exports.
- `collab.js` is reproducible: `npm run build:collab` twice gives the same bytes, and rebuilding a commit's source gives that commit's `collab.js`.
