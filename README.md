# DD2 Map

Personal live map overlay for Dragon's Dogma 2: embeds the mapgenie.io world map
and shows the player's real-time position, read from `DD2.exe`'s memory.
See `%USERPROFILE%\.claude\plans\gentle-inventing-quill.md` for the full plan.

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
| hold `Alt` | Give the overlay the mouse: click POIs, drag the map. Release to hand input back to the game. A blue border shows while it's held. |

The marker is a **dot with an arrow**: the dot is your position, the arrow points
where you're heading. There's no facing angle in memory, so the heading comes from
your movement vector — it holds its last direction while you stand still.

**Auto-zoom is off by default** — the overlay just holds whatever zoom `F10`/`F11`
set. Tick *Auto-zoom* in the control window to turn it on: after you've been
**moving for 3 seconds** the map eases out by `runZoomOut` levels (default 1.4 ≈ a
2.6x wider view), and eases back in once you stop. `F10`/`F11` still move the
*standing* zoom, and running pulls back from wherever you set it — so the two
never fight. Turning it off mid-run glides straight back to your standing zoom.

**Holding Alt briefly focuses the overlay, so DD2 loses focus for as long as you
hold it.** That's not incidental — DD2 pins the cursor to screen centre and only
releases it when it loses focus, so there is no way to click a POI without taking
focus. Let go of Alt and focus goes straight back to the game.

### Opacity and brightness

Sliders in the control window's panel, live while you drag them, persisted to
`config/overlay.json`. They only ever touch the *overlay* — the game itself is
never modified. Each of the two modes gets its own opacity **and** brightness,
because the full map and bare icons want different amounts of both:

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

Scroll-wheel zoom over the overlay does **not** work, by design: the overlay never
takes focus from the game (that's what keeps your input in DD2), and Windows only
routes the wheel to the focused window. Use `F10`/`F11`.

### Tuning

Everything about how the overlay feels is in `config/overlay.json` — edit and
relaunch, no code changes:

| Key | Meaning |
|---|---|
| `hotkeys` | Rebind any of the four keys (any Electron accelerator string) |
| `baseZoom` | The standing zoom. Set by `F10`/`F11` and persisted; `null` = adopt the map's own zoom on first run. Map's range is 7–16. |
| `zoomStep` | How far one `F10`/`F11` press moves the base zoom |
| `autoZoom` | **Default `false`.** The checkbox in the control window. Everything below only applies when it's on. |
| `hideFound` | **Default `true`.** Hides POIs you've marked as found — in the *overlay* only; the control window still shows them so you can mark them. mapgenie merely fades found POIs to 40% opacity, which stops reading as a distinction once the overlay's own opacity and brightness are stacked on top. |
| `runZoomOut` | How many **zoom levels** below the base to pull back while running. Levels, not a percentage — Mapbox zoom is logarithmic, so one level = 2x the view. `1.4` ≈ 2.6x wider. |
| `zoomEase` | Per-frame zoom glide rate; higher = snappier |
| `runSpeed` / `stillSpeed` | Game units/sec thresholds for "running" / "standing still" |
| `runDwellMs` | How long you must be moving before it zooms out (default 5000 = 5s). The timer survives the dead band between the two speeds and only resets when you actually **stop** — real running dips below any fixed threshold constantly, so a timer that reset on every dip would never reach 5s. |
| `stillDwellMs` | How long you must be still before it zooms back in |
| `mapOpacity` / `mapBrightness` | The full-map sliders above |
| `iconOpacity` / `iconBrightness` | The icons-only sliders above |
| `hideWhenGameUnfocused` | Hide the overlay when you alt-tab away from DD2 |
| `hideMainWindowWithOverlay` | Hide the control window while the overlay is up |
| `focusable` | Default `true`: Alt focuses the overlay so the game releases the cursor. Set `false` if you'd rather the game never lose focus — but then the cursor stays pinned at screen centre and POIs can't be clicked. |

The terminal prints a `[overlay] map probe:` line on startup with the map's canvas
alpha, real zoom range and layer count, plus a loud warning for either failure mode
worth knowing about (a hotkey another app already owns, or a canvas that can't do
transparency).

### Known issue: Electron binary doesn't auto-extract on this machine

`npm install`'s Electron postinstall (`@electron/get` + `extract-zip`) downloads
the zip into `%LOCALAPPDATA%\electron\Cache\` successfully but silently fails to
extract it (exits 0, no error, `node_modules/electron/dist/` stays empty). Cause
not yet root-caused. Workaround if `npm start` fails with "Electron failed to
install correctly":

```bash
cd node_modules/electron/dist
unzip -o "$LOCALAPPDATA/electron/Cache/<hash>/electron-v*-win32-x64.zip"
printf 'electron.exe' > ../path.txt
```

(Find `<hash>` via `ls "$LOCALAPPDATA/electron/Cache"`.)
