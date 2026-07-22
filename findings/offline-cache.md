# Offline cache: serving mapgenie from disk

How the app keeps working when mapgenie is unreachable. Tiles + page bundle are mirrored
to `%APPDATA%\dd2-map\mapcache`, and an HTTPS interception layer serves them back.

See also: [mapgenie's map internals](mapgenie-map.md).

## protocol.handle('https') breaks if a webContents that used it is DESTROYED

The single most expensive thing found while building this, because every symptom points
somewhere else.

Symptom: with `session.defaultSession.protocol.handle('https', …)` registered, the FIRST
navigation works perfectly and every subsequent one dies with `ERR_FAILED (-2)` after
~25ms. The handler is still entered (logging proves it) but its returned promise never
reaches the renderer. No exception is thrown anywhere.

Everything the symptom suggests is wrong:

- **It is not the caching logic.** A second navigation to `https://example.com/` — a host
  that isn't in the allowlist and is passed straight through with no recording — fails
  identically.
- **It is not registration order.** Registering before any window exists fails on the
  second load just the same as registering after a load.
- **It is not "the same URL twice".** A different mapgenie path fails as load #2, and the
  map URL fails as load #2 after a different path succeeded as #1.
- **It is not forwarding via the wrong API.** `ses.fetch` and `net.fetch` behave the same.

The actual trigger is **destroying the BrowserWindow** between loads. Measured on a
minimal handler that does nothing but forward:

| sequence | result |
|---|---|
| new window per load, previous **destroyed** | #1 OK, #2 **FAILED** |
| one window, three sequential `loadURL`s | #1 OK, #2 OK, #3 OK |
| two windows, **neither destroyed** | #1 OK, #2 OK, #3 OK |

So a destroyed webContents leaves the registered https handler wedged for everything
that comes after it.

**Consequences, both shipped:**

1. The real app is fine as-is — the control window and the overlay are both long-lived
   and never destroyed, and they reload the mapgenie SPA constantly (26 times in one
   session) without trouble.
2. **Anything that opens a throwaway window for capture or verification must not destroy
   it while the handler is registered.** `assetCapture.js` therefore keeps ONE persistent
   hidden window for the whole session and reuses it, rather than creating and destroying
   one per phase. If you ever add another "just load it in a hidden window" step, reuse
   that window too.

## Forwarding the intercepted request's headers breaks every request

`protocol.handle` hands the handler a `Request`. Passing `headers: request.headers`
straight to `ses.fetch` kills the very first navigation with `net::ERR_FAILED`.

The incoming Request carries browser-managed headers — `Host`, `Origin`, the `Sec-Fetch-*`
set, and an `Accept-Encoding` describing an encoding we are about to strip — and
Chromium's net stack refuses to re-send them on a synthetic request.

Forward only `accept`, `accept-language`, `referer`, `content-type`. Measured: wholesale
headers → dead on request #1; curated four → 80 requests, page loads normally.

**Cookies are deliberately NOT in that list.** `protocol.handle` never shows the handler
the request's `Cookie` header at all. Auth is preserved by passing
`credentials: 'include'` to `ses.fetch`, which attaches cookies from the session's own
jar — which is also why forwarding must use `ses.fetch` and not `net.fetch`.

## mapgenie 403s absent tiles — it never 404s

Their tiles are in an S3 bucket without `ListBucket` permission, so a missing key returns
**403 with an AccessDenied XML body**, not 404. Verified: `z7/63/63` → 403,
`z16/32640/32768` (past the east edge) → 403, and z17 (which doesn't exist at all) → 403.

This matters for the negative cache and for rate-limit detection, which would otherwise
read every empty tile as "we've been blocked" and pause the build permanently. So:

- 403 → treat as **absent**; write the zero-byte negative marker.
- 429/5xx → the real throttle signal, 2% of a 200-response window trips a pause.
- 403 → only a **majority** (>50%) means blocked, which is safe precisely because with
  correct enumeration legitimate 403s are ~0% (a sampled z16 row was 8/8 200s).

## Tile enumeration must be derived by DOUBLING, not by projecting the bbox

Projecting mapgenie's declared source bounds (`lng[-1.4,0]`, `lat[0,1.4]`) at each zoom
is wrong at **both** edges, and the two errors point in opposite directions:

- **Inclusive upper bound overshoots.** east `lng=0` and south `lat=0` project to exactly
  `0.5`, so `floor(0.5 · 2^z)` lands on the first tile of the next column — entirely
  outside the data. That added a guaranteed-403 row *and* column: 1,032 doomed requests,
  511 of them at z16.
- **`floor()` undershoots at the west/north edge.** At z16 it gives `x0 = 32513`, but
  `x = 32512` returns 200. mapgenie generates **all four children of any non-empty
  parent**, so the tileset spills one tile past the declared bounds wherever an edge falls
  mid-tile (z15's `x0=16256` sits at .46 of a tile, so both its children exist).

Correct enumeration is a single tile at z8 `(127,127)`, doubled per level:
`lo = 127 << (z-8)`, `hi = (128 << (z-8)) - 1`. Verified against the live server at every
edge: z16 `x=32512` → 200, `x=32768` → 403; z15 `x=16255` → 403, `x=16256` → 200.

**The sanity check is that every zoom's grid comes out square and a power of two.** If it
doesn't, the enumeration is wrong. Totals: **87,382 tiles ≈ 940 MB**, about 8 minutes at
concurrency 6 (measured: 342 tiles in 1.9 s).

z7 is the one zoom with no tiles at all — its single tile 403s. It's still enumerated,
because the style declares `minzoom: 7` and MapLibre may ask for it.

## Restoring found-marks offline: mapgenie's own mark path does NOT work

The documented way to mark a location from outside is dispatching mapgenie's
`setLocationFound` CustomEvent on `document` — the only route, since the Redux action
type is minified to a single letter and can't be hand-written (see
[mapgenie-map](mapgenie-map.md)).

**Offline it silently does nothing.** Measured: 25/25 events dispatched, 0 marks landed —
the Redux store and the map's feature-state both still empty afterwards. The event drives
their *real* mark path, and that path runs through a thunk that talks to the server; with
no server it gives up before the reducer ever sees anything.

So the visual state is set directly instead, which is what their middleware ends up
calling anyway:

```js
map.setFeatureState({ source: 'locations-data', id }, { found: true })
```

Three things this cost time on:

1. **Set it on BOTH sources.** Hide-found fades two layers — `locations` (icons, reading
   `locations-data`) and `location-titles` (labels, reading `text-locations-data`). Set
   only the first and the icon dims while its label stays bright.
2. **`setFeatureState` does not throw for an id no feature has.** It stores state nobody
   reads, so a naive success count is a lie. Count by reading back with
   `getFeatureState`. Related: `locations-data` carries only **3630 of the 5372** known
   locations — the rest live in the `circle-` / `polygon-` / `line-locations-data` sources
   by POI shape — so ids that don't take are normal, not a bug.
3. **State set before the source's features load is silently dropped.** Wait until
   `querySourceFeatures('locations-data')` is non-empty, the same retry shape
   `installFoundSync` uses.

**The Redux store stays empty offline and that is expected.** mapgenie's own POI sidebar
list won't show the marks; the map rendering will be correct, which is what the overlay
and hide-found actually read.

Restoring also sets `window.__dd2_restoring_found__`, which suppresses the dispatch
bridge: without it, restoring 64 marks emits 64 console lines, replays 64 actions into the
other window (which is restoring the same set itself), and rewrites `found.json`
mislabelled as `offline`.

## Asset capture can fail right after the tile crawl — retry, don't discard

Reported symptom: full tile build (87k) succeeded, then the build "failed on assets:
loading page" and appeared stuck there.

What actually happened, and the three fixes:

1. **`assetCapture.capture` threw and the renderer never showed it.** The hidden capture
   window loaded mapgenie but `window.map` never initialised within the wait, so
   `loadAndSettle` returned null → "style never loaded". `cache:build` returned
   `{ error }`, but the Create-button handler only checked `out.paused`, so the UI froze
   on the last progress line ("assets: loading page"). Fixed: the renderer now shows
   `out.error` (and PARTIAL verify results).

2. **Likeliest cause is a transient rate-limit on the page host after ~87k tile
   requests.** Not reproducible in isolation (capture with two live webviews and no prior
   crawl works fine); it correlates with the crawl that precedes it. Fixes: an 8s cooldown
   between the tile phase and capture, and `loadAndSettle` now retries the whole page load
   3× with a 5s/10s backoff, diagnosing each failure (challenge/consent page vs
   "map didn't initialise") so the error is actionable.

3. **A failed capture never costs the download.** The tiles live in `building/`, which is
   only promoted on full success, so they're intact. Re-clicking **Create** ("Resume
   build") retries. To make that retry near-instant, `tileCache.start` short-circuits when
   the tile set is already complete (cursor null, have+negative ≥ expected) instead of
   re-walking and `stat`-ing all 87k files — measured 4ms vs a full sweep.

If capture keeps failing across retries, it's not transient: wait a minute (let any block
clear) and press Resume, or check the reported reason for a consent/login wall.

### Update: the failure is "map is up but POI layers never streamed in", and retrying dodges it

On a real full build the diagnosis was NOT a challenge page — the page loaded with the
correct title, but MapLibre's symbol (POI) layers never appeared within the wait, so the
style capture (which needs those layers for their font stacks) timed out. Two things came
out of it:

- **The retry avoids the trigger by construction.** All 87k tiles are already in
  `building/` after the download, so pressing Resume skips the tile phase (fast path) and
  runs capture *without* 87k requests immediately before it — the rate-limit/contention
  condition that starved the hidden window is simply gone the second time. So "press
  Resume" is not just damage control; it removes the cause.
- **The wait now nudges and reports precisely.** `WAIT_FOR_STYLE` waits ~35s, and once
  window.map exists but shows 0 symbol layers it clicks the POI category checkboxes on (a
  fresh, cookie-less capture context can open with every category off, so the layers never
  stream in on their own). On a real timeout it now reports the true state — window.map
  present? layer/symbol counts? store present? — instead of a blanket "style never
  loaded", so any residual failure is diagnosable at a glance.

### Root cause + the fix that actually works: an ISOLATED capture session

Two failures stacked here, found in order:

1. A top-level hidden `BrowserWindow` loading mapgenie fails to bootstrap the Redux store
   in the running app: `map is up but POI layers never appeared (2 layers, 0 symbol,
   styleLoaded=true, store=false)`. MapLibre's base map builds, but mapgenie's app —
   which creates `window.store` and streams the POI layers — never completes. A
   `<webview>` inside a host window (the exact shape the real control/overlay windows use)
   initialises the store reliably where a top-level window does not.

2. **Driving the REAL control webview for capture broke the live app** — do NOT do this.
   Capture/verify register the https handler and cycle through offline `replay` on the
   session they use; doing that on the DEFAULT session (which the real webviews share)
   disturbed the running map, and a reload landing mid-replay could 504. Reported as "it
   broke main app".

The fix is isolation on BOTH axes:

- **A dedicated capture session** (`session.fromPartition('dd2-cache-capture')`, non-
  persistent). `httpMirror.setMode` takes `{ session }`; capture/verify pass the capture
  session, the switcher's offline-serving keeps the default session. The handler is never
  registered on the default session during a build, so the real guests are untouched.
  Logged-out is fine — the map/tiles/style/sprites/glyphs/POIs are public; the found-set
  is captured separately.
- **A dedicated hidden host window with a `<webview>`** on that partition, reused across
  capture and verify, destroyed only at shutdown (destroying it mid-session would wedge
  the handler). `about:blank` first, then `loadAndSettle` drives the real load, to avoid a
  `src`-vs-loadURL race (-3 ABORTED).
- Verify `clearCache()`s the capture session first, so Chromium can't serve an asset from
  its own cache and hide a real gap.

Verified end to end: isolated capture gives `store` up, POI layers present, verify
**0 misses**, and a live default-session guest is provably unaffected (still
`store:true, pois:5372`, still reloads) after a full build. The switcher's default-session
offline serving still passes all four online/offline flips.

## Capture must be LOGGED IN, or offline POI-checking says "Login to track found locations"

The isolated capture session has its own cookie jar, so it captured the LOGGED-OUT page.
Served offline, mapgenie's checklist then reads "Login to track found locations" and no POI
can be marked — even though the real webviews are signed in.

Fix: `copyLoginCookies()` copies mapgenie.io cookies (incl. the httpOnly `laravel_session`)
from the default session into the capture session before recording, so the cached page is
the logged-in variant with a working checklist. The capture session stays otherwise
isolated — only the auth cookie rides along. Requires a REBUILD to take effect (an
existing cache is still the logged-out page).

Offline marking then works: the click updates mapgenie's store + map (visible mark), the
`PUT /api/v1/user/locations` write is answered with a synthetic 200 by the mirror (offline
replay) so it doesn't hang on the dead network, and the found-set mirror saves it to
found.json. **Caveat — the "no write-back" design:** a mark made offline never reaches your
mapgenie account, so the server set overwrites it once you're back online. Making offline
marks survive reconnection would need a queue-and-replay, which is not built.

## "Rebuild cache" reuses tiles — it does not re-download

Once a cache exists, the Create button becomes "Rebuild cache" (this is expected, not a
missing option). A rebuild over a COMPLETE cache hardlinks the existing tiles into the new
build and copies the manifest, so tileCache fast-path-skips the download entirely —
`seedBuildFromCurrent()`. Only the page bundle is re-captured. Measured: 86 files
hardlinked in 17ms with the tile phase then taking 0ms; at 87k tiles that's ~15s of
linking vs an 8-minute re-download. Hardlinks share inodes, so the reused tiles cost no
extra disk. This is the path for refreshing the page (logged-in variant, mapgenie JS
updates) cheaply; the old cache still moves to the backup slot.


## store=false, again: the capture window was BACKGROUND-THROTTLED

The `store=false` failure returned in the running app even with the <webview>-in-a-window
shape. Root cause: the capture host window is hidden (`show:false`), so Chromium throttles
its page's timers/rAF to ~1fps, and mapgenie's store bootstrap stalls out. It only passed
in the isolated test because that process had little else competing.

The overlay already solves this with a THREE-part anti-throttle setup; the capture window
was missing two thirds of it:

1. `applyThrottlingSwitches()` global command-line switches — already set at startup.
2. `backgroundThrottling:false` on the host window — was set.
3. **`webpreferences="backgroundThrottling=no"` on the <webview> TAG** — was MISSING. The
   webview is its own webContents; the host window's pref doesn't reach it.

Plus belt-and-braces: the host window is now `showInactive()` at off-screen coords
(x/y -32000, skipTaskbar) rather than `show:false`. A shown page isn't throttled like a
hidden one; off-screen + inactive keeps it invisible and never steals focus from the game.

Note the retry already recovered this in practice (the cache completed on a later attempt),
but the fix makes attempt 1 succeed instead of limping through 2-3.


## DEFINITIVE root cause of store=false: capture must be LOGGED OUT (reverses an earlier note)

An agent traced mapgenie's `map.js` bootstrap directly. `window.map` is created FIRST (base
2-layer style, isStyleLoaded=true), then:

```js
var T = C("/api/v1/maps/"+id+"/data"),                       // public, always 200
    M = window.user ? C("/api/v1/user/map-data/"+id)         // ONLY when logged in
                    : Promise.resolve(null);
Promise.all([T, M]).then(function(e){                        // NO .catch
   ... window.store = ...; window.mapManager = ...; initMap(...); // POI layers, React panels
});
```

`C` is `axios.get`, which REJECTS on non-2xx. In the capture window
`GET /api/v1/user/map-data/{id}` returns **401** (proven), so `Promise.all` rejects, the
`.then` never runs, and `window.store` + the POI symbol layers are never created — exactly
`store=false, 2 layers, styleLoaded=true`.

This means the earlier "Capture must be LOGGED IN" section had it **backwards**: signing the
capture window in (copyLoginCookies) is what INTRODUCED store=false. Logged out,
`window.user` is null, the user-data fetch is skipped, and the store depends only on the
public maps endpoint (always 200) — which is why every isolated (logged-out) test always
passed. Background-throttling was never the cause (heavy CPU + contention did NOT reproduce
it; a logged-out load with 53% main-thread spin still built the store in 1.3s).

Fix: `ensureLoggedOut()` (clears any auth cookie from the capture partition) replaces
`copyLoginCookies()`. The offline map is fully functional logged-out — the found-set is
captured to found.json and re-applied via setFeatureState, independent of the page's
checklist. The only cost is the cosmetic "Login to track found locations" text, and
mapgenie's own mark path can't work offline anyway.

Consequence for the FEATURE: offline you can VIEW found POIs (our restore) but cannot MARK
new ones through mapgenie's UI (needs its server). Real offline marking would require our
own click-to-toggle writing to found.json — a separate feature, not mapgenie's checklist.

## Cancel, hangs, false-complete verify, and "won't start" (one cluster)

Several issues surfaced together after the logged-in-capture era:

- **Cancel did nothing during asset capture.** `cache:cancel` only called `tileCache.cancel()`.
  Added `assetCapture.cancel()`; every wait in the asset phase now goes through a `guarded()`
  race that bails within ~200ms on cancel. Cancelled builds keep `building/` for Resume.

- **Verify (and the whole build) could hang** on the ~35s style wait. Added a 45s inner cap
  on the wait and a 60s cap around verify's whole load, so a build can NEVER wedge.

- **Verify produced FALSE "complete" caches.** It counted misses only. But if the offline
  page's bootstrap dies early (e.g. the logged-in 401, or a missing critical asset), it
  never REQUESTS the later assets, so missLog stays empty → 0 misses → "complete" while the
  cache is actually broken (observed: a `state=complete, verify.misses=0` cache with only 11
  HTTP assets that threw `Cannot read 'layers'` offline). Fix: verify now also requires the
  offline page to actually come up (loadAndSettle returns a style with symbol layers) →
  `verify.loaded`. `computeState` requires `verify.loaded === true` for 'complete', so those
  false-completes correctly read as 'partial' and older manifests (no flag) do too.

- **"App won't start" = a hung build's zombie.** The hidden capture window is a real
  BrowserWindow. A build that HUNG left it mid-load; the app couldn't fully quit, so the
  next launch collided. The timeouts above stop hangs. NOTE: do NOT "fix" this by destroying
  the capture window after each build — that re-triggers the protocol.handle wedge and the
  NEXT build hangs (verified: build 1 OK, build 2 hangs). It's reused across builds and torn
  down at will-quit; `mainWindow.on('closed') → app.quit()` already closes it on exit.

- **Startup safety:** if the saved source is 'offline' but the current cache isn't
  'complete', boot in 'auto' (not persisted) so the map comes up on the network instead of a
  broken offline render. The saved preference returns once a good cache exists.

## Offline POI marking — our own, since mapgenie's checklist can't work offline

mapgenie's checklist needs a login + its server (the logged-in bootstrap 401s in the
capture window, and even its mark button's thunk fails offline), so we mark POIs ourselves,
entirely client-side. `mapAgent.buildOfflineMarker()` (control window only; injected in
renderer.js next to installFoundSync) installs a `map.on('contextmenu')` handler:
RIGHT-click a POI → `queryRenderedFeatures(point,{layers:['locations']})[0].id` is the
locationId → toggle `setFeatureState({source},{found})` on BOTH `locations-data` and
`text-locations-data` (icon + label), exactly as `__dd2_apply_found_set` restores marks, so
it drives the same found-fade paint expression and can't fight hide-found.

Right-click deliberately: mapgenie binds LEFT-click on POIs (its detail popup), so
contextmenu never conflicts and needs no mode toggle. Offline the Redux store is empty
(logged-out page), so `window.__dd2_found_local__` (a Set, seeded by __dd2_apply_found_set
on restore) is the source of truth. Each toggle emits `__DD2_FOUNDSET__<full set>` →
`recordFoundSet` → found.json (persisted, restored on next load), and `__DD2_MARK__{id,found}`
→ `mirrorMarkToOverlay` → the overlay guest's `__dd2_set_found_one` so the overlay updates
immediately instead of waiting for a reload. Guard in `recordFoundSet`: while offline, an
EMPTY emission (buildFoundSync's install-time line, empty on the logged-out page) is ignored
if found.json is non-empty, so it can't wipe real offline marks. Local-only by design — these
never reach the mapgenie account. Validated live: right-click marks icon+label, toggles off,
bridges both lines.
