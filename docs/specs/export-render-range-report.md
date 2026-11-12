# Report: render range options and AAC audio (export-render-range.md)

Branch `render-range`, local commits only (nothing pushed or merged). New check: `design/render-range-check.mjs`, 52/52 (all of it failed before the code existed: 8/22 at the time, plus the stacking check, which failed until fixed). Run helper: `node design/run-local.mjs design/<check>.mjs <root> <out>`.

## Criteria

| | Result | Proving check |
|---|---|---|
| A1 | PASS | render-range-check "A1": no set-in/set-out/mark buttons anywhere; Range rows are exactly All, Current selection, Custom |
| A2 | PASS | "A2 · desktop" (disabled + hint / enabled with 0:01.0 to 0:03.0, read-only, mono); "A2 · phone-390x844 / 390x667" |
| A3 | PASS | "A3 · phone-…": handles at rest at 0 and the end, drag creates the selection, both dragged back clear it, Clear works, grips 44×44, a handle behind Clear stays draggable (390×844 and 390×667) |
| A4 | PASS | "A4 · 1:15 and 75…", "rejects End ≤ Start…" (16 bad inputs: End ≤ Start, past the end, under 0.2 s, letters, 1:75, -3, 1e3, empty, two colons, pasted text, Infinity, hex), "Enter in an invalid field starts nothing" |
| A5 | PASS | "A5": Custom 0:02.5 to 4.5 makes a 2.02 s file (video 2.00, audio 2.02), first frame green (the shot at 2 s), marks still [1, 3] |
| A6 | PASS (fallback) | "A6 · AudioEncoder AAC stubbed off": no permissive AAC encoder exists to vendor (below), so the Opus notice shows in Done; no notice when there's no audio |
| A7 | PASS, mostly trivially | "A7": no encoder file is ever requested (none exists with the fallback); the muxer only once the dialog opens; no third-party requests |
| A8 | PASS | "A8": offset 0 px at 960, 1180, 1440, 1920 (example and a long-titled project); `topbar-spacing-check` now also measures 960 and 1180 |
| A9 | PASS | the whole suite, below |

## Production code
`index.html`: +57 / −26 lines (git diff --stat against 5913670), well under the 250 cap. The app's lines are long, so the line count understates how much changed.

## AAC
Fallback applied. Rejected: `@mediabunny/aac-encoder` 1.65.2 (FFmpeg, LGPL-2.1+, 1.13 MB), `@audio/encode-aac` 1.2.1 (Fraunhofer FDK licence: you have to hand out the source to anyone who gets the binary, it grants no patent licence, and it may only be used where a patent licence applies; 484 KB), `@ffmpeg/core` (GPL, 64.7 MB), `@unni-craftsman/aac-encode` (faac, LGPL). The only permissive encoder, vo-aacenc (Apache-2.0), has no browser build on npm and couldn't be compiled here. Details and the way forward are in `export-render-notes.md`. No file was vendored.

## Existing suite (one at a time)
All green: collab 59/59, inline-shots 21/21, media 37/37, mobile 130/130, mobile-sizes 66/66, mobile-takes 90/90, phonebar 33/33, render 103/103, render-collab 8/8, report, resume-buy, rooms, settings-account all pass, shortcuts 52/52, strip-wheel 19/19, syntax, topbar 53/53, topbar-spacing 5/5, undo 84/84, sdp-size runs, `npm test` 11 + 56 + 50 pass (1 skipped: it needs `/opt/cue-sync/data`). `shoot.mjs` timed out once at load and passed on rerun. `measure.mjs` crashes, and crashes the same way on the commit before this pass, so the crash was already there. collab and media needed `npm ci` first (the workspace deps weren't installed).
Edited assertions (because the markup changed): render-check 6 (Current selection is shown disabled instead of hidden), 7 ("Clear in the dialog" became Alt+X; "Set in from the dialog" was removed), 12 (Set in/out taps became ruler handle drags); topbar-spacing widths +960 +1180, and its centre rule now applies at those widths (the full-zone gap is 16 px below 1280).

## A human on a real device
iPhone (Chrome iOS): drag both ruler handles from rest, the Clear button, typing times in Custom on the iOS keyboard (the colon and comma); an Opus file from Linux Chrome really refuses to play in Photos/QuickTime and plays in VLC; the bar at 960 px.

## Open risks
- AAC on Linux needs a vo-aacenc WASM build (Apache-2.0), which an owner-approved follow-up would have to do; AAC patents weren't checked legally. TASTE-GAP: I treated the FDK licence as "questionable" and rejected it.
- With a handle under the zoom buttons it can't be grabbed until you scroll (this was already true); Clear covers the ruler's leftmost labels.
- With no song loaded, Side A/B sits 40-85 px off centre because the song zone is full (already so, and the bar check accepts it).
- Custom accepts up to 0.05 s past the end (it treats that as the end), so it never refuses its own pre-filled value.
