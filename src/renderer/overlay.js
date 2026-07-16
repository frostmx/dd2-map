// Overlay renderer. A stripped renderer.js: no calibration flow, no panel, no
// debug — it reads the saved calibration, drives the shared guest script
// (mapAgent.js), and turns the player's speed into a zoom target.
//
// Follow is always on here. The overlay IS the follow view; there's no UI to
// turn it off, and a locked-center map is the whole point.

const webview = document.getElementById('mapView');
const mgLogo = document.getElementById('mgLogo');

let cfg = null;
let calibration = null;

// The per-dungeon inset transforms. Read-only here — the control window authors
// them and main pushes every change down, so the two windows can never disagree
// about where the player is.
let areas = { insetLinear: null, areas: {} };
window.dd2overlay.onAreasState((state) => { areas = state; });

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
let currentAreaKey = null;   // null = overworld; set from the position feed

// Inside a dungeon the map is drawn at a DIFFERENT scale, so the same zoom level
// shows a different amount of world. The insets are ~2x the world's scale, so
// holding baseZoom underground would show you half as much ground as it does on the
// surface — the map reads as if it zoomed in on you the moment you stepped inside.
//
// Mapbox zoom is logarithmic (one level = 2x the view), so the correction is exactly
// log2(scale): a 2x inset needs one level OUT to cover the same ground. Derived from
// the scale we already have, not a new knob — and it tracks automatically if the
// scale is later measured properly.
function zoomOffset() {
  if (!currentAreaKey) return 0;                    // overworld: baseZoom means what it says
  const scale = areas.insetLinear && areas.insetLinear.scale;
  if (!scale || scale <= 0) return 0;
  return -Math.log2(scale);
}

function pushZoomTarget() {
  if (baseZoom == null) return;
  // runZoomOut is in ZOOM LEVELS below the base, not a percentage of it.
  // Percentages don't work here: Mapbox zoom is logarithmic, so 70% of zoom 15.5
  // is 10.85 — nearly 5 levels out, i.e. ~25x wider. That's why it flew so far.
  // One level = 2x the view, so ~1.4 levels is a modest, useful pull-back.
  const pulledBack = cfg.autoZoom && running;
  const base = baseZoom + zoomOffset();
  const target = clampZoom(pulledBack ? base - cfg.runZoomOut : base);
  // The target only changes on a hotkey, a run/stand flip, or walking into a dungeon
  // — don't re-send it 30x/sec. The guest's follow loop is already easing toward
  // whatever it holds, so a changed target GLIDES rather than snapping.
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
// The F9 mode: 'icons' (POIs only) | 'map' (fullscreen map) | 'window' (map in a movable,
// resizable box). Icons-only until main sends the real mode on F8-on; it has to start here,
// or the overlay would flash the map on the way up. mapShown() = the map layers are drawn.
let overlayMode = 'icons';
const mapShown = () => overlayMode !== 'icons';

// The current dungeon floor's edge art, { localArea, corners } or null. Computed from the
// feed's edgeLocalArea/edgeBox each tick; drives the F9 map when underground.
let edgeArea = null;

// mapgenie subregion of the floor we're in, or null (overworld / unnamed). When set, the
// guest filters the POI layers to it so only THIS floor's icons show. Tracked to fire the
// guest call on change only (30 Hz feed). `undefined` = never applied yet.
let poiSubregion = undefined;

function applyPoiFilter() {
  const arg = (typeof poiSubregion === 'number') ? poiSubregion : 'null';
  runInWebview(`window.__dd2_set_poi_filter && window.__dd2_set_poi_filter(${arg})`);
}

// The baked edge PNGs are served over app-tiles:// (a privileged fetch scheme), but
// Mapbox GL's image-source loader doesn't go through Electron's protocol.handle, so it
// can't load that scheme — it adds the source and never fetches a pixel. `fetch` DOES
// honour the scheme, so we pull the bytes here and hand the guest a self-contained
// data: URL, which Mapbox can always load. Cached per floor: the PNG never changes, and
// a data URL survives the host->webview boundary (a blob: URL would not — it's origin-
// scoped to this renderer). A failed load isn't cached, so a later attempt can retry.
const edgePngCache = new Map();  // localArea -> Promise<dataUrl|null>

function edgePngDataUrl(localArea) {
  if (edgePngCache.has(localArea)) return edgePngCache.get(localArea);
  // -1 is the overworld sentinel: its baked art is world.png, not <id>.png.
  const name = localArea < 0 ? 'world' : String(localArea);
  const p = fetch(`app-tiles://edge/${name}.png`)
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => (blob ? new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    }) : null))
    .catch(() => null);
  edgePngCache.set(localArea, p);
  p.then((v) => { if (!v) edgePngCache.delete(localArea); });
  return p;
}

// Show our dungeon edge art when F9 (full map) is on AND we're in a placeable dungeon.
// Off otherwise — icons-only stays POIs-only. The PNG loads async (data URL); the guest
// call is deferred until it resolves, and re-checked against current state in case the
// player changed floor or toggled F9 while it loaded.
function applyEdge() {
  // Overworld (id -1) is drawn by the crisp near-player TILE grid (applyWorldTiles), NOT the
  // single blurry world.png — stacking both ghosts the base through the transparent tiles
  // ("drawn twice"). So the single-image path here is for dungeons/towns only.
  if (mapShown() && edgeArea && edgeArea.localArea !== -1) {
    const la = edgeArea.localArea;
    const corners = edgeArea.corners;
    edgePngDataUrl(la).then((dataUrl) => {
      if (!dataUrl) return;
      if (!(mapShown() && edgeArea && edgeArea.localArea === la)) return;
      runInWebview(`window.__dd2_set_dungeon_edge && window.__dd2_set_dungeon_edge(${la}, ${JSON.stringify(corners)}, ${JSON.stringify(dataUrl)})`);
    });
  } else {
    runInWebview('window.__dd2_set_dungeon_edge && window.__dd2_set_dungeon_edge(null, null, null)');
  }
}

// --- Overworld edge tiles (native 2px, near-player) --------------------------
// The single world.png (edgeArea id -1, via applyEdge above) is a 1px/unit base that stays
// soft when zoomed in. On top of it we draw a 3x3 block of NATIVE 2px tiles around the player,
// so where you actually are is crisp while the blurry base fills the far periphery. The tile
// set is recomputed only when you cross a tile boundary; the guest (__dd2_set_world_edge) adds
// and removes sources to match.
let worldTiles = null;            // [{key, col, row, box}] from manifest, or null until loaded
let worldTileKey = null;          // player's current "col,row", to fire only on a crossing
const worldTileCache = new Map(); // key -> Promise<dataUrl|null>
const WORLD_TILE_RADIUS = 1;      // 3x3 block (512u tiles => ~1536u of crisp map around you)
const WORLD_TILE_UNITS = 512;

function worldTileDataUrl(key) {
  if (worldTileCache.has(key)) return worldTileCache.get(key);
  const p = fetch(`app-tiles://edge/world/${key}.png`)
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => (blob ? new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    }) : null))
    .catch(() => null);
  worldTileCache.set(key, p);
  p.then((v) => { if (!v) worldTileCache.delete(key); });
  return p;
}

// Load the tile manifest once (list of which tiles exist + their world boxes).
fetch('app-tiles://edge/world/manifest.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((m) => { if (m && Array.isArray(m.tiles)) worldTiles = m.tiles; })
  .catch(() => {});

// Draw/refresh the crisp tiles around the player. Clears them when the map is hidden or we're
// not in the overworld. `transform` is the world affine (forArea returns it for a null areaKey).
function applyWorldTiles(data, transform) {
  const active = worldTiles && mapShown() && edgeArea && edgeArea.localArea === -1;
  if (!active) {
    if (worldTileKey !== null) {
      worldTileKey = null;
      runInWebview('window.__dd2_set_world_edge && window.__dd2_set_world_edge([])');
    }
    return;
  }
  const pc = Math.floor((data.x + 4096) / WORLD_TILE_UNITS);
  const pr = Math.floor((data.y + 4096) / WORLD_TILE_UNITS);
  const key = pc + ',' + pr;
  if (key === worldTileKey) return;   // same tile — the visible set hasn't changed
  worldTileKey = key;
  const wanted = worldTiles.filter((t) =>
    Math.abs(t.col - pc) <= WORLD_TILE_RADIUS && Math.abs(t.row - pr) <= WORLD_TILE_RADIUS);
  const pt = (gx, gz) => { const p = window.DD2Calib.apply(transform, gx, gz); return [p.lng, p.lat]; };
  Promise.all(wanted.map((t) => worldTileDataUrl(t.key).then((url) => (url ? {
    key: t.key,
    corners: { tl: pt(t.box[0], t.box[1]), tr: pt(t.box[2], t.box[1]),
      br: pt(t.box[2], t.box[3]), bl: pt(t.box[0], t.box[3]) },
    imageUrl: url,
  } : null)))).then((built) => {
    if (worldTileKey !== key) return;  // player moved on / left overworld while loading
    const good = built.filter(Boolean);
    runInWebview(`window.__dd2_set_world_edge && window.__dd2_set_world_edge(${JSON.stringify(good)})`);
  });
}

// The two modes want opposite things, so they get their own opacity: the full map
// should read as a map, while icons-only floats over live gameplay and must not
// blot out in-game text.
function applyOpacity() {
  if (!cfg) return;
  webview.style.opacity = String(mapShown() ? cfg.mapOpacity : cfg.iconOpacity);
}

// Darkens the overlay's own pixels so a low opacity reads as a shadow over the
// game rather than a white wash (see the note in mapAgent.js). Per-mode: icons
// and the full map want different amounts.
function applyBrightness() {
  if (!cfg) return;
  const v = mapShown() ? cfg.mapBrightness : cfg.iconBrightness;
  runInWebview(`window.__dd2_set_map_brightness && window.__dd2_set_map_brightness(${v})`);
}

// Hide POIs already marked as found. mapgenie only fades them to 40%, which stops
// reading as "found" at all once the overlay's opacity and brightness are stacked
// on top — so they just cluttered the map.
function applyHideFound() {
  if (!cfg) return;
  runInWebview(`window.__dd2_set_hide_found && window.__dd2_set_hide_found(${!!cfg.hideFound})`);
}

// Heading-up: rotate the map so the way you're running is up, so a POI drawn above
// the marker is genuinely ahead of you. The guest owns the easing; this just says
// which way it should be. Overlay only — the control window is never rotated.
function applyRotate() {
  if (!cfg) return;
  runInWebview(`window.__dd2_set_rotate && window.__dd2_set_rotate(${!!cfg.rotateWithHeading})`);
}

// The windowed box, in screen pixels, from cfg.windowRect (screen fractions), clamped so it
// stays on screen. Min size keeps the handles reachable.
function windowRectPx() {
  const wr = (cfg && cfg.windowRect) || { left: 0.63, top: 0.06, width: 0.34, height: 0.46 };
  const W = window.innerWidth, H = window.innerHeight;
  const width = Math.max(160, Math.round(wr.width * W));
  const height = Math.max(140, Math.round(wr.height * H));
  const left = Math.min(Math.max(0, Math.round(wr.left * W)), W - width);
  const top = Math.min(Math.max(0, Math.round(wr.top * H)), H - height);
  return { left, top, width, height };
}

// Position #mapFrame: a box in window mode, fullscreen otherwise. Mapbox is told to resize
// after the layout settles (a webview element resize also fires the guest's own resize, but
// asserting it is cheap and covers the corners).
let guestResizeTimer = null;
function scheduleGuestResize() {
  if (guestResizeTimer) clearTimeout(guestResizeTimer);
  guestResizeTimer = setTimeout(() => {
    runInWebview('window.__dd2_resize && window.__dd2_resize()');
  }, 60);
}
function layoutFrame() {
  const win = overlayMode === 'window';
  document.body.classList.toggle('windowed', win);
  const f = document.getElementById('mapFrame');
  if (win) {
    const r = windowRectPx();
    f.style.left = r.left + 'px'; f.style.top = r.top + 'px';
    f.style.width = r.width + 'px'; f.style.height = r.height + 'px';
  } else {
    f.style.left = ''; f.style.top = ''; f.style.width = ''; f.style.height = '';
  }
  scheduleGuestResize();
}

// The MapGenie badge (screen top-right) rides with the map: shown in map/window modes, hidden
// in icons-only (no map, nothing to attribute).
function applyLogo() {
  if (mgLogo) mgLogo.hidden = !mapShown();
}

function applyMode(mode) {
  overlayMode = mode;
  if (!cfg) return; // hotkey beat the config load; state is kept, applied on boot
  layoutFrame();
  applyLogo();
  // In a dungeon/town/overworld we draw OUR edge art instead of mapgenie's raster; keep the
  // raster hidden exactly when we'll draw edge art over it. 'window' shows the map too.
  const show = mapShown();
  const useEdge = show && !!edgeArea;
  runInWebview(`window.__dd2_set_basemap_visible && window.__dd2_set_basemap_visible(${show && !useEdge})`);
  applyEdge();
  applyOpacity();
  applyBrightness();
  // A deliberate F9 switch means "give me the live map": clear any leftover manual-pan
  // suspension (from dragging the map, or a stale interactive flag) so the map re-locks on the
  // player and the F10/F11 zoom hotkeys take effect again — but not while actively interacting.
  // Without this, standing still after an Alt session left follow suspended and zoom dead until
  // you toggled Alt off (and a state mismatch could need two presses).
  if (!document.body.classList.contains('interactive')) {
    runInWebview('window.__dd2_follow_suspended__ = false; window.__dd2_interactive_lock__ = false;');
  }
}

window.dd2overlay.onCommand('overlay:mode', (mode) => applyMode(mode));

// Persist the box as screen fractions (so it survives a resolution change) and update cfg.
function persistWindowRect() {
  const f = document.getElementById('mapFrame');
  const W = window.innerWidth, H = window.innerHeight;
  const rect = {
    left: (parseFloat(f.style.left) || 0) / W,
    top: (parseFloat(f.style.top) || 0) / H,
    width: (parseFloat(f.style.width) || f.offsetWidth) / W,
    height: (parseFloat(f.style.height) || f.offsetHeight) / H,
  };
  if (cfg) cfg.windowRect = rect;
  window.dd2overlay.saveWindowRect(rect);
}

// Drag the top bar to move, the edge/corner handles to resize. Pointer capture keeps the
// events coming to the handle even as the cursor passes over the webview (its own surface,
// which would otherwise swallow them). The handles only capture when window-mode + interactive
// (CSS pointer-events), so this is inert the rest of the time.
function setupFrameEditing() {
  const frame = document.getElementById('mapFrame');
  const MIN = 140;
  let drag = null;

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    const W = window.innerWidth, H = window.innerHeight;
    const r = drag.rect;
    let { left, top, width, height } = r;
    const d = drag.dir;
    if (d === 'move') { left = r.left + dx; top = r.top + dy; }
    else {
      if (d.indexOf('e') >= 0) width = r.width + dx;
      if (d.indexOf('s') >= 0) height = r.height + dy;
      if (d.indexOf('w') >= 0) { left = r.left + dx; width = r.width - dx; }
      if (d.indexOf('n') >= 0) { top = r.top + dy; height = r.height - dy; }
    }
    width = Math.max(MIN, width); height = Math.max(MIN, height);
    left = Math.min(Math.max(0, left), W - width);
    top = Math.min(Math.max(0, top), H - height);
    frame.style.left = left + 'px'; frame.style.top = top + 'px';
    frame.style.width = width + 'px'; frame.style.height = height + 'px';
    scheduleGuestResize();
  }
  function onUp(e) {
    if (!drag) return;
    try { drag.el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    drag.el.removeEventListener('pointermove', onMove);
    drag.el.removeEventListener('pointerup', onUp);
    drag = null;
    persistWindowRect();
    scheduleGuestResize();
  }
  function onDown(dir, e) {
    if (overlayMode !== 'window') return;
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const b = frame.getBoundingClientRect();
    drag = { dir, startX: e.clientX, startY: e.clientY,
      rect: { left: b.left, top: b.top, width: b.width, height: b.height }, el };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }

  document.getElementById('mapDrag').addEventListener('pointerdown', (e) => onDown('move', e));
  frame.querySelectorAll('.rz').forEach((h) => {
    h.addEventListener('pointerdown', (e) => onDown(h.dataset.dir, e));
  });
}

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
  if (key === 'rotateWithHeading') applyRotate();
  if (key === 'areaHud' && !value) { hud.hidden = true; hudSig = null; }  // don't wait for a tick
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
  // The follow loop applies zoom only while "driving" (following AND not suspended), so a
  // leftover manual-pan suspension would swallow F10/F11 silently. During normal play (not
  // interactive) a zoom keypress is a clear "follow me at this zoom" — resume so it lands.
  if (!document.body.classList.contains('interactive')) {
    runInWebview('window.__dd2_follow_suspended__ = false;');
  }
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

// --- Area readout ------------------------------------------------------------
// Two things the app cannot know by itself: which BUILDING you just walked into (the
// game's "inside" flag fires for houses and shops too, and mapgenie has an entrance for
// none of them), and which FLOOR you're on (every floor reports the same x/y — only
// your height separates them, and only once you've named a floor at that height).
//
// It used to guess both silently: the nearest entrance won at any distance, so a house
// in Vernworth could calibrate a dungeon 219u away — and get it permanently wrong. Now
// it declines to guess, and says so here, with the key that settles it. Nothing on this
// panel is decorative: every line is either where you are or a question you can answer.
const hud = document.getElementById('areaHud');
const hudWhere = document.getElementById('hudWhere');
const hudNear = document.getElementById('hudNear');
const hudTitle = document.getElementById('hudTitle');
const hudDetail = document.getElementById('hudDetail');
const hudAction = document.getElementById('hudAction');

let hudSig = null;   // last rendered content; the feed is 30Hz and the DOM needn't be

// "Home — remember this as Kough's Inn (Inn)" -> the key in a <b>, the rest as text. One
// line per action; a hint can offer two (it's a building, vs it really is that dungeon).
// Built as nodes, not innerHTML: the strings carry place names straight from mapgenie.
function renderActions(actions) {
  hudAction.textContent = '';
  (actions || []).forEach((text) => {
    const line = document.createElement('div');
    const dash = text.indexOf('—');
    const key = document.createElement('b');
    key.textContent = (dash < 0 ? text : text.slice(0, dash)).trim();
    line.appendChild(key);
    if (dash >= 0) line.appendChild(document.createTextNode(text.slice(dash + 1).trim()));
    hudAction.appendChild(line);
  });
}

function updateHud(data) {
  const hint = data.hint || null;
  const near = data.near || null;
  const nearby = near && near.dist <= cfg.areaHudRadius;

  // Nothing to say: no question pending, not in a dungeon or a named building, and no
  // dungeon near enough to be worth naming. Then the overlay should be a map, and only that.
  const show = cfg.areaHud !== false && (hint || data.areaName || data.placeName || nearby);
  if (!show) {
    if (hudSig !== null) { hud.hidden = true; hudSig = null; }
    return;
  }

  // A building you've named is not an area — the marker doesn't move for it (indoors the
  // game still reports true world coords, so you're already drawn in the right house).
  // It just stops the app guessing, and tells you where you are.
  let where;
  if (data.areaName) {
    // The area the pointer named — a placed dungeon (areaKey set, marker on its inset) OR a
    // town/settlement (areaKey null, marker on the overworld). Either way it has a name, and
    // the name is what goes here; the marker's transform is a separate decision (areaKey).
    where = `${data.areaName}${data.areaFloor ? ` · ${data.areaFloor}` : ''}`;
  } else if (data.placeName) {
    where = `${data.placeName}${data.placeCategory ? ` · ${data.placeCategory}` : ''}`;
  } else {
    where = data.inside ? 'Inside — placed on the overworld' : 'Overworld';
  }
  // Suppressed once the pointer has named where we are — a nearby door offer would just be
  // naming the entrance we came through, at whatever distance we've since walked from it.
  const nearText = (nearby && !data.areaName)
    ? `${near.name}${near.floor ? ` ${near.floor}` : ''} · ${near.dist.toFixed(0)}u`
    : '';

  const actions = (hint && hint.actions) || [];
  const sig = `${where}|${nearText}|${hint ? `${hint.title}|${hint.detail}|${actions.join('|')}` : ''}`;
  if (sig === hudSig) return;
  hudSig = sig;

  hudWhere.textContent = where;
  hudNear.textContent = nearText;
  hudNear.classList.toggle('empty', !nearText);
  hudTitle.textContent = hint ? hint.title : '';
  hudTitle.classList.toggle('empty', !hint);
  hudDetail.textContent = hint ? hint.detail : '';
  hudDetail.classList.toggle('empty', !hint);
  renderActions(actions);
  hudAction.classList.toggle('empty', !actions.length);
  hud.classList.toggle('asking', !!hint);
  hud.hidden = false;
}

// --- Position feed -----------------------------------------------------------
window.dd2overlay.onGamePosition((data) => {
  if (!cfg) return;
  updateHud(data);
  if (!calibration) return;

  // The transform depends on which area main says we're in: the overworld affine
  // out in the world, that dungeon's inset transform underground. null means the
  // area can't be placed (no inset scale seeded yet, or a floor reached by falling
  // rather than through a portal) — in which case hold the marker still rather than
  // fall back to the world affine, which would draw you confidently in the wrong
  // place, out on the surface, while you're in a cave.
  const transform = window.DD2Calib.forArea(calibration, areas, data.areaKey);
  if (!transform) {
    // Unplaceable area (we hold the marker still). Drop any overworld tiles so they don't
    // hang over the frozen map.
    if (worldTileKey !== null) {
      worldTileKey = null;
      runInWebview('window.__dd2_set_world_edge && window.__dd2_set_world_edge([])');
    }
    return;
  }

  // Walking into a dungeon changes the map's scale under us, so the zoom target has
  // to move with it (see zoomOffset). Push on the edge only — pushZoomTarget is a
  // no-op when the target hasn't changed, and the guest eases to it, so the zoom
  // glides as you step through the doorway rather than jumping.
  currentAreaKey = data.areaKey || null;

  // F9 edge art: the current dungeon floor's four inset corners, via the SAME transform
  // as the marker so art and marker share one frame. Mapbox wants [TL, TR, BR, BL]; with
  // the inset's negative lat term, north (max lat) is the minimum z, so TL = (x0, z0).
  const prevEdgeLa = edgeArea && edgeArea.localArea;
  if (data.edgeLocalArea != null && data.edgeBox) {
    const b = data.edgeBox;
    const pt = (gx, gz) => { const p = window.DD2Calib.apply(transform, gx, gz); return [p.lng, p.lat]; };
    edgeArea = { localArea: data.edgeLocalArea,
      corners: { tl: pt(b[0], b[1]), tr: pt(b[2], b[1]), br: pt(b[2], b[3]), bl: pt(b[0], b[3]) } };
  } else {
    edgeArea = null;
  }
  // On a change of floor (or entering/leaving a dungeon), re-evaluate F9: entering swaps
  // mapgenie's raster for our art, leaving swaps it back.
  if ((edgeArea && edgeArea.localArea) !== prevEdgeLa) applyMode(overlayMode);

  const lngLat = window.DD2Calib.apply(transform, data.x, data.y);
  if (!window.DD2Calib.isValidLngLat(lngLat)) return;

  if (!markerInstalled) {
    runInWebview(window.DD2MapAgent.buildInstallMarker({
      zoomEase: cfg.zoomEase,
      rotateEase: cfg.rotateEase,
      headingEase: cfg.headingEase,
      hideChrome: true,
    }));
    markerInstalled = true;
    // A mapgenie SPA navigation wipes the guest context, taking icons-only mode,
    // the brightness filter and heading-up with it. Re-assert them all on every
    // re-injection, or the base map would silently come back mid-session (and come
    // back glaring), and the map would quietly drop back to north-up.
    // Re-assert the full F9 state (basemap/edge/brightness), not just brightness — a
    // re-injection wiped the edge layer too, so it has to be re-added if F9 is on.
    applyMode(overlayMode);
    applyHideFound();
    applyRotate();
    poiSubregion = undefined;   // force a re-apply against the fresh guest below
    worldTileKey = null;        // re-inject wiped the world tiles too; re-add them below
  }

  // Current-floor-only POIs: on a change of floor (or in/out of a dungeon), tell the guest
  // which subregion to keep. Runs after the install block so the guest fn exists; a value
  // change or a fresh re-inject (poiSubregion reset above) both trigger it.
  const sub = (typeof data.subregionId === 'number') ? data.subregionId : null;
  if (sub !== poiSubregion) {
    poiSubregion = sub;
    applyPoiFilter();
  }

  // Crisp native-2px overworld tiles around the player, over the blurry world.png base.
  applyWorldTiles(data, transform);
  probeOnce();

  const now = performance.now();
  if (cfg.autoZoom) updateRunning(data, now);

  // "Moved" clears a manual pan and resumes follow — same deadband as the main
  // window: per-tick, so it scales with the ~33ms poll and ignores idle jitter.
  const moved = !prevGamePos
    || Math.hypot(data.x - prevGamePos.x, data.y - prevGamePos.y) > 0.15 ? 1 : 0;
  prevGamePos = { x: data.x, y: data.y };

  // Where you're LOOKING, through the same transform as where you ARE. null when the
  // camera chain missed a tick — the guest then falls back to the movement heading.
  const ahead = window.DD2Calib.aheadPoint(transform, data.x, data.y, data.facing);
  const aheadArgs = ahead ? `, ${ahead.lng}, ${ahead.lat}` : '';
  runInWebview(`window.__dd2_apply && window.__dd2_apply(${lngLat.lng}, ${lngLat.lat}, 1, ${moved}${aheadArgs})`);
  pushZoomTarget();
});

// --- Boot --------------------------------------------------------------------
Promise.all([
  window.dd2overlay.loadOverlayConfig(),
  window.dd2overlay.loadCalibration(),
  window.dd2overlay.loadAreas(),
]).then(([overlayCfg, cal, areaState]) => {
  cfg = overlayCfg;
  calibration = cal;
  if (areaState) areas = areaState;
  baseZoom = typeof cfg.baseZoom === 'number' ? cfg.baseZoom : null;
  applyOpacity();
  applyBrightness();
  applyMode(overlayMode);       // assert the current mode now that cfg (windowRect) is loaded
  setupFrameEditing();          // wire the windowed-box move/resize handles
  if (!calibration) {
    console.log('[overlay] no saved calibration — the marker cannot be placed. Calibrate in the main window first.');
  }
});
