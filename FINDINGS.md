# DD2 Map — Findings & Project State

Personal live-map overlay for **Dragon's Dogma 2**: embeds the mapgenie.io world
map and shows the player's real-time position, read from `DD2.exe` memory.
Personal use only. No kernel driver — DD2 has no anti-cheat, so user-mode
`ReadProcessMemory` (via koffi FFI) is sufficient.

## Architecture (monolith Electron app)

```
dd2-map/
  src/main/           # the app's main process — nothing else lives here
    index.js          # poll loop (30Hz memory read -> IPC), hotkeys, Alt/foreground
                      #   poll, found-mark bridge between the two windows
    memoryReader.js   # koffi/kernel32: OpenProcess/ReadProcessMemory,
                      #   findModuleBase, resolvePointerChain, readPointer
    win32Input.js     # koffi/user32: Alt-hold, foreground forcing, ClipCursor release
    overlayWindow.js  # the transparent, click-through, always-on-top overlay window
    overlayConfig.js  # overlay settings + defaults
    configStore.js    # config/<name>.json load/save (userData when packaged)
    areaTracker.js    # which area you're in: the game's inside-flag (in/out), the nearest
                      #   entrance (which dungeon), and HEIGHT (which floor)
    areaStore.js      # config/areas.json: the shared inset linear part + per-dungeon
                      #   translations. Main is its ONLY writer (see below).
  src/renderer/
    index.html/.js    # control window: mapgenie <webview>, calibration, overlay settings
    overlay.html/.js  # overlay: map + player marker only, no UI
    mapAgent.js       # the scripts injected into the mapgenie guest — shared by both:
                      #   buildInstallMarker (marker, follow, zoom, icons-only,
                      #   hide-found), buildFoundSync, buildExtractAreas
    calibration.js    # the affines (world + per-area), shared by both
    preload.js / overlayPreload.js   # contextBridges
  config/
    dd2.offsets.json  # THE memory findings (pointer chains, offsets, backups)
    calibration.json  # solved world->map affine  (written by the RENDERER)
    areas.json        # per-dungeon inset transforms (written by MAIN)
    overlay.json      # overlay prefs (gitignored; bundled into the .exe on build)
    mapgenie-areas.json # cached region/portal graph (gitignored; re-derived on launch)
  tools/              # RE tooling — how the offsets were FOUND. Not part of the app.
    scanner.js, globalHunt.js, pointerScan.js, testChains.js, findOrigin.js,
    findCellIndex.js, verifyCellIndex.js, watch.js, globalWatch.js, ctLogger.js,
    ctSnapshot.js, readCtAddresses.js, readStatic.js, compareStatic.js,
    analyzeRebase.js, probeMapLib.js, smokeTest.js
    zoneLog.js                # logs the game's (insideFlag, zoneIndex) against the
                              #   nearest mapgenie entrance — builds the id mapping
    ce_find_pointer.lua       # Cheat Engine: "find what writes" -> struct base
    global.chains{,2}.json    # the validated pointer chains these produced
```

Run the tools from the repo root (`node tools/testChains.js`); they write their
dumps and logs to the working directory, and those are gitignored — they're
gigabytes and all reproducible.

- No driver, no bridge service, no signing cost. One process.
- Map: official mapgenie embed `?embed=light` via Electron `<webview>` (host-side
  `executeJavaScript` reliably reaches `window.map`; a `<webview>` preload does
  NOT share `window.map` in this Electron version, even with contextIsolation=no).
- Map lib is **Mapbox GL JS** (not Leaflet). `window.map.project({lng,lat})` gives
  live pixel coords accounting for pan/zoom; raster source bounds `[-1.4,0,0,1.4]`
  (axis-aligned, no rotation).
- **2026-07: mapgenie migrated to MapLibre GL.** The page shims
  `window.mapboxgl = window.maplibregl`, so `window.map` and every JS API the guest
  script uses are unchanged — but the **CSS class prefix changed** from `mapboxgl-`
  to `maplibregl-` (MapLibre v3+ dropped the compat classes). Every CSS rule the
  guest injects by class (`hideChrome`, transparency, brightness) silently stopped
  matching; symptom was the zoom +/- buttons and the World/Unmoored World switcher
  (both live in `.maplibregl-control-container` — the switcher is a map control
  too, `mapTypeControl` added `bottom-right`) reappearing over the game. Fix: keep
  BOTH prefixes in every selector. If a class-targeted style silently stops
  working again, suspect another rename before anything else.

## Memory findings (the hard-won part)

### Player position struct
- Layout: 3 consecutive float32 at **structBase + 0x40 (x), +0x44 (height), +0x48 (y)**.
- Writing instruction: `DD2.exe+~0x54BB683` (`addss xmm3,xmm4` at post-write RIP;
  real `movss [rbx+0x40]` just before). Struct base held in RBX/RCX.
- **These are LOCAL coordinates under a floating origin** (see below).

### Stable pointer chain (survives reallocation + full restart)
Raw addresses reallocate during play AND on restart — both the position struct and
any origin values move. Solved via Cheat Engine pointer scan, narrowed through a
full DD2 restart + 2 reloads (559330 -> 5047 -> 124 -> 18 survivors), all 18
validated live by `tools/testChains.js`.

**Primary chain** (`config/dd2.offsets.json`):
```
"DD2.exe" + 0x0F8E4388  ->  offsets [0x50, 0x20, 0x28, 0x70, 0x20, 0x0]  ->  structBase
   x = structBase + 0x40,  height = +0x44,  y = +0x48
```
Backup chains: base `0x0F8E9420` [48,10,20,20,70,20,0]; bases `0x0F8FD5B8` /
`0x0FE46548` / `0x0FE7D220` all with [1D8,1A0,18,1B8,150,20,0].

**CE offset order (verified):** deref `[moduleBase+staticOffset]`, then apply
offsets[0..n-1] each with a deref, add offsets[n] LAST without deref. (Implemented
in `memoryReader.js:resolvePointerChain`.) DD2.exe module base = `0x140000000`
(not ASLR-randomized across the restarts observed).

**Persistent anchor:** `RSI = 0x1D4B83500` stayed byte-identical across the
original capture, a reload, AND a full restart — a deterministic singleton
(player manager?). Fallback anchor if the chain ever breaks.

### Camera position (solved 2026-07-13) — a real facing angle
The camera is a Vec3 laid out exactly like the player's (`x @+0, h @+4, y @+8`), and it
exists in **both** frames, like the player: `camGlobal - camLocal` came out as exactly
`(640, -1024)` = `(5, -8)` cells = *precisely* the player's own cell offset, with the
camera's offset from the player identical in both frames to 3 decimals. Use the **global**
one (`config/dd2.offsets.json` → `cameraPosition.stableChain`) — it sidesteps the floating
origin and matches the frame the app already reads.

Why it's worth having: **the camera looks at the player**, so the horizontal vector
`camera -> player` *is* the view direction. `heading = atan2(px - cx, py - cy)` is a true
facing angle that works **while standing still** — which the movement-derived
`__dd2_heading__` fundamentally cannot do (stop moving and it has nothing to report).

**Wired in.** Main ships `facing` (a unit vector in GAME coords) on the position feed; both
renderers turn it into a **look-ahead point** — the player pushed 25u along it, through the
*same* transform as the player — and the guest projects both points and takes the pixel
angle (`setHeadingFromAhead`). It feeds the existing `__dd2_heading__`, so the marker arrow
and the heading-up bearing consume it unchanged. If the camera chain misses a tick, the
guest silently falls back to the old movement heading.

**Facing must cross into map space as a POINT, not an angle.** The vector itself is
calibration-independent (it's just player - camera), but *drawing* it isn't: the affine's
`b`/`d` cross-terms carry the rotation between the game's axes and mapgenie's north-up
ones, and a dungeon inset applies its own transform on top. Convert the angle by hand and
the arrow disagrees with the direction the marker actually slides — wrong in the overworld,
wrong differently underground. Project two points that both went through the real transform
and the rotation comes along for free (the translation cancels in the subtraction, so only
the linear part survives, which is exactly the correction wanted). On the current
calibration that rotation happens to be 0.09°, so a hand-converted angle would *look* fine
and quietly break on a recalibration or in an inset.

**How it was found (`tools/cameraHunt.js`) — a relation, not a value.** There is no value
to scan for. But the camera is the one thing in memory **on a leash**: it stays a few units
from the player through walking, sprinting, teleports and cell-boundary snaps. So the
search key is a *relation* — a Vec3 that never leaves the leash — and float soup walks off
it within a few metres of running. Rotation then does the naming: stand still, swing the
mouse, and the camera is the thing that **moves while the player floats are frozen**.

Three traps, each of which cost a run:
- **Rank by ROAM, not by proximity.** The first pass ranked by tightest leash and returned
  548 hits sitting 0.3–0.7u from the player, all "moving while you stood still" — those are
  **skeleton bones**. The idle animation sways them while the root position is frozen, so
  they pass the rotation test exactly like a camera. What separates them: swing the mouse
  and the camera sweeps *metres* of arc at constant radius; a bone jiggles centimetres.
- **Measure the roam RELATIVE TO THE PLAYER.** Boxing the candidate's absolute position
  measures where *you walked*, not what the camera did — local coords wrap ±128 at every
  cell boundary, so it reported a "148u arc" under a 12u leash. That was the map, not the
  camera.
- **In the local frame the leash must be TIGHT.** Local coords are cell-relative and wrap
  inside a 128-unit box, so a generous leash spans much of the reachable range and the soup
  simply sits inside it forever: a 30u leash stalled at 2.3M candidates that could not be
  walked off. (In the *global* frame this problem largely vanishes — coords are large and
  specific, and junk landing within metres of them on both axes essentially doesn't happen.
  Same reason `pointerScan validatecam --global` narrows and the local one barely does.)

**It is NOT module-static.** All 92MB of DD2.exe's writable `.data` was swept; every leashed
Vec3 there was walked off the leash. Unlike `staticLocalPosition`, there is no static mirror
to find — don't go looking for one. Hence the pointer chain, narrowed
8148 → 7529 (teleport) → 5595 (save reload) → **285 (full game restart)**.

### Dead ends / corrections (so we don't repeat them)
- First "position" found (`0x3b8c4c60` struct) was **camera position, not player** —
  it moved when only rotating the camera. Discriminators that separated them:
  (1) camera-rotation-invariance, (2) jump raises/lowers height, (3) large smooth
  X/Z change on walk while height stays flat. (That address was then *discarded* rather
  than recorded, so the camera had to be re-found from scratch later. It is now written
  down properly — see above.)
- Raw session addresses (`0x47a55e10`, `0x3ea477c0`, `0x43b6bc20`, `0x4889d4a0`
  across rounds) all reallocate — never hardcode one; that's why the pointer chain
  exists.

## What works
- App reads the player's **absolute world position** directly, via a stable
  pointer chain to the global coordinate (survives reload + full restart). No
  dead reckoning, no drift, fast-travel/teleport just works.
- Calibration: click 3+ in-game landmarks on the map -> least-squares **full 2D
  affine** fit (`lng = a*gx + b*gy + c`, `lat = d*gx + e*gy + f`) + optional Refine
  offset. The `b`/`d` cross-terms carry the ROTATION between the game's world axes
  and the map's north-up axes; the earlier per-axis separable fit
  (`lng=a*gx+b`, `lat=c*gy+d`) omitted them and so drifted linearly with distance
  from the calibration points on long runs. 3 non-collinear points give an exact
  fit (pick a spread-out triangle, not a line); more points average click error.
  Because the coords are absolute, **calibration is permanent across sessions**
  (recalibrate once). Legacy separable calibration files are still honored on load
  (detected by the absence of `e`/`f`).
- **Accumulating Refine (the drift fix).** Scale is estimated from the SPREAD of
  the points, so a clustered calibration drifts in proportion to distance from it
  (each teleport showed error on whichever axis it traveled farthest along). Refine
  no longer stores a constant offset (only correct at one spot); it now treats the
  correction as a NEW correspondence point, appends it to `calibration.points`, and
  re-solves the whole affine. Teleport destinations are far apart, so a few
  jump→Refine cycles pin the scale and converge to an exact fit. The panel reports
  `max fit error ~N game units` (watch it fall toward 0) and warns via
  `calibrationQuality` when the points are too clustered / near-collinear. If that
  error plateaus well above 0 with many well-spread points, mapgenie's map isn't
  perfectly to-scale (warped) and a single global affine can't be exact — piecewise
  correction would be the next step. Needs one fresh calibration on this version
  first (older saves lack stored `points`, so Refine falls back to a local offset).
- Webview `dom-ready` timing bug fixed (guarded `runInWebview`).
- **Follow rendering (hard-won).** mapgenie's map is Mapbox GL (minified; POI icons
  are GPU symbol layers, `_fadeDuration` 300ms by default). SHIPPED approach
  (`mapAgent.js` `followFrame`, injected into the mapgenie page and shared by both
  windows): a 60fps rAF loop keeps a smoothed display position (`disp`, eased
  toward the latest target); when following it `jumpTo`s the camera to `disp` and
  draws our DOM marker at `disp` → **locked-center** follow, smooth tiles + marker.
  Player poll is 30Hz; a manual drag/zoom (movestart with `originalEvent`) suspends
  follow until the player moves >0.15 units/tick.
  - Trade-off: driving the Mapbox camera every frame makes each frame a discrete
    Mapbox "move", which re-runs symbol placement + restarts the icon fade →
    icons flicker and can show mild positional wobble. This is inherent to
    per-frame camera moves on Mapbox GPU symbols. Retargeting `easeTo` every tick
    instead stutters the tiles.
  - Settled on `_fadeDuration = 80ms` while driving (not 0). Zero kills the flicker
    but also kills Mapbox's symbol-placement throttle, so icons recompute every
    frame and wobble; 80ms keeps the throttle alive (~12 recomputes/sec) while
    staying too short to see as a fade. The map's normal 300ms is restored for
    manual browsing.
  - **Rejected:** a dead-zone (map idle, recenter via one `easeTo` glide only when
    the marker leaves a central box) fully stabilizes the icons but the map no
    longer locks to center — the user rejected that feel (bad for an overlay).
  - Reimplementing the ~5372 POIs as our own smooth DOM markers (to dodge the
    Mapbox symbol churn) is impractical: heavy per-frame cost and it throws away
    mapgenie's POI interactivity (click, tooltip, category/preset filters,
    found-state). So locked-center with mild icon wobble is the accepted state.
- **Heading-up map rotation** (`cfg.rotateWithHeading`, overlay only, off by
  default). Turns the map so the direction you're RUNNING is up, which is the whole
  point: "the POI is above the marker" then means "run straight on", instead of you
  translating "arrow points north-east" into "turn left a bit". There is no facing
  angle in memory, so the heading is still the movement vector — it holds its last
  direction while you stand still, and it will turn the map around if you run
  backwards. Three things here are not rediscoverable from the code:
  - **The heading has to be measured in WORLD space, and it wasn't.** `updateHeading`
    gets its angle from `map.project()`, i.e. SCREEN pixels — which is fine only
    while the map is north-up. Feed that straight into the bearing and the frame you
    measure in *is* the thing you rotate: the map turns, the projected delta swings
    back toward "up", the heading collapses toward north and the bearing chases its
    own tail (a slow spin, or oscillation). The fix is one term — `atan2(dy,dx) +
    map.getBearing()`. Mapbox's bearing is the compass direction drawn "up", so a
    world direction of azimuth `c` lands on screen at `c - 90 - bearing`; adding the
    bearing back cancels the camera. Keep `__dd2_heading__` camera-independent and
    everything else falls out: target bearing = `heading + 90`, and the marker's SVG
    rotate = `heading - bearing` (which is *exactly* the old value at bearing 0, and
    -90 — straight up — once heading-up settles).
  - **The bearing is eased off `map.getBearing()`, not off remembered state.** A
    smoothed `disp_bearing` of our own would need resyncing every time the user
    hand-rotates during an Alt-drag, and its unwrapped value drifts from Mapbox's
    normalized ±180. Easing from the map's real bearing each frame is self-correcting
    and needs neither.
  - **`__dd2_rotate_active__` is a separate flag from `__dd2_rotate__`**, and it has
    to be. It keeps the loop owning the bearing while it eases back to north after
    you switch rotation off (otherwise the map just stays stuck at an angle), and —
    more importantly — it is the only thing that lets the loop write a bearing at
    all. `followFrame` runs in BOTH windows; a condition like "unwind whenever the
    bearing isn't 0" would have the follow loop snap the CONTROL window's map back to
    north the moment you right-drag-rotated it by hand. The control window never
    calls `__dd2_set_rotate`, so it never touches the bearing.
  - The bearing rides the existing per-frame `jumpTo` (with center and zoom). A
    separate `setBearing()` would be a second Mapbox "move" per frame and double the
    symbol churn the 80ms fade throttle above exists to contain.
  - Verifiable without the game: drive the built guest script against a mock Mapbox
    whose `project()` models bearing, run a straight line on each compass heading,
    and assert the bearing settles on the run direction and the arrow on -90.
- **Live coord readout** in the control panel (`local` vs `world`), a **Follow
  player** checkbox, the overlay's settings (opacity/brightness sliders, auto-zoom,
  hide-found), and a **Refine** message reporting the correction in game X/Y units.

## Overlay (in-game, shipped)

Second BrowserWindow (`src/main/overlayWindow.js` + `src/renderer/overlay.*`):
fullscreen, transparent, frameless, always-on-top, click-through, no UI at all.
It has to be a SEPARATE window — `transparent` and `frame` are constructor-only in
Electron, so overlay mode cannot be a runtime flip of the control window. Both
windows run the same guest script (`src/renderer/mapAgent.js`, shared so the two
can't drift) off the same broadcast `game-position` feed.

Hotkeys (`globalShortcut`, all rebindable in `config/overlay.json`): F8 overlay,
F9 base map on/off, F10/F11 zoom out/in, hold Alt for mouse.

### Measured facts about mapgenie's Mapbox instance
Read live at startup by `__dd2_probe()` and logged — never hardcoded:
- **Canvas alpha = `true`.** This is what makes icons-only mode possible at all:
  hide the non-symbol layers and the WebGL canvas is genuinely transparent, so the
  game shows through. If a future mapgenie change flips this to `false`, layer-
  hiding can't work and the only fallback is rendering POIs ourselves as DOM
  markers from `querySourceFeatures` (viewport-only). The app detects and warns.
- **Zoom range 7–16**, opens at 12.
- **14 layers, 5 of them symbol.** The 5 symbol layers are the POI icons+labels
  (what icons-only keeps); the other 9 are the map itself.

### The layer list is NOT stable (cost real debugging time)
mapgenie loads a **2-layer base style first**, reports `map.isStyleLoaded() === true`,
and only *then* streams the POI layers in — so an early probe truthfully reports
"2 layers (0 symbol)". It also mutates layers as you toggle POI categories.
Consequences, both shipped:
1. **Never cache the layer ids.** `__dd2_set_basemap_visible` recomputes from the
   live style on every call and re-asserts itself on `styledata`/`idle`. A cached
   list captured at the wrong moment left base layers visible in icons-only mode.
2. The startup probe keeps retrying until symbol layers actually exist (capped at
   ~5s), so the logged count isn't a lie. Zoom range and alpha are adopted from
   the first loaded style — those never change.
3. **Never gate a style mutation on `map.isStyleLoaded()`.** It flickers false
   whenever mapgenie streams a source, which is often. Gating `applyBasemap` on it
   silently DROPPED the restore: F9 hid the map, F9 again did nothing, forever.
   Two compounding halves — the gate threw the call away, and the re-apply hook
   only re-asserted the *hidden* state, so nothing ever retried it. Now: no gate,
   and the hook re-applies in both directions. Repeated identical
   `setLayoutProperty` calls are no-ops in Mapbox, so re-applying freely can't loop.
4. **8 of the 14 layers ship HIDDEN — never blanket-restore to `visible`.**
   `Unmoored World` (a whole alternate-map raster), `region-fills`,
   `subregion-fills`, `regions`, `subregions`, `region-borders`, `link-lines`,
   `highlighter`. Restoring every non-symbol layer to `visible` switches all of
   those on at once and the map goes **black** — the Unmoored raster and the region
   fills paint over the real map. (And because the re-apply hook runs in both
   windows, it blacked out the control window too, which never even uses F9.)
   `applyBasemap` now records each layer's original visibility before hiding it and
   restores to exactly that, touching only the layers it hid — so it's also a no-op
   when nothing is hidden, which is what makes it safe to fire from `styledata`.
   Verified against the live style: with icons-only on, no non-symbol layer leaks
   through, and restoring returns every layer to its exact starting visibility.
5. **`applyBasemap` must skip OUR OWN layers.** The dungeon edge art (below) is a
   `raster` layer, i.e. non-symbol, so the "hide every non-symbol layer" sweep hid it
   too — and because the sweep re-runs on `styledata`, and *adding* the edge layer
   fires `styledata`, the edge vanished the instant it appeared (`vis=none`, image
   fully loaded and correctly placed). The fix is one guard: skip any layer whose id
   starts with `__dd2_`. Cost a full live-diagnostic session to find, because every
   other signal (source loaded, layer exists, corners in viewport) said success.

### Dungeon edge art (F9 in a dungeon) — data: URL, not a custom scheme
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
  `AREA_TRUST` (0.30) gates game-derived transforms out of the merge, so ~18 low-score
  dungeons have valid `c`/`f` but no marker and no edge. (Not yet resolved; see TODO.)

### Found POIs are a paint expression, not a layer (and not filterable)
mapgenie has no separate layer for locations you've marked found — it fades them
in place, on the `locations` layer:
```
icon-opacity: ["case", ["boolean", ["feature-state","found"], false], 0.4, 1]
```
So "found" is only **40% opacity**. Stack the overlay's own opacity and brightness
on top and 0.4 vs 1.0 stops reading as a distinction at all, so marked POIs still
cluttered the map. `hideFound` (default on, overlay only) rewrites that
expression's found-branch to **0**.

It has to be done in the PAINT expression: **Mapbox layer filters cannot read
`feature-state`**, so a filter physically cannot see which locations are found.
The original expression is captured before the override and restored verbatim
(back to the 0.4 fade, not a flat 1), and it's re-applied on `styledata` — mapgenie
rewrites the layer's paint whenever you toggle a POI category, which would
otherwise silently restore its own fade. The control window is left alone, so you
can still see and mark found POIs there.

(How it was found: dump `map.getStyle().layers`, filter to `type === 'symbol'`, and
read their `paint` — the `locations` layer's `icon-opacity` is the whole story.)

### Found-state sync between the two windows
The control window and the overlay are **two separate mapgenie SPA instances**.
They share cookies, so the SERVER sees a mark immediately — but each page only
reads the found-set from the server **on load**, so marking in one was invisible
to the other until a reload (overlay→main needed a page refresh; main→overlay
needed an app restart).

mapgenie is **Redux** (`window.store`, a real store with getState/subscribe/dispatch):
- The found-set is `store.getState().user.foundLocations` — `{ [locationId]: true }`.
- Marking dispatches a plain action whose middleware does
  `case MARK_LOCATION: mapManager.setLocationFound(locationId, found)`, and
  `mapManager.setLocationFound` is just
  `map.setFeatureState({source:'locations-data', id}, {found})`.
- **The HTTP write (`DELETE/POST /api/v1/user/locations/{id}`) lives in the THUNK
  around it, not in the action.** That's the key: replaying the plain action in the
  other window updates its store AND its map, and cannot re-write to the server.

Shipped (`mapAgent.js` `buildFoundSync`, bridged through main): patch
`store.dispatch` in both guests; if a dispatch changed `user.foundLocations`,
console-bridge the raw action to main, which replays it in the other guest.

- **The action type is never hardcoded.** It's minified to a single-letter variable
  (`case d:` in the reducer), so it cannot be hand-written — an early self-test that
  fabricated `{type:'MARK_LOCATION'}` was silently ignored by the reducer. Instead a
  mark is detected by whether the dispatch *changed* `user.foundLocations`. Redux
  reducers return a NEW object when they change something, so an identity check is
  enough — no deep diff, and it survives mapgenie renaming its actions.
- Replayed actions carry `__dd2_mirrored__` so they don't bounce back, and the
  replay temporarily blocks `/api/v1/user/locations` writes as belt-and-braces.
- The sync is injected on `dom-ready`, **separately from the marker script** — the
  marker waits on a saved calibration and a running game, and the sync must work
  regardless of both.
- mapgenie also exposes a `setLocationFound` **CustomEvent** on `document`
  (`detail: {locationId, found}`) that drives its real mark path end to end — the
  only way to trigger a genuine mark from outside, since the action type can't be
  hand-written.

**Marks DO persist to the server** — verified on live traffic. The window you
clicked in writes once (`PUT /api/v1/user/locations/{id}` to mark,
`DELETE` to unmark — explicit verbs, not a toggle, so it's idempotent). The
mirrored copy in the other window writes nothing.

Verified end to end: a mark in the control window lands in the overlay's Redux
store *and* its map feature-state (`{found: true}`), with exactly one server write.

### Electron overlay gotchas (all load-bearing)
- **Background throttling.** The overlay is never the focused window, so Chromium
  throttles its rAF to ~1fps and the marker freezes. Needs ALL of:
  `backgroundThrottling:false` on the window, `webpreferences="backgroundThrottling=no"`
  on the `<webview>` (the 60fps follow loop lives in the *guest*), and the
  `disable-background-timer-throttling` / `disable-renderer-backgrounding` /
  `disable-backgrounding-occluded-windows` command-line switches (before `whenReady`).
- **DD2 CONFINES the cursor — so the overlay MUST take focus to be clickable.**
  This killed the original `focusable: false` (WS_EX_NOACTIVATE) design, which was
  chosen precisely so the overlay would never disturb the game. DD2 pins the cursor
  to screen centre and only releases it when it loses focus, so with a non-focusing
  overlay: Alt produced a cursor stuck at centre, POI clicks did nothing, and the
  map couldn't be panned (no drag possible with a pinned cursor). `focusable: true`
  is now the default. Two things were needed to make that actually work:
  - **`win.focus()` is not enough — Windows silently denies it.** SetForegroundWindow
    is refused to any process that didn't receive the last input event, and while
    you're playing that's always DD2. The call no-ops and the overlay never
    activates. `win32Input.forceForeground()` gets around it with the
    **AttachThreadInput** trick: attach our input queue to the foreground window's
    thread (which makes Windows treat us as part of that input context, lifting the
    restriction), SetForegroundWindow, detach immediately.
  - **The game re-applies `ClipCursor` every frame** while it believes it owns the
    mouse, so clearing the clip once on Alt-down doesn't stick. The clip is
    system-wide state (not per-process), so `ClipCursor(NULL)` from our process
    works — we just have to keep calling it, every poll tick while Alt is held.
- **Alt must LOCK follow, not just suspend it.** `__dd2_apply` cancels a manual pan
  whenever the player moves past the deadband, so any drift while you were dragging
  yanked the map back to centre mid-pan. `__dd2_interactive_lock__` blocks that
  cancellation for as long as Alt is held.
- **Do NOT pass `{ forward: true }` to `setIgnoreMouseEvents`.** Forwarding
  mouse-move to the renderer while click-through made mapgenie fire POI hover
  tooltips under the game's trapped centre-screen cursor — labels popping up over
  the game with no cursor visible anywhere near them. Click-through has no use for
  hover; don't forward.
- Scroll-wheel zoom over the overlay is routed by Windows to the *focused* window,
  so it only works while Alt is held. Hence the zoom hotkeys.
- **Alt-hold must be POLLED** (`GetAsyncKeyState` via koffi/user32,
  `src/main/win32Input.js`): `globalShortcut` only ever fires on key PRESS — there
  is no key-release event, so hold-to-interact cannot be built on it.
- **DD2 must run Borderless Windowed** — nothing draws over exclusive fullscreen.
- Closing the control window quits the app: the hidden, frameless overlay is also
  a window, so it would otherwise keep the app alive with no way to reach it.

### Zoom model
Manual and automatic zoom compose instead of fighting: the hotkeys move a persisted
`baseZoom` (the STANDING zoom) and running eases out to `baseZoom - runZoomDelta`
from wherever you set it. Speed comes from the position feed (game units/sec) with
**hysteresis + a dwell on each edge** — without the dwell, shuffling in combat
strobes the zoom. Zoom is folded into the follow loop's existing per-frame `jumpTo`
(center + zoom in one move), so it adds no *extra* Mapbox symbol churn beyond the
locked-center cost already documented below.

## Packaging (portable .exe, shipped)

`npm run dist` (electron-builder) → `dist/DD2Map.exe`, one ~72 MB portable binary.

- **The bundled `config/` is inside `app.asar` and READ-ONLY.** This is the trap:
  writing there fails *silently*, so calibration and every setting would appear to
  save and then be gone on the next launch, with no error anywhere. `configStore.js`
  therefore writes to `app.getPath('userData')/config` when `app.isPackaged`, and on
  first run falls back to reading the copy shipped inside the asar (which is how the
  calibration and tuned overlay settings ship with the binary). Dev still reads and
  writes the repo's `config/`, so hand-editing `config/overlay.json` keeps working.
- **koffi must be `asarUnpack`ed.** It's a native addon and cannot be loaded from
  inside an asar — without this there is no `ReadProcessMemory` and no player
  position.
- **`win.signAndEditExecutable: false`.** Otherwise electron-builder downloads its
  `winCodeSign` package, which contains macOS symlinks that Windows refuses to
  extract without Developer Mode or admin rights, and the build dies there
  ("Cannot create symbolic link"). Cost: the .exe keeps the default Electron icon
  and metadata.
- userData resolves to `%APPDATA%\dd2-map` — Electron's `app.getName()` uses
  package.json's `name`, NOT electron-builder's `productName` ("DD2 Map").

## Floating origin — SOLVED by reading the absolute coordinate (Path B, shipped)
DD2 uses a floating origin: raw ("local") coords re-center at streaming-cell
boundaries (constant 128-unit grid with hysteresis; see the geometry notes
below). But the game **also keeps the true absolute position live in memory**,
and we read it directly, so the origin churn never reaches the marker.

- `global = local + k*128`. The global is a Vec3: **X @ +0, Y @ +8** (the +4
  field is not on the 128-grid — ignored; the map is 2D).
- **Primary chain:** `DD2.exe+0x0FD26358 -> [0x1A8, 0x410]`.
  Fallback (different base/structure): `DD2.exe+0x0F8E1130 -> [0x210, 0x50]`.
  Offset order = CE display order = `resolvePointerChain` order.
- Validated across **teleport + reload + a full game restart** (ASLR), so the
  chains are module-relative and permanently stable. Each tick the app also
  sanity-checks `global - local` is a multiple of 128 before trusting the read,
  and falls back to the second chain otherwise (`src/main/index.js`).
- **Teleport lesson (important):** the first chain we shipped
  (`0BB0E1D0 -> [0x40,0x20,0x190,0x3F8,0x88,0x3E0]`) survived reload/restart but
  read GARBAGE after a fast-travel *until the in-game map was opened* — it threaded
  a **map-owned copy** only refreshed when the map is up. Always add a teleport
  test (fast-travel WITHOUT opening the map) and keep only chains that stay
  consistent; those reach the **gameplay-live copy**. Shorter isn't automatically
  better either, but here the teleport-robust chains happened to be the shortest.

### How it was found (reusable)
1. `tools/globalHunt.js` finds the live global address: filter memory to
   values that move in lockstep with the player between crossings
   (`d(global) == d(local)`), then a boundary crossing separates global (tracks
   the player's TRUE displacement) from local (snaps ~128 with the origin).
   121M candidates -> a handful of global copies.
2. Pointer-scan a *stable* global copy (CE, or `tools/pointerScan.js scan`).
   Low-heap copies are transient (no stable path); pick one that survives a
   reload. Narrow the scan across reloads (`findglobal` to get the new address +
   CE rescan, or `tools/pointerScan.js validate`, which auto-identifies via the
   128-consistency test so it needs no manual re-targeting).
3. `tools/pointerScan.js validate tools/global.chains.json` across a reload + a full restart
   keeps only permanently-stable chains. Shortest survivor wins.

Note: raw heap addresses die on any reload/teleport — never hardcode one; a chain
must be re-validated across a restart before trusting it. Also, the SHORTEST
chains are not always the most stable: here the 4-5 offset chains were transient
and the 6-offset one won.

### Cell geometry (measured, for reference)
Not needed by the app anymore (we read global directly), but documented since it
took real work to establish:
- **Grid step is exactly 128.** The origin only ever moves in 128-unit steps.
  (Raw observed jumps look like ~127.6 — that is `128 − the real movement during
  that tick`; subtracting measured per-tick motion gives ±128.000.)
- The local field re-centers to about **−8** (a constant offset; calibration
  absorbs it).
- **NOT a constant-border grid — there is hysteresis.** The anchor holds until
  the player is 128 from its center, so the valid band is local ∈ **[−136, +120]**
  = 256 wide = twice the step; adjacent anchors overlap by 128. So the flip has no
  fixed world position — it depends which anchor you're on. Standard engine design
  (the overlap stops the origin thrashing when you walk along a boundary).

### Superseded approach: dead reckoning (Path A)
An earlier version accumulated the 128 re-centers live (`world = accum + local`,
detect a jump in band `64 < |Δ| < 400`, subtract the reset portion with an EMA
velocity estimate) — sub-pixel drift, but per-session calibration and no
fast-travel. Fully replaced by the global read above and removed from `index.js`.
`tools/globalHunt.js` / `tools/scanner.js` retain the tooling if ever needed again.

## Dungeons: the inset problem, and mapgenie's portal graph

mapgenie draws every dungeon as an **inset** — a separate, zoomed panel parked off to
the side of the playable world, but inside the *same* raster and therefore the same
lng/lat plane. DD2's caves are seamless world geometry, so the game just keeps
reporting ordinary world coordinates when you walk into one. With a single global
affine that means the marker stays out at the cave mouth while the cave's POIs sit far
away in the inset: **1,227 of the map's 5,354 POIs (23%) are in the 72 dungeon insets
and were unreachable.**

Fixed by making the transform **piecewise**: an affine per area (overworld + one per
dungeon floor), selected each tick from the live position (`src/main/areaTracker.js`).
Everything downstream is untouched — swapping the affine flies the camera to the inset
where the POIs already are.

### mapgenie states the whole dungeon graph outright (the thing that made this cheap)

Read live from the guest, never hardcoded (`mapAgent.js` `__dd2_extract_areas`):

- `sources['subregions-data']` — **74 named dungeon polygons** (`{id, title}` + bbox).
  Three *regions* (2438 Battahl, 2439 Vermund, 2440 Agamen) are the overworld; the
  overworld set is derived as "is a region, not a subregion", never a hardcoded id list.
- **`store.getState().map.locationsById`** — all 5,372 locations as FULL objects. This
  is the load-bearing part: the geojson source (`locations-data`) carries only a
  trimmed property set with **no `description`**, and the description is the whole
  story. Every portal names its destination **by location id**:

  ```
  **Transitions to:** [Waterfall Cave 1F](https://mapgenie.io/…?locationIds=328583)
  ```

  Parsing `locationIds=(\d+)` out of those yields **913 edges, every destination
  resolving**: 131 overworld→dungeon entrances covering **72 of the 74** insets, 123
  exits, 204 floor-to-floor links.

Matching entrances to insets **by title** also nearly works (98 of 105 exact) — and
that "nearly" is a trap. Four destinations have `region_id: null`, one of which is the
**only** edge into Darkhorde Cave, so the id alone loses a whole dungeon. Those four
fall back to an *exact, unambiguous* subregion-title match (two subregions are both
called "Sealed Mining Shaft", so uniqueness is checked); anything less certain drops
the edge. A mis-assigned portal would silently teleport the marker into the wrong
cave, which is worse than an uncalibrated one.

Not auto-reachable: **Vernworth - Southern Ruins** and **Sealed Mining Shaft** — no
entrance edge exists in mapgenie's data at all. They need manual calibration.

### mapgenie's category taxonomy (verified live — this is what any FILTER would be built on)

Every POI carries `category_id`, every category belongs to a **group**, and the groups are
exactly the headings the site's own filter sidebar renders. Read from the guest's Redux
store (identical on `?embed=light` and the full map, so the embed we load has all of it):

| path | what |
|---|---|
| `store.getState().map.groups` | `{ id, title }` — the 8 groups below |
| `store.getState().map.categories` | `{ id, group_id, title, icon, order, locations_count, premium, … }` |
| `store.getState().map.locationsById[id].category_id` | which category a POI is in |
| `store.getState().map.locationsByCategory` | the reverse index, already built |
| `store.getState().map.categoryIds` | the ids in display order |

The 8 groups, with their categories and POI counts (DD2, 2026-07):

| group | categories (count) |
|---|---|
| **Locations** | Area (19), Portcrystal (11), Waypoint (111), Campsite (84), Dungeon (106), **Transition (260)**, Settlement (10) |
| **Facilities** | Riftstone (11), Ox Station (6), Apothecary (10), Peddler (7), **Inn (12)**, Barberie (2), Tavern (4), Forgotten Riftstone (90), Armory (9), Vocation Guild (3), Bordelrie (1), Oracle (2), Mortuary (2) |
| **Key Items** | Seeker's Token (240), Implement (25), Golden Beetle (82), Key (4), Wakestone Shard (80), Ferrystone (47), Key Item (2) |
| **Equipment** | Weapon (149), Armor (151), Cloak (28), Ring (48), Ammunition (35) |
| **Items** | Grimoire (84), Valuable (270), Material (90), Curative (1253), Chest (435), Loot Pile (597) |
| **Quests** | Main Quest (26), Side Quest (48) |
| **Enemies** | Enemy (704), Boss (124) |
| **Other** | Miscellaneous (21), NPC (46) |

Match on the group **title**, never the id (`Locations` is 1770, `Facilities` 1777 — those
are *this map's* numbers and mean nothing on another game).

`Transition` is the odd one: those POIs **are the doorways** — the same objects the portal
graph is parsed out of — and their titles name a destination floor ("Waterfall Cave 1F"),
not a place you can stand in. Exclude it from anything that means "where am I".

For a future filter UI this is everything needed: 5,372 POIs, 8 groups, 39 categories, with
counts, icons and display order already supplied. Note POIs all live on **one** Mapbox
layer (`locations`), and *found* state is a **feature-state paint expression**, not a layer
or a filterable property (see "Found POIs are a paint expression"), so a
category filter has to work on the category property, not by hiding layers.

### Named places: most interiors are BUILDINGS, and buildings are POIs, not insets

The inside-flag fires for every house, shop and inn — and mapgenie draws an inset for none
of them, so there is no panel to place the marker on and no entrance in the portal graph to
match. This is *why* the unbounded nearest-entrance rule went wrong (above): it was being
asked which dungeon a tavern was.

But nothing needs placing. **Indoors, DD2 still reports true world coordinates**, so inside
a house you are already drawn in the right house. The only thing missing is the **name** —
and mapgenie has it, as an ordinary POI in the `Locations`/`Facilities` groups ("Kough's
Inn", category Inn; 475 of them on the overworld).

Nothing in memory links the interior you're standing in to that POI, and no geometry can
supply it (the flag says *inside*, not *inside what*). So it is **taught, once, per
building**: `Home` binds the nearest place POI to the spot you're standing on, main saves it
to `areas.json` under `places`, and from then on that doorway is recognised — the HUD names
the building and no dungeon is ever guessed there again.

Two details that matter:

- It binds **your position**, not the POI's. mapgenie draws a building's icon wherever it
  looks right on the world map — a roof, a courtyard — which can be tens of units from the
  door you actually walk through. The **door** is where the flag flips, so the door is what
  has to be recognised. The POI-to-door offset is stored alongside (`dist`), and it is
  small in practice: measured **2u** standing in Kough's Inn.
- `Home` **refuses** past `placeRadius` (40u). A "nearest" inn 300u away is not the room
  you're in, and binding it would be the 219u dungeon bug wearing a friendlier name.

### Height is NOT usable to detect "inside" (measured in-game — this killed the first design)

The obvious detector — a z-band per dungeon — does not work, and it's worth writing
down so nobody rebuilds it:

- Entering a cave produces **no step change in height**. The coordinate runs
  continuously straight through the doorway.
- Inside is **not reliably lower**. A tower's interior climbs *above* its own entrance.

So there is no height band separating inside from outside, and any z-gate misfires on
towers. Height is still read and broadcast, but nothing keys off it.

### What we detect on: the game's flag for WHETHER, the nearest entrance for WHICH

Two questions, and they get different answers.

**1. Am I inside? The game tells us.** Found by CE value-scanning (2026-07-13); a
module-static int, **no pointer chain** (same kind of read as the local-position mirror,
so restart-stable by construction):

```
DD2.exe+FA62CAC   insideFlag   0 = overworld,  1 and 2 = inside a dungeon
```

Both non-zero values mean inside (user-observed) — 2 is some *second kind* of interior,
and what distinguishes it from 1 isn't known yet. Since both mean inside, nothing in the
app needs to care; `tools/zoneLog.js` is collecting the data to find out what it is.

**It lags the in-game map**, and this cost us a wrong conclusion worth recording. Walking
out of a cave, the game's own map had already switched back to the overworld while the
flag still read `1` — sampled there, it looks like a dead value that never updates, and
we briefly concluded it was a stale copy (which this project has a real precedent for —
see the teleport lesson under `globalPosition`). It isn't. It settles once you are
properly outside. **Don't judge it mid-transition.**

The struct around it, read live: `+4` (`zoneIndex`) is **`-1`, not `0`**, in the
overworld — a sentinel. `-24` is a **room hash** (see below). `+12` is a float, 0.0
outside and wandering 0.46–0.75 inside; unknown, probably a blend/fog factor.

This **replaced a doorway-proximity guess**: invert the world affine to place each
entrance in game coordinates, and treat coming within `enterRadius` of one as having
crossed it, with a containment backstop (do I still map inside the inset panel?) for
exits that missed the radius. It worked, but it inherited the world affine's fit error,
needed a radius *plus* a re-arm band *plus* a dwell to stop it strobing when you idled in
a doorway (three tries to get right — see the git log), and structurally could never see
the two dungeons with no portal entrance in mapgenie's data. All of that is now deleted:
`enterRadius`, `rearmMargin`, `rearmDwellTicks`, `outsideDwellTicks` and the containment
check are gone.

**2. Which dungeon? The nearest known entrance.** There is a second static int beside the
flag:

```
DD2.exe+FA62CB0   zoneIndex    the GAME's own dungeon id
```

It is tempting to read this as "the dungeon", and it very nearly is — but it is the
**game's** numbering, and mapgenie's is different: mapgenie's subregion ids run
**2441–2514**, while an observed `zoneIndex` was **18**. They do not coincide, so
`zoneIndex` cannot name a dungeon until a **mapping table is built**, dungeon by dungeon.

Until then: the flag says *when* to jump into an inset, and the **nearest known entrance**
(from mapgenie's portal graph) says *which* one — **provided it is actually near** (see
the next section, which is where this bit an entire dungeon).

### The flag means "inside", not "inside a DUNGEON" — cap the entry distance

The nearest-entrance rule looked forgiving: the right entrance only has to be nearer than
the next-nearest, so the affine's fit error would have to be enormous to pick the wrong
cave. **That reasoning has a hole, and it is not about the affine at all.** It assumes the
right answer is *in the list*. It often isn't:

`insideFlag` is set by **every interior in the game** — houses, shops, the Vernworth
barracks — and mapgenie has an entrance POI for **none of them**. Walk into a house and
the app is asked "which dungeon is this?", a question with no true answer; unbounded, it
returns whichever dungeon is least far away, at any distance whatsoever. Observed:

```
[areas] auto-calibrated "Ancestral Chamber"  from the crossing (219.4u from the nearest known doorway)
[areas] Ancestral Chamber sits at height 125.4 (measured 125.4)
```

That is not a near miss. It **wrote a transform anchored on 219u of error into
`areas.json`**, and a floor height of 125.4 (the player was up a tower somewhere), so a
dungeon the player had never entered was permanently mis-placed — and the floor height,
which *averages* across visits, would have stayed poisoned even after a real visit.

The fix is a radius (`dungeonEnterRadius`, default **20u**, in `config/overlay.json`): a
crossing anchor is only worth anything if you are standing *in* the doorway, so beyond it
we decline to answer. The marker then stays on the **overworld** — which is right, because
DD2 reports ordinary world coordinates indoors, so a building draws you at the building —
and the overlay's area readout offers the nearest dungeon with `Insert` to accept it. That
override deliberately **skips the radius**: at that point the guess isn't ours, it's one
you looked at and confirmed, and it is also the only way into the two orphan dungeons.

Rule of thumb for anything downstream: **a hint the player can't see is a guess the player
can't correct.** The 219u line was in the console the whole time and no one was reading it
mid-fight; that's why the same information now sits on the overlay.

The saved area now records the anchor's `dist`, so a placement that looks off can be
diagnosed instead of re-guessed.

Note the id must be keyed on `(insideFlag, zoneIndex)`, **not zoneIndex alone**: the flag
appears to select an id *namespace*. Measured so far —

| flag | zone | dungeon | mapgenie subregion | matched at |
|---|---|---|---|---|
| 1 | 18 | Forgotten Tunnel | 2447 | 28u |
| 2 | 2010 | Stormwind Cave | 2460 | 13u |
| 1 | 69 | Stragglers' Cave | 2443 | 7u |

flag-1 ids are small (18, 69); the one flag-2 id is four digits (2010). "Nearest entrance"
picked correctly all three times.

**`tools/zoneLog.js` exists to finish this.** Run it while playing; on every change of
zone state it appends a line pairing `(insideFlag, zoneIndex)` with the nearest mapgenie
entrance's name and how far away it was. Only the CLOSE lines are usable — a line logged
deep inside a dungeon pairs a zone number with whatever entrance happened to be nearest,
which may be a different cave entirely. Visit enough dungeons and the mapping falls out.

The free-anchor calibration trick (below) is unaffected: entry still hands over the
player's world position paired with the matched entrance's inset position.

### 3. Which floor? HEIGHT — and nothing else can do it

**Only height can carry this, as a matter of fact rather than preference: the game reports
the SAME (x, y) on every floor of a dungeon.** Two floors differ in z and in nothing else.
So no x/y signal — not a room id, not the portal graph, not the panel geometry — can ever
separate them, however clever. This is worth being blunt about because two plausible ideas
were built and both failed on exactly this.

**The room hash is not a floor id (dead end, cost a day).** The third int in the struct:

```
DD2.exe+FA62C94   roomHash   -1 in the overworld; inside, an id for a streaming cell
```

It looked perfect: deterministic (walking Forgotten Tunnel one way and back gave the
identical five hashes in reverse order), so it was used as a *learned key* — press
`PageUp`, record the room you're in against that floor. It does not work, and cannot:

- **The same hash appears on two floors.** In The Gracious Hand's Vaults, `1bc90b46` and
  `ae32b49d` both occur at h=-13.7 *and* h=-5.2. It's a cell that spans floors vertically.
- Two of them **flicker back and forth three times a second** while you stand still on a
  boundary.
- Recording it taught the table contradictions, which then *fought the player*: walk into
  the stairwell, get flipped to the wrong floor, correct it, get flipped the other way
  next time. Every room ends up marked ambiguous and the mechanism is dead weight.

Read it, log it (`tools/zoneLog.js`), but never key a floor on it.

**What works: learn where each floor SITS, per dungeon.** Stand on a floor, press
`PageUp`/`PageDown` to name it; once your height settles, that height is recorded in
`areas.floorHeights`. From then on your height picks the nearest floor by itself.

- **Absolute height, never height CHANGE.** Measured floor gaps run **5.8u** (The Gracious
  Hand's Vaults) to **16.6u** (Forgotten Tunnel), while the height wanders up to **4u
  within a single floor**. A change threshold would need to sit below 5.8 and above 4 — a
  1.8u window — and be wrong in the next dungeon regardless. A 12u threshold picked from
  Forgotten Tunnel is precisely what silently broke the previous attempt: it never fired in
  the Vaults, so the app never noticed the player had changed floor and confidently wrote
  every floor's rooms down as 1F.
- **The height is taken once it SETTLES** (~1s flat, ≤1.5u spread), not when you press the
  key — you press it *on the stairs*, and the stairs are between floors, which is the one
  height that belongs to neither. Verified in simulation replaying the real log: pressing
  PageDown mid-staircase still records B1F correctly.
- Averaged over visits, so a second pass sharpens a floor rather than replacing it.
- A rival floor must beat the current one by `SWITCH_MARGIN` (1.5u), so walking a ramp
  can't flicker the map between two panels. An untaught floor is never guessed at.

Simulated against the real Vaults data: teach three floors (one keypress each), then walk
the same route again and all three follow with **zero input**.

**Floors must be ordered by ELEVATION, not alphabetically.** `B` = basement, so B1F sits
*under* 1F, and a string sort gives `['1F', 'B1F']` — which made `PageUp` from B1F walk off
the end of the list and silently do nothing. `floorRank()` exists for this (`B1F → -1`,
`1F → +1`). Also: mapgenie has portals whose titles carry **no floor label at all** (three
into the Vaults), and `''` ranks between B1F and 1F — a phantom floor with no panel behind
it, which `PageDown` would step onto. `''` is only a real floor when it is the only one.

**Floors reached only by stairs have no entrance**, so no free anchor from a doorway
crossing ever lands on them — they'd stay uncalibrated forever, the marker would simply
vanish up there, and Refine couldn't rescue it (it *shifts* an existing transform; there'd
be nothing to shift). A floor change now offers the **stair crossing** as that floor's
anchor, using mapgenie's 203 internal portal edges: the floor you came *from* is
calibrated, so inverting it places its stairs in game coords and the nearest is the one you
took. Confirmed live.

### Calibration is free, because a crossing IS a correspondence

Every inset is drawn at the **same scale and rotation**, so they all share one 2x2
linear part (`insetLinear`) and differ only by translation:

```
lng = A*gx + B*gy + c        A,B,D,E = insetLinear: solved ONCE
lat = D*gx + E*gy + f        c,f     = per-area: ONE correspondence each
```

And walking through a doorway hands us that one correspondence for nothing: we know
the player's world position *and* (from the portal graph) exactly where that doorway
comes out on the inset. So **a dungeon calibrates itself the first time you walk in**.
`insetLinear` is seeded once, by running the ordinary 3-point flow inside any one
dungeon; every dungeon after that costs zero clicks.

- The anchor is taken at **closest approach** to the doorway, not at the instant it
  fires — firing happens anywhere within `enterRadius`, and at inset scale a 10-unit
  error is magnified into a visible one. (Simulated: 3.1 units instead of ~10.)
- **Refine inside a dungeon SHIFTS, it does not re-fit.** The linear part is shared and
  already known, so there is nothing left to fit — only the offset can be wrong. A
  least-squares re-fit would let click error bend a linear part that isn't in question,
  and would need three points to do it. A straight translation is both correct and what
  lets you drag yourself back into place when an anchor lands slightly off.

### Two files, one writer each (a race worth avoiding)

`config/areas.json` (insetLinear + the per-dungeon translations) is written **only by
main**, which solves an area the moment you walk into it. `config/calibration.json` (the
world affine, and Refine) is written **only by the renderer**. One file with two writers
would let a world Refine clobber every dungeon you'd calibrated, or vice versa.

`config/mapgenie-areas.json` is a derived cache of the extracted graph (gitignored;
re-extracted on every launch).

### Not done yet (dungeons)

**1. The game↔mapgenie dungeon-id mapping (`tools/zoneLog.js` is collecting it).**
`DD2.exe+FA62CB0` holds the game's own dungeon id, but it is not mapgenie's numbering
(game: 18 observed; mapgenie subregions: 2441–2514). Building the table would let the
game name the dungeon outright instead of us picking the nearest entrance — which would
drop the last dependence on the world affine and reach the two orphan dungeons below.

Run `node tools/zoneLog.js` while playing (it needs DD2 running and
`config/mapgenie-areas.json` present; the app writes that on launch). Every change of
zone state appends a line to `zone_log.txt` pairing `(insideFlag, zoneIndex)` with the
nearest entrance's name and its distance. **Only the CLOSE samples are trustworthy** —
a line logged deep inside a dungeon (large distance) is pairing a zone number with
whatever entrance happened to be nearest, which may be a different cave entirely.

The same log settles **what flag value 2 means**: both 1 and 2 are "inside", but the
distinction is unknown. If 2 is (say) towns rather than caves, the log will show it.

**2. Two dungeons have no entrance in mapgenie's data at all** — *Vernworth - Southern
Ruins* and *Sealed Mining Shaft*. The flag detects that you're inside *something*, but
"nearest entrance" has nothing right to pick, so they need `Insert` plus a manual
3-point calibration. The id mapping above would fix this properly.

**3. The inset scale is derived, not measured: 1.92, ±5%.**
Good enough to play with (the free anchors land a few units out), but if the true value
is 2.0 the marker drifts ~4 game units per 100 walked from an entrance, and the zoom
offset is off by a few percent with it.

The data can't do better: the noise floor is the ~20-unit door-vs-arrival offset, and
the estimators disagree systematically (least-squares 1.86 — a projection, so rotation
noise drags it down; median-of-ratios 1.92–1.97 — magnitudes, which noise inflates).

**Settling it takes one 3-point calibration inside any dungeon**, spread as wide as the
place allows. It reports `measured X vs derived 1.92`, overrides the derivation, and
applies to all 72 dungeons permanently. Until someone does it, the derived value stands.

### Crowdsourcing the database (design note — NOT built)

The idea: hand the app to several players, have them each explore, and pool what they
learn. Everything that costs playtime is in **one file**, and most of it pools cleanly —
but not all of it, and the part that doesn't is the part that would silently corrupt the
pool, so this is written down before anyone tries.

**The file to collect is `areas.json`.** In a packaged build it is NOT next to the .exe:

```
%APPDATA%\dd2-map\config\areas.json      (packaged — userData; the folder is package.json `name`, "dd2-map", not productName)
config/areas.json                        (dev)
```

Nothing else is worth collecting. `overlay.json` is personal taste, `mapgenie-areas.json`
is a re-derivable cache (gitignored), and `calibration.json` is the one file that should
travel **outward** — see below.

| key | what it is | pools? |
|---|---|---|
| `places` | buildings: mapgenie `poiId` + the game coords of the door you walked through | **perfectly** — both halves are absolute |
| `floorHeights` | the height a floor sits at, `{ h, n }` | **perfectly** — absolute game height. `n` is a visit count, so a merge can weight-average instead of last-write-wins |
| `areas` | the per-dungeon transforms | **only via `points`** — see below |
| `insetLinear` | the shared inset scale/rotation | **never take someone else's** — it's derived from *their* world affine |

**The trap.** A dungeon's `c`/`f` are solved against that player's `insetLinear`, which is
derived from *their* `calibration.json`. Two players who calibrated the world separately
have slightly different affines, so their `c`/`f` are expressed in slightly different
frames, and merging them by copying the numbers slides each imported dungeon by the
difference. It would look like it worked, and be a few units wrong everywhere.

**The way through** is already in the file: each area carries `points` — the raw
correspondence `game (x, y) ↔ mapgenie (lng, lat)` that produced it. Both halves are
**absolute**: the game coords come out of DD2's memory, the lng/lat out of mapgenie's
portal graph. Neither passed through anybody's calibration. So a merge must re-solve
`c`/`f` from `points` using the *local* `insetLinear` (`areaStore.solveTranslation` does
exactly this), never copy `c`/`f` across.

**Or sidestep it entirely:** `configStore` seeds a packaged build's userData from the copy
of `config/` inside the asar on first run. So ship the .exe with a good `calibration.json`
and ask contributors not to re-calibrate — then everyone derives the *same* `insetLinear`,
and even `c`/`f` agree. That is the cheap version, and it makes the pool trivially mergeable.

Sketch of `tools/mergeAreas.js`, if we build it:

- `places` — union by `poiId`. Conflict worth reporting rather than resolving: two players
  binding the *same* doorway to *different* POIs means one of them mis-pressed `Home`.
- `floorHeights` — weighted mean by `n` (the counter is already there for this).
- `areas` — re-solve from `points`; hand-calibrated (`auto: false`) beats auto, and prefer
  the point with the **smallest `dist`** (that field is the anchor's error — a 2u crossing
  is a better anchor than a 19u one).
- `insetLinear` — keep ours; ignore theirs.

Worth knowing before shipping the app around: `Home`, `Insert`, `PageUp`/`PageDown` are
registered as **global** shortcuts, so they are swallowed system-wide while the app runs.

### Seeker's Token ground truth (2026-07-17): 240 exact correspondences, free

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
  solve — the solve is below trust, so the token won (see trust ordering above); written
  as `2492|` with floor `''`. If the correlation solver later scores Guerco ≥ trust and
  disagrees, the solver wins and this entry should go.
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

### The full Almanac dataset is vendored: `data/almanac/` (2026-07-17)

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
described above (world affine, then inset transforms).

## Managed singletons via pure RPM — WORKS (`tools/singletonHunt.js`, 2026-07-17)

REFramework's singleton resolution (shared/sdk/REContext.cpp, MIT) is pointer reads all
the way down, so it ports to out-of-process ReadProcessMemory. The tool does the whole
chain and it is **verified live against DD2** (TDB version 73):

1. Pattern-scan DD2.exe for `48 8B 0D ?? ?? ?? ?? BA FF FF FF FF E8` (`mov rcx,
   [rip+disp]` loading the `via.clr.VM` global). Found: **`DD2.exe+0xf8cbce0`** —
   module-static, same class as the position block. The pattern scan re-finds it after
   a patch; the RVA is stable within a build.
2. VM+`0x3618` → TDB (magic `"TDB\0"`, version 73 at +4). 174,675 types.
3. VM+`0x35d0` → static tables (`{elements, size}`; size == numTypes — good check).
4. TDB tdb73 layout: `types[]`@+0x60 (0x48/entry, RETypeDefVersion71: index:19 |
   parent:19 | … , `managed_vt` @+0x40), `typesImpl[]`@+0x68 (0x30/entry, name/ns
   string offsets @0/@4, static_field_size @0xC), `stringPool`@+0xD0. Bulk-read all
   three and find any type by full name.
5. **The instance is NOT in the type's own statics.** It sits on the generic ancestor
   `AppSingleton`1<T>`'s statics (walk `parent_typeid`), slot +0x8 — validated by the
   slot target's first qword equalling the *derived* type's `managed_vt`.

`node tools/singletonHunt.js [--save] [TypeName ...]` (DD2 running) prints the chain and
instance addresses; `--save` writes `config/singletons.json` (RVA + type indices + the
per-session instance pointers). Resolved and vt-verified: `app.GenerateManager`,
`app.TimeManager`, `app.GimmickManager`.

**First live read:** `app.TimeManager` instance +0x10 is a double that advanced 3.0167
in 3.0 real seconds — the elapsed-seconds accumulator (~370,165 at time of reading;
semantics — day-relative vs total, timeScale interaction — still to pin down). This was
superseded by the real clock fields once found — see "In-game clock" below.

**`--deref <TypeName> <fieldName>` (2026-07-17):** resolves a field's offset the same
way `--fields` does, dereferences its live pointer, and dumps THAT object's own field
table — for reaching into a non-singleton nested object (a collection, a component) one
named hop at a time instead of hand-computing offsets. First use:
`--deref app.GenerateManager _NeverGenetateID` (see "Collected-token filtering" below).

Per-session instance pointers move between launches; the durable recipe is
RVA → VM → staticTbl → `elements[holderTypeIndex]` → slot +0x8, re-resolved at attach,
which the runtime reader should do each boot (cheap: four reads once the RVA is known).

## In-game clock — SHIPPED (`src/main/timeReader.js`, 2026-07-17)

Time of day lives in the RE Engine managed singleton **`app.TimeManager`**, reached via
the singleton-RPM chain above. Community accessor names (from the [Clock mod
source](https://github.com/xyzkljl1/MyDD2Mod)) pointed at the right object;
`tools/singletonHunt.js --fields app.TimeManager` then dumped the real tdb73 field table
with **live values**, which is how the actual layout below was found — no REFramework,
no il2cpp dump.

**Layout**, instance → `_TimeData` (a nested `app.TimeManager.TimeData`-shaped object,
field offset `+0x20` on the instance):

| field | offset | meaning |
|---|---|---|
| `_TimeData` pointer | instance `+0x20` | (`_TimeDataLook` at `+0x28` mirrors it, both observed identical) |
| day | `TimeData +0x2c` (i32) | in-game day counter |
| day-seconds | `TimeData +0x40` (f32) | seconds into the current day, **wraps at 2880** |

Clock constants are the game's own statics on `TimeManager` (read live, not guessed):
`InGameDaySeconds = 2880`, `InGameHourSeconds = 120`, `InGameMinuteSeconds = 2` — so a
day is 2880 *real* seconds (48 minutes), and `hh = daySec/120`, `mm = (daySec%120)/2`.

**The clock freezes** while the game pauses world time (menus, tutorial popups — a
frozen read is the game behaving, not a stale chain; verified by watching `WholePlayTime`
at instance `+0x10` keep advancing 1:1 with real time throughout).

`src/main/timeReader.js` re-resolves the 4-hop chain every read (config from
`config/singletons.json`'s `app.TimeManager` entry) and rejects out-of-range values
(`daySec` outside `[0, 2880]`, `day` outside `[0, MaxGameDay=1000000]`) rather than
showing a garbage clock. Wired onto `game-position` as `gameTime: {day, hh, mm}` (null
if unresolvable). Displayed in the control window's coords readout (`time  day 107
05:20`) and on its own line in the overlay's area-readout HUD (`#hudTime`), where a
ticking clock alone is now enough to keep the HUD visible on the open overworld.

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
interpMs` (default 24ms — roughly 1.5 feed intervals, enough to guarantee two real
samples straddle it), lerping position/fov/aspect linearly and re-normalizing the basis
vectors after lerping. The scene runs ~24ms latent (invisible except on very fast
flicks) but is judder-free regardless of feed rate, monitor refresh, or phase — the
right fix for "camera feed vs vsync" mismatches generally, worth remembering for any
future 60Hz+ overlay work.

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
don't retune by feel), `floatU`/`floatFadeU` (1.6/8, cosmetic), `interpMs` (24, smooth↔snappy),
`edgeMax` (12), `collectedPollMs` (3000, see below).

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

### Golden Trove Beetle collected-state — SHIPPED (`src/main/gimmickReader.js`, 2026-07-17)

Beetles are the second AR collectible, and their collected-state is nothing like tokens'.
It is **per-gimmick and local** — read off the live beetle object in the world, so it only
resolves for beetles currently streamed in near the player. That's exactly the AR layer's
regime (radius-limited), so it's the right tradeoff; a beetle the game hasn't loaded just
keeps its marker until you get close.

The path, all found live by walking `app.GimmickManager` (already singleton-resolved) and
byte-diffing (`config/singletons.json` `beetleGimmickChain` has the offsets):

- **What a beetle *is*.** The runtime component is `app.Gm82_009` (NOT `Gm82_080` — that's
  the almanac's data-group id; the runtime component type differs). Its own fields are a
  giveaway: `GatherContext`/`GatherNum`/`OnGatherItem`/`IsGivedItem` (it's a gatherable)
  plus a pile of light fields (`PointLight`, `EmissiveTimer`, `MoonLightEff`, `TurnOn`) —
  it's a *glowing* gatherable. `Gm82_009` is generic: several unrelated gatherables share
  it, so a beetle is specifically a `Gm82_009` sitting within ~2.5u of a known almanac
  beetle position. The others (28–62u away) are not beetles.
- **Finding it.** `GimmickManager` instance `+0x10+0x18` → `ManagedGimmicks`
  (`HashSet<GimmickBase>`, ~535 loaded gimmicks, same HashSet layout as `_NeverGenetateID`).
  Filter to `Gm82_009` by vtable — but the vtable *value* moves each launch, so it's
  resolved fresh from the TDB (`types[61564] + 0x40`), not stored.
- **Its world position** (to bridge to an almanac GUID): `gimmick +0x10` (GameObject)
  `+0x18` (Transform) `+0x80` (worldMatrix) `+0x30` (row3 = pos: x@+0, z@+8). This is in
  the **cell-local floating-origin frame** — add the same global−local offset the marker
  feed uses and it matches an almanac beetle to **0.00u**. (The missing GameObject→Transform
  indirection is why an early position scan found nothing; `gimmick+0x10` is the GameObject,
  not the Transform.)
- **The collected flag: byte at `gimmick +0x3e4 == 1`.** Found by snapshotting one beetle
  before/after gathering it. The key was a **0-drift alive baseline**: a first attempt
  diffed snapshots minutes apart and got fooled by a continuously-updating light/timer
  float at `+0x3f8` (and by a co-located lantern of a *different* type — the reason the
  first suspected type, the light gimmick, was wrong). Snapshotting the same beetle twice
  while alive showed exactly which bytes self-drift (`+0x3f8..+0x3fb`); excluding those, a
  gather flips **7 booleans together** (`0x36a,0x36b,0x370,0x374,0x3e4,0x407,0x40a`), all
  of which **persist** with no post-gather revert. `0x3e4` is the one the reader uses.
  Verified end-to-end: of 10 loaded `Gm82_009`, exactly the one just gathered reads the
  flag and maps to its almanac GUID.

**Wiring:** the same `collectedTimer` calls `gimmickReader.read(handle, moduleBase,
frameOffset, beetlePois)` and unions the returned beetle GUIDs into the token set before
the diff/broadcast — one `collected-tokens` message carries both, and the overlay filters
`arPois` by GUID regardless of kind. Beetle POIs are cached main-side (`arBeetlePois`)
because the reader needs them to turn a nearby gimmick's position back into an almanac GUID.

**Not yet verified:** whether a beetle gathered in a *previous* session loads pre-flagged
when re-streamed (the thing that makes startup-filtering work across sessions). Collecting
one live in-session is confirmed; the cross-session case awaits an in-game check.

## Reusable RE workflow (for finding cell index or any future value)
1. Value-scan for candidates; discriminate with camera-rotation (unchanged) +
   jump (height up/down) + movement (changed) filters. Tools: `tools/scanner.js`
   (snapshot/filter-changed/filter-unchanged/filter-direction/proximity/context).
2. Confirm struct + get base: `tools/ce_find_pointer.lua` in CE ("find what writes" ->
   captures base register + offset to `ce_out.txt`).
3. Pointer-scan the base in CE GUI; narrow across a full restart + reloads (re-run
   the Lua after each to get the new base fast); validate survivors with
   `tools/testChains.js`.
4. Wire into `index.js` via `resolvePointerChain`.
