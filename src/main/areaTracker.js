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
  let rooms = {};           // the learned roomHash -> areaKey table (from areas.json)

  let doors = [];               // every known overworld-side entrance, in GAME coords
  let floorsBySub = new Map();  // subregionId -> ordered floor labels, for PageUp/PageDown

  let current = null;       // null = overworld; else { key, subregionId, floor, name }
  let lastPos = null;
  let lastNear = null;      // nearest known doorway + distance, for the readout
  let lastRoom = null;      // the roomHash we last acted on

  // The insideFlag `current` was last derived from. Tracked separately from `current`
  // itself so a manual override (Insert / PageUp / PageDown) sticks: it isn't
  // overwritten every tick just because the raw flag is unchanged from the value that
  // produced it. Treated as a boolean — 1 and 2 both mean inside.
  let syncedInside = null;

  // Set on entry: the correspondence that calibrates the dungeon we just walked into.
  // The player's position at the moment the game says "you're inside" IS (near enough)
  // the entrance POI's spot on the inset, so the pair is a free anchor — no clicking.
  let pendingAnchor = null;

  // Set when a manual floor change teaches us where a room is. Drained by main, which
  // owns areas.json and is the only thing allowed to write it.
  let pendingRoom = null;

  // A SUGGESTION that the floor may have changed — never an action. Raised when you
  // enter an unknown room having gained or lost a lot of height since the last room
  // change. That is what a staircase looks like, but it is also what a long ramp or a
  // deep shaft inside ONE floor looks like, so it is far too fragile to act on: a wrong
  // automatic floor change silently teleports the marker to the wrong panel, which is
  // worse than not moving it at all.
  //
  // It earns its place for the case nothing else covers — DROPPING THROUGH A HOLE to
  // the floor below. There's no portal, no transition prompt, and you may not even
  // notice it happened; the map would just quietly be wrong. This says so, and you
  // press PageDown, which both fixes it and teaches the room. Advice, then a decision
  // that's still yours.
  const FLOOR_HINT_HEIGHT = 12;   // game units of height change across one room change
  let roomEntryHeight = null;     // height when the current room was entered
  let floorHint = null;           // { dh } — drained by main for the log

  // Why the area last changed. Surfaced so the log can say WHY, not just what.
  let lastReason = null;

  // A roomHash is only meaningful inside; -1 (0xFFFFFFFF) is the overworld sentinel.
  const validRoom = (r) => Number.isInteger(r) && r !== -1;
  const roomKey = (r) => (r >>> 0).toString(16).padStart(8, '0');

  // Remember: this room is on this floor. Called when you set the floor by hand — the
  // only moment we actually know the answer.
  function learnRoom(room, areaKey) {
    if (!validRoom(room) || !areaKey) return;
    const k = roomKey(room);
    if (rooms[k] === areaKey) return;   // already known, don't churn the file
    rooms[k] = areaKey;
    pendingRoom = { room: k, areaKey };
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
    for (const floors of floorsBySub.values()) floors.sort((x, y) => floorRank(x) - floorRank(y));

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
    // The learned roomHash -> areaKey table, from areas.json.
    setRooms(next) {
      rooms = next || {};
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
        if (inside) {
          enterNearest(pos, `the game says you're inside (flag ${pos.insideFlag})`);
          // The entrance told us the floor, and we know the room we arrived in — so
          // that room is now known, for free, without you doing anything.
          if (current) learnRoom(pos.roomHash, current.key);
        } else {
          current = null;
          lastReason = 'the game says you\'re in the overworld (flag 0)';
        }
        lastRoom = pos.roomHash;
        roomEntryHeight = pos.height;
        return current;
      }

      // Same side of the door as last tick. The only thing left that can change the
      // area is walking into a room we've been taught the floor of.
      if (!current || pos.roomHash === lastRoom) return current;

      // How much height did we gain or lose crossing out of the last room? A staircase
      // between floors shows up here as a big number.
      const dh = roomEntryHeight === null ? 0 : pos.height - roomEntryHeight;
      lastRoom = pos.roomHash;
      roomEntryHeight = pos.height;
      if (!validRoom(pos.roomHash)) return current;

      const known = rooms[roomKey(pos.roomHash)];
      if (known && known !== current.key) {
        const floor = known.split('|')[1] || '';
        current = { ...current, floor, key: known };
        lastReason = `room ${roomKey(pos.roomHash)} is on ${floor || 'this floor'} (learned)`;
        return current;
      }
      if (known) return current;   // known, and it's the floor we're already on

      // An unknown room. It tells us nothing on its own — a room change is NOT a floor
      // change (one walk through Forgotten Tunnel crossed 8 rooms across 2 floors), so
      // inferring from it would be wrong far more often than right. Hold the floor we're
      // on. But if we also moved a long way vertically, SAY so: that's what a staircase
      // looks like, and more importantly it's the only trace left by falling through a
      // hole, which no portal and no table can catch.
      if (Math.abs(dh) >= FLOOR_HINT_HEIGHT) {
        floorHint = { dh, room: roomKey(pos.roomHash) };
      }
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
        lastReason = 'Insert';
      } else {
        enterNearest(lastPos, 'Insert');
        if (current) learnRoom(lastPos.roomHash, current.key);
      }
      syncedInside = lastPos.insideFlag !== 0;
      lastRoom = lastPos.roomHash;
      return current;
    },

    // PageUp / PageDown: step a floor. No anchor comes with this — you asked for it, so
    // we trust it — which means an unvisited floor lands uncalibrated and says so rather
    // than guessing where you are.
    //
    // But it is not JUST an override. It is how the roomHash table gets taught: you are
    // standing in a room, and you have just told us which floor that room is on. That
    // is the one moment we actually know. Recorded, so this room — and therefore this
    // spot in this dungeon — is never wrong again, in this session or any future one.
    stepFloor(delta) {
      if (!current) return current;
      const floors = floorsBySub.get(current.subregionId) || [];
      const i = floors.indexOf(current.floor);
      if (i < 0) return current;
      const next = floors[i + delta];
      if (next === undefined) return current;  // already at the top/bottom floor
      current = { ...current, floor: next, key: keyOf(current.subregionId, next) };
      if (lastPos) learnRoom(lastPos.roomHash, current.key);
      return current;
    },

    // Drains the anchor from the last entry, if there was an entrance to anchor on.
    takeAnchor() {
      if (!pendingAnchor) return null;
      const a = pendingAnchor;
      pendingAnchor = null;
      return a;
    },

    // Drains a newly learned roomHash -> areaKey pair, so main can persist it. Main owns
    // areas.json; the tracker never writes it.
    takeRoom() {
      if (!pendingRoom) return null;
      const r = pendingRoom;
      pendingRoom = null;
      return r;
    },

    // Drains a "you might have changed floor" suggestion. Advice only — the tracker has
    // already declined to act on it.
    takeFloorHint() {
      if (!floorHint) return null;
      const h = floorHint;
      floorHint = null;
      return h;
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
