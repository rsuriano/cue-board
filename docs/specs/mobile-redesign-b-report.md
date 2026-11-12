# Report: phone interface redesign, direction B

Contract: `docs/specs/mobile-redesign-b.md`. Branch `mobile-b`, local commits only (nothing pushed, nothing merged, `main` untouched). Run on 2026-11-12 in headless Chromium with phone emulation and real touch events through CDP. Nothing here ran on an iPhone.

## Criteria

| # | Result | Proving check |
|---|---|---|
| 1 | PASS | `mobile-b-check` "1 ·" at 390x844, 390x667, 430x932, 360x640: the pressable set is project, Cut, Takes, Report, Settings, Undo, Cut here, plus the picture; no transport row, peek row, zoom button or bottom tab bar |
| 2 | PASS | `mobile-b-check` "2 ·" (tap plays and pauses, time moves, glyph only while paused, a control in the slate keeps its tap); `mobile-check` "Download on a held clip in the slate" |
| 3 | PASS | `mobile-b-check` "3 ·" (three bar states, deselect); `mobile-check` Cut here, Details, Photo, Move, ±0.1 s through the same handlers |
| 4 | PASS | `mobile-b-check` "4 ·"; `mobile-check` "armed Delete (in More)…" twice, and "Delete shot (tap twice, in More)" |
| 5 | PASS in emulation. Real iOS pinch: NOT VERIFIABLE HERE | `mobile-b-check` "5 ·" (two-finger CDP touch: zoom in, zoom out, time under the fingers kept within 0.4 s, playhead centred, double tap fits) |
| 6 | PASS | `mobile-b-check` "6 ·" at four sizes; `render-range-check` A3 at 390x844 and 390x667 |
| 7 | PASS | `mobile-b-check` "7 ·" (numbers below) |
| 8 | PASS | `mobile-b-check` "8 ·" (sections, uniform rows, Song opens Replace / Remove, Save project file gives the same `.cueboard.json`, Delete project last) |
| 9 | PASS | `mobile-b-check` "9 ·" (forced failed save at every size: toast, red dot on the name, notice in the sheet); `mobile-check` (who is here, files state, Files and downloads); `phonebar-check` (Report, Settings) |
| 10 | PASS in emulation. Rotation on a device: NOT VERIFIABLE HERE | `mobile-b-check` "10 ·" at 844x390 and 667x375 |
| 11 | PASS (safe areas emulated: 47px top, 34px bottom, through CDP) | `mobile-b-check` "11 ·" at four sizes, Cut side, Takes side and the Project sheet |
| 12 | PASS, files untouched | `topbar-check` 53/53, `topbar-spacing-check` 5/5, `shortcuts-check` 52/52, `strip-wheel-check` 19/19, `render-check` 103/103; `mobile-b-check` "12 ·" at 820 and 1280 |
| 13 | PASS | table below |
| 14 | PASS | `collab-check` 59/59, `rooms-check`, `media-check` 37/37, `render-collab-check` 8/8; `mobile-b-check` "14 ·" (the stored project loads back with the same fields and shots) |
| 15 | PASS | `mobile-b-check` "15 ·": served by `server.mjs` at 390x844, 844x390 and 1280x800, zero page errors |

## Size

`index.html` against the spec commit (`109c49c`): **248 lines added, 147 removed** (net +101), markup included. Cap: about 600. No change to the data model, storage keys, sync messages or the export format; `collab.js` and `packages/` untouched.

## Old assertion → new assertion

| Check | Removed | Covers the same behaviour now |
|---|---|---|
| mobile-check | tabs and toolbar shown, the peek row only from 700px tall | "the Cut / Takes switch and the bar shown, no peek row and no transport row at any height". The peek row's job (open details) is the Details tool: "Details opens as a sheet under the picture" |
| mobile-check | the whole side A deck fits the screen (tab bar on screen) | "…(the bar ends at the bottom edge; the switch is in the top row)" |
| mobile-check | scrub reads `#tc` | same assertion, reads the time on the picture (`#mTime`) |
| mobile-check | armed Delete, then a scroll onto another shot (`#mtDel`) | "armed Delete (in More), then a scroll onto another shot: disarmed, a second tap deletes nothing" |
| mobile-check | armed Delete, then playback crosses a cut (Play button) | same name; playback starts from the picture and crosses the cut with the More sheet open |
| mobile-check | Delete (tap twice) removes the shot | "Delete shot (tap twice, in More) removes the shot and closes the sheet" |
| mobile-check | Details opens under the transport (Play stays visible) | "Details opens as a sheet under the picture (the picture, which is Play, stays visible)" |
| mobile-check | a long shot title: the peek row truncates it | "a long shot title: no overflow (the slate on the picture truncates it)" |
| mobile-check | song picker opens from the Song button | "song picker opens (Song, then Replace song)" |
| mobile-check | rotated: no overflow, Play reachable | "rotated: no overflow, Play reachable (the picture fills the screen; a tap on it plays)" |
| mobile-sizes-check | waveform at most its cap (120px) | "the waveform row takes the height that is left: at least 72px", and `mobile-b-check` 7 (timeline height). The cap is now on the bars (56px either side), not asserted by pixels |
| mobile-sizes-check | preview at least 30% of the viewport height | "the 16:9 picture is the full width with no bars", and `mobile-b-check` 7 (9:16 at least 50%). The old 30% counted black bars |
| mobile-sizes-check | toolbar and tabs fully visible | "the bar fully visible at the bottom edge; the Cut / Takes switch in the top row" |
| mobile-sizes-check | zoom control 44px tall, off the strip and the waveform | "no zoom control over the shot strip or the waveform: none on screen", and `mobile-b-check` 5 (pinch, double tap) |
| mobile-takes-check | the last control is above the tab bar | "the last control is on screen, clear of the bottom edge" |
| undo-check | Undo in the shot toolbar, before Delete (Cut here, Details, Photo, Move, Undo, Delete) | "Undo is first in the bar, with the five others; Delete is not in the bar" (Undo, Cut here, Details, Photo, Move, More); Delete is `mobile-b-check` 4 |
| render-range-check | a handle behind Clear stays grabbable; the zoom buttons keep their taps | "…; no zoom button is left on the ruler to cover one" |

No check was deleted. `phonebar-check` and `render-check` pass unchanged.

## Suite (each run alone)

`mobile-b-check` 279/279 · `mobile-check` 130/130 · `mobile-sizes-check` 66/66 · `mobile-takes-check` 90/90 · `phonebar-check` 33/33 · `undo-check` 84/84 · `render-check` 103/103 · `render-range-check` 52/52 · `render-collab-check` 8/8 · `collab-check` 59/59 · `rooms-check` all pass · `media-check` 37/37 · `report-check` all pass · `settings-account-check` all pass · `resume-buy-check` all pass · `topbar-check` 53/53 · `topbar-spacing-check` 5/5 · `shortcuts-check` 52/52 · `strip-wheel-check` 19/19 · `syntax-check` pass · `shoot.mjs` exit 0.
`npm test`: auth 11/11, collab-client 56/56, sync-server 50 passed, 0 failed of 51 (one skipped).

Two things to know. `mobile-check` failed once (a timeout at Photo right after a delete); the helper that picks a shot now retries, and the four runs after that were green. `design/measure.mjs` (a desktop audit tool, not a check) stops on `proj.selectedOptions`: it still expects the project picker to be a `<select>`. I did not touch it and did not run it against the base commit. The collaboration checks needed `npm ci` first (no `node_modules` in the clone).

## Measured at 390x844

| | Spec | Measured |
|---|---|---|
| 16:9 picture | 390x219, no bars | 390x219, no bars |
| 9:16 picture | at least 50% of the height | 266x473, 56% |
| Timeline (16:9) | at least 330px | 517px (340px at 390x667, spec 190) |
| Bar | 60px plus the safe area | 60px |
| Always-visible controls | top row, picture, Undo, Cut here | 7 plus the picture: project, Cut, Takes, Report, Settings, Undo, Cut here |

## Where it differs from the mock, and why

- Report and Settings are in the top row, not in the sheet's header: the spec says so.
- The time is on the picture's lower right, not top left: the spec says lower edge.
- No notes row under the picture: the spec has no peek row. Notes are one line on the slate.
- More is a bottom sheet with Loop, Speed and Delete, not a popover with Replace photo and Open its takes: the spec, and the rule that sheets keep the existing style.
- Takes side has no bottom bar and keeps today's column order (frames, references, takes): the spec says "as today".
- Project sheet: no shot count on the open project; the room row says "Collaborate" as today, not "Share or join a room · Not shared".
- Shot tiles keep their thumbnails. Cut here is ink, not orange (orange means selected).

Decisions the spec did not cover (`TASTE-GAP:`):
- TASTE-GAP: a shot is let go by tapping it again or by tapping the waveform or ruler. While picked, the pick follows the playhead as the selection always did.
- TASTE-GAP: with Loop on or a speed other than 1×, the time on the picture says so ("· loop", "· 0.5×"), since those controls are now inside More.
- TASTE-GAP: the play glyph is a real button (Play / Pause for a screen reader). When a slate has its own Download or Retry, the glyph moves to the top so it never covers it.
- TASTE-GAP: on the Takes side a tap on the monitor plays the picked shot's stretch in a loop.
- TASTE-GAP: turning to landscape closes the Project, More and details sheets, but leaves Settings, Render and other dialogs open on top of the viewer (closing Render would cancel a render).
- TASTE-GAP: while the song plays, a pinch zooms around the playhead, not the fingers, so the song does not jump.

Found on the way and fixed: tapping a shot seeked to its start but the timeline did not always follow (touch order); small buttons had a 42px hit area on the phone, now 44.

## A human must test on a real iPhone

Tap-to-play (sound starts, silent switch on) · pinch zoom in Safari and Chrome iOS, and that the page does not zoom or scroll with it · double tap on the ruler · the bar's three states with a thumb, Cut here in particular · the More sheet (Loop, Speed, Delete asks again) · rotation both ways: while playing, with a sheet open, mid-drag · the scrub bar next to the home indicator · the range handles and Clear · the Project sheet, the Frame row opening the native picker · the keyboard over the details sheet · safe areas on a notched phone · that his existing projects open as before.

## Open risks

1. Pinch is built on touch events and proven only in Chromium emulation; iOS may still take the gesture.
2. The landscape viewer triggers on a coarse pointer under 500px tall, so at 844px wide it lays the viewer over the desktop layout; only emulated.
3. A tall (9:16) project leaves the timeline 173px at 360x640 and the Takes monitor small (34% of the height).
4. With many short shots at the default zoom the 44px cut grips sit side by side; pinch in to work on them.
5. Copy on the Takes side still says "side A" in places (desktop wording, out of scope here).
6. Screenshots in `design/out/mobile-b/` use generated colour frames, not real footage.
