---
version: alpha
name: Cue Board
description: An edit suite for AI music videos. Dark, quiet, precise; one orange.
colors:
  # neutrals: warm-tinted ramp (hue ~30°, chroma kept very low), darkest to lightest
  screen: "#0a0a09"          # monitor, thumbnails, media wells
  inset: "#0f0e0d"           # text inputs, selects, segmented-control track
  bg: "#121110"              # app background
  surface-1: "#191817"       # panels, cards, list, header, dialogs
  surface-2: "#211f1e"       # secondary buttons, ruler, dialog footer
  surface-3: "#2a2826"       # hover, selected tab, toast
  border-subtle: "#262422"   # dividers inside a panel
  border: "#33302d"          # panel and card edges
  border-strong: "#47433f"   # button edges, dialog edge
  border-control: "#6e6a63"  # input edges (>= 3:1 against surface-1 and inset)
  ink: "#edebe7"             # primary text
  ink-2: "#aeaaa3"           # secondary text, labels
  ink-3: "#8f8b84"           # tertiary text, placeholders, timecodes
  ink-4: "#5f5b56"           # disabled, decorative placeholders only (not for text that must be read)
  accent: "#f0a33a"          # THE orange: selection, playhead, primary action, focus
  accent-hover: "#f6b35a"
  accent-press: "#de9029"
  accent-ink: "#1a1206"      # text on accent
  accent-subtle: "rgba(240,163,58,.12)"   # selected row, pressed toggle, shot-number chip
  accent-border: "rgba(240,163,58,.5)"
  ok: "#7cc79a"
  ok-subtle: "rgba(124,199,154,.14)"
  ok-ink: "#0d2016"
  warn: "#e6c15c"
  error: "#f08a76"
  error-subtle: "rgba(240,138,118,.12)"
  scrim: "rgba(0,0,0,.72)"   # caption legibility over media (functional, not decoration)
  backdrop: "rgba(5,5,4,.66)"
  on-media: "rgba(10,10,9,.72)"
  # timeline canvas (literal values; the script reads them by name)
  tl-ruler: "#211f1e"
  tl-tick: "#47433f"
  tl-label: "#8f8b84"
  tl-region-a: "#151413"
  tl-region-b: "#1a1918"
  tl-region-sel: "#2f261b"
  tl-text: "#c9c5be"
  tl-text-sel: "#f0a33a"
  tl-cut: "#8f8b84"
  tl-wave: "#858179"
typography:
  families:
    ui: "Instrument Sans (variable 400–700), self-hosted, fallback system-ui"
    mono: "JetBrains Mono (variable 400–600), self-hosted; numbers, time, price, kbd only"
  scale:
    sm:   { size: 12px, use: "field labels, secondary text, meta, badges, kbd, small buttons, status (the floor: nothing smaller)" }
    md:   { size: 13px, use: "body and controls (the base size of the app)" }
    lg:   { size: 14px, use: "readouts (price, spend), slate notes" }
    xl:   { size: 16px, use: "dialog titles, main timecode, caption title" }
    2xl:  { size: 20px, use: "side B shot title, slate title minimum" }
    3xl:  { size: 28px, use: "slate title maximum (clamped between 2xl and 3xl)" }
  line-height: { sm: 16px (12px text), md: 20px (13-14px), xl: 24px (16px), 2xl: 28px (20px), 3xl: 32px, control: 1 (fixed-height controls) }
  line-height-note: "pixel values so every line box lands on the 4px grid; the slate title alone uses 1.15"
  weights: { regular: 400, medium: 500, semibold: 600 }
  tracking: { tight: "-0.01em (titles)", caps: "0.06em (reserved; no uppercase labels in use)" }
  numerals: "font-variant-numeric: tabular-nums on every time, duration, count and price"
spacing:
  base: 4px
  scale: { px: 1px, 0-5: 2px, 1: 4px, 1-5: 6px, 2: 8px, 3: 12px, 4: 16px, 5: 20px, 6: 24px, 8: 32px, 10: 40px }
  note: "0-5 and 1-5 are half steps for dense internals (badge padding, list gaps) only"
  roles:
    gap-label: 6px     # label to its field, field to its hint
    gap-tight: 4px     # controls that act as one (header actions, zoom set)
    gap-related: 8px   # items in one group (button rows, transport groups, strip cards)
    gap-group: 24px    # between groups in a toolbar (16px in the header and under 1180px)
    gap-block: 16px    # between blocks in a panel, between panels, between take cards
    inset-row: 8px     # list rows, bars
    inset-card: 12px   # card bodies (strip, takes)
    inset-panel: 16px  # inspector, frames, generation box, empty states
    inset-dialog: 24px # dialogs
rounded:
  xs: 3px    # badges, kbd, chips inside tracks, thumbnails in rows
  sm: 5px    # controls: buttons, inputs, selects, chips, list rows
  md: 7px    # panels, cards, monitor, timeline
  lg: 10px   # dialogs
  round: 50% # status dots, spinner
controls:
  height: { xs: 20px (kbd, number chips, badges), sm: 28px (actions inside panels and cards, prompt chips, tabs), md: 32px (toolbars, form fields, dialog actions), lg: 36px (reserved) }
  row-rule: "one height per row: a toolbar is all 32, a panel's action row is all 28"
  hit-target: 32px  # 28px controls extend their hit area to 32px with an invisible ::after
elevation:
  rule: "Borders and surface steps first. Shadows only on things that float above the page."
  float: "0 12px 32px rgba(0,0,0,.5)   # toast, drag ghost"
  overlay: "0 24px 64px rgba(0,0,0,.55) # dialogs"
motion:
  fast: 150ms    # hover, press, color and border changes
  base: 200ms    # toast and dialog entrance
  easing: "cubic-bezier(.2,.8,.2,1) (ease-out)"
  reduced: "All transitions and animations sit inside @media (prefers-reduced-motion: no-preference)"
layout:
  gutter: 20px (16px under 1180px)
  header: "48px app bar (32px controls + 8px), full bleed, hairline bottom; one row down to 1360px"
  inspector: "clamp(320px, 26vw, 400px)"
  shot-list: 248px (220px under 1180px)
  stage-height: "max(280px, 100vh - 400px): monitor and inspector share one row; the inspector scrolls inside"
  breakpoints: { wide: ">= 1280px (side B splits frames | generation)", compact: "<= 1180px", stacked: "<= 900px", narrow: "<= 620px" }
  app-max: 1920px
---

# Cue Board design system

## Overview

**The surface, in one line:** an edit suite — you *operate* on shots against a timeline (side A), and *configure* generation per shot (side B). It is not a landing page: no hero, no feature cards, no centered stacks.

The register is a professional tool in the Adobe sense (dense, calm, consistent, everything has a state) without borrowing Adobe's look. Minimal is the trademark: one dark theme, one typeface for words, one for numbers, one accent colour. Everything else is neutral and steps back so the user's frames and the song's waveform are what you look at.

Rules that shape every screen:

1. **The orange means something.** It marks only: the selected shot (timeline region, card, list row, shot-number chip), the playhead, the one primary action of a view, toggles that are on, and keyboard focus. Cut markers, prices and links are neutral.
2. **Panels, not cards on a page.** Surfaces sit on `bg` with a hairline `border`; inner divisions use `border-subtle`. No shadows on things that don't float.
3. **Numbers are mono and tabular.** Timecodes, durations, counts and prices use JetBrains Mono with `tabular-nums`, so readouts don't jitter while playing. Words never use mono.
4. **Every interactive thing has five states**: rest, hover, active (pressed), focus-visible (2px orange ring) and disabled (40% opacity, no hover). Selected states are listed per component.

## Colors

Neutrals carry a very slight warm tint (about 30°, so they sit well next to the orange and next to film stills, which skew warm). The old palette was a cool violet-grey; the change is subtle but removes the "default dark theme" feel.

The accent stays `#f0a33a`, the existing Cue Board orange, unchanged. Hover lightens (`#f6b35a`), press darkens (`#de9029`). On tinted backgrounds (`accent-subtle`), orange text keeps 6.8:1 or better.

Contrast (WCAG 2.x, measured):

| Pair | Ratio |
|---|---|
| ink on surface-1 | 14.9:1 |
| ink-2 on surface-1 | 7.7:1 |
| ink-3 on surface-1 / surface-2 / inset | 5.2 / 4.8 / 5.7:1 |
| accent on surface-1 | 8.5:1 |
| accent-ink on accent | 8.8:1 |
| error on surface-1 | 7.3:1 |
| border-control vs surface-1 / inset (input edges) | 3.3 / 3.6:1 |

`ink-3` is never used on `surface-3` (4.3:1). `ink-4` is only for disabled things and placeholder numerals that carry no information.

Semantic colours are used for state only: `ok` = a take is in the cut, saved; `error` = failures, destructive hover, "too short"; `warn` is reserved.

## Typography

**Two families plus mono, as briefed:** Instrument Sans for everything you read, JetBrains Mono for numbers.

**Big Shoulders Display is dropped.** It was used for the brand, the slate, shot numbers, dialog titles and side B's title, all uppercase. Condensed display caps on every heading are the clearest "generated UI" tell, and they fight a dense tool UI: they shout where a tool should be quiet. The slate now reads like a title card (small orange number, shot type, then the title in Instrument Sans semibold), which is closer to what an editor actually sees.

**Self-hosted, no third parties.** The previous build loaded all three families from Google Fonts, i.e. every visitor's IP went to Google on page load, contradicting the product's "nothing leaves your browser except OpenRouter calls" promise. The two remaining families now live in `fonts/` as Latin and Latin-Extended woff2 subsets (about 84 KB total, latin-ext only downloads when a character needs it), with their OFL licences next to them. They load from `file://` too (verified), so double-clicking `index.html` still works. If `fonts/` is missing, the stacks fall back to `system-ui` and `ui-monospace` without breaking layout.

Base size is 13px (body and controls), which is the density of pro tools; inputs and text areas use the same size. Uppercase is not used for labels anywhere.

## Layout

- **App bar**: full-bleed 48px header on `surface-1`. Groups, separated by 16px of space and no rules: brand, side switch, project (picker, New, Delete) … song actions, file actions (Example, Import, Export, Settings, and in a room the media status indicator), save status. Presence (collaborators' initials) sits after the project picker. Inside a group, ghost actions sit 4px apart (their 8px padding makes the visual gap). It stays on one row down to 1360px: only the project picker (220→160px) gives up width. The picker is the only place the project name appears: it truncates with an ellipsis and shows the full name as a tooltip. Below 1360px whole groups wrap.
- **Side A**: monitor + inspector share one row whose height is `max(280px, 100vh − 400px)`, so the transport and timeline stay above the fold at 1440×900. The monitor is a viewer: media is letterboxed (`object-fit: contain`), never cropped. The inspector scrolls inside when prompts are open. Then the deck (transport 8px above the timeline, the two read as one unit), the storyboard strip, and the keyboard reference last at reading measure. Spacing between sections is 12px, inside the deck 8px, and the keys sit 24px below the strip.
- **Grouping by distance.** Within a group 4–8px, between groups 16–24px, between sections 12–24px. No hairline separators in toolbars. Hairlines are only used inside panels, for a header or footer (inspector head, prompts, side B header, generation footer).
- **Side B**: shot list (248px, sticky) and a main column. The header block (number, title, timecode, spend, notes) ends with a hairline. At ≥1280px the work area splits: frames with the references row under them on the left, the generation panel on the right spanning both. Takes follow underneath, 2-up at 1440 (`--take-min: 400px`) so each card's actions fit on one line. Frames, prompt, price and the Generate button are all visible together.
- **Down to 820px**: inspector and shot list stack under the monitor / above the main column; the shot list becomes a horizontal rail. Nothing overflows horizontally (verified at 1920, 1440, 1024 and 820).

## Elevation & depth

Depth is made with surface steps (`bg` → `surface-1` → `surface-2` → `surface-3`) and hairlines. Only three things cast shadows: dialogs (`overlay`), the toast and the drag ghost (`float`). No glow rings: selection is a 1px accent border plus a 1px inset ring (2px total, no layout shift).

## Shapes

Small and consistent: 3px for badges and kbd, 5px for controls, 7px for panels, 10px for dialogs. No pills: the side switch and the prompt chips used 999px radii, now they follow the control radius like everything else.

## Components

**Button.** 32px (default) or 28px (`.small`, with a 32px hit area). Font 13/12px medium. Small ghost buttons use 8px side padding, the others 12px. `.icon` is a 32px square for icon-only buttons (zoom). `.seg` joins buttons that act as one control (−, Fit, +), with shared 1px edges and outer corners rounded.
- *Primary*: accent fill, `accent-ink` text, semibold. One per view: **Play** on side A (with a song), **Load song** when there is no song, **Generate take** on side B, the confirm button in a dialog, and **Generate** inside an open frame panel. When a song is loaded, "Replace song" drops to secondary, and so does "Load song" while side B is showing (CSS `:has`, no script change).
- *Secondary*: `surface-2` fill, `border-strong` edge; hover `surface-3` + `border-control`; press `surface-1`.
- *Ghost*: no fill, `ink-2`; hover gets the secondary look. Used for app-bar actions and per-item actions.
- *Destructive*: ghost at rest (the two-tap confirm lives in the label); hover turns `error` on `error-subtle`. Applies to Delete project, Remove song, Delete shot, Delete/Forget take.
- *Toggle* (`aria-pressed="true"`): `accent-subtle` fill, `accent-border`, accent text. Loop shot, frame Generate / From start.
- *Disabled*: 40% opacity, no hover change, `not-allowed` cursor.
- *In a take card*, "Use in cut" is a tinted secondary (accent text on `accent-subtle`) so a grid of takes doesn't become a wall of orange buttons; it fills orange on hover.

**Input, textarea, select.** `inset` fill, `border-control` edge, 5px radius, 32px tall; hover lightens the edge to `ink-3`; focus sets an accent edge plus a 1px accent ring. Selects use a custom chevron drawn with two gradients so the colour comes from tokens (no SVG with baked-in hex). Checkboxes use `accent-color`.

**Segmented control** (side switch). An `inset` track with a hairline; 28px segments; selected = `surface-3` + `border-strong` ring + `ink`. It is navigation, not selection of content, so it stays neutral.

**Panel.** `surface-1`, 1px `border`, 7px radius, 16px padding everywhere (inspector, frames, generation box, empty states). Cards use 12px, list rows 4–8px, dialogs 24px. Inner sections are separated by `border-subtle` rules, not boxes in boxes.

**Inspector head.** Number chip, time range (mono), then Delete shot (small ghost) pushed right and optically aligned to the edge. The fit hint ("11.7 s · 10s+: split or extend") sits on the line below in plain 12px `ink-3` text, not in a mono chip.

**Generation panel.** Prompt label 6px above the textarea, presets 8px below it, then the settings grid (3 equal columns: Model, Resolution, Duration / Takes, Seed, Audio), then a footer under a hairline with the fit note on the left and price + Generate take on the right. Nothing in it wraps into a widow.

**Take card.** Media, then 12px body: meta (model · res · duration, price right), the prompt, and one action row. Cut decisions (Use in cut / Play in cut, Last frame → next shot) go on the left, file actions (Download, Delete) on the right.

**List row** (side B shots). Transparent at rest, `surface-2` on hover, selected = `accent-subtle` + `accent-border`, the timecode turns orange. 72px 16:9 thumbnail.

**Card** (storyboard strip, takes). `surface-1`, media on top on `screen`, 12px body. Empty thumbnails are plain `screen` blocks with no placeholder numerals, since the number is already in the meta line. Strip card selected = accent border + inset ring and its duration turns orange. Take in the cut = `ok` border and an `ok` badge.

**Timeline.** 132px canvas on the 4px grid: 20px ruler, 20px label band, waveform below. Shot labels (12px semibold) fit their region: the full "03  The gate", then the title cut with an ellipsis (at least 2 letters), then the number alone, then nothing. Ruler on `tl-ruler` with `tl-tick` ticks and mono labels; shot regions alternate `tl-region-a`/`b`; the selected shot gets the warm `tl-region-sel` tint and an orange label. Cut markers are neutral (`tl-cut`) lines with a draggable triangle at the ruler edge, so they no longer compete with selection. The playhead is the only orange line: 2px with a 12px cap in the ruler.

**Project picker and menu.** A button styled like a select (same fill, edge, chevron and 32px height) that shows the open project's name. It opens a menu (`role="menu"`, `surface-2`, `border-strong`, 7px radius, float shadow, 4px inset) right under it, at least as wide as the picker and at most 360px. Items are 28px rows: every project as a `menuitemradio` (the open one in `ink` with a check, the others `ink-2`), then a hairline and **Rename…**. Hover and keyboard focus use `surface-3`, and keyboard focus adds the 2px orange ring inside the row. Arrow keys, Home and End move through the items, Escape closes the menu and puts focus back on the picker, and Tab or a click outside closes it. Rename… lays a 32px field over the picker's own box (so the header doesn't move) with the name selected: Enter or leaving the field saves, Escape cancels. New opens the field straight away. New and Delete stay ghost buttons next to the picker.

**Icon button with progress ring** (media status indicator). A 32px ghost icon button (the `tray` icon, `ink-2`) at the end of the file actions, right after Settings, shown only while the project is in a room. Quiet when every file is here. While files arrive, a thin ring (1.5px, `ink-2` arc on a `border-strong` track, 2px inside the button) fills with the bytes received; before any byte it shows a quarter arc that turns (still with reduced motion). When something isn't here, a 6px dot at the top-right corner: hollow (`ink-2` hairline) for "not here, nothing wrong" (offline, nobody online has it, skipped, paused, too large to relay, storage busy, a file not shared), filled `error` for "something went wrong" (can't reach the room, couldn't be verified, storage full). Never orange. It always shows the worst state; its words are the button's accessible name and appear in a small `surface-3` label under it on hover and keyboard focus (the one exception to native tooltips, so keyboard users get it too). While it's shown, the header's "Saved locally" status hides unless it reports an error.

**Dropdown panel** (files). Non-modal, anchored under the indicator with right edges aligned (moved left only if it would leave the screen), 400px wide, at most the viewport's height below the button; it scrolls inside, and its file list scrolls on its own past `min(360px, 40vh)`. `surface-2`, `border-strong`, 7px radius, float shadow, 16px inset, rises 4px like the toast. Top: the state in one 13/20 semibold line (`error` when something went wrong) and one 12px `ink-3` line saying why. Then an optional warning (storage may be cleared, low on space, another invite link), the list, and a footer under a hairline: the two auto-download limits side by side, Pause (ghost) and Download all now (secondary, not primary: the panel sits beside the view's real primary action), and the privacy note. List rows: name (13px `ink`, ellipsis, full name as a tooltip) and size (mono, "13.2 MB of 31.5 MB" while it arrives); under them the state and who else has it (12px `ink-3`; "Nobody online has it" with the hollow dot; "Couldn't be verified" in `error`), a small ghost Retry or Download on the right, and a 2px `ink-2` progress line while it downloads. Rows are separated by `border-subtle` hairlines. Keyboard: Enter, Space or ↓ on the indicator opens it with focus on the first file (a click opens it with focus on the panel itself, so no ring shows), ↑/↓ and Home/End move through files and buttons, Tab reaches the limits, Escape closes it and puts focus back on the indicator, a click outside closes it. It stays open while work goes on around it and updates live without moving focus. It closes when the project changes or leaves the room.

**Missing-file placeholder.** A file a collaborator has and this device doesn't (a shot's frame or clip, the monitor, a start/end frame slot, a take, a reference image, the song) keeps its place with a quiet 12px `ink-3` line: "Arriving · 42%" with a 120px 2px `ink-2` progress line under it, "Waiting its turn", "Paused · 42%", "Nobody online has it" (hollow dot), "Over the size limit" with a small secondary **Download**, "Couldn't be verified" with **Retry**, "Needs a direct connection", or "Not on this device yet" outside a room. Inside a strip card (itself a button) there's no action: the monitor, side B and the panel carry it. A reference (100px) shows one line under its remove button, or just the action. The song's state sits in the song bar. Nothing is added for files that are here.

**Monitor.** `screen` black with a 2px progress line for the current shot in orange. The monitor doesn't repeat the timecode (it's in the transport) or a shot count (the timeline and strip show it). The slate keeps the playhead shot's number, type and title. Over media, the caption uses a bottom scrim (`scrim`), which is a legibility device, not decoration.

**Modal.** `surface-1`, `border-strong`, 10px radius, overlay shadow, backdrop `backdrop`. 24px inset on all sides, 16px between blocks. Title 16/24 semibold. A field's hint sits 6px under it, linked with `aria-describedby`. Actions are 32px, right-aligned, primary last, 24px below the content. There is no footer band.

**Toast.** Bottom centre, `surface-3`, `border-strong`, float shadow, 13px medium; rises 4px in 200ms (no motion with reduced motion).

**Empty state.** A panel (or, for the takes grid, a dashed landing zone) with the existing copy at reading measure (72ch), `ink-2`, and the one action as an underlined link. Covered: no project (side A inspector), no song (timeline), no shots (side B), no takes, no references, empty frame slots.

**Progress.** The take spinner is a 16px ring, `border-strong` with an accent arc; status text is "Queued / Rendering / Downloading" in `ink-2` with a mono elapsed timer. Failures use `error` text.

**Tooltip.** Native `title` attributes (no custom tooltip layer, to keep the single file small). The media status indicator's label is the one exception (above).

**Kbd hint.** 20px tall, mono 12px, `surface-2` with a hairline edge. Inside buttons (Cut **M**, Loop **L**) it drops to a quiet outline in `ink-3`. In the shortcut reference below the strip, keys are flat (`surface-2` fill, no edge) on 24px lines at reading measure, so the paragraph reads as text and not as a wall of keycaps.

**Icons.** One inline `<symbol>` sprite at the top of `<body>`: play, pause, plus, minus, arrow-right, swap, check, tray, x. 16×16 viewBox, 1.5px stroke, round caps and joins, `currentColor`, no fills. The script uses them through `ico(name)`. No icon font, no library, no unicode glyphs as icons.

**Badge.** 12px semibold, 20px tall, on `on-media` over thumbnails ("take 4", "clip"); `ok` fill for "in cut".

## Do's and Don'ts

- Do use the orange for one meaning per view. If two oranges compete, one of them is wrong.
- Do use tokens for every value. The canvas reads the `--tl-*` tokens by name, so keep those literal hex values.
- Do keep numbers in mono with tabular figures; keep words in Instrument Sans.
- Don't add uppercase tracked labels, condensed display type, gradients for decoration, glass, glows, or icons above headings.
- Don't add a second accent colour. Semantic green/red are for state only.
- Don't add shadows to panels. If a panel needs to stand out, it probably needs a better border or more space.

## Audit

Slop diagnostic, ten tells, one point each (lower is better). The `claude-design` skill was not available in this environment, so the tells are applied as listed here. Pass 2 adds tell 11 (rhythm) and was checked with the Impeccable skill (detector, critique, layout).

| # | Tell | Before | Pass 1 | Pass 2 |
|---|---|---|---|---|
| 1 | Display/condensed type used as decoration (uppercase headlines, giant numerals) | 1 | 0 | 0 |
| 2 | Uppercase, letter-spaced mono labels as "tech" garnish (tabs, status, badges, busy states) | 1 | 0 | 0 |
| 3 | Accent everywhere (tabs, every cut marker, every duration, links, prices, three primaries per view) | 1 | 0 | 0 |
| 4 | Ghost placeholder numerals as decoration (120px "03" on the slate, 34px in every card) | 1 | 0 | 0 |
| 5 | Decorative gradients, glows, glass | 0 | 0 | 0 |
| 6 | Ad-hoc values (12.5/13.5px type, 3/4/5/6/8/10px radii, one-off spacing) instead of a scale | 1 | 0 | 0 |
| 7 | Mixed shape language (999px pills next to 6px rectangles) | 1 | 0 | 0 |
| 8 | Flat action hierarchy (every action a bordered button; several orange primaries at once) | 1 | 0 | 0 |
| 9 | Dashed borders as default styling (song bar, empty states, every frame) | 1 | 0 | 0 |
| 10 | Unfinished defaults: CDN fonts, native selects and disclosure triangles, unicode glyphs as icons | 1 | 1 | 0 |
| 11 | Rhythm (pass 2): one gap for everything, boxes and separators instead of distance, mixed control heights in a row, widowed controls, off-grid line heights | – | 1 | 0 |
| | **Score** | **9/10** | **2/11** | **0/11** |

Pass 1 left tell 10 at 1 (unicode glyphs ▶ ❚❚ → ⇄ × as icons), and tell 11 was the owner's "still looks vibecoded". Pass 2 replaced the glyphs with the SVG sprite. It also rebuilt the rhythm: a spacing-role layer on top of the 4px scale, one control height per row, pixel line heights on the 4px grid, and groups made by distance (see `design/REPORT-2.md`). Measured with `design/measure.mjs`: no off-scale spacing and no off-ladder control. The Impeccable detector reports 0 findings. Still native (on purpose): the video controls inside take cards, and the `<select>` option lists.
