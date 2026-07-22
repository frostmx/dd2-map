# Almanac data & the AR layer

The vendored Almanac coordinate dumps, and the camera-space AR marker layer that projects them onto the game.

See also: [memory & RE](memory-re.md), [managed singletons](singletons-and-clock.md).

## Seeker's Token ground truth (2026-07-17): 240 exact correspondences, free

The Sphinx's Riddle of Rumination made someone dump every Seeker's Token position, and
that dump is a calibration dataset better than anything we can produce by playing:
**240 points known exactly in BOTH coordinate systems** — game world coords on one side,
mapgenie markers on the other.

**Game side:** [gibbed's `gibbed_RiddleOfRuminationMarker.lua`](https://github.com/gibbed/DD2-REFramework-Scripts/blob/main/gibbed_RiddleOfRuminationMarker.lua)
has all 240 inline, keyed by GUID, as engine `(x, y, z)` = our `(x, h, y)` (RE Engine is
y-up — same axis order as the position struct). The repo's `docs/gimmicks.csv` is the
gimmick-id→name dictionary. His Almanac mod's beetle/chest JSONs are **Nexus-download
only**, not in the git repo — but see the endpoint below, which makes them unnecessary.

**mapgenie side — the endpoint that beats scraping:**

```
https://mapgenie.io/api/v1/maps/599/full        (browser User-Agent required)
```

returns every location on the DD2 world map (5372 of them, all categories — tokens,
chests, beetles, everything), nested under `groups[].categories[].locations`. Seeker's
Token is category **10735**. This is the same data the SPA loads, without the Redux
store, the webview, or the app running. (`api/v1/maps/599` = map metadata; the
`window.mapData` blob embedded in the page HTML has categories but NOT locations.)

**What matching them proved (run 2026-07-17, scripts in session scratchpad):**

- 211/240 tokens pair 1:1 through the world affine at <30u, **median error 4.6u**.
  The 3-click world calibration is fine; most of the 4.6u is mapgenie's hand-placement.
- The 29 leftovers are dungeon tokens. 18 of them land on already-calibrated inset
  panels at **0.2–10u** (Dragonsbreath 5F 0.2u, Forgotten Tunnel B1F 1.0u, Twilight ×3
  ≤2.6u…) — independent proof, across ~13 dungeons, that one shared `insetLinear` +
  one-correspondence-per-panel is *correct*, not just convenient.
- Three tokens in Forbidden Magick Research Lab imply the same translation within 5.5u
  **and** agree (3.7–6.4u) with the LocalArea solver's score-0.22 solve for id 337 —
  two independent methods converging on an id that sat below `AREA_TRUST`. Written to
  `areas.json` as `"337"` with `src: "tokens"`.
- Also written: `2531|` (Rock Wall Berme, no prior entry) and `2455|1F`/`2455|2F`
  (Waterfall Cave — the floor labels are **provisional, ranked by token height**;
  `floorHeights` seeded from the tokens' h with `n: 1` so real visits refine them).
- **`src: "tokens"`** = translation solved from a token correspondence; both halves
  absolute, so these entries pool/merge exactly like `points`-bearing ones.

**Trust ordering (by data provenance, not by who typed it).** When two transforms for
the same panel disagree, prefer the one whose inputs passed through fewer human hands:

1. **Trusted correlation solves** (`src: "game"`, score ≥ `AREA_TRUST`) — the game's own
   inset texture image-correlated against mapgenie's drawn panel (`matchInset.py`). No
   human placement anywhere in the loop. Beats everything.
2. **Token pairs** (`src: "tokens"`) — game half exact (from the dump), map half a
   hand-placed mapgenie marker (median ~4.6u error, occasional 60u blunders).
3. **Doorway crossings** (`auto: true`) — player *near* a door ↔ hand-placed portal marker.
4. Manual 3-point clicks.

Consequences applied 2026-07-17: Trembling Hollow keeps its trusted solves (the token
disagreed by 60u — that indicts the *marker*, rule 1 beats rule 2); Guerco Cavern got
the token entry `2492|` (its correlation solve scored 0.299, below trust — an untrusted
correlation loses to an exact game coordinate, rule 2 beats a failed rule 1).

**Known-bad mapgenie markers (do NOT "fix" our transforms to match them):**

- Trembling Hollow 2F token (mapgenie id 330232) sits ~60u off the *trusted* LocalArea
  solves for 418/419. The trusted solves win; the marker is misplaced.
- Guerco Cavern token (330589, "down in the ravine") is 255u from the score-0.299 B1F
  solve — the solve is below trust, so the token won (see trust ordering above). Keyed
  `512` with floor `B1F` (re-keyed 2026-07-19 from the subregion form `2492|`, which the
  pointer never looks up — see "Re-keying" below). If the correlation solver later scores
  Guerco ≥ trust and disagrees, the solver wins and this entry should go.
- Two tokens (330995, 331021) fall inside no inset bbox at all.

**Stale numeric entries in `areas.json`.** The `src: "game"` numeric keys are a snapshot
of an *older* LocalArea mapping: disk says `"341"` = Waterfall Cave, current
`localAreas.json` says 341 = Vernworth, and the disk transform projects outside
mapgenie's Waterfall bbox entirely. `mergeLocalAreas()` only overwrites ids the current
solver *trusts*, so stale low-score ids linger on disk forever. Worth a cleanup pass:
drop any `src: "game"` entry whose id is absent (or renamed) in current `localAreas.json`.

**Unused headroom:** multi-token panels are over-determined — a least-squares over them
could *measure* the inset scale and settle "Not done yet #3" without the manual 3-point
calibration. The tokens fitting existing panels at 0.2–7u already says the derived 1.92
is very close.

## The full Almanac dataset is vendored: `data/almanac/` (2026-07-17)

gibbed's Arisen's Almanac position dumps (from the Nexus zip, mod 194 — his git repo has
only the Lua), checked into `data/almanac/<gimmickId>.json`. Format per file:
`{ author, description, game, see_also, locations: { "<guid>": {x, y, z} } }` — engine
y-up, so `(x, y, z)` = our `(x, h, y)`. Contents:

| file | what | count |
|---|---|---|
| `167.json` | Seeker's Tokens | 240 |
| `161.json` | Golden Trove Beetles | 78 |
| `10/11/12.json` | Chests S / M / L | 599 / 217 / 63 |
| `495.json` | Chests XL ("sunken", mostly post-game) | 83 |
| `692/693/694.json` | Special chests S / M / L | 1 / 4 / 1 |
| `13/653/465.json` | Sphinx's opulent chests / Sphinx-sealed L | 1 / 1 / 10 |

**Beetles (matched 2026-07-17): all 78 pair 1:1 with mapgenie at median 3.9u, max 21u,
no dungeon tail** (beetles are all overworld). mapgenie's 4 extra beetle markers are not
world spawns: 3 merchant-sold (Folkes, Mubarak, Angus) + 1 quest reward (*The Gift of
Giving*) — 78 + 4 = 82 obtainable, both datasets right, different questions. The 4 can
never be tracked by gimmick state; they're inventory transactions.

**Chests (20-sample, 2026-07-17): mapgenie only maps 435 of 968 chests (~45%).** The
sample matched 9 overworld (2.3–12u) + 8 on insets (2.8–14u, more independent panel
confirmations); the 3 misses are most likely chests that simply aren't on mapgenie —
with under-half coverage, "nearest marker" for an unmapped chest is a different chest.
So for chests the game dump doesn't validate mapgenie, it **supersedes** it: 533 chests
mapgenie doesn't have, plus S/M/L/XL size classes mapgenie doesn't distinguish.

**Collected-state mechanics** (from `gibbed_Almanac.lua`, per type):

- Tokens — global: collected GUID goes on `app.GenerateManager._NeverGenetateID`
  (Capcom's typo). Offline fallback: `GimmickContext:isOnFreeBit(16)` via the
  ContextDB. **Read live and shipped** — see "Collected-token filtering" below; the
  set turned out to hold every collectible type that uses this mechanism (394 GUIDs
  live on one save vs. 240 known tokens), not tokens only.
- Beetles — live gimmick `get_IsBroken()`; persistent via ContextDB
  `GatherContext:get_Num() <= 0`.
- Chests — live gimmick `get_IsOpenedFreeBit()`; persistent via ContextDB
  `GmItemContext:get_IsPick()`.
- The ContextDB path: `app.ContextDBMS` → `IndexCreator.UniqueID2Keys`
  (Dictionary<Guid, key>) → `Records[key.KeyForSystem]` → record's context object.
  Out-of-process that's a managed-Dictionary walk — doable, but the cheap variant is
  tokens-only via `_NeverGenetateID`, and live-nearby chests via
  `GimmickManager.getGimmickList(id)`.

The GUID↔mapgenie-location-id pairing table is derivable on demand: `data/almanac/*.json`
(game side) × the `api/v1/maps/599/full` endpoint (mapgenie side) × the matching pass
described above — the world affine, then the [inset transforms](dungeons-areas.md).

## Camera frame + AR token layer — SHIPPED (2026-07-17)

The player's world position was already solved; this adds the camera's full
**orientation** and **dynamic FOV**, and uses both to project Seeker's Token world
coordinates onto the overlay exactly where they are in 3D — a finder that draws through
walls, not a 2D map marker.

### Finding the camera transform (`tools/cameraHunt2.js`)

The existing camera-position chain (`config/dd2.offsets.json → cameraPosition`) gives a
point, not an orientation — no basis, no fov. Scanned for both, using the same
"relation, not value" trick as the original camera hunt:

- **World-matrix scan**: swept all private RW memory for a live-camera-position match
  embedded at `+0x30` of a block whose leading 3×3 is orthonormal (row length 1,
  mutually perpendicular) — **zero hits**. RE Engine does *not* store the camera as a
  packed row-major 4×4 with position folded in; a dead end worth recording so it isn't
  retried.
- **`RECamera`-component scan**: swept for the constant signature
  `[near 0.01–10][far 100–1e6][fov 20–120][lookAtDistance][pad][aspect 1.0–2.7]`
  (layout from REFramework's `ReClass_Internal_DD2.hpp`, MIT) — 508 hits. Filtered by
  tracking which candidates' `fov`/`lookAtDistance` actually **moved** while playing
  (aim/sprint) — down to 2, and the one with `aspect ≈ 16:9` (the other was an off-screen
  probe camera at aspect 1.0) is the real one.

**Two-phase, not interactive-single-run**: `node tools/cameraHunt2.js scan` (stand still)
then `node tools/cameraHunt2.js track` (swing the mouse for 10s) — split because this
harness's `!` shell channel cannot feed a running process's stdin, so a single
`readline`-prompting script would hang forever on the first prompt.

### The structural chain (durable — walks from a singleton, not a hardcoded address)

```
app.CameraManager (singleton, via the RPM chain above)
  instance +0x10  -> _CameraObjects (fixed array)
  array    +0x20  -> [0] the camera's REGameObject
  GameObject +0x18 -> RETransform
    Transform +0x80  -> worldTransform 4x4: row0 right, row1 up, row2 forward,
                         row3 position (LOCAL frame — see below)
    Transform +0x18  -> childComponent = RECamera
      RECamera +0x30 near, +0x34 far, +0x38 fov(deg), +0x3C lookAtDistance, +0x44 aspect
```

Verified by walking `_CameraObjects[0]` end-to-end and finding it *is* the same
component `cameraHunt2.js` found by scanning — not a coincidence, a structural fact.
Recorded in `config/singletons.json` under `cameraChain`, alongside the
`app.CameraManager` entry that `--fields`/`--save` also resolve.

`src/main/cameraFrameReader.js` reads this chain, sanity-checks the basis (unit length,
mutual orthogonality) and fov/aspect range, and returns `null` on any failure — the AR
layer holds its last frame rather than drawing from garbage.

### Two floating-origin gotchas, both cost real debugging time

**The camera's world matrix is in the LOCAL (cell-relative) frame**, unlike the
already-solved camera *position* chain which reads the global mirror directly. Fix:
main computes `frameOffsets = { x: g.x - localX, h: g.h - height, y: g.y - localY }`
from the ordinary position poll (updates only at cell crossings) and the fast camera
loop adds it to `posLocal` every read — same technique as the world/local player split,
just applied to a third source (the transform) instead of two.

**The floating origin rebases the VERTICAL axis too, not just x/y.** This was assumed
false and cost a full misdiagnosis: earlier position code only ever compared local/global
x and y, so nobody had checked height. Measured directly: local mirror height and global
height differed by up to several hundred units depending on where the offset happened to
land — e.g. one session showed global height 236.29 against local 8.29 at the same
instant. The existing `height` field (used by floor-learning, untouched) stayed
local-frame; a new `heightGlobal` field on `game-position` and `offH` in the camera
rebase both use the *global* player height for the delta, exactly like x/y.

### The projection

Standard pinhole math against the camera basis, with two conventions worth recording
because both were wrong on the first attempt and only in-game testing caught them:

```js
depth = viewSign * dot(fwd, target - camPos)
ndcX  = -(viewSign * dot(right, target - camPos)) / (depth * tan(fov/2) * aspect)
ndcY  =  (viewSign * dot(up,    target - camPos)) / (depth * tan(fov/2))
```

- **`viewSign`, not a fixed handedness constant.** The player is always in front of a
  chase camera, so `sign(dot(fwd, player - camPos))` *is* the view direction — read
  fresh every frame instead of trusting RE Engine's convention (which the codebase had
  no independent way to confirm). Self-calibrating: correct regardless of whether `fwd`
  points where the camera looks or its negative.
- **`ndcX` is negated.** Without the negation, tokens mirrored left/right — confirmed
  visually in-game (turn to put a token on-screen-left; it drew on the right). Recorded
  as a verified fact, not derived from an engine-handedness argument, because the
  argument alone got it wrong once already.

### Two more measured constants — the Almanac's vertical frame, and eye-vs-feet

**`ar.heightOffsetU = 100`, exact.** gibbed's Almanac x/z match the game's runtime
ground frame with zero measurable offset (confirmed repeatedly: standing on a token,
horizontal distance ~0–2u). But Almanac **height** (engine-y) is in a *different*
vertical origin. Measured by standing dead-on a token and reading both: player global
height 207.96, token raw `y` 107.95 → gap **100.01**. A second reading elsewhere gave the
same constant, so it's added as a flat `heightOffsetU` to every POI height, not derived
per-POI.

**The camera doesn't aim at the feet.** The player position feed is ground-level (feet),
but `dot(fwd, direction-to-target)` peaks at **feet + 1.4u**, not at the feet themselves
— measured directly (−0.91 alignment to feet vs −0.998 to feet+1.4). For a distant token
this is invisible; for one you're standing on (camera only ~3u away) it visibly pulls the
marker down and produces rotation-dependent drift when orbiting close — the "marker
floats in different directions" symptom, which is real geometry (aim point ≠ feet), not
a bug in the projection.

**Fix: a distance-faded cosmetic float**, `floatU = 1.6` ramping in from 0 (on top of
the collectible) to full at `floatFadeU = 8`u away:

```js
liftFraction = min(1, distanceToPlayer / floatFadeU)
markerHeight = trueHeight + floatU * liftFraction
```

A flat float was tried first and rejected: 1.6u lifted a 2u-away token by ~39° of visual
angle (way off), while being invisible past ~15u. Fading by distance makes the marker
land exactly on a token you're standing over and float for visibility at range — best of
both, verified in-game ("lands right on it").

### Feed rate: matched to the renderer's clock, then decoupled from it entirely

Camera reads run on their **own timer**, separate from the 30Hz position poll — a stale
basis during a pan visibly swims (33ms of lag became tens of pixels of drift on distant
markers, where angular error matters most). First fix: match the overlay's
`requestAnimationFrame` (~60Hz) 1:1 — but two independent 60Hz clocks (Node's
`setInterval`, the display's vsync) still drift in and out of phase, plus a >60Hz
monitor outruns a 60Hz feed entirely, so a residual beat-frequency judder remained.

**Real fix: interpolate in the renderer, decoupling feed rate from judder completely.**
The overlay keeps the last two `camera-frame` messages with arrival timestamps
(`performance.now()`) and draws from a camera sampled at `renderTime = now -
camInterpMs` (must exceed the feed interval so two real samples straddle it), lerping
position/fov/aspect linearly and re-normalizing the basis vectors after lerping. The scene
runs slightly latent (invisible except on very fast flicks) but is judder-free regardless of
feed rate, monitor refresh, or phase — the right fix for "camera feed vs vsync" mismatches
generally, worth remembering for any future 60Hz+ overlay work. (The player position is
interpolated the same way but at its own, larger delay — see "Smoothing the AR markers".)

### Smoothing the AR markers — SHIPPED (2026-07-19, was `prompts/ar-smoothness.md`)

The markers were juddery on movement and blinked on the camera swing. Instrumented first
(temporary `[ar-metrics]` overlay logging: feed inter-arrival, real rAF rate, `a`-clamp
rate, per-frame draw cost, blink diagnostics), which named the causes instead of guessing —
and immediately **exonerated two red herrings**: draw cost was **0.2ms/frame** (Canvas2D is
nowhere near a bottleneck; WebGL would change nothing — the judder is data, not draw) and
the overlay rAF ran at **79–118fps** (not Chromium-throttled). Three real fixes:

1. **`interpMs` default was 8ms, far below the feed** — the `a` factor pinned high **68%**
   of frames (freeze-on-latest then jump = the judder). The on-disk `ar` block carried no
   `interpMs`, so the too-small default applied. Raised it; the freeze-jump vanished.
2. **The player wasn't interpolated** — only the camera was. `arPlayer` stepped straight off
   the 30Hz feed, so everything derived from player *distance* (the float, culling, marker
   size/alpha) stepped too = the **blink**. Gave the player the same two-sample timestamped
   interpolation as the camera (`arSamplePlayer`). Blink gone.
3. **Camera and player use DIFFERENT render delays, on purpose.** A marker's on-screen
   *position* depends only on the camera (POI vs camera basis) — the player only gates
   culling/size/alpha/float, all slow and latency-insensitive. So `camInterpMs` (camera) can
   be small for low rotation lag while `interpMs` (player) stays larger to cover its slower,
   jerkier feed without re-blinking. This broke the single-knob floor.

**The latency floor was the Windows timer, not the code.** The camera feed is a main-process
`setInterval`, which Windows floors at its ~15.6ms quantum: `setInterval(8)` and `(16)` BOTH
measured ~26ms, pinning the smooth `camInterpMs` floor at ~28ms (below it the feed can't
straddle a smaller delay → HIGH clamp → judder; 16ms was tried and clamped 41% high).
`src/main/timerResolution.js` calls `timeBeginPeriod(1)` (winmm.dll, via koffi — already a
dep; paired with `timeEndPeriod` on `will-quit`) to drop the quantum to 1ms. The feed then
measured **~16ms** (camera, frame-quantized) and **~33ms** (position, its nominal), which let
`camInterpMs` come down to **18ms** at ~1% high clamp — roughly **halving the rotation lag**
while staying blink- and judder-free. Final: `camInterpMs 18`, `interpMs 30`, `camTimer 8ms`.

nlerp (lerp + renormalize) on the basis was never the residual problem and slerp was not
needed. Capture-time timestamps (frames are still stamped on IPC arrival) were left for
later: after 1–3 above the arrival jitter was not the dominant term. Tuning is by measured
number — re-add the `[ar-metrics]` block (git history) to re-measure before retuning.

### Off-screen handling and mode coverage

Markers whose `|ndcX|` or `|ndcY|` exceeds 1 clamp to the border (`edge = 0.94` of
half-screen) as outward-pointing arrows rather than disappearing, direction computed
from `atan2(-ndcY, ndcX)` in screen space; capped to the nearest `edgeMax = 12` so a
dense token cluster doesn't wall the whole border. **Behind-camera tokens** (`depth ≤
0.1`, where the perspective divide is meaningless) are pushed far out along their
*screen-plane* direction `(sr, su)` normalized ×10, which clamps to the correct edge and
stays continuous with the front-facing case as a token crosses behind the player.

The AR canvas (`#arCanvas`, `z-index: 10`, `pointer-events: none`) sits above the map
`<webview>` by stacking order alone, so it draws correctly in **every F9 mode**
(icons/map/window), not just icons-only.

### Config: `overlay.json → ar` — code/JSON tuning, never UI-authored

`arCollectibles` (checkbox, default on — renamed from `arTokens`, which `load()` still
honours for upgraders) is the only AR setting exposed in the control window; it toggles
both tokens and beetles together. Everything else is a knob in `overlayConfig.js
DEFAULTS.ar`, merged like `hotkeys` so a
saved file predating a new knob doesn't shadow its default (`ar: {...DEFAULTS.ar,
...saved.ar}`). **The reverse trap was live and is now closed**: `save()` used to persist
the *merged* config, so the first UI checkbox toggle would have frozen the entire `ar`
block (all current values) into `overlay.json`, silently shadowing every future
`DEFAULTS.ar` code change from then on. `overlayConfig.save()` now strips `ar` back out
before writing unless the user hand-edited one into the file themselves — the block is
tuning-by-code (or manual JSON edit), never tuning-by-UI-drift.

Knobs: `radiusU` (200), `markerPx` (14), `labels` (true), `heightOffsetU` (100, physics —
don't retune by feel), `floatU`/`floatFadeU` (1.6/8, cosmetic), `interpMs` (30, PLAYER render
delay — blink↔lag), `camInterpMs` (18, CAMERA render delay — rotation lag↔judder, falls back
to `interpMs`; see "Smoothing the AR markers"), `edgeMax` (12), `collectedPollMs` (3000, see
below).

### Data source

`data/almanac/167.json` (Seeker's Tokens) and `161.json` (Golden Trove Beetles), both
vendored — see the ground-truth section above — loaded once via `ar:pois:load` IPC into
`{guid, kind, x, h, y}` triples (engine axes, no conversion needed — matches the position
feed's convention directly), `kind` driving the marker style: `'token'` = green circle,
`'beetle'` = yellow diamond, `'chest'` = blue square (chests not wired as POIs yet).
This list is static for the session; collected-state filtering (below) happens at render
time against a separately-pushed live set, not by re-fetching this list.

### Collected-token filtering — SHIPPED (`src/main/generateManagerReader.js`, 2026-07-17)

Tokens you've already picked up no longer draw. The mechanism is
`app.GenerateManager._NeverGenetateID`, already flagged above as the pending unblock —
this closes it. What we didn't know going in was the field's *internal* layout: gibbed's
Lua only calls `:GetEnumerator()/:MoveNext()/:get_Current()` on it (confirmed by fetching
`gibbed_NeverGenerateDumper.lua`), which goes through REFramework's CLR reflection and
never needed to know raw memory layout the way pure RPM does. RE Engine's `via.clr` VM
is Capcom's own reimplementation, not real CoreCLR, so a textbook layout couldn't be
assumed — it had to be read out of the live TDB and probed.

**Tooling first:** `tools/singletonHunt.js` got a `--deref <TypeName> <fieldName>` mode
(a generalization of `--fields`) that resolves a named field's offset, dereferences its
live pointer, and dumps *that* object's own field table with live values — turning
"reverse-engineer a nested field's layout" into one command instead of hand-computing
offsets. `node tools/singletonHunt.js --deref app.GenerateManager _NeverGenetateID`
revealed the field is a `HashSet`1<System.Guid>` whose own fields (`_buckets`, `_slots`,
`_count`, `_lastIndex`, `_freeList`, `_comparer`, `_version`, plus static
`Lower31BitMask`/`StackAllocThreshold`/`ShrinkThreshold`) are a **verbatim match for
real .NET's `System.Collections.Generic.HashSet<T>`** — the VM mirrors the BCL's own
layout here rather than a custom one, which is not something to assume elsewhere without
re-checking.

**The rest was manual probing** (not automatable yet — a boxed-value hop the tool
doesn't follow): `_slots` array data starts at `array_object + 0x20`; each `Slot` packs
into **16** bytes, not the BCL's nominal 24+ (`{hashCode: i32 @0, next: i32 @4,
valuePtr: i64 @8}`) — the VM **boxes** the `Guid` generic argument rather than storing it
inline, so `value` is a pointer, not embedded bytes. `valuePtr + 0x10` (the same
"+0x10 past the header" convention every managed object in this codebase uses) is the
raw 16-byte `Guid`, decoded with .NET's real byte order (Data1/Data2/Data3
little-endian, Data4 raw) to match `data/almanac/*.json`'s string keys. Full chain
recorded in `config/singletons.json`'s `neverGenerateChain` block.

**It is not tokens-only, but it is NOT beetles either.** On the save it was read from,
the set held ~396 GUIDs; only ~71 matched known token IDs, and **zero** matched the 78
Golden Trove Beetle GUIDs. So `_NeverGenetateID` is a broader "never respawn this rolled
id" record (the ~320 others match no vendored almanac file at all); tokens just happen to
also be gated by it. A caller must intersect against its own known-GUID list, which
`generateManagerReader.js` and the AR filter do implicitly (the almanac token list only
supplies token GUIDs). Beetles needed an entirely different mechanism — see below.

**Wiring:** `src/main/index.js` polls this on its own timer (`ar.collectedPollMs`,
default 3s) — deliberately decoupled from the 30Hz position poll and the 60Hz camera
feed, since collected-state changes at most a few times per session. It diffs against
the last-broadcast set and only sends `collected-tokens` (same generic
`broadcast`/`onCommand` channel as `camera-frame`) when it actually changed. The overlay
(`overlay.js`) keeps a `collectedGuids` `Set` and skips matching POIs in the AR render
loop — `arPois` itself is never re-fetched, so a collectible picked up mid-session drops
out without needing a reload. (The same timer now also unions in collected beetles.)

### Golden Trove Beetle collected-state — SHIPPED (ContextDB + live gimmick, 2026-07-17)

Beetles are the second AR collectible. Their collected-state needs **two** reads unioned,
because neither alone is complete — a subtle but important split:

- **Persistent (`src/main/contextDbReader.js`)** — the save-wide **ContextDB**, global like
  tokens' `_NeverGenetateID`. But the ContextDB is the *save* database: `GatherContext`'s
  byte only flips to collected when the game **writes the save**, so it *lags* an in-session
  gather until you save. It's authoritative after any save/reload.
- **In-session (`src/main/gimmickReader.js`)** — the **live gimmick** flag, which flips the
  *instant* you gather, while the beetle's gimmick is still loaded (you're standing on it).
  It covers the window between gathering and saving that the ContextDB misses.

Union them and a gathered beetle's marker disappears immediately **and** stays gone across
reloads. `config/singletons.json` has both `beetleContextChain` and `beetleGimmickChain`.
**Verified in-game (2026-07-18):** marker vanishes the moment you gather (live gimmick), and
is still gone after a save+reload (ContextDB) — the single-read versions each failed one of
those halves.

**Why the ContextDB is unavoidable (not just the gimmick).** A **collected beetle does not
respawn a gimmick at all** — reload a save and a gathered beetle simply isn't created in the
world, so there's no object to read a flag off. The live-gimmick read can therefore only
ever see beetles you're near *this session*; anything collected in a past session is invisible
to it. That's exactly what the ContextDB supplies. (Symmetric gotcha the other way: the
ContextDB lags until save — hence the union.) Two false starts while finding the gimmick
flag: a light/timer float at `+0x3f8` that self-drifts with the day/night clock, and a
co-located *lantern* gimmick of a different type — both dodged by diffing a **0-drift alive
baseline** of the exact object. The gimmick flag itself is byte `+0x3e4` (one of 7 that flip
together on gather); the beetle gimmick type is `app.Gm82_009` (`Gm82_080` is the almanac's
data-group id), matched to an almanac GUID by world position (`gimmick +0x10` GameObject →
`+0x18` Transform → `+0x80` worldMatrix `+0x30` pos, plus the cell-local→global frame offset).

**The ContextDB walk** mirrors what `gibbed_Almanac.lua` does with managed calls, done
out-of-process (fetched the mod to get the chain right). `app.ContextDBMS` is a resolved
singleton; from it:

- `ContextDBMS +0x10+0x08` → `OfflineDB` (== `CurrentDB` in single-player), a
  `ContextDatabase`.
- `ContextDatabase +0x10+0x18` → `IndexCreator` (`app.TowerContextDatabaseIndexCreator`);
  `+0x10+0x00` → `UniqueID2Keys`, a `Dictionary<UniqueID, ContextDatabaseKey>`. Entries at
  `(dict+0x10+0x08 → array)+0x20`, **stride 24**, `{hashCode:i32, next:i32, keyPtr@0x08,
  valuePtr@0x10}`. The key is a `UniqueID` *object* — its `_RowID` Guid is at `key+0x10`
  (this is why searching for the raw GUID inline failed: the dict is keyed by object ref,
  Guid one level down). The value is a `ContextDatabaseKey`; `+0x10+0x00` = `KeyForSystem`
  (an int index).
- `ContextDatabase +0x10+0x08` → `Records` (`List<RecordInfo>`); `Records._items+0x20`,
  `[KeyForSystem]` → `RecordInfo`; `+0x10+0x08` → the `ContextDatabaseRecord`.
- `ContextDatabaseRecord +0x10+0x00` → `Contexts` (a `List`); iterate `_items` and pick the
  element whose vtable is `app.GatherContext`'s (resolved live from `types[74683]+0x40` —
  the vtable value moves each launch).
- **`GatherContext` byte `+0x28`: `0` = collected, `1` = available.** Confirmed twice: it
  flips `1→0` on gather, and loading a save with the beetle *alive* flips it back `0→1`.

A beetle GUID absent from `UniqueID2Keys` was simply never approached → treated as
uncollected. Validated end-to-end against a real save: **42 of 78 collected, 19 available,
17 not-in-DB**, tracking the live save state as beetles are gathered/reloaded — with no
gimmick loaded.

**Wiring:** `collectedTimer` unions the reads into one GUID set before the diff/broadcast —
tokens (`generateManagerReader`), the persistent ContextDB read (`contextDbReader`, one walk
over beetle + chest specs), and the in-session live-gimmick read (`gimmickReader`, beetle +
chest specs). One `collected-tokens` message carries all of it; the overlay filters `arPois`
by GUID regardless of kind. Both readers are **spec-driven** (see next section): each spec is
`{guids/pois, typeIndex, flagOffset, collectedValue}`, so adding a collectible is data, not
new traversal code.

### Chests — SHIPPED (same machinery, 2026-07-18)

Chests (Treasure Boxes) are the third AR collectible — **980 GUIDs** across `data/almanac/`
(`10`=S, `11`=M, `12`=L, `495`=XL, plus special/sphinx), drawn as **blue squares** with the
size in the label (`42u · L`). Structurally identical to beetles, so both readers were
**generalized to take a list of specs** rather than duplicated:

- **Persistent (ContextDB):** the exact same `UniqueID2Keys → Records → Contexts` walk, but
  the per-record context is an **`app.GmItemContext`** (type 31281) instead of `GatherContext`,
  and opened iff **byte `+0x19 == 1`** — *opposite polarity* to beetles (`+0x28 == 0`). Found
  by opening a chest, saving, diffing the `GmItemContext`; validated by the distribution across
  725 in-DB chests (452 opened / 273 not) with the just-opened one reading `1`. `contextDbReader`
  now takes both specs and does **one** dictionary walk.
- **In-session (live gimmick):** same `ManagedGimmicks` walk, but chests are **not**
  vtable-filtered — their runtime gimmick type varies by size (`app.gm80_001`=S and
  `gm80_097`=L resolve by name; M/XL/variants don't), so a chest is identified **purely by the
  position match** to an almanac chest point, reading the shared `GimmickBase` "interacted"
  byte **`+0x374 == 1`** (generic — it also flips on beetle gather; the position match is what
  makes it a chest). Beetles keep their exact vtable pre-filter. Both go through the one
  spec-driven `gimmickReader.read`.

  **The match radius MUST be tight for chests (bug fixed 2026-07-19).** Because chests are
  position-only, a loose radius mis-attributes an **unrelated** neighbour gimmick's `+0x374`
  to the chest. Symptom: a chest's blue AR marker vanished **on approach, before opening** —
  intermittently. Traced live (`scratchpad` probes over `gimmickReader`'s own walk): the
  chest's OWN gimmick is correct — `+0x374 == 0` while closed, flips to `1` only on open (its
  `+0x3d0` low byte goes `0→2→3` through the open animation). But two *different-vtable*
  gimmicks (props/enemies, not chests) sat **1.95u and 2.40u** from the closed chest's almanac
  point with `+0x374` already `1`, and the old **2.5u** radius swept them up → the closed chest
  read "opened". The real chest gimmick sits at **~0.00u**. Fix: a per-spec `matchRadius`
  (`gimmickReader` honours `spec.matchRadius`, default `MATCH_RADIUS` 2.5u); the chest spec in
  `index.js` uses **1.0u**. Beetles are unaffected (their vtable pre-filter already excludes
  neighbours, and they keep 2.5u). Erring tight is safe: a chest whose gimmick is missed by the
  live read is still hidden by `contextDbReader` after the next save, so tightening only ever
  *delays* a hide — it never *falsely* hides. (So `+0x374` itself was never wrong; the identity
  was too loose.)

The two ContextDB flags are opposite polarity and the two gimmick reads use different identity
strategies — the `{flagOffset, collectedValue, vtableTypeIndex?}` spec captures both cleanly.
Chest chains live in `config/singletons.json` (`chestContextChain`, `chestGimmickChain`).

**Why both reads, for chests specifically:** unlike beetles, an opened chest's gimmick *does*
respawn on reload (carrying a persistent `+0x3d0` free-bit) — but it still only exists when
you're **near** it. Your ~450 already-opened chests scattered across the map have no loaded
gimmick, so only the global ContextDB can hide them from launch. The gimmick read just adds
the "vanish the instant you open it, before you save" immediacy.

### Chest AR marker showing the WRONG state — the two failure modes (2026-07-19)

A chest AR marker (blue square) draws for every almanac chest whose GUID is **not** in the
collected set. That set is the **union of two reads**, with different coverage:

| read | source | covers | blind to |
|---|---|---|---|
| `contextDbReader` | save-wide ContextDB (`GmItemContext +0x19==1`) | every opened chest **after a save**, near or far | chests opened but **not yet saved**; chests with **no** ContextDB record |
| `gimmickReader` | the live gimmick byte, position-matched | a chest **while its gimmick is loaded near you** | anything out of streaming range |

So the two known symptoms are opposite bugs — keep them straight when diagnosing:

**1. Marker HIDDEN on a still-CLOSED chest (fixed 2026-07-19).** A false *positive* from the
live read: chests are matched by position only (no vtable filter), so an **unrelated
neighbour gimmick** (different vtable) carrying the generic `+0x374` within the match radius
was blamed on the closed chest. Fixed by tightening the chest `matchRadius` to 1.0u (the chest
gimmick sits ~0u from its almanac point; false neighbours were ~2u). See the live-gimmick
subsection above.

**2. Marker SHOWN on an already-OPENED chest.** A false *negative* — the opened chest's GUID
is in neither read. **Which cause depends on WHEN it shows:**

*Observed 2026-07-19: on a **fresh load** (not same-session), a marker led to an
already-opened chest.* A fresh load makes the ContextDB authoritative from the start, so this
**rules out save-lag** — it points at a **persistent** gap (record/GUID/duplicate below), not
a timing one. Always ask first: did this show right after loading, or after opening it
this session without saving? That single fact splits the causes.

  - **Chest has no ContextDB record (persistent — fits the fresh-load sighting).** The DB
    validation covered 725 chests; the almanac has 980 GUIDs. A chest the game never writes a
    `GmItemContext` for (`GUID absent from UniqueID2Keys → "never approached"`) can only ever
    be hidden by the live read — i.e. only while you're standing on it — so on a fresh load its
    marker shows until you walk up to it.
  - **GUID mismatch (persistent).** gibbed's almanac GUID ≠ the runtime `UniqueID` for that
    chest → the intersection never matches, so it's never hidden. Presents identically to
    "no record"; distinguish by checking whether the GUID exists in `UniqueID2Keys` at all.
  - **Duplicate almanac entries (persistent).** 8 chest-entry pairs sit within 2u of each other
    (likely one physical chest with two GUIDs); opening records only the real GUID, so the
    phantom's marker never clears. Minor (16 of 980 GUIDs).
  - **Save-lag gap (SAME-SESSION only — does NOT explain a fresh-load sighting).** The
    ContextDB byte only flips **when the game writes a save**. Between opening a chest and the
    next autosave, only the live read hides it, and that stops when the gimmick unloads — so
    walking away before a save brings the marker back. Self-corrects at the next save or on
    re-entering gimmick range. (Fix #1's tighter live radius widens this window slightly for
    chests whose gimmick is >1.0u off the almanac point — cosmetic, closed by the next save.)
  - **Fresh launch, before the first read.** The collected set starts empty and fills on the
    first successful ContextDB read (reads soft-fail to "keep last set"); opened chests show
    until then. But this clears within seconds and hits **every** opened chest at once, so a
    single lingering marker after exploring is NOT this.

**How to diagnose a specific recurrence** (reusable recipe, no in-repo tooling needed):
identify the chest by position-matching the player's global (x,z) to the nearest chest almanac
point (`data/almanac/{10,11,12,495,…}.json`, engine z is the almanac `y`). Then, for that
chest's GUID, check **both** reads standalone against the live game (replicate the walks in
`gimmickReader.js` / `contextDbReader.js`; player pos + `GimmickManager` offsets are in
`src/main/index.js`). If ContextDB says "not opened" but you did open it, it's save-lag or a
missing DB record; capture whether a save has happened since. Match the player position to the
GUID first — the marker you followed and the DB record must be the **same** chest.

### AR collectibles — session complete (2026-07-18)

All three mapgenie collectible types now draw as AR markers and hide once collected, verified
in-game (immediate on collect + persistent across reload):

- **Seeker's Tokens** — green circles, via `app.GenerateManager._NeverGenetateID`.
- **Golden Trove Beetles** — yellow diamonds, via ContextDB (`GatherContext`) + live gimmick.
- **Chests** — blue squares with size labels, via ContextDB (`GmItemContext`) + live gimmick.

The reusable machinery this session built — managed-singleton resolution over pure RPM
(`singletonHunt.js`, `--fields`/`--deref`), the `ContextDBMS → UniqueID2Keys → Records →
Contexts` walk (`contextDbReader`), and the position-matched live-gimmick read
(`gimmickReader`) — is now spec-driven, so a **fourth collectible would be mostly data**, not
new traversal code. Nothing here is left half-done; the only deferred *nicety* is splitting
chests out of the single `arCollectibles` toggle if a treasure-dense area ever feels cluttered
(today it relies on the 200u radius cull + `edgeMax`).

