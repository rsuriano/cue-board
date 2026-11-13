# Generate with code: build report

Branch `codegen` (local commits, not pushed). Contract: `generate-with-code.md`. Checks: `design/codegen-sandbox-check.mjs` (sandbox, beat; no UI) and `design/codegen-check.mjs` (the UI with OpenRouter stubbed by fixture answers; no paid model is called anywhere). Screenshots: `design/out/codegen-build/`.

## Criteria
| # | Result | Check |
|---|---|---|
| 1 Sandbox, network | PASS | sandbox-check: 16 attacks (fetch, XHR, WebSocket, EventSource, importScripts, Image, location, window.open, top.location, WebTransport, BroadcastChannel, Worker, postMessage, prototype postMessage, FontFace URL, timers) all fail; route log: zero requests left the page; no navigation; a second `load` stops the job. Walls alone: the same attacks with code right in the CSP iframe (no worker), and a raw blob worker without the prelude: all blocked |
| 2 Sandbox, data | PASS | sandbox-check (IndexedDB, localStorage, sessionStorage, cookie, parent.document, caches, FileReaderSync); codegen-check scans every message to the sandbox: no key, no other shot's text, the job has exactly the listed fields |
| 3 Endless loop | PASS | `while(true)` in draw stops in 2.0 s; a 10 ms timer on the page had no gap over 15 ms; iframe removed; the card shows "more than 1 s"; no video |
| 4 Throws | PASS | message, `line 6`, `frame 0 (0.0 s)` on the card; nothing recorded; Fix it sends the code and the error |
| 5 Memory | PASS, partial | Chromium: the page keeps answering; the fixture is stopped by the 3 s setup limit (shown as the "more than 1 s" text) before it reaches a real out-of-memory, so the "no error message" text was not seen. The project is flushed before every job (code path, not a separate check) |
| 6 Contract | PASS | no block, two blocks, no `animation`, non-function return → "right form"; 33 KB does not start |
| 7 Determinism | PASS | frames 0/mid/last hash equal in forward and reverse order (with transforms, Math.random and Date.now in draw); another seed differs |
| 8 Output | PASS, partial | Parsed files: 16:9 1920x1080 (321 frames for 10.7 s, about 3.4 Mbit/s), 9:16 1080x1920, 1:1 1080x1080, 4:3 1440x1080 (132 frames for 4.4 s), all avc1 at 30 fps; after Use in cut, the side A monitor has the take's video. Not checked: a Render pixel sample of the take |
| 9 Fallback | PASS | without `VideoEncoder`: a playable file and "Records in real time"; without `OffscreenCanvas`: the Code tab is disabled with its hint |
| 10 Request body | PASS | model, stream, max_tokens 8000, usage; title, notes, video prompt, words, duration, fps, size, seed; beats and loudness with the beat on; `Authorization` header; no key in the body |
| 11 Beat | PASS | 120 BPM click track: 100 % of clicks within 30 ms, 120 BPM found; shot beats relative to its start; 10 loudness values per second |
| 12 Versions | PASS | v2 from v1 has v1's code and the words; one card, two rows; Use in cut takes the version on screen; Delete v2 keeps v1; a reload keeps it all |
| 13 Costs | PASS | estimate in the box and under Ask for a change; cost = `usage.cost`; Project spend up by it; Stop aborts the stream with the billing note |
| 14 OAuth URL and storage | PASS | callback = page without query, challenge = S256(stored verifier), state; the return posts code + verifier + S256, stores the key, no `code` left in the address |
| 15 OAuth failures | PASS | wrong state: no exchange; 403 and network error: their messages; the paste field works in all three |
| 16 iPhone | NOT VERIFIABLE HERE | needs a real iPhone (Chrome iOS and the home-screen app). The headless short-code fallback is not built (only if this test shows the problem) |
| 17 Rooms | NOT VERIFIABLE HERE (not run) | `code.asset` is in `mediaOf`, `projectMediaIds`, export and import, and the collab media layer has no type filter; the two-tab check was not written |
| 18 Phone | PASS | 390x844 and 390x667: the entry is on screen above the takes, 44 px targets, sheet without horizontal scroll, 16 px inputs, sheet closes on Generate; screenshots looked at |
| 19 Third-party requests | PASS | on load only the existing `/videos/models` catalog call (already there before this change); `openrouter.ai` only on generate, test or connect |
| 20 Existing suites | see below | |

Sandbox per engine: **Chromium (headless shell 1248) only**: all walls hold, blob worker in the opaque-origin iframe works. Firefox and WebKit are not installed here: not run.

OAuth CORS: **works**. `OPTIONS` and `POST https://openrouter.ai/api/v1/auth/keys` with `Origin: https://cue.bedrocklabs.dev` answer `access-control-allow-origin: *` (POST with a fake code: 400 "Invalid code"). So Connect works as a browser fetch; no proxy.

Production lines: **424 added, 21 changed** in `index.html` (cap about 700): sandbox about 75, beat about 20, request/recorder/take flow about 70, card and box UI about 60, OAuth about 30, the system prompt 45, CSS 58, markup 30.

## Decisions and deviations
- First frame limit 2 s, not 3 s: criterion 3 asks for a stop within 2.5 s and the first call to draw is the first frame. Setup keeps 3 s.
- The sandbox sends one extra message, `{type:"setup"}`, so the 5 s silence rule never fires during setup plus the first frame.
- `Math.random` and `random()` are reseeded per frame from (seed, frame), so even code that calls them in draw stays order-independent.
- OAuth `state`: a different `state` stops the exchange; a missing one does not (OpenRouter's docs do not say it echoes `state`; PKCE already ties the code to this tab's verifier).
- Model prices for the three Claude models are built in (checked against the live `/models` on 2026-11-13: Sonnet 5.5, Opus 5.5, Haiku 5.5); the live text-model list is fetched only when "Show every model" is on.
- Beat analysis is cached in memory per page session, not stored.
- Prompt tuning (step d): **not done with a real model**. There is no key here and checks must not spend. The prompt has the contract, rules for looking good and the mock's example; it needs one session of 5-6 real generations on the example (about 0.50 USD with Sonnet).
- `TASTE-GAP:` a stopped or failed take without code shows "Try again" (resends the same words) instead of "Fix it", since there is no code to fix.

## Suites
All 24 `design/*-check.mjs`, one at a time (a failure rerun alone twice):
- PASS (22): codegen, codegen-sandbox, collab (59/59 after `npm ci`; the clone had no `node_modules`), example-media, mobile-b, mobile-sizes, mobile-takes, phonebar, render, render-collab, render-range, report, resume-buy, rooms, selection, settings-account, shortcuts, strip-wheel, syntax, topbar, topbar-spacing, undo. render-check and mobile-b-check serve the app from `server.mjs` with zero page errors.
- FAIL on the base commit too (same failures with the `ce0d8eb` index.html): media-check (30/37, peer media transfer A-F) and mobile-check (times out waiting for a file chooser after "Swapped shots 02 and 03"). This change did not cause them.

`npm test`: auth 12/12, collab-client 55/56, sync-server 72/73. The two failures ("doc -> project -> doc round trip" and "(f) .cueboard.json round trip ... on the example") fail the same way with the base index.html. One run also failed "(t) never logs the token" while the design suite was using port 3360. It passed alone twice.

## What a human must test
- Real iPhone, Chrome iOS and the home-screen app: Connect with OpenRouter, approve, come back "Connected" in the same app (criterion 16). If the home-screen app loses the key, the short-code fallback is the next step.
- Safari (macOS and iOS): does the blob worker start inside the sandboxed iframe, does the Code tab work, and does it record (Safari has `VideoEncoder` since 17; else the real-time path).
- On the phone: a code take on shot 02 with the beat on, play it, ask for "slower", put v2 in the cut.
- 5-6 real generations on the example to judge how the default output looks.

## Open risks
1. Only Chromium was run; Safari and Firefox sandbox behaviour is unproven.
2. The prompt is untuned against a real model: output quality is unknown.
3. A true out-of-memory in the sandbox on Safari or a phone can still close the tab (project is saved first).
4. Rooms with code takes are untested end to end.
5. The live site must keep serving `fonts/` (the worker loads the two fonts from it; without them text falls back).
