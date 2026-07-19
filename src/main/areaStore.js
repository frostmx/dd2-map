// Two small stores, kept apart on purpose (see CLAUDE.md "one writer per domain"):
//
//  - config/dungeons.json  — the AUTHORED dungeon transforms: the shared `insetLinear`
//    plus one `{ c, f, scale? }` per area key. The app only ever READS this; it is written
//    by the RE tooling (.map) and by hand. Making it read-only is what stopped the app from
//    silently clobbering tuned transforms on every restart (see FINDINGS).
//
//  - config/areas.json     — runtime state the app DOES own, now just `places`: buildings
//    you've named with Home. Not a transform and moves no marker — DD2 reports true world
//    coords indoors, so you're already drawn in the right building; only the NAME was
//    missing, and one key press at the door supplies it.
//
// THE SHARED LINEAR PART. Every inset is drawn at the same rotation and (nearly) the same
// scale, so all of them share one 2x2 linear part and differ only by translation:
//
//     lng = A*gx + B*gy + c        <- A, B, D, E are insetLinear (in dungeons.json)
//     lat = D*gx + E*gy + f        <- c, f are per-area; a few carry a `scale` multiplier

const store = require('./configStore');

const FILE = 'areas';         // runtime: { places }
const DUNGEONS = 'dungeons';  // authored, read-only: { insetLinear, areas }

function empty() {
  return { insetLinear: null, areas: {}, places: {} };
}

// areas.json — only `places` lives here now.
function load() {
  const saved = store.load(FILE);
  return { places: (saved && saved.places) || {} };
}

// Persist `places` only. Called by Home; never writes dungeon transforms or insetLinear.
function save(state) {
  store.save(FILE, { places: (state && state.places) || {} });
}

// The authored dungeon transforms + shared linear. READ-ONLY: nothing here writes it back.
function loadDungeons() {
  const d = store.load(DUNGEONS);
  return {
    insetLinear: (d && d.insetLinear) || null,
    areas: (d && d.areas) || {},
  };
}

module.exports = { load, save, empty, loadDungeons, FILE };
