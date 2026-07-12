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

Two windows open: the **control window** (the map plus the calibration panel —
this is where you calibrate and browse) and the **overlay**, which starts hidden.

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
| `F8` | Overlay on / off (also hides the control window while it's up) |
| `F9` | Base map on / off — off leaves just the POI icons floating over the world |
| `F10` / `F11` | Zoom out / in |
| hold `Alt` | Give the overlay the mouse: click POIs, drag the map, scroll to zoom. Release to hand input back to the game. A blue border shows while it's held. |

The marker is a **dot with an arrow**: the dot is your position, the arrow points
where you're heading. There's no facing angle in memory, so the heading comes from
your movement vector — it holds its last direction while you stand still.

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
relaunch, no code changes. (In a packaged build the live copy is in
`%APPDATA%\dd2-map\config\` — see below.)

| Key | Meaning |
|---|---|
| `hotkeys` | Rebind any of the four keys (any Electron accelerator string) |
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

When run from a terminal, startup prints a `[overlay] map probe:` line with the
map's canvas alpha, real zoom range and layer count, plus a loud warning for the
two failure modes worth knowing about: a hotkey another app already owns, or a map
canvas that can't do transparency (which would break icons-only mode).

## Building a portable .exe

```
npm run dist
```

Produces `dist/DD2Map.exe` — a single ~72 MB portable binary. No installer, and no
Node or Electron needed on the target machine. Just run it.

`config/calibration.json` and `config/overlay.json` are bundled, so the .exe ships
already calibrated and with your tuned settings. (`overlay.json` is gitignored, so
on a fresh clone it simply isn't there — the build still works and the app falls
back to the defaults in `src/main/overlayConfig.js`.)

Two things about the packaged build that are easy to get wrong:

- **Settings are written to `%APPDATA%\dd2-map\config\`, not next to the .exe.**
  The bundled `config/` lives inside `app.asar`, which is **read-only** — writing
  there fails silently, so calibration and every slider would appear to save and
  then be gone on restart. `configStore.js` writes to userData instead, seeding
  from the copy shipped inside the asar on first run. (In dev it still uses the
  repo's `config/`, so hand-editing `config/overlay.json` works as you'd expect.)
- **Code signing is off** (`win.signAndEditExecutable: false`). electron-builder
  otherwise downloads its `winCodeSign` package, which contains macOS symlinks that
  Windows refuses to extract without Developer Mode or admin — the build dies
  there. The cost is that the .exe carries the default Electron icon and metadata.
  Turn it back on (and enable Developer Mode) if you want those.

## Repo layout

- `src/main/` — Electron main: the 30 Hz memory poll, hotkeys, the overlay window.
- `src/renderer/` — both windows, and `mapAgent.js`, the script injected into the
  mapgenie page (marker, follow, zoom, icons-only, hide-found, found-sync).
- `config/` — `dd2.offsets.json` (the memory findings) and the calibration.
- `tools/` — the reverse-engineering scripts the offsets were found with. Not part
  of the app; run them from the repo root (`node tools/testChains.js`). Their dumps
  and logs are gitignored — gigabytes, and all reproducible.
