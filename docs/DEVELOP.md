# Develop Cue Board

Notes for contributors. What the app does for its users is in the [README](../README.md).
`CLAUDE.md` has the deploy steps for the hosted copy, `DESIGN.md` the design system, and `PRODUCT.md` the short product brief.

## The app

The app is `index.html`. It has no build step and no dependencies, and it works when you double-click it (`file://`).
It makes no requests to third parties except the user's own calls to OpenRouter. The fonts are in `fonts/`.

| File | What it is |
|---|---|
| `index.html` | The whole app. |
| `server.mjs` | Optional local server and OpenRouter relay. Listens on `127.0.0.1` only. |
| `example/example.js`, `example/media/` | The example project and its song; its keyframes and takes (1.3 MB). Loaded only when the example opens, then stored like your own media. From a `file://` page the pictures are skipped. |
| `mp4-muxer.js` | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 (MIT), vendored. Loaded only when the render dialog opens. How to update it: `docs/specs/export-render-notes.md`. |
| `collab.js` | The collaboration client, built from `packages/collab-client`. Loaded only when a project is in a room. |
| `manifest.webmanifest`, `icons/` | The phone install (Add to Home Screen). |

### Run it

- **Open the file.** Double-click `index.html`. Current Chrome, Edge and Firefox run both sides: OpenRouter allows cross-origin requests, so the page calls it straight from a local file. The API key is stored in the browser.
- **Local server.** Use it if you want to keep the API key out of the browser:

```bash
node server.mjs                                  # http://localhost:5173
OPENROUTER_API_KEY=sk-or-... node server.mjs     # key stays on the server
node --env-file=.env server.mjs                  # same, key read from .env (Node 20.6+)
```

It needs Node 18 or later and no `npm install`. For the `.env` route, put `OPENROUTER_API_KEY=sk-or-...` in a `.env` file next to `server.mjs`. `.env` is in `.gitignore`; never commit it, and never deploy `server.mjs` or `.env`.

To host the app somewhere else, upload `index.html`, `example/`, `fonts/`, `mp4-muxer.js`, `collab.js`, `manifest.webmanifest` and `icons/` to any static host.

### Side B (Takes) in detail

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys). A credit limit on the key is a good idea.
2. Open **Settings**, paste the key, **Test key**, **Save**.
3. Pick a shot, set a start frame, write the motion prompt, **Generate take**.

Video generation is asynchronous. Takes show "Queued", "Rendering", "Downloading" and land in the grid. Jobs resume if you reload the page.

Each frame slot can **Upload** an image, use the keyframe from side A, or **Generate** one:

- **Generate** makes 1 or 2 variants from the keyframe prompt (shared with side A). Set how many in **Settings**.
- **From start** (end frame only) edits the start frame: you write only what changes, and the rest stays the same. Use it for static shots.
- **References**: up to 3 images per project (character sheet, portrait…), sent with every generated frame so characters stay consistent.

The image model and size are in **Settings** (Nano Banana Pro at 1K by default). Frame costs count toward the project spend.

Side B shows an estimate before each generation, from OpenRouter's live pricing, and the real cost when the job finishes. The header shows the project's spend and the credits left on the key.

Tips that save money:

- Draft at 480p. Render your final picks at 720p or 1080p.
- Describe only the motion in the prompt. The start frame already sets the look.
- For a static camera, give a start and an end frame with the same background.
- **Last frame → next shot** takes the final frame of a take and makes it the next shot's start frame.
- The duration picker starts at the shortest clip that covers the shot. A clip shorter than its shot freezes on its last frame in the animatic.

### Render

**Render** (in the bar; **Render video** in the phone's Project sheet) makes an MP4 of the cut, in the browser. Spec: `docs/specs/export-render.md`, `docs/specs/export-render-range.md`.

- **Frame**: 16:9, 9:16, 1:1 or 4:3, per project. The monitor shows that frame and the render uses it.
- **A section**: **I** and **O** mark in and out at the playhead, **Alt+X** clears them. On a phone, drag the two handles on the ruler. Or choose **Custom** and type a start and end (`1:15`, `1:15.5` or `75`).
- **Size**: 720p with a small "Cue Board" watermark for everyone; 1080p without it with an account.
- **Speed**: with WebCodecs (current Chrome and Edge) it renders faster than real time, as H.264 with AAC (Opus where the browser can't encode AAC, as on Linux: that file plays in Chrome and VLC, not in iPhone Photos or QuickTime, and the dialog says so). Other browsers make the file in real time, as MP4 or WebM.

### Project files

**Save project file** writes one `.cueboard.json` (cuts, notes, prompts, keyframes, takes, and optionally the song). **Import project file** loads it, or drop the file on the page. `*.cueboard.json` is in `.gitignore`: exports can hold personal media.

### Example project

**The Mountain King (example)** loads on the first visit: 13 shots on Grieg's *In the Hall of the Mountain King*, with notes, frame prompts and motion prompts, a painted keyframe on every shot and takes on shots 3, 4 and 10. The recording is by the Musopen Symphony Orchestra and, like the composition, is in the public domain ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Grieg_-_Peer_Gynt_Suite_No._1,_Op._46_-_IV._In_the_Hall_of_the_Mountain_King_(Musopen_Symphony).flac), [Musopen](https://musopen.org/music/777-peer-gynt-suite-no-1-op-46/)).

## The packages

The repo is also an npm workspaces monorepo (Node 20 or later) for the services. They are never deployed with the page.

| Path | What it is |
|---|---|
| `packages/sync-server` | Real-time sync server: Yjs over WebSocket, one room per project, invite links, the media relay, problem reports. See its `SPIKE.md`. |
| `packages/collab-client` | The app side of collaboration: Yjs client, the project ⇄ doc binding, validation of remote data, media between peers. `npm run build:collab` bundles it into `collab.js` (committed; rebuild after changing the package). |
| `packages/auth` | The account service (`auth.bedrocklabs.dev`): email magic links, Lemon Squeezy purchases, invite codes, signed sessions. No dependency, Node 22.13 or later. Spec: `docs/specs/auth-paywall.md`. |

```bash
npm install          # at the root: installs every package
npm test             # runs every package's tests
npm run build:collab # rebuilds collab.js
```

## Collaboration

How it works: [`docs/collaboration.md`](collaboration.md). Media between collaborators: [`docs/media-p2p.md`](media-p2p.md). Problem reports: [`docs/reports.md`](reports.md).

**Turn it on.** The copy of the app has to know a sync server: `<meta name="cue-sync-url" content="wss://sync.example.dev">` in `index.html`. Empty (the default in this repo) means collaboration is off and `collab.js` never loads. Run the server from `packages/sync-server` (see its `SPIKE.md`). Creating rooms from the app also needs `<meta name="cue-auth-url">` and a running `packages/auth`.

**Create a room as the operator**, on the server:

```bash
APP_URL=https://cue.example.dev/ npm run create-project -w @cue-board/sync-server -- "Our video"
# app:    https://cue.example.dev/#join=<room>.<token>    (send this one)
```

`--import file.cueboard.json` seeds the room from an export; `--invite <room>` prints another link for the same room.

**Join.** Open the `#join=` link, or paste it into **Collaborate → Join with a link**. The app asks for your name the first time. With a project open you choose: open the room as a new project, or share this project into the room (only while the room is empty). Nothing is overwritten without asking, and the link leaves the address bar as soon as it's read.

**Limits.**

- One shared link per room, with full edit access. There are no read-only links or per-person revoke. The room's owner can make a new link, which cuts off the old one.
- A file travels only while someone who has it is online. Nothing is stored on a server.
- A generation runs on the key of whoever started it.
- The room token is kept in the browser's IndexedDB, never in exports, `localStorage` or the address bar, and goes to the server as a WebSocket subprotocol, not in a URL.

## Checks

The design checks in `design/` drive the app in headless Chromium with Playwright. Run them one at a time:

```bash
node design/run-local.mjs design/<check>.mjs . <out-dir>
```

`run-local.mjs` finds the Playwright headless shell in `~/.cache/ms-playwright` and a `playwright-core` install in `~/testkit` (or set `CUE_TESTKIT` and `CUE_CHROMIUM`). The README screenshots come from `design/readme-shots.mjs`, which writes `docs/readme/`. They show the example as shipped: its pictures and takes are files in `example/media/`, painted by `node design/run-local.mjs design/example-art.mjs .` (which also points `example/example.js` at them), and `design/example-media-check.mjs` checks that a fresh profile gets them all.
