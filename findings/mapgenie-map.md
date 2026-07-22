# mapgenie's map internals

Measured facts about the embedded Mapbox/MapLibre instance: layers, found-POI paint, and syncing found marks between the two windows.

See also: [the overlay](overlay.md), [world calibration & follow](calibration-and-follow.md).

## The library: Mapbox GL JS, then MapLibre GL

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
- The embed is the official mapgenie `?embed=light` in an Electron `<webview>`.
  Host-side `executeJavaScript` reliably reaches `window.map`; a `<webview>` preload
  does **not** share `window.map` in this Electron version, even with
  `contextIsolation=false`.

## Measured facts about mapgenie's Mapbox instance
Read live at startup by `__dd2_probe()` and logged — never hardcoded:
- **Canvas alpha = `true`.** This is what makes icons-only mode possible at all:
  hide the non-symbol layers and the WebGL canvas is genuinely transparent, so the
  game shows through. If a future mapgenie change flips this to `false`, layer-
  hiding can't work and the only fallback is rendering POIs ourselves as DOM
  markers from `querySourceFeatures` (viewport-only). The app detects and warns.
- **Zoom range 7–16**, opens at 12.
- **14 layers, 5 of them symbol.** The 5 symbol layers are the POI icons+labels
  (what icons-only keeps); the other 9 are the map itself.

## The layer list is NOT stable (cost real debugging time)
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

## Found POIs are a paint expression, not a layer (and not filterable)
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

## Found-state sync between the two windows
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


## mapgenie's style claims z17 tiles that don't exist — 403s at max zoom (2026-07-20)

Symptom: at the deepest zoom the map went blank, and both webview consoles filled with

```
Error: AJAXError: (403): https://tiles.mapgenie.io/games/dragons-dogma-2/world/world-v1/17/65255/65311.jpg
```

The obvious reading — "our zoom driving is walking past the map's limit" — is **wrong**,
and chasing it wastes a pass. The camera was never out of range: the startup probe reports
`range 7–16`, i.e. mapgenie's own style already caps `map.getMaxZoom()` at 16, and there is
no code path that can exceed it.

The real cause is one level lower. Both raster sources declare a maxzoom the server does not
honour:

```
World          type=raster tileSize=256 minzoom=7 maxzoom=17
Unmoored World type=raster tileSize=256 minzoom=8 maxzoom=17
```

z17 is a **lie** — every z17 tile 403s; z16 is the deepest that exists (which the inset
resolver already knew, see "z16 is not a preference" in
[inset-resolve-wip](inset-resolve-wip.md)). And because `tileSize` is **256**, not
the MapLibre default 512, the covering tile zoom is one level *above* the camera zoom
(`round(zoom + log2(512/tileSize))`). So merely sitting at the permitted maximum camera zoom
of 16 asks for **z17** tiles. The legal top of the camera range was unusable.

Fix (`mapAgent.buildClampZoom`, injected on every `dom-ready` in both windows): clamp each
raster source's `maxzoom` to 16. MapLibre then **overzooms** the z16 tiles it already has, so
the whole 7–16 camera range keeps working — the bottom of it just renders upscaled instead of
blank. Verified behaviourally: 403 count went 25+ → **0** across a 30s run, probe still
`range 7–16`.

Two traps in doing it:

- It must go through **`map.getSource(id)`**. `map.getStyle()` returns a *serialized copy* of
  the style; mutating `getStyle().sources[id].maxzoom` changes nothing. `SourceCache` reads
  `maxzoom` off the live source object on every update, which is why a plain assignment plus
  a `triggerRepaint()` is enough — no source re-add, no style reload.
- Do **not** "fix" this by capping the camera (`setMaxZoom(15)`). It also silences the 403s,
  but at the cost of a whole zoom level of reach, and it treats a data bug as a camera bug.

Not a knob in `overlay.json`: it is a fact about mapgenie's tile server, not something that
can be judged while playing. `MAX_TILE_ZOOM` is a constant in `mapAgent.js` — raise it if
they ever publish z17 for real.

## z17 403s came BACK — the clamp was one-shot; it must re-assert on styledata/idle (2026-07-21)

`buildClampZoom` clamped each raster source's maxzoom to 16 exactly once. But mapgenie
rebuilds its style under us — the 2-layer base → full stream, a World/Unmoored switch, a
POI-category toggle, and (new) the OFFLINE cache re-serving mapgenie's verbatim maxzoom:17
style — and each rebuild creates a FRESH raster source back at 17, with nothing re-clamping
it. So z17 tiles get requested again (403 online, 504 through the offline mirror, which only
has z7–z16). This is the same "the layer/style list is not stable" trap that
applyBasemap/applyHideFound already handle by re-applying on styledata/idle.

Fix: `buildClampZoom` now defines `applyClamp()` and, once per guest, hooks it on
`map.on('styledata')` + `map.on('idle')` (guarded by `window.__dd2_clamp_hooked__`, which
resets on dom-ready since the SPA wipes the guest JS context). Repeated maxzoom assignments
are no-ops once already at 16, so it can't loop. Validated live: `World.maxzoom` stays 16
across a full `setStyle(…,{diff:false})` rebuild (styledata fired 4×, re-clamped each time);
the one-shot version reverted to 17. NOTE it needs a beat — idle/styledata re-clamp fires
within a few seconds of the rebuild, not instantly.
