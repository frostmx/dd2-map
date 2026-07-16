// Runs in the host window's isolated main world. The control window keeps mapgenie's
// full-colour map for browsing; it draws the player marker and hosts the overlay's
// settings (the overlay has no UI of its own). The marker/follow updater and the affine
// helpers live in mapAgent.js / calibration.js, shared with the overlay so the two windows
// can't drift apart.

const webview = document.getElementById('mapView');
const coordsEl = document.getElementById('coords');
const areaEl = document.getElementById('area');
const followChk = document.getElementById('followChk');
let followPlayer = followChk.checked; // reflects the HTML default (checked)
followChk.addEventListener('change', () => { followPlayer = followChk.checked; });

// The world affine: { a, b, c, d, e, f } solving
//   lng = a*gameX + b*gameY + c ,  lat = d*gameX + e*gameY + f
// Loaded from config/calibration.json — the overworld transform (dungeon insets come from
// areas.json). No longer authored here (the game pointer + the shipped affine replaced hand
// calibration), but still applied to place the marker.
let calibration = null;
let lastGamePos = null;
let prevGamePos = null; // previous tick's game position, for follow's "moved" test
let webviewReady = false;

// Guarded executeJavaScript: no-op until the guest page has emitted dom-ready,
// otherwise Electron throws "WebView must be attached to the DOM...".
function runInWebview(code) {
  if (!webviewReady) return Promise.resolve(null);
  return webview.executeJavaScript(code).catch(() => null);
}

// The persistent marker/follow updater is injected into the guest once; each
// poll tick then just calls it with numbers (one tiny IPC instead of re-sending
// and re-parsing a full script every frame). Reset on dom-ready so it re-injects
// after the mapgenie SPA navigates and wipes the guest's JS context.
let markerInstalled = false;
webview.addEventListener('dom-ready', () => {
  webviewReady = true;
  markerInstalled = false;
  installFoundSync();
  extractAreas();
});

// --- Dungeon areas ------------------------------------------------------------
// mapgenie draws each dungeon as an INSET off to the side of the world map, in the
// same lng/lat plane. DD2's caves are seamless world geometry, so the game keeps
// reporting ordinary world coords inside one, and the marker would otherwise stay
// out at the cave mouth while the cave's POIs sit far away in the inset.
//
// This window extracts mapgenie's portal graph and hands it to main, which owns the
// tracking (both windows must agree on where you are, so exactly one of them may
// decide). Everything below then just consumes `areaKey` off the position feed.
let areas = { insetLinear: null, areas: {} };  // the per-dungeon inset transforms
let currentArea = null;   // { key, name, floor } from the feed; null = overworld
let namedOverworld = null; // a town/settlement name the pointer gave with no inset (areaKey null)

function extractAreas(attempt = 0) {
  runInWebview(window.DD2MapAgent.buildExtractAreas()).then((json) => {
    // null until mapgenie's Redux store AND the region sources have streamed in,
    // which is a good while after dom-ready. Retry for ~15s.
    if (!json) {
      if (attempt < 30) setTimeout(() => extractAreas(attempt + 1), 500);
      return;
    }
    let meta;
    try {
      meta = JSON.parse(json);
    } catch {
      return;
    }
    console.log(
      `[areas] ${meta.locationCount} locations, ` +
      `${Object.keys(meta.subregions).length} subregions, ` +
      `${meta.portals.length} portal edges`,
    );
    window.dd2.saveAreaMetadata(meta);
  });
}

window.dd2.loadAreas().then((state) => { if (state) areas = state; });
window.dd2.onAreasState((state) => {
  areas = state;
  updateAreaLabel();
});

// The transform for wherever we are now. null means "this area can't be placed" —
// no inset scale seeded yet, or a floor reached by falling rather than through a
// portal. The caller must NOT fall back to the world affine in that case: that would
// confidently draw the marker out in the overworld while you're underground.
function currentTransform() {
  return window.DD2Calib.forArea(calibration, areas, currentArea && currentArea.key);
}

function areaLabel() {
  if (!currentArea) {
    // A town/settlement the pointer named but that rides the overworld transform (areaKey
    // null): show its name, but it needs no inset — the marker is already right out here.
    return namedOverworld ? `${namedOverworld} (overworld)` : 'Overworld';
  }
  const name = `${currentArea.name} ${currentArea.floor}`.trim();
  const rec = areas.areas[currentArea.key];
  const lin = areas.insetLinear;
  if (!lin) return `${name} — no inset scale`;
  if (!rec) return `${name} — not placed yet (walk in through its entrance)`;
  const how = rec.src === 'game' ? 'from game data' : (rec.auto ? 'auto' : 'by hand');
  return `${name} — ${how}, ${lin.scale ? `${lin.scale.toFixed(2)}x scale` : 'scale set'}`;
}

function updateAreaLabel() {
  areaEl.textContent = areaLabel();
}

// Mirrors found-marks between this window and the overlay: they're two separate
// mapgenie SPA instances and neither sees the other's marks until a reload.
// Deliberately NOT tied to the marker install, which waits on a calibration and a
// running game — the sync must work regardless of either. Retries because the
// Redux store isn't up the instant dom-ready fires.
function installFoundSync(attempt = 0) {
  runInWebview(window.DD2MapAgent.buildFoundSync()).then((ok) => {
    // Returns false until mapgenie's Redux store exists, which is a moment after
    // dom-ready. Retry for ~10s.
    if (!ok && attempt < 20) setTimeout(() => installFoundSync(attempt + 1), 500);
  });
}

// The marker/follow guest script lives in mapAgent.js, shared with the overlay. This
// window passes no zoom target (it owns its zoom via the saved-view glide below) and
// keeps mapgenie's chrome — it's where you browse.
const INSTALL_MARKER = window.DD2MapAgent.buildInstallMarker({ hideChrome: false });

// --- Overlay settings ---------------------------------------------------------
// The overlay has no UI of its own, so the settings worth changing while you look at
// them live here. They only ever touch the MAP — the game itself is never modified.
function wireSlider(key, sliderId, valueId, fallback) {
  const slider = document.getElementById(sliderId);
  const label = document.getElementById(valueId);
  const show = (v) => { label.textContent = Math.round(v * 100) + '%'; };

  window.dd2.loadOverlayConfig().then((ocfg) => {
    const v = (ocfg && typeof ocfg[key] === 'number') ? ocfg[key] : fallback;
    slider.value = String(v);
    show(v);
  });

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    show(v);
    window.dd2.setOverlayNumber(key, v); // main persists (debounced) + pushes live
  });
}

// Opacity and brightness, per mode — the full map and icons-only want different
// amounts of each. Brightness darkens the overlay's own pixels, which is what
// stops a faded near-white map from reading as glare over the game (the window
// composites with straight alpha, so fading white just ADDS white — see the note
// in mapAgent.js).
wireSlider('mapOpacity', 'mapOpacity', 'mapOpacityValue', 1);
wireSlider('mapBrightness', 'mapBrightness', 'mapBrightnessValue', 0.35);
wireSlider('iconOpacity', 'iconOpacity', 'iconOpacityValue', 0.7);
wireSlider('iconBrightness', 'iconBrightness', 'iconBrightnessValue', 0.35);

// Overlay checkboxes.
//   autoZoom  — off by default; on, the overlay pulls back while you run.
//   hideFound — on by default; hides POIs you've already marked, in the OVERLAY only
//               (mapgenie merely fades them to 40%). This window keeps showing them.
//   rotateWithHeading — off by default; turns the OVERLAY's map so the way you're running
//               is up. This window stays north-up.
//   areaHud — on by default; the overlay's area readout (the same lines stay above too).
function wireCheckbox(key, id) {
  const box = document.getElementById(id);
  window.dd2.loadOverlayConfig().then((ocfg) => { box.checked = !!(ocfg && ocfg[key]); });
  box.addEventListener('change', () => window.dd2.setOverlaySetting(key, box.checked));
}

wireCheckbox('autoZoom', 'autoZoom');
wireCheckbox('hideFound', 'hideFound');
wireCheckbox('rotateWithHeading', 'rotateWithHeading');
wireCheckbox('areaHud', 'areaHud');

// Overlay map style: Full color (mapgenie's raster) vs Edge (our art baked from the game's
// textures). Edge is only offered once art has been generated into userData/edge — until
// then the option is disabled and the overlay falls back to the raster anyway.
function wireMapStyle() {
  const colorR = document.getElementById('mapStyleColor');
  const edgeR = document.getElementById('mapStyleEdge');
  const note = document.getElementById('mapStyleNote');
  Promise.all([window.dd2.loadOverlayConfig(), window.dd2.edgeArtAvailable()]).then(([ocfg, available]) => {
    const style = (ocfg && ocfg.mapStyle === 'color') ? 'color' : 'edge';
    edgeR.disabled = !available;
    if (!available) {
      colorR.checked = true;
      note.textContent = 'Edge maps not generated yet.';
    } else {
      colorR.checked = style === 'color';
      edgeR.checked = style === 'edge';
      note.textContent = '';
    }
  });
  colorR.addEventListener('change', () => { if (colorR.checked) window.dd2.setOverlaySetting('mapStyle', 'color'); });
  edgeR.addEventListener('change', () => { if (edgeR.checked) window.dd2.setOverlaySetting('mapStyle', 'edge'); });
}
wireMapStyle();

// --- Live position -> marker --------------------------------------------------
window.dd2.onGamePosition((data) => {
  lastGamePos = data;

  // A named area with no inset key is a town on the overworld; track its name separately so
  // the label can show it while the marker keeps riding the world transform (null areaKey).
  const nextNamed = (!data.areaKey && data.areaName) ? data.areaName : null;
  const areaChanged = (currentArea && currentArea.key) !== data.areaKey
    || namedOverworld !== nextNamed;
  currentArea = data.areaKey
    ? { key: data.areaKey, name: data.areaName, floor: data.areaFloor }
    : null;
  namedOverworld = nextNamed;
  if (areaChanged) updateAreaLabel();

  let lines =
    `local ${data.localX.toFixed(1)}, ${data.localY.toFixed(1)}  h ${data.height.toFixed(1)}\n` +
    `world ${data.x.toFixed(1)}, ${data.y.toFixed(1)}`;
  if (data.near) {
    lines += `\ndoor  ${data.near.name}  ${data.near.dist.toFixed(1)}u`;
  }
  // What the app is unsure about, and the key that settles it — the same text the overlay
  // shows, so the two windows never tell you different stories.
  if (data.placeName) {
    lines += `\nin    ${data.placeName}${data.placeCategory ? ` (${data.placeCategory})` : ''}`;
  }
  if (data.hint) {
    lines += `\n\n${data.hint.title}\n${data.hint.detail}`;
    for (const a of data.hint.actions || []) lines += `\n${a}`;
  }
  coordsEl.textContent = lines;

  if (calibration) {
    // The transform depends on where you ARE: the overworld affine out in the world, that
    // dungeon's inset transform underground. null = we can't place this area, in which case
    // leave the marker where it is rather than drawing it somewhere confidently wrong.
    const transform = currentTransform();
    const lngLat = transform && window.DD2Calib.apply(transform, data.x, data.y);
    const valid = window.DD2Calib.isValidLngLat(lngLat);
    if (valid) {
      // Inject the resident updater once, then drive it with a tiny per-tick call.
      if (!markerInstalled) {
        runInWebview(INSTALL_MARKER);
        markerInstalled = true;
      }
      const follow = followPlayer ? 1 : 0;
      // "Moved" in game units: standing still reads a constant value, so any real movement
      // clears a manual pan and resumes follow. Deadband is per-tick (≈4-5 units/sec).
      const moved = !prevGamePos
        || Math.hypot(data.x - prevGamePos.x, data.y - prevGamePos.y) > 0.15 ? 1 : 0;
      prevGamePos = { x: data.x, y: data.y };
      // Where you're LOOKING, through the same transform as where you ARE. null when the
      // camera chain missed a tick — the guest then falls back to the movement heading.
      const ahead = window.DD2Calib.aheadPoint(transform, data.x, data.y, data.facing);
      const aheadArgs = ahead ? `, ${ahead.lng}, ${ahead.lat}` : '';
      runInWebview(`window.__dd2_apply && window.__dd2_apply(${lngLat.lng}, ${lngLat.lat}, ${follow}, ${moved}${aheadArgs})`);
      maybeGlideToSavedZoom(lngLat);
    }
  }
});

window.dd2.loadCalibration().then((saved) => {
  if (saved) calibration = saved;
});

// Zoom behavior: open at mapgenie's default (far) view, then glide once to the
// saved zoom centered on the player as soon as follow is tracking. While
// following, remember the current zoom as the new saved default; zooming out
// with follow OFF does not overwrite it.
let savedZoom = null;       // persisted follow zoom (null until loaded / first learned)
let lastZoomSeen = null;    // last value persisted, to skip redundant writes
let zoomGlideDone = false;  // one-time open glide-to-saved already done this session?

window.dd2.loadView().then((v) => {
  if (v && typeof v.zoom === 'number') { savedZoom = v.zoom; lastZoomSeen = v.zoom; }
});

// One-time: when we first have a followed player position, smoothly glide from
// the far open view to the saved zoom on the player. No-op on first run (no
// saved zoom yet) — the interval below learns it instead.
function maybeGlideToSavedZoom(lngLat) {
  if (zoomGlideDone || !webviewReady || !followPlayer || savedZoom == null) return;
  zoomGlideDone = true;
  runInWebview(`(function(){
    if (!window.map || typeof window.map.easeTo !== 'function') return false;
    window.__dd2_zoom_gliding__ = true; // pause per-frame center lock during the glide
    window.map.once('moveend', function(){ window.__dd2_zoom_gliding__ = false; });
    window.map.easeTo({ center: { lng: ${lngLat.lng}, lat: ${lngLat.lat} }, zoom: ${savedZoom}, duration: 800 });
    return true;
  })()`);
}

// Remember the current zoom as the default — only while following and not
// mid-glide, so browsing zoomed-out (follow off) never clobbers the saved zoom.
setInterval(async () => {
  if (!webviewReady || !followPlayer) return;
  const raw = await runInWebview(
    '(function(){ return JSON.stringify({ z: (window.map && window.map.getZoom) ? window.map.getZoom() : null, g: !!window.__dd2_zoom_gliding__ }); })()',
  );
  if (!raw) return;
  let info;
  try { info = JSON.parse(raw); } catch { return; }
  if (typeof info.z !== 'number' || info.g) return; // no map yet, or mid-glide
  if (lastZoomSeen == null || Math.abs(info.z - lastZoomSeen) > 0.01) {
    lastZoomSeen = info.z;
    savedZoom = info.z;
    window.dd2.saveView({ zoom: info.z });
  }
}, 1500);
