const { app, BrowserWindow, ipcMain, globalShortcut, protocol } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle } = require('./memoryReader');
const overlayWindow = require('./overlayWindow');
const overlayConfig = require('./overlayConfig');
const configStore = require('./configStore');
const win32Input = require('./win32Input');
const areaStore = require('./areaStore');
const { createTracker, floorOf } = require('./areaTracker');
const { createLocalAreaReader } = require('./localAreaReader');
const timeReader = require('./timeReader');
const cameraFrameReader = require('./cameraFrameReader');
const generateManagerReader = require('./generateManagerReader');

// Must run before app.whenReady(): the overlay is never the focused window, and
// without these Chromium throttles its timers/rAF to ~1fps and the marker
// freezes. See overlayWindow.js.
overlayWindow.applyThrottlingSwitches();

// Our own basemap tiles/art (baked from the game's textures into userData) are served to
// the mapgenie Mapbox instance over this scheme. It must be registered as privileged
// BEFORE app ready, and needs fetch support so Mapbox's image/raster loader can read it.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app-tiles',
  privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true },
}]);

// Dev-only hot reload: reloads the window when a renderer file changes and
// relaunches the app when a main-process file changes. Never active in a
// packaged build; wrapped so a missing dependency can't break startup.
//
// IT WATCHES THE WHOLE REPO, so anything that WRITES into the repo while the app runs
// makes it reload — and a reload wipes the injected marker and re-fetches the mapgenie
// page, which you see as the map blanking and redrawing mid-game.
//
// That is not hypothetical. Two separate cases have caused it:
//   - config/ — the runtime state we write ourselves (calibration, zoom, areas). Saving
//     the zoom would reload the app on every zoom change.
//   - zone_log.txt — tools/zoneLog.js appends a line on every room change, so simply
//     WALKING THROUGH A DUNGEON with the logger running reloaded the app over and over
//     (measured: 21 reloads in one session; the more you explored, the worse it got).
//
// So the rule is: the watcher may only ever see SOURCE. Anything written at runtime —
// by the app or by the RE tooling — has to be ignored, or it will do this again with
// whatever the next tool happens to write.
if (!app.isPackaged) {
  try {
    require('electron-reloader')(module, {
      ignore: [
        /[\/\\]config[\/\\]/,          // runtime state: calibration, view, areas, the graph cache
        /[\/\\]tools[\/\\]/,           // the RE tooling isn't part of the running app
        /\.(txt|csv|bin|log)$/i,       // what that tooling writes — zone_log.txt et al
      ],
    });
  } catch { /* electron-reloader not installed — run without hot reload */ }
}


// ABSOLUTE world position. DD2 uses a floating origin, so the player's raw
// ("local") coordinates re-center at streaming-cell boundaries. But the game
// also keeps the true absolute position live in memory (global = local + k*128).
// These pointer chains reach that global Vec3 (X @ +0, Y @ +8); the middle
// field @ +4 is not on the 128-grid and is ignored. Found via a Node/CE pointer
// scan and validated across TELEPORT + reload + a full game restart (ASLR), so
// they are module-relative and permanently stable. See config/dd2.offsets.json
// and tools/global.chains2.json. Reading global directly means NO dead reckoning, no
// drift, and fast-travel/teleport just works.
//
// NOTE: an earlier chain (0BB0E1D0) survived reload/restart but read garbage
// after a teleport until the in-game map repopulated it — it threaded a
// map-owned copy. These chains reach the gameplay-live copy, which stays valid.
const GLOBAL_STATIC_OFFSET = 0x0fd26358n;
const GLOBAL_OFFSETS = [0x1a8, 0x410];
// Fallback chain on a DIFFERENT static base/structure (also teleport+restart
// stable) — used if the primary ever fails or reads an inconsistent value.
const GLOBAL_FALLBACK_STATIC_OFFSET = 0x0f8e1130n;
const GLOBAL_FALLBACK_OFFSETS = [0x210, 0x50];
const GLOBAL_X_OFFSET = 0x0n;
const GLOBAL_Y_OFFSET = 0x8n;

// Module-static mirror of the LOCAL (cell-relative) position: X @ +0, height @
// +4, Y @ +8. No pointer chain needed. Used for the on-screen height readout and
// as a sanity reference (global - local must be an exact multiple of 128).
const LOCAL_MIRROR_OFFSET = 0x0fa65f70n;
const CELL = 128;

// The CAMERA's position, in the SAME absolute frame as the global chain above
// (X @ +0, height @ +4, Y @ +8). Found 2026-07-13 by tools/cameraHunt.js and
// narrowed across teleport + reload + full restart; see config/dd2.offsets.json.
//
// This is where FACING comes from. The camera looks AT the player, so the horizontal
// vector camera->player IS the view direction — a real facing angle, unlike the
// movement-derived heading, which has nothing to report the moment you stand still.
const CAMERA_STATIC_OFFSET = 0x0f8e7ed0n;
const CAMERA_OFFSETS = [0x198, 0x18, 0x18, 0x5f8, 0x800];
// Same object reached by a different path — used if the primary misses a tick.
const CAMERA_FALLBACK_STATIC_OFFSET = 0x0f8d3158n;
const CAMERA_FALLBACK_OFFSETS = [0x18, 0x788, 0x18, 0x18, 0x5f8, 0x800];

// Below this the camera->player vector is too short to carry a direction (the camera
// has passed through the player: a cutscene, or a wall shoving it in tight). Observed
// orbit is ~5u in normal play and ~1.4u at a hard upward pitch, so 0.35 only rejects
// the degenerate case. On reject we send no facing and the map holds its last heading,
// which beats snapping the arrow to a direction invented from noise.
const CAMERA_MIN_DIST = 0.35;

// Dungeon zone state, straight from the game — no pointer chain, same kind of read as
// the local mirror above. Found by CE value-scanning (2026-07-13; see
// config/dd2.offsets.json). Three fields we care about, so one read covers them all:
//
//   -24  roomHash    -1 outside; inside, an id for the streaming cell you're in. NOT a
//                     floor and NOT usable as one — the same hash turns up at h=-13.7
//                     and h=-5.2 in one dungeon. Read only so zoneLog can record it.
//     0  insideFlag   0 = overworld; 1 and 2 both = inside (2 is some other kind of
//                     interior — seen in Stormwind Cave; both mean inside, so it
//                     doesn't matter which)
//    +4  zoneIndex    the game's own dungeon id. NOT mapgenie's numbering (game: 18,
//                     69, 2010; mapgenie subregions: 2441-2514), so it can't name a
//                     dungeon yet — see tools/zoneLog.js.
//
// insideFlag replaces guessing entry/exit from proximity to a doorway position derived
// from the world affine. The FLOOR comes from height (see areaTracker), which is the only
// signal that can carry it: the game reports the same (x, y) on every floor of a dungeon.
const ZONE_WINDOW_OFFSET = 0x0fa62c94n;  // roomHash; insideFlag at +24, zoneIndex at +28
const ZONE_WINDOW_SIZE = 32;

const CALIB_PREFIX = '__DD2_CALIB__';
const FOUND_PREFIX = '__DD2_FOUND__';

// The two mapgenie webviews are separate SPA instances: each reads the found-set
// from the server only on load, so a mark in one was invisible to the other until
// a reload. These hold the two guest webContents so a mark can be mirrored across
// live (see mapAgent.js's found-sync).
let mainGuest = null;
let overlayGuest = null;

// A mark happened in one window — replay the (plain, non-networking) Redux action
// in the other, so its store and its map both catch up.
function mirrorFoundAction(fromGuest, json) {
  const target = fromGuest === mainGuest ? overlayGuest : mainGuest;
  if (!target || target.isDestroyed()) return;
  target.executeJavaScript(
    `window.__dd2_apply_found_action && window.__dd2_apply_found_action(${json})`
  ).catch(() => { /* guest reloading; it'll read the fresh set from the server anyway */ });
}

let mainWindow;
let readerHandle = null;
let moduleBase = null;
let pollTimer = null;
let camTimer = null;       // the fast camera-frame loop (see startMemoryPolling)
let collectedTimer = null; // the slow "which tokens are already picked up" loop
let frameOffsets = null;   // latest local->global offsets, written by the position poll
let lastCollectedGuids = null; // last broadcast Set, so we only send on real change

let cfg = null;              // config/overlay.json, with defaults filled in
let gamePid = null;          // DD2.exe's pid, for the overlay's focus-follow
let inputTimer = null;
let altDown = false;         // last observed Alt state, for edge detection
let altChorded = false;      // some other key went down during this Alt hold — it's a chord (Alt+Tab etc.), not a tap
let interactiveOn = false;   // Alt is now a TOGGLE (switch), not hold — this is its state
// The overlay's F9 mode: 'icons' | 'map' | 'window'. F9 cycles; F8 preserves it. Initial
// value set from cfg.openIconsOnly once cfg is loaded.
let overlayMode = 'icons';
let priorForeground = null;  // whose focus we stole, if focusable:true is in use

// A resolved global read is trustworthy only if it sits on the 128-grid relative
// to the local mirror (rejects a transiently-bad pointer resolution).
function consistentWithLocal(global, local) {
  const k = (global - local) / CELL;
  return Number.isFinite(global) && Math.abs(k - Math.round(k)) < 0.05;
}

// All persistence goes through configStore, which knows that in a PACKAGED build
// the bundled config/ is inside app.asar and read-only — writes there fail
// silently, so calibration and settings would seem to save and then vanish on
// restart. It writes to userData instead, seeding from the shipped copy.
const loadCalibration = () => configStore.load('calibration');
const saveCalibration = (data) => configStore.save('calibration', data);

// Persisted view preferences (currently just the default zoom level).
const loadView = () => configStore.load('view');
const saveView = (data) => configStore.save('view', data);

// --- Dungeon areas -----------------------------------------------------------
// mapgenie puts each dungeon on an INSET off to the side of the world map. DD2's
// caves are seamless world geometry, so the game reports ordinary world coords
// inside one and the marker would otherwise stay out at the cave mouth while the
// cave's POIs sit far away in the inset. The tracker says which area you're in; the
// renderers use it to pick the matching transform.
const tracker = createTracker();
let areas = areaStore.empty();       // insetLinear + the per-dungeon translations
let areaMeta = null;                 // mapgenie's region/portal graph
let lastAreaKey = null;              // for edge detection on the broadcast

// PRIMARY area source: read the game's own current-area record (LocalArea id) from a
// static pointer chain, instead of guessing from position. `localAreas` is the shipped
// table (LocalArea -> subregion, floor, name, inset transform); `localAreaReader` resolves
// the chain each tick. Both null if config is missing -> we fall back to `tracker` alone.
// See localAreaReader.js and .map/README.md.
let localAreas = null;
let localAreaReader = null;
const AREA_TRUST = 0.30;             // min match score to trust a solved inset transform
// Whether the baked overworld edge map (userData/edge/world.png) exists. Set at boot. When
// true, the overlay's F9 draws OUR world edge art (id -1) over the whole world box instead
// of mapgenie's raster; when false, the pointer reads -1 but we leave mapgenie's raster up
// (hiding it with nothing baked would blank the map).
let hasWorldEdge = false;
// LocalArea ids that have a baked <id>.png in userData/edge/. Filled at boot by scanning the
// dir. Used to decide whether a TOWN (overworld:true) can show its own detailed edge map
// (bakeTownEdges.py, placed at the solved texBox) vs falling back to the world edge.
const bakedEdgeIds = new Set();

// Fold the shipped LocalArea transforms into the `areas` state the renderers consume, so
// forArea(cal, areas, String(localArea)) resolves them. Only trustworthy placements get a
// transform; a low-score dungeon still gets its NAME (from the pointer) but no transform,
// so forArea returns null and the marker is held rather than drawn confidently wrong.
function mergeLocalAreas() {
  if (!localAreas) return;
  if (!areas.insetLinear && localAreas.insetLinear) areas.insetLinear = localAreas.insetLinear;
  for (const [la, v] of Object.entries(localAreas.byLocalArea || {})) {
    if (v.score >= AREA_TRUST && typeof v.c === 'number' && typeof v.f === 'number') {
      areas.areas[la] = { c: v.c, f: v.f, name: v.title, floor: v.floorLabel || '', src: 'game' };
    }
  }
}

function pushAreas() {
  tracker.setHeights(areas.floorHeights);   // where each floor sits, in game units
  tracker.setPlaces(areas.places);          // the buildings you've named with Home
  broadcast('areas:state', areas);
}

// Home: "this interior is that building." The game's inside-flag fires for every house
// and inn, none of which mapgenie draws an inset for — so there's nothing to calibrate
// and nothing to move. Only the NAME is missing, and one key press supplies it, for good.
function rememberPlace() {
  const r = tracker.rememberPlace();
  if (!r) return;
  if (r.code === 'none') {
    console.log('[areas] nothing to remember — no place POIs loaded yet (the map graph '
      + "hasn't arrived).");
    return;
  }
  if (r.code === 'too-far') {
    console.log(
      `[areas] nearest place is "${r.title}" (${r.category}), ${r.dist.toFixed(0)}u away — `
      + `too far to be the room you're in (limit ${r.radius}u), so nothing was remembered.`,
    );
    return;
  }
  const rec = tracker.takePlace();
  if (!rec) return;
  areas.places[rec.poiId] = rec;
  areaStore.save(areas);
  pushAreas();
  console.log(
    `[areas] remembered this doorway as "${rec.title}" (${rec.category}, `
    + `${rec.dist.toFixed(0)}u from its map icon). No dungeon will be guessed here again.`,
  );
}

// The tracker says WHAT it's unsure about; this says it in English, with the key that
// settles it. It lives here rather than in the tracker because the hotkeys are config,
// and it's used twice — the console line and the overlay's readout — which have to agree.
let lastHintId = null;
let timeLogged = false;   // one boot-time "[time] resolved" line, not one per tick
let camLogged = false;    // same, for the camera-frame feed
let genLogged = false;    // same, for the first successful collected-token read
function describeHint(h) {
  if (!h) return null;
  const keys = cfg.hotkeys;
  const floor = h.floor ? ` ${h.floor}` : '';

  // "It's a building, and it's called X" — offered whenever we have a named place near
  // enough to be the room you're standing in. This is the answer far more often than
  // "it's a dungeon" is: the game has a hundred houses and inns for every cave.
  const remember = (keys.rememberPlace && h.place && h.place.reachable)
    ? `${keys.rememberPlace} — remember this as ${h.place.title} (${h.place.category})`
    : null;
  const nearestPlace = h.place
    ? `nearest place: ${h.place.title} (${h.place.category}) · ${h.place.dist.toFixed(0)}u`
    : null;

  switch (h.code) {
    case 'enter':
      return {
        code: h.code,
        title: 'Inside something — but what?',
        detail: `nearest entrance: ${h.name}${floor} · ${h.dist.toFixed(0)}u away `
          + `(too far to be the door you just used — limit ${h.radius}u), so you're `
          + `still being drawn on the overworld${nearestPlace ? `\n${nearestPlace}` : ''}`,
        actions: [
          remember,
          `${keys.areaToggle} — it really is ${h.name}, go in`,
        ].filter(Boolean),
      };
    case 'no-doors':
      return {
        code: h.code,
        title: 'Inside something — no entrances known',
        detail: nearestPlace || "mapgenie's portal graph hasn't loaded yet",
        actions: [remember].filter(Boolean),
      };
    case 'floor-unknown':
      return {
        code: h.code,
        title: `${h.name}${floor} — this floor has never been placed`,
        detail: `you're at height ${h.height.toFixed(1)}`,
        actions: [`${keys.floorUp} / ${keys.floorDown} — name the floor you're on`],
      };
    case 'floor-off':
      return {
        code: h.code,
        title: `${h.name} — the floor may be wrong`,
        detail: `showing ${h.floor || 'the only floor'} (sits at ${h.sits.toFixed(1)}); `
          + `you're at ${h.height.toFixed(1)}, ${h.off.toFixed(1)}u off — no floor we know `
          + 'fits that',
        actions: [`${keys.floorUp} / ${keys.floorDown} — name the floor you're on`],
      };
    default:
      return null;
  }
}

// The shared inset linear part, measured from mapgenie's own data — no calibration.
//
// The insets share the world map's rotation exactly and differ only by a uniform
// scale, and that scale is recoverable from the portal graph: a dungeon with two
// entrances gives two free correspondences, and the ratio between the inset
// displacement and the one the world affine predicts IS the scale. (Measured: ~1.97,
// i.e. the insets are drawn at twice the world's scale.) See areaStore.
//
// So dungeons work with nothing asked of the player. A hand calibration inside a
// dungeon still overrides this — that's how you'd correct it if it were ever wrong.
function ensureInsetLinear() {
  if (areas.insetLinear && !areas.insetLinear.derived) return;  // hand-set: leave it
  if (!areaMeta) return;
  const worldCal = loadCalibration();
  const derived = areaStore.deriveInsetLinear(areaMeta, worldCal);
  if (!derived) return;
  const prev = areas.insetLinear && areas.insetLinear.scale;
  if (prev && Math.abs(prev - derived.scale) < 1e-6) return;  // unchanged; don't churn
  areas.insetLinear = derived;
  areaStore.save(areas);
  pushAreas();
  console.log(
    `[areas] inset scale derived from the portal graph: ${derived.scale.toFixed(3)}x ` +
    `the world map (${derived.samples} entrance pairs). No calibration needed — ` +
    'walk into any dungeon and it places itself.',
  );
}

// A crossing is a free correspondence: standing in the doorway, we know both the
// player's world position AND (from mapgenie's portal graph) exactly where that
// doorway comes out on the inset. With the shared linear part that's the entire
// transform, so an unvisited dungeon calibrates itself the moment you walk in.
function absorbAnchor() {
  const anchor = tracker.takeAnchor();
  if (!anchor) return;
  if (!areas.insetLinear) {
    // Only reachable if the inset scale couldn't be derived — which needs the world
    // map calibrated, since the whole measurement is made against that affine.
    console.log(
      `[areas] entered "${anchor.name}" but there's no inset scale to place it with. ` +
      'Calibrate the world map first (the scale is measured against it), or set it by ' +
      'hand with the 3-point flow inside a dungeon.',
    );
    return;
  }
  const existing = areas.areas[anchor.areaKey];
  if (existing && !existing.auto) return;  // hand-calibrated: never overwrite it

  const { c, f } = areaStore.solveTranslation(areas.insetLinear, anchor);
  areas.areas[anchor.areaKey] = {
    subregionId: anchor.subregionId,
    floor: anchor.floor,
    name: anchor.name,
    c,
    f,
    auto: true,
    // How far you stood from that doorway when the game said "inside". It IS the
    // anchor's error, so it's the error of this whole transform — worth keeping next to
    // it, so a placement that later looks off can be explained rather than re-guessed.
    // The tracker won't hand over an anchor beyond `dungeonEnterRadius` unless you
    // forced the entry with Insert, so a large number here means you insisted.
    dist: anchor.dist,
    points: [{ gameX: anchor.gameX, gameY: anchor.gameY, lng: anchor.lng, lat: anchor.lat }],
  };
  areaStore.save(areas);
  pushAreas();
  console.log(
    `[areas] auto-calibrated "${anchor.name}" ${anchor.floor} from the crossing ` +
    `(${anchor.dist.toFixed(1)}u from the nearest known doorway)`,
  );
}

// Where a floor SITS, in game units — the one thing that can tell floors apart, because
// the game reports the same (x, y) on every floor of a dungeon and they differ in z alone.
//
// Learned from you: stand on a floor, press PageUp/PageDown to name it, and once your
// height settles it's recorded for this dungeon. From then on your height picks the floor
// by itself. Averaged over visits, so a second pass sharpens it rather than replacing it.
function absorbHeight() {
  const m = tracker.takeHeight();
  if (!m) return;
  areas.floorHeights[m.areaKey] = { h: m.h, n: m.n };
  areaStore.save(areas);
  pushAreas();
  const area = areas.areas[m.areaKey];
  const label = area ? `${area.name} ${area.floor}`.trim() : m.areaKey;
  console.log(
    `[areas] ${label} sits at height ${m.h.toFixed(1)} `
    + `(measured ${m.sample.toFixed(1)}${m.n > 1 ? `, averaged over ${m.n} visits` : ''})`,
  );
}

// A floor reached only by STAIRS has no entrance, so no free anchor from a doorway
// crossing ever lands on it. Left alone it stays uncalibrated forever: the marker simply
// vanishes when you go up there, and Refine can't rescue it either (Refine SHIFTS an
// existing transform — there'd be nothing to shift). Every upper floor would be dead.
//
// But pressing PageUp/PageDown is an assertion: you just took a stair, so you're standing
// at the end of it. mapgenie knows where that stair comes out on the destination panel
// (203 internal portal edges). So the crossing is a free correspondence, exactly like
// walking in the front door — the same trick, one level down.
//
// Which stair? The one whose near side you're standing on. The floor you just LEFT is
// calibrated (that's how you got here), so inverting ITS transform puts all of its stairs
// in game coords, and the nearest is the one you took. The chain bootstraps itself:
// entrance places floor 1, floor 1's stairs place floor 2, and so on.
function absorbFloorAnchor() {
  const req = tracker.takeFloorAnchor();
  if (!req || !areaMeta || !areas.insetLinear) return;
  const existing = areas.areas[req.areaKey];
  if (existing && typeof existing.c === 'number') return;  // already placed; nothing to do

  // The stairs on the floor we just left that lead to the one we're now on.
  const stairs = areaMeta.portals.filter((p) => (
    p.fromRegion === req.subregionId
    && p.toRegion === req.subregionId
    && floorOf(p.fromTitle) === req.fromFloor
    && floorOf(p.toTitle) === req.toFloor
  ));
  if (!stairs.length) {
    console.log(
      `[areas] ${req.name} ${req.toFloor} has no transform yet, and mapgenie lists no ` +
      `stair from ${req.fromFloor || 'this floor'} to it — the marker can't be placed there. ` +
      'Calibrate it by hand (3-point) while standing on it.',
    );
    return;
  }

  // Pick the stair we actually took: invert the floor we came FROM (it's calibrated —
  // that's how we got here) to place its stairs in game coords, and take the nearest.
  const fromAffine = areaStore.affineFor(areas, `${req.subregionId}|${req.fromFloor}`);
  let best = stairs[0];
  let bestDist = null;
  if (fromAffine && stairs.length > 1) {
    for (const s of stairs) {
      const g = areaStore.invert(fromAffine, s.fromLng, s.fromLat);
      if (!g) continue;
      const d = Math.hypot(req.gameX - g.x, req.gameY - g.y);
      if (bestDist === null || d < bestDist) { bestDist = d; best = s; }
    }
  }

  // You are standing where that stair comes out. Pair it with your world position.
  const { c, f } = areaStore.solveTranslation(areas.insetLinear, {
    gameX: req.gameX, gameY: req.gameY, lng: best.toLng, lat: best.toLat,
  });
  areas.areas[req.areaKey] = {
    subregionId: req.subregionId,
    floor: req.toFloor,
    name: req.name,
    c,
    f,
    auto: true,
    points: [{ gameX: req.gameX, gameY: req.gameY, lng: best.toLng, lat: best.toLat }],
  };
  areaStore.save(areas);
  pushAreas();
  const via = bestDist === null
    ? ''
    : ` (matched the stair you took, ${bestDist.toFixed(0)}u away of ${stairs.length})`;
  console.log(`[areas] placed "${req.name}" ${req.toFloor} from the stair crossing${via}`);
}

// Both the main window and the overlay run the same follow loop off this feed.
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // On teardown the render frame is disposed before the window reports
    // destroyed, and it can be disposed between this check and the send — so
    // guard AND catch. (Only reachable when the process is killed outright;
    // a normal quit clears the poll timers first, via before-quit.)
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try {
      wc.send(channel, payload);
    } catch { /* frame went away mid-send */ }
  }
}

function startMemoryPolling() {
  // The camera feed runs on its own loop, separate from the 30Hz position poll: markers
  // are glued to the world only as long as the projection uses the rotation the game is
  // rendering with (at 30Hz a pan projects with a basis up to 33ms stale and every marker
  // swims). Pinned to ~60Hz to MATCH the overlay's requestAnimationFrame render: a faster
  // feed (120Hz) lands two samples per drawn frame at irregular phases, so the render
  // keeps picking a different one each vsync — a beat frequency that reads as judder.
  // One sample per frame is smooth. The reads are 6 small RPM calls — microseconds.
  camTimer = setInterval(() => {
    if (!readerHandle || !frameOffsets) return;
    const camFrame = cameraFrameReader.read(readerHandle, moduleBase);
    if (!camFrame) return;
    broadcast('camera-frame', {
      pos: [
        camFrame.posLocal[0] + frameOffsets.x,
        camFrame.posLocal[1] + frameOffsets.h,
        camFrame.posLocal[2] + frameOffsets.y,
      ],
      right: camFrame.right,
      up: camFrame.up,
      fwd: camFrame.fwd,
      fovDeg: camFrame.fovDeg,
      aspect: camFrame.aspect,
      near: camFrame.near,
    });
    if (!camLogged) {
      camLogged = true;
      console.log(`[camera] frame feed resolved: fov ${camFrame.fovDeg.toFixed(1)}°, aspect ${camFrame.aspect.toFixed(3)}`);
    }
  }, 16);   // ~60Hz, matched to the overlay's rAF render (see note above)

  // Which AR tokens are already picked up: its own slow loop, decoupled from both
  // feeds above. Collected-state changes at most a few times a session (see
  // generateManagerReader.js), so this only reads and only sends when the set of
  // GUIDs actually changed — same broadcast/onCommand channel as camera-frame.
  collectedTimer = setInterval(() => {
    if (!readerHandle) return;
    const guids = generateManagerReader.read(readerHandle, moduleBase);
    if (!guids) return;
    if (lastCollectedGuids && guids.size === lastCollectedGuids.size
      && [...guids].every((g) => lastCollectedGuids.has(g))) return; // unchanged
    lastCollectedGuids = guids;
    broadcast('collected-tokens', { guids: [...guids] });
    if (!genLogged) {
      genLogged = true;
      console.log(`[collect] never-generate set resolved: ${guids.size} GUID(s) tracked`);
    }
  }, cfg.ar.collectedPollMs);

  pollTimer = setInterval(() => {
    try {
      if (!readerHandle) {
        const pid = findProcessIdByName('DD2.exe');
        if (!pid) return;
        readerHandle = openProcess(pid);
        moduleBase = BigInt(findModuleBase(pid, 'DD2.exe').base);
        gamePid = pid; // the overlay's focus-follow compares against this
      }

      // Local mirror (static): X/height/Y at +0/+4/+8. Used for the height
      // readout and to sanity-check the global read.
      const mirror = readMemory(readerHandle, moduleBase + LOCAL_MIRROR_OFFSET, 12);
      const localX = mirror.readFloatLE(0);
      const height = mirror.readFloatLE(4);
      const localY = mirror.readFloatLE(8);

      // Absolute world position via the stable global chain, with a fallback.
      const readGlobal = (staticOff, offs) => {
        const addr = resolvePointerChain(readerHandle, moduleBase + staticOff, offs);
        const buf = readMemory(readerHandle, addr, 12);
        // h: the GLOBAL height. NOT identical to the local mirror's — the vertical axis
        // rebases too (measured 2026-07-17: global 236.29 vs local 8.29, offset exactly
        // 228.00). Anything mixing frames must offset height like x/y.
        return { x: buf.readFloatLE(0), h: buf.readFloatLE(4), y: buf.readFloatLE(8) };
      };
      let g = null;
      try {
        const primary = readGlobal(GLOBAL_STATIC_OFFSET, GLOBAL_OFFSETS);
        if (consistentWithLocal(primary.x, localX) && consistentWithLocal(primary.y, localY)) g = primary;
      } catch { /* fall through to fallback */ }
      if (!g) {
        const fb = readGlobal(GLOBAL_FALLBACK_STATIC_OFFSET, GLOBAL_FALLBACK_OFFSETS);
        if (consistentWithLocal(fb.x, localX) && consistentWithLocal(fb.y, localY)) g = fb;
      }
      if (!g) return; // both unresolved this tick (e.g. mid-load); skip, keep handle

      // Facing, from the camera. Unit vector in GAME coords pointing where you LOOK.
      // Never fatal: if the chain misses a tick the position feed carries on without it
      // and the map keeps the heading it had.
      const readCamera = (staticOff, offs) => {
        const addr = resolvePointerChain(readerHandle, moduleBase + staticOff, offs);
        const buf = readMemory(readerHandle, addr, 12);
        return { x: buf.readFloatLE(0), y: buf.readFloatLE(8) };
      };
      const facingFrom = (cam) => {
        const dx = g.x - cam.x;
        const dy = g.y - cam.y;
        const len = Math.hypot(dx, dy);
        if (!Number.isFinite(len) || len < CAMERA_MIN_DIST) return null;
        return { x: dx / len, y: dy / len };
      };
      let facing = null;
      try {
        facing = facingFrom(readCamera(CAMERA_STATIC_OFFSET, CAMERA_OFFSETS));
      } catch { /* fall through to the backup path */ }
      if (!facing) {
        try {
          facing = facingFrom(readCamera(CAMERA_FALLBACK_STATIC_OFFSET, CAMERA_FALLBACK_OFFSETS));
        } catch { /* no facing this tick — the map holds its last heading */ }
      }

      // Dungeon zone state: roomHash, insideFlag and zoneIndex all sit in one 32-byte
      // window, so one read gets all three.
      const zoneBuf = readMemory(readerHandle, moduleBase + ZONE_WINDOW_OFFSET, ZONE_WINDOW_SIZE);
      const roomHash = zoneBuf.readInt32LE(0);
      const insideFlag = zoneBuf.readInt32LE(24);
      const zoneIndex = zoneBuf.readInt32LE(28);

      // Which area are we in? Ticked here rather than in a renderer because both
      // windows need the same answer and neither may disagree with the other.
      const area = tracker.tick({ x: g.x, y: g.y, height, insideFlag, zoneIndex, roomHash });
      absorbAnchor();
      absorbHeight();
      absorbFloorAnchor();

      // PRIMARY area source: the game's own current-area record. When it names a
      // dungeon/interior (localArea >= 0) it overrides the tracker's guess for both the
      // NAME and the transform key. When it reads overworld (-1) or can't be trusted this
      // tick, we keep the tracker's answer -- which still runs the nearest-dungeon offer.
      let areaKey = area ? area.key : null;
      let areaName = area ? area.name : null;
      let areaFloor = area ? area.floor : null;
      let areaSource = tracker.reason() || 'startup';
      // For the overlay's F9 edge art: the current dungeon floor's id + world box, set
      // only when the pointer names a DUNGEON floor we have a trustworthy transform for
      // (a baked edge PNG exists at userData/edge/<id>.png). The overlay turns the box
      // into inset corners via the same transform as the marker.
      let edgeLocalArea = null;
      let edgeBox = null;
      // mapgenie's subregion id for the current dungeon floor, or null. The overlay filters
      // the POI layers to it so only THIS floor's icons show (each POI's region_id is its
      // subregion). Set for any dungeon floor the pointer names, placeable or not.
      let subregionId = null;
      const la = localAreaReader ? localAreaReader.read() : null;
      if (la && la.localArea >= 0) {
        const entry = localAreas.byLocalArea[String(la.localArea)];
        if (entry) {
          areaName = entry.title;
          areaFloor = entry.floorLabel || '';
          areaSource = 'pointer';
          // A TOWN_ area (overworld:true) is a settlement, not a dungeon: mapgenie draws no
          // inset for it, and DD2 reports true world coords indoors, so the marker must ride
          // the world affine. areaKey stays null (forArea returns worldCal for null) and we
          // only take the NAME. Naming it after a dungeon inset is exactly the bug that made
          // Vernworth read as "Waterfall Cave" -- see .map/nameTowns.py.
          if (!entry.overworld) {
            areaKey = String(la.localArea);   // forArea places it if areas.areas[key] exists
            if (entry.isDungeon && typeof entry.subregionId === 'number') subregionId = entry.subregionId;
            if (entry.isDungeon && areas.areas[areaKey]) {
              edgeLocalArea = la.localArea;
              edgeBox = entry.box;
            }
          } else if (bakedEdgeIds.has(la.localArea)) {
            // A town with its OWN detailed edge map (bakeTownEdges.py): the game's town-plan
            // texture, pinned at the SOLVED world box (texBox — a town texture has margins, so
            // its game box isn't its art extent) and placed by the world affine (areaKey null,
            // forArea returns worldCal), so the marker rides the same frame.
            edgeLocalArea = la.localArea;
            edgeBox = entry.texBox || entry.box;
          } else if (hasWorldEdge && localAreas.overworld) {
            // No detailed town map baked (or low-confidence solve): fall back to the open
            // overworld's world edge — the town's streets are on it too, just at lower detail.
            edgeLocalArea = -1;
            edgeBox = localAreas.overworld.box;
          }
        }
      } else if (la && la.localArea === -1 && hasWorldEdge && localAreas.overworld) {
        // Overworld: the F9 map is our own world edge art, pinned to the whole world box
        // and placed by the world affine (forArea returns it for a null areaKey). Sentinel
        // id -1 reuses the single dungeon-edge slot; areaKey stays null so the marker still
        // rides the world transform.
        edgeLocalArea = -1;
        edgeBox = localAreas.overworld.box;
      }
      if (areaKey !== lastAreaKey) {
        lastAreaKey = areaKey;
        const where = areaName ? `${areaName} ${areaFloor}`.trim() : 'overworld';
        console.log(`[areas] now in: ${where}  <- ${areaSource}`);
      }

      // The guesses we DIDN'T make. Logged on change only — it's a 30Hz loop.
      // Suppressed entirely once the pointer has named the area: the "inside but what /
      // nearest entrance / Insert to confirm" prompts are the OLD guessing path, and
      // showing them next to a definite pointer answer is just confusing noise.
      const pointerResolved = areaSource === 'pointer';
      const hint = pointerResolved ? null : describeHint(tracker.hint());
      const hintId = hint ? `${hint.code}|${hint.title}` : null;
      if (hintId !== lastHintId) {
        lastHintId = hintId;
        if (hint) {
          const acts = hint.actions.length ? `\n           ${hint.actions.join('\n           ')}` : '';
          console.log(`[areas] ${hint.title} — ${hint.detail.replace(/\n/g, ' — ')}${acts}`);
        }
      }
      const place = tracker.place();

      // Local->global frame offsets for the camera feed (all three axes rebase — the
      // vertical has a floating origin too, measured 228.00u once; see readGlobal).
      // They only change at cell crossings, so the fast camera loop below can reuse
      // the latest values instead of re-reading the player chains at 120Hz.
      frameOffsets = { x: g.x - localX, h: g.h - height, y: g.y - localY };

      const gameTime = timeReader.read(readerHandle, moduleBase);
      if (gameTime && !timeLogged) {
        timeLogged = true;
        console.log(`[time] in-game clock resolved: day ${gameTime.day}, `
          + `${String(gameTime.hh).padStart(2, '0')}:${String(gameTime.mm).padStart(2, '0')}`);
      }

      broadcast('game-position', {
        x: g.x,
        y: g.y,
        height,                 // LOCAL-frame height (floor learning depends on it — keep)
        heightGlobal: g.h,      // GLOBAL-frame height, same frame as x/y and the POI data
        localX,
        localY,
        facing,                 // unit vector in GAME coords, or null (see CAMERA_*)
        areaKey,
        areaName,
        areaFloor,
        edgeLocalArea,          // dungeon floor id for the overlay's F9 edge art, or null
        edgeBox,                // its world box [x0,z0,x1,z1], for computing inset corners
        subregionId,            // mapgenie subregion for POI filtering (this floor only), or null
        near: pointerResolved ? null : tracker.near(),   // nearest doorway; hidden once the pointer knows
        inside: insideFlag !== 0,   // the game's own flag: a dungeon OR any building
        // The named building you're standing in, if you've taught us this doorway (Home).
        // Moves nothing — indoors the game still reports true world coords, so the marker
        // is already right; this only says WHERE right is.
        placeName: place ? place.title : null,
        placeCategory: place ? place.category : null,
        hint,                   // what we're unsure about, and what settles it (or null)
        // The in-game clock (app.TimeManager via the managed-singleton chain), or null.
        // Freezes when the game pauses world time — that's the game's clock, not a bug.
        gameTime: gameTime,
      });
    } catch (err) {
      // DD2.exe likely closed or the chain didn't resolve this tick — drop the
      // handle and retry next tick.
      if (readerHandle) {
        closeHandle(readerHandle);
        readerHandle = null;
        moduleBase = null;
        gamePid = null;
      }
    }
  }, 33); // ~30Hz — finer target updates for the renderer's 60fps follow smoothing
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DD2 Map',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // The overlay is a window too, so it would keep the app alive on its own after
  // you close this one — and it's hidden and frameless, so you'd have no way to
  // get rid of it. Closing the control window quits everything.
  mainWindow.on('closed', () => app.quit());

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[host console] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-attach-webview', (_e, webContents) => {
    // The <webview> tag attaches its own internal loading-state listeners
    // (did-stop-loading etc.) as the mapgenie SPA navigates; raise the cap so
    // Electron doesn't warn about a leak that isn't one of ours.
    webContents.setMaxListeners(30);
    mainGuest = webContents;

    // The mapgenie guest reloads itself, repeatedly (26 times in one play session),
    // and each reload wipes the injected marker + found-sync and re-runs the portal
    // extraction — visible as the map blanking and redrawing while you play. Nothing in
    // our code reloads it, so this says WHO does: a real navigation, a crash, or the
    // page choosing to reload. Diagnostic; keep until the cause is nailed down.
    webContents.on('did-navigate', (_e2, url) => console.log(`[webview nav] -> ${url}`));
    webContents.on('did-fail-load', (_e2, code, desc, url) => {
      console.log(`[webview FAILED LOAD] ${code} ${desc} — ${url}`);
    });
    webContents.on('render-process-gone', (_e2, details) => {
      console.log(`[webview CRASHED] ${details.reason} (exit ${details.exitCode})`);
    });
    webContents.on('unresponsive', () => console.log('[webview UNRESPONSIVE]'));
    webContents.on('console-message', (_e2, level, message, line, sourceId) => {
      if (message.startsWith(FOUND_PREFIX)) {
        mirrorFoundAction(webContents, message.slice(FOUND_PREFIX.length));
        return;
      }
      if (message.startsWith(CALIB_PREFIX)) {
        try {
          const data = JSON.parse(message.slice(CALIB_PREFIX.length));
          mainWindow.webContents.send('calibration-click-result', data);
        } catch {
          // ignore malformed bridge message
        }
        return;
      }
      console.log(`[webview console] ${message} (${sourceId}:${line})`);
    });
    webContents.on('preload-error', (_e2, preloadPath, error) => {
      console.log(`[webview preload-error] ${preloadPath}: ${error}`);
    });
    // Injects a click-capture listener into the guest's own main-world JS
    // context (via executeJavaScript, which reliably sees the real Mapbox
    // instance — unlike a <webview> preload script, which in this Electron
    // version does not actually share window.map with the page even under
    // contextIsolation=no; see M3 debugging notes). Bridges back to the host
    // via a console.log with a special prefix, since page-world script has
    // no ipcRenderer access.
    webContents.on('dom-ready', () => {
      webContents.executeJavaScript(`
        (function() {
          if (window.__dd2_click_hook_installed__) return;
          window.__dd2_click_hook_installed__ = true;
          window.__dd2_calibration_mode__ = false;

          var tooltip = document.createElement('div');
          tooltip.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;background:rgba(0,0,0,0.8);color:#fff;padding:3px 6px;border-radius:4px;font:11px monospace;transform:translate(12px, 12px);display:none;';
          document.body.appendChild(tooltip);

          Object.defineProperty(window, '__dd2_set_calibration_mode__', {
            value: function(active) {
              window.__dd2_calibration_mode__ = active;
              document.body.style.cursor = active ? 'crosshair' : '';
              tooltip.style.display = active ? 'block' : 'none';
            },
            configurable: true,
          });
          Object.defineProperty(window, '__dd2_clear_calib_pins__', {
            value: function() {
              document.querySelectorAll('.__dd2_calib_pin__').forEach(function(el) { el.remove(); });
            },
            configurable: true,
          });

          document.addEventListener('mousemove', function(e) {
            if (!window.__dd2_calibration_mode__) return;
            tooltip.style.left = e.clientX + 'px';
            tooltip.style.top = e.clientY + 'px';
            if (!window.map || typeof window.map.unproject !== 'function') {
              tooltip.textContent = 'map loading...';
              return;
            }
            var ll = window.map.unproject([e.clientX, e.clientY]);
            tooltip.textContent = ll.lng.toFixed(4) + ', ' + ll.lat.toFixed(4);
          });

          document.addEventListener('click', function(e) {
            if (!window.__dd2_calibration_mode__) return;
            if (!window.map || typeof window.map.unproject !== 'function') {
              console.log('${CALIB_PREFIX}' + JSON.stringify({ notReady: true }));
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            const lngLat = window.map.unproject([e.clientX, e.clientY]);

            var pin = document.createElement('div');
            pin.className = '__dd2_calib_pin__';
            pin.dataset.lng = lngLat.lng;
            pin.dataset.lat = lngLat.lat;
            pin.style.cssText = 'position:absolute;width:10px;height:10px;border-radius:50%;background:#2ecc71;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.7);z-index:99998;transform:translate(-50%,-50%);pointer-events:none;';
            document.body.appendChild(pin);
            var pinPos = window.map.project(lngLat);
            pin.style.left = pinPos.x + 'px';
            pin.style.top = pinPos.y + 'px';

            if (!window.__dd2_pin_move_hooked__) {
              window.__dd2_pin_move_hooked__ = true;
              window.map.on('move', function() {
                document.querySelectorAll('.__dd2_calib_pin__').forEach(function(p) {
                  var pp = window.map.project({ lng: parseFloat(p.dataset.lng), lat: parseFloat(p.dataset.lat) });
                  p.style.left = pp.x + 'px';
                  p.style.top = pp.y + 'px';
                });
              });
            }

            console.log('${CALIB_PREFIX}' + JSON.stringify({ lng: lngLat.lng, lat: lngLat.lat }));
          }, true);
        })();
      `).catch((err) => console.log('[inject click hook error]', err));
    });
  });
}

// --- Overlay -----------------------------------------------------------------

function createOverlay() {
  const overlay = overlayWindow.create(cfg);

  overlay.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[overlay] ${message} (${sourceId}:${line})`);
  });
  overlay.webContents.on('did-attach-webview', (_e, webContents) => {
    webContents.setMaxListeners(30);
    overlayGuest = webContents;
    webContents.on('console-message', (_e2, level, message) => {
      if (message.startsWith(FOUND_PREFIX)) {
        mirrorFoundAction(webContents, message.slice(FOUND_PREFIX.length));
        return;
      }
      console.log(`[overlay webview] ${message}`);
    });
  });
}


function registerHotkeys() {
  const bind = (accelerator, label, handler) => {
    if (!accelerator) return;
    // A silently dead hotkey is the worst failure mode here — you'd be pressing
    // a key and getting nothing, with no clue why. Say so.
    const ok = globalShortcut.register(accelerator, handler);
    if (!ok) {
      console.log(`[overlay] FAILED to register ${accelerator} (${label}) — another app likely owns it. Change it in config/overlay.json.`);
    } else {
      console.log(`[overlay] ${accelerator} → ${label}`);
    }
  };

  bind(cfg.hotkeys.toggle, 'overlay on/off', () => {
    const enabled = overlayWindow.toggle();
    if (enabled) {
      // PRESERVE the current F9 mode across on/off (the user asked for this): just re-assert
      // whatever mode was last selected, rather than snapping back to icons-only.
      overlayWindow.send('overlay:mode', overlayMode);
    } else {
      // Coming back should never be stuck interactive; clear the Alt toggle on hide.
      if (interactiveOn) {
        interactiveOn = false;
        overlayWindow.setInteractive(false);
        overlayWindow.send('overlay:interactive', false);
      }
    }
    if (cfg.hideMainWindowWithOverlay && mainWindow && !mainWindow.isDestroyed()) {
      if (enabled) mainWindow.hide(); else mainWindow.show();
    }
  });

  // F9 cycles the three modes: icons-only -> full map -> windowed box -> icons-only.
  bind(cfg.hotkeys.baseMap, 'cycle map mode (icons/map/window)', () => {
    const order = ['icons', 'map', 'window'];
    overlayMode = order[(order.indexOf(overlayMode) + 1) % order.length];
    overlayWindow.send('overlay:mode', overlayMode);
  });

  bind(cfg.hotkeys.zoomOut, 'zoom out', () => {
    overlayWindow.send('overlay:zoom-delta', -cfg.zoomStep);
  });

  bind(cfg.hotkeys.zoomIn, 'zoom in', () => {
    overlayWindow.send('overlay:zoom-delta', cfg.zoomStep);
  });

  // Manual area override. In/out is read straight from the game now, so Insert
  // should rarely be needed for that — what's still invisible to everything
  // automatic is dropping through a hole to the floor below without crossing a
  // portal, since the zone flag doesn't change between floors. Not a fallback for
  // that case — a first-class control, and the only way the app ever learns where a
  // floor sits.
  //
  // The floor's HEIGHT isn't recorded here: you press the key on the stairs, and the
  // stairs are between floors. It's taken a moment later, once your height settles —
  // see areaTracker. What is drained here is the stair crossing, which places a floor
  // that has no entrance of its own, so the map is right by the time you release the key.
  const announce = (area) => {
    absorbFloorAnchor();
    console.log(`[areas] manual: ${area ? `${area.name} ${area.floor}`.trim() : 'overworld'}`);
  };
  bind(cfg.hotkeys.areaToggle, 'enter/exit dungeon', () => announce(tracker.toggle()));
  // rememberPlace (Home) is unassigned now — bind() skips a null accelerator.
  bind(cfg.hotkeys.rememberPlace, 'remember this building', rememberPlace);
  bind(cfg.hotkeys.floorUp, 'floor up', () => announce(tracker.stepFloor(1)));
  bind(cfg.hotkeys.floorDown, 'floor down', () => announce(tracker.stepFloor(-1)));
}

// Alt (mouse capture, now a TOGGLE) and game-focus follow. Both have to be POLLED:
// globalShortcut only ever fires on key press, so it cannot tell us when Alt is
// released, and there's no event for "the foreground window changed".
function startInputPolling() {
  inputTimer = setInterval(() => {
    try {
      const alt = win32Input.isAltDown();

      // Track whether this Alt hold is a bare tap or a chord (Alt+Tab, Alt+F4, ...).
      // Rising edge starts a fresh hold; any other key going down during the hold
      // marks it chorded, so a later Alt+Tab doesn't also toggle the overlay.
      if (alt && !altDown) altChorded = false;
      if (alt && win32Input.otherKeyIsDown()) altChorded = true;

      // Alt is a SWITCH, not hold: flip the interactive state on Alt RELEASE (falling
      // edge) — not press, so Alt+Tab's Alt-down doesn't fire this before Windows even
      // sees the Tab — and only when the hold was a bare tap. One tap captures the
      // mouse (click POIs, move/resize the windowed box); tap again to hand control
      // back to the game.
      if (!alt && altDown && !altChorded) {
        interactiveOn = !interactiveOn;
        overlayWindow.setInteractive(interactiveOn);
        overlayWindow.send('overlay:interactive', interactiveOn);

        // DD2 pins the cursor to screen centre with ClipCursor and only lets go
        // when it loses focus, so a merely click-receiving overlay isn't enough —
        // the cursor stays stuck at centre and clicks land nowhere. Alt has to
        // genuinely ACTIVATE the overlay. Electron's focus() can't do it on its
        // own: Windows denies SetForegroundWindow to a process that didn't get the
        // last input event (DD2 did), so the call is silently ignored. Hence
        // forceForeground, which lifts that restriction via AttachThreadInput.
        if (cfg.focusable !== false && overlayWindow.isEnabled()) {
          if (interactiveOn) {
            priorForeground = win32Input.foregroundWindow();
            overlayWindow.focus();
            win32Input.forceForeground(overlayWindow.getHwnd());
          } else if (priorForeground) {
            win32Input.forceForeground(priorForeground);
            priorForeground = null;
          }
        }
      }
      altDown = alt;

      // Level, not edge: DD2 re-applies its ClipCursor every frame for as long as it
      // thinks it owns the mouse, so clearing it once on toggle-on doesn't stick. The clip
      // is system-wide state, so keep clearing it the whole time we're interactive.
      if (interactiveOn && cfg.focusable !== false && overlayWindow.isEnabled()) {
        win32Input.releaseCursorClip();
      }

      if (!cfg.hideWhenGameUnfocused || !overlayWindow.isEnabled()) return;

      const fg = win32Input.foregroundProcessId();
      const ourWindowIsUp = fg === process.pid;  // any of our own windows
      const gameIsUp = gamePid != null && fg === gamePid;

      // Never hide while we're interactive or while one of our windows has focus — a
      // click on the overlay would otherwise make it vanish under the cursor.
      if (gameIsUp || ourWindowIsUp || interactiveOn) overlayWindow.show();
      else overlayWindow.hide();
    } catch {
      // A transient user32 failure shouldn't kill the loop.
    }
  }, 50);
}

// Live numeric knobs from the control window's sliders: push to the overlay
// immediately so you can see it change, but only write to disk once the drag
// settles.
const NUMBER_KEYS = ['mapOpacity', 'iconOpacity', 'mapBrightness', 'iconBrightness'];
let numberSaveTimer = null;
ipcMain.on('overlay:number', (_event, { key, value }) => {
  if (!NUMBER_KEYS.includes(key)) return;
  const v = Math.min(1, Math.max(0.05, Number(value)));
  if (!Number.isFinite(v)) return;
  cfg[key] = v;
  overlayWindow.send('overlay:number', { key, value: v });
  clearTimeout(numberSaveTimer);
  numberSaveTimer = setTimeout(() => overlayConfig.save(cfg), 500);
});

// Overlay settings toggled from the control window: booleans plus the string mapStyle.
const SETTING_KEYS = ['autoZoom', 'hideFound', 'rotateWithHeading', 'areaHud', 'arTokens'];
ipcMain.on('overlay:setting', (_event, { key, value }) => {
  if (SETTING_KEYS.includes(key)) {
    cfg[key] = !!value;
    overlayWindow.send('overlay:setting', { key, value: !!value });
    overlayConfig.save(cfg);
  } else if (key === 'mapStyle' && (value === 'edge' || value === 'color')) {
    cfg.mapStyle = value;
    overlayWindow.send('overlay:setting', { key, value });
    overlayConfig.save(cfg);
  }
});

// Whether any baked edge art exists (userData/edge/*.png) — the control window uses this to
// enable/disable the Edge map style. Read fresh so it reflects a just-finished generation.
ipcMain.handle('overlay:edge-available', async () => {
  try {
    const files = await fsp.readdir(path.join(app.getPath('userData'), 'edge'));
    return files.some((f) => /\.png$/i.test(f));
  } catch {
    return false;
  }
});

ipcMain.handle('overlay:config:load', () => cfg);
ipcMain.handle('overlay:config:save', (_event, data) => {
  cfg = { ...cfg, ...data };
  overlayConfig.save(cfg);
  return true;
});

// The overlay window (windowed F9 mode) was moved/resized; persist the box as screen
// fractions so it's remembered and survives a resolution change.
ipcMain.on('overlay:save-window-rect', (_event, rect) => {
  if (!rect || typeof rect.width !== 'number') return;
  cfg = { ...cfg, windowRect: rect };
  overlayConfig.save(cfg);
});

ipcMain.on('overlay:probe', (_event, info) => {
  console.log(
    `[overlay] map probe: canvas alpha=${info.alpha}, zoom=${info.zoom?.toFixed?.(2)} ` +
    `(range ${info.minZoom}–${info.maxZoom}), ${info.layerCount} layers (${info.symbolLayers} symbol)`
  );
  if (info.alpha === false) {
    console.log(
      '[overlay] WARNING: map canvas has alpha=false — icons-only mode (the base-map ' +
      'hotkey) cannot be transparent by hiding layers. See FINDINGS.md "Overlay".'
    );
  }
});

ipcMain.handle('calibration:load', () => loadCalibration());
ipcMain.handle('calibration:save', (_event, data) => {
  saveCalibration(data);
  // The doorways live in GAME coords, derived by inverting this affine — so a
  // recalibration or a Refine moves every one of them. The derived inset scale is
  // measured against this affine too, so it has to be re-derived.
  tracker.setWorldCalibration(data);
  ensureInsetLinear();
  return true;
});

// --- Dungeon areas IPC -------------------------------------------------------

// The portal graph, extracted from the mapgenie guest by the control window (see
// mapAgent.buildExtractAreas). Cached so the overlay never has to re-derive it and
// a mapgenie outage can't take the feature down with it.
// The control window re-extracts on every guest dom-ready, and the mapgenie SPA
// navigates on its own, so this arrives repeatedly (measured: 4 times in one session,
// unprompted). The graph is identical every time, and it's ~300KB — so re-parsing and
// rewriting it on each one is pure waste. Only act when it actually changed.
let areaMetaFingerprint = null;

ipcMain.handle('areas:metadata', (_event, meta) => {
  if (!meta || !Array.isArray(meta.portals)) return false;
  // `pois` is part of the fingerprint, not just a passenger: without it, a cache written
  // before named places existed has an IDENTICAL fingerprint to a fresh extraction that
  // has them, so the new graph would be dropped and buildings would never work.
  const fingerprint = `${meta.portals.length}|${Object.keys(meta.subregions || {}).length}`
    + `|${(meta.pois || []).length}|${meta.locationCount}`;
  if (fingerprint === areaMetaFingerprint) return true;
  areaMetaFingerprint = fingerprint;

  configStore.save('mapgenie-areas', meta);
  areaMeta = meta;
  tracker.setMetadata(meta);
  console.log(
    `[areas] ${tracker.doorCount()} dungeon doorways and ${tracker.poiCount()} named places `
    + 'placed in game coords',
  );
  ensureInsetLinear();
  return true;
});

ipcMain.handle('areas:load', () => areas);

// The AR layer's POI set: Seeker's Token positions in game world coords, from gibbed's
// Almanac dump vendored in data/almanac (see FINDINGS.md). Engine axes: x, y=height, z.
ipcMain.handle('ar:pois:load', () => {
  try {
    const raw = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'data', 'almanac', '167.json'), 'utf-8'));
    return Object.entries(raw.locations).map(([guid, p]) => ({ guid, x: p.x, h: p.y, y: p.z }));
  } catch {
    return [];   // no data file — the AR layer just draws nothing
  }
});

// Seeds the shared inset scale/rotation from a 3-point calibration run inside one
// dungeon, and stores that dungeon as hand-calibrated. Every OTHER dungeon then
// needs no clicks at all — the crossing anchor plus this linear part is the whole
// transform.
// A hand calibration inside a dungeon. No longer REQUIRED — the inset scale is
// derived from the portal graph on its own — but kept as the way to measure it
// properly and to override the derivation if it's ever wrong.
//
// It also reports the fitted scale against the derived one, which is the experiment
// that tells us whether the derivation can be trusted.
ipcMain.handle('areas:calibrate', (_event, { areaKey, area, linear }) => {
  if (!areaKey || !area || !linear) return false;
  const worldCal = loadCalibration();
  const measured = areaStore.scaleOf(linear, worldCal);
  const derived = areas.insetLinear && areas.insetLinear.scale;

  areas.insetLinear = { ...linear, scale: measured, derived: false };
  areas.areas[areaKey] = { ...area, auto: false };
  areaStore.save(areas);
  pushAreas();

  const cmp = (derived && measured)
    ? ` — measured ${measured.toFixed(3)}x the world map, vs ${derived.toFixed(3)}x derived ` +
      `from the portal graph (${(100 * Math.abs(measured - derived) / derived).toFixed(1)}% apart)`
    : '';
  console.log(`[areas] inset scale set by hand from "${area.name}"${cmp}`);
  return { measured, derived };
});

// Refine, inside a dungeon: nudge the area's translation. Deliberately NOT the
// overworld's accumulate-and-re-fit behaviour — the linear part is shared and
// already known, so there is nothing left to fit. Only the offset can be wrong, and
// a straight shift is both what's needed and what lets you drag yourself back into
// place when a crossing anchor lands slightly off.
ipcMain.on('areas:shift', (_event, { areaKey, dLng, dLat }) => {
  const area = areas.areas[areaKey];
  if (!area || !Number.isFinite(dLng) || !Number.isFinite(dLat)) return;
  area.c += dLng;
  area.f += dLat;
  area.auto = false;  // you moved it by hand; a later crossing must not undo that
  areaStore.save(areas);
  pushAreas();
  console.log(`[areas] shifted "${area.name}" ${area.floor}`.trim());
});
ipcMain.handle('view:load', () => loadView());
ipcMain.handle('view:save', (_event, data) => {
  saveView(data);
  return true;
});

app.whenReady().then(() => {
  cfg = overlayConfig.load();
  // Initial F9 mode. F8 preserves it thereafter; F9 cycles it.
  overlayMode = cfg.openIconsOnly === false ? 'map' : 'icons';

  // Serve baked edge art from userData/edge/ over app-tiles://. The dungeon-floor PNGs
  // (LocalArea id -> <id>.png) are generated from the user's own game files, never
  // shipped. A request outside the edge dir (path traversal) is refused.
  const edgeDir = path.join(app.getPath('userData'), 'edge');
  fsp.access(path.join(edgeDir, 'world.png')).then(() => { hasWorldEdge = true; }).catch(() => {});
  fsp.readdir(edgeDir).then((files) => {
    for (const fn of files) {
      const m = /^(\d+)\.png$/.exec(fn);
      if (m) bakedEdgeIds.add(Number(m[1]));
    }
  }).catch(() => {});
  protocol.handle('app-tiles', async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const target = path.normalize(path.join(edgeDir, rel));
    if (!target.startsWith(edgeDir)) return new Response('forbidden', { status: 403 });
    try {
      const buf = await fsp.readFile(target);
      return new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // Areas: the saved per-dungeon transforms, the world affine the doorways are
  // derived from, and the cached portal graph. The cache means the doorways are live
  // from the first tick, before the mapgenie guest has even finished loading.
  areas = areaStore.load();
  // The game-derived area table + pointer chains (shipped, universal). If either is
  // missing the reader stays null and we run on the old tracker alone.
  localAreas = configStore.load('localAreas');
  const chainCfg = configStore.load('dd2.localarea');
  if (localAreas && chainCfg) {
    mergeLocalAreas();
    try {
      localAreaReader = createLocalAreaReader(chainCfg, localAreas);
    } catch (err) {
      console.log(`[areas] pointer reader disabled: ${err.message}`);
    }
  }
  tracker.setHeights(areas.floorHeights);
  tracker.setEnterRadius(cfg.dungeonEnterRadius);  // how near a doorway "inside" must be
  tracker.setPlaceRadius(cfg.placeRadius);         // ...and how big a building is
  tracker.setPlaces(areas.places);                 // the buildings you've already named
  tracker.setWorldCalibration(loadCalibration());
  const cachedMeta = configStore.load('mapgenie-areas');
  if (cachedMeta) {
    areaMeta = cachedMeta;
    tracker.setMetadata(cachedMeta);
    ensureInsetLinear();  // so dungeons work from the first tick, before mapgenie loads
  }

  createWindow();
  createOverlay();
  registerHotkeys();
  startMemoryPolling();
  startInputPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Stop the polls before the windows come down, so neither loop fires into a
// half-disposed frame on the way out.
app.on('before-quit', () => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (camTimer) { clearInterval(camTimer); camTimer = null; }
  if (collectedTimer) { clearInterval(collectedTimer); collectedTimer = null; }
  if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (readerHandle) { closeHandle(readerHandle); readerHandle = null; }
  if (localAreaReader) { localAreaReader.detach(); }
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (camTimer) clearInterval(camTimer);
  if (collectedTimer) clearInterval(collectedTimer);
  if (inputTimer) clearInterval(inputTimer);
  if (readerHandle) closeHandle(readerHandle);
  if (process.platform !== 'darwin') app.quit();
});
