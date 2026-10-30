# Problem reports

**Report a problem** is in **More** on the desktop bar and in the phone's Projects sheet. It opens a dialog with an optional text box, two checkboxes and **See what will be sent**, which shows the exact JSON that goes out (sent without the indentation; rebuilt at Send, so a room that dropped meanwhile shows up in it). Send posts it to the sync server; the user gets "Thanks, sent. Report `<id>`." With no sync server (`cue-sync-url` empty) or when sending fails, **Copy report** and **Download report** give the same JSON to send by hand.

## What a report holds

Built field by field from an allow-list, in the app (`<script id="cue-report">` in `index.html`'s `<head>`) and again on the server (`packages/sync-server/src/reports.mjs`, `cleanReport`): unknown fields are dropped, strings clipped, enums checked.

| Field | When | What |
| --- | --- | --- |
| `v`, `build`, `at` | always | format 1, the build id from `<meta name="cue-build">` (`dev` when empty), the time |
| `text` | if typed | the user's words, up to 2000 characters |
| `viewport`, `phone`, `side`, `ua`, `lang`, `online` | technical details (on by default) | width, height and devicePixelRatio; phone layout or not; side `a` (Cut) or `b` (Takes); user agent; language; online |
| `storage`, `save`, `collab`, `media` | technical details | persistent storage granted, MB used and available; the save status text; `off` (no sync server), `none` (not in a room) or the room state (`synced`, `syncing`, `offline`, `unreachable`, `rejected`, `deleted`, `full`); file counts `here`, `queued`, `downloading`, `skipped`, `failed` |
| `errors` | technical details | the last 20 uncaught errors and unhandled rejections since the page loaded: message (300 characters) and `file:line:col`, repeats counted as `n`. Any of the project's own strings inside a message becomes `[project text]`; if the report would pass 15 KB the oldest errors are dropped |
| `shape` | second checkbox (off by default) | number of shots, each shot's length in seconds and takes per shot (the first 500 shots) |

Never in a report: project, shot or room names, notes, prompts, lyrics, file names, media, thumbnails, the OpenRouter key, the room id, invite links, tokens, owner tokens, verification codes or tokens, anything else from localStorage or IndexedDB. Every string (typed text, error messages, user agent) is scrubbed in the app and again on the server: URL query strings and fragments, `#join=…`, `token=`/`key=`/`code=`…, `Bearer …`, `sk-…` keys, e-mail addresses and anything that looks like a token (16+ characters with digits, `-`/`_`, or many capitals) are removed. The error buffer scrubs when it keeps an error, so nothing secret sits in memory either.

## Server

`POST /reports` on the sync server (same host as the WebSocket, `packages/sync-server/src/api.mjs`). No token: anyone with the app can report. Same `CORS_ORIGINS` allow-list as the other endpoints. JSON body up to 16 KiB (413 past that, 400 for anything that isn't a JSON object). Limits, both answered 429 "Too many reports right now. Try again later.": `REPORTS_PER_HOUR` per IP (5) and `REPORTS_PER_DAY` for everyone (200, checked first, in memory: a restart resets it). Behind the proxy keep `TRUST_PROXY=1` so the per-IP limit sees real addresses. Many addresses can use up the daily limit; the app then offers Copy and Download.

Each report is a file `DATA_DIR/reports/<UTC time with ms>-<id>.json` (folder 0700, file 0600), with `id` and `received` added. At most `MAX_REPORTS` (500) are kept; the oldest go first. The log gets one line per report (`report stored`, id and IP), never its contents.

## Operator

From the server's checkout, with the service's `DATA_DIR`:

    DATA_DIR=<dir> npm run list-reports -w @cue-board/sync-server                  # newest first: id, time, build, phone/desktop, errors, text
    DATA_DIR=<dir> npm run show-report -w @cue-board/sync-server -- <id>           # one report, pretty JSON
    DATA_DIR=<dir> npm run clear-reports -w @cue-board/sync-server -- --older-than 30d

`show-report` only takes a 10-character id and finds the file by listing the folder; it never builds a path from what was typed.

An agent fixing a bug: `show-report <id>` gives the build (`git show <build>`), the viewport and `phone`/`side` to reproduce the layout, the save and room state, file counts and the errors with their `file:line`.

## Build id

`<meta name="cue-build" content="">` is empty in this repo (reports say `dev`). The deploy sets it in the hephaestus copy to the short git sha of the commit being deployed (see `CLAUDE.md`, Deploying).

## Checks

- `packages/sync-server/test/reports.test.mjs` (10 tests): the app's builder taken from `index.html` (a project full of secrets, a room, a key and errors with tokens and `#join=` links leave nothing; details and shape off; the error buffer; app and server scrub alike and idempotently; the app's output is already what the server stores), the server's cleaner (unknown and nested fields, clipping, enums, prototype keys, strings built to backtrack), `POST /reports` (0600 file, refusals, nothing in the log at debug), per-IP and daily limits, CORS, retention, restart, the three CLIs (one line per report, no terminal escapes, no paths in `show-report`).
- `node design/report-check.mjs . <out>` (sync server on 3360): the More entry and the phone row at 1440×900, 390×844 and 390×700, keyboard open and close with focus back on More, Send to a real server (the stored file equals "See what will be sent"), a secret project and planted errors that never reach the report, the network dropping with the dialog open, no sync server (Download and Copy give the shown JSON), an unreachable server, no horizontal overflow, 16px text box on the phone.
