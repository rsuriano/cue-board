# Side B (Takes): notes from an editor

> The full screenshot sets were left out of the repo to keep history small. One before/after pair is in `img/`; `design/b-side-check.mjs` regenerates the after set.

I cut music videos and short films in Resolve and Premiere. I took Cue Board's side B for a working session: an 8-shot cut of the Mountain King (40 s), 1 to 4 takes per shot, start frames on most shots, an end frame on shot 3, one take already in the cut, one failed take, two shots with nothing yet. I went shot to shot, set a start frame, wrote a prompt, picked a model and duration, compared takes, put one in the cut, played it in the cut, reframed, downloaded, deleted, and went back and forth to side A. I did this at 1440x900 and 1280x720, and the main path once at 390x844 (phone).

I couldn't generate real takes (no key). Everything else is what the app really did. Screenshots: `docs/b-side/editor-shots/` (`d1440-*`, `d1280-*`, `p390-*`). Measurements from the run (positions, sizes, labels, file names): `docs/b-side/walk-log.json`.

Short version: side A feels like an editor, side B feels like a form. On side A the picture is big and on top, the controls sit on the side, and the keyboard does the rest. On side B the generator owns the screen, and the takes, which are what I came to judge, start below it.

---

## Top 10 frustrations (worst first)

### 1. The takes are below the fold, and the generator takes the whole first screen
- **What I tried:** open shot 3 (4 takes) to choose one.
- **What happened:** at 1440x900 the take grid starts at y=685, so I see the top 215 px of two tiles. At 1280x720 it starts at y=719: **not one take on screen**. Shot 3 is 1613 px tall at 1440. Changing shots from the list keeps the scroll position, so once I'm down at the takes I can stay there. But that means the start frame, prompt and Generate are off screen, so every "look at the takes, then fix the prompt" goes up 700 px and back down. The left column also has a dead area under the frames (x 284-895, y 514-685) with only the "Add reference images" link in it.
- **Why it hurts:** choosing takes is 80% of my time here, generating is 20%. The layout has it the other way round. Results and inputs never fit on one screen together, so I'm always scrolling between them.
- **Screenshots:** `d1440-02-sideB-first-shot.png`, `d1280-02-sideB-first-shot.png`, `d1280-08-shot3-four-takes-top.png`, `d1440-09b-shot3-full.png`
- **Smallest fix:** put the takes first. When a shot has takes, show the take grid directly under the shot header, and move the frames and generator below it (or keep the generator in the right column and scroll the takes on the left). Shots with no takes keep today's order.

### 2. I can't hear a take against the song on side B
- **What I tried:** play two takes of shot 3 to see which one moves with the music.
- **What happened:** the tiles play muted and loop, with no song. The only way to hear the music under a take is "Play in cut", which leaves side B (see 3).
- **Why it hurts:** this is a music video tool. "Does the push-in land on the hit" is the question for every take, and side B can't answer it. I'm judging motion with no music.
- **Screenshots:** `d1440-09-shot3-takes-scrolled.png` (native players, muted)
- **Smallest fix:** clicking play on a take also plays the song from the shot's start time and stops at the shot's end. The song is already loaded for side A.

### 3. "Play in cut" throws me out of side B and I lose my place
- **What I tried:** "Use in cut" on take 3 of shot 3, then "Play in cut".
- **What happened:** the app jumps to side A and plays from 0:11.0. It doesn't stop at the end of the shot (it went on into shot 4). I pressed Space, clicked "Side B · Takes", and landed at the **top** of shot 3 (scrollY 0), with the takes 630-700 px below. That's 3 actions and a scroll to get back to the tile I was on. On the phone it drops me on the Cut tab's timeline with nothing pointing back.
- **Why it hurts:** I check a take in context 3 or 4 times per shot. Each round trip resets me.
- **Screenshots:** `d1440-11-play-in-cut-sideA.png`, `d1440-12-back-to-B.png`, `d1280-12-back-to-B.png`, `p390-07-play-in-cut.png`
- **Smallest fix:** keep side B's scroll position when coming back, and have "Play in cut" stop at the end of the shot (or loop it, like "Loop shot" on side A). Better still, see wish 8.

### 4. Every take looks the same until I play it
- **What I tried:** look at the 4 tiles of shot 3 and pick the two worth watching.
- **What happened:** the poster frame is 0.1 s in, and every take starts on the same start frame (that's the point of image-to-video). Takes 4, 3 and 2 are the same picture. Only take 1, which drifted, looks different.
- **Why it hurts:** the grid tells me nothing. I have to play all of them to tell them apart, so 4 takes cost 4 full plays before I can choose.
- **Screenshots:** `d1440-09b-shot3-full.png`, `d1440-10-shot3-use-in-cut.png`
- **Smallest fix:** use the middle (or last) frame of the take as its poster, not 0.1 s. Even better, scrub the take on mouse hover (wish 3).

### 5. Side B has no keyboard at all
- **What I tried:** the keys that work on side A: `]`, `[`, the arrow keys, `j`, Space, `?`.
- **What happened:** nothing. The selected shot stayed on 01, Space didn't play anything, and `?` didn't open the shortcuts (the shortcut handlers check that side A is showing). The footer hint row on side A ("Space play · M cut · L loop · ← → step · ? All shortcuts") isn't on side B.
- **Why it hurts:** going through 8 shots × 3 takes with the mouse means aiming at a 238x62 list row, then scrolling, then aiming at a tile. On side A I never touch the mouse to move between shots.
- **Screenshots:** `d1440-02-sideB-first-shot.png` (no hints) vs `d1440-11-play-in-cut-sideA.png` (hint row at the bottom)
- **Smallest fix:** `[` and `]` for previous/next shot on side B too (same keys as side A), Space plays the in-cut take or the first take, `?` opens the shortcuts. Then add the same hint row.

### 6. To redo a take with one change, I rebuild it by hand
- **What I tried:** take 3 (Veo 3.1, 720p, 6 s) is nearly right. I want the same thing with "slower".
- **What happened:** the tile has no "same settings" button. I click the prompt to copy it, scroll up about 600 px, select all in Video prompt, paste, edit, then set Model, Resolution and Duration again: around 9 actions. Veo 3.1 isn't even in the Model list (only Wan 3.0, Wan 3.0 Prime, Seedance 2.5, Seedance 2.0 Fast) unless I turn on "Show every video model" in Settings. Also the model I picked on shot 2 stayed selected on shot 3 without telling me.
- **Why it hurts:** iterating on the best take is the normal loop. Rebuilding settings is where mistakes come from: wrong duration, wrong model.
- **Screenshots:** `d1440-09b-shot3-full.png` (take tiles), `d1440-06-shot2-prompt-model-duration.png`
- **Smallest fix:** a "Reuse" button on each take that loads its prompt, model, resolution, duration and seed into the generator and scrolls to it.

### 7. Take tiles are huge and the buttons wrap
- **What I tried:** see all 4 takes of shot 3 at once.
- **What happened:** each tile is 558x452 px at 1440 (480x407 at 1280), two per row, so 4 takes are 2 screens tall. Each tile has 6 or 7 text buttons (Use in cut / Play in cut, Remove from cut, Last frame → next shot, Reframe, Download, Delete). On the in-cut tile "Delete" wraps onto a line of its own at 1440, and on the phone "Download Delete" wraps too. The native player controls cover the bottom 70 px of every picture.
- **Why it hurts:** I can't compare what I can't see together. And the button rows are the busiest thing on the screen, louder than the pictures.
- **Screenshots:** `d1440-10-shot3-use-in-cut.png`, `d1440-16-delete-armed.png`, `p390-05-shot3-takes.png`
- **Smallest fix:** 3 tiles per row at 1440 (4 at wider widths), the picture without native controls, and on each tile only the main action as a labelled button (Use in cut, or Play in cut on the one in the cut). Reframe, Download, Last frame → next shot and Delete become icon buttons with a tooltip and an aria-label, in one row.

### 8. The shot list doesn't tell me what's left to do
- **What I tried:** use the left list to plan: which shots still need a start frame, which have nothing in the cut, which failed.
- **What happened:** each row says "2 takes", "no takes" or "4 takes · in cut". Nothing says a shot has no start frame (shot 2 looked the same before and after I uploaded one, apart from the thumbnail), that shot 5's last take failed, or which take number is in the cut. On side A the strip at least shows the picture that plays. The list ends at y=589 and the column is empty below it.
- **Why it hurts:** on a real job the question is "what's left", and I have to open each shot to find out.
- **Screenshots:** `d1440-17-shot5-failed-take.png` (shot 5 says "3 takes", one of them failed), `d1440-18-shot6-no-takes.png`
- **Smallest fix:** a second line per row with plain status: "take 3 in cut" / "nothing in cut", "no start frame", "1 failed". The same text in the phone strip.

### 9. The downloaded file doesn't match the take number
- **What I tried:** "Download" on the tile labelled "take 4" of shot 03.
- **What happened:** the file is `mountain-king-editor-test-shot03-wan-30-t1.mp4`. The end of the name is the last 4 characters of an internal id (in real use that's random), not "take 4".
- **Why it hurts:** in Premiere I conform by name. If the bin says `-t1` and Cue Board says "take 4", I can't tell which take a client means when they say "use take 4 on shot 3".
- **Screenshots:** `d1440-16-delete-armed.png` (tile labels); file name in `walk-log.json` (`download filename`)
- **Smallest fix:** name the file with the number on the tile: `…-shot03-take4-wan-30.mp4`.

### 10. Orange is on every take except the one that's chosen
- **What I tried:** find which take is in the cut at a glance.
- **What happened:** every take that isn't in the cut has an orange-outlined "Use in cut" button (3 on shot 3, plus the orange "Generate take"). The take that is in the cut gets a **green** border and a green "in cut" badge. On side A orange means "this one is selected" (the strip, the timeline, the shot number).
- **Why it hurts:** my eye goes to orange, which here means "not chosen". The chosen take is the quiet one. It's backwards from side A.
- **Screenshots:** `d1440-10-shot3-use-in-cut.png`, `d1440-09b-shot3-full.png`
- **Smallest fix:** make "Use in cut" a neutral button and give the in-cut tile the orange outline, the way side A marks the selected shot.

### Smaller annoyances (real, but they slow me less)
- **Two kinds of player in one grid.** After Reframe, a take loses its native controls and plays on click with no scrub and no time display. The tile next to it has full controls. (`d1440-16-delete-armed.png`: take 4 vs take 3)
- **Generate without a key opens the Settings dialog on top of everything.** The header already shows "No API key: open Settings" in red. A note next to the Generate button would do. (`d1440-07-generate-without-key.png`)
- **A failed take takes up a full 558x314 black tile** that says "Failed". It could be one line with Retry. (`d1440-17-shot5-failed-take.png`)
- **"Tap again" on a desktop Delete.** Desktop should say "Click again" or "Delete?". (`d1440-16-delete-armed.png`)
- **The Duration list has 29 entries** (2 s to 30 s) for a 3.5 s slot. The default is right ("6 s clip for a 6.0 s slot" is great), but the list could show only the values near the slot.
- **Project spend, credits and API status sit in the shot header**, next to the shot title. That's project information. It belongs in the top bar, or in Settings.
- **"Wan 3.0 Prime" is cut off** in the Model select at 1280 (`d1280-12-back-to-B.png`).
- **Phone:** the takes start about 1370 px down the page, under the monitor, strip, header, "Generate with code" and two full-width frames (`p390-03-sideB-full.png`). AI generation is hidden on the phone, which is fine for reviewing, so on the phone the takes should come first.

---

## Side A vs side B: what A does that B doesn't

| | Side A (Cut) | Side B (Takes) |
|---|---|---|
| **Layout** | Fits one screen (1043 px tall at 900): monitor on top-left, inspector on the right, timeline and strip below. Nothing important needs a scroll. | A page that scrolls (1145 to 1613 px at 900). Header, then form, then results. |
| **Hierarchy** | The picture is the biggest thing; fields are on the side. | The generator form is the biggest thing; the pictures come last. |
| **Selection** | One selected shot, orange everywhere it shows (strip, timeline, inspector number). | The selected shot is orange in the list. There is no "current take": takes can't be selected, only acted on, and the chosen one is green. |
| **Keyboard** | Space, M, L, I/O, [ ], arrows, ? and a visible hint row. | None. |
| **Playback** | One transport, the song always under the picture, Loop shot. | Native muted players on each tile, no song, no loop of the slot. |
| **Density** | Strip tiles are 175 px wide with number, timecode, duration, title and shot type. 8 shots in one row. | Take tiles are 558 px wide. 2 per row. |

---

## Wishes: what I'd expect as an editor

1. **Compare takes side by side.** Tick 2 to 4 takes and play them together from the same frame, with the song, in a 2x2 grid; or flip between two in the same frame (A/B), like source/record in Premiere. That's how I choose takes; doing it one after another depends on memory.
2. **Choose the in-point of a take.** A 5 s take for a 3.5 s slot always plays from its first frame. The best motion is often in the middle. I want to slide the take inside the slot (slip) and see the used part on the tile. Every editor does this on every generated clip.
3. **Scrub on hover.** Move the mouse across a tile to scrub the take, like the browser in Resolve or Premiere's hover scrub. That fixes "all takes look the same" without playing anything.
4. **A keyboard flow like side A's.** `[ ]` shot, `← →` take, Space plays the take with the song, `Enter` = Use in cut, `?` lists them. Then I go through a whole cut without the mouse.
5. **A shot list that works as a to-do list.** Status per shot (start frame, in cut, failed, rendering), and an optional "only shots with nothing in the cut" view. That's how I'd plan a generation session.
6. **Reuse a take's settings.** "Reuse" loads that take into the generator; generating from it keeps the same seed so I can change only the prompt. It's how I'd iterate.
7. **Mark takes like dailies.** A circle (keep) and an X (no) on each take, with "hide rejected". After 3 rounds a shot has 10 takes and I only care about 2.
8. **Play the shot in context without leaving side B.** A play button that plays the last 2 s of the previous shot, this take, and the first 2 s of the next shot, with the song, right in side B. Cuts are judged across the edit, not one shot alone.

None of these needs a third-party request or a new colour. Compare (1) and hover scrub (3) are one interaction on the existing grid. The rest are fields or buttons on things that already exist.

---

## What already works and must stay

- **Start frame from side A**, labelled "from side A", with "Don't use" to turn it off. A new picture on side A replacing it is right. (`d1440-02`)
- **The fit line**: "6 s clip for a 6.0 s slot", and the warning when a clip is too short or will be trimmed. Duration defaulting to the slot is right. That's the line an editor wants before spending money.
- **The price before Generate** ("≈ 0.30 USD") and the cost on every take. Clear, no surprises.
- **Last frame → next shot.** Very useful for continuity, and something I'd otherwise do by hand in Resolve.
- **Use in cut / Remove from cut** keeping the keyframe, and Undo working on it. Nothing gets lost.
- **Download names with project, shot and model** (only the take number is wrong, see 9).
- **Two-step Delete** and the "Forget" wording on a job that's still running.
- **Click a prompt to copy it**: the prompt is right there on each take.
- **The reframe dialog**: drag, zoom, a Time slider to pick the frame to frame on, and "Use as is". (`d1440-13`)
- **Shot numbers and timecodes match side A** (03, 0:11.0 → 0:17.0, 6.0 s). Always one language between the two sides.
- **The phone strip** of shots with take counts is a good way to move between shots by thumb (`p390-02`).

---

## If I could change only three things

First, put the takes at the top of the shot and make them smaller: 3 per row at 1440, no native controls, the middle frame as the poster, one main button per tile. Then the first screen of every shot is the takes, and I can tell them apart without playing each one. Second, make playing a take play the song under it, from the shot's start to its end, inside side B, so I judge takes against the music where I choose them and stop going back and forth through "Play in cut". Third, give side B side A's keyboard: `[ ]` for shots, arrows for takes, Space to play, Enter for Use in cut, `?` for help, with the same hint row. Together that turns side B from a form I scroll through into a place I review in.
