// Overlay renderer. A stripped renderer.js: no calibration flow, no panel, no
// debug — it reads the saved calibration, drives the shared guest script
// (mapAgent.js), and turns the player's speed into a zoom target.
//
// Follow is always on here. The overlay IS the follow view; there's no UI to
// turn it off, and a locked-center map is the whole point.

const webview = document.getElementById('mapView');

let cfg = null;
let calibration = null;

let webviewReady = false;
let markerInstalled = false;
let probeDone = false;
let probeInFlight = false;
let probeAttempts = 0;

let prevGamePos = null;   // previous tick's position, for the "moved" test
let lastSample = null;    // { x, y, t } for the speed estimate

// Zoom state. baseZoom is the STANDING zoom — the hotkeys move it, and running
// eases out to baseZoom - runZoomOut from wherever it currently sits. So manual
// and automatic zoom compose instead of fighting: whatever base you pick, running
// is always the same amount wider.
let baseZoom = null;
let minZoom = -Infinity;
let maxZoom = Infinity;

// Speed hysteresis: latch `running` on above runSpeed and off below stillSpeed,
// each only once its threshold has held for its dwell. Without the dwell, combat
// shuffling and a momentary stutter mid-sprint would strobe the zoom in and out.
let running = false;
let candidateSince = null; // when the opposing condition first became true

function runInWebview(code) {
  if (!webviewReady) return Promise.resolve(null);
  return webview.executeJavaScript(code).catch(() => null);
}

webview.addEventListener('dom-ready', () => {
  webviewReady = true;
  // The mapgenie SPA wipes the guest JS context when it navigates, so the guest
  // script has to be re-injected and re-probed after each dom-ready.
  markerInstalled = false;
  probeDone = false;
  probeInFlight = false;
  probeAttempts = 0;
  lastPushedZoom = null; // the fresh guest has no target; force a re-push
  installFoundSync();
});

// Mirrors found-marks between the overlay and the control window: they're two
// separate mapgenie SPA instances and neither sees the other's marks until a
// reload. Not tied to the marker install (which waits on a calibration and a
// running game) — the sync must work regardless. Retries because the Redux store
// isn't up the instant dom-ready fires.
function installFoundSync(attempt = 0) {
  runInWebview(window.DD2MapAgent.buildFoundSync()).then((ok) => {
    // Returns false until mapgenie's Redux store exists, which is a moment after
    // dom-ready. Retry for ~10s.
    if (!ok && attempt < 20) setTimeout(() => installFoundSync(attempt + 1), 500);
  });
}

// --- Probe -------------------------------------------------------------------
// Ask the live map for the things we refuse to hardcode: canvas alpha (whether
// icons-only can be transparent at all), the real zoom range, and the layer list.
// Runs until the map object exists — on a cold load `window.map` isn't there yet.
const PROBE_MAX_ATTEMPTS = 150; // ~5s at the 30Hz feed

async function probeOnce() {
  // probeDone can only be set AFTER the await, so without an in-flight flag the
  // 30Hz feed fires a dozen overlapping probes before the first one returns.
  if (probeDone || probeInFlight) return;
  probeInFlight = true;
  probeAttempts += 1;
  const raw = await runInWebview('window.__dd2_probe && window.__dd2_probe()');
  probeInFlight = false;
  if (!raw) return; // map/style not up yet; try again next tick

  let info;
  try { info = JSON.parse(raw); } catch { return; }

  // Zoom range and canvas alpha are true from the first loaded style and never
  // change, so adopt them immediately.
  if (typeof info.minZoom === 'number') minZoom = info.minZoom;
  if (typeof info.maxZoom === 'number') maxZoom = info.maxZoom;

  // First run: adopt whatever zoom the map opened at, so there's no guessed
  // constant anywhere. From then on it's persisted.
  if (baseZoom == null && typeof info.zoom === 'number') {
    baseZoom = info.zoom;
    persistBaseZoom();
  }

  // The LAYER list is not stable — mapgenie loads a 2-layer base style, then
  // streams the POI (symbol) layers in after. Keep probing until the symbol
  // layers exist so the reported count isn't a lie, but don't spin forever if a
  // map genuinely has none.
  const layers = info.layers || [];
  const symbolLayers = layers.filter((l) => l.type === 'symbol').length;
  if (symbolLayers === 0 && probeAttempts < PROBE_MAX_ATTEMPTS) return;

  probeDone = true;
  window.dd2overlay.reportProbe({
    alpha: info.alpha,
    zoom: info.zoom,
    minZoom: info.minZoom,
    maxZoom: info.maxZoom,
    layerCount: layers.length,
    symbolLayers,
  });
}

// --- Zoom --------------------------------------------------------------------
function clampZoom(z) {
  return Math.min(maxZoom, Math.max(minZoom, z));
}

let saveTimer = null;
function persistBaseZoom() {
  // Debounced: holding a zoom hotkey shouldn't hammer the disk.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.dd2overlay.saveOverlayConfig({ ...cfg, baseZoom });
  }, 500);
}

let lastPushedZoom = null;

function pushZoomTarget() {
  if (baseZoom == null) return;
  // runZoomOut is in ZOOM LEVELS below the base, not a percentage of it.
  // Percentages don't work here: Mapbox zoom is logarithmic, so 70% of zoom 15.5
  // is 10.85 — nearly 5 levels out, i.e. ~25x wider. That's why it flew so far.
  // One level = 2x the view, so ~1.4 levels is a modest, useful pull-back.
  const pulledBack = cfg.autoZoom && running;
  const target = clampZoom(pulledBack ? baseZoom - cfg.runZoomOut : baseZoom);
  // The target only changes on a hotkey or a run/stand flip — don't re-send it
  // 30x/sec. The guest's follow loop is already easing toward whatever it holds.
  if (target === lastPushedZoom) return;
  lastPushedZoom = target;
  runInWebview(`window.__dd2_set_zoom_target && window.__dd2_set_zoom_target(${target})`);
}

// Speed in game units/sec, from consecutive absolute-world positions.
//
// The arming timer must survive the DEAD BAND (speed between stillSpeed and
// runSpeed), not just the threshold itself. With a 5-second dwell that's the
// whole game: real running dips below any fixed threshold constantly — a turn, a
// bump, a slope — and a timer that reset on every dip would never once reach 5s.
// So the timer only resets when you actually STOP (below stillSpeed); mere
// slowing leaves it running.
function updateRunning(data, now) {
  if (!lastSample) {
    lastSample = { x: data.x, y: data.y, t: now };
    return;
  }
  const dt = (now - lastSample.t) / 1000;
  if (dt <= 0) return;
  const speed = Math.hypot(data.x - lastSample.x, data.y - lastSample.y) / dt;
  lastSample = { x: data.x, y: data.y, t: now };

  if (!running) {
    // Arm on real movement; disarm only on a real stop. Dead band holds.
    if (speed > cfg.runSpeed) {
      if (candidateSince == null) candidateSince = now;
    } else if (speed < cfg.stillSpeed) {
      candidateSince = null;
    }
    if (candidateSince != null && now - candidateSince >= cfg.runDwellMs) {
      running = true;
      candidateSince = null;
      pushZoomTarget();
    }
  } else {
    // Symmetrically: arm the stop on standing still, disarm on running again.
    if (speed < cfg.stillSpeed) {
      if (candidateSince == null) candidateSince = now;
    } else if (speed > cfg.runSpeed) {
      candidateSince = null;
    }
    if (candidateSince != null && now - candidateSince >= cfg.stillDwellMs) {
      running = false;
      candidateSince = null;
      pushZoomTarget();
    }
  }
}

// --- Commands from main (hotkeys) --------------------------------------------
let baseMapVisible = true;

// The two modes want opposite things, so they get their own opacity: the full map
// should read as a map, while icons-only floats over live gameplay and must not
// blot out in-game text.
function applyOpacity() {
  if (!cfg) return;
  webview.style.opacity = String(baseMapVisible ? cfg.mapOpacity : cfg.iconOpacity);
}

// Darkens the overlay's own pixels so a low opacity reads as a shadow over the
// game rather than a white wash (see the note in mapAgent.js). Per-mode: icons
// and the full map want different amounts.
function applyBrightness() {
  if (!cfg) return;
  const v = baseMapVisible ? cfg.mapBrightness : cfg.iconBrightness;
  runInWebview(`window.__dd2_set_map_brightness && window.__dd2_set_map_brightness(${v})`);
}

// Hide POIs already marked as found. mapgenie only fades them to 40%, which stops
// reading as "found" at all once the overlay's opacity and brightness are stacked
// on top — so they just cluttered the map.
function applyHideFound() {
  if (!cfg) return;
  runInWebview(`window.__dd2_set_hide_found && window.__dd2_set_hide_found(${!!cfg.hideFound})`);
}

function applyBaseMap(visible) {
  baseMapVisible = visible;
  if (!cfg) return; // hotkey beat the config load; state is kept, applied on boot
  runInWebview(`window.__dd2_set_basemap_visible && window.__dd2_set_basemap_visible(${visible})`);
  applyOpacity();
  applyBrightness();
}

window.dd2overlay.onCommand('overlay:basemap', (visible) => applyBaseMap(visible));

// Live from the control window's sliders.
window.dd2overlay.onCommand('overlay:number', ({ key, value }) => {
  if (!cfg) return;
  cfg[key] = value;
  if (key === 'mapBrightness' || key === 'iconBrightness') applyBrightness();
  else applyOpacity();
});

// Live from the control window's checkboxes.
window.dd2overlay.onCommand('overlay:setting', ({ key, value }) => {
  if (!cfg) return;
  cfg[key] = value;
  if (key === 'hideFound') applyHideFound();
  if (key === 'autoZoom') {
    // Turning it off mid-run must not strand the map zoomed out — drop the run
    // state and glide straight back to the base zoom.
    running = false;
    candidateSince = null;
    lastSample = null;
    pushZoomTarget();
  }
});

window.dd2overlay.onCommand('overlay:zoom-delta', (delta) => {
  if (baseZoom == null) return; // probe hasn't landed yet
  baseZoom = clampZoom(baseZoom + delta);
  persistBaseZoom();
  pushZoomTarget();
});

window.dd2overlay.onCommand('overlay:interactive', (interactive) => {
  document.body.classList.toggle('interactive', !!interactive);
  // Stop driving the camera while you have the mouse. The follow loop jumpTo's
  // the map to the player every frame, which drags the map back out from under
  // you mid-pan. The lock also stops __dd2_apply from cancelling the suspension
  // the moment you drift a few units. Released: resume, and the map glides back
  // to the player.
  const on = !!interactive;
  runInWebview(`window.__dd2_interactive_lock__ = ${on}; window.__dd2_follow_suspended__ = ${on};`);
});

// --- Position feed -----------------------------------------------------------
window.dd2overlay.onGamePosition((data) => {
  if (!cfg || !calibration) return;

  const lngLat = window.DD2Calib.apply(calibration, data.x, data.y);
  if (!window.DD2Calib.isValidLngLat(lngLat)) return;

  if (!markerInstalled) {
    runInWebview(window.DD2MapAgent.buildInstallMarker({
      zoomEase: cfg.zoomEase,
      hideChrome: true,
    }));
    markerInstalled = true;
    // A mapgenie SPA navigation wipes the guest context, taking icons-only mode
    // and the brightness filter with it. Re-assert both on every re-injection, or
    // the base map would silently come back mid-session (and come back glaring).
    if (!baseMapVisible) applyBaseMap(false);
    else applyBrightness();
    applyHideFound();
  }
  probeOnce();

  const now = performance.now();
  if (cfg.autoZoom) updateRunning(data, now);

  // "Moved" clears a manual pan and resumes follow — same deadband as the main
  // window: per-tick, so it scales with the ~33ms poll and ignores idle jitter.
  const moved = !prevGamePos
    || Math.hypot(data.x - prevGamePos.x, data.y - prevGamePos.y) > 0.15 ? 1 : 0;
  prevGamePos = { x: data.x, y: data.y };

  runInWebview(`window.__dd2_apply && window.__dd2_apply(${lngLat.lng}, ${lngLat.lat}, 1, ${moved})`);
  pushZoomTarget();
});

// --- Boot --------------------------------------------------------------------
Promise.all([
  window.dd2overlay.loadOverlayConfig(),
  window.dd2overlay.loadCalibration(),
]).then(([overlayCfg, cal]) => {
  cfg = overlayCfg;
  calibration = cal;
  baseZoom = typeof cfg.baseZoom === 'number' ? cfg.baseZoom : null;
  applyOpacity();
  applyBrightness();
  if (!baseMapVisible) applyBaseMap(false); // a hotkey that beat the config load
  if (!calibration) {
    console.log('[overlay] no saved calibration — the marker cannot be placed. Calibrate in the main window first.');
  }
});
