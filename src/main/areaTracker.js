// @deprecated for dungeon identification. The primary source is now localAreaReader.js,
// which reads the game's own current-area record (LocalArea id) from a static pointer
// chain — exact area+floor in one read, no guessing. This tracker is KEPT and still runs:
// (1) as the fallback when the pointer can't be read or verified, and (2) always in the
// OVERWORLD, where it supplies the nearest-dungeon hint/offer. Its Insert and Home paths
// are superseded by the shipped LocalArea table (config/localAreas.json) and are retained
// only for that fallback. FLOOR is no longer decided here at all — the pointer's LocalArea
// is unique per (area, floor); the old height-learning path was removed (see FINDINGS,
// "Height-based floor mechanic retired"). See index.js position loop and .map/README.md.
//
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
//
//    ...but only if it is actually NEAR. The flag says "inside", not "inside a
//    DUNGEON": every house, shop and barracks in Vernworth sets it too, and mapgenie
//    has no entrance for any of them. Left unbounded, "nearest entrance" then answers
//    a question that has no answer, and it answers it confidently — a real case:
//
//      auto-calibrated "Ancestral Chamber" from the crossing (219.4u from the
//      nearest known doorway)
//
//    You were in a building. 219u away is not a doorway you just walked through, and
//    the anchor it hands over is 219u of pure error — which then gets SAVED as that
//    dungeon's transform, so the dungeon is wrong ever after, on a visit you never
//    made. A crossing anchor is only worth anything if you are standing IN the
//    doorway, so entry is capped at `enterRadius` (game units) and everything beyond
//    it is treated as "inside something we don't know" — the marker stays on the
//    overworld (your world coords are still right in there) and the UI offers the
//    nearest dungeon for you to confirm with Insert, which is the one thing that
//    genuinely can't be wrong: you pressed it.
//
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
// 3. WHICH FLOOR? — not decided here any more. The LocalArea pointer (localAreaReader.js)
//    is unique per (area, floor), so index.js reads the floor directly from it. When this
//    tracker runs as the fallback it simply adopts the floor label of the entrance you
//    crossed and holds it — it no longer tries to separate floors itself. The earlier
//    approaches are both gone: roomHash is not a floor (it spans floors vertically), and
//    the height-learning that replaced it rebased per streaming-cell and misfired (a floor
//    read "104u off itself" across a cell boundary). See FINDINGS, "Height-based floor
//    mechanic retired".

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
  let meta = null;          // the extracted mapgenie graph
  let worldCal = null;      // the overworld affine, for placing entrances in game coords

  let doors = [];               // every known overworld-side entrance, in GAME coords

  // --- Named places (buildings) -------------------------------------------------
  //
  // Most interiors in this game are NOT dungeons. The flag fires for every house, shop
  // and inn, and mapgenie draws no inset for any of them, so there is nothing to place
  // the marker ON — but the building itself IS on the world map, as an ordinary POI in
  // the "Locations" or "Facilities" group ("Kough's Inn", category Inn). That can't move
  // the marker (it doesn't need to: DD2 reports true world coords indoors, so you're
  // already drawn in the right building), but it can NAME where you are, which is the
  // only thing that was missing.
  //
  // It has to be taught, once per building, because nothing in memory links the interior
  // you're standing in to a POI on the map — only your position does, and only at the
  // moment you walk in. Home binds the two, and from then on that doorway is recognised.
  let pois = [];                // every place POI, in GAME coords (from meta.pois)
  let places = {};              // poiId -> a building you've taught us, from areas.json
  let placeRadius = 40;         // how big a building is, near enough (game units)
  let currentPlace = null;      // the taught building we're standing in, or null
  let pendingPlace = null;      // a Home press for main to persist (it owns areas.json)

  // How close to a known doorway you have to be, when the game says "inside", for the
  // nearest one to be believed. Beyond it we don't know where we are and say so (see
  // the header). Overridable from config/overlay.json — it trades a missed dungeon
  // against a wrongly-placed one, and only playing can settle where that sits.
  let enterRadius = 20;

  let current = null;       // null = overworld; else { key, subregionId, floor, name }
  let lastPos = null;
  let lastNear = null;      // nearest known doorway + distance, for the readout

  // What we'd suggest the player do, if we're unsure. Structured, not a sentence —
  // main formats it, because main is what knows the hotkey names.
  let hint = null;
  // Set when you Insert your way OUT of an area while the game still says "inside":
  // you have just told us you don't want one, so we must not immediately turn round
  // and offer one again. Cleared on the next real in/out edge.
  let dismissed = false;

  // The insideFlag `current` was last derived from. Tracked separately from `current`
  // itself so a manual override (Insert / PageUp / PageDown) sticks: it isn't
  // overwritten every tick just because the raw flag is unchanged from the value that
  // produced it. Treated as a boolean — 1 and 2 both mean inside.
  let syncedInside = null;

  // Why the area last changed. Surfaced so the log can say WHY, not just what.
  let lastReason = null;

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
    pois = [];
    if (!meta) return;
    const overworldIds = new Set(meta.overworldRegionIds);

    if (!worldCal) return;

    // The named places, in game coords. Same inversion as the doorways, and just as
    // dependent on the world affine — a Refine moves all of them.
    for (const p of meta.pois || []) {
      const g = invertWorld(p.lng, p.lat);
      if (!g) continue;
      pois.push({ id: p.id, title: p.title, category: p.category, x: g.x, y: g.y });
    }

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

  // The nearest named place — the inn/shop/settlement you're most likely standing in.
  // Reported at any distance: it is only ever OFFERED, never acted on, and the distance
  // is shown with it so an offer of something 300u away reads as the nonsense it is.
  function nearestPoi(pos) {
    let best = null;
    let bestDist = Infinity;
    for (const p of pois) {
      const dist = Math.hypot(pos.x - p.x, pos.y - p.y);
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    return best ? { poi: best, dist: bestDist } : null;
  }

  // A building you've already taught us, if you're standing in its doorway again. Matched
  // on the position you stood at when you pressed Home — not on the POI's own position,
  // which sits wherever mapgenie chose to draw the icon (a roof, a courtyard) and can be
  // tens of units from the door you actually use.
  function knownPlaceAt(pos) {
    let best = null;
    let bestDist = Infinity;
    for (const id of Object.keys(places)) {
      const p = places[id];
      if (!Number.isFinite(p.gameX)) continue;
      const dist = Math.hypot(pos.x - p.gameX, pos.y - p.gameY);
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    return best && bestDist <= placeRadius ? { place: best, dist: bestDist } : null;
  }

  // The game says we're inside. Which dungeon? Whichever entrance we're standing
  // closest to — PROVIDED we're standing close to one at all. Hands over the free
  // calibration anchor at the same time, since the entrance we matched is also the one
  // whose inset arrival point we know.
  //
  // `force` is you pressing Insert. It skips the radius, because at that point the
  // nearest entrance isn't a guess we made — it's one you looked at and accepted. It's
  // also the only way into the two dungeons mapgenie has no entrance for.
  function enterNearest(pos, reason, force = false) {
    const near = nearestDoor(pos);

    // A building you've already named wins outright, and without a distance contest: you
    // stood in this doorway and said "this is Kough's Inn", so we never guess a dungeon
    // here again. Skipped on `force`, which is you overruling exactly that.
    if (!force) {
      const known = knownPlaceAt(pos);
      if (known && (!near || near.dist > enterRadius)) {
        current = null;
        currentPlace = known.place;
        lastReason = `inside "${known.place.title}" (${known.place.category}) `
          + '— you taught us this doorway';
        return;
      }
    }

    if (!near) return;   // no portal graph yet — stay in the overworld rather than guess
    if (!force && near.dist > enterRadius) {
      // Inside SOMETHING, but nothing we know is within reach — a house, a shop, a
      // dungeon with no entrance in mapgenie's data. Entering the nearest one anyway is
      // how "Ancestral Chamber" got calibrated from 219u away. Stay out, and let the
      // hint offer it instead: the dungeon (Insert) or the nearest named place (Home).
      current = null;
      lastReason = `the game says you're inside, but the nearest known entrance `
        + `"${near.door.name}" is ${near.dist.toFixed(1)}u away (over the ${enterRadius}u limit) `
        + '— probably a building. Staying in the overworld';
      return;
    }
    currentPlace = null;   // it's a dungeon, not a building
    const d = near.door;
    current = {
      key: keyOf(d.subregionId, d.floor),
      subregionId: d.subregionId,
      floor: d.floor,
      name: d.name,
    };
    // The distance is worth saying out loud: it is how far the entrance we CHOSE was
    // from where you actually stood when the game said you were inside. Small is
    // reassuring. Large means either you entered a dungeon with no entrance in
    // mapgenie's data (there are two), or the world affine has drifted.
    lastReason = `${reason} — nearest entrance "${d.name}" ${near.dist.toFixed(1)}u away`;
    dismissed = false;
  }

  // What, if anything, are we unsure about right now — and what could the player press
  // to settle it? Recomputed every tick and published on the position feed; the overlay
  // draws it, so the guesses the app is making stop being invisible.
  //
  // Only ever ONE thing at a time, most-blocking first: there's no point suggesting a
  // floor for a dungeon we haven't even agreed we're in.
  function computeHint(pos) {
    const inside = pos.insideFlag !== 0;

    if (!current) {
      // The game says inside, but we didn't take it (no doorway near enough, or none at
      // all). Two things you can tell us, and only you can: it IS that dungeon (Insert),
      // or it's a building, and here is its name (Home).
      if (!inside || dismissed) return null;
      if (currentPlace) return null;    // already named — nothing left to ask
      const p = nearestPoi(lastPos);
      const place = p ? {
        title: p.poi.title,
        category: p.poi.category,
        dist: p.dist,
        // Home refuses beyond placeRadius: a "nearest" inn 300u away isn't the room
        // you're standing in, and binding it would just be the 219u bug with a
        // friendlier name on it.
        reachable: p.dist <= placeRadius,
      } : null;
      if (!lastNear) return { code: 'no-doors', place };
      return {
        code: 'enter',
        name: lastNear.name,
        floor: lastNear.floor,
        dist: lastNear.dist,
        radius: enterRadius,
        place,
      };
    }

    // Inside a dungeon. Which FLOOR is no longer in doubt here — the LocalArea pointer
    // owns it (index.js), and when this tracker is the fallback it holds the floor it
    // entered on. So there is nothing left to ask.
    return null;
  }

  function step(pos) {
    // 0 = overworld; anything else (1 or 2 observed) = inside. Both non-zero values
    // mean inside, so the only edge that matters is zero <-> non-zero.
    const inside = pos.insideFlag !== 0;
    if (inside !== syncedInside) {
      syncedInside = inside;
      dismissed = false;   // a real crossing — whatever you waved away, it's a new question
      if (inside) {
        enterNearest(pos, `the game says you're inside (flag ${pos.insideFlag})`);
      } else {
        current = null;
        currentPlace = null;
        lastReason = 'the game says you\'re in the overworld (flag 0)';
      }
      return current;
    }

    // Inside, in no dungeon and no named building — but a building may have been taught
    // since (or the app may have started up already indoors, with no edge to fire on).
    // Cheap: a handful of places.
    if (inside && !current && !currentPlace) {
      const known = knownPlaceAt(pos);
      if (known) currentPlace = known.place;
    }

    if (!current) return current;

    // The floor is the pointer's job now (index.js). This tracker holds whatever floor it
    // entered on; height no longer moves it between floors.
    return current;
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
    // How near a known doorway you must be for "inside" to mean that dungeon.
    setEnterRadius(u) {
      if (Number.isFinite(u) && u > 0) enterRadius = u;
    },
    // The buildings you've taught us: poiId -> { title, category, gameX, gameY }.
    // From areas.json; main owns the file, as with everything else here.
    setPlaces(next) {
      places = next || {};
    },
    // Roughly how big a building is: how far from the doorway you taught us we'll still
    // recognise it, and how far Home will reach for a POI to name it with.
    setPlaceRadius(u) {
      if (Number.isFinite(u) && u > 0) placeRadius = u;
    },

    // Called every poll tick with { x, y, height, insideFlag, zoneIndex, roomHash }.
    // Returns the active area (null = overworld), and refreshes the hint alongside it.
    tick(pos) {
      lastPos = pos;
      const near = nearestDoor(pos);
      lastNear = near
        ? { name: near.door.name, floor: near.door.floor, dist: near.dist }
        : null;
      const area = step(pos);
      hint = computeHint(pos);
      return area;
    },

    // --- Manual override -----------------------------------------------------
    // In/out comes from the game now, so Insert should rarely be needed. It stays for the
    // one thing still invisible to everything automatic: the two dungeons with no entrance
    // in mapgenie's data at all, where "nearest entrance" has nothing right to pick.
    //
    // Setting the area by hand also syncs the flag state to the CURRENT reading, so
    // the next tick's automatic path sees no edge and doesn't immediately fight it.

    toggle() {
      if (!lastPos) return current;
      if (current) {
        current = null;
        lastReason = 'Insert';
        // You just said "no, I'm not in a dungeon" while the game still says "inside"
        // (a building). Don't turn round and offer the same dungeon again next tick.
        dismissed = lastPos.insideFlag !== 0;
      } else {
        // Forced: the radius is there to stop US guessing, not to stop YOU. This is the
        // only way into a building-that-is-a-dungeon, or into the two dungeons mapgenie
        // has no entrance for at all.
        enterNearest(lastPos, 'Insert', true);
      }
      syncedInside = lastPos.insideFlag !== 0;
      hint = computeHint(lastPos);
      return current;
    },

    // Home: "this interior is that building." Binds the nearest named place (an Inn, a
    // Settlement, a Waypoint — mapgenie's "Locations" and "Facilities" groups) to the
    // spot you're standing on, so the doorway is recognised from now on and nothing is
    // ever guessed here again.
    //
    // Bound to YOUR position, not the POI's: mapgenie draws the icon wherever it looks
    // right on the world map, which can be a roof or a courtyard tens of units from the
    // door you actually walk through — but the door is where the flag flips, so the door
    // is what has to be recognised.
    //
    // It also cancels a dungeon we'd entered: if you're pressing Home, the interior is a
    // building, and whatever we thought we were in, we weren't.
    rememberPlace() {
      if (!lastPos) return null;
      const near = nearestPoi(lastPos);
      if (!near) return { code: 'none' };   // no place POIs (metadata hasn't landed yet)
      if (near.dist > placeRadius) {
        // Refuse rather than bind something far away. This is the same failure the entry
        // radius exists to stop — a confident name for a place you are not in.
        return {
          code: 'too-far',
          title: near.poi.title,
          category: near.poi.category,
          dist: near.dist,
          radius: placeRadius,
        };
      }
      const rec = {
        poiId: near.poi.id,
        title: near.poi.title,
        category: near.poi.category,
        gameX: lastPos.x,
        gameY: lastPos.y,
        dist: near.dist,          // how far the POI icon sits from the door you used
      };
      places[rec.poiId] = rec;
      currentPlace = rec;
      current = null;
      dismissed = false;
      syncedInside = lastPos.insideFlag !== 0;
      pendingPlace = rec;         // main persists it; the tracker never writes the file
      lastReason = `Home — you said this is "${rec.title}" (${rec.category})`;
      hint = computeHint(lastPos);
      return { code: 'ok', ...rec };
    },

    // Drains a newly taught building, so main can persist it.
    takePlace() {
      if (!pendingPlace) return null;
      const p = pendingPlace;
      pendingPlace = null;
      return p;
    },

    current: () => current,
    // The named building you're standing in, if you've taught us this doorway. Never a
    // dungeon — it moves no marker, it only says where you are.
    place: () => currentPlace,
    reason: () => lastReason,
    // What we're unsure about, and what would settle it: { code, name, floor, dist, ... }
    // or null when we're confident. Published on the position feed so the overlay can
    // show it — a guess the player can't see is a guess the player can't correct.
    hint: () => hint,
    // Nearest known entrance and how far off it is, in game units. Published on the
    // position feed for the control window's readout.
    near: () => lastNear,
    doorCount: () => doors.length,
    poiCount: () => pois.length,
  };
}

module.exports = { createTracker, floorOf, keyOf };
