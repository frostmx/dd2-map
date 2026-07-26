# DD2 Map

Live map overlay for Dragon's Dogma 2: embeds the mapgenie.io world map and shows
the player's real-time position, read from `DD2.exe`'s memory.

No kernel driver and no injection — DD2 has no anti-cheat, so plain user-mode
`ReadProcessMemory` (via koffi) is enough. See `FINDINGS.md` for how the memory
offsets were found and every non-obvious thing learned along the way.

## Setup

```
npm install
npm start
```

Two windows open: the **control window** (the map plus a settings panel — this is
where you browse the map and tune the overlay) and the **overlay**, which starts
hidden. There is no calibration step: the map ships already aligned to the game's
world coordinates.

They're two separate mapgenie instances, but **found-marks sync between them live**
— mark a POI in either and the other updates immediately, no reload.

## Overlay

A fullscreen, transparent, always-on-top, click-through window that draws over
the game: just the mapgenie layer and your player marker, no buttons or readouts.
Keys and clicks pass straight through to DD2 unless you hold Alt.

**Run DD2 in Borderless Windowed.** Nothing can draw over exclusive fullscreen —
that's a Windows limitation, not something the app can work around.

| Key | Does |
|---|---|
| `F8` | Overlay on / off (also hides the control window while it's up). Comes back in whatever mode you left it in. |
| `F9` | Cycle the overlay's map mode: **icons-only → full map → windowed box** → back to icons-only |
| `F10` / `F11` | Zoom out / in |
| `Insert` | Force enter / exit a dungeon — see [Dungeons](#dungeons) |
| hold `Alt` | Give the overlay the mouse: click POIs, drag the map, scroll to zoom. Release to hand input back to the game. A blue border shows while it's held. |

**F9 cycles three map modes; F8 just shows/hides whichever one is current.**

- **Icons-only** — POI icons floating over the live world, no map. The mode you play
  with, and where the overlay starts on first launch (`openIconsOnly: false` in the
  config starts it on the full map instead).
- **Full map** — the ordinary fullscreen mapgenie view.
- **Windowed box** — the map in a movable, resizable panel (drag the top bar to move
  it, the edges/corners to resize) instead of covering the whole screen. Its position
  and size are remembered as fractions of the screen, so they survive a resolution
  change.

Toggling the overlay off and back on with `F8` **preserves whatever mode F9 last
left it in** — it no longer snaps back to icons-only, so a full map or windowed box
you had up stays up.

The marker is a **dot with an arrow**: the dot is your position, the arrow points
where you're heading. There's no facing angle in memory, so the heading comes from
your movement vector — it holds its last direction while you stand still.

**Rotate to heading is off by default.** Tick it in the control window and the
overlay's map turns so the way you're *running* is up: a POI drawn above the marker
is then simply straight ahead, instead of you working out which way to turn so the
arrow ends up on it. The arrow just points up, and the map eases round as you turn
(`rotateEase` in the config: higher = snappier). Since the heading is your movement
vector, running backwards turns the map around. The control window stays north-up.

**Holding Alt briefly focuses the overlay, so DD2 loses focus for as long as you
hold it.** That's not incidental, and it's why the mouse works at all: DD2 pins the
cursor to screen centre and only releases it when it loses focus, so there is no way
to click a POI without taking focus. Let go of Alt and focus goes straight back to
the game. (It also means the scroll wheel only reaches the overlay while Alt is
held — Windows routes the wheel to the focused window. `F10`/`F11` work anytime.)

**Auto-zoom is off by default** — the overlay just holds whatever zoom `F10`/`F11`
set. Tick *Auto-zoom* in the control window to turn it on: after you've been
**moving for 3 seconds** the map eases out by `runZoomOut` levels (default 1.4 ≈ a
2.6x wider view), and eases back in once you stop. `F10`/`F11` still move the
*standing* zoom, and running pulls back from wherever you set it — so the two
never fight. Turning it off mid-run glides straight back to your standing zoom.

### Map style

The full-map and windowed-box modes can draw either mapgenie's ordinary full-colour
raster, or our own **edge art** — line art baked from the game's own map textures —
over the same tiles. Pick one with the *Full color* / *Edge* radio buttons in the
control window (`mapStyle` in the config). Edge is the default look the overlay is
built around; if no edge art has been baked for the area you're in it just falls
back to the raster.

### AR collectible markers

A checkbox in the control window (`arCollectibles`, on by default) projects nearby
**Seeker's Tokens** (green circles) and **Golden Trove Beetles** (yellow diamonds)
onto the overlay at the collectible's real position in 3D, using the game's own
camera basis and field of view — not a map-plane icon. Markers fade in with
distance, clamp to the screen edge as arrows when off-screen, and drop out once
you've actually picked the collectible up. The `ar` block in `config/overlay.json`
tunes range, marker size, and the render-interpolation delays that keep the effect
from jittering; it's tuning-only, with no control-window UI of its own.

### Opacity and brightness

Sliders in the control window's panel, live while you drag them, and persisted.
They only ever touch the *overlay* — the game itself is never modified. Each of the
two modes gets its own opacity **and** brightness, because the full map and bare
icons want different amounts of both:

- **Full map (F9 on)** — `mapOpacity`, `mapBrightness`
- **Icons only (F9 off)** — `iconOpacity`, `iconBrightness`

**Why brightness exists.** The overlay composites over the game with straight
alpha: the OS just blends our pixels onto the game's. mapgenie's style is a *light*
one (near-white), so fading it to 30% literally adds 30% white to every pixel — it
reads as glare, not as a faint map. CSS blend modes can't help; they only blend
within our own window and can't see the game underneath. Darkening the overlay's
own pixels first is the fix: below about 40% brightness it's darker than the game,
so a faint overlay reads as a *shadow* over it rather than a wash. Contrast is
nudged up automatically as it darkens, or roads and labels turn to mud.

### Tuning

Everything about how the overlay feels lives in `config/overlay.json` — edit and
relaunch, no code changes.

| Key | Meaning |
|---|---|
| `hotkeys` | Rebind any of the keys (any Electron accelerator string) |
| `openIconsOnly` | **Default `true`.** Which of the three F9 modes the overlay starts in on launch (icons-only vs. full map). F9/F8 take over from there — see [Overlay](#overlay). |
| `mapStyle` | `'edge'` (default) or `'color'` — see [Map style](#map-style) |
| `windowRect` | The windowed-box mode's position/size, as screen fractions. Written automatically when you drag or resize it. |
| `arCollectibles` | **Default `true`.** The AR collectible markers checkbox — see [AR collectible markers](#ar-collectible-markers). |
| `ar` | Tuning for the AR markers (range, size, interpolation delays). No control-window UI; hand-edit only. |
| `baseZoom` | The standing zoom. Set by `F10`/`F11` and persisted; `null` = adopt the map's own zoom on first run. The map's real range is 7–16. |
| `zoomStep` | How far one `F10`/`F11` press moves the base zoom |
| `autoZoom` | **Default `false`.** The checkbox in the control window. The four keys below only apply when it's on. |
| `runZoomOut` | How many **zoom levels** below the base to pull back while running. Levels, not a percentage — Mapbox zoom is logarithmic, so one level = 2x the view. `1.4` ≈ 2.6x wider. |
| `runSpeed` / `stillSpeed` | Game units/sec thresholds for "running" / "standing still" |
| `runDwellMs` | How long you must be moving before it zooms out (default 3000). The timer survives the dead band between the two speeds and only resets when you actually **stop** — real running dips below any fixed threshold constantly, so a timer that reset on every dip would never get there. |
| `stillDwellMs` | How long you must be still before it zooms back in |
| `zoomEase` | Per-frame zoom glide rate; higher = snappier |
| `hideFound` | **Default `true`.** Hides POIs you've marked as found — in the *overlay* only; the control window still shows them so you can mark them. mapgenie merely fades found POIs to 40% opacity, which stops reading as a distinction at all once the overlay's own opacity and brightness are stacked on top. |
| `mapOpacity` / `mapBrightness` | The full-map sliders above |
| `iconOpacity` / `iconBrightness` | The icons-only sliders above |
| `hideWhenGameUnfocused` | Hide the overlay when you alt-tab away from DD2 |
| `hideMainWindowWithOverlay` | Hide the control window while the overlay is up |
| `focusable` | Default `true`: Alt focuses the overlay so the game releases the cursor. Set `false` if you'd rather the game never lose focus — but then the cursor stays pinned at screen centre and POIs can't be clicked. |
| `dungeonEnterRadius` | How close to a known dungeon doorway (game units) the "inside" flag is taken as *that* dungeon. Default 20 — see [Dungeons](#dungeons). |
| `placeRadius` | How far `Home` (dormant by default) will bind or recognise a named building. Default 40. |
| `areaHud` | **Default `true`.** The overlay's area readout — where you are, the nearest dungeon, what to press when the app is unsure. |
| `areaHudRadius` | How near a dungeon has to be before the readout mentions it (game units). Default 150 — deliberately wider than `dungeonEnterRadius`, so it can tell you an entrance is near before you're close enough to trigger it. |

When run from a terminal, startup prints a `[overlay] map probe:` line with the
map's canvas alpha, real zoom range and layer count, plus a loud warning for the
two failure modes worth knowing about: a hotkey another app already owns, or a map
canvas that can't do transparency (which would break icons-only mode).

## Dungeons

mapgenie draws each dungeon as an **inset** — a zoomed panel off to the side of the
world map. DD2's caves are seamless world geometry, so the game reports ordinary world
coordinates inside one, and without this the marker would sit out at the cave mouth
while the cave's POIs sat far away in the inset. **1,227 of the 5,354 POIs (23%) live
in those insets.**

**None of this needs calibrating** — the insets are aligned to the game's coordinates
ahead of time and shipped in `config/dungeons.json`. The app only ever *reads* that table;
nothing learns a dungeon transform at runtime. Placing a dungeon comes down to three
questions the app answers from the game's own memory:

**Whether** you're inside is a flag the game keeps in memory — no guessing, no threshold.
(It means "inside a building", not specifically a dungeon; houses and shops set it too.)

**Which** dungeon comes from mapgenie's own portal graph: it knows where the cave mouths
are and which inset each leads to, so the one you're standing nearest when the flag flips
is the one you walked into — but only within a short radius (20 game units), because
buildings set the flag too and have no entrance at all. Beyond that radius the overlay
just names the nearest dungeon as a *suggestion* and `Insert` accepts it.

**Which floor** comes from the game's **LocalArea** pointer: its id is unique per
(dungeon, floor) and survives falls, lifts and teleports, so the right floor is picked
automatically on every visit with nothing to teach. (The game reports the same (x, y) on
every floor, so height alone could never tell them apart — this is why the id matters.)

(The game also keeps its own dungeon *id*, which would name the dungeon outright — but
it's the game's numbering, not mapgenie's, and the mapping between them doesn't exist
yet. `tools/zoneLog.js` is how it gets built; see `FINDINGS.md`.)

Two dungeons have no entrance in mapgenie's data at all — **Vernworth - Southern Ruins**
and **Sealed Mining Shaft**. Both now carry a trusted LocalArea id, so the pointer names
them on entry anyway; `Insert` is a legacy fallback for forcing in / out.

### When it guesses wrong

In/out and the floor both come from the game, so those shouldn't need correcting. The one
thing the app can't see is a dungeon it's standing too far from the entrance of (or one
with no entrance in mapgenie's data). There the overlay names its best guess and:

- `Insert` — force in / out, accepting that guess (it skips the entrance radius, because
  then the call is yours).

## Offline map

Both windows can serve the map from a local cache instead of mapgenie.io. Pick
**Auto** (use the cache if mapgenie is unreachable), **Online**, or **Offline** with
the radio buttons in the control window. The first time a map source is available,
the app mirrors its tiles and page assets to `%APPDATA%\dd2-map\mapcache` so a later
session can run with mapgenie fully unreachable — see `findings/offline-cache.md`
for how the caching and local HTTPS interception work.

## Repo layout

- `src/main/` — Electron main: the 30 Hz memory poll, hotkeys, the overlay window,
  area tracking (`areaTracker.js`), the LocalArea floor reader (`localAreaReader.js`),
  the game-camera and collected-item readers behind AR collectibles
  (`cameraFrameReader.js`, `generateManagerReader.js`), and the offline map cache
  (`tileCache.js`, `httpMirror.js`, `assetCapture.js`).
- `src/renderer/` — both windows, and `mapAgent.js`, the script injected into the
  mapgenie page (marker, follow, zoom, icons-only, hide-found, found-sync, offline).
- `config/` — `dd2.offsets.json` (the memory findings), `calibration.json` (the
  hand-authored world affine), `dungeons.json` + `localAreas.json` + `dd2.localarea.json`
  (the per-dungeon inset transforms and the LocalArea floor lookup, app read-only),
  and `areas.json` (buildings you've named).
- `tools/` — the reverse-engineering scripts the offsets were found with. Not part
  of the app; run them from the repo root (`node tools/testChains.js`). Their dumps
  and logs are gitignored — gigabytes, and all reproducible.
