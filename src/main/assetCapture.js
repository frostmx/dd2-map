// Captures the mapgenie page bundle into the cache: the HTML, its JS/CSS, the Mapbox
// style, sprites, glyph fonts, and the POI payloads. Tiles are tileCache.js's job.
//
// THREE PHASES, BECAUSE NO ONE OF THEM IS TRUSTWORTHY ALONE.
//
//   A. Record a real load. Turn the mirror to 'record' and load the map in a hidden
//      window; whatever it fetches gets written. This is the only way to learn the
//      bundle URLs, which carry content hashes we cannot guess.
//
//   B. Forced style walk. A single load only fetches what the initial viewport needed —
//      MapLibre pulls glyph ranges lazily, per font-stack per 256-codepoint block, and
//      only for text actually on screen. So we read the live style and fetch the sprite
//      variants and every fontstack x range deterministically. Without this the map
//      renders offline with NO LABELS, which looks like a font bug rather than a cache
//      one.
//
//   C. Verify by replay. Static enumeration can always miss something, so the only
//      honest completeness check is empirical: flip to replay with fail-fast on, reload,
//      and count what 504s. Zero misses is the only thing that earns 'complete'.
//
// Phase C is why the manifest can say "partial" truthfully. A half-cache that silently
// half-works offline is worse than no cache, because it presents as a calibration bug.

const { BrowserWindow, session } = require('electron');
const httpMirror = require('./httpMirror');

const MAP_URL = 'https://mapgenie.io/dragons-dogma-2/maps/world?embed=light';

// 0-255 and 256-511 cover English POI names; the upper two are a few KB each and cover
// accented characters and punctuation edge cases. A 404 on a high range is normal.
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023'];

// A DEDICATED, throwaway session for the capture window — the single most important thing
// in this file. Capture and verify register the https handler and cycle through offline
// replay; doing that on the DEFAULT session disturbed the live map (the real webviews
// share it), which broke the running app during a build. On its own partition, none of
// that touches the real guests: the switcher's offline-serving still owns the default
// session, and building a cache is fully isolated.
//
// Non-persistent (no "persist:" prefix) so its HTTP cache is in-memory and gone next run —
// and we clear it before verify, so verify can't be fooled into "0 misses" by Chromium
// serving an asset from its own cache instead of from our mirror.
//
// Logged-out is fine: the map, tiles, style, sprites, glyphs and POI layers are all
// public. The user's found-set is captured separately (found.json), not from this page.
const CAP_PARTITION = 'dd2-cache-capture';
function captureSession() { return session.fromPartition(CAP_PARTITION); }

// Cancellation. The tile phase has its own cancel (tileCache); this covers the asset
// capture + verify phases, which is where a stuck build otherwise ignores the Cancel
// button (the retry loop and the ~35s style waits would run to completion). cancel() flips
// the flag; loadAndSettle races its waits against it and bails within ~200ms.
let capCancelled = false;
function cancel() { capCancelled = true; }
function beginCancelScope() { capCancelled = false; }
function isCancelled() { return capCancelled; }

// Race `promise` against cancellation AND a hard cap, cleaning up both timers whichever
// way it settles (no leaked intervals). Rejects 'cancelled' if Cancel is pressed, or
// 'timeout' if capMs elapses — so no single await in the asset phase can hang the build.
function guarded(promise, capMs) {
  let iv, to;
  const cancelP = new Promise((_r, rej) => {
    iv = setInterval(() => { if (capCancelled) rej(new Error('cancelled')); }, 200);
  });
  const capP = capMs
    ? new Promise((_r, rej) => { to = setTimeout(() => rej(new Error('timeout')), capMs); })
    : new Promise(() => {});
  return Promise.race([promise, cancelP, capP]).finally(() => { clearInterval(iv); clearTimeout(to); });
}

// A sleep that aborts the moment Cancel is pressed.
function sleep(ms) {
  let t;
  const timer = new Promise((r) => { t = setTimeout(r, ms); });
  return guarded(timer, 0).finally(() => clearTimeout(t));
}

// Capture must be LOGGED OUT. This was the hard-won lesson: copying the login cookies in
// (so the offline POI checklist wouldn't say "Login to track") made mapgenie serve the
// LOGGED-IN bootstrap — and that bootstrap gates window.store on
// GET /api/v1/user/map-data/{id}, which returns 401 in the capture window. The gate is a
// `Promise.all([publicData, userData]).then(...)` with NO .catch, and that .then is where
// window.store, window.mapManager, initMap() and every POI symbol layer are created. So a
// single 401 silently kills the entire bootstrap — exactly the "map is up (2 layers,
// styleLoaded=true) but store=false, 0 symbols" failure.
//
// Logged out, `window.user` is null, the user-data fetch is skipped
// (Promise.resolve(null)), and the store depends only on the PUBLIC /api/v1/maps/{id}/data
// (always 200). The offline map is fully functional either way — the found-set is captured
// separately to found.json and re-applied via setFeatureState, and mapgenie's own mark
// path can't work offline regardless. So this clears any stray auth cookie from the
// (non-persistent) capture partition to guarantee the logged-out bootstrap.
async function ensureLoggedOut() {
  try {
    const ses = captureSession();
    const cookies = await ses.cookies.get({ domain: 'mapgenie.io' });
    for (const c of cookies) {
      const host = c.domain.replace(/^\./, '');
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
      try { await ses.cookies.remove(url, c.name); } catch { /* ignore */ }
    }
  } catch { /* nothing to clear */ }
}

// ONE hidden host window + its <webview>, reused across capture and verify and never
// destroyed mid-session. Two reasons it's a <webview> in a host window rather than a
// top-level BrowserWindow: (1) destroying a webContents that used protocol.handle('https')
// wedges the handler for everything after (see findings/offline-cache.md), so it must
// persist; (2) a top-level hidden window failed to bootstrap mapgenie's Redux store in the
// running app (store=false, POI layers never streamed in) — the <webview>-in-a-window
// shape, which is exactly how the real control/overlay windows run the map, initialises it
// reliably.
let hostWin = null;
let guestWC = null;

function ensureGuest() {
  if (guestWC && !guestWC.isDestroyed()) return Promise.resolve(guestWC);
  return new Promise((resolve, reject) => {
    hostWin = new BrowserWindow({
      show: false,
      x: -32000,           // off-screen: present enough to dodge the hidden-page throttle,
      y: -32000,           // but never seen and (via showInactive) never focus-stealing
      width: 1280,
      height: 900,
      skipTaskbar: true,
      webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    // showInactive, not show: a shown page isn't throttled like a hidden one, but we must
    // NOT take focus — the user may be in-game. Off-screen coords keep it invisible.
    hostWin.showInactive();
    const timer = setTimeout(() => reject(new Error('capture webview never attached')), 20000);
    hostWin.webContents.on('did-attach-webview', (_e, wc) => {
      wc.setMaxListeners(30);
      guestWC = wc;
      // Resolve on the about:blank dom-ready; loadAndSettle then drives the first real
      // MAP_URL load. Starting on about:blank (rather than src=MAP_URL) avoids a race
      // where our explicit loadURL aborts the webview's own in-flight src load (-3).
      wc.once('dom-ready', () => { clearTimeout(timer); resolve(wc); });
    });
    // backgroundThrottling=no ON THE WEBVIEW TAG is essential, not just on the host
    // window. The host is hidden (show:false), so Chromium throttles a background page's
    // timers/rAF to ~1fps — which stalls mapgenie's store bootstrap and gives exactly the
    // "2 layers, 0 symbol, store=false" failure. The webview is its own webContents with
    // its own prefs, so the host's backgroundThrottling:false doesn't reach it; the tag
    // attribute does. Same trio the overlay uses (window pref + this attr + the global
    // switches applyThrottlingSwitches() sets at startup).
    const html = `<!doctype html><meta charset=utf-8>`
      + `<webview id=v partition="${CAP_PARTITION}" src="about:blank"`
      + ` webpreferences="backgroundThrottling=no" allowpopups`
      + ` style="position:fixed;inset:0;width:100%;height:100%"></webview>`;
    hostWin.loadURL('data:text/html,' + encodeURIComponent(html));
  });
}

// Called ONLY at app shutdown. Destroying the host mid-session wedges the https handler
// (see the finding), so capture()/verify() leave it alive and reuse it.
function releaseScratch() {
  if (hostWin && !hostWin.isDestroyed()) hostWin.destroy();
  hostWin = null;
  guestWC = null;
}

// The style only exists once MapLibre has built it, and mapgenie streams the POI layers
// in AFTER reporting isStyleLoaded() === true (see findings/mapgenie-map.md — an early
// probe truthfully reports "2 layers"). So wait for symbol layers to actually exist —
// those carry the font stacks Phase B needs.
//
// Resolves to a JSON string of { ok, style?, diag }. On failure `diag` reports the true
// state (does window.map exist? how many layers/symbols? is the store there?), because
// "the page loaded but no symbols yet" and "no map at all" need completely different
// responses and the old null couldn't tell them apart.
//
// While waiting, it NUDGES the POI categories on: a fresh (logged-out or cookie-less)
// context can open with every category off, so the symbol layers never stream in on
// their own. Clicking the sidebar checkboxes is what forces them — and it's idempotent,
// so doing it each poll is harmless.
const WAIT_FOR_STYLE = `
new Promise((resolve) => {
  var tries = 0;
  var MAX = 175;               // ~35s at 200ms
  var nudged = false;
  function diag() {
    var d = { hasMap: false, layers: 0, symbols: 0, styleLoaded: false, hasStore: false };
    try { d.hasStore = !!(window.store && window.store.getState); } catch (e) {}
    try {
      if (window.map && window.map.getStyle) {
        d.hasMap = true;
        d.styleLoaded = !!window.map.isStyleLoaded && window.map.isStyleLoaded();
        var ls = window.map.getStyle().layers || [];
        d.layers = ls.length;
        d.symbols = ls.filter(function (l) { return l.type === 'symbol'; }).length;
      }
    } catch (e) {}
    return d;
  }
  (function poll() {
    tries++;
    var d = diag();
    if (d.hasMap && d.symbols > 0) {
      return resolve(JSON.stringify({ ok: true, style: window.map.getStyle(), diag: d }));
    }
    // Once the map exists but no POI layers have shown, force the categories on.
    if (d.hasMap && d.symbols === 0 && !nudged && tries > 5) {
      nudged = true;
      try {
        document.querySelectorAll('input[type=checkbox]:not(:checked)').forEach(function (b) { b.click(); });
      } catch (e) {}
    }
    if (tries > MAX) return resolve(JSON.stringify({ ok: false, diag: d }));
    setTimeout(poll, 200);
  })();
})`;

// Is this a challenge/consent wall rather than the real page? Checked only when the map
// never appeared at all.
const IS_CHALLENGE = `(function () {
  try { return /just a moment|attention required|cloudflare|verify you are human|rate limit|are you a robot/i.test((document.body && document.body.innerText || '').slice(0, 600)); }
  catch (e) { return false; }
})()`;

// Turn the wait's diag object into a one-line, actionable reason.
function reasonFrom(diag, challenge) {
  if (!diag || !diag.hasMap) {
    return challenge ? 'blocked by a challenge/consent page' : 'MapLibre never created window.map';
  }
  // Map exists but no POI symbol layers streamed in — the interesting case.
  return `map is up but POI layers never appeared (${diag.layers} layers, 0 symbol, `
    + `styleLoaded=${diag.styleLoaded}, store=${diag.hasStore})`;
}

// Load the map page and wait for MapLibre to have real symbol layers. `wc` is a
// webContents — either one of the app's LIVE mapgenie guests (preferred) or the hidden
// scratch window's. Retries the whole load a few times.
async function loadAndSettle(wc, settleMs, onProgress = () => {}, maxAttempts = 3) {
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (capCancelled) throw new Error('cancelled');
    if (attempt > 1) {
      onProgress({ phase: 'assets', step: `retrying page load (attempt ${attempt}/${maxAttempts}) — ${lastReason}` });
      await new Promise((r) => setTimeout(r, 5000 * attempt));   // let a throttle cool off
      if (capCancelled) throw new Error('cancelled');
    }
    try {
      await wc.loadURL(MAP_URL);
    } catch (e) {
      if (capCancelled) throw new Error('cancelled');
      lastReason = `page load failed (${(e.message || '').split('\n')[0]})`;
      continue;
    }
    let res = {};
    // Guard the in-guest wait: Cancel takes effect mid-wait, and a hard 45s cap means the
    // wait can never wedge the build even if executeJavaScript itself never settles.
    try { res = JSON.parse(await guarded(wc.executeJavaScript(WAIT_FOR_STYLE), 45000)); }
    catch (e) {
      if (capCancelled) throw new Error('cancelled');
      lastReason = e.message === 'timeout' ? 'wait timed out (no style)' : 'page gone';
      continue;   // let the retry loop try again / give up
    }
    if (res.ok) {
      // Let lazily-streamed sources and the icon sprite finish arriving.
      await sleep(settleMs);
      return res.style;
    }
    let challenge = false;
    if (!res.diag || !res.diag.hasMap) {
      try { challenge = await wc.executeJavaScript(IS_CHALLENGE); } catch { /* gone */ }
    }
    lastReason = reasonFrom(res.diag, challenge);
    console.log(`[cache] capture attempt ${attempt} failed: ${lastReason}`);
  }
  const err = new Error(`style never loaded — ${lastReason}`);
  err.reason = lastReason;
  throw err;
}


// Phase A + B. Runs entirely on the isolated capture session — never touches the real
// guests or the default session.
async function capture(dir, onProgress = () => {}) {
  beginCancelScope();
  httpMirror.resetHostStats();
  // Sign the capture session in (copy cookies) BEFORE recording, so the recorded page is
  // the logged-in one with a working POI checklist.
  await ensureLoggedOut();   // logged-in bootstrap 401s on user-data and never builds the store
  // Record on the CAPTURE session, so the default session (real webviews) is untouched.
  httpMirror.setMode('record', { dir, session: captureSession() });

  const wc = await ensureGuest();
  const result = { styleJson: false, sprite: false, spriteRetina: false, glyphStacks: {}, apiPayloads: [] };
  try {
    onProgress({ phase: 'assets', step: 'loading page' });
    const style = await loadAndSettle(wc, 4000, onProgress);   // throws with a reason on failure
    result.styleJson = true;

    if (capCancelled) throw new Error('cancelled');

    // Toggling every POI category on makes mapgenie stream the layers and sprite
    // additions it otherwise holds back (it mutates layers on category toggle).
    onProgress({ phase: 'assets', step: 'expanding POI categories' });
    await wc.executeJavaScript(`
      (function () {
        try {
          document.querySelectorAll('input[type=checkbox]:not(:checked)').forEach(function (b) { b.click(); });
        } catch (e) {}
        return true;
      })()`).catch(() => {});
    await sleep(3000);

    // Phase B — the deterministic walk. These go through ses.fetch INSIDE the guest so
    // they pass through the mirror and get recorded like any other request.
    const urls = [];
    if (style.sprite) {
      for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) urls.push(style.sprite + suffix);
    }
    const stacks = new Set();
    for (const layer of style.layers || []) {
      const font = layer.layout && layer.layout['text-font'];
      if (Array.isArray(font)) stacks.add(font.join(','));
    }
    if (style.glyphs) {
      for (const stack of stacks) {
        result.glyphStacks[stack] = GLYPH_RANGES.slice();
        for (const range of GLYPH_RANGES) {
          urls.push(style.glyphs.replace('{fontstack}', encodeURIComponent(stack)).replace('{range}', range));
        }
      }
    }
    for (const [id, src] of Object.entries(style.sources || {})) {
      if (src.url) urls.push(src.url);
      if (typeof src.data === 'string') { urls.push(src.data); result.apiPayloads.push(id); }
    }

    if (capCancelled) throw new Error('cancelled');
    onProgress({ phase: 'assets', step: `fetching ${urls.length} style assets` });
    await wc.executeJavaScript(`
      Promise.all(${JSON.stringify(urls)}.map(function (u) {
        return fetch(u).then(function (r) { return r.ok; }).catch(function () { return false; });
      })).then(function (rs) { return rs.filter(Boolean).length; })`);

    result.sprite = !!style.sprite;
    result.spriteRetina = !!style.sprite;
    result.hosts = httpMirror.getHostStats();
    return result;
  } finally {
    // Unregister our handler from the CAPTURE session. The default session was never
    // touched, so the real guests keep rendering throughout.
    httpMirror.setMode('passthrough');
  }
}

// Phase C. Loads the map with ONLY the cache available and reports what it couldn't find.
// Same isolated capture session — the real guests are unaffected.
async function verify(dir, onProgress = () => {}) {
  // Clear the capture session's HTTP cache first, or Chromium could serve an asset from
  // its own cache and hide a genuine gap, giving a false "0 misses".
  try { await captureSession().clearCache(); } catch { /* fine */ }

  httpMirror.setMode('replay', { dir, offline: true, session: captureSession() });
  httpMirror.startMissLog();

  const wc = await ensureGuest();
  let loaded = false;
  try {
    // One attempt only: verify measures what the cache is MISSING, and a missing asset
    // won't materialise on a retry. loadAndSettle already has a 45s inner cap; wrap the
    // whole thing in a 60s guard so verify can NEVER hang the build regardless.
    onProgress({ phase: 'verify', step: 'checking the cache loads offline…' });
    const style = await guarded(loadAndSettle(wc, 5000, onProgress, 1), 60000).catch(() => null);
    // CRITICAL: loadAndSettle only returns a style once real POI symbol layers appeared,
    // i.e. the page's store actually bootstrapped offline. Counting misses alone is NOT
    // enough — if the bootstrap dies early it never REQUESTS the later assets, so missLog
    // stays empty and the cache looks "complete" while being broken (exactly how the
    // logged-in captures produced a false 0-miss "complete" cache). So a cache is only
    // self-contained if the offline page actually came up.
    loaded = !!(style && (style.layers || []).some((l) => l.type === 'symbol'));
  } finally {
    const misses = httpMirror.stopMissLog();
    httpMirror.setMode('passthrough', { offline: false });

    const unique = [...new Set(misses)];
    verify.last = { misses: unique.length, missUrls: unique.slice(0, 50), loaded };
    if (!loaded) {
      console.log('[cache] verify: the offline page did NOT initialise — cache is NOT self-contained'
        + (unique.length ? ` (${unique.length} misses)` : ' (no misses recorded — bootstrap died before requesting them)'));
    } else if (unique.length) {
      console.log(`[cache] verify found ${unique.length} missing asset(s); first few:`);
      for (const u of unique.slice(0, 8)) console.log(`  MISS ${u}`);
    } else {
      console.log('[cache] verify: offline page came up, 0 misses — cache is self-contained');
    }
  }
  return verify.last;
}

module.exports = { capture, verify, cancel, isCancelled, releaseScratch, MAP_URL };
