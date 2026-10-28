# Design pass 2: spacing, rhythm, last tells

Branch `design/system`, on top of the first pass (`REPORT.md`). The owner's feedback was: "I like it. I'd fix the spacing. It still looks a bit vibecoded." Screenshots are in `design/shots/after-2/`; compare them with `before/` (main) and `after/` (pass 1).

## 1. Diagnosis (before any change)

Sources:
- `design/measure.mjs`, a new script that reads computed styles from the running page;
- the Impeccable detector;
- an Impeccable critique "Assessment A" by an isolated reviewer agent, which only saw the screenshots and the CSS;
- my own read of `design/shots/after/`.

**The values were already on the grid.** `measure.mjs` found no padding, margin or gap off the 4px scale (0 off-scale values at 1440 on side A, side B and in Settings). Pass 1 had tokenised everything. What read as "vibecoded" was how those values were used:

| # | Problem | Measured |
|---|---|---|
| 1 | **One gap for everything, so there is no grouping hierarchy.** Each stack repeats a single value: side A gives monitor, transport, timeline, strip and shortcuts the same gap. Side B's main column gives the header bar, notes, references, frames/generation and takes the same gap. The header gives every item the same gap. Groups were made with boxes and hairline separators instead of distance. | side A `#sideA` 12px; side B `.bmain` 16px; header 6px between all 12 items, with 4 hairline `.sep` in header and transport |
| 2 | **Similar panels had different insets.** | inspector 16, generation box 16, frame panels 12, empty-state panels 24, shot list 4 with rows at 6, card bodies 8/12/12, song bar 8/8/8/12, dialog 20/20/0 |
| 3 | **Controls in one row had different heights.** | transport: Play, Cut, Loop, speed 32 next to −, Fit, + and Copy shot list 28. Settings footer: Test key 28 next to Close/Save 32. Prompt chips 30 (`all:unset` reset `box-sizing`, so 28 + 2px border), off the ladder |
| 4 | **Line heights put text between pixels.** `--lh:1.5` gave 12→18, 13→19.5 and 14→21px lines, and `--lh-tight:1.2` gave 16→19.2px, so text baselines didn't sit on the 4px grid and rows came out at fractional heights. | e.g. side B list rows were 71.5px, card bodies fractional |
| 5 | **Widows in wrapping rows.** | generation settings: Seed falls alone onto line 2 at 1440, and "Generate take" sits alone under the price at 820. Take cards: "Delete" alone on line 2 of every card (4 actions in 280px). Inspector: "Upload image…" and "Delete shot" each alone on a row, with "Delete shot" floating at the bottom right |
| 6 | **Label gaps differed.** | label→field 6px in fields, but the "Video prompt" label→textarea was 12px (the panel gap). Key field→helper text in Settings was 16px, the same as between unrelated sections |
| 7 | **Words in mono.** Pass 1's rule is "numbers mono, words never", but the inspector's clip chip ("10s+: split or extend") and side B's timecode line ("· Medium shot") set words in JetBrains Mono. | `.clip`, `#bTime` |
| 8 | **Repeated information as filler.** | Shot number: up to 6 times on side A, including grey placeholder numerals in every empty thumbnail on both sides. Project name: shown twice side by side, as select and as input, both boxed. 15 boxed `kbd` keys in a 1400px-wide shortcut paragraph |
| 9 | **Unicode glyphs as icons.** | ▶, ❚❚ (play/pause), "+" (Cut, zoom in), "−" (zoom out), "→" inside "Last frame → next shot", "⇄" in the drag chip, "×" on reference thumbnails |
| 10 | **Known defects.** | Project selector at 178px with 32px reserved for the chevron, so "The Mountain King (ex" is clipped with no ellipsis and no tooltip. Timeline label for shot 01 drawn into a 46px region and clipped to "01 Th" (a hard clip rect, no measuring) |

Detector before: 4 findings.
- `[broken-image]`: the monitor's `<img id="mimg">` with no `src`.
- `[tiny-text]`: 11px text (`--text-xs`, used by 41 elements).
- `[cramped-padding]` ×2: the dialog content had 0 bottom padding, with the footer band pulled flush by negative margins.

Font sizes in use: 11/12/13/14/16/20/28. Radii in use: 3/5/7/10 (fine).

## 2. What changed (before → after, measured at 1440)

| Area | Before | After |
|---|---|---|
| Spacing model | scale tokens used directly; one gap per stack | spacing roles on top of the scale: `gap-label` 6, `gap-tight` 4, `gap-related` 8, `gap-block` 16, `gap-group` 24; insets `row` 8, `card` 12, `panel` 16, `dialog` 24 |
| Header | 52px, 6px between all items, 2 hairlines; selector 178px clipped, no tooltip | 48px (32 + 2×8), groups 16px apart with no hairlines, 4px inside groups. One row down to 1360px, where only selector (220→160) and name (140→96) shrink. Selector ellipsis + full-name `title`. Name edited in place (no box at rest) |
| Transport | 32/28 mixed, 2 hairlines, 8px everywhere | all 32. Groups (Play+timecode / Cut, Loop, speed / zoom) 24px apart, 8px inside. Zoom is a joined −/Fit/+ control. Transport and timeline form one "deck", 8px apart |
| Timeline | 18px ruler, 10px ruler text, labels hard-clipped ("01 Th") | 20px ruler + 20px label band on the 4px grid, 11px ruler, 12px labels that fit or truncate: "06 One eye…", then "13", then nothing |
| Inspector | head chip + mono word chip wrapping; Upload and Delete each alone on a row | head: number, time, Delete shot (right, optically aligned). The fit hint below in plain 12px text. Head→fields 16 |
| Side B header | notes outside the bar, pulled up with a negative margin; shot type in mono | notes inside the header block, hairline under it; shot type in Instrument Sans |
| Side B work area | frames padding 12 vs generation 16; flat 16 everywhere; hole under the frames; references above the frames | all panels 16. References under the frames (where they apply), the generation panel spans both rows, no hole |
| Generation panel | flex-wrap row: Seed widowed at 1440, Generate widowed at 820; `padding-top:20px` hack on the price | 3-column settings grid + footer (fit note left, price + Generate take right) under a hairline; label→prompt 6, prompt→presets 8, blocks 16 |
| Takes | 280px min, 4 actions wrapping ("Delete" alone) | 400px min (2-up at 1440, 3-up at 1920). One action row: cut decisions left, Download/Delete right |
| Dialogs | 20/20/0 padding + `surface-2` footer band with negative margins; Test key 28 next to 32 | 24 all round, no band, actions 32px, 24px below content. Key hint attached to its field (6px, `aria-describedby`) |
| Type | 11/12/13/14/16/20/28px; line heights 1.5/1.2 → 19.5px, 21px, 19.2px lines | 12/13/14/16/20/28px (12 is the floor); px line heights 16/20/24/28 on the 4px grid |
| Chips | 30px (`all:unset` dropped `box-sizing`) | 28px |
| Repetition | placeholder numerals in every empty thumbnail (strip and list); 15 boxed kbd keys at 1400px | empty thumbnails are plain media wells; flat keys, 72ch measure, 24px lines |
| Icons | ▶ ❚❚ + − → ⇄ × as text | one `<symbol>` sprite (play, pause, plus, minus, arrow-right, swap, x), 16px, 1.5px stroke, `currentColor`, used by `ico(name)` in the script. Play/Pause swaps the icon only when the state changes |
| Docs | CLAUDE.md deployed `index.html` + `example/` | + `fonts/` |

**Behaviour.** No feature or copy change. Every id, data attribute and handler is kept. Static markup moved:
- `#f-del` into the inspector head;
- `#bNotes` into `.bbar`;
- `#bRefs` after the frames;
- `#gFit` into the new `.genfoot`;
- `#setKey`'s hint into its field.

Wrappers added: `.tgroup`, `.deck`, `.seg`, `.gprompt`, `.genfoot`.

Script changes are markup only:
- the play button, the take buttons and the drag chip use `innerHTML` with `ico()`;
- the project select gets a `title`;
- empty thumbnails no longer print the shot number;
- `#bTime` wraps the shot type in a span;
- `renderTimeline` uses 20px bands and a new `tlLabel()` fitter.

The monitor `<img>` gets a neutral transparent SVG `src` instead of none. The script still sets the real `src`, and its `getAttribute("src")` comparison is unaffected.

## 3. Detector

| | Findings |
|---|---|
| Before | 4: `broken-image`, `tiny-text` (11px), `cramped-padding` ×2 (dialog) |
| Midway | 2: `tight-leading` "1.25x". The checker reads the empty-state blocks as 16px text (it doesn't resolve the font size from body's `font` shorthand) against their new 20px line height. In the browser they are 13/20 = 1.54; an explicit `font-size` on both fixed it |
| After | **0** (`npx impeccable@4.8.0 detect index.html`) |

## 4. Verification

`node design/shoot.mjs . design/shots/after-2`: **31/31 checks pass**. Added in this pass:
- transport controls share one height;
- every control is on the 20/28/32/36 ladder;
- the project selector carries the full name as a tooltip;
- no glyph icons left;
- Play turns into Pause and back (icon + label);
- zoom in widens the timeline and Fit restores it;
- a mouse click on the waveform moves the playhead (Playwright mouse, i.e. CDP input events);
- the Cut button adds a shot;
- no horizontal overflow at 1920, 1440, 1280, 1024, 900 and 820 on both sides.

Still passing from pass 1: example loads, selection, playback, Loop toast, Settings/Export open and close, side B list, frame panel, seeded takes, empty states, `file://` fonts. Also no console errors and no external requests (the OpenRouter model-list request is aborted by the harness).

`node design/measure.mjs .`: 0 off-scale spacing values. Per-row heights:
- header, transport and dialog footer: 32;
- frame rows: 28;
- chips: 28.

Panel insets: inspector, frames and generation box 16; cards 12; dialogs 24.

2x crops (`crop2x-toolbar`, `crop2x-transport-timeline`, `crop2x-shotlist`): icons and text sit on whole pixels, and the joined zoom edges and timeline label band are aligned.

## 5. Not verified

- Real generation (no API key, OpenRouter never called). Rendering/failed/done takes are seeded into IndexedDB, as in pass 1.
- Dragging cuts on the canvas and reordering strip cards: the swap chip's new icon was not seen live.
- Firefox and Safari: only Chromium was run. `text-overflow` on `<select>` and `:has()` in the header shrink rule are cosmetic. Without `:has()` the project group just doesn't shrink, and the header wraps earlier.
- Long project names in other languages, and browser zoom above 100%: checked only through the overflow checks.

## 6. Decisions for the owner

1. **Project selector and name field still show the same name side by side.** The name is now a quiet in-place field, but at 1440 both truncate. Merging them into one control (a selector with "Rename…" inside) would free about 150px and remove the duplication. It's a small behaviour change, so this pass didn't make it.
2. **Monitor readouts.** The monitor still shows its own timecode and "Shot 03 / 13", which repeat the transport timecode and the inspector chip. The reviewer suggested dropping them. They are kept because editors expect a program monitor to show TC. It's a one-line CSS removal if you want it quieter.

## Pass 3: owner-approved retouches

The owner approved both decisions above.

**1. One project control.** `<select id="proj">` and the `#ptitle` name field are now a single picker. The picker is a `button#proj` styled like a select, and it shows the open project's name (ellipsis, full name in `title`, `aria-label="Project: …"`). It opens `#projmenu` (`role="menu"`), which lists every project as a `menuitemradio` with the open one checked, then **Rename…**.
- **Rename** lays `#ptitle` over the picker's own box, so the header doesn't shift. Enter or blur saves (flushed to IndexedDB right away), and Escape cancels. **New** opens the rename field straight away, as the old name field used to get focus.
- **Keyboard:** ArrowDown/ArrowUp on the picker opens the menu. In the menu, the arrows wrap and Home/End jump. Escape closes the menu and focus returns to the picker. Tab or a click outside also closes it. Keys pressed inside the menu don't reach the side A shortcuts, so Space doesn't start playback.
- **Unchanged:** New, Delete (two-tap) and Example stay where they were. Freed width: the 140px name field is gone.
- **Script:** `renderProjSelect()` now fills the button. `renderProjMenu`, `openProjMenu`/`closeProjMenu` and `startRename`/`endRename` are new, and the old `onchange`/`oninput` handlers are gone. Removed tokens: `--w-title*`. Added: `--w-menu-max`, `--menu-max-h`, `--z-menu`, and an `i-check` icon.

**2. Monitor readouts removed.** `#mtc` (it repeated the transport `#tc`) and `#msec` "Shot nn / nn" (the timeline and strip show the count) are gone along with `.mbar`. I checked first: nothing shown only there was lost. The slate still shows the playhead shot's number, type and title, and during playback that is the only place the *playing* (vs selected) shot's title appears, so it stays.

DESIGN.md is updated: app bar, a new "Project picker and menu" component, and Monitor.

**Verification.** `node design/shoot.mjs . design/shots/after-3`: **48/48 checks pass**, with no console errors and no external requests (the OpenRouter model list is blocked, nothing else is called). New checks:
- no monitor TC or shot count, and the project name appears once in the header;
- the menu opens with the current project focused, ArrowDown reaches Rename…, and Space in the menu doesn't play;
- Escape closes the menu and returns focus;
- Rename selects the name, Enter saves and the name persists after reload, Escape cancels, and blur saves;
- New starts a rename, the menu lists both projects, and choosing one with the keyboard switches to it;
- Delete removes the open project;
- with no projects, the picker says so and is disabled, and Example loads from that state.

All earlier checks still pass, including no overflow from 1920 to 820 on both sides.

`npx impeccable@4.8.0 detect index.html`: **0 findings**. The bundled `.claude/…/impeccable` binary needed a permission I didn't have here, so the npx build used in pass 2 was run instead.

Shots (1440×900) are in `after-3/`:
- `hdr-1-closed`, `hdr-2-menu-open`, `hdr-3-renaming`;
- `01-sideA-shot-selected`, `09-sideB-takes`;
- plus the full set.

**Not verified:** screen-reader announcement of the menu (only roles/ARIA were checked, no AT run), Firefox/Safari, and very long project lists (the menu scrolls at `min(420px, 60vh)`, but this wasn't exercised).
