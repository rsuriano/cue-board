# SPEC amendment: render range and AAC audio (follow-up to export-render.md)

Status: decided by the owner on 2026-11-11 after seeing the first build. Where this file and `export-render.md` disagree, this file wins.

## 1. Range: the timeline owns the selection, the dialog only chooses
- **Remove the "Set in / Set out from playhead" buttons from the render dialog** (and any "Mark in / Mark out" buttons elsewhere). The owner does not want them.
- **The selection is made on the timeline only.** Desktop: keys `I` / `O` and dragging the two handles on the ruler, as today. Phone: the two handles are always present on the phone timeline's ruler, resting at the start and the end of the song; dragging either one creates the selection (handles resting at both ends = no selection). Grips keep a 44px touch target. Clearing: `Alt+X` on desktop; on the phone, dragging both handles back to the ends, plus a small "Clear" affordance on the ruler when a selection exists.
- **The dialog's Range has exactly three options, in this order:**
  1. **All**: the whole song.
  2. **Current selection**: the timeline's in/out. Disabled, with the hint "Mark a range on the timeline first", when there is no selection. Shows its two times read-only.
  3. **Custom**: two timestamp fields, Start and End, typed by hand. Accept `m:ss`, `m:ss.d` and plain seconds (`75`, `75.5`); show the parsed value in the app's mono tabular style. Validate on input: End after Start, both inside the song, at least 0.2 s long; an invalid field shows a short inline message and disables Render. Pre-fill with the current selection when there is one, else with 0 and the song's end. Custom does NOT move the timeline's marks.
- Default option when the dialog opens: Current selection if one exists, else All. The file name's range part reflects the chosen option's times.

## 2. AAC audio everywhere
Today, where the browser has no AAC encoder (Chrome on Linux), the MP4 gets Opus audio, which iOS Photos and QuickTime do not play. The owner works on Linux, so this is his default path.
- Produce AAC-LC audio in the MP4 on every desktop browser the fast path supports, by adding a software AAC encoder used ONLY when `AudioEncoder` cannot do AAC. Requirements: permissive license compatible with a closed-source app (MIT/BSD/Apache/ISC or public domain; no GPL/LGPL, and say plainly if the only workable option has a patent or license caveat), self-hosted, lazily loaded with the muxer (never on page load), reasonable size (say under ~1.5 MB; report the size), runs off the main thread or in chunks so the progress bar keeps moving.
- If no option meets those requirements, do NOT ship a questionable one: keep Opus, make the Done state say plainly "Audio is Opus: plays in Chrome and VLC, not in iPhone Photos or QuickTime", and report the options you rejected and why.

## 3. Small follow-up from the first pass
- The side switch is up to 16px off centre around 960px wide: fix and add that width to the bar check.

## Approval criteria (each = a check written first)
A1. The dialog has no set-in/set-out buttons; its Range group has exactly All, Current selection, Custom, in that order.
A2. Current selection is disabled with the hint when no selection exists, and enabled with the right times when one does (desktop and phone).
A3. Phone: dragging a ruler handle from its resting end creates a selection; dragging both back clears it; the Clear affordance works; grips are >= 44px.
A4. Custom parses `1:15`, `1:15.5`, `75` and `75.5` to the same instants; rejects End <= Start, values past the song's end and ranges under 0.2 s, with an inline message and Render disabled.
A5. A Custom render produces a file whose duration equals End minus Start within 0.1 s and whose first frame is the shot at Start; the timeline marks are unchanged afterwards.
A6. With `AudioEncoder` AAC support stubbed off, the produced MP4's audio track is AAC (parse the sample entry: `mp4a` with an AAC-LC object type), or, if section 2's fallback applied, the Done state shows the Opus notice.
A7. The AAC encoder file is requested only when a render starts on a browser that needs it; no third-party requests.
A8. Side switch centred within 2px at 960, 1180, 1440 and 1920.
A9. The existing suites (`design/*.mjs` one at a time, `render-check`, `render-collab-check`, `npm test`) stay green; update only assertions whose markup legitimately changed and list them.

## Out of scope
Everything out of scope in `export-render.md`, plus: frame-accurate timecode entry (frames), snapping, multiple ranges, remembering Custom values between sessions.

## Limits
Size cap: ~250 lines of production code (tests and vendored files excluded). Over the cap = stop and report.
