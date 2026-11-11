# SPEC: Export video (render) + project frame ratio + render a section (MVP)

Status: draft for owner approval (Rami approved the product rules in chat, 2026-11-10).

## Why
Cue Board plans and generates a music video shot by shot against the song, but there is no way to get the finished video out. Today "Export" only saves the project as `.cueboard.json`. This adds a real render: an MP4 of the timeline (all of it or a marked section), in the frame ratio of the project.

## Product rules
- **Render is free for everyone at 720p, with a small watermark.** A discreet "Cue Board" wordmark, bottom-right, ~55% opacity, about 3% of frame height. No other limits.
- **1080p without watermark for anyone with an account** (`account.get()` is truthy). Accounts come from paying OR from an invite code Rami hands out (friends and testers): both are the same account, so both unlock it. No new server logic: the client already knows whether there is an account.
- **Frame ratio is a project setting**, not an export option: 16:9 (default), 9:16, 1:1, 4:3. It is synced to collaborators like the project title. The monitor shows the frame in that ratio while you edit, generation asks the model for that ratio when the model supports it, and the render uses it.
- **Render a section**: in/out marks on the timeline; the export dialog offers "Selection" (only when marks exist) or "Whole song".
- Everything happens in the browser. Nothing is uploaded; the render is a local download.

## Pieces
### 1. Project ratio
- New project field `ratio` (`"16:9" | "9:16" | "1:1" | "4:3"`); absent = `"16:9"`, so every existing project and every old export file opens exactly as today.
- Control: in the existing project area (desktop: next to the project picker / project operations; phone: in the project sheet), a compact selector labelled "Frame" with the four options. Respect existing placement rules: project actions live with the project, not in Settings.
- Monitor (desktop and phone) letterboxes its frame to the ratio and crops media to fill it (`object-fit: cover` behaviour), so what you see is what renders. Thumbnails in the strip can stay as they are.
- Generation (video and image requests that today hard-code `aspect_ratio: "16:9"`) sends the project ratio when the selected model supports it. Add a per-model `ratios` list next to the existing `res` list; a model without the ratio gets 16:9 and the render crops. Do not guess support you cannot confirm: when unknown, keep 16:9.
- Undo/redo and collaboration must treat `ratio` like any other project meta field (the history module already diffs meta fields; check it, add a test).

### 2. In/out marks
- Keys `I` and `O` set in/out at the playhead (desktop; ignore while typing or with a dialog open; ignore `e.repeat`). `Alt+X` (or a "Clear" action in the dialog) clears them.
- Marks are drawn on the timeline ruler as two handles with the range shaded; handles drag with mouse and finger (pointer events), snapping is not required.
- Marks are per-tab view state stored with the project locally but NOT synced to collaborators and NOT part of undo (they are a viewing aid, like the playhead).
- Phone: a "Mark in" / "Mark out" pair in the phone timeline's existing action area or the export dialog itself ("Set in/out from playhead"); no keyboard needed.

### 3. Export dialog and render
- Entry points: desktop, a "Render" button with icon + label next to the project operations (keep the existing JSON Export as is, rename its label/tooltip to "Save project file" only if it is ambiguous next to Render; list that as a suggestion, do not rename on your own); phone, a "Render video" row in the project sheet.
- Dialog (20px inset, existing dialog styles, tabs not needed): Range (Whole song / Selection, with times shown in mono tabular), Resolution (720p always; 1080p enabled only with an account, otherwise disabled with the hint "Log in or use your invite code for 1080p without watermark"), ratio shown read-only with a link-style button to change it, Render button, then a progress bar with percent and Cancel. On finish: download starts automatically and the dialog says "Done" with the file name and size.
- Output: MP4, H.264 video + AAC audio, 30 fps, at 720p or 1080p on the short side matched to the ratio (16:9 -> 1280x720 / 1920x1080; 9:16 -> 720x1280 / 1080x1920; 1:1 -> 720x720 / 1080x1080; 4:3 -> 960x720 / 1440x1080). File name: `<project title> - <ratio as 16x9> - <range>.mp4`, sanitized.
- Frame content per shot in the range: the shot's chosen take video if there is one (the same take the monitor plays), else its key image (still, held for the shot), else black. Media is cropped to fill the frame (cover), centered. Video takes shorter than the shot hold their last frame; longer ones are cut at the next cut. Audio: the song, trimmed to the range; no audio if the project has no song.
- Engine: WebCodecs (`VideoEncoder`, `AudioEncoder`) plus a small MP4 muxer, faster than real time. Vendor the muxer (MIT/BSD-licensed, e.g. `mp4-muxer`) into a lazily loaded file (like `collab.js`), self-hosted, no CDN, loaded only when the user opens the render dialog. Fallback when WebCodecs H.264/AAC is not available: real-time `canvas.captureStream()` + Web Audio + `MediaRecorder` (MP4 where the browser supports it, else WebM), with the dialog saying it renders in real time. Firefox and older Safari must still produce a file.
- Memory: never hold all frames; encode streaming, flush the encoder periodically, release decoded frames (`frame.close()`), and release object URLs after the download.
- Cancel stops cleanly and frees everything; closing the dialog cancels; a render in progress blocks a second one.
- Errors (a take that fails to decode, encoder error, storage full) show a calm message in the dialog naming the shot when possible ("Shot 04's take could not be read; it rendered black") and the render continues for per-shot media failures.

## Out of scope (do NOT build)
Per-shot reframing / pan & zoom · transitions, fades, titles, text overlays · color or speed changes · audio mixing, take audio, volume · rendering on the server · upload/share links · resolutions other than 720p/1080p · frame rates other than 30 · GIF or image-sequence export · a render queue or background render after closing the dialog · changing generation models' lists beyond adding the `ratios` field · touching the auth service, the sync server or the paywall · any change to how takes are generated, chosen or stored.

## Approval criteria (each one = a test written first; all green = mergeable)
1. A project without `ratio` opens as 16:9; old `.cueboard.json` files import unchanged; setting 9:16 saves, reloads and travels to a second tab in the same room (collab check).
2. Undo after changing the ratio restores the previous one; a collaborator's later ratio change is not overwritten by undo (history module test).
3. The monitor frame's measured aspect matches each of the four ratios at desktop (1440x900) and phone (390x844) sizes, with media covering the frame (no bars inside the frame).
4. Video generation request body carries the project ratio for a model whose `ratios` includes it, and `16:9` for a model whose list does not (request captured with a stubbed fetch, no real API call).
5. `I`/`O` set marks at the playhead, handles drag, marks survive reload, are not synced to a second tab, are ignored while typing, with a dialog open, and on key auto-repeat.
6. Render of the whole song for a fixture project (3 shots: one video take, one image only, one empty; plus a song) produces an MP4 whose duration matches the song within 0.1 s, whose video track has the expected width x height for each ratio, and whose audio track exists. Verify by parsing the produced file (duration, track dimensions, codecs) in the test, not by trusting the UI.
7. Render of a selection produces a file whose duration equals out minus in (within 0.1 s) and whose first frame comes from the shot at the in point (sample a pixel color from fixture media of known solid colors).
8. Without an account: 1080p is disabled, the file is 720p and the watermark is present (pixel check in the bottom-right corner region against the known fixture color). With an account (stub `account.get()`): 1080p is available and the watermark is absent at both resolutions.
9. Fallback path: with `VideoEncoder` forced undefined, a render still produces a playable file (MediaRecorder path) and the dialog says it renders in real time.
10. Cancel mid-render stops within 1 s, no download happens, a new render can start right after; no `VideoFrame` leak warnings in the console.
11. The muxer file is loaded only when the render dialog opens (no request for it on page load); no third-party requests at any point.
12. Phone (390x844 and 390x667): the render entry is reachable from the project sheet in two taps, the dialog fits without horizontal scroll, touch targets are >= 44px; text blocks do not overlap.
13. Existing check suite (`design/*.mjs`, run one at a time) and package tests stay green.
14. Smoke: the app served from `server.mjs` loads with zero page errors and renders the fixture end to end in headless Chromium.

## Limits and gate
- Size cap: ~700 lines of production code (tests and the vendored muxer excluded). Over the cap = stop and report.
- Merge when: all criteria green + full existing suites green + under the cap.
- At most ONE independent review; only blockers (data loss, a criterion not actually met, user input rendered as HTML) count. Everything else goes to a follow-up list.
- Before finishing, the implementer re-reads the diff as a hostile reviewer: memory leaks on long songs, cancel during flush, a take deleted by a collaborator mid-render, a song replaced mid-render, very short shots (< 1 frame), and adds a test for each it can.

## Setup the owner does
None.

## Deploy
Static app only (no server change): merge, then publish through the hephaestus repo as usual, keeping the live per-host meta values; curl the live build id and that the new Render entry is present. Rollback: re-publish the previous `pages/cue` commit.

## Manual test list for Rami (real devices, after deploy)
- iPhone (Safari and home-screen app): set 9:16, render a 10 s selection, open the file in Photos and play it with sound.
- Desktop Chrome: render the whole song in 16:9 at 1080p while logged in; check there is no watermark.
