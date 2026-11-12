# Generate with code: open questions and risks

Companion to `generate-with-code.md` (the contract). Mock: `design/mock-codegen.html`, screenshots in `design/out/codegen/`.

## Open questions for Rami (each with a recommendation)
1. **Code takes on the phone?** Today the phone has no generation at all (`mobile-redesign-b.md`: "No generation controls on the phone"). A code take is cheap, text only, and records on the device, so it fits a phone better than AI video.
   **Recommendation: yes.** Code takes on the phone, AI video stays off on the phone. The spec and the mock show this.
2. **Default model?** Claude Sonnet: about 0.08 USD a request, good code. Claude Haiku: about 0.02 USD, more failed or plain animations. Claude Opus: best code, about 2 to 3 times Sonnet.
   **Recommendation: Claude Sonnet as the default**, Haiku and Opus in the list. A failed try costs money too, so Haiku's low price can cost more in the end.
3. **"Fix it" automatic once?** When code fails, the app can send the error back once without a tap (faster), or wait for the user's tap (no surprise cost).
   **Recommendation: always wait for the tap.** It matches "no money without a tap". The card shows the price of the fix.
4. **Home-screen app on iPhone, if OpenRouter's redirect leaves the app:** (a) OpenRouter's headless mode: OpenRouter shows a short code and the user types or pastes it into Settings, or (b) a message "Connect in Safari or Chrome, then paste the key here".
   **Recommendation: (a).** A short code is easier than a key, and the key never shows on screen. Only if the real-iPhone check (criterion 16) shows the problem.

## Risks
1. **Workers inside an opaque-origin iframe.** The sandbox needs a `blob:` worker started from a sandboxed iframe without `allow-same-origin`. Chrome and Firefox allow this. Safari is not confirmed. Check it first, before any UI. If Safari refuses, try a `data:` worker URL (also opaque). If both fail there, Safari gets no code takes (the Code tab is disabled with its hint). Never run the code in the page or in a same-origin iframe as a fallback.
2. **Memory.** No browser lets the app cap a worker's memory. On Chrome desktop the sandbox has its own process. On Safari, Firefox and phones, code that fills memory can close the tab. Guards: fixed canvas size, a canvas limit, time limits, and a save before each job, so the user loses no work. The user can lose the tab for a moment.
3. **The iframe can navigate itself.** CSP does not stop an iframe from loading another URL in itself. The only data inside is this shot's text, which the model already has. Guards: no `allow-top-navigation` or `allow-popups`; the app stops the job on a second `load` event (criterion 1). A model that writes this on purpose is unlikely, but the check stays.
4. **CORS on the key exchange.** OpenRouter's docs show the exchange as a browser `fetch`, but they do not state CORS. Check with one real call from `https://cue.bedrocklabs.dev` and from `http://localhost` before building the UI. If it fails, Connect cannot work from the page; paste stays the way.
5. **Cost higher than the estimate.** Models that "think" bill reasoning tokens, and some answers are long. The estimate assumes 4,000 output tokens; `max_tokens` is 8,000. The card shows the real cost after each request. Many changes on one animation add up (10 versions with Sonnet is about 1 USD).
6. **Code that runs but looks bad.** The sandbox stops broken code, not ugly code. The fixed system prompt and its example decide most of the quality. Budget time to tune the prompt on 5 or 6 shots of the example project before release, and keep the prompt in one place in `index.html`.
7. **Beat tracking on free tempo.** The example song (Grieg) speeds up all the time. A beat tracker made for a steady tempo can drift there. The loudness curve still helps. The user can turn the beat off. The 120 BPM check (criterion 11) proves only the steady case.
8. **Small pixel differences between browsers.** The same code gives the same frames in one browser, but antialiasing and text can differ a little between Chrome, Safari and Firefox, or between GPUs. A version recorded on another device can look a little different. This is acceptable; the take is the recorded video, not the code.
9. **Fonts in the worker.** `FontFace` in workers is new in some browsers. Without it, text falls back to the generic families (`sans-serif`, `monospace`). Lyrics still show, in another font.
10. **The key in the browser.** OAuth does not change where the key lives (IndexedDB, as a pasted key). Any script on the app's origin can read it, as today. The sandbox does not change this; it only keeps the model's code away from it. A CSP for the app page itself would help and is a separate change.
11. **Key with no limit.** OpenRouter makes the key with no spending limit and has no parameter to set one. The Settings hint and its link to the key's page tell the user where to set it.

## TASTE-GAP decisions made in this spec (not covered by the owner's principles)
- `TASTE-GAP:` the AI video / Code switch is a segmented control at the top of the generation box (one box, two ways to make a take), not a second box.
- `TASTE-GAP:` versions of one animation are one card with a version list, not one card per version (the takes list stays short; each version is still a take in the data and in the count).
- `TASTE-GAP:` code takes record at 1080 on the short side for everyone. The work is local and free, and a 720p take looks soft in a 1080p render.
