# Dungeon art & the alignment tooling

Pulling the game's own dungeon minimap art out of memory, and the .map tools that align it to mapgenie's tiles.

See also: [dungeons & area tracking](dungeons-areas.md), [the paused inset re-resolve](inset-resolve-wip.md).

## Dungeon edge art (F9 in a dungeon) — data: URL, not a custom scheme
In a dungeon, F9 replaces mapgenie's raster with OUR baked wall/stair linework
(`%APPDATA%\dd2-map\edge\<LocalArea>.png`, served over the `app-tiles://` privileged
scheme). It goes in as a Mapbox `image` source pinned to the floor's four inset corners
(same transform as the marker) and a `raster` layer inserted below the first symbol
layer. Two things that cost debugging:
- **Mapbox GL's `image`-source loader does NOT go through Electron's `protocol.handle`,**
  so `{type:'image', url:'app-tiles://…'}` adds the source, fetches nothing, and errors
  nothing — a silent blank. `fetch('app-tiles://…')` DOES honour the scheme (from both the
  guest and the overlay host), so the overlay fetches the PNG, converts it to a `data:` URL
  via `FileReader`, caches it per floor, and hands *that* to the guest. A `data:` URL also
  survives the host→`<webview>` boundary; a `blob:` URL would not (origin-scoped).
- The edge only shows for a **placeable** dungeon — one with a transform in `areas.areas`.
  `AREA_TRUST` (0.30) gates game-derived transforms out of the merge, so the low-score
  dungeons had valid `c`/`f` but no marker and no edge. **RESOLVED 2026-07-19** by manual
  edge-map matching (below); the gate itself is unchanged and still correct.

  **Do NOT "fix" this by trusting `src:'game'` regardless of score** (the older
  `.map/IMPLEMENTATION_STATUS.md` fix direction — it is unsafe). The gated set was
  *dominated by the false-match-magnet subregions that section itself named*, and the
  correlation's error was worse than "imprecise translation": for 11 of 16 gated floors it
  had picked the **wrong subregion entirely**. And because `sweepAreas.py` takes an area's
  `title` FROM the matched subregion (`title = subs[sid]["title"]`), a wrong match stamped a
  wrong **name too** — four distinct game dungeons all read "Twilight Cave". So a low score
  there is a wrong panel, not an under-confident right one; blanket-trust would have placed
  and *misnamed* them.

  **How they were placed — manual edge-map matching (2026-07-19).** The baked edge PNGs
  ARE the game's dungeon linework, so the human eye can do what the correlation failed at:
  match each floor's linework to the right mapgenie inset. A throwaway gallery page
  (`edge PNGs on a light bg`) got the **subregion+floor corrections**; the floor *labels*
  were already right (game height data), only subregion+title were wrong. Those 11
  corrections went into `localAreas.json` (subregionId+title). Then a **drag-to-align tool**
  (a manual `matchInset`: mapgenie tiles as backdrop, our edge art overlaid at `insetLinear`
  scale, drag to fit → reads `c,f` off the alignment) placed all 16 precisely. Both pages
  were generated offline from `config/*` + `userData/edge/*.png`; tiles fetched at runtime
  from `tiles.mapgenie.io` (serves 200 with no auth/Referer). Placements are `src:"aligned"`.

  **The aligner exports a CENTER-anchored translation** and is scale-invariant on purpose:
  `insetLinear.scale` (1.9225) was a hair small — the user needed art-scale **1.048 on 15 of
  16** floors to make edges meet (Ancestral was the lone outlier at 0.68; see per-area scale
  below). Anchoring on the box center put the marker where the player walks and split the
  residual drift to the edges.

  **Global 2.0 rescale — DONE (2026-07-19), and the follow-up 1.9225 revert CANCELLED
  (2026-07-20).** The 2.0 value below stands, but read the "115 hand-alignments" note further
  down before touching the shared scale again: a plan to revert it to 1.9225 was cancelled
  when 115 dungeons aligned by hand all landed at scale **1.000**. The `1.048` that motivated
  2.0 was also not what it looked like — see the art-scale-slider trap in that same note.

  **Global 2.0 rescale — DONE (2026-07-19).** 1.9225 × 1.048 ≈ 2.0, the clean value mapgenie
  actually draws insets at. A center-preserving rescale of the shared linear (`a,b,d,e ×=
  2.0/1.9225`) with each area's `c,f` re-derived so its **box centre maps to the identical
  lng/lat** — every marker stays put, only edge-fit tightens (~4%). Categories: 126 boxed
  areas rescaled; Ancestral's per-area `scale` divided by g to hold its effective 1.31 scale;
  4 boxless legacy entries exempted (`scale = 1/g`, byte-identical); **7 stale subregion-keyed
  duplicates deleted** (Forgotten Tunnel/Trevo/Gracious Vaults/Ancestral — all superseded by
  LocalArea-keyed entries). **`insetLinear.derived` set to `false`** — essential, or
  `ensureInsetLinear` (index.js) re-derives it back to ~1.9225 on next launch and silently
  breaks every rescaled `c,f`. Script verified all 131 centres/transforms unchanged before
  writing. (Deferred: the 4 exempt legacy entries could be properly rescaled once their boxes
  are recovered from `areaTable`.)

  **Per-area scale — not every inset shares the scale (2026-07-19).** Ancestral Chamber
  (LA 545) is a genuine outlier: its mapgenie inset is drawn at **~0.68×** the shared
  scale, not the ~2.0 the other 15 agree on. In-game its marker drifted right OUT of the
  panel toward the SW while the player stood at the SW entrance — a marker over-spreading
  from its anchored centre, i.e. the transform scale was too large. `forArea` now takes an
  optional per-area `scale` that multiplies the shared linear (absent → 1, so the other 121
  areas are untouched); Ancestral carries `scale:0.68` with `c`/`f` recomputed
  centre-preserving. Verified in-game: marker aligns, edge still good.

  **The MARKER, not the edge, is the sensitive test for scale.** The edge art is an image
  stretched to fill `transform(box)`'s four corners, so a wrong scale still "looks perfect"
  — it just fills a slightly-too-big rectangle over a large panel. The marker maps a single
  live point through the same transform, so any scale error shows as drift that grows with
  distance from the anchor. A dungeon can read "edge perfect, marker outside the panel"; that
  combination means *scale*, and per-area `scale` is the fix (an offset instead would need the
  box corrected, and would break the edge when the marker is aligned).

  **Re-keying (2026-07-19).** The pointer stamps `areaKey = String(localArea)` and
  `forArea` looks up `areas.areas[areaKey]` directly, so a token entry keyed by
  **subregion** (`2492|`) is never found — the pointer emits the **LocalArea** (`512`).
  Guerco was re-keyed `2492|`→`512` (its subregion 2492 maps to exactly one LocalArea).
  Waterfall Cave (`2455|1F/2F`) and Rock Wall Berme (`2531|`) can't be re-keyed the same
  way: **no current LocalArea carries their subregion or title at all** — they're orphaned
  by a since-changed LocalArea→subregion mapping, reachable only via the deprecated tracker
  fallback. Placing them needs their LocalArea id first.

  **Single-source dungeon transforms — the clobber bug, and the fix (2026-07-19).** The 2.0
  rescale (above) *looked* applied, then silently reverted 95 `src:"game"` dungeons on the next
  launch: `mergeLocalAreas()` (`index.js`) copied `localAreas.json`'s `c,f` over `areas` **every
  startup, unconditionally** (`score ≥ 0.30`), and the rescale had only updated `areas.json`, not
  `localAreas.json`. So each restart re-installed the un-rescaled (1.9225-era) `c,f` while
  `insetLinear` stayed 2.0 — a constant translation of ~29% of a box's height (the "marker floats
  above the tunnel" report). The 16 `src:"aligned"` dungeons survived only because they're
  `score < 0.30` (gated out of the merge). Diagnosis: same-position reads across restarts, and
  `areas.json` `c,f` byte-identical to `localAreas.json`'s (not the rescale commit's).
  **Immediate fix:** rescale `localAreas.json` too (center-preserving 1.9225→2.0), format-
  preserving (line-level c/f edit — a full JS re-stringify *reorders integer keys numerically* and
  flips `e-08`→`e-8`, a 1356-line reformat; avoid it). **Structural fix:** dungeon transforms now
  live in an authored, **app-read-only** `config/dungeons.json`; `mergeLocalAreas`/`absorbAnchor`
  (doorway auto-calibration)/`ensureInsetLinear` and the in-app calibrate/Refine are deleted;
  `areas.json` keeps only `places`. `localAreas.json` stays for the pointer's metadata but its
  `c,f` are no longer read. The rule that killed the bug: **one writer per transform, and for
  dungeons that writer is us, not the app.** insetLinear in `dungeons.json` is absolute, so it does
  NOT track the world affine — re-calibrating the overworld no longer re-derives it.

  **115 hand-alignments settle the shared scale — and kill three plausible theories
  (2026-07-20).** After the clobber fix, 115 dungeons were aligned by hand against mapgenie in
  the rebuilt `.map/aligner.html`. Result: **every one landed at scale `1.000`** (the existing
  shared linear) except Ancestral (0.6615) and Ancient Battleground (0.5). Positions moved by a
  mean of **−0.00% / −0.30% of a box** (sd ~0.6%, max 2.5%) with **no correlation to map
  position** (r = 0.06 / 0.20) — i.e. hand-precision scatter centred on zero, not a systematic
  error. Consequences:

  - **The planned global revert to 1.9225 was cancelled.** One earlier single-dungeon test
    (`setScale 627 1.9225`, "fits again — almost, still slightly offsetted") had suggested it;
    115 independent fits outvote it. The scale was right all along, and the earlier "dungeons
    look wrong" symptom was the `mergeLocalAreas` clobber above, not the scale.
  - **The "aligned wanted 2.0 / game wanted 1.9225" split never existed.** It came from
    misreading the old aligner: `currentCF()` exports `c,f` against the **shared** linear,
    centre-anchored, and its art-scale slider is **purely visual** (its own comment says so).
    So the `1.048` dialled during the 16-dungeon pass was an observation about our *art extent*
    being oversized, never a transform factor. **If a tool's control doesn't feed its export,
    say so in the export** — that one silent decoupling produced a false scale story that
    survived two sessions.
  - **Ancient Battleground (450) sits at exactly 0.5× the inset scale = 1.0× world scale**,
    which suggests it isn't drawn as an inset at all.

  **Identity errors are common, and match score does not find them (2026-07-20).** 13 dungeons
  were pointing at the wrong mapgenie subregion. `473` ("Coastal Cavern B1F", really Mountain
  Shrine) was found by its tell — score 0.3507, barely over the old 0.30 trust gate, claiming a
  subregion whose real holder (349) sits ~2200 units away. But **`449` scored 0.7811 and was
  equally wrong** (also Mountain Shrine). So score is a triage hint, never a verdict; only eyes
  on the art settle it. Two structural signals do help and are now surfaced as flags in the
  aligner: a **low score on an entry never hand-verified**, and a **duplicate title+floor where
  this entry scores lower than another claiming the same label**. Corrections must update
  `subregionId` as well as the title — the pointer path feeds it to the overlay's POI filter,
  so a rename alone would leave the wrong floor's icons showing.

  **mapgenie's inset panels are not 1:1 with LocalAreas.** Mountain Shrine (sub 2489) is drawn
  as a **single 1F panel** that the game splits across **three** LocalAreas (449, 473, 474).
  Expect duplicate labels to be legitimate sometimes; the game's subdivision is finer than
  mapgenie's.

## The alignment tooling (`.map/*.html`, 2026-07-20)

Three generators, all writing self-contained pages that fetch mapgenie tiles live. Run
`node .map/gen<X>.js` to rebuild; editing the generator alone does nothing until you re-run it.

- **`genWorldMapAligner.js` → `worldMapAligner.html`** — drags our whole baked overworld map
  (`world.png`, game box ±4096) onto mapgenie's tiles to solve the **world affine**. This is
  what produced the conformal calibration. Aligning *cities individually* was tried first and
  abandoned: each city could be made to fit, but no single transform satisfied all of them at
  once, which is exactly what a one-piece overlay makes unambiguous.
- **`genDungeonAligner.js` → `aligner.html`** — per-dungeon alignment for all 113 dungeons with
  baked art. Exports the **full** transform (`a b c d e f` + rotation), not just `c,f` against a
  shared linear — that assumption is what hid the scale story. Carries ✓/✗/? verdicts plus a
  free-text note per tile (same pattern as `edgeGallery.js`) so identity errors can be reported
  in the same paste as the transforms, and flags suspect tiles (see above).
- Art is referenced by **`file://`**, not base64: embedding all 127 PNGs made a 12.5 MB page
  versus 43 KB. Requires opening the page from the local filesystem.

Two things learned the hard way in this tooling:

- **mapgenie's world-v1 tiles stop at z16** (z17+ is HTTP 403, verified at two locations). Zoom
  must therefore be an integer tile level clamped to ≤16 **plus** a fractional CSS scale;
  otherwise zooming past the fixed level just upscales blurry tiles while sharper ones exist.
- **Overworld areas must be excluded from the dungeon aligner.** Towns/cities (`overworld:true`)
  ride the *world* affine, not `insetLinear`, so drawing them there puts them at ~2× scale in
  empty space with no art beneath — which reads as "the tool is broken" but is correct
  behaviour applied to the wrong set.

