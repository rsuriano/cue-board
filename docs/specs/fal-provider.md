# fal.ai as a second video provider

## Intent (Rami, 2026-11-26, verbatim)
"deberiamos usar fal, si... te bancas un refactor en paralelo hacia fal? me voy a dormir y cuando me levanto me mostras que hiciste y lo probamos. no dejes sin conexion cue 1.0 porque es un producto que esta live ahora"

Context: OpenRouter's video catalog lists models with no provider (Hailuo 3 Max, Hailuo 3, Hailuo 2.3 return "No endpoints found" since 20 Nov) and does not pass Wan's `prompt_extend` / `negative_prompt`. fal.ai serves these models with their full options.

## Decisions taken without a grill (Rami asleep; he can veto them in the morning)
1. **Additive, not a replacement.** OpenRouter stays exactly as it is and stays the default. Existing users, projects, takes and settings keep working with no change. fal is an optional second provider.
2. **Bring your own key**, like OpenRouter today: an optional "fal.ai key" field in Settings, stored the same way as the OpenRouter key (browser only, never in exports, logs or URLs; header only).
3. **The model picker shows fal models only when a fal key is set**, labelled with the provider (e.g. "Wan 2.x · fal"). Picking one routes the take through fal; everything else in the box (frames, duration, resolution, seed, takes, estimate, Use in cut, Retry, Download) works the same.
4. A **curated short list** of fal models, checked live against fal's docs/model pages: the newest Wan image-to-video (with `prompt_extend` off by default and `negative_prompt` wired to the existing Avoid field), the newest MiniMax Hailuo image-to-video, and at most two more that the docs show support a first frame (and last frame if they do). Fewer models that work beats a long list.

## In scope
- A small provider seam in `index.html`: submit, poll status, fetch result, for OpenRouter (current code moved behind it, behaviour identical) and fal (queue API: submit, status, result).
- Start/end frames sent the way fal accepts them (data URI or fal's upload, whichever the docs say works from a browser).
- A take records its provider; polling resumes after a reload for fal jobs like it does for OpenRouter jobs; a fal error shows as the take's error text.
- Cost estimate for fal models when fal publishes a per-second or per-video price; otherwise "—".
- README: one short paragraph "Using fal.ai" (ASD-STE100 English).

## Out of scope
- Removing, renaming or changing OpenRouter behaviour, its settings, its labels, or the default model.
- Any server, sync-server, auth or Gumroad change. No new top-level files that `deploy_cue_pages.py` would need (keep it inside `index.html`).
- Image models, the code-generated takes (codegen), audio-only models.
- Renaming any existing label or button.

## Hard stop
**Before writing the fal client, check that fal's queue API can be called from a browser page (CORS) with the key in a header.** Read fal's docs (WebFetch) and, if possible, make an unauthenticated preflight request with `curl -i -X OPTIONS -H "Origin: https://cue.bedrocklabs.dev" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization,content-type" https://queue.fal.run/<model-id>`. If a browser cannot call it directly, STOP: do not build a proxy; write what you found (headers, docs quotes) in your final message and commit nothing but notes.

## Acceptance criteria (one check each, in `design/fal-check.mjs`, fal and OpenRouter mocked with `page.route`; no real key, no real network)
1. With no fal key, the app behaves exactly as before: same model list, same request body to OpenRouter for a Wan take (compare the JSON).
2. Settings has a fal key field; saving a key adds the fal models to the picker, labelled with the provider; clearing it removes them.
3. A take on a fal model submits to fal's queue with the key in the `Authorization` header (never in the URL), the prompt, the duration/resolution the model accepts, the start frame, and for Wan `prompt_extend: false` plus the Avoid text as `negative_prompt`.
4. The take polls fal's status, shows the video when done, and Use in cut / Download / Retry work on it.
5. A fal job in progress survives a reload and finishes.
6. A fal error (4xx with a message) shows on the take card; the app does not break.
7. The fal key never appears in an exported project, in `localStorage` keys other than the one settings uses, or in any request URL.
8. Existing checks still pass: `design/take-out-check.mjs`, `design/media-check.mjs`, `design/mobile-takes-check.mjs`.

## Size cap
About 450 added lines in `index.html` plus the check script. Moving the OpenRouter code behind the seam counts as new lines. If you go over, stop and report why.

## How to run the checks
`node design/<check>.mjs . <out-dir>`; Playwright from `createRequire(process.env.TESTKIT || '/home/talos/testkit/')('playwright-core')`, Chromium at `/snap/bin/chromium` with `--no-sandbox`. The app's functions live in its script scope: copy the serving hook from `design/take-out-check.mjs` (it exposes a few functions as `window.__t` in the served copy only). Run checks one at a time (fixed ports).

## Report (final message, short)
Criteria met (list), line count, the fal models you picked and why (with the doc URL for each), what you could not verify without a real key, and every field name you took from docs vs. from memory.
