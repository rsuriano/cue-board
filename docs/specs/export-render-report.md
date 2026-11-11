# Export render: implementation report

Branch `export-render`, local commits only (nothing pushed or merged). Contract: `export-render.md`. Notes and decisions: `export-render-notes.md`. Screenshots: `design/out/render/`.

All checks ran in the Playwright headless shell (Chromium 156, Linux). It encodes H.264 but has no AAC encoder, which matters for criterion 6.

## Criteria

| # | Result | Proof |
|---|---|---|
| 1 | PASS | `render-check` "1 ·" (example and an old `.cueboard.json` open as 16:9 with no `ratio` added; 9:16 saves and survives a reload) and `render-collab-check` "1 ·" (9:16 travels to a second browser in the room) |
| 2 | PASS | `packages/collab-client/test/history.test.mjs` "frame ratio: undo puts the previous one back…", plus `render-collab-check` "2 ·" in two real browsers |
| 3 | PASS | `render-check` "3 ·": 16 checks, four ratios × image and clip, at 1440×900 and 390×844; frame aspect within 1.2%, media `cover` on the frame's exact box |
| 4 | PASS | `render-check` "4 ·": request bodies captured from a stubbed OpenRouter. Not checked against the live API: the field name `supported_aspect_ratios` is from memory of its docs |
| 5 | PASS | `render-check` "5 ·" (keys, both handles drag, reload, typing, dialog open, auto-repeat, Alt+X) and `render-collab-check` "5 ·" (not synced) |
| 6 | PASS, except AAC: NOT VERIFIABLE HERE | `render-check` "6 ·": the file's boxes are parsed in the test (duration 6.0 s, H.264 at the right size for each ratio, an audio track) and its pixels read back. The audio track here is **Opus**, because this browser cannot encode AAC; the AAC branch never ran |
| 7 | PASS | `render-check` "7 ·": 2.0 s file for a 2.5–4.5 s selection, first frame green (the shot at the in point) |
| 8 | PASS | `render-check` "8 ·": no account → 1080p disabled, 720p, watermark pixels found; with an account → 720p and 1080p, no watermark |
| 9 | PASS | `render-check` "9 ·": `VideoEncoder` removed → the dialog says real time, a playable 1280×720 file with sound comes out in about 6 s for a 6 s song |
| 10 | PASS | `render-check` "10 ·": Cancel returns in under 1 s, no download, a new render finishes right after, no `VideoFrame` warnings after a forced GC |
| 11 | PASS, with one pre-existing exception | `render-check` "11 ·": the muxer is requested only when the dialog opens. The app already asks OpenRouter for its model list at start (unchanged; aborted in the checks); nothing else leaves, and nothing from the render |
| 12 | PASS (emulated) | `render-check` "12 ·" at 390×844 and 390×667: two taps, no horizontal scroll, targets ≥ 44px, no overlapping text, in idle, selection, progress and done |
| 13 | PASS, two existing checks edited | See "Existing suite" |
| 14 | PASS | `render-check` "14 ·": served by `server.mjs`, zero page errors, fixture rendered end to end |

## Size

298 lines added to `index.html` (30 changed or removed) against the ~700 cap. Nothing else is production code; `mp4-muxer.js` (vendored, 1930 lines) and the checks are excluded. The lines are dense, in the file's existing style.

## Existing suite

Ran one at a time, before the change and after, then `npm test`.

- Pass after, same counts as before: `collab-check` 59, `inline-shots` 21, `media-check` 37, `mobile-check` 130, `mobile-sizes-check` 66, `mobile-takes-check` 90, `phonebar-check` 33, `report-check` 42, `resume-buy-check` 11, `rooms-check` 56, `settings-account-check` 19, `shoot` 53, `shortcuts-check` 52, `strip-wheel-check` 19, `syntax-check` 4, `topbar-check` 53, `topbar-spacing-check` 5, `undo-check` 84.
- New: `render-check` 104, `render-collab-check` 8.
- `npm test`: auth 11/11, collab-client 56/56 (one new), sync-server 50 pass and 1 skipped.
- `measure.mjs` fails with a TypeError **before and after** my change (it fails on the untouched branch too). Not fixed.
- Not run: `make-icons.mjs` and `sdp-size.mjs` (a generator and a tool, not checks).
- **Two existing checks were edited because the markup they assert on changed:**
  - `topbar-check.mjs`: the exact list of More's entries at 1440 now includes the four Frame ratios.
  - `topbar-spacing-check.mjs`: the Render button is added to its list of project operations (same 4px gap rule). Nothing was loosened.
- The checks hard-code `/home/ramiro/testkit/` and `/snap/bin/chromium`, neither usable here. `design/local-env.mjs` swaps both paths at load without editing the scripts.

## Deviations from the spec, for the owner

1. **Frame is in the More menu on desktop, not a selector in the bar.** The bar was already full: with a selector and a labelled Render the side switch left the centre at 1440 and 1920, and the bar overflowed in a room. Render keeps icon and word down to 1440 (icon alone below); the project picker's minimum width drops from 160 to 140px below 1800 to pay for it. `TASTE-GAP:` where a project setting goes when the bar has no room.
2. **Opus instead of AAC where the browser has no AAC encoder** (Chrome on Linux). Same MP4, still faster than real time; it does not play in QuickTime or iOS Photos.
3. **A shot renders what the monitor shows.** A shot whose only picture is a side B start frame is black, as in the monitor.
4. **Phone monitor fix.** It was 616px wide on a 390px screen (an inherited `aspect-ratio`); fixed, since the frame needs it.
5. Added without being asked: a "Download again" link in the Done state, for phones that block the automatic download.

Suggestion only, not done: with Render next to it, the JSON Export could be labelled "Save project file".

## A human must test on a real device

- **iPhone, Safari and the home-screen app**: the whole flow. Nothing about iOS was verified: whether WebCodecs or the real-time path runs, whether clips seek frame by frame correctly, whether the download starts by itself, and whether Photos plays the file with sound.
- **Chrome on macOS or Windows**: that the audio track is AAC, and a 1080p render while logged in has no watermark.
- **A real 4-minute song with real takes at 1080p**: memory and speed. Here the longest render was 40 s of flat colour (about 5 s, a file under 1 MB), which says little about either.
- **Firefox**: which path it takes and that the file plays.
- The marks on a real touch screen (44px grips on the phone's ruler), and the frame in 9:16 on a small phone.

## Open risks and follow-ups

1. iOS is untested end to end; the real-time path there depends on `captureStream` and `MediaRecorder` behaving, and on the tab staying in front.
2. Clips are seeked frame by frame on the fast path: exact, but long-GOP 1080p takes may render slower than real time.
3. The real-time path slows or stalls in a background tab (browser timer throttling); the dialog says to keep the tab in front, nothing enforces it.
4. Memory on long renders is by design (frames closed, file kept as Blob parts), not by measurement at real sizes. The decoded song is held whole while its audio is encoded (about 90 MB for 4 minutes).
5. The side switch is up to 16px off centre around 960px wide, where Render's icon fills the left zone; not checked by the suite at that width.
6. During development two smoke runs let `server.mjs` proxy one unauthenticated model-list request to OpenRouter; the check now answers it locally.
