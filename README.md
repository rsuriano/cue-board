# Cue Board

A two-sided tool for making AI music videos.

- **Side A · Cut** — load a song, mark a cut at every change in the music, and each stretch becomes a shot with a title, notes, prompts and a keyframe. The monitor plays it back as an animatic, synced to the song.
- **Side B · Takes** — make the start/end frames and generate video for each shot through [OpenRouter](https://openrouter.ai): pick a model (Wan 3.0, Seedance 2.5…), set start and end frames, see the price before you spend it, and keep every result as a take. Mark the one you like with **Use in cut** and it plays in the animatic on side A.

Everything lives in your browser (IndexedDB): the song, keyframes, takes and your API key. Nothing is uploaded anywhere except the generation requests you send to OpenRouter.

## Run it

**Online:** [cue.bedrocklabs.dev](https://cue.bedrocklabs.dev). Each person enters their own OpenRouter key in **Settings**; it stays in their browser and goes only to OpenRouter. To host it elsewhere, upload `index.html` and the `example/` folder to any static host; nothing else is needed.

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

## Example project

The first time you open Cue Board it loads **The Mountain King (example)**: a 13-shot cut of Grieg's *In the Hall of the Mountain King*, with notes, frame prompts and motion prompts for every shot, so you can see both sides working before you load your own song. Open it again any time with **Example**.

The recording is by the Musopen Symphony Orchestra and, like the composition, is in the public domain ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Grieg_-_Peer_Gynt_Suite_No._1,_Op._46_-_IV._In_the_Hall_of_the_Mountain_King_(Musopen_Symphony).flac), [Musopen](https://musopen.org/music/777-peer-gynt-suite-no-1-op-46/)).

## Projects

**Export** saves a project as one `.cueboard.json` file (cuts, notes, prompts, keyframes, takes; optionally the song). **Import** loads it on any computer, or drop the file on the page. Leave the song out if you share the file.

## Prices

Side B shows an estimate before each generation, computed from OpenRouter's live pricing, and the actual cost once the job finishes. The header shows the project's spend and the credits left on your key. Prices change often; the estimate is only as good as OpenRouter's published SKUs.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app. No build step. |
| `server.mjs` | Optional local server + OpenRouter relay. |
| `example/example.js` | The example project and its song, loaded only when needed. |
| `collab.js` | The collaboration client, built from `packages/collab-client`. Loaded only when a project is in a room. |

## License

MIT. See `LICENSE`.

## Monorepo

The repo is also an npm workspaces monorepo (Node 20+), for the multi-user version in progress. The app above is unaffected: `index.html` still needs no build and no `npm install`.

| Path | What it is |
|---|---|
| `packages/sync-server` | Real-time sync server for shared cue boards (Yjs over WebSocket, one room per project, invite links). A spike: see its `SPIKE.md`. |
| `packages/collab-client` | The app side of collaboration: Yjs client, the project ⇄ doc binding, validation of remote data. `npm run build:collab` bundles it into `collab.js` (committed). |

`npm install` at the root installs all packages; `npm test` runs their tests. The app itself will move to `apps/web` later.

## Collaboration v1

A project can be shared with friends and edited live: shots and cuts, titles, notes, prompts, takes (their details, not their files), which take is in the cut, and the song reference. It's opt-in per project. Projects that aren't in a room work exactly as before, with no network at all, and `collab.js` is never loaded for them.

**Turn it on.** The copy of the app has to know a sync server: set `<meta name="cue-sync-url" content="wss://sync.example.dev">` in `index.html`. Empty (the default) means collaboration is off and the menu doesn't offer it. Run the server from `packages/sync-server` (see its `SPIKE.md`).

**Create a room** (the operator, on the server):

```bash
APP_URL=https://cue.example.dev/ npm run create-project -w @cue-board/sync-server -- "Our video"
# room:   …
# invite: http://127.0.0.1:3300/demo/?room=…&token=…    (the dev demo)
# app:    https://cue.example.dev/#join=<room>.<token>    (send this one)
```

`--import file.cueboard.json` seeds the room from an export; `--invite <room>` prints another link for the same room.

**Join.** Open the `#join=` link, or paste it into **Join collaboration…** in the project menu. The first time, the app asks for your name (kept in this browser; the others see it next to the shot you have selected). On a device with no projects the room opens as a new project. With a project open you choose: **Open the room as a new project** (your project is untouched) or **Share this project into the room** (only while the room is still empty). Nothing is overwritten without asking, and the link leaves the address bar as soon as it's read.

**While you work.** The chip next to the project picker says *Synced*, *Syncing…*, *Offline, changes will sync* or *Can't reach the room*. The initials next to it are the others in the project; theirs also show on the shot each of them has selected. Offline edits stay in the browser (across reloads too) and merge when you're back. Two people typing in the same note both keep their text. **Leave collaboration** in the project menu stops syncing and keeps the project here as a local copy.

**Limits.**
- **Media isn't synced yet.** Images, clips, take videos and the song stay on the device that made them; the room holds only their content hashes, and other devices show "not on this device yet". Someone with the same song file can load it themselves. Media will travel peer to peer in a later version.
- **One shared link per room, with full edit access.** Anyone with the link can read and change everything, including deleting shots. No accounts, roles, read-only links or per-person revoke: revoking means removing the token's hash from the room's `project.json` on the server, which cuts off everyone using that link (hand the others a new one with `--invite`).
- A generation runs on the key of whoever started it. The others see the take's details; the video stays on that person's device.
- The token is kept in this browser's IndexedDB, never in exports, `localStorage` or the address bar, and travels to the server as a WebSocket subprotocol rather than in a URL.

How it works: [`docs/collaboration.md`](docs/collaboration.md).
