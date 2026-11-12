# SPEC: phone interface redesign, direction B ("editor")

Status: direction chosen by the owner on 2026-11-12 from mockups. Reference (not committed): `.ref/mocks.html?d=B&s=1..5`, `.ref/out/B-*.png`, `.ref/NOTES.md`. The mock is the visual target; this file is the contract. Where they disagree, this file wins.

## Why
The owner's words: the video looks tiny, the whole screen is buttons, the phone UI is hard to use, the project sheet is a mess. Today the phone stacks seven strips with about 20 always-visible controls.

## Scope: phone only
Everything here applies below 820px in portrait, plus the new landscape viewer. **Above 820px nothing changes**, and the data model, storage keys, sync messages and export format do not change at all (the preview build shares storage with the live app).

## The screen (Cut side), top to bottom
1. **Top row** (one row, no separate app bar): the project's name as a button that opens the Project sheet (with the attention dot it has today), the Cut / Takes switch, then Report a problem and Settings as icon buttons. Presence avatars and the files indicator stay out of this row (they live in the Project sheet, as today).
2. **Monitor**: the frame in the project's ratio, as large as the width allows, no black bars around a 16:9 frame (the spare height goes to the timeline). **Tap the picture to play or pause.** Current time over total is overlaid on the picture's lower edge (mono tabular, on the scrim). While paused, a play glyph sits centred on the picture; it fades out when playing. No transport row.
3. **Timeline**: fills the remaining height. No floating zoom buttons: pinch to zoom, double-tap the ruler to fit. The range handles and Clear (from the render work) must not cover ruler labels: Clear sits at the ruler's right end, in line, only when a selection exists.
4. **One bottom bar**, 60px plus the safe area, whose contents depend on the selection:
   - nothing selected: Undo, **Cut here** (the primary action, wide);
   - a shot selected: Undo, Cut here, Details, Photo, Move, More;
   - a cut picked: −0.1 s, the cut's time and both lengths, +0.1 s, Done.
   **More** opens a small sheet for the selected shot: Loop this shot, Playback speed, Delete shot (last, apart, asks again as today). Undo keeps tap = undo, hold = redo.
   Nothing else is always visible. No peek row, no tab bar at the bottom.

## Takes side
Same top row. The monitor shows the picked take (or the start frame). Below it, the shot rail, the header and the frames / references / takes column as today, restyled only as far as the mock shows. No generation controls on the phone (unchanged).

## Project sheet
Titled sections, uniform rows (label left, value and chevron right), in this order:
- **Projects**: the list; New, Import.
- **This project**: Rename; Song (shows the song's name; tapping opens Replace / Remove); Frame (shows the ratio).
- **Output**: Render video; Copy shot list; Save project file (today's "Export"; rename on the phone only).
- **Collaboration**: as today (people, state, Files and downloads, This room, Collaborate).
- **Delete project**: last and apart.
The install hint keeps its place above Delete project.

## Landscape viewer (new; replaces the earlier "no landscape" decision)
When a phone is turned to landscape (a coarse pointer, landscape, height under 500px): the monitor fills the screen (frame fitted, black around it), tap to play or pause, time overlaid, a thin scrub bar along the bottom edge that can be dragged, and a small "Rotate to edit" hint that fades after 2 s. No editing in landscape. Turning back restores the portrait screen at the same position and selection.

## Out of scope (do NOT build)
Any desktop change · any data, storage, sync or export change · new features (effects, titles, multi-track) · generation on the phone · tablet layouts · a new icon set (new icons follow the sprite's 16px grid and 1.5px stroke) · swipe-between-shots paging (direction C) · renaming Export on desktop · onboarding or tutorials.

## Approval criteria (each = a check written first; phone sizes 390x844, 390x667, 430x932, 360x640)
1. Cut side, nothing selected: the always-visible controls are exactly the top row's items, the picture (tap target) and Undo + Cut here. Count them in the check; there is no transport row, peek row, zoom button or bottom tab bar in the DOM's visible set.
2. Tapping the picture toggles play / pause; the time overlay updates; the play glyph shows only while paused. Taps on the slate or caption areas that have their own actions keep them.
3. Selecting a shot swaps the bar to the six tools; picking a cut swaps it to the nudge layout; deselecting restores it. Every tool does what its old button did (reuse the same handlers).
4. More sheet: Loop, Speed and Delete work; Delete still asks again, ignores a repeated tap within the confirm window as today, and is not adjacent to Undo anywhere.
5. Pinch zooms the timeline around the pinch centre; double-tap on the ruler fits; the playhead stays centred.
6. Range handles are grabbable at rest and with a selection at every size (no control covers them); Clear appears only with a selection and covers no ruler label.
7. Monitor size: at 390x844 the 16:9 picture is the full width (390x219) with no bars; in a 9:16 project the picture's height is at least 50% of the screen. The timeline is at least 330px tall at 390x844 and at least 190px at 390x667 (16:9).
8. Project sheet: the four titled sections in order, uniform rows, Song row opens Replace / Remove, Save project file exports the same file as before, Delete project last; every old action is reachable (list them in the check).
9. Things the old layout showed on the phone are still reachable: save errors (the sheet notice and toast), files and downloads state, who is here, Report a problem, Settings, undo history state. Force a failed save at 390 wide and assert the user sees it.
10. Landscape (844x390 and 667x375): only the viewer shows; tap plays; the scrub bar seeks; turning back restores position and selection.
11. Touch targets are at least 44px; no horizontal overflow; text blocks do not intersect; safe areas respected (nothing interactive under the home indicator), at all four sizes.
12. Above 820px: the existing desktop checks pass untouched (`topbar-check`, `topbar-spacing-check`, `shortcuts-check`, `strip-wheel-check`, `render-check` desktop parts).
13. The existing phone checks (`mobile-check`, `mobile-sizes-check`, `mobile-takes-check`, `phonebar-check`, the phone parts of `render-check` and `render-range-check`) are updated to the new layout WITHOUT dropping behaviours: for every assertion removed, name the new one that covers the same behaviour, in the report.
14. Collaboration still works on the phone (`collab-check`, `rooms-check`, `media-check` green), and a project made before this change opens unchanged.
15. Smoke: served by `server.mjs`, zero page errors at phone and desktop sizes.

## Limits and gate
- Size cap: ~600 lines of production code (CSS + script in `index.html`), tests excluded. Removing dead phone CSS counts in your favour; report added and removed separately. Over the cap = stop and report.
- This build goes to a preview address first; the owner tries it on his iPhone before it replaces the live phone layout.

## A human must test on a real iPhone
Tap-to-play, pinch zoom, the bar's three states with a thumb, the More sheet, rotation both ways, the range handles, the Project sheet, and the keyboard over the details sheet.
