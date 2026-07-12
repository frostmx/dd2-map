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
    // Manual area override. Entering a dungeon is detected from the doorway, which
    // cannot catch every case: brushing past a cave mouth flips the map, and
    // dropping through a hole to the floor below never touches a portal at all.
    areaToggle: 'Insert',
    floorUp: 'PageUp',
    floorDown: 'PageDown',
  },

  // Game units, for the doorway detector (src/main/areaTracker.js). enterRadius has
  // to absorb the world affine's own fit error too, since the doorways' game coords
  // are derived from it — so it is a knob, not a constant.
  // How close to a doorway counts as going through it. 10 is what it should be: at 15
  // the map flipped noticeably BEFORE you reached the entrance, which reads as the
  // app jumping the gun. (It was briefly raised to 15 to chase missed entries — but
  // those turned out to be the re-arm latch below, not the radius, so the radius went
  // back.)
  enterRadius: 10,

  // Re-arming the doorway takes BOTH: at least rearmMargin units beyond enterRadius,
  // held for rearmDwellTicks (at 30Hz). A big distance alone broke re-entry (you never
  // get 20-40 units clear of a cave mouth before turning back, so walking in again did
  // nothing); a bare dwell alone strobed (idling across the edge re-armed every half
  // second). Small band + dwell does the latch's actual job and nothing more.
  rearmMargin: 5,
  rearmDwellTicks: 15,
  // How long (in 30Hz ticks) you must map outside a dungeon's own inset panel before
  // the app concludes you left it without using the doorway. The doorway rule alone
  // misses a wide exit path; this is the backstop.
  outsideDwellTicks: 20,

  // The overlay always comes up ICONS-ONLY: that's the mode you actually play with,
  // and it shouldn't depend on what you happened to leave it on last time. F9 brings
  // the map. Re-asserted on every F8-on, not just at startup — see index.js.
  // Set false to have it open showing the full map instead.
  openIconsOnly: true,

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
  return {
    ...DEFAULTS,
    ...saved,
    hotkeys: { ...DEFAULTS.hotkeys, ...(saved.hotkeys || {}) },
  };
}

function save(cfg) {
  store.save('overlay', cfg);
}

module.exports = { DEFAULTS, load, save };
