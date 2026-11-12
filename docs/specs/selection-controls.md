# SPEC: selection controls in the transport row, visible range handles, Space always plays

Status: asked for by the owner on 2026-11-12 after trying the render build. He could not find how to mark a range: on desktop nothing is visible until `I` / `O` is pressed. Amends `export-render-range.md` (which said marks are made on the timeline only): the timeline stays the place where the range lives, and the transport row now shows and edits it.

## 1. Desktop: a Selection group in the transport row
Order in the row: Play, time, Cut, Loop shot, speed, **Selection**, then zoom (−, Fit, +) **last, at the right end**.

The Selection group is one compact control, same height and style as its neighbours:
- **In** field and **Out** field: mono tabular time text boxes (`m:ss.d`), about 7 characters wide. Empty state shows the placeholder `In` / `Out`. Typing a time (`m:ss`, `m:ss.d` or seconds, the same parser as the render dialog's Custom fields) and pressing Enter or leaving the field sets that mark; an invalid or out-of-order value is refused inline (the field keeps focus, `aria-invalid`, the old value comes back on Escape). Clearing a field removes that mark.
- A small **set-from-playhead** button attached to each field (bracket-style icons, sprite grid 16px / 1.5px stroke), with the `I` and `O` key hints shown the way `M` and `L` are on Cut and Loop shot. They do exactly what the `I` / `O` keys do.
- A **Clear** icon button at the group's end, visible only while a mark exists; same action as `Alt+X`.
- With a full selection, the group shows its length after Out in dim text (for example `28.5s`) if the row has room; drop it first when space is tight.
- The fields, the keys, the ruler handles and the render dialog all read and write the same `io` state and stay in sync, including marks arriving from undo or a project switch.
- Orange means "selected" and nothing else: the group is neutral; only the range on the ruler uses the existing range colours.
- Narrow desktop widths (820 to ~1100px): the row must not overflow or wrap badly. Collapse in this order: selection length, then key hints, then the speed select's width. Never push zoom off the row.

## 2. Desktop: handles always visible on the ruler
With no marks, two handles rest at the ruler's two ends (start and end of the song), drawn quietly, and can be dragged with the mouse to create a selection (both at the ends = no selection, as on the phone). With marks, the handles are clearly grabbable (at least a 12px hit area, a visible grip, `ew-resize` cursor). Dragging does not seek or start a shot drag.

## 3. The dialog's hint
"Current selection" disabled hint becomes: desktop `Set In and Out in the bar above the timeline, or press I and O`; phone `Drag the two handles on the timeline's ruler`.

## 4. Space always plays or pauses
On desktop, Space toggles playback wherever focus is, including on a button that was just clicked, a `summary`, a select or a menu trigger, on both sides (Cut and Takes) if playback exists there today. It must NOT fire: while typing (input, textarea, contenteditable), while a dialog or sheet is open, or inside an open menu / listbox where Space picks an item. Space on a focused button must not also "click" it (handle keydown and swallow the keyup activation). Enter still activates the focused control, so keyboard use keeps working. Never on key repeat.

## 5. Phone
No new phone UI here (the phone redesign, branch `mobile-b`, owns the ruler handles and Clear). Only the hint text of item 3. Do not touch phone layout rules.

## Out of scope
Any phone layout change · data, storage, sync or export changes (the marks stay local as today) · new shortcuts beyond these · restyling the rest of the transport row.

## Approval criteria (each = a check written first, in `design/selection-check.mjs`)
1. Row order at 1440, 1180 and 960 wide: Selection sits between speed and zoom; zoom is the last group and inside the row; no overflow or wrap at 820, 960, 1180, 1440.
2. Set-from-playhead buttons equal `I` / `O`; Clear equals `Alt+X` and shows only with a mark.
3. Typing valid times sets marks; invalid or out-of-order input is refused inline and changes nothing; clearing a field removes the mark.
4. Fields update when marks change by key, by dragging a handle, by undo and on project switch.
5. With no marks, both ruler handles are visible at the ends and dragging one creates a selection; the render dialog then enables Current selection with the same times.
6. Dragging a handle neither seeks nor moves a shot or cut.
7. Hint texts as in item 3.
8. Space toggles play after clicking: Cut, Loop shot, a zoom button, the Render button (dialog closed again), a shot in the strip; and with focus on the speed select (closed).
9. Space does not toggle while typing in the In field, the title field or shot notes; nor with a dialog open; nor with a menu open. Space on a focused button does not activate that button. Enter still does.
10. Existing suites stay green: `shortcuts-check`, `topbar-check`, `topbar-spacing-check`, `render-check`, `render-range-check`, `mobile-check`, `syntax-check`.

Size cap: ~180 lines of production code. Over the cap = stop and report.
