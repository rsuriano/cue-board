# Cue board data model (Y.Doc, schema 1)

One project = one room = one `Y.Doc`. The doc holds only the light data. Media (song, keyframes, takes, reference images) is referenced by content hash; the bytes live elsewhere (today: each browser's IndexedDB; later: peer-to-peer).

Code: [`src/schema.mjs`](../src/schema.mjs) (helpers, JSDoc types) and [`src/import-cueboard.mjs`](../src/import-cueboard.mjs) (`.cueboard.json` ⇄ Y.Doc).

## Layout

```
doc.getMap('meta')                      plain values, last writer wins
  schema      1
  id, title, created, updated           as in the app's project object
  song        SongRef | null
  hasRefs     true if the source project had a `refs` key (keeps the round trip exact)
  <any other project key>               kept as is, so newer app versions don't lose data

doc.getArray('refs')                    MediaRef[]   reference images sent with every generated frame

doc.getMap('shots')                     shotId -> Y.Map (one per cut)
  id          string                    stable, never reused
  start       number (s)                where the cut is. Order and end time are derived from it (below)
  title       Y.Text   ┐
  notes       Y.Text   │ character-level merge: two people typing in the same note both keep their text
  imgPrompt   Y.Text   │ (keyframe / frame prompt)
  vidPrompt   Y.Text   ┘ (motion prompt)
  shot        string                    shot type ("Wide shot")
  img         MediaRef | null           what plays in the cut on side A: an image, an uploaded clip, or a take's video
  kind        "" | "image" | "video"
  clipDur     number                    length of img when it's a video
  key, endKey MediaRef | null           start / end frame for side B
  keyOff      boolean                   "don't use side A's keyframe as the start frame"
  imgCrop, keyCrop, endCrop  string     the framing of img / key / endKey: "<ratio> x y w h" (0..1 of the
                                        original image); used only while the project's ratio matches. Optional,
                                        plain last-writer-wins strings (an older app keeps them as unknown keys)
  takes       Y.Array<Y.Map>            newest first
    id, jobId, model, modelName, res, dur, audio, seed, prompt, start, end,
    est, cost, status, created, done, error, note, clipDur     plain values
    media     MediaRef | null           the generated video
  <any other shot / take key>           kept as is

MediaRef = { sha256: hex, bytes: number, mime: string }
SongRef  = { name, duration, peaks: number[], sha256, mime, bytes, bpm?, fileName? }
```

## Decisions, and why

- **Shots are a map keyed by id, ordered by `start`.** A cue board is a timeline: a shot runs from its cut to the next one, and the app already keeps `sections` sorted by `start` (dragging a card swaps or rewrites `start` values; it doesn't reorder an array). So "reordering" is editing `start`, a last-writer-wins number, and a concurrent insert is just a new key: nothing to merge. A `Y.Array` of shots would be worse: moving an item is delete + insert, so a concurrent edit to a moved shot is lost and two concurrent moves duplicate it. Ties (two cuts at the same instant) break by id, identically on every peer (`orderedShots`).
- **Cut end is derived, not stored.** `cutRange()` gives `[start, next.start)`, the last shot ending at the song's end. Storing both ends would let concurrent edits leave gaps or overlaps.
- **"Use in cut" is derived, not a flag on each take.** A take is in the cut when `shot.img` is the take's media (`useInCut()` / `setInCut()`), exactly as the app does today. One register per shot means two people picking different takes at the same time still end with exactly one take in the cut. A boolean per take could end with two.
- **Text you write is `Y.Text`, everything else is last-writer-wins.** Prompts are paragraphs people refine together; numbers, statuses and media refs are replaced whole.
- **Unknown keys are carried through** at project, shot and take level, so the doc is a superset of the current export format and of fields added later.
- **Media by hash only.** Same bytes = same ref = stored once. Import returns the payloads on the side; they never enter the doc (asserted in the tests).
- **No undo history or per-user data in the doc.** Undo is client-side (`Y.UndoManager` scoped to the local origin); presence (who is looking at which shot) goes over awareness, which isn't persisted.

## Mapping from `.cueboard.json` (version 1)

| export | doc |
|---|---|
| `project.{id,title,created,updated,…}` | `meta` |
| `project.song` + top-level `song` (file) | `meta.song` (SongRef; the file's bytes become `sha256`) |
| `project.refs[]` (media ids) | `refs` (MediaRefs) |
| `project.sections[]` | `shots` (map) |
| `section.img/key/endKey`, `take.media` (media ids) | MediaRef, or `null` for `""` |
| `media{id: {type, data}}` | not in the doc; ids become `sha256-<hex>` on export |
| `exportedAt`, `format`, `version` | not stored (export metadata) |

`docToCueboard()` writes the format back; given the payloads, it reproduces the original file (media ids aside). Without them it writes `media[id] = {type, sha256, bytes}` with no `data`, which the current app would import as missing media. The app also drops media ids it has no payload for on import (`re()` in `index.html`); `cueboardToDoc` does the same and reports them in `dropped`.
