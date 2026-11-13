# SPEC: Generate with code (side B) + Connect with OpenRouter

Status: draft for owner approval. Idea from Rami, 2026-11-12. Mock: `design/mock-codegen.html`, screenshots in `design/out/codegen/`. Open questions and risks: `generate-with-code-notes.md`.

## Why
Side B makes takes with AI video models. These models are good at realistic scenes. They are bad at exact timing, text, flat graphics and abstract shapes, and each try costs 0.25 to 2 USD. Many music videos need these things: an animatic, lyrics on screen, motion graphics, shapes that move on the beat.

A language model can write that animation as code. The app runs the code on this device and records it as a take. A request costs about 0.05 to 0.15 USD. The user asks for changes in words ("slower", "warmer colours") and gets a new version. Every version is a take: it plays in the monitor, goes in the cut and goes in Render, as every take does today.

This does not replace AI video. Code does not make realistic people or places.

The second part, "Connect with OpenRouter", removes the hardest step for a new user: to make an API key on another site and copy it into the app.

## Product rules
- **Same take model.** A code take is a take: same list, same "Use in cut", same Render, same project spend. Nothing else in the app needs to know how a take was made.
- **The user's own key.** Requests go to OpenRouter with the key that the app has today. No account or plan is necessary (same as AI video).
- **Model code never runs in the app's page.** It runs only in the sandbox (section 1). The sandbox has no key, no project, no storage and no network.
- **No money without a tap.** The app shows the estimate before each request. It never retries or fixes code on its own.
- **The song stays on the device.** The app finds the beat locally. Only beat times and a loudness curve (numbers) go to the model.
- **Phone too.** The phone gets "Generate with code" (open question 1 in the notes). AI video stays off on the phone, as today.

## 1. Sandbox (design this first, build this first, test this first)
The model's code is untrusted. Treat it as code from a stranger. The sandbox has three walls. Each wall must hold alone.

### Wall 1: a sandboxed iframe with an opaque origin
- The app makes a new hidden `<iframe>` for each job and removes it after the job. Never use one iframe for two jobs.
- Attributes: `sandbox="allow-scripts"` (and nothing else: no `allow-same-origin`, `allow-top-navigation*`, `allow-popups`, `allow-forms`, `allow-modals`, `allow-downloads`, `allow-pointer-lock`), `allow=""` with every powerful feature set to `'none'` (camera, microphone, geolocation, clipboard-read, clipboard-write, display-capture, usb, serial, bluetooth, payment, fullscreen), `referrerpolicy="no-referrer"`, `srcdoc` (no URL).
- Without `allow-same-origin` the iframe has an opaque origin. Its code cannot read the app's IndexedDB, `localStorage`, `sessionStorage`, cookies or service worker. It cannot touch `parent` or `top` (cross-origin). It cannot open windows or navigate the app.

### Wall 2: a strict Content Security Policy inside the iframe
- The `srcdoc` starts with this meta tag. The app makes a new random nonce for each job:
  `default-src 'none'; script-src 'nonce-<random>'; worker-src blob:; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; frame-src 'none'; child-src blob:; form-action 'none'; base-uri 'none'`
- No `connect-src` source means no `fetch`, XHR, WebSocket, EventSource or WebTransport. No `img-src` means no image beacons. The worker (wall 3) inherits this policy from its blob URL.
- The iframe's own script (the runner, about 120 lines, part of `index.html`) is the only script with the nonce. The model's code is never in the `srcdoc` as a script tag.

### Wall 3: a Worker inside the iframe, with a reduced global scope
- The runner starts a dedicated Worker from a `blob:` URL. The worker source is: the hardening prelude, then the model's code inside a strict-mode function, then the frame loop. The model's code runs only in this worker.
- Why a worker: a `while(true){}` in the page or in a same-process iframe would freeze the app. A worker has its own thread, and `worker.terminate()` stops any loop.
- The prelude removes or replaces, before the model's code runs: `fetch`, `XMLHttpRequest`, `WebSocket`, `WebTransport`, `EventSource`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`, `Worker`, `SharedWorker`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `queueMicrotask`. `Date.now()` and `performance.now()` return the frame time. `Math.random` is the seeded `random`. The prelude keeps a private reference to `postMessage` and hides the global one, so the model's code cannot send messages.
- This wall is defence in depth. Walls 1 and 2 are the boundary.

### Message channel only
- The app makes a `MessageChannel` and sends one port to the iframe with the first message. After that, all traffic uses the port. The app ignores `window` `message` events, except the first `ready` from that iframe's `contentWindow`.
- App to sandbox: `{type:"job", code, width, height, fps, duration, seed, beats, energy, fonts}`, `{type:"frame", i}`, `{type:"stop"}`. `fonts` is the app's two font files as `ArrayBuffer`s, so text can use "Instrument Sans" and "JetBrains Mono" (the worker loads them with `new FontFace(name, buffer)`; no URL).
- Sandbox to app: `{type:"ready"}`, `{type:"frame", i, bitmap}` (an `ImageBitmap`, transferred), `{type:"error", kind, message, line, frame}`. `kind` is one of `syntax`, `contract`, `throw`, `hang`, `slow`, `crash`.
- The app checks every message (type, fields, sizes: the bitmap must be exactly width x height). A message that does not match stops the job and removes the iframe.
- The job never contains the API key, other shots, the project, file names or any media. Only the fields above.

### Limits
| What | Limit | Who enforces it |
|---|---|---|
| Code size | 32 KB (about 8,000 tokens) | the app, before the sandbox starts |
| Setup (the call to `animation`) | 3 s | the runner (iframe thread) terminates the worker |
| One frame | 1 s (the first frame: 3 s) | the runner terminates the worker |
| The whole recording | the larger of 60 s and 8 x the shot's length | the app removes the iframe |
| Silence | no message from the iframe for 5 s while a job runs | the app removes the iframe (this also stops its worker) |
| Extra canvases | at most 4, each at most 4096 px on a side | the prelude wraps `OffscreenCanvas` |

A browser cannot cap a worker's memory. The guards are: fixed canvas size, the canvas limit, the time limits, and a save of the project before each job (so a crash loses nothing). Recent Chrome on desktop puts sandboxed iframes in their own process, so an out-of-memory error there stops only the sandbox (criterion 5 checks it). Other browsers can lose the tab (see the notes).

### When the code fails
| Case | What the user sees on the take card |
|---|---|
| No code block, or no `animation` function, or it does not return a function | "The model did not return code in the right form." |
| Syntax error | "The code has a syntax error" + message + line |
| It throws | "The code failed" + message + line + frame and time, e.g. `TypeError: … · line 9 · frame 0 (0.0 s)` |
| One frame takes too long | "One frame took more than 1 s. The code can have an endless loop." |
| The whole recording takes too long | "The animation is too slow to record. Ask for a simpler version." |
| The worker or iframe stops with no message | "The code stopped with no error message. It can use too much memory." |

In all cases: the app stops the job, removes the iframe and records nothing. The take stays in the list with status `failed`, its cost, and its code. The card has **Fix it** (sends the code and the error to the model as a new version, with the estimate on the card), **Show code** and **Remove**. The app keeps working during and after a failure.

## 2. The contract: what the model gets and what it must return
### The model gets
- A fixed system prompt (about 1,800 tokens): the contract below, the rules, one short example (the one in `design/mock-codegen.html`, `#sampleCode`).
- The shot: number, title, shot type, notes, frame prompt (`imgPrompt`), video prompt (`vidPrompt`), the user's words from "What the animation shows".
- The numbers: `duration` (the shot's exact length, e.g. 10.7), `fps` (30), `width` x `height` (the project ratio at 1080 on the short side: 1920x1080, 1080x1920, 1080x1080, 1440x1080), and the seed.
- When "Follow the song's beat" is on: the beat times inside the shot, in seconds from the shot's start (2 decimals), and the loudness over the shot (10 values per second, 0 to 1, 2 decimals).
- For a new version: the code of the version the user started from, the user's words ("slower"), and the error if that version failed.
- Never: the API key, images, the song, other shots, names of people in the room.

### The model must return
Exactly one fenced code block (` ```js `) with exactly one function. Text outside the block is ignored. It is never shown as HTML.

```js
function animation({ canvas, ctx, width, height, fps, duration, random, beats, energy, lib }) {
  // setup: runs once, may precompute
  return function draw(t, i) {
    // draws the full frame for time t (seconds from the shot's start); i = frame number
  };
}
```

| Input | What it is |
|---|---|
| `canvas`, `ctx` | an `OffscreenCanvas` of `width` x `height` and its 2D context |
| `fps`, `duration` | 30; the shot's length in seconds |
| `random()` | seeded random number in [0, 1). The same seed gives the same numbers |
| `beats` | sorted beat times in seconds from the shot's start; `[]` when the beat is off |
| `energy(t)` | loudness 0 to 1 at time `t`; `null` when the beat is off |
| `lib` | small helpers in the runner: `lerp`, `clamp`, `ease.in/out/inOut`, `noise(x, y, z)` (seeded value noise), `grid(duration, step)` |

Rules (in the system prompt, and the runner enforces what it can):
1. `draw(t)` must give the same picture for the same `t`, in any order of calls. The app draws frames 0, middle and last first, as a test. Particles and motion must come from `t` (or from data made in setup), not from the previous frame.
2. Canvas 2D only. No WebGL, no DOM, no network, no timers, no `async`, no `import`, no images or fonts from URLs.
3. Use `random`, not `Math.random` (the runner replaces `Math.random` anyway).
4. Draw the whole frame each time (fill the background first).
5. Keep the code under 32 KB.

Before the sandbox starts, the app checks: one code block, size, and the word `animation`. These checks give clear messages. They are not a security control.

## 3. User flow
### Desktop (side B)
1. The generation box gets a switch at the top: **Make the take with** [AI video] [Code] (the app's segmented control, as Side A / Side B). The choice is saved per browser, like the model choice.
2. Code mode shows: **What the animation shows** (text area, saved per shot as `codePrompt`, synced like `vidPrompt`), chips (`on the beat`, `lyrics on screen`, `flat shapes`, `line drawing`, `slow and calm`), one hint line, **Model**, **Follow the song's beat (N beats in this shot)** (on by default; disabled with "No song in this project" when there is no song), the token and cost estimate, and **Generate with code** (icon and label, the box's primary button). Start and end frames stay on screen; code mode does not use them.
3. The new take appears first in the takes list as a card with steps: **Writing the code** (streamed token count) → **Testing in the sandbox** (3 frames) → **Recording** (frame count and bar) → **Saving the take**. **Stop** works in every step.
4. When it is done, the card shows the take, the version list, **Ask for a change** and the usual actions.
5. Mock: `desktop-1440x900-1-b-side-code.png`, `-3-progress.png`, `-4-done-versions.png`, `-5-error.png`.

### Phone (side B)
1. Under the shot header: a full-width **Generate with code** button (icon and label) and one hint line. The AI video box stays hidden on the phone, as today.
2. The button opens a sheet (the app's bottom sheet, as Details and More) with the same fields as desktop, stacked, and **Generate with code** at the bottom.
3. The sheet closes on Generate. The take card appears at the top of the takes, and the side B column scrolls to it.
4. Touch targets at least 44 px. The text input for "Ask for a change" is 16 px text (no iOS zoom).
5. Mock: `phone-390x844-1-b-side-code.png`, `-2-code-sheet.png`, `-3-progress.png`, `-4-done-versions.png`, `-5-error.png`.

### Versions and "Ask for a change"
- Each version is its own take record. Versions of one animation share `code.thread` (the id of version 1) and the takes list shows them as **one card** with a version list (newest first): `v3 warmer colours, slower glow 0.09 USD`, …, `v1 first version`. The row on screen has the selected style (orange, the one meaning of orange). The version in the cut shows "in cut".
- The card shows the selected version. **Use in cut**, **Download**, **Delete** and **Show code** act on that version. **Delete** removes only that version (two taps, as today).
- **Ask for a change**: a text input and **Send**. Under it: "For example “slower” or “warmer colours”. Makes v4 from v3: about 9,000 tokens, ≈ 0.10 USD." Send makes the next version from the selected one. The version count goes up by one for the thread, whatever version the user started from.
- **Show code** opens a dialog with the code as plain text (`textContent`, never `innerHTML`) in JetBrains Mono, and **Copy**. No editing (out of scope).
- The takes count on side A counts each version as a take.

## 4. Recording
- **Deterministic path** (where `VideoEncoder` with H.264 is available): for each frame `i` from 0 to `round(duration x 30) - 1`, the app asks the sandbox for frame `i`, makes a `VideoFrame` from the `ImageBitmap` with timestamp `i / 30` s, encodes it, and closes the frame and the bitmap. Keyframe every 2 s. At most 4 frames in the encoder queue (back pressure). One frame request in flight while one encodes. Muxer: the vendored `mp4-muxer.js`, loaded the same way as Render loads it. Reuse Render's encoder setup (`rnFastPath`), do not copy it.
- Output: MP4, H.264, 30 fps, no audio track, at the size in section 2 (1080 on the short side), about 6 Mbit/s (about 8 MB for 10 s). The video is exactly the shot's length (± 1 frame), so it never freezes or needs a trim.
- **Real-time fallback** (no `VideoEncoder` or no H.264): the app draws the bitmaps on a canvas at 30 fps by the wall clock and records `canvas.captureStream()` with `MediaRecorder` (MP4 where supported, else WebM). If a frame is late, the last frame stays on screen (the length stays right). The card says "Records in real time: this browser has no fast video encoder."
- **Browsers without `OffscreenCanvas` in workers**: no code takes. The Code tab is disabled with the hint "This browser cannot run code takes safely. Update the browser."
- **Test step**: before the recording, the app draws frames 0, middle and last. If all three are one flat colour, the finished card says "Most frames are one colour. Ask for a change if this is wrong." The recording continues.
- **Save**: the video goes into the app's media store (`assets.upload`), as AI takes do. The code goes into the media store too, as a `text/javascript` file (`code.asset`), so that it travels with the project and the room without making the synced document bigger. `mediaOf`, export and the room's media list must include `code.asset`.
- The app saves the code as soon as the model answers. If the page closes during the recording, the card says "Recording stopped" and offers **Record again** (no cost: it uses the saved code).
- Memory: never keep more than the frames in flight. Close every `VideoFrame` and `ImageBitmap`. Release object URLs.

### The take record (added fields only)
`kind:"code"`, `model`, `modelName`, `res` (e.g. `"1080p"`), `dur`, `audio:false`, `prompt` (the words), `status` (`writing`, `testing`, `recording`, `saving`, `completed`, `failed`, `cancelled`; the busy ones count as busy for `isBusy`), `est`, `cost`, `error`, `note`, `dev`, and `code:{asset, thread, v, parent, ask, seed, beats, tokensIn, tokensOut}`. A take without `kind` is an AI video take, as today. Old projects and old export files open unchanged.

## 5. The beat, found on the device
- When the box opens with the beat option on, the app decodes the song (the same decode Render uses), at 22,050 Hz mono, and computes:
  - loudness: RMS every 100 ms, scaled 0 to 1 over the whole song;
  - an onset curve (rise of energy in 4 frequency bands), a tempo between 60 and 180 BPM (autocorrelation), and beat times (dynamic programming over the onset curve).
- The result is cached with the song in this browser. It is not synced: each device computes it. About 80 lines, no library.
- The shot's beats are the beats in [shot start, shot end), minus the shot start.

## 6. Requests and costs shown to the user
- Request: `POST /chat/completions` through the app's `apiFetch` (so the local server mode works too), with `model`, `messages`, `max_tokens: 8000`, `stream: true`, and usage accounting on, so that the answer carries the real cost. **Stop** aborts the stream (`AbortController`). The card then says "Stopped. OpenRouter can still bill the tokens written before the stop."
- Models: a short list, verified against the live `GET /models` when built (do not guess ids): Claude Sonnet (latest, default), Claude Opus (better code, costs more), Claude Haiku (cheaper). The existing "Show every model" setting also shows every other text model with a price. The choice is saved per browser (`putSetting("codegen")`).
- **Estimate before the request** (box foot, sheet foot, under "Ask for a change"): input tokens = 1,800 + the characters of the shot text and the numbers / 4 (+ the characters of the earlier code / 4 for a new version); output tokens = 4,000. Price = tokens x the model's `pricing.prompt` and `pricing.completion` from `GET /models` (fetched once per session). Shown as "About 7,000 tokens" and "≈ 0.08 USD". Unknown price: "price unknown". The worst case (8,000 output tokens) is in the tooltip of the estimate.
- **While it writes**: the streamed token count on the card.
- **After**: the real cost from the answer's usage (`usage.cost`); if it is missing, tokens x price, marked "≈". The take's `cost` counts in **Project spend**, as AI takes do.
- Errors from OpenRouter (401, 402 no credit, 429, 5xx, no network) use the same messages and the same `corsHint` as AI video, on the card.

## 7. Connect with OpenRouter (OAuth PKCE)
Today: Settings > Model has one field, "OpenRouter API key", stored in IndexedDB (`putSetting("apiKey")`), sent only as `Authorization: Bearer` by `apiFetch`. Manual paste stays as the fallback.

### Settings
- New row at the top of Settings > Model: label **OpenRouter**, button **Connect with OpenRouter**, the state ("No key yet"), and the hint "Opens OpenRouter. You log in and approve there, then you come back here with a key. You do not copy anything."
- The key field stays under it, with the label **Or paste a key** and its current hint.
- With a key (from either way): **Connected**, the key masked as `sk-or-v1-…a1f3`, **Disconnect**, and the hint "The key is only in this browser. To set a spending limit or delete the key, go to openrouter.ai/keys." The link opens `https://openrouter.ai/keys/<sha-256 hex of the key>` (OpenRouter's deep link; only the key's owner can open it). The paste field is hidden; **Disconnect** shows it again. **Test key** becomes **Test connection**.
- **Disconnect** deletes the key from this browser. It cannot delete the key at OpenRouter (the hint says where to do that).
- The "No API key" messages ("Add your OpenRouter API key to generate takes.") become "Connect OpenRouter to generate takes." and open Settings.
- Hide **Connect** when the page is a `file://` page (no callback is possible) and when the local server has its own key (no key is necessary).
- Mock: `desktop-1440x900-6-settings-connect.png`, `-7-settings-connected.png`, and the same for the phone.

### The flow
1. On **Connect**: make `code_verifier` (64 random bytes, base64url), `code_challenge` = base64url(SHA-256(verifier)) with `crypto.subtle`, and `state` (16 random bytes, base64url). Store `{verifier, state, created}` in `sessionStorage` (`cueboard-or-pkce`). It lives in this tab only and survives the navigation. Save the project now (flush).
2. Go to `https://openrouter.ai/auth?callback_url=<page>&code_challenge=<challenge>&code_challenge_method=S256&state=<state>&key_label=Cue%20Board%20(<host>)`. `<page>` is `location.origin + location.pathname`, with no query and no hash (e.g. `https://cue.bedrocklabs.dev/`; on `server.mjs`, `http://localhost:<port>/`, which OpenRouter allows on any port).
3. On every start, before anything else reads the URL: if the query has `code`, remove `code` and `state` from the address with `history.replaceState` (so the code does not stay in the history, in a problem report or in a screenshot). Then:
   - no pending entry, `state` differs, or the entry is older than 10 minutes: show "The OpenRouter sign-in did not match. Try Connect again." Send nothing.
   - else `POST https://openrouter.ai/api/v1/auth/keys` with `{code, code_verifier, code_challenge_method:"S256"}`. On `{key}`: store it exactly as a pasted key, delete the pending entry, show "Connected to OpenRouter", refresh credits and the catalog.
   - 400 or 403: "OpenRouter refused the sign-in: the code is old or used. Try Connect again." No network or a CORS error: "Could not reach OpenRouter. Try again, or paste a key."
4. The key is never in a URL, a log, a problem report, the sandbox, the room or an export file (as today).

### Home-screen app on iPhone
A home-screen app on iOS can have storage that is separate from Safari's. If OpenRouter's redirect opens the callback in Safari, the key lands in Safari, not in the app. The implementer checks this on a real iPhone first (approval criterion 16). If the key lands in the wrong place, the home-screen app (`display-mode: standalone` on iOS) uses OpenRouter's headless mode (no `callback_url`; OpenRouter shows a code) and Settings shows a field "Code from OpenRouter". See open question 4.

## Out of scope (do NOT build)
p5.js or any other library in the sandbox · WebGL, shaders, 3D · sound in code takes · images sent to the model (start frame, references) · editing code by hand (Show code is read only) · automatic fixes or retries · several takes per request · lyrics import or lyric timing tools · a server-side render or a server-side proxy for OpenRouter · providers other than OpenRouter · AI video on the phone · a CSP for the app page itself (a good idea, a separate change) · revoking keys at OpenRouter from the app · spending limits set from the app · changes to Render, the sync server, the auth service or the paywall · new colours, new fonts, new icons other than the code icon (`</>`, on the sprite's 16 px grid, 1.5 px stroke).

## Approval criteria (each one = a check written first; all green = mergeable)
1. **Sandbox, network.** A hostile fixture tries `fetch`, XHR, `WebSocket`, `EventSource`, `importScripts`, `new Image().src`, `location.href = …` (inside the iframe), `window.open`, `top.location = …`. No request leaves the page (Playwright route log: zero requests that the app did not make), the app does not navigate, and the job ends with an error or continues without effect. A second `load` event on the iframe stops the job.
2. **Sandbox, data.** A hostile fixture tries `indexedDB.open`, `localStorage`, `document.cookie`, `parent.document`, `caches`, and to read the job for any key. All fail. A scan of every message to the sandbox finds no API key, no project id and no other shot's text.
3. **Endless loop.** `while(true){}` in `draw` stops within 2.5 s. During it, a timer on the app's page keeps its pace (no gap over 100 ms). The card shows the "more than 1 s" message. No media is saved.
4. **Throws.** A fixture that throws at frame 0 shows the message, the line and the frame on the card. Nothing is recorded. **Fix it** sends a request whose body has the code and the error (stubbed `fetch`).
5. **Memory.** A fixture that fills memory: on Chrome desktop the app page still answers after it, and the card shows the "no error message" text. On all browsers the project was saved before the job.
6. **Contract.** Answers with no code block, two code blocks, no `animation`, or a non-function return each give the "right form" message. Code over 32 KB does not start.
7. **Determinism.** The same code and seed, drawn twice, give the same pixels (hash) for frames 0, middle and last, also when drawn in reverse order.
8. **Output.** For each ratio, the file is MP4/H.264, 30 fps, the expected width x height, and the shot's length ± 1 frame (parse the file, do not trust the UI). After **Use in cut**, the monitor plays it and a Render of the shot shows its colours (pixel sample of a known fixture colour).
9. **Fallback.** With `VideoEncoder` undefined, a code take still records a playable file and the card says "Records in real time". Without `OffscreenCanvas` in workers, the Code tab is disabled with its hint.
10. **Request body.** Stubbed `fetch`: the body has the model, the shot's prompts, notes, duration, fps, width x height and the seed; beats and loudness only when the option is on; the `Authorization` header is present; no key in the body.
11. **Beat.** A 120 BPM click track fixture: at least 90 % of the clicks have a beat within 30 ms. The shot's beats are relative to the shot's start.
12. **Versions.** Ask for a change on v1 makes v2 (same `thread`, `parent` = v1) with v1's code and the words in the body. The card lists both. **Use in cut** uses the version on screen. Delete v2 keeps v1. A reload keeps all of it.
13. **Costs.** The estimate shows before Send. After a stubbed answer with `usage.cost`, the take's cost is that value and Project spend goes up by it. Stop during the stream aborts the request.
14. **OAuth URL and storage.** **Connect** goes to `openrouter.ai/auth` with `callback_url` = the page URL with no query, `code_challenge` = S256 of the stored verifier, and `state`. Stubbed: the return with the right `code` and `state` posts the right body, stores the key, and leaves no `code` in `location` or `history`.
15. **OAuth failures.** A wrong `state` sends no exchange. A 403 shows its message. A network error shows its message. In all three cases the paste field still works.
16. **iPhone (manual, by the implementer on a real device before merge, or by Rami).** Connect in Chrome iOS and in the home-screen app: the key arrives in the same place the user started from, or the headless fallback works.
17. **Rooms.** A code take made in tab 1 arrives in tab 2 (record, video, code file). Tab 2 can **Ask for a change** with its own key.
18. **Phone (390x844 and 390x667).** The entry is reachable without scrolling past the takes. The sheet fits with no horizontal scroll. Touch targets are at least 44 px. No text overlaps. Screenshots looked at.
19. **No new third-party requests.** On page load: none. Requests to `openrouter.ai` only when the user generates, tests the key or connects.
20. **Existing suites.** `design/*.mjs` checks (one at a time) and package tests stay green. The app served from `server.mjs` loads with zero page errors.

## Limits and gate
- Size cap: about 700 lines of production code in `index.html` (sandbox runner and prelude about 150, recorder glue about 100, beat analysis about 80, UI about 250, OAuth about 70, the rest about 50). Tests and fixtures are not counted. Over the cap = stop and report.
- Build order: the sandbox and criteria 1 to 7 first, alone, with a fixture code (no model, no UI). Then the recorder. Then the UI and the requests. OAuth is independent and can be a separate PR.
- Merge when: all criteria green + existing suites green + under the cap.
- At most ONE independent review. Only blockers count: a sandbox escape, the key outside the app's storage, data loss, a criterion not actually met, model text rendered as HTML. Everything else goes to a follow-up list.
- Before finishing, the implementer reads the diff as a hostile reviewer: a sandbox message with a wrong size, a bitmap from an old job, Stop during the flush, a collaborator who deletes the shot during a recording, a song replaced during a recording, a shot shorter than one frame, two jobs at the same time on one shot, a page reload during Writing. Add a check for each one possible.

## Setup the owner does
None for the code takes. For OAuth: nothing to register at OpenRouter (the callback is the page itself). Rami tries Connect on his iPhone after the deploy (manual test list).

## Deploy
Static app only: merge, then publish through the hephaestus repo as usual (`CLAUDE.md`), keeping the per-host meta values. No new file, no new meta value, no server change. After the deploy: `curl -s https://cue.bedrocklabs.dev/ | grep -c 'Generate with code'` is not 0 and the build id is the new sha. Rollback: re-publish the previous `pages/cue` commit.

## Manual test list for Rami (real devices, after deploy)
- iPhone, Chrome iOS: Settings > Connect with OpenRouter, approve, come back: "Connected". Then the same from the home-screen app.
- iPhone: on shot 02 of the example, Generate with code with the beat on; play the take in the monitor; ask for "slower"; put v2 in the cut.
- Desktop Chrome: make a code take for a 9:16 project, then Render the whole song; the take is in the video.
