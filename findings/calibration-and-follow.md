# World calibration & follow rendering

The world affine, the locked-centre follow loop, and heading-up map rotation.

See also: [mapgenie map internals](mapgenie-map.md), [dungeons & area tracking](dungeons-areas.md).

- App reads the player's **absolute world position** directly, via a stable
  pointer chain to the global coordinate (survives reload + full restart). No
  dead reckoning, no drift, fast-travel/teleport just works.
- **The world affine is hand-authored now — there is no in-app calibration or
  Refine.** `config/calibration.json` is a **pure similarity** transform
  (`a = |e|`, `b = d = 0`: uniform scale, no rotation, no shear) with **no `points`
  array**. It was re-solved 2026-07-20 by dragging the whole baked overworld map
  onto mapgenie's tiles (`.map/worldMapAligner.html`); landing on exact conformality
  by hand is the evidence it's right. `apply`/`invert` in `calibration.js` still
  read the general `a,b,c,d,e,f` form (and still honour legacy separable files by the
  absence of `e`/`f`), but nothing writes it from the app. See `CLAUDE.md`
  ("Coordinates"). *Retired below: the old 3-point click fit and the accumulating
  Refine loop.*
- **RETIRED — the 3-point click calibration + accumulating Refine.** The app used to
  let you click 3+ in-game landmarks on the map for a least-squares full-2D-affine
  fit, then nudge it with a **Refine** that appended each correction to
  `calibration.points` and re-solved (reporting `max fit error` / `calibrationQuality`).
  None of that exists any more: no `solveAffine`, no `.points`, no Refine, no
  calibration UI in `index.html`. It was replaced because a hand-authored similarity
  is exactly conformal, which the click-fit never was (it came out slightly rotated
  and anisotropic — fit error). The historical reason the fit used a full affine with
  `b`/`d` cross-terms was that a separable `lng=a*gx+b, lat=c*gy+d` fit omitted the
  world→map rotation and drifted linearly with distance; the re-solve removed the
  rotation entirely instead of fitting it.
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
  player** checkbox, and the overlay's settings (opacity/brightness sliders,
  auto-zoom, hide-found). (There used to be a **Refine** readout here reporting the
  correction in game X/Y units — gone with the calibration flow above.)

