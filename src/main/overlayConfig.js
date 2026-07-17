// Overlay settings, with defaults so a missing or partial config/overlay.json
// still boots. Everything that decides how the overlay *feels* in-game (the
// run/stand speed thresholds, the zoom steps, the ease rate) lives here rather
// than in code, so tuning it is an edit-and-relaunch, not a code change.

const store = require('./configStore');

const DEFAULTS = {
  hotkeys: {
    toggle: 'F8',
    baseMap: 'F9',
    zoomOut: 'F10',
    zoomIn: 'F11',
    // Manual area override. In/out is read straight from the game (see
    // areaTracker.js), so this is mainly for the one thing that isn't: dropping
    // through a hole to the floor below without ever crossing a portal.
    areaToggle: 'Insert',
    floorUp: 'PageUp',
    floorDown: 'PageDown',
    // rememberPlace (Home) is unassigned: the pointer names buildings now, so the manual
    // "this interior is that building" bind is no longer needed. null = bind() skips it.
    rememberPlace: null,
  },

  // The overlay's INITIAL F9 mode at startup. F9 cycles icons-only -> full map -> windowed
  // box; F8 now PRESERVES the current mode across on/off (it no longer snaps back here).
  // true = start icons-only (what you play with); false = start on the full map.
  openIconsOnly: true,

  // The AR collectible layer: Seeker's Token and Golden Trove Beetle markers projected
  // to WHERE THE COLLECTIBLE IS in 3D, through the game's own camera basis and fov.
  // arCollectibles is the on/off (a control-window checkbox, covering both kinds); the
  // knobs below decide how it feels. (Renamed from arTokens — load() migrates the old key.)
  arCollectibles: true,
  ar: {
    radiusU: 200,     // draw tokens within this many game units of the player (a sphere)
    markerPx: 14,     // marker size at ~40u; scales with distance, clamped 6..28 px
    labels: true,     // distance label under each marker
    // Vertical frame correction. The Almanac's x/z match the game's runtime frame
    // exactly, but its HEIGHT (engine-y) sits in a vertical origin shifted by a flat
    // 100u — measured 2026-07-17 standing dead-on a token: player global height
    // 207.96, token raw y 107.95, gap 100.01. Added to every POI height.
    heightOffsetU: 100,
    // Cosmetic float: lift the MARKER above the collectible so it hovers near eye
    // level instead of at the object's feet. Not a physics correction — readability.
    // FADED IN with distance (floatFadeU): a world-space lift is a big ANGLE up close
    // (1.6u at 2u away = ~39deg — the marker flies off the token) but invisible far
    // off. So the lift ramps from 0 on top of the token to floatU past floatFadeU,
    // which makes the marker LAND on the shiny as you walk up and float for visibility
    // at range. Tune to taste.
    floatU: 1.6,
    floatFadeU: 8,
    // Render-interpolation delay (ms). Markers are drawn from a camera interpolated to
    // (now - interpMs), between the two latest frames, so feed/vsync phase can't judder
    // the motion. ~1.5 feed intervals guarantees two frames straddle the render time.
    // Higher = smoother but more latent on fast flicks; lower = snappier but can judder.
    interpMs: 8,
    // Off-screen tokens clamp to the screen border as arrows rather than vanishing.
    // Cap how many, so a dense area doesn't wall the edges — nearest ones win.
    edgeMax: 12,
    // How often (ms) to re-read app.GenerateManager._NeverGenetateID and hide tokens
    // the player has already collected. Collected-state changes at most a few times
    // per session, nowhere near every frame, so this is its own slow timer separate
    // from the 30Hz position poll and 16ms camera timer — see generateManagerReader.js.
    collectedPollMs: 3000,
  },

  // The windowed F9 mode's box, as fractions of the screen (resolution-independent). The
  // overlay converts to pixels; move/resize writes it back here. Default: upper-right.
  windowRect: { left: 0.63, top: 0.06, width: 0.34, height: 0.46 },

  // Overlay map style: 'edge' draws OUR edge art (baked from the game's textures) over the
  // map; 'color' leaves mapgenie's full-colour raster. Default 'edge' — with art baked it's
  // what the overlay is for; with none baked it harmlessly falls back to the raster (there's
  // no edge layer to draw). Chosen from the control window (Full color / Edge).
  mapStyle: 'edge',

  // null = adopt whatever zoom the map is already at on first run, then persist.
  baseZoom: null,
  zoomStep: 0.5,       // how far one zoomIn/zoomOut press moves the base zoom

  // Off by default: the map holds whatever zoom you set with the hotkeys, full
  // stop. Turn it on (checkbox in the control window) for the run/stand behaviour
  // below — everything from runZoomOut down only applies when this is true.
  autoZoom: false,
  // How many ZOOM LEVELS below the base to pull back while running. Levels, not a
  // percentage: Mapbox zoom is logarithmic (one level = 2x the view), so "70% of
  // zoom 15.5" is 10.85 — about 25x wider, which is why that felt like it flew
  // into orbit. 1.4 levels ≈ 2.6x wider.
  runZoomOut: 1.4,
  zoomEase: 0.12,      // per-frame lerp toward the zoom target; higher = snappier

  // Heading-up: rotate the overlay's map so the way you're LOOKING is up, instead
  // of leaving you to work out which way to turn so the arrow ends up on the POI.
  // Off by default — north-up is what a map normally means, and heading-up is a
  // taste. The control window is never rotated (clicking calibration landmarks on a
  // spinning map is miserable).
  //
  // The heading is the game's CAMERA direction (found 2026-07-13; see FINDINGS.md), so
  // it is a real facing angle: it holds steady while you stand still and look around,
  // and running backwards no longer spins the map around. If the camera can't be read
  // it silently falls back to the old movement-vector heading.
  rotateWithHeading: false,
  // Per-frame lerp toward the heading; higher = snappier. The heading itself is
  // already smoothed, so this stacks on top: 0.1 settles a turn in roughly half a
  // second. Push it up if the map feels like it's lagging behind you, down if a
  // wall-slide or a dodge makes it wobble.
  rotateEase: 0.1,
  // Smoothing on the heading itself, before rotateEase gets it. The camera signal is
  // clean (it IS the facing angle, not a direction reconstructed from noisy deltas), so
  // this only takes the edge off a fast mouse flick. Lower it if a quick look-around
  // makes the arrow feel twitchy.
  headingEase: 0.25,

  // Speed hysteresis, in game units/sec, with a dwell on each edge.
  // The dwell timer survives the dead band between the two speeds and only resets
  // on a real stop — otherwise a 5s runDwell could never be reached, since real
  // running dips below any fixed threshold constantly (turns, bumps, slopes).
  runSpeed: 2.0,
  stillSpeed: 0.5,
  runDwellMs: 3000,    // must be moving this long before the map zooms out
  stillDwellMs: 400,

  // Two separate opacities, because the two modes want opposite things:
  // the full map should read as a MAP (opaque), while icons-only floats over live
  // gameplay and must not blot out in-game text.
  mapOpacity: 1.0,     // full-map mode
  iconOpacity: 0.7,    // icons-only mode (F9)

  // Darkens the overlay's pixels BEFORE the window composites them over the game.
  // Needed because compositing is straight alpha and mapgenie's style is
  // near-white: a faded white map just adds white to the screen (glare). Pushed
  // below ~0.4 it goes darker than the game, so a faint overlay reads as a shadow
  // instead of a wash. Per-mode, like the opacities — icons and the full map want
  // different amounts.
  mapBrightness: 0.35,
  iconBrightness: 0.35,

  // Hide POIs you've already marked as found, in the overlay only. mapgenie just
  // fades them to 40% opacity, which is nearly invisible as a distinction once the
  // overlay's own opacity and brightness are stacked on top — so they still
  // cluttered the map. The control window keeps showing them, so you can still
  // find and mark them there.
  hideFound: true,

  // --- Dungeons ---------------------------------------------------------------
  // How close to a KNOWN doorway you have to be, in game units, for the game's "you're
  // inside" flag to be taken as "you're inside THAT dungeon".
  //
  // The flag is set by every building in the game — houses, shops, the barracks — and
  // mapgenie has an entrance for none of them. Without a limit, the nearest entrance is
  // whatever dungeon happens to be least far away, which produced this beauty:
  //
  //   auto-calibrated "Ancestral Chamber" from the crossing (219.4u from the nearest
  //   known doorway)
  //
  // — and saved that 219u of error as the dungeon's transform. 20u is about a doorway's
  // worth of slack plus the world affine's fit error. Raise it if a real dungeon you
  // walk into is being missed (the overlay will tell you how far off it was); lower it
  // if a building still grabs one.
  dungeonEnterRadius: 20,

  // Roughly how big a building is, in game units. Two uses, one meaning:
  //   - how far from the doorway you taught us (Home) we still recognise the building;
  //   - how far Home will reach for a POI to name it with. Beyond this it refuses —
  //     a "nearest" inn 300u away is not the room you are standing in, and binding it
  //     would be the same mistake as the 219u dungeon, wearing a friendlier name.
  // mapgenie draws a building's icon wherever it looks right (a roof, a courtyard), so
  // this has to absorb that offset as well as the world affine's fit error.
  placeRadius: 40,

  // The overlay's area readout: where you are, the nearest dungeon, and what to press
  // when the app is unsure (it can't know which building you just walked into, and it
  // can't know your floor until you've named it once). Off = the overlay stays purely
  // map, and the same information is still in the control window.
  areaHud: true,
  // How near a dungeon has to be for the readout to bother mentioning it, in game units.
  // Well outside dungeonEnterRadius on purpose: it's what tells you the entrance is
  // there and how far the app thinks you are from it.
  areaHudRadius: 150,

  hideWhenGameUnfocused: true,
  hideMainWindowWithOverlay: true,

  // DD2 confines the cursor to screen centre and only releases it when it loses
  // focus, so Alt has to actually FOCUS the overlay for the mouse to work at all.
  // On release, focus goes straight back to the game. Set false if you'd rather
  // the game never lose focus and you don't need to click POIs.
  focusable: true,
};

function load() {
  const saved = store.load('overlay') || {};
  // arTokens was renamed to arCollectibles (now covers beetles too). Honour a user's old
  // saved value so someone who turned the layer OFF doesn't get it back on after upgrade.
  const arCollectibles = saved.arCollectibles !== undefined ? saved.arCollectibles
    : (saved.arTokens !== undefined ? saved.arTokens : DEFAULTS.arCollectibles);
  return {
    ...DEFAULTS,
    ...saved,
    arCollectibles,
    hotkeys: { ...DEFAULTS.hotkeys, ...(saved.hotkeys || {}) },
    // Nested like hotkeys: a saved `ar` block must not shadow defaults for knobs it
    // predates (e.g. heightOffsetU), or the new knob silently reverts to undefined.
    ar: { ...DEFAULTS.ar, ...(saved.ar || {}) },
  };
}

// The `ar` block is code/JSON tuning only — no UI writes it — but load() folds the
// full DEFAULTS.ar into the in-memory cfg. If we persisted that, the first UI save
// (a checkbox toggle) would freeze every ar knob into overlay.json and from then on
// silently shadow future DEFAULTS.ar edits. So save NEVER authors `ar`: it writes back
// only the ar the user actually put on disk (hand-edited), and drops the merged one.
function save(cfg) {
  const onDisk = store.load('overlay') || {};
  const toWrite = { ...cfg };
  if (onDisk.ar !== undefined) toWrite.ar = onDisk.ar;
  else delete toWrite.ar;
  store.save('overlay', toWrite);
}

module.exports = { DEFAULTS, load, save };
