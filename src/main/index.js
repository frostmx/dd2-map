const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('node:path');
const { findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle } = require('./memoryReader');
const overlayWindow = require('./overlayWindow');
const overlayConfig = require('./overlayConfig');
const configStore = require('./configStore');
const win32Input = require('./win32Input');
const areaStore = require('./areaStore');
const { createTracker, floorOf } = require('./areaTracker');

// Must run before app.whenReady(): the overlay is never the focused window, and
// without these Chromium throttles its timers/rAF to ~1fps and the marker
// freezes. See overlayWindow.js.
overlayWindow.applyThrottlingSwitches();

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

// Dungeon zone state, straight from the game — no pointer chain, same kind of read as
// the local mirror above. Found by CE value-scanning (2026-07-13; see
// config/dd2.offsets.json). Three fields we care about, so one read covers them all:
//
//   -24  roomHash    -1 outside; inside, a STABLE id for the room you're standing in
//                    (same room = same hash, across visits and across sessions)
//     0  insideFlag   0 = overworld; 1 and 2 both = inside (2 is some other kind of
//                     interior — seen in Stormwind Cave; both mean inside, so it
//                     doesn't matter which)
//    +4  zoneIndex    the game's own dungeon id. NOT mapgenie's numbering (game: 18,
//                     69, 2010; mapgenie subregions: 2441-2514), so it can't name a
//                     dungeon yet — see tools/zoneLog.js.
//
// insideFlag replaces guessing entry/exit from proximity to a doorway position derived
// from the world affine. roomHash is the key to the learned floor table (areas.rooms).
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

let cfg = null;              // config/overlay.json, with defaults filled in
let gamePid = null;          // DD2.exe's pid, for the overlay's focus-follow
let inputTimer = null;
let altDown = false;         // last observed Alt state, for edge detection
// The overlay opens icons-only (see cfg.openIconsOnly); F9 brings the map.
let baseMapVisible = false;
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

function pushAreas() {
  tracker.setRooms(areas.rooms);   // the learned roomHash -> floor table
  broadcast('areas:state', areas);
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
    points: [{ gameX: anchor.gameX, gameY: anchor.gameY, lng: anchor.lng, lat: anchor.lat }],
  };
  areaStore.save(areas);
  pushAreas();
  // How far the player was from the nearest KNOWN doorway at the instant the game's
  // own zone flag said "you're in here" — not a detection radius any more, just how
  // far off this anchor (and therefore the auto placement) is likely to be. Sets how
  // big a Refine shift you'd need if it looks off.
  console.log(
    `[areas] auto-calibrated "${anchor.name}" ${anchor.floor} from the crossing ` +
    `(${anchor.dist.toFixed(1)}u from the nearest known doorway)`,
  );
}

// The game gives us a stable id for the room you're standing in, but nothing that says
// which FLOOR that room is on — and a room change is NOT a floor change (one walk
// through Forgotten Tunnel crossed 8 rooms across 2 floors), so it can't be inferred.
//
// So it's learned instead. Every time you set the floor by hand, the room you were in
// is recorded against it. Walk into that room again — next week, next session — and the
// floor is set exactly, from the table, with no geometry involved. Each room needs
// correcting at most once, ever, and the dungeon becomes deterministic as you explore it.
function absorbRoom() {
  const learned = tracker.takeRoom();
  if (!learned) return;
  areas.rooms[learned.room] = learned.areaKey;
  areaStore.save(areas);
  pushAreas();
  if (learned.conflict) {
    // The room has now been seen on two floors — it's a stairwell, and it physically
    // spans both. There is no right answer, so it's marked ambiguous and will never be
    // consulted again. Saying so matters: silently dropping it would look like the
    // learning had simply failed.
    console.log(
      `[areas] room ${learned.room} is on BOTH ${learned.conflict.split('|')[1] || '?'} ` +
      `and ${learned.areaKey === '?' ? learned.label : learned.areaKey} — that's a stairwell. ` +
      'Marked ambiguous; it will never decide the floor again.',
    );
    return;
  }
  console.log(`[areas] learned: room ${learned.room} is on ${learned.label} — it won't need telling again`);
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

// "You may have changed floor." Advice, never an action — the tracker deliberately did
// NOT move you. A big height change across a room boundary is what a staircase looks
// like, but it's also what a long ramp or a deep shaft inside one floor looks like, so
// acting on it would silently teleport the marker to the wrong panel often enough to be
// worse than useless.
//
// It's here for the case nothing else can catch: DROPPING THROUGH A HOLE to the floor
// below. No portal, no prompt, and you might not even notice — the map would just be
// quietly wrong. This tells you, you press PageUp/PageDown, and that both fixes it and
// teaches the room, so it never asks again.
function absorbFloorHint() {
  const hint = tracker.takeFloorHint();
  if (!hint) return;
  const dir = hint.dh < 0 ? 'DOWN' : 'UP';
  const key = hint.dh < 0 ? cfg.hotkeys.floorDown : cfg.hotkeys.floorUp;
  console.log(
    `[areas] you moved ${Math.abs(hint.dh).toFixed(0)}u ${dir} into a new room (${hint.room}) — ` +
    `if that was a floor change (a staircase, or a hole you fell through), press ${key}. ` +
    'It will remember this room and stop asking.',
  );
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
        return { x: buf.readFloatLE(0), y: buf.readFloatLE(8) };
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
      absorbRoom();
      absorbFloorHint();
      const areaKey = area ? area.key : null;
      if (areaKey !== lastAreaKey) {
        lastAreaKey = areaKey;
        const where = area ? `${area.name} ${area.floor}`.trim() : 'overworld';
        console.log(`[areas] now in: ${where}  <- ${tracker.reason() || 'startup'}`);
      }

      broadcast('game-position', {
        x: g.x,
        y: g.y,
        height,
        localX,
        localY,
        areaKey,
        areaName: area ? area.name : null,
        areaFloor: area ? area.floor : null,
        near: tracker.near(),   // nearest doorway + distance, for the readout
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
      // Assert the opening mode on every F8-on, not just at startup. Otherwise the
      // mode is sticky: look something up on the full map, hide the overlay, bring
      // it back mid-fight, and you get a full map over your face. Icons-only is the
      // mode you play with; the map is a deliberate F9 away.
      baseMapVisible = !cfg.openIconsOnly;
      overlayWindow.send('overlay:basemap', baseMapVisible);
    }
    if (cfg.hideMainWindowWithOverlay && mainWindow && !mainWindow.isDestroyed()) {
      if (enabled) mainWindow.hide(); else mainWindow.show();
    }
  });

  bind(cfg.hotkeys.baseMap, 'base map on/off (icons-only)', () => {
    baseMapVisible = !baseMapVisible;
    overlayWindow.send('overlay:basemap', baseMapVisible);
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
  // that case — a first-class control.
  // A manual change can produce two things the poll loop would otherwise pick up a tick
  // later: the room it just taught us, and — for a floor with no entrance of its own —
  // the stair crossing that places it. Drain both here so the map is right by the time
  // you've let go of the key.
  const announce = (area) => {
    absorbRoom();
    absorbFloorAnchor();
    console.log(`[areas] manual: ${area ? `${area.name} ${area.floor}`.trim() : 'overworld'}`);
  };
  bind(cfg.hotkeys.areaToggle, 'enter/exit dungeon', () => announce(tracker.toggle()));
  bind(cfg.hotkeys.floorUp, 'floor up', () => announce(tracker.stepFloor(1)));
  bind(cfg.hotkeys.floorDown, 'floor down', () => announce(tracker.stepFloor(-1)));
}

// Alt-hold (mouse capture) and game-focus follow. Both have to be POLLED:
// globalShortcut only ever fires on key press, so it cannot tell us when Alt is
// released, and there's no event for "the foreground window changed".
function startInputPolling() {
  inputTimer = setInterval(() => {
    try {
      const alt = win32Input.isAltDown();

      // Edge, not level: only act when Alt actually changes state.
      if (alt !== altDown) {
        altDown = alt;
        overlayWindow.setInteractive(alt);
        overlayWindow.send('overlay:interactive', alt);

        // DD2 pins the cursor to screen centre with ClipCursor and only lets go
        // when it loses focus, so a merely click-receiving overlay isn't enough —
        // the cursor stays stuck at centre and clicks land nowhere. Alt has to
        // genuinely ACTIVATE the overlay. Electron's focus() can't do it on its
        // own: Windows denies SetForegroundWindow to a process that didn't get the
        // last input event (DD2 did), so the call is silently ignored. Hence
        // forceForeground, which lifts that restriction via AttachThreadInput.
        if (cfg.focusable !== false && overlayWindow.isEnabled()) {
          if (alt) {
            priorForeground = win32Input.foregroundWindow();
            overlayWindow.focus();
            win32Input.forceForeground(overlayWindow.getHwnd());
          } else if (priorForeground) {
            win32Input.forceForeground(priorForeground);
            priorForeground = null;
          }
        }
      }

      // Held, not just on the edge: DD2 re-applies its ClipCursor every frame for
      // as long as it thinks it owns the mouse, so clearing it once on Alt-down
      // doesn't stick. The clip is system-wide state, so we can just keep clearing
      // it while Alt is held.
      if (alt && cfg.focusable !== false && overlayWindow.isEnabled()) {
        win32Input.releaseCursorClip();
      }

      if (!cfg.hideWhenGameUnfocused || !overlayWindow.isEnabled()) return;

      const fg = win32Input.foregroundProcessId();
      const ourWindowIsUp = fg === process.pid;  // any of our own windows
      const gameIsUp = gamePid != null && fg === gamePid;

      // Never hide while Alt is held or while one of our windows has focus — an
      // Alt-click on the overlay would otherwise make it vanish under the cursor.
      if (gameIsUp || ourWindowIsUp || alt) overlayWindow.show();
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

// Boolean overlay settings toggled from the control window.
const SETTING_KEYS = ['autoZoom', 'hideFound', 'rotateWithHeading'];
ipcMain.on('overlay:setting', (_event, { key, value }) => {
  if (!SETTING_KEYS.includes(key)) return;
  cfg[key] = !!value;
  overlayWindow.send('overlay:setting', { key, value: !!value });
  overlayConfig.save(cfg);
});

ipcMain.handle('overlay:config:load', () => cfg);
ipcMain.handle('overlay:config:save', (_event, data) => {
  cfg = { ...cfg, ...data };
  overlayConfig.save(cfg);
  return true;
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
  const fingerprint = `${meta.portals.length}|${Object.keys(meta.subregions || {}).length}|${meta.locationCount}`;
  if (fingerprint === areaMetaFingerprint) return true;
  areaMetaFingerprint = fingerprint;

  configStore.save('mapgenie-areas', meta);
  areaMeta = meta;
  tracker.setMetadata(meta);
  console.log(`[areas] ${tracker.doorCount()} dungeon doorways placed in game coords`);
  ensureInsetLinear();
  return true;
});

ipcMain.handle('areas:load', () => areas);

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

  // Areas: the saved per-dungeon transforms, the world affine the doorways are
  // derived from, and the cached portal graph. The cache means the doorways are live
  // from the first tick, before the mapgenie guest has even finished loading.
  areas = areaStore.load();
  tracker.setRooms(areas.rooms);
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
  if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (readerHandle) { closeHandle(readerHandle); readerHandle = null; }
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (inputTimer) clearInterval(inputTimer);
  if (readerHandle) closeHandle(readerHandle);
  if (process.platform !== 'darwin') app.quit();
});
