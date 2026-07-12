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

// --- Deriving insetLinear with no calibration at all --------------------------
//
// The insets turn out to share the world map's ROTATION exactly (measured: median
// -0.9 degrees, i.e. zero) and differ from it only by a uniform SCALE. So the shared
// linear part is just the world's, times one number — and that number can be measured
// from mapgenie's own data, without the player doing anything.
//
// How: a dungeon with two entrances gives two correspondences for free. We know both
// doors' positions in game coords (inverting the world affine) and both arrival
// points' positions on the inset. If the inset were drawn at world scale, the inset
// displacement between the arrivals would equal what the world's linear part predicts
// for the displacement between the doors. The ratio of the two IS the scale.
//
// Measured across 28 usable entrance pairs: median 1.97, i.e. the insets are drawn at
// TWICE the world's scale. The spread (sd 0.25) is explained by measurement noise
// rather than dungeons genuinely differing: the doors sit on the surface while the
// arrival points are inside the cave, and that offset is tens of game units in an
// arbitrary direction — which is exactly the error this produces on a 200-unit
// baseline. Median (not mean) so a bad pair can't drag it.
//
// Two rules that matter for correctness:
//  - Pairs must land on the SAME FLOOR PANEL. Different panels have different
//    translations, so a cross-panel displacement measures the gap between the panels,
//    not the scale. (This is why the arrival TITLE is part of the grouping key: it's
//    how we know two arrivals are drawn on the same panel.)
//  - Pairs must have a long enough baseline. The door-vs-arrival offset is a roughly
//    fixed number of game units, so its relative effect blows up as the baseline
//    shrinks — a 30-unit baseline tells you almost nothing.
const MIN_BASELINE = 80;   // game units between the two doors
const MIN_SAMPLES = 5;     // below this, don't pretend we've measured anything

function deriveInsetLinear(meta, worldCal) {
  if (!meta || !Array.isArray(meta.portals)) return null;
  if (!worldCal || typeof worldCal.e !== 'number') return null;
  const det = worldCal.a * worldCal.e - worldCal.b * worldCal.d;
  if (!Number.isFinite(det) || det === 0) return null;

  const invert = (lng, lat) => {
    const dl = lng - worldCal.c - (worldCal.offsetLng || 0);
    const dt = lat - worldCal.f - (worldCal.offsetLat || 0);
    return {
      x: (worldCal.e * dl - worldCal.b * dt) / det,
      y: (-worldCal.d * dl + worldCal.a * dt) / det,
    };
  };

  const overworld = new Set(meta.overworldRegionIds);
  const panels = new Map();
  for (const p of meta.portals) {
    if (!overworld.has(p.fromRegion) || overworld.has(p.toRegion)) continue;
    const g = invert(p.fromLng, p.fromLat);
    const key = `${p.toRegion}|${p.toTitle}`;
    const list = panels.get(key) || [];
    list.push({ x: g.x, y: g.y, toId: p.toId, lng: p.toLng, lat: p.toLat });
    panels.set(key, list);
  }

  const scales = [];
  for (const list of panels.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (A.toId === B.toId) continue;  // both doors come out at the same POI
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        if (Math.hypot(dx, dy) < MIN_BASELINE) continue;
        // What the WORLD's linear part predicts for that displacement...
        const pLng = worldCal.a * dx + worldCal.b * dy;
        const pLat = worldCal.d * dx + worldCal.e * dy;
        // ...versus what the inset actually does.
        const aLng = B.lng - A.lng;
        const aLat = B.lat - A.lat;
        const pred = Math.hypot(pLng, pLat);
        const act = Math.hypot(aLng, aLat);
        if (pred < 1e-9 || act < 1e-5) continue;
        scales.push(act / pred);
      }
    }
  }
  if (scales.length < MIN_SAMPLES) return null;

  scales.sort((x, y) => x - y);
  const k = scales[Math.floor(scales.length / 2)];
  if (!Number.isFinite(k) || k <= 0) return null;

  return {
    a: worldCal.a * k,
    b: worldCal.b * k,
    d: worldCal.d * k,
    e: worldCal.e * k,
    scale: k,            // kept so it can be reported and compared against a manual fit
    samples: scales.length,
    derived: true,       // a hand calibration overrides this and clears the flag
  };
}

// The scale of a linear part relative to the world's, as a single number. Used to
// report a hand-measured inset fit against the derived one.
function scaleOf(linear, worldCal) {
  const d1 = Math.abs(linear.a * linear.e - linear.b * linear.d);
  const d0 = Math.abs(worldCal.a * worldCal.e - worldCal.b * worldCal.d);
  if (!d0) return null;
  return Math.sqrt(d1 / d0);
}

module.exports = {
  load, save, empty, solveTranslation, affineFor, deriveInsetLinear, scaleOf, FILE,
};
