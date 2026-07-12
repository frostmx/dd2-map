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
    areaTracker.js    # which area you're in: doorway proximity + inset containment
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

### Dead ends / corrections (so we don't repeat them)
- First "position" found (`0x3b8c4c60` struct) was **camera position, not player** —
  it moved when only rotating the camera. Discriminators that separated them:
  (1) camera-rotation-invariance, (2) jump raises/lowers height, (3) large smooth
  X/Z change on walk while height stays flat.
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

### Height is NOT usable to detect "inside" (measured in-game — this killed the first design)

The obvious detector — a z-band per dungeon — does not work, and it's worth writing
down so nobody rebuilds it:

- Entering a cave produces **no step change in height**. The coordinate runs
  continuously straight through the doorway.
- Inside is **not reliably lower**. A tower's interior climbs *above* its own entrance.

So there is no height band separating inside from outside, and any z-gate misfires on
towers. Height is still read and broadcast, but nothing keys off it.

### What we detect on instead: the doorway, plus a containment backstop

1. **Doorway.** Inverting the world affine (`DD2Calib.invert`) puts each of the 131
   entrances at a known point in GAME coordinates. Come within `enterRadius` (10 units,
   measured) and you've gone through it. The *same* doorway is both the way in and the
   way out, so one rule drives both; re-arming only once you're `rearmRadius` (30 units)
   clear is what stops it strobing while you stand in the entrance.
2. **Containment backstop.** The doorway rule alone is too brittle to be the only way
   out: it needs you to pass within 10 units of a point *derived* from the world affine,
   so it inherits that affine's error, and a slightly wide exit path simply misses it —
   leaving the map stuck in an inset while you stand in daylight. (Simulated: an exit
   path passing **13 units** from the doorway never fires.) So we also run the player
   through the current area's transform and check they still land inside the inset
   panel mapgenie drew. Strong signal precisely *because* insets are drawn several
   times larger than the world: once genuinely outside, the magnification throws you
   far out of the panel. Needs the dungeon calibrated, so it can't be the only rule
   either — the two cover each other.
3. **Manual override** (`Insert` in/out, `PageUp`/`PageDown` floor). Not a fallback —
   a first-class control. Two failure modes are visible to the player and invisible to
   the app: brushing past a cave mouth without going in, and **dropping through a hole
   to the floor below without ever touching a portal**.

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
