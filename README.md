# Cue Board

A two-sided tool for making AI music videos.

- **Side A · Cut** — load a song, mark a cut at every change in the music, and each stretch becomes a shot with a title, notes, prompts and a keyframe. The monitor plays it back as an animatic, synced to the song.
- **Side B · Takes** — make the start/end frames and generate video for each shot through [OpenRouter](https://openrouter.ai): pick a model (Wan 3.0, Seedance 2.5…), set start and end frames, see the price before you spend it, and keep every result as a take. Mark the one you like with **Use in cut** and it plays in the animatic on side A.

Everything lives in your browser (IndexedDB): the song, keyframes, takes and your API key. Nothing is uploaded anywhere except the generation requests you send to OpenRouter.

## Run it

**Option 1: just open it.** Double-click `index.html`. Works in current Chrome, Edge and Firefox, side B included: OpenRouter's API allows cross-origin requests, so the page can call it straight from a local file. Your API key is then stored in the browser.

**Option 2: local server.** Use it if you'd rather keep the API key out of the browser:

```bash
node server.mjs                                  # http://localhost:5173
OPENROUTER_API_KEY=sk-or-... node server.mjs     # key stays on the server
node --env-file=.env server.mjs                  # same, key read from .env (Node 20.6+)
```

Needs Node 18+, no `npm install`. The server only listens on `127.0.0.1`. For the `.env` route, put `OPENROUTER_API_KEY=sk-or-...` in a `.env` file next to `server.mjs`; it's in `.gitignore`.

## Side B setup

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys). Setting a credit limit on the key is a good idea.
2. Open **Settings**, paste the key, **Test key**, **Save**.
3. Pick a shot, set a start frame, write the motion prompt, **Generate take**.

Video generation is asynchronous: takes show "Queued" → "Rendering" → "Downloading" and land in the grid. Jobs resume if you reload the page.

### Frames

Each frame slot can **Upload** an image, use the keyframe from side A, or **Generate** one:

- **Generate** makes 1 or 2 variants from the keyframe prompt (shared with side A); set how many in **Settings**. One costs half as much; two let you pick. Click the one you like; the rest are discarded.
- **From start** (end frame only) edits the start frame: you write only what changes ("the rider much farther down the trail") and everything else is kept identical. Use it for static shots.
- **References**: up to 3 images per project (character sheet, portrait, horse…) sent with every generated frame, so characters stay consistent.

Pick the image model and size in **Settings** (Nano Banana Pro at 1K by default). Frame costs count toward the project spend.

### Tips that save money and headaches

- **Draft at 480p**, render your final picks at 720p/1080p.
- **Describe only the motion** in the prompt. The start frame already sets the look.
- **Static camera?** Give it a start *and* an end frame with an identical background. Models love to move the camera; two matching frames leave them no room to.
- **Continuity:** "Last frame → next shot" grabs the final frame of a take and makes it the next shot's start frame.
- The duration picker defaults to the shortest clip that covers the shot's slot. A clip shorter than its slot freezes on its last frame in the animatic.

## Projects

**Export** saves a project as one `.cueboard.json` file (cuts, notes, prompts, keyframes, takes; optionally the song). **Import** loads it on any computer, or drop the file on the page. Leave the song out if you share the file.

## Prices

Side B shows an estimate before each generation, computed from OpenRouter's live pricing, and the actual cost once the job finishes. The header shows the project's spend and the credits left on your key. Prices change often; the estimate is only as good as OpenRouter's published SKUs.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app. No build step. |
| `server.mjs` | Optional local server + OpenRouter relay. |

## License

MIT. See `LICENSE`.
