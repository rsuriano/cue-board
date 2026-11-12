# Report: selection controls (branch `selection-controls`, local only)

Commits: `16db030` check (written first: 39 failures against the old `index.html`), `6cf9e0b` code, then this report and the screenshots.
Proof: `node design/run-local.mjs design/selection-check.mjs . design/out/selection` gives 99/99.

## Criteria
| # | Result | Proving check (`design/selection-check.mjs`) |
|---|---|---|
| 1 | PASS | `1 ·`: order at 1440/1180/960; one row, no overflow, nothing clipped at 1440/1180/960/820 with no marks and with a full selection; times past 10:00 at 1440/1200/1100/1060/1024/960/900/820 |
| 2 | PASS | `2 ·`: the buttons give the same marks as I/O; Clear = Alt+X, shown only with a mark; I/O hints styled like M; 16px sprite icons, 1.5px stroke |
| 3 | PASS | `3 ·`: valid typing, Enter and blur; "1:60", "abc", past the end, Out before In, In after Out, In = Out are all refused (marks unchanged, focus kept, aria-invalid, reason given); Escape restores; clearing a field removes its mark |
| 4 | PASS | `4 ·`: key, handle drag, undo, a shorter song and its undo, project switch and back |
| 5 | PASS | `5 ·`: resting handles drawn at both ends, ≥12px hit area, ew-resize; dragging creates In/Out; the render dialog's Current selection has the same times; a handle dragged past the other stops short |
| 6 | PASS | `6 ·`: playhead, cuts and selected shot unchanged (including a mark sitting on a cut) |
| 7 | PASS | `7 ·`: desktop and phone hint texts |
| 8 | PASS | `8 ·`: after Cut, Loop shot, zoom +, Render (dialog closed again), a strip card, the speed select (closed), set In, the project button (closed) |
| 9 | PASS | `9 ·`: no toggle in the In field, shot title, notes, Render dialog, keys panel, project menu, More menu; Space on a focused button doesn't press it, Enter does; keydown on Loop with keyup on Cut presses neither; a held Space toggles once; a summary is left as it was |
| 10 | PASS | suites below |

Native select **open**: NOT VERIFIABLE HERE. Headless Chrome doesn't open the popup, so only the closed case is tested. When it's open, Chrome sends the keys to the popup, not to the page.

## Size
`index.html`: +76 / −14 lines (cap 180).

## Suites (final tree, one at a time)
syntax 4/4 · shortcuts 52/52 · topbar 53/53 · topbar-spacing 5/5 · render 103/103 · render-range 52/52 · mobile 130/130 · selection 99/99.

## Deviations
- **Copy shot list** (not in the spec) leaves the row below 1100px and appears in More instead, the way the app bar already moves actions into More. Without that, the row can't fit at 820–1060. `TASTE-GAP:` where Copy shot list goes at narrow widths. Order at full width: … Selection, spacer, Copy shot list, zoom (zoom last).
- Below 900px the row's gaps go from 16 to 12px (after the length, key hints and speed width steps, 820px with a full selection was still 8px too wide).
- Collapse steps: length below 1200, key hints and Copy shot list below 1100, speed width and gaps below 900.
- `render-range-check`: A1 now looks for set buttons only inside the dialog, and A2 expects the new hints, both as the amended spec says.
- A refused time also shows its reason in a toast (and as the field's title). The field itself gets the red error border.
- Leaving a bad field returns focus to it only while focus stays in the transport row. Clicking elsewhere (menus, other panels) restores the old value instead, so focus is never trapped.

## Open risks
- With no marks, a click within ~13px of the ruler's start or end grabs a handle instead of seeking there.
- The Space handler is document-level capture: any future control on side A that needs Space must be an input or sit in a dialog or menu.
- mobile-b touches `ioDraw`/the phone ruler: the phone drawing is kept as it was, but the same lines changed here, so expect a small merge there.
