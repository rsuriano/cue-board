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
- **Marks**: `io`, `ioLoad`, `ioRange`, `ioSet`, `ioDraw`, `ioAt` (same place); the phone's handles are `.mkgrip` buttons placed (and drawn at rest) in `mDraw`, its Clear is `#mkClear`.
- **Render**: the block "RENDER" before "toast / boot": the dialog (`rnParse`, `rnRange` (the chosen range or what's wrong with it), `rnDraw`, `rnMode`, `openRender`), `rnSource` (what a frame shows), `rnFastPath` (WebCodecs + muxer), `rnRealTime` (MediaRecorder), `rnStart` (one job, cancel, the download).

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

## AAC encoder: researched 2026-11-12, none shipped (export-render-range.md section 2)

The requirement: a permissive licence (MIT, BSD, Apache, ISC or public domain; no GPL or LGPL), self-hosted, loaded lazily, under ~1.5 MB, off the main thread or in chunks. Every AAC-LC encoder that runs in a browser and is published on npm was looked at (`npm search` for aac encoder / wasm / vo-aacenc; packages downloaded with `npm pack` into a scratch folder and their licence files read):

| Option | Licence | Size | Why not |
|---|---|---|---|
| `@mediabunny/aac-encoder` 1.65.2 (FFmpeg's native AAC encoder in WASM) | Wrapper MPL-2.0; the encoder inside is FFmpeg, **LGPL-2.1+** (the package ships `licenses/ffmpeg/COPYING.LGPLv2.1`) | 1.13 MB minified bundle (5.4 MB unpacked package) | LGPL, excluded by the spec. Also built for Mediabunny's coder API, not mp4-muxer: we would carry glue for a second media library. |
| `@audio/encode-aac` 1.2.1 (Fraunhofer FDK AAC in WASM) | Wrapper MIT; the encoder is under the **Fraunhofer FDK AAC licence** | 484 KB (`src/fdk.wasm.js`) | Not one of the allowed licences, and two clauses rule it out for us: section 2 obliges whoever ships the binary to "make available free of charge copies of the complete source code" of the codec, and section 3 grants no patent licence and says the software may be used "only for purposes that are authorized by appropriate patent licenses" (Via Licensing). A web app without an AAC patent licence would be using it outside its own terms. |
| `ffmpeg.wasm` (`@ffmpeg/core` 0.12.10) | GPL-2.0-or-later | 64.7 MB unpacked | Licence and size. |
| `@unni-craftsman/aac-encode` 0.1.2 (faac in WASM) | LGPL-2.1-or-later | 136 KB unpacked | Licence. |
| VisualOn vo-aacenc (Android's old encoder) | **Apache-2.0**: the only permissive AAC-LC encoder that exists | (no browser build on npm) | Nothing to vendor: it would have to be compiled to WASM from its C source with Emscripten, which is neither on npm nor reachable here (no network beyond npm). The way forward if the owner wants AAC: build vo-aacenc to WASM once (about 200-400 KB expected), vendor it with its Apache licence and NOTICE, and call it from the fast path when `AudioEncoder` can't do `mp4a.40.2`. |
| Writing an AAC-LC encoder in JS | ours | | Thousands of lines (MDCT, psychoacoustics, Huffman tables); far past the 250-line cap and a quality risk. |

A caveat that applies to any AAC encoder, permissive or not: AAC is covered by patents pooled by Via Licensing. Many of the AAC-LC patents have expired, but this was not verified here and isn't legal advice. Browsers that encode AAC themselves (Chrome on macOS and Windows, Safari) carry that licence for us.

**So the spec's fallback applies**: where the browser has no AAC encoder the MP4 keeps Opus audio, and the Done state says so: "Audio is Opus: plays in Chrome and VLC, not in iPhone Photos or QuickTime". No file was vendored; nothing new is loaded.

## Decisions made in the range pass (export-render-range.md)

1. **Custom parsing**: `m:ss`, `m:ss.d` (any number of decimals) and plain seconds; a decimal comma reads as a point (a phone keyboard in Spanish gives `,`). Seconds over 59 after a colon, negatives, exponents, hex, `Infinity`, two colons and anything with letters are refused. The fields are plain text inputs (a numeric keypad on iOS has no `:`).
2. **Custom against the song's end**: values up to 0.05 s past the end are taken as the end (the fields show tenths, so `fmt` of the end can round up by that much); anything further is "The song ends at m:ss.s". Messages: "Type a time like 1:15 or 75", "End must be after Start", "Make it at least 0.2 s long". The field at fault gets `aria-invalid` and the error border.
3. **Custom pre-fill** happens each time the dialog opens (the spec keeps nothing between sessions): the selection, else `0:00.0` and the song's end rounded down to the tenth.
4. **Phone handles**: both always on the ruler; an unset one rests at its end, drawn dim (`--tl-label`), set ones keep the light bracket. A handle dragged to within 0.05 s of its own end is unset, so dragging both back clears the selection. A dragged handle stops 0.1 s short of the other, resting or not. The same rule applies to the desktop drag (a mark dragged to its end disappears, which is what it means anyway).
5. **Clear on the phone ruler** sits at its left end (the zoom buttons hold the right end). It's under the handles (`z-index` 1 vs 2, the zoom buttons 3): a handle that passes behind it can still be dragged, and a handle behind the zoom buttons doesn't steal their taps. Accessible name "Clear selection".
6. **Side switch at 960 px**: the project picker's floor (`--w-project-min`) is 120 px up to 1023 px instead of only below 960; at 140 the left zone outgrew its half between 960 and ~990 px. With no song loaded the switch is still off centre (40-85 px) because the song zone is full; that was so before and the bar check accepts a full zone.
