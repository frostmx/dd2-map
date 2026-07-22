# Re-resolving dungeon insets (WIP)

Paused work rebasing every inset translation onto the 2026-07-20 world affine. Read this before touching config/dungeons.json.

See also: [dungeon art & alignment](dungeon-art-and-alignment.md), [dungeons & area tracking](dungeons-areas.md).

## Re-resolving dungeon insets after the 2026-07-20 recalibration — IN PROGRESS, PAUSED

The world affine was re-solved by hand into a pure similarity (see CLAUDE.md "World
affine"). Every inset translation in `dungeons.json` is therefore expressed in the OLD
frame. This section is the state of putting that right; **nothing has been promoted into
`config/dungeons.json` yet.**

### The tooling was dead before this started

`.map/matchInset.py` read `insetLinear` from `config/areas.json`. Since the single-source
refactor that file holds **only `places`**, so the module raised `KeyError` at *import* —
the art matcher could not run at all, and neither could `sweepAreas.py` or `blindSearch.py`,
which both `import matchInset`. Fixed: it reads `config/dungeons.json` now.
**`.map/dungeonAligner.js:4` still has the identical bug and is still broken.**

### z16 is not a preference, it is the exactly-right resolution

- mapgenie's tiles top out at **z16**, which at the inset scale is `2**16 * 256 / 360 *
  insetLinear.a` = **8.00 px per game unit**.
- the game's own minimap texture is `TexSize 2048` over a `TexRange 256` box — also
  **8 px/unit**.

Both sides of the correlation are natively 8 px/unit, so z16 matches art to art with no
resampling loss on either side. `sweepAreas.py` runs `SWEEP_Z = 14` (2.0 px/unit) and
**produced 95 of the 121 placed floors** — it was downsampling both the tiles and the game
art 4x. (Note both `SWEEP_Z`'s comment and `refine()`'s docstring claim z14 is "~1px/unit";
it is 2.0. They understate their own resolution by 2x.)

### The `ncc` block trap — this is the one that costs hours

`blindSearch.ncc(image, templ, block=1536)` raises the block to `max(block, th+64, tw+64)`,
then tiles the image in steps of `block - template`. A z16 template is ~2048px, so the
**default 1536 becomes 2112**, and a 2400px search window is covered in steps of **64** —
**36 overlapping 2112px FFTs** for what one FFT over the window computes. That is
~2 min and 1.7 GB per floor; the whole sweep would be 3-4 hours.

Passing a block that **exceeds the window** takes the single-block path:
**~2 min -> 1.3 s per floor, ~100x.** `refine()` now takes a `block` param (default 1536,
unchanged for existing callers); `resolveInsets.py` passes `--block 4096 --pad 0.04`.

This is also why `matchInset.refine`'s docstring says z16 is "far too slow for a 135-floor
sweep" and why `sweepAreas` dropped to z14 — **that conclusion was a symptom of the block
bug, not a real cost of z16.** z14 may not have been necessary at all.

### `.map/resolveInsets.py` — the resolver (written, validated, not yet swept)

Seeds each floor by shifting its stored translation to the new linear (pinning the game
box centre), then re-derives it by art correlation at z16. Writes
`config/dungeons_resolved.json` — **never** `dungeons.json`, which stays app-read-only and
hand-promoted.

Verified offline: all **121** placed areas join to an `areaTable` row (zero missing);
`insetLinear` recomputes to `a = |e| = 0.000171622866`, `b = d = 0`; `545` copied through
byte-identical; the 14 unplaced entries keep their nulls.

- **`545` Ancestral Chamber is skipped by request** (`SKIP` set) — 0.65x scale, hand-tuned.
- The **8 legacy `subregionId|floor` keys get rebase-only**: no `LocalArea` row means no
  game box, so no template can be rendered and no art match is possible. They are a tracker
  fallback anyway, and their stored `points` anchor reproduces their `c`/`f` to 0.0u, so
  the arithmetic rebase is exact at that point.
- Rejected matches keep the **seed**, not the old value — a floor mapgenie lacks still gets
  the calibration fix, and is flagged rather than written as confident.

### Two things to settle before trusting a full sweep

1. **The score gate is apples-to-oranges.** It compares a z16 score against the z14 score
   from `areas_solved.json`. On the one floor measured, 342 scored **0.730 at z16 vs 0.746
   at z14** — *lower*, as expected (more resolution = more detail to disagree on: JPEG
   artifacts, texture-vs-raster). `REGRESS = 0.05` absorbed it here, but if that penalty is
   systematic and larger anywhere, good matches get rejected and silently kept on the
   rebase. Fix the gate (drop the cross-zoom check, or re-score the incumbent at z16) —
   do **not** tune `REGRESS` until the numbers look nice.
2. **Is the sweep worth it at all?** 342 moved only **0.3u** from the rebase. If that holds,
   the arithmetic rebase is already accurate and z16 only buys precision. One floor is not
   a sample — this is exactly what the paused 5-floor run was meant to answer.

### State of `config/dungeons.json` right now — CHECK THIS FIRST ON RESUME

It is **half-migrated**, and not by this work: at 01:34 on 2026-07-20 `b`/`d` were zeroed
but **`a`/`e` were left at the old `0.00017151956164229506`** (should be `0.000171622866`),
and the `c`/`f` were shifted ~1.8u by a partial rebase. `resolveInsets.py` deliberately
recomputes `insetLinear` from `calibration.json * 2` rather than trust it. Safe because the
match is art-based: a wrong linear can only mis-seed, and a mis-seed collapses the score
rather than producing a confident wrong answer.

### Resume

```
python -u .map/resolveInsets.py --dry                      # seeds only, no network
python -u .map/resolveInsets.py --only 375,342,343,337,338 \
    --out config/dungeons_smoke.json > .map/smoke.log 2>&1  # the paused 5-floor sample
python -u .map/resolveInsets.py > .map/sweep_z16.log 2>&1   # full sweep
```

**Never pipe these through `tail`/`grep` without `--line-buffered`** — output buffers until
EOF, and a run killed mid-way leaves an empty log (cost two debugging rounds here). Also
note the interpreter is **`python3.12.exe`**; filtering `tasklist` for `python.exe` returns
"no matching tasks" and reads exactly like a dead process on a live one.

Tile cache is at `.map/tilecache/<z>/`, keyed by zoom, 404s memoised; z16 held ~3169 tiles
at pause. A full z16 sweep needs an estimated 8-10k, so it warm-starts.
