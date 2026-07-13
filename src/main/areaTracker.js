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
// TWO QUESTIONS, TWO DIFFERENT ANSWERS:
//
// 1. AM I INSIDE? — the game tells us, so we don't guess. A module-static int (no
//    pointer chain; same kind of read as the local-position mirror), found by CE
//    value-scanning, 2026-07-13:
//
//      DD2.exe+FA62CAC  insideFlag  0 = overworld, 1 and 2 = inside a dungeon
//
//    (1 and 2 are both "inside" — observed. What distinguishes them isn't known yet;
//    some second kind of interior. Since both mean inside, nothing here needs to
//    care, and tools/zoneLog.js is collecting the data to find out.)
//
//    This replaced a doorway-proximity guess — "you're within N units of a portal
//    position we derived by inverting the world affine, so you must have crossed
//    it". That guess inherited the world affine's fit error, needed a radius plus a
//    re-arm band plus a dwell to stop it strobing in a doorway, and could never see
//    the two dungeons that have no portal entrance in mapgenie's data at all.
//
// 2. WHICH DUNGEON? — the NEAREST KNOWN ENTRANCE, from mapgenie's portal graph.
//    There is a second static int next to the flag:
//
//      DD2.exe+FA62CB0  zoneIndex   the game's own dungeon id
//
//    ...but it is the GAME's numbering, not mapgenie's, and the two do not coincide:
//    mapgenie's subregion ids run 2441-2514, while an observed zoneIndex was 18. A
//    mapping between them would have to be BUILT, dungeon by dungeon, and until it
//    exists zoneIndex cannot name a dungeon. So the flag says when to jump, and the
//    nearest entrance says where to jump to. (See tools/zoneLog.js — it logs
//    zoneIndex against the nearest entrance's name on every transition, which is
//    exactly the table needed. Once it's complete, "which dungeon" becomes a lookup
//    and stops depending on the world affine at all.)
//
// WHAT WE STILL CANNOT USE: height, to tell inside from outside. Entering a cave
// produces no step change in it, and "inside" isn't even reliably lower — a tower's
// interior climbs above its own entrance.
//
// 3. WHICH FLOOR? — nothing in memory says. The flag holds the same value across a
//    dungeon's floors, and so does zoneIndex. But there IS a third int in the struct:
//
//      DD2.exe+FA62C94  roomHash   -1 in the overworld; inside, a stable id for the
//                                  room/section you're standing in
//
//    It is NOT a floor: it changes far more often (8 distinct rooms in a single walk
//    through Forgotten Tunnel). Treating a room change as a floor change would be
//    wrong most of the time. But it IS deterministic — the same physical room gives
//    the same hash across visits and across sessions (verified: walking a cave one way
//    and back gave the identical five hashes in reverse order).
//
//    So it is used as a LEARNED KEY, not as a signal. The floor is set by hand
//    (PageUp/PageDown), and when you do, the room you were standing in is recorded
//    against that floor in `areas.rooms`. Walk into that room again — this session or
//    any future one — and the floor is set exactly, from the table, with no geometry
//    and no guessing. Each room needs correcting at most once, ever.
//
//    Nothing is ever inferred from an unknown room: if we don't know where a room is,
//    we hold the current floor rather than guess at one.

// "Waterfall Cave 1F" -> "1F". mapgenie names the floor in the destination POI's
// title and nowhere else, so this is the only place a floor label comes from.
// Titles without one (single-floor dungeons) get '', which is a valid floor key.
function floorOf(title) {
  const m = /\b(B?\d+F)\b/i.exec(title || '');
  return m ? m[1].toUpperCase() : '';
}

// Floors have to be ordered by ELEVATION, not alphabetically — the B ("basement")
// prefix means below ground, so B1F sits UNDER 1F. Sorting the labels as strings gives
// ['1F', 'B1F'], and then PageUp from B1F walks off the end of the list and silently
// does nothing. (Which is exactly what it did; a simulation against the real Forgotten
// Tunnel data caught it.)
function floorRank(floor) {
  const m = /^(B?)(\d+)F$/i.exec(floor || '');
  if (!m) return 0;                                     // '' — a single-floor dungeon
  const n = parseInt(m[2], 10);
  return m[1] ? -n : n;                                 // B1F -> -1, 1F -> +1, 2F -> +2
}

function keyOf(subregionId, floor) {
  return `${subregionId}|${floor}`;
}

function createTracker() {
  let meta = null;          // the extracted mapgenie graph
  let worldCal = null;      // the overworld affine, for placing entrances in game coords
  let heights = {};         // areaKey -> { h, n } : where each floor SITS (from areas.json)

  let doors = [];               // every known overworld-side entrance, in GAME coords
  let floorsBySub = new Map();  // subregionId -> ordered floor labels, for PageUp/PageDown

  let current = null;       // null = overworld; else { key, subregionId, floor, name }
  let lastPos = null;
  let lastNear = null;      // nearest known doorway + distance, for the readout

  // The insideFlag `current` was last derived from. Tracked separately from `current`
  // itself so a manual override (Insert / PageUp / PageDown) sticks: it isn't
  // overwritten every tick just because the raw flag is unchanged from the value that
  // produced it. Treated as a boolean — 1 and 2 both mean inside.
  let syncedInside = null;

  // Set on entry: the correspondence that calibrates the dungeon we just walked into.
  // The player's position at the moment the game says "you're inside" IS (near enough)
  // the entrance POI's spot on the inset, so the pair is a free anchor — no clicking.
  let pendingAnchor = null;

  // Set when a floor change may also have supplied a free anchor for a floor that has
  // none of its own (see stepFloor). Resolved by main, which holds the transforms.
  let pendingFloorAnchor = null;

  // --- Floors, by height -------------------------------------------------------
  //
  // THE ROOM HASH DOES NOT WORK, and it can't be made to. It is not a floor id: the same
  // hash appears at h=-13.7 AND h=-5.2 in The Gracious Hand's Vaults, and two of them
  // flicker back and forth three times a second while you stand still. It's a spatial
  // cell that spans floors vertically. Recording it against a floor taught the table
  // contradictions, which then fought the player. That whole mechanism is gone.
  //
  // Height is the ONLY signal that can separate floors, and this is not a preference —
  // the game reports the SAME (x, y) on every floor of a dungeon. Floors differ in z and
  // in nothing else, so no x/y signal, however clever, carries the information at all.
  //
  // ABSOLUTE height, not height CHANGE. Measured floor gaps run 5.8u (The Gracious Hand's
  // Vaults) to 16.6u (Forgotten Tunnel), while the height wanders up to 4u WITHIN one
  // floor. A change threshold would have to be below 5.8 and above 4 — a 1.8u window, and
  // wrong in the next dungeon anyway. (A 12u threshold, picked from Forgotten Tunnel, is
  // exactly what silently broke the last attempt.) So instead: stand on a floor, press the
  // key, and the height that floor SITS at is recorded for this dungeon. After that your
  // height picks the nearest floor, and no threshold is needed anywhere.
  //
  // The sample is taken once your height has SETTLED, not the instant you press the key —
  // you press it on the stairs, and the stairs are between floors, which is the one height
  // that belongs to neither.
  const SETTLE_TICKS = 30;        // ~1s of height held steady before we believe it
  const SETTLE_SPREAD = 1.5;      // game units: how flat "steady" has to be
  const SWITCH_MARGIN = 1.5;      // a rival floor must beat the current one by this much
  let heightWin = [];             // recent heights, for the settle test
  let sampling = null;            // areaKey we're waiting to take a settled height for

  let pendingHeight = null;       // { areaKey, h } — drained by main, which owns the file

  // Why the area last changed. Surfaced so the log can say WHY, not just what.
  let lastReason = null;

  // Where does floor `key` sit? null if it's never been taught.
  const floorHeight = (key) => (heights[key] && Number.isFinite(heights[key].h) ? heights[key].h : null);

  // Record (or refine) the height of a floor. Averaged, so a second visit sharpens it
  // rather than replacing it on the strength of one reading.
  function learnHeight(areaKey, h) {
    const prev = heights[areaKey];
    const n = prev ? prev.n : 0;
    const next = prev ? (prev.h * n + h) / (n + 1) : h;
    heights[areaKey] = { h: next, n: n + 1 };
    pendingHeight = { areaKey, h: next, n: n + 1, sample: h };
  }

  // Which floor of THIS dungeon does height h sit closest to? Only floors we've been
  // taught can be chosen; an untaught floor is never guessed at.
  function floorByHeight(subregionId, h) {
    let best = null;
    let bestD = Infinity;
    for (const floor of floorsBySub.get(subregionId) || []) {
      const key = keyOf(subregionId, floor);
      const fh = floorHeight(key);
      if (fh === null) continue;
      const d = Math.abs(h - fh);
      if (d < bestD) { bestD = d; best = { key, floor, dist: d }; }
    }
    return best;
  }

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

  // The known overworld entrances, placed in game coords. Rebuilt whenever the
  // metadata or the world affine changes — the affine is what puts them there, so a
  // Refine moves every one of them.
  //
  // These no longer DETECT anything (the game's flag does that). They answer "which
  // dungeon did I just walk into", which is a different and much more forgiving job:
  // the nearest entrance only has to be nearer than the next-nearest, so the affine's
  // fit error would have to be enormous to pick the wrong cave.
  function rebuild() {
    doors = [];
    floorsBySub = new Map();
    if (!meta) return;
    const overworldIds = new Set(meta.overworldRegionIds);

    // Every floor of every dungeon, so PageUp/PageDown has an ordered list to walk
    // even for floors that have never been visited.
    for (const p of meta.portals) {
      if (overworldIds.has(p.toRegion)) continue;
      const floors = floorsBySub.get(p.toRegion) || [];
      const f = floorOf(p.toTitle);
      if (!floors.includes(f)) floors.push(f);
      floorsBySub.set(p.toRegion, floors);
    }
    for (const [sub, floors] of floorsBySub) {
      // Some of mapgenie's POI titles just don't carry a floor label (The Gracious
      // Hand's Vaults has three such portals alongside its B1F/1F/2F ones), and '' ranks
      // between B1F and 1F — so it lands in the middle of the list as a PHANTOM FLOOR
      // with no inset panel behind it. PageDown from 1F stepped onto it, the marker had
      // nowhere to go, and you had to press the key twice to get to B1F.
      //
      // '' is only a real floor when it is the ONLY one (a single-level dungeon, where
      // it's the natural key). Alongside labelled floors it is noise.
      const named = floors.filter((f) => f !== '');
      const ordered = (named.length ? named : floors).sort((x, y) => floorRank(x) - floorRank(y));
      floorsBySub.set(sub, ordered);
    }

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

  // The game says we're inside. Which dungeon? Whichever entrance we're standing
  // closest to. Hands over the free calibration anchor at the same time, since the
  // entrance we matched is also the one whose inset arrival point we know.
  function enterNearest(pos, reason) {
    const near = nearestDoor(pos);
    if (!near) return;   // no portal graph yet — stay in the overworld rather than guess
    const d = near.door;
    current = {
      key: keyOf(d.subregionId, d.floor),
      subregionId: d.subregionId,
      floor: d.floor,
      name: d.name,
    };
    pendingAnchor = {
      areaKey: current.key,
      subregionId: d.subregionId,
      floor: d.floor,
      name: d.name,
      gameX: pos.x,
      gameY: pos.y,
      lng: d.toLng,
      lat: d.toLat,
      dist: near.dist,
    };
    // The distance is worth saying out loud: it is how far the entrance we CHOSE was
    // from where you actually stood when the game said you were inside. Small is
    // reassuring. Large means either you entered a dungeon with no entrance in
    // mapgenie's data (there are two), or the world affine has drifted — and those
    // need different fixes.
    lastReason = `${reason} — nearest entrance "${d.name}" ${near.dist.toFixed(1)}u away`;
  }

  return {
    setMetadata(next) {
      meta = next;
      rebuild();
    },
    setWorldCalibration(next) {
      worldCal = next;
      rebuild();  // the entrances' game coords are derived from this affine
    },
    // Where each floor sits, in game units. From areas.json.
    setHeights(next) {
      heights = next || {};
    },

    // Called every poll tick with { x, y, height, insideFlag, zoneIndex, roomHash }.
    // Returns the active area (null = overworld).
    tick(pos) {
      lastPos = pos;
      const near = nearestDoor(pos);
      if (near) lastNear = { name: near.door.name, dist: near.dist };

      // 0 = overworld; anything else (1 or 2 observed) = inside. Both non-zero values
      // mean inside, so the only edge that matters is zero <-> non-zero.
      const inside = pos.insideFlag !== 0;
      if (inside !== syncedInside) {
        syncedInside = inside;
        heightWin = [];
        if (inside) {
          enterNearest(pos, `the game says you're inside (flag ${pos.insideFlag})`);
          // The entrance NAMES the floor it leads to, so this is an assertion as good as
          // you pressing the key — start measuring where that floor sits.
          sampling = current ? current.key : null;
        } else {
          current = null;
          sampling = null;
          lastReason = 'the game says you\'re in the overworld (flag 0)';
        }
        return current;
      }

      if (!current) return current;

      // Has the height SETTLED? Stairs and ramps are between floors, and a height taken
      // mid-climb belongs to no floor at all — so we only believe a height once it's been
      // flat for about a second.
      heightWin.push(pos.height);
      if (heightWin.length > SETTLE_TICKS) heightWin.shift();
      const settled = heightWin.length === SETTLE_TICKS
        && Math.max(...heightWin) - Math.min(...heightWin) <= SETTLE_SPREAD;

      // Someone asserted a floor and we've now stopped moving vertically: THIS is where
      // that floor sits. Recorded once per assertion.
      if (settled && sampling) {
        const h = heightWin.reduce((s, v) => s + v, 0) / heightWin.length;
        learnHeight(sampling, h);
        sampling = null;
        return current;
      }

      // Otherwise: let the height pick the floor. Only floors you've stood on and named
      // can be chosen — an untaught floor is never guessed at — and a rival has to beat
      // the floor we're showing by a clear margin, so walking a ramp can't make the map
      // flicker between two panels.
      if (!settled) return current;
      const best = floorByHeight(current.subregionId, pos.height);
      if (!best || best.key === current.key) return current;
      const cur = floorHeight(current.key);
      if (cur !== null && best.dist + SWITCH_MARGIN >= Math.abs(pos.height - cur)) return current;

      const from = current.floor;
      current = { ...current, floor: best.floor, key: best.key };
      lastReason = `height ${pos.height.toFixed(1)} is ${best.dist.toFixed(1)}u from ${best.floor} `
        + `(which sits at ${floorHeight(best.key).toFixed(1)})`;
      // The floor may never have been placed — an upper floor has no entrance of its own.
      // You just came off the stair, so offer the crossing as its anchor. Main ignores
      // this if the floor already has a transform.
      pendingFloorAnchor = {
        subregionId: current.subregionId,
        name: current.name,
        fromFloor: from,
        toFloor: best.floor,
        areaKey: current.key,
        gameX: pos.x,
        gameY: pos.y,
      };
      return current;
    },

    // --- Manual overrides ----------------------------------------------------
    // In/out comes from the game now, so Insert should rarely be needed for that. Two
    // things are still invisible to everything automatic, and this is what they're
    // for: a FLOOR change that doesn't cross a portal (dropping through a hole — the
    // flag doesn't change between floors), and the two dungeons with no entrance in
    // mapgenie's data at all, where "nearest entrance" has nothing right to pick.
    //
    // Setting the area by hand also syncs the flag state to the CURRENT reading, so
    // the next tick's automatic path sees no edge and doesn't immediately fight it.

    toggle() {
      if (!lastPos) return current;
      if (current) {
        current = null;
        sampling = null;
        lastReason = 'Insert';
      } else {
        enterNearest(lastPos, 'Insert');
        sampling = current ? current.key : null;
      }
      syncedInside = lastPos.insideFlag !== 0;
      heightWin = [];
      return current;
    },

    // PageUp / PageDown: step a floor. It is not just an override — it is the ONLY input
    // that ever teaches the app where a floor sits. But it does not record your height at
    // the instant you press it: you press it on the stairs, and the stairs are between
    // floors, which is the one height that belongs to neither. The height is taken once
    // it has SETTLED (see tick), i.e. once you're standing on the floor you meant.
    stepFloor(delta) {
      if (!current) return current;
      const floors = floorsBySub.get(current.subregionId) || [];
      const i = floors.indexOf(current.floor);
      if (i < 0) return current;
      const next = floors[i + delta];
      if (next === undefined) return current;  // already at the top/bottom floor
      const from = current.floor;
      current = { ...current, floor: next, key: keyOf(current.subregionId, next) };
      lastReason = `${delta > 0 ? 'PageUp' : 'PageDown'} — you said ${next}`;
      sampling = current.key;   // measure where this floor sits, once you've settled on it
      heightWin = [];

      // A floor reached only by STAIRS has no entrance, so no free anchor ever lands on
      // it — it would stay uncalibrated forever, the marker would simply vanish there,
      // and Refine couldn't rescue it (Refine shifts an existing transform; there'd be
      // nothing to shift). Dead floors.
      //
      // But you have just ASSERTED the floor change by pressing the key, which means you
      // are standing at the top or bottom of the stair you took — and mapgenie knows
      // where that stair comes out on the destination panel (203 internal portal edges).
      // So the crossing you just made is a free correspondence, exactly like walking in
      // through the front door. Main resolves it (it owns areas.json and the transforms).
      if (lastPos) {
        pendingFloorAnchor = {
          subregionId: current.subregionId,
          name: current.name,
          fromFloor: from,
          toFloor: next,
          areaKey: current.key,
          gameX: lastPos.x,
          gameY: lastPos.y,
        };
      }
      return current;
    },

    // Drains the anchor from the last entry, if there was an entrance to anchor on.
    takeAnchor() {
      if (!pendingAnchor) return null;
      const a = pendingAnchor;
      pendingAnchor = null;
      return a;
    },

    // Drains a newly measured floor height, so main can persist it. Main owns areas.json;
    // the tracker never writes it.
    takeHeight() {
      if (!pendingHeight) return null;
      const h = pendingHeight;
      pendingHeight = null;
      return h;
    },

    // Drains the stair crossing from the last floor change, so main can use it to place a
    // floor that has no entrance of its own.
    takeFloorAnchor() {
      if (!pendingFloorAnchor) return null;
      const a = pendingFloorAnchor;
      pendingFloorAnchor = null;
      return a;
    },

    current: () => current,
    reason: () => lastReason,
    // Nearest known entrance and how far off it is, in game units. Published on the
    // position feed for the control window's readout.
    near: () => lastNear,
    floorsOf: (subregionId) => floorsBySub.get(subregionId) || [],
    doorCount: () => doors.length,
  };
}

module.exports = { createTracker, floorOf, floorRank, keyOf };
