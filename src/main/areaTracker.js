// Which area is the player in — the overworld, or one floor of one dungeon?
//
// mapgenie draws each dungeon as an INSET: a separate, zoomed panel placed off to
// the side of the playable world, but inside the same raster and therefore the same
// lng/lat plane. DD2's caves are seamless world geometry, so the game keeps
// reporting ordinary world coordinates inside one. Left alone, the marker sits out
// at the cave mouth while the cave's POIs sit far away in the inset. Knowing which
// area you're in is what lets the renderer swap to that inset's transform, which
// flies the camera to where the POIs already are.
//
// WHAT WE CANNOT USE: height. Measured in-game, and it was the assumption this was
// originally designed around, so it's worth being explicit about why it's gone:
//   - entering a cave produces NO step change in height — the coordinate is
//     continuous straight through the doorway;
//   - "inside" is not even reliably LOWER. A tower's interior climbs above its own
//     entrance.
// So there is no height band that separates inside from outside, and any z-gate
// would misfire on towers. The only trustworthy signal left is the doorway itself.
//
// WHAT WE USE INSTEAD: mapgenie states every portal's destination outright, by
// location id, in its description (see mapAgent.buildExtractAreas). Inverting the
// world affine puts each overworld entrance at a known point in GAME coordinates.
// Walking within a few units of one means you went through it — and because the
// same doorway is both the way in and the way out, one proximity rule drives both:
//
//   pass close to a doorway  ->  swap to the other side of it
//
// Re-arming only once you're well clear of the doorway is what stops it strobing
// while you stand in it. This does mean brushing past a cave mouth without entering
// will flip the map; that's what the manual override (Insert) is for, and it's why
// the override exists rather than being a fallback.

const DEFAULTS = {
  // Game units. Coming within this of an entrance means you are in the doorway.
  // Deliberately configurable — it also has to absorb the world affine's own fit
  // error, since the doorway positions are derived from it. 15 was too eager: the map
  // flipped visibly before you reached the entrance.
  enterRadius: 10,

  // Re-arming the doorway takes BOTH of these: you must be at least rearmMargin units
  // beyond enterRadius, and stay there for rearmDwellTicks (at 30Hz).
  //
  // It used to be a big distance alone (you had to get 20-40 units clear), and that
  // broke re-entry outright: you don't get that far from a cave mouth before turning
  // round, so walking back into a cave you just left did nothing and needed a forced
  // Insert. Live play showed it at 40 and again at 20.
  //
  // A dwell alone doesn't work either, though — it strobes. Mill around a doorway and
  // you drift in and out across enterRadius; each exit re-arms after half a second and
  // the next step back in fires again. (Simulated at enterRadius 10: 16 flips.)
  //
  // So: a SMALL band plus a dwell. The band means idling around an entrance never
  // counts as having left it; the dwell means a brief clip past the edge doesn't
  // either. Together they're enough to stop the strobe while still re-arming the
  // moment you genuinely step outside — which is all the latch was ever for.
  rearmMargin: 5,
  rearmDwellTicks: 15,

  // Ticks (at 30Hz) the player must map outside the dungeon's inset panel before we
  // conclude they left without using the doorway. ~0.7s.
  outsideDwellTicks: 20,
};

// "Waterfall Cave 1F" -> "1F". mapgenie names the floor in the destination POI's
// title and nowhere else, so this is the only place a floor label comes from.
// Titles without one (single-floor dungeons) get '', which is a valid floor key.
function floorOf(title) {
  const m = /\b(B?\d+F)\b/i.exec(title || '');
  return m ? m[1].toUpperCase() : '';
}

function keyOf(subregionId, floor) {
  return `${subregionId}|${floor}`;
}

function createTracker() {
  let cfg = { ...DEFAULTS };
  let meta = null;          // the extracted mapgenie graph
  let worldCal = null;      // the overworld affine, for placing entrances
  let areas = null;         // the solved inset transforms, for the containment check
  let overworldIds = new Set();
  let outsideTicks = 0;     // consecutive ticks mapped outside the current inset

  let doors = [];           // overworld-side entrances, in GAME coords
  let floorsBySub = new Map();  // subregionId -> ordered floor labels

  let current = null;       // null = overworld; else { key, subregionId, floor, name }
  let armed = true;         // can a doorway fire right now?
  let clearTicks = 0;       // consecutive ticks spent outside enterRadius
  let lastPos = null;
  let lastNear = null;      // nearest doorway + distance, published for the readout

  // Set when a doorway is crossed: the correspondence that calibrates the area we
  // just walked into. The player's position at the doorway IS the destination POI's
  // spot on the inset, so the pair is a free anchor — no clicking required.
  //
  // It is NOT taken at the instant the doorway fires. Firing happens anywhere within
  // enterRadius, so that position can be a full enterRadius off the actual doorway —
  // and at inset scale (the insets are drawn several times larger than the world)
  // that error is magnified into a visible one. Instead the anchor tracks the
  // player's CLOSEST approach to the doorway and is only handed over once they've
  // moved past it, which pins it as tightly as the data allows.
  let pendingAnchor = null;
  let anchorReady = false;
  let anchorTicks = 0;

  // Belt and braces: if you enter and then just STAND in the doorway, "moved past
  // it" never happens and the dungeon would never calibrate. Give up waiting for a
  // better position after ~2s at 30Hz and use the best one seen.
  const ANCHOR_MAX_TICKS = 60;

  function invertWorld(lng, lat) {
    const c = worldCal;
    if (!c || typeof c.e !== 'number') return null;
    const det = c.a * c.e - c.b * c.d;
    if (!Number.isFinite(det) || det === 0) return null;
    const dl = lng - c.c - (c.offsetLng || 0);
    const dt = lat - c.f - (c.offsetLat || 0);
    return {
      x: (c.e * dl - c.b * dt) / det,
      y: (-c.d * dl + c.a * dt) / det,
    };
  }

  // Overworld doorways, placed in game coords. Rebuilt whenever the metadata or the
  // world affine changes — the affine is what puts them there, so a Refine moves
  // every doorway with it.
  function rebuild() {
    doors = [];
    floorsBySub = new Map();
    if (!meta) return;
    overworldIds = new Set(meta.overworldRegionIds);

    // Every floor of every dungeon, so PageUp/PageDown has an ordered list to walk
    // even for floors that have never been visited.
    for (const p of meta.portals) {
      if (overworldIds.has(p.toRegion)) continue;
      const floors = floorsBySub.get(p.toRegion) || [];
      const f = floorOf(p.toTitle);
      if (!floors.includes(f)) floors.push(f);
      floorsBySub.set(p.toRegion, floors);
    }
    for (const floors of floorsBySub.values()) floors.sort();

    if (!worldCal) return;
    for (const p of meta.portals) {
      if (!overworldIds.has(p.fromRegion)) continue;  // not an overworld doorway
      if (overworldIds.has(p.toRegion)) continue;     // overworld -> overworld
      const g = invertWorld(p.fromLng, p.fromLat);
      if (!g) continue;
      const sub = meta.subregions[p.toRegion];
      doors.push({
        x: g.x,
        y: g.y,
        subregionId: p.toRegion,
        floor: floorOf(p.toTitle),
        name: (sub && sub.title) || String(p.toRegion),
        // Where this doorway lands you on the inset — the other half of the anchor.
        toLng: p.toLng,
        toLat: p.toLat,
      });
    }
  }

  function nearestDoor(pos) {
    let best = null;
    let bestDist = Infinity;
    for (const d of doors) {
      const dist = Math.hypot(pos.x - d.x, pos.y - d.y);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    return best ? { door: best, dist: bestDist } : null;
  }

  function enter(door, pos, dist) {
    current = {
      key: keyOf(door.subregionId, door.floor),
      subregionId: door.subregionId,
      floor: door.floor,
      name: door.name,
    };
    // The free anchor: we are at the doorway, and the doorway's inset counterpart is
    // exactly where mapgenie says this portal comes out. Seeded here, then sharpened
    // as we get closer (see refineAnchor).
    pendingAnchor = {
      areaKey: current.key,
      subregionId: door.subregionId,
      floor: door.floor,
      name: door.name,
      gameX: pos.x,
      gameY: pos.y,
      lng: door.toLng,
      lat: door.toLat,
      dist,
    };
    anchorReady = false;
    anchorTicks = 0;
  }

  // Keep the anchor at the player's closest approach to the doorway, and hand it
  // over once they've moved past it (or stood there long enough that they clearly
  // aren't going to get any closer).
  function refineAnchor(dist, pos) {
    if (!pendingAnchor || anchorReady) return;
    anchorTicks += 1;
    if (dist < pendingAnchor.dist) {
      pendingAnchor.dist = dist;
      pendingAnchor.gameX = pos.x;
      pendingAnchor.gameY = pos.y;
    }
    if (dist > cfg.enterRadius || anchorTicks >= ANCHOR_MAX_TICKS) anchorReady = true;
  }

  // Why an area change happened. The two rules fail in opposite ways — the doorway
  // can fire when you merely brush past a cave mouth, and the containment backstop
  // can eject you from a cave you're standing in if the inset scale is off enough to
  // map you outside the panel. Those need completely different fixes, so the log has
  // to say which one it was.
  let lastReason = null;

  function leave(reason) {
    current = null;
    outsideTicks = 0;
    lastReason = reason;
  }

  // Have we left the dungeon WITHOUT going back through its doorway?
  //
  // The doorway rule alone is too brittle to be the only way out. It needs the
  // player to pass within enterRadius of a point we DERIVED from the world affine,
  // so it inherits that affine's error, and a slightly wide exit path simply misses
  // it — leaving the map stuck in the inset while you stand in daylight. (Measured:
  // an exit path passing 13 units from the doorway never fires.)
  //
  // So check containment as well. Run the player through the current area's
  // transform and see whether they land inside the inset panel that mapgenie drew
  // for this dungeon. This is a strong signal precisely because the insets are drawn
  // several times larger than the world: once you're actually outside the cave, the
  // magnification throws you far outside the panel, not marginally.
  //
  // Needs the dungeon to be calibrated, so it can't be the only rule either — an
  // uncalibrated dungeon still relies on the doorway. The two cover each other.
  function outsideInset(pos) {
    if (!current || !areas || !areas.insetLinear || !meta) return false;
    const area = areas.areas && areas.areas[current.key];
    if (!area || typeof area.c !== 'number') return false;
    const sub = meta.subregions[current.subregionId];
    if (!sub || !sub.bbox) return false;

    const lin = areas.insetLinear;
    const lng = lin.a * pos.x + lin.b * pos.y + area.c;
    const lat = lin.d * pos.x + lin.e * pos.y + area.f;

    const [x0, y0, x1, y1] = sub.bbox;
    // The panel already contains the whole dungeon by construction — mapgenie drew it
    // to fit — so anywhere inside the cave maps inside the bbox and the margin only
    // needs to absorb anchor error and the panel's own padding. Keep it small: it
    // sets how far past the exit you walk before the map lets go, and a large margin
    // (0.5 of the panel) meant ~270 game units of standing in daylight looking at a
    // cave map.
    const mx = (x1 - x0) * 0.15;
    const my = (y1 - y0) * 0.15;
    return lng < x0 - mx || lng > x1 + mx || lat < y0 - my || lat > y1 + my;
  }

  return {
    setConfig(next) {
      cfg = { ...DEFAULTS, ...(next || {}) };
    },
    setMetadata(next) {
      meta = next;
      rebuild();
    },
    setWorldCalibration(next) {
      worldCal = next;
      rebuild();  // the doorways' game coords are derived from this affine
    },
    // The solved inset transforms. Only used for the containment backstop above —
    // the tracker never writes them.
    setAreas(next) {
      areas = next;
    },

    // Called every poll tick. Returns the active area (null = overworld).
    tick(pos) {
      lastPos = pos;
      if (!doors.length) return current;

      const near = nearestDoor(pos);
      if (!near) return current;
      lastNear = { name: near.door.name, dist: near.dist };

      // Re-arm: a small band beyond the radius, held for a moment. Neither half works
      // alone — a big distance breaks re-entry, a bare dwell strobes when you idle
      // across the edge. See DEFAULTS.
      if (near.dist > cfg.enterRadius + cfg.rearmMargin) {
        clearTicks += 1;
        if (clearTicks >= cfg.rearmDwellTicks) armed = true;
      } else {
        clearTicks = 0;
      }

      if (armed && near.dist <= cfg.enterRadius) {
        armed = false;
        // The same doorway both ways: if we're already inside the dungeon this door
        // belongs to, we're on our way out; otherwise we're on our way in.
        if (current && current.subregionId === near.door.subregionId) {
          leave(`through the doorway (${near.dist.toFixed(1)}u from it)`);
        } else {
          enter(near.door, pos, near.dist);
          lastReason = `through the doorway (${near.dist.toFixed(1)}u from it)`;
        }
        return current;
      }

      refineAnchor(near.dist, pos);

      // Backstop for an exit that missed the doorway: if we're mapping well outside
      // the dungeon's own inset panel, we are plainly not in it any more. Dwelled, so
      // a moment of bad geometry can't kick us out of a cave we're standing in.
      if (current) {
        outsideTicks = outsideInset(pos) ? outsideTicks + 1 : 0;
        if (outsideTicks >= cfg.outsideDwellTicks) {
          // If this fires while you are genuinely still in the cave, the inset scale
          // is wrong — it is mapping you off the edge of the panel. Say so loudly:
          // the fix is a 3-point measurement, not a tweak to this rule.
          leave(`MAPPED OUTSIDE the inset panel (${near.dist.toFixed(0)}u from the doorway) ` +
                '— if you were still inside, the inset scale is off; measure it with the 3-point flow');
        }
      }
      return current;
    },

    // --- Manual overrides ----------------------------------------------------
    // Auto-detection has two failure modes the player can see and the app cannot:
    // brushing past a cave mouth without going in, and dropping through a hole to
    // the floor below without ever touching a portal. Rather than pretend those
    // away, hand over the controls.

    // Insert: force in/out. In the overworld this enters the nearest dungeon
    // regardless of distance, so it also works as "I'm in here, the app missed it".
    toggle() {
      if (current) { leave('Insert'); armed = false; return current; }
      if (!lastPos) return current;
      const near = nearestDoor(lastPos);
      if (!near) return current;
      enter(near.door, lastPos, near.dist);
      lastReason = `Insert (nearest doorway ${near.dist.toFixed(0)}u away)`;
      armed = false;
      return current;
    },

    // PageUp / PageDown: step a floor. No anchor comes with this — you asked for it,
    // so we trust it — which means an unvisited floor lands uncalibrated and says so
    // rather than guessing where you are.
    stepFloor(delta) {
      if (!current) return current;
      const floors = floorsBySub.get(current.subregionId) || [];
      const i = floors.indexOf(current.floor);
      if (i < 0) return current;
      const next = floors[i + delta];
      if (next === undefined) return current;  // already at the top/bottom floor
      current = { ...current, floor: next, key: keyOf(current.subregionId, next) };
      return current;
    },

    // Drains the anchor from the last crossing — but only once it has settled on the
    // player's closest approach to the doorway (see refineAnchor). Returns null
    // while it's still sharpening.
    takeAnchor() {
      if (!pendingAnchor || !anchorReady) return null;
      const a = pendingAnchor;
      pendingAnchor = null;
      anchorReady = false;
      return a;
    },

    current: () => current,
    // Why the area last changed. The two auto rules fail in opposite ways and need
    // opposite fixes, so this is not decoration — it's how you tell a doorway
    // misfire from the inset scale being wrong.
    reason: () => lastReason,
    // Nearest doorway and how far off it is, in game units. Published on the
    // position feed purely so the control window can show it: it's what tells you
    // whether enterRadius is set sensibly, and the doorways inherit the world
    // affine's fit error, so that number is worth being able to see.
    near: () => lastNear,
    floorsOf: (subregionId) => floorsBySub.get(subregionId) || [],
    doorCount: () => doors.length,
  };
}

module.exports = { createTracker, floorOf, keyOf, DEFAULTS };
