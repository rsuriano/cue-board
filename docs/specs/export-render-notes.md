# Export render: implementation notes

Companion to `export-render.md` (the contract) and `export-render-report.md` (the result).

## Vendored file

| | |
|---|---|
| File | `mp4-muxer.js` (repo root, next to `collab.js`) |
| Package | [`mp4-muxer`](https://github.com/Vanilagy/mp4-muxer) by Vanilagy |
| Version | 5.2.2 |
| License | MIT (full text in the file's header) |
| What it is | The package's `build/mp4-muxer.js`, unmodified, with a header comment added (name, version, licence). It defines one global, `Mp4Muxer`. sha256 of the package's file: `cc4d30bd20b9ffe0b15f59cf0de3e1930626ccd46a5146e36e4d619d7fecf63d` |
| Loaded | By a `<script>` tag the app adds when the render dialog opens (so it also works from `file://`). Never on page load, never from another host. |

To update it: `npm install --no-save mp4-muxer@<version>` in a scratch folder, copy `node_modules/mp4-muxer/build/mp4-muxer.js` over everything below the header in `mp4-muxer.js`, change the version in the header and in this table, run `design/render-check.mjs`.

It is part of the deploy: `mp4-muxer.js` goes to `hephaestus/pages/cue/` with `index.html` (see `CLAUDE.md`). Without it the app still renders, in real time (the fallback path).

## Where the code is

All in `index.html`:

- **Ratio**: `RATIOS`, `ratioOf`, `genRatio`, `renderFrame`, `setRatio` (before "projects"). The monitor's frame is `#mframe` inside `#monitor`, sized in CSS from `--fr`.
- **Marks**: `io`, `ioLoad`, `ioRange`, `ioSet`, `ioDraw`, `ioAt` (same place); the phone's grips are `.mkgrip` buttons made in `mDraw`.
- **Render**: the block "RENDER" before "toast / boot": the dialog (`rnDraw`, `rnMode`, `openRender`), `rnSource` (what a frame shows), `rnFastPath` (WebCodecs + muxer), `rnRealTime` (MediaRecorder), `rnStart` (one job, cancel, the download).

## Decisions made while building (not in the spec)

1. **Audio codec.** The spec asks for AAC. Chrome on Linux and some Firefox builds have H.264 in WebCodecs but no AAC encoder. There the fast path writes **Opus in the same MP4** instead of dropping to the real-time path: the real-time path would not give AAC either (MediaRecorder records Opus there), and it is slower. Where the browser encodes AAC (Chrome on macOS and Windows, Safari) the file is H.264 + AAC as specified. An H.264 + Opus MP4 plays in Chrome, Firefox and VLC, not in QuickTime or iOS Photos.
2. **What a shot shows** follows the monitor exactly: the shot's media (`img`): a clip or a take in the cut, or its image. A shot whose only picture is a start frame on side B (`key`) is black, as it is in the monitor.
3. **Marks live in `localStorage`** under `cueboard-io:<project id>`, not in the project object: a room's update replaces every project field it doesn't know, and the history diffs the project, so this is what keeps them unsynced and out of undo. They are removed with the project.
4. **One mark is enough**: only In means "from there to the end", only Out "from the start to there". A mark set past the other one with a key removes the other; a dragged handle stops 0.1 s short of it.
5. **Model ratios.** `ratios` comes from the live catalog's `supported_aspect_ratios`. The built-in fallback catalog and the image models carry no list (not confirmed), so they are asked for 16:9, as before.
6. **Download again** in the Done state: the automatic download can be blocked on a phone after a long render (no recent tap); the link is the way out. The file's object URL is released when the dialog closes or a new render starts.
7. **Render in the bar** keeps icon and label down to 960px and is the icon alone below that; the Frame selector drops its word below 1280px (it stays its accessible name).
8. **Phone monitor width.** The phone layout inherited `aspect-ratio:16/9` from the stacked layout, which made the monitor 616px wide on a 390px screen (hidden by clipping while media was letterboxed). It now has `aspect-ratio:auto`; the frame inside it carries the ratio.
9. **File names**: `<title> - 16x9 - full.mp4`, or `- 12.3s-31.0s.mp4` for a selection; characters a file system refuses become spaces.
