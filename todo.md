# TODO

## Bundled edge generator (deferred — the big one)

Make the app generate its own edge art from the user's DD2 install, so a shipped
build works without my offline bake. Plan (approved, deferred by request):

- `config/edgeTextures.json` — tracked manifest, built offline once: per output PNG
  (dungeon/town `<LA>.png`, overworld `world/<c>_<r>.png` tiles, single `world.png`)
  → its `.tex` path in the pak + recipe (`cut`, `top`, `inkRgb`, `downsample`).
- `.map/generate.py` — one-shot generator: murmur3 the path → extract from pak
  (`repak.py`) → decode BC1 (`tex.py`) → threshold → PNG. `PROGRESS i/n` lines, `DONE`.
- Un-ignore `.map/repak.py`, `.map/tex.py`, `.map/generate.py` (functional tooling,
  not game art — `.map/out/`, the RSZ registry and the path list stay ignored).
- PyInstaller `--onefile` → `resources/dd2-edgegen.exe`, shipped via electron-builder
  `extraResources`; npm script `build:generator`.
- `src/main/edgeGen.js` — locate install (running DD2.exe → image path; Steam
  `libraryfolders.vdf`; folder picker), spawn generator, parse progress.
- First-run prompt: "Add transparent (edge) maps? They'll be created from your game
  files — please wait until done." Prompt once (`edgeGenPrompted` flag); after that
  only via a **Regenerate** button in the control window.
- On success: mark edge art available, flip `mapStyle` to `edge`.

**Must verify first (highest risk):** `repak.py` must extract a *known* path from the
pak's own entry table without the 21MB path-list index. If it can't, bundle the list
inside the exe (fine — not committed).

Other knowns from the plan: `--onefile` unpacks to temp each start (switch to
`--onedir` if slow); build machine needs Python + PyInstaller + numpy/Pillow/zstandard.

## Smaller items

- **BC7 floors** — local areas 525 / 526 / 530 are BC7-compressed and skipped by the
  baker; they fall back to mapgenie's raster even in Edge style. Add BC7 decode.
- **Conflicting uiArea dungeon groups** — 11 groups where one uiArea id maps to
  multiple mapgenie dungeons; fix incrementally as they're visited in play.
- **Game dungeon id → mapgenie mapping** — the game's own dungeon id sits at
  `DD2.exe+FA62CB0`; `tools/zoneLog.js` is collecting pairs. Once enough are logged,
  the tracker can stop guessing by nearest entrance.
