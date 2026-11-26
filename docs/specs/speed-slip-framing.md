# Clip speed, framing keyframes, and an end frame on side A

## Intent (Rami, 2026-11-26, verbatim answers to the grill)
- Speed: "La velocidad la haria libre. En el vegas si estiras el corte con Shift apretado le cambias la velocidad para que se ajuste al clip. Hay algo que ver tambien ahi que es que deberiamos tener una forma visual de ver que el clip es mas corto que su corte, porque si no no te das cuenta a menos que mires el clip en el video"
- Framing: "Si, fotograma de inicio y final esta bien." (start and end framing; the app moves between them)
- End frame: "podriamos tambien poner un tilde para tener fotograma de inicio y de fin, matcheado con el lado b ... No se como lo mostrariamos pero lo dejo a tu imaginación"

## Launch condition
After `feat/fal-provider` (#52) and `plan/b-side-ux` (#53) are merged: both touch side B and the reframe area. Branch from the merged main. (Both merged 2026-11-26.)

## Deepened (deep-not-big pass, 2026-11-26)
- **One time map, used everywhere.** Write a single pure function `srcTime(shot, tShot) -> { t, held }` (source time = clip offset + tShot x speed, clamped to the clip's end, `held` true once the clip ran out) and a single `cropAt(shot, slot, tShot)` for the framing move. The monitor, the render, the strip/timeline "held" region and the thumbnails all call these two; no other place computes clip time or crop. Unit-test both directly (speed 0.5/1/2.37, offset, end clamp, frame boundaries at 24/25/30 fps).
- **Rawest material: a test clip that shows its own frame number.** Generate it with ffmpeg (`testsrc2` plus a per-frame barcode or `drawtext` of the frame index, 24 fps, 5 s) into the check's temp dir, use it as the shot clip, render, then extract frames from the rendered MP4 with ffmpeg and read which source frame each output frame shows. Judge by that, not by the app's own state.
- **Methods/tools:** Playwright pointer events with Shift and Alt held for the timeline drags (and without, to prove the plain drag is unchanged); ffmpeg/ffprobe for the render; geometric checks (bounding boxes, `design/frame-rows-check.mjs` style) for the held region and the switch marker; the existing suites for regressions.
- **External judge:** the ffmpeg frame readout of the rendered file, the existing check suites, and one independent review round (blockers only) because the project format gains fields.
- Reference behaviour, checked against the real tools' docs before building: Vegas Shift+drag on an event edge = time-stretch; Alt+drag inside an event = slip. Follow their feel, keep Cue Board's own labels.

## Scope
1. **Free speed per shot clip.** A numeric speed on the shot (any value 0.1x-10x, default 1x) in the side A editor next to the clip, plus the same on the take in the cut. Monitor playback (`playbackRate`) and the render (seek time = (t - shot start) x speed) both honour it; the clip still freezes on its last frame when it runs out. Saved with the project and in export/import; old projects open at 1x.
2. **Shift + drag a cut (Vegas style)** on the side A timeline: dragging the edge of a shot with a clip while Shift is held changes that shot's speed so the clip exactly fills the new length, instead of leaving it short or trimmed. Without Shift, dragging works as today. A small readout shows the speed while dragging. Undo restores both cut and speed.
3. **See when a clip is shorter than its shot.** On the timeline and on the strip card, the part of the shot after the clip (at its speed) has run out is drawn as a hatched or dimmed region with a tooltip "Clip ends at 3.2 s: holds the last frame". The same rule for a take in the cut.
4. **Framing keyframes (start and end).** The Reframe dialog gets a "Move" toggle: off = one framing (today); on = a start framing and an end framing, and the picture moves between them across the shot (linear, with an ease option if trivial). Works for clips and for still images (a Ken Burns on a still). Monitor and render use the interpolated crop per frame. Old projects keep their single framing.
5. **End frame on side A ("matched with side B").** A checkbox "End frame" in the side A editor under the image. On: a second image slot appears, and it IS side B's end frame (the same field, `endKey`), so setting it on either side shows on both. Display: the strip card shows the start image with a small end-frame thumbnail in its corner; in the monitor the shot shows the start image, then switches to the end image at a **switch point** with a short dissolve (~0.25 s). The switch point is a small marker inside the shot on the side A timeline, draggable (default: the middle of the shot), also settable as a number in the editor ("End frame from 0.8 s"). Rami (26/11): "que pasa si quiero tener la imagen de inicio poco tiempo y la de fin por el resto del clip?" Off: no end frame on side A; side B's end frame is cleared only if the user confirms.
6. **Choose which part of the clip plays (slip).** Rami (26/11): "que pasa si quiero recortar el inicio de un clip en vez del final, ponele que tengo un clip que dura 5 segundos y la toma dura 3". Each shot clip (and take in the cut) gets a start offset ("Clip starts at 1.2 s", default 0). Alt + drag inside the shot on the side A timeline slips the clip (Vegas style), with a readout; a number field in the editor sets it exactly. Monitor and render seek at offset + (t - shot start) x speed; the short-clip region (item 3) and Shift-drag speed (item 2) use the remaining length after the offset. Undo restores it.

## Out of scope
More than two framing keyframes; reverse playback; speed ramps; audio time-stretch (clips are muted in the animatic); any sync-server or storage change beyond the new fields; renaming existing labels.

## Acceptance (one check each)
- Speed: a 6 s clip at 0.5x fills a 12 s shot; in the RENDERED file (ffmpeg readout of the frame-numbered test clip) the output frame at t=10 s shows source frame 5 s x fps (±1), and the monitor agrees.
- Shift-drag: a shot with a 4 s clip dragged to 8 s with Shift gets speed 0.5x; without Shift its speed stays 1x; undo restores both.
- Short clip: a 3 s clip in a 5 s shot shows the hatched region from 3 s to 5 s on the timeline and the card; at 1.5x the region starts at 2 s.
- Framing: with Move on, the crop at shot start equals the start framing, at the end equals the end framing, halfway is the midpoint; render matches the monitor.
- End frame: setting the end frame on side A shows it as side B's end frame and vice versa; the monitor shows the start image before the switch point and the end image after it; dragging the marker moves the switch; turning it off asks before clearing.
- Slip: a 5 s clip in a 3 s shot with offset 2 s shows the clip's frame at 2 s at shot start and at 4.5 s at 2.5 s into the shot, in the monitor and in the render; Alt-drag changes the offset; undo restores it.
- Old projects (no new fields) open unchanged; export/import round-trips the new fields; existing checks pass.

## Size cap
About 650 added lines in `index.html` plus checks.
