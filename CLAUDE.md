# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron app that reads the player's position out of `DD2.exe`'s memory and draws
it on the mapgenie.io map for Dragon's Dogma 2 — in a normal window, and in a
transparent click-through overlay on top of the running game.

**Read `FINDINGS.md` before changing anything non-trivial.** It is the project's
memory: the memory offsets and how they were found, and — more importantly — the
long list of things that *look* like they should work and don't (Mapbox layer
visibility, Windows foreground rules, asar write-protection). Most of them cost real
debugging time and are not rediscoverable from the code alone. This file covers
*where* things live; `FINDINGS.md` covers *why* they are that way.

## Commands

```
npm start        # run in dev (electron .)
npm run dist     # build dist/DD2Map.exe (portable, ~72MB)
node tools/<x>.js   # the RE tooling — run from the repo root
```

There is **no test suite, no linter and no build step** for the app itself: the
renderer is plain HTML + vanilla JS loaded with `<script src>` (no bundler), and the
main process is CommonJS. `node --check <file>` is the only static check available.

Verification is therefore behavioural, and DD2 must be **running** (and in
**Borderless Windowed** — nothing draws over exclusive fullscreen) for anything
position-related to exercise. A quick smoke test:

```
timeout 14 npx electron . 2>&1 | grep -E "map probe|WARNING|FAILED"
```

Startup logs a `[overlay] map probe:` line (canvas alpha, real zoom range, layer
count) and shouts if a hotkey failed to register or the map canvas can't do
transparency. `Render frame was disposed` on SIGTERM is a kill artifact, not a bug.

## Architecture

### One position feed, two windows

`src/main/index.js` polls DD2's memory at 30 Hz and `broadcast`s `game-position` to
**every** window. Two windows consume it:

- **control window** (`renderer/index.html` + `renderer.js`) — the map, the
  calibration flow, the overlay's settings UI. The overlay has no UI of its own, so
  anything the user must be able to click lives here.
- **overlay** (`renderer/overlay.html` + `overlay.js`) — fullscreen, transparent,
  always-on-top, click-through. Map + player marker, nothing else.

They are **two separate mapgenie SPA instances**. That is the source of several
non-obvious constraints (see "found-sync" below).

### The guest script is where the map work happens

Neither renderer manipulates the map directly. `renderer/mapAgent.js` builds
**strings of JS that are injected into the mapgenie page** via
`webview.executeJavaScript`, and exports three builders:

| Builder | Installs |
|---|---|
| `buildInstallMarker` | the player marker, the 60 fps locked-centre follow loop, zoom driving, icons-only mode, hide-found, the startup probe |
| `buildFoundSync` | the Redux `dispatch` patch that mirrors found-marks to the other window |
| `buildExtractAreas` | pulls mapgenie's region/portal graph out of its Redux store |

Injection as a *string* is not a style choice: **a `<webview>` preload does not share
`window.map` with the page** in this Electron version, even with
`contextIsolation: false`. Host-side `executeJavaScript` is the only thing that
reaches the real Mapbox instance. The guest has no `ipcRenderer`, so it talks back by
`console.log`-ing a prefixed line (`__DD2_CALIB__`, `__DD2_FOUND__`) that main parses
out of the `console-message` event.

Both windows share `renderer/calibration.js` (`window.DD2Calib`) and `mapAgent.js`
(`window.DD2MapAgent`) — loaded by `<script src>` in both HTML files so the two can't
drift apart.

### Coordinates: two transforms, two files, two writers

`game (x, y)` → `mapgenie (lng, lat)` is a **2D affine**. There are two of them:

- **World affine** — `config/calibration.json`. Solved by clicking 3+ landmarks in
  the control window; Refine appends a point and re-solves. Written by the
  **renderer**.
- **Dungeon insets** — `config/areas.json`. mapgenie draws each dungeon as an inset
  panel off to the side of the world map, in the same lng/lat plane, while DD2 keeps
  reporting ordinary world coords inside caves. Every inset shares **one** linear
  part (`insetLinear`) and differs only by translation, so **one** correspondence
  pins a dungeon — and walking through a doorway supplies that correspondence for
  free. Written by **main** (`areaStore.js`).

Two files with one writer each, deliberately: a single file with two writers would
let a Refine clobber every dungeon you'd calibrated.

`DD2Calib.forArea(worldCal, areas, areaKey)` picks the right one. It returns `null`
for an area that can't be placed — callers must **not** fall back to the world
affine, which would confidently draw the marker out in the overworld while the player
is underground.

### Area tracking

`src/main/areaTracker.js` decides which area the player is in. Main owns this (both
windows must agree, so exactly one may decide) and stamps `areaKey` onto the position
feed.

Three questions, three different answers — all read from one 32-byte window of module-
static memory (`DD2.exe+FA62C94`, no pointer chain):

- **Whether you're inside** — the game's flag at `+FA62CAC`. 0 = overworld, 1 and 2 both
  = inside. Authoritative; never height (it's continuous through a cave mouth, and
  "inside" isn't even reliably lower — towers). Note it means "inside", **not "inside a
  dungeon"**: every house and shop sets it too.
- **Which dungeon** — the nearest known entrance from mapgenie's portal graph, **but only
  within `dungeonEnterRadius` (20u)**. Beyond that we don't answer: buildings set the flag
  and have no entrance POI at all, so an unbounded "nearest" once calibrated a dungeon
  from **219u away** and saved that error forever. Too far → stay on the overworld (your
  world coords are still right indoors) and let the overlay offer it; `Insert` accepts and
  skips the radius, because then the guess is yours. The game's own dungeon id sits right
  there at `+FA62CB0`, but it's the *game's* numbering, not mapgenie's, and the mapping
  doesn't exist yet. `tools/zoneLog.js` is collecting it.
- **Which floor** — **height**, learned per dungeon into `areas.floorHeights`. This is the
  only signal that can carry it: the game reports the *same (x, y)* on every floor, so
  floors differ in z and nothing else. `PageUp`/`PageDown` names a floor, the app measures
  how high it sits (once your height *settles* — you press the key on the stairs, which
  belong to no floor), and from then on height picks the floor. Absolute height, never
  height *change*: real floor gaps run 5.8u–16.6u while height wanders 4u within one floor,
  so no fixed threshold works. **The room id at `+FA62C94` is NOT a floor** — same hash at
  h=-13.7 and h=-5.2 — and a learned room→floor table was tried and failed; don't retry it.

**Most interiors are not dungeons at all** — they're houses, shops, inns, and mapgenie
draws no inset for any of them. Nothing needs placing (indoors the game still reports true
world coords, so you're already drawn in the right building); only the *name* is missing.
`Home` (`tracker.rememberPlace()`) binds the nearest **place POI** — mapgenie's
`Locations`/`Facilities` groups, matched on group *title*, `Transition` excluded — to the
doorway you're standing in, and main saves it to `areas.json` under `places`. That doorway
is then recognised forever: the HUD names the building, and no dungeon is guessed there
again. It binds *your* position, not the POI's (mapgenie's icon can sit on a roof), and
refuses past `placeRadius` (40u).

`Insert` covers the two dungeons mapgenie has no entrance for. Floor labels sort by
`floorRank()`, not alphabetically — B1F is *below* 1F — and an unlabelled `''` floor is
dropped unless it's the only one (it would otherwise be a phantom floor with no panel).

Where the tracker won't guess, it says so: `tracker.hint()` returns a structured
"what I'm unsure about, and which keys settle it" (or null), main turns it into English
(it owns the hotkey names — `describeHint`, whose `actions` are the offers: `Home` = it's
this building, `Insert` = it really is that dungeon), and it rides the position feed to
**both** windows. The overlay draws it as `#areaHud`; the control window appends it to the coords
readout. A guess the player can't see is a guess the player can't correct — that is what
let a 219u mis-calibration sit in the console unnoticed.

### Found-mark sync between windows

The two mapgenie instances only read the found-set from the server on load, so a mark
in one was invisible to the other until a reload. `buildFoundSync` patches
`store.dispatch` in both guests; if a dispatch changed `user.foundLocations`, the raw
action is bridged to main and replayed in the other window.

The Redux **action type is never hardcoded** — it's minified to a single-letter
variable and cannot be written by hand. A mark is detected by whether the dispatch
*changed* `user.foundLocations` (reducers return a new object, so an identity check
suffices). The HTTP write lives in the *thunk*, not the action, which is why replaying
the plain action cannot double-write to the server.

## Things that will bite you

- **Config writes.** Always go through `configStore.js`. In a packaged build the
  bundled `config/` is inside `app.asar` and **read-only — writes fail silently**, so
  settings appear to save and then vanish. `configStore` writes to `userData` when
  packaged and seeds from the asar copy. (Packaged userData is `%APPDATA%\dd2-map`,
  keyed off package.json `name`, *not* electron-builder's `productName`.)
- **koffi must stay in `asarUnpack`.** It's a native addon; it cannot load from
  inside an asar, and without it there is no `ReadProcessMemory` and no position.
- **Never blanket-restore Mapbox layer visibility to `visible`.** 8 of mapgenie's 14
  layers ship *hidden* (an alternate-world raster, region fills); switching them all
  on turns the map black. Icons-only records each layer's original visibility and
  restores exactly that.
- **The overlay is never the focused window**, so Chromium throttles it to ~1 fps
  unless `backgroundThrottling: false` is set on the window *and* on the `<webview>`
  tag *and* the command-line switches in `overlayWindow.applyThrottlingSwitches()`.
- **Alt-hold has to be polled** (`win32Input.js`): `globalShortcut` only ever fires on
  key *press*, never release.

## Config

`config/overlay.json` — every knob that decides how the overlay *feels* (speed
thresholds, dwell times, zoom steps, opacity/brightness per mode, hotkeys).
`src/main/overlayConfig.js` holds the defaults, so a missing or partial file still
boots. Prefer adding a knob there over hardcoding a constant — the numbers that
matter can only be judged while actually playing.

`config/mapgenie-areas.json` is a re-derived cache and is gitignored;
`config/areas.json` is not — it holds solved transforms that cost playtime.

