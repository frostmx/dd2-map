// The per-dungeon transforms: config/areas.json.
//
// Deliberately NOT part of calibration.json. Main writes this file (it solves an
// area the moment you walk into it), while the renderer writes calibration.json (the
// world affine, and Refine). One file with two writers would let a Refine clobber
// every dungeon you'd calibrated, or vice versa. Two files, one writer each.
//
// THE SHARED LINEAR PART. Every inset is drawn at the same scale and rotation, so
// all of them share one 2x2 linear part and differ only by translation:
//
//     lng = A*gx + B*gy + c        <- A, B, D, E are insetLinear: solved ONCE
//     lat = D*gx + E*gy + f        <- c, f are per-area: one point each
//
// That is what collapses per-dungeon calibration to a single correspondence — and a
// crossing hands us one for free, so a dungeon calibrates itself the first time you
// walk in. insetLinear itself is seeded once, by running the ordinary 3-point flow
// inside any one dungeon.

const store = require('./configStore');

const FILE = 'areas';

function empty() {
  return { insetLinear: null, areas: {} };
}

function load() {
  const saved = store.load(FILE);
  if (!saved) return empty();
  return {
    insetLinear: saved.insetLinear || null,
    areas: saved.areas || {},
  };
}

function save(state) {
  store.save(FILE, state);
}

// Given the shared linear part, one correspondence pins the translation. This is the
// whole of per-dungeon calibration.
function solveTranslation(linear, point) {
  return {
    c: point.lng - (linear.a * point.gameX + linear.b * point.gameY),
    f: point.lat - (linear.d * point.gameX + linear.e * point.gameY),
  };
}

// The effective affine for an area: shared linear part + that area's translation.
function affineFor(state, areaKey) {
  const area = state.areas[areaKey];
  const lin = state.insetLinear;
  if (!area || !lin || typeof area.c !== 'number') return null;
  return { a: lin.a, b: lin.b, c: area.c, d: lin.d, e: lin.e, f: area.f };
}

module.exports = { load, save, empty, solveTranslation, affineFor, FILE };
