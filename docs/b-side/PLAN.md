# Side B (Takes): plan

> The full screenshot sets were left out of the repo to keep history small. One before/after pair is in `img/`; `design/b-side-check.mjs` regenerates the after set.

Goal: side B reads like side A. The pictures first, the controls in a panel on the side, the keyboard for the rest.
Numbers (F1…F10, W1…W8) are the frustrations and wishes in `EDITOR-NOTES.md`. Checks: `design/b-side-check.mjs`
(same item numbers). Screenshots: `before/` (main) and `after/`, at 1440x900, 1280x720, 390x844, 375x667.

## Changes

| # | Change | Answers |
|---|---|---|
| 1 | **Takes first, generator on the side.** Three columns like side A: shot list, the shot's takes, and one generator panel on the right (frames, references, prompt, settings, Generate). The panel scrolls on its own and the Generate row stays in view. Under 1280 px the generator goes below the takes. | F1 |
| 2 | **Smaller, calmer take cards.** 2 per row at 1280 and 1440, up to 4 on wider screens. One labelled button per card (Use in cut, or Play in cut); Remove from cut, Last frame → next shot, Reframe, Download and Delete are icon buttons in one row, each with its old name as tooltip and aria-label. Orange marks the take in the cut (edge and badge); "Use in cut" is a plain button. A failed take is one line with Retry. | F7, F10, failed-tile note |
| 3 | **A take plays with the song, inside side B.** Click a take: it plays from the shot's start with the song under it and stops at the shot's end; the playhead goes back where it was. Moving the pointer across a take scrubs it. A take rests on its middle frame, so takes that share a start frame look different. No native controls on a computer. | F2, F4, W3, part of F3 |
| 4 | **Keyboard, as on side A.** `[` `]` shot, `←` `→` take, Space plays the take with the song, Enter puts it in the cut, `?` opens Shortcuts (new "Side B · Takes" group). The same hint row as side A, under the takes. | F5, W4 |
| 5 | **The shot list says what is left.** Each row: "4 takes · take 4 in cut" or "nothing in cut", and a second line when something is missing: "no start frame", "1 failed". | F8, part of W5 |
| 6 | **The file name carries the take number**: `…-shot03-take4-wan-30.mp4`. | F9 |
| 7 | **Spend, credits and API status leave the shot header** and sit at the foot of the generator panel, next to what spends. The header is number, title, time and notes. | header note |
| 8 | **Phone: takes before the frames.** Header, spend line, Generate with code, takes, then frames. Native players and the short rail text stay as they were. | phone note |

## Left out, on purpose

- **Reuse a take's settings (F6, W6), the no-key note next to Generate, the Duration list, the Model select's contents.**
  They live in the generation box, model picker and settings, which `feat/fal-provider` is editing; this branch only
  moves that box. Do them after that branch merges.
- **"Play in cut" still goes to side A** (rest of F3): item 3 covers hearing a take against the song; playing across
  the neighbouring shots (W8) is a new feature, not a rearrangement.
- **Compare side by side (W1), slip a take in its slot (W2), keep/reject marks (W7), "only shots with nothing in the
  cut" (rest of W5).** New features or new data in the project file; out of scope here.
- **"Tap again" on Delete.** The owner's rule is no renamed labels; it stays.
- No change to data, storage, project format, sync, export, OpenRouter requests or side A. Every existing id and
  `data-act` is kept. New ids: `bGen`, `bAcct`, `bKeys`, `bKeysb`, `kTakes`.

## Assertions changed in the older checks

| Check | Old assertion | New assertion |
|---|---|---|
| `design/mobile-takes-check.mjs`, "strip, title row, spend row, notes and frames never overlap" | the spend row is `.bbar .statbox` (inside the shot header) | the spend row is `#bAcct .statbox` (its own line under the header); same no-overlap test, same 5 blocks |

`take-out-check`, `media-check` and `mobile-check` needed no change.
