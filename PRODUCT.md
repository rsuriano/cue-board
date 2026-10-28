# Product context

Short brief for design work. `README.md` describes the features, and `DESIGN.md` is the design system and the source of truth for visual decisions.

- **What it is:** Cue Board, a two-sided tool for making AI music videos. On side A you cut a song into shots, write notes and prompts, and play the animatic. On side B you make start/end frames and generate video takes through OpenRouter.
- **Who uses it:** one person making a music video (a musician, editor or director), working at a desktop or laptop and usually for long sessions. They know editing tools (Premiere, Resolve, After Effects) and expect that density and precision.
- **Mode:** Operate. It is an edit suite, not a landing page. Scanability, consistency and predictable controls come before expression.
- **Constraints:**
  - One `index.html`, no build step, works when double-clicked (`file://`).
  - No requests to third parties except the user's own OpenRouter calls. Fonts are self-hosted in `fonts/`.
  - Everything is stored in the browser (IndexedDB).
  - Desktop first, 1280 to 1920px; it must still work down to about 820px.
- **Voice:** plain, short and practical. Controls name their action ("Generate take", "Use in cut"). Prices and costs are stated before spending. No marketing copy.
- **Look:** professional and minimal, like an Adobe product with less chrome. Dark, quiet and precise, with one orange accent (`#f0a33a`) that has a single meaning (selection, playhead, primary action, focus).
