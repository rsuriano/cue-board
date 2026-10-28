# Design pass: report

Branch `design/system`. System and rationale: [`DESIGN.md`](../DESIGN.md). Screenshots: `design/shots/before/` (from `main`) and `design/shots/after/`, same names, 1440×900 unless the name says otherwise (`w1920-`, `w1280-`, `w1024-`, `w820-`).

## What changed

- **Tokens.** One `:root` block: warm-tinted neutral ramp, the existing `#f0a33a` orange (unchanged) with hover/press/subtle/border states, semantic ok/warn/error, a 7-step type scale, 4px spacing, 4 radii, 28/32/36 control heights, motion, elevation. The CSS takes all its values from these tokens. The only literals are the media-query breakpoints (CSS can't put variables in them) and the token overrides inside those queries.
- **Type.** Big Shoulders Display is gone (it was on the brand, the slate, shot numbers and every heading, all uppercase). Instrument Sans for words, JetBrains Mono only for time, durations and prices, with tabular figures. Both are self-hosted in `fonts/` with their OFL licences; the Google Fonts CDN link is removed, so the page makes no third-party request on load.
- **Orange only where it means something:** selected shot (timeline region, card, list row, number chip), playhead, the single primary action of each view, toggles that are on, and focus. Cut markers, durations, prices and links are now neutral.
- **Layout.** A full-bleed app bar with grouped actions. Side A: monitor and inspector share a row sized to the viewport, so transport and timeline stay above the fold at 1440×900. The monitor letterboxes media instead of cropping it. The inspector scrolls inside. The shortcut reference moves below the strip. Side B (≥1280px): frames on the left, generation settings on the right, takes underneath.
- **States.** Every control has hover, pressed, focus-visible, disabled and (where it applies) selected states. Destructive actions turn red on hover. 28px controls get a 32px hit area. Motion is 150–200ms ease-out and only runs when reduced motion is off.
- **Timeline.** Neutral cut markers, a warm tint on the selected shot, and a 2px orange playhead with a cap in the ruler.

## Behaviour safety

Element ids, script-used classes, data attributes and handlers are unchanged. Markup changes: header separators, header actions switched from `btn small ghost` to `btn ghost`, "New" now ghost, the inline gap styles on `#sideA`/`#ed-body` moved to CSS, and the shortcut `<p class="keys">` moved below the strip. The only script change: the timeline canvas reads `--tl-*` tokens instead of the old colour names (`renderTimeline` and the `T` list). `git diff main --stat` covers only `index.html`, `DESIGN.md`, `design/` and `fonts/`.

## Verification (`node design/shoot.mjs . design/shots/after`)

Headless Chromium from `/home/ramiro/testkit`. Every request outside the local server is aborted, so OpenRouter is never reached. 18/18 checks pass:

- example loads on first visit (13 cards); clicking a card selects it and fills the inspector
- the animatic plays (timecode advances), Loop toggles (toast shot), Settings and Export dialogs open and close
- side B lists the shots; the frame-generation panel opens; 4 seeded takes (rendering, failed, done, in cut) render
- the no-project empty states show on both sides
- no horizontal overflow at 1920, 1440, 1280, 1024 and 820px, on either side
- opened as `file://` (double-click), both local fonts load
- no console errors apart from the app's own expected probes (`api/health` 404 without `server.mjs`, and the aborted OpenRouter catalog request); no other external requests

## Not verified

- Real generation flows (Queued → Rendering → Downloading with a live key, frame variants coming back, credits readout): a Rendering card and a Failed card were seeded straight into IndexedDB, so those states were checked visually, but no request ever reached OpenRouter.
- Drag interactions (moving cuts on the canvas, reordering strip cards): the drag styles are restyled but weren't driven in this run.
- Firefox and Safari: only Chromium was run. `:has()` is used for two cosmetic rules and the empty shot list; older browsers just keep the default look.
- Contrast was computed from the token values, not measured with an a11y scanner.

## Open decisions for the owner

1. **Deploying `fonts/`.** CLAUDE.md says only `index.html` and `example/` go to hephaestus. The hosted copy needs `fonts/` too, or it falls back to system fonts (it still works, it just looks less refined). The deploy steps should add `fonts/`; this pass doesn't touch CLAUDE.md.
2. **Unicode glyphs as icons** (▶ Play, ❚❚ Pause, →, ⇄) come from the script's strings. Inline SVG icons would finish the look (the last point in the slop audit), but it means changing script-generated markup.
3. **Side tabs stay neutral** (not orange), so the orange keeps one meaning (selected content). If you'd rather the active side be orange, it's a one-token change.

## Copy suggestions (not applied)

- *Suggestion:* "Tap again to delete" reads as touch-first on a desktop tool; "Click again to delete" or "Confirm delete" may fit better.
