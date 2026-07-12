// Runs in the host window's isolated main world. Calibration clicks are
// captured by a click listener injected directly into the mapgenie <webview>
// guest's own main-world JS context (see main/index.js's did-attach-webview
// handler) via executeJavaScript — this reliably sees the real Mapbox
// instance, unlike a <webview> preload script, which in this Electron
// version does not actually share window.map with the page even under
// contextIsolation=no (see M3 debugging notes). The guest bridges click
// results back via console.log with a special prefix, parsed in main.

const webview = document.getElementById('mapView');
const panel = document.getElementById('calibrationPanel');
const statusEl = document.getElementById('calibrationStatus');
const nextPointBtn = document.getElementById('nextPointBtn');
const resetBtn = document.getElementById('resetCalibrationBtn');
const toggleBtn = document.getElementById('toggleCalibrationBtn');
const coordsEl = document.getElementById('coords');
const areaEl = document.getElementById('area');
const followChk = document.getElementById('followChk');
let followPlayer = followChk.checked; // reflects the HTML default (checked)
followChk.addEventListener('change', () => { followPlayer = followChk.checked; });

const CALIBRATION_POINT_COUNT = 3;

// Full 2D affine: { a, b, c, d, e, f } solving
//   lng = a*gameX + b*gameY + c
//   lat = d*gameX + e*gameY + f
// (Legacy saved files use the old separable { a, b, c, d } form: lng = a*gameX+b,
//  lat = c*gameY+d. applyCalibration still honors those — detected by absence of e/f.)
let calibration = null;
let calibrationMode = false;
let points = [];
let awaitingClick = false;
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
  if (!currentArea) return 'Overworld';
  const name = `${currentArea.name} ${currentArea.floor}`.trim();
  const rec = areas.areas[currentArea.key];
  const lin = areas.insetLinear;
  if (!lin) return `${name} — no inset scale (is the world map calibrated?)`;
  if (!rec) return `${name} — not placed yet (walk in through its entrance)`;
  const how = rec.auto ? 'auto' : 'by hand';
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

function setStatus(text) {
  statusEl.textContent = text;
}

function armNextClick() {
  awaitingClick = true;
  nextPointBtn.disabled = true;
  setStatus(`Point ${points.length + 1}/${CALIBRATION_POINT_COUNT}: walk to a landmark in-game, then click it on the map.`);
}

function setCalibrationMode(active) {
  calibrationMode = active;
  runInWebview(`window.__dd2_set_calibration_mode__ && window.__dd2_set_calibration_mode__(${active});`);
  toggleBtn.textContent = active ? 'Exit Calibration' : 'Start Calibration';
  panel.classList.toggle('active', active);
  if (active) {
    points = [];
    document.getElementById('refineBtn').disabled = true;
    runInWebview('window.__dd2_clear_calib_pins__ && window.__dd2_clear_calib_pins__();');
    armNextClick();
  } else {
    awaitingClick = false;
    nextPointBtn.disabled = true;
    setStatus('Idle.');
  }
}

// Solve a 3x3 linear system M·x = rhs by Gaussian elimination with partial
// pivoting (copies its inputs; M is 3 rows of 3).
function solve3(M, rhs) {
  const A = M.map((row, i) => [row[0], row[1], row[2], rhs[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    [A[col], A[piv]] = [A[piv], A[col]];
    const div = A[col][col];
    for (let j = col; j < 4; j++) A[col][j] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      for (let j = col; j < 4; j++) A[r][j] -= factor * A[col][j];
    }
  }
  return [A[0][3], A[1][3], A[2][3]];
}

// The game world and mapgenie's map are the same map at different scales, so
// the exact relationship is a 2D affine transform (see header comment on
// `calibration`). Solving lng and lat with the SHARED design matrix [gx, gy, 1]
// via least squares: 3 non-collinear points give an exact fit; extra
// well-spread points average out click imprecision. The b/d cross-terms carry
// the rotation between the game's world axes and the map's north-up axes — the
// piece the old separable fit was missing, which is why it drifted on long runs.
function solveAffine(pts) {
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0;
  let gLng = 0, yLng = 0, sLng = 0;
  let gLat = 0, yLat = 0, sLat = 0;
  const n = pts.length;
  for (const p of pts) {
    const gx = p.gameX, gy = p.gameY;
    Sxx += gx * gx; Sxy += gx * gy; Sx += gx; Syy += gy * gy; Sy += gy;
    gLng += gx * p.lng; yLng += gy * p.lng; sLng += p.lng;
    gLat += gx * p.lat; yLat += gy * p.lat; sLat += p.lat;
  }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const [a, b, c] = solve3(M, [gLng, yLng, sLng]);
  const [d, e, f] = solve3(M, [gLat, yLat, sLat]);
  return { a, b, c, d, e, f };
}

// Scale is estimated from the SPREAD of the calibration points, so clustered or
// thin-triangle points give a poor scale estimate and the marker drifts in
// proportion to how far you travel from the calibration spot. This flags an
// under-constrained calibration before it's trusted. All thresholds are ratios,
// so they hold regardless of the game's coordinate magnitudes.
function calibrationQuality(pts) {
  const xs = pts.map((p) => p.gameX);
  const ys = pts.map((p) => p.gameY);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const warnings = [];

  const big = Math.max(spanX, spanY) || 1;
  if (Math.min(spanX, spanY) / big < 0.3) {
    const thin = spanX < spanY ? 'X (east-west)' : 'Y (north-south)';
    warnings.push(`points barely spread along ${thin} — that axis will drift`);
  }
  // Near-collinear points (thin sliver) under-constrain the fit even if both
  // spans look large. Compare the triangle's area to its bounding box.
  if (pts.length >= 3) {
    const [a, b, c] = pts;
    const area = Math.abs(
      (b.gameX - a.gameX) * (c.gameY - a.gameY) - (c.gameX - a.gameX) * (b.gameY - a.gameY),
    ) / 2;
    if (spanX * spanY > 0 && area / (spanX * spanY) < 0.08) {
      warnings.push('points are nearly in a straight line — pick a fatter triangle');
    }
  }
  return { spanX, spanY, warnings };
}

// Worst-case prediction error over the stored calibration points, expressed in
// GAME units (map error run back through the inverse linear part). ~0 means the
// affine passes through every point; a stubbornly large value across many
// well-spread points would mean the map itself isn't perfectly to-scale.
function fitResidualGameUnits(cal) {
  const pts = cal.points || [];
  const det = cal.a * cal.e - cal.b * cal.d;
  if (!pts.length || !Number.isFinite(det) || det === 0) return null;
  let maxErr = 0;
  for (const p of pts) {
    const plng = cal.a * p.gameX + cal.b * p.gameY + cal.c;
    const plat = cal.d * p.gameX + cal.e * p.gameY + cal.f;
    const dlng = p.lng - plng;
    const dlat = p.lat - plat;
    const egx = (cal.e * dlng - cal.b * dlat) / det;
    const egy = (-cal.d * dlng + cal.a * dlat) / det;
    maxErr = Math.max(maxErr, Math.hypot(egx, egy));
  }
  return maxErr;
}

// The affine apply/forArea helpers and the marker/follow guest script live in
// calibration.js and mapAgent.js, shared with the overlay window so the two can't
// drift apart. This window passes no zoom target (it owns its zoom via the
// saved-view glide below) and keeps mapgenie's chrome — it's where you browse and
// calibrate.
const INSTALL_MARKER = window.DD2MapAgent.buildInstallMarker({ hideChrome: false });

// Overlay knobs. The overlay has no UI of its own, so the settings worth changing
// while you look at them live here. They only ever touch the MAP — the game
// itself is never modified.
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
//   hideFound — on by default; hides POIs you've already marked, in the OVERLAY
//               only. mapgenie merely fades found POIs to 40% opacity, which stops
//               reading as a distinction at all once the overlay's own opacity and
//               brightness are stacked on top. This window keeps showing them, so
//               you can still find and mark them here.
function wireCheckbox(key, id) {
  const box = document.getElementById(id);
  window.dd2.loadOverlayConfig().then((ocfg) => { box.checked = !!(ocfg && ocfg[key]); });
  box.addEventListener('change', () => window.dd2.setOverlaySetting(key, box.checked));
}

wireCheckbox('autoZoom', 'autoZoom');
wireCheckbox('hideFound', 'hideFound');

nextPointBtn.addEventListener('click', () => armNextClick());

resetBtn.addEventListener('click', () => {
  points = [];
  awaitingClick = false;
  nextPointBtn.disabled = true;
  runInWebview('window.__dd2_clear_calib_pins__ && window.__dd2_clear_calib_pins__();');
  setStatus('Calibration points cleared. Click "Start Calibration" to begin.');
});

toggleBtn.addEventListener('click', () => setCalibrationMode(!calibrationMode));

let refining = false;
const refineBtn = document.getElementById('refineBtn');

refineBtn.addEventListener('click', async () => {
  if (!calibration || !lastGamePos) return;

  if (!refining) {
    // Enter refine mode: freeze the marker on screen; map panning underneath
    // no longer moves it.
    refining = true;
    refineBtn.textContent = 'Confirm Refinement';
    await runInWebview('window.__dd2_marker_frozen__ = true;');
    setStatus('Refine mode: pan the map so the marker sits exactly on your real position, then click "Confirm Refinement".');
  } else {
    // Read the marker's current (unmoved) screen position, unproject it to
    // find out where it actually is now, and store the gap between that and
    // what the calibration currently predicts as a constant offset.
    const result = await webview.executeJavaScript(`
      (function() {
        var m = document.getElementById('__dd2_player_marker__');
        if (!m || !window.map) return null;
        var x = parseFloat(m.style.left);
        var y = parseFloat(m.style.top);
        var ll = window.map.unproject([x, y]);
        return JSON.stringify({ lng: ll.lng, lat: ll.lat });
      })();
    `);
    if (result) {
      const { lng, lat } = JSON.parse(result);
      const newPoint = { gameX: lastGamePos.x, gameY: lastGamePos.y, lng, lat };

      if (currentArea) {
        // INSIDE A DUNGEON: shift, don't re-fit.
        //
        // Every inset shares one scale and rotation, so a dungeon's linear part is
        // already known and there is nothing left to fit — only the offset can be
        // wrong. Feeding this correction into a least-squares re-fit would let click
        // error bend a linear part that isn't in question, and would need three
        // points to do it. A straight translation is both what's correct here and
        // what lets you simply drag yourself back into place when a crossing anchor
        // lands slightly off.
        const transform = currentTransform();
        if (!transform) {
          setStatus('This area has no transform yet — calibrate a dungeon first (3 points) to seed the inset scale.');
        } else {
          const predicted = window.DD2Calib.apply(transform, lastGamePos.x, lastGamePos.y);
          window.dd2.shiftArea({
            areaKey: currentArea.key,
            dLng: lng - predicted.lng,
            dLat: lat - predicted.lat,
          });
          setStatus(`Shifted ${currentArea.name} ${currentArea.floor} into place.`.replace(/\s+/g, ' '));
        }
      } else if (Array.isArray(calibration.points) && calibration.points.length >= 3) {
        // Preferred: treat this correction as a NEW far-flung correspondence and
        // re-fit the whole affine over every point collected so far. Teleport
        // destinations are spread across the map, so a few jump+refine cycles
        // pin the scale down and converge to an exact, drift-free calibration —
        // unlike a constant offset, which is only right at one spot.
        const pts = calibration.points.concat([newPoint]);
        // Merge, don't replace: solveAffine returns only {a..f}, and the file also
        // carries the per-dungeon inset transforms. Assigning its result straight
        // to `calibration` would drop those on every Refine.
        calibration = { ...calibration, ...solveAffine(pts), points: pts };
        // Re-fitting over every point (including this correction) makes any legacy
        // constant offset redundant — and applying it on top would now double-count.
        delete calibration.offsetLng;
        delete calibration.offsetLat;
        window.dd2.saveCalibration(calibration);
        const resid = fitResidualGameUnits(calibration);
        const q = calibrationQuality(pts);
        let msg = `Added point (${pts.length} total) and re-fit — max fit error ~${resid == null ? '?' : resid.toFixed(1)} game units`;
        if (q.warnings.length) msg += `; ${q.warnings.join('; ')}`;
        setStatus(msg + '.');
      } else {
        // Legacy calibration without stored points: fall back to a one-off
        // constant offset (only correct near here) and nudge toward a fresh
        // calibration, which unlocks the accumulating jump+refine workflow.
        const k = calibration;
        const affine = typeof k.e === 'number' && typeof k.f === 'number';
        const predicted = affine
          ? { lng: k.a * lastGamePos.x + k.b * lastGamePos.y + k.c, lat: k.d * lastGamePos.x + k.e * lastGamePos.y + k.f }
          : { lng: k.a * lastGamePos.x + k.b, lat: k.c * lastGamePos.y + k.d };
        calibration.offsetLng = lng - predicted.lng;
        calibration.offsetLat = lat - predicted.lat;
        window.dd2.saveCalibration(calibration);
        setStatus('Applied a local offset (fixes here only). Tip: Reset and recalibrate once with this version, then each Refine improves the whole map.');
      }
    } else {
      setStatus('Could not read marker position — refinement not saved.');
    }
    refining = false;
    refineBtn.textContent = 'Refine';
    await runInWebview('window.__dd2_marker_frozen__ = false;');
  }
});

document.getElementById('debugStyleBtn') && document.getElementById('debugStyleBtn').addEventListener('click', async () => {
  const result = await webview.executeJavaScript(`
    (function() {
      if (!window.map || typeof window.map.getStyle !== 'function') return JSON.stringify({ error: 'no map' });
      var style = window.map.getStyle();
      var sources = {};
      for (var key in style.sources) {
        var s = style.sources[key];
        sources[key] = { type: s.type, coordinates: s.coordinates, bounds: s.bounds, tiles: s.tiles };
      }
      return JSON.stringify({ sources: sources, transform: window.map.transform ? {
        lngRange: window.map.transform.lngRange, latRange: window.map.transform.latRange
      } : null }, null, 1);
    })();
  `);
  console.log('[debug style]', result);
  setStatus('Style info logged to console.');
});

document.getElementById('debugMarkerBtn').addEventListener('click', async () => {
  const result = await webview.executeJavaScript(`
    (function() {
      var m = document.getElementById('__dd2_player_marker__');
      var info = {
        markerExists: !!m,
        markerLeft: m ? m.style.left : null,
        markerTop: m ? m.style.top : null,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        mapCenter: window.map ? window.map.getCenter() : null,
        mapZoom: window.map ? window.map.getZoom() : null,
      };
      return JSON.stringify(info);
    })();
  `);
  console.log('[debug marker info]', result);
  setStatus('Marker info: ' + result);
});

window.dd2.onCalibrationClickResult((data) => {
  if (!awaitingClick) return;
  if (data.notReady) {
    setStatus('Map is still loading — wait a moment and click again.');
    return;
  }
  if (!lastGamePos) {
    setStatus('No live game position yet — is DD2.exe running?');
    return;
  }
  const { lng, lat } = data;
  points.push({ gameX: lastGamePos.x, gameY: lastGamePos.y, lng, lat });
  awaitingClick = false;
  setStatus(`Recorded point ${points.length}/${CALIBRATION_POINT_COUNT}.`);

  if (points.length === CALIBRATION_POINT_COUNT) {
    const pts = points.map((p) => ({ gameX: p.gameX, gameY: p.gameY, lng: p.lng, lat: p.lat }));
    const fit = solveAffine(pts);
    const q = calibrationQuality(points);

    if (currentArea) {
      // Calibrating INSIDE A DUNGEON seeds the shared inset scale and rotation.
      // Every inset is drawn alike, so this 2x2 linear part is the ONLY thing all
      // the others were missing — from here on a dungeon needs no clicks at all,
      // because walking through its doorway supplies the one correspondence that
      // pins its offset. You do this once, in one cave.
      window.dd2.calibrateArea({
        areaKey: currentArea.key,
        linear: { a: fit.a, b: fit.b, d: fit.d, e: fit.e },
        area: {
          subregionId: Number(String(currentArea.key).split('|')[0]),
          floor: currentArea.floor,
          name: currentArea.name,
          c: fit.c,
          f: fit.f,
          points: pts,
        },
      }).then((res) => {
        // The experiment: how does a hand-measured inset scale compare with the one
        // derived from mapgenie's portal graph? If they agree, the derivation stands
        // on its own and no dungeon ever needs calibrating.
        if (res && res.measured && res.derived) {
          const off = 100 * Math.abs(res.measured - res.derived) / res.derived;
          setStatus(
            `Measured ${res.measured.toFixed(3)}x the world scale here, vs ` +
            `${res.derived.toFixed(3)}x derived from the portal graph — ${off.toFixed(1)}% apart.` +
            (q.warnings.length ? ` (But ${q.warnings.join('; ')}.)` : ''),
          );
        }
      });
      runInWebview('window.__dd2_clear_calib_pins__ && window.__dd2_clear_calib_pins__();');
      setCalibrationMode(false);
      setStatus(`Measuring the inset scale from ${currentArea.name}…`);
    } else {
      // Merge rather than replace — the world affine is only part of what this
      // window holds. Keep the raw correspondences too, so each future Refine can
      // add a point and re-solve the whole affine (converging toward an exact fit).
      calibration = { ...calibration, ...fit, points: pts };
      // A fresh fit supersedes any legacy constant offset. Merging would otherwise
      // carry a stale one over and apply it on top of the new affine.
      delete calibration.offsetLng;
      delete calibration.offsetLat;
      window.dd2.saveCalibration(calibration);
      runInWebview('window.__dd2_clear_calib_pins__ && window.__dd2_clear_calib_pins__();');
      setCalibrationMode(false);
      refineBtn.disabled = false;
      // Order matters: setCalibrationMode(false) resets status to "Idle.", so set
      // the real message afterward.
      if (q.warnings.length) {
        setStatus(`Calibration saved, but ${q.warnings.join('; ')}. Jump somewhere far and hit Refine to improve it, or Reset for a wider triangle.`);
      } else {
        setStatus('Calibration complete! Marker should now track your position.');
      }
    }
  } else {
    setStatus(`Point ${points.length} recorded. Walk to another distant landmark, then click "Next Point".`);
    nextPointBtn.disabled = false;
  }
});

window.dd2.onGamePosition((data) => {
  lastGamePos = data;

  const areaChanged = (currentArea && currentArea.key) !== data.areaKey;
  currentArea = data.areaKey
    ? { key: data.areaKey, name: data.areaName, floor: data.areaFloor }
    : null;
  if (areaChanged) updateAreaLabel();

  let lines =
    `local ${data.localX.toFixed(1)}, ${data.localY.toFixed(1)}  h ${data.height.toFixed(1)}\n` +
    `world ${data.x.toFixed(1)}, ${data.y.toFixed(1)}`;
  if (data.near) {
    lines += `\ndoor  ${data.near.name}  ${data.near.dist.toFixed(1)}u`;
  }
  coordsEl.textContent = lines;

  if (calibration) {
    // The transform depends on where you ARE: the overworld affine out in the
    // world, that dungeon's inset transform underground. null = we can't place this
    // area, in which case leave the marker where it is rather than drawing it
    // somewhere confidently wrong.
    const transform = currentTransform();
    const lngLat = transform && window.DD2Calib.apply(transform, data.x, data.y);
    const valid = window.DD2Calib.isValidLngLat(lngLat);
    if (valid) {
      // Inject the resident updater once, then drive it with a tiny per-tick
      // call. Follow is suppressed during refine (marker is frozen while the
      // user pans to align).
      if (!markerInstalled) {
        runInWebview(INSTALL_MARKER);
        markerInstalled = true;
      }
      const follow = followPlayer && !refining ? 1 : 0;
      // "Moved" in game units: standing still reads a constant value, so any real
      // movement clears a manual pan and resumes follow. Deadband is per-tick, so
      // it scales with the ~33ms poll (≈4-5 units/sec) and ignores idle jitter.
      const moved = !prevGamePos
        || Math.hypot(data.x - prevGamePos.x, data.y - prevGamePos.y) > 0.15 ? 1 : 0;
      prevGamePos = { x: data.x, y: data.y };
      runInWebview(`window.__dd2_apply && window.__dd2_apply(${lngLat.lng}, ${lngLat.lat}, ${follow}, ${moved})`);
      maybeGlideToSavedZoom(lngLat);
    }
  }
});

window.dd2.loadCalibration().then((saved) => {
  if (saved) {
    calibration = saved;
    refineBtn.disabled = false;
    setStatus('Loaded saved calibration.');
  } else {
    setStatus('No saved calibration yet. Click "Start Calibration" to begin.');
  }
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
