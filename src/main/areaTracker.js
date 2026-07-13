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

  // Set when a manual floor change may also have supplied a free anchor for a floor
  // that has none (see stepFloor). Resolved by main, which holds the transforms.
  let pendingFloorAnchor = null;

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

  // Ticks (at 30Hz) you must remain in one room before it's recorded against the current
  // floor. This is the fix for the stairwell: pressing PageUp happens IN the stairs, so
  // learning immediately records the one room that belongs to both floors. Waiting until
  // you've settled records the room you actually walked into instead. ~1.5s.
  const LEARN_DWELL_TICKS = 45;
  let roomTicks = 0;              // consecutive ticks in the current room

  // Do we actually BELIEVE the floor we're showing? Learning while we don't is how the
  // table gets poisoned wholesale: walk down to B1F, explore for half a minute before
  // pressing PageDown, and every B1F room you crossed gets written down as 1F. Next visit
  // they'd all drag you back to the wrong floor.
  //
  // The floor is trusted when something ASSERTED it — you pressed the key, you came in
  // through an entrance that names the floor, or you walked into a room we already know.
  // It stops being trusted the moment we see a move that could have been an unannounced
  // floor change (the height jump), and stays untrusted until something asserts it again.
  // Nothing is recorded in the meantime.
  let trusted = false;

  // Why the area last changed. Surfaced so the log can say WHY, not just what.
  let lastReason = null;

  // A roomHash is only meaningful inside; -1 (0xFFFFFFFF) is the overworld sentinel.
  const validRoom = (r) => Number.isInteger(r) && r !== -1;
  const roomKey = (r) => (r >>> 0).toString(16).padStart(8, '0');

  // A room that has been seen on TWO different floors. A stairwell is exactly this — it
  // physically spans both — and it can never be given one answer, so it is written down
  // as ambiguous and then never used or overwritten again.
  const AMBIGUOUS = '?';

  // Remember: this room is on this floor.
  //
  // The obvious moment to record it — the instant you press PageUp/PageDown — turns out
  // to be the WORST one. That's when you're standing in the stairwell, which belongs to
  // both floors at once. Learning it there taught the table a contradiction, and then the
  // table fought you: walk into the stairwell, it flips you to the wrong floor, you
  // correct it, it relearns, and the next time through it flips you the other way.
  // (Observed live: room 1bc90b46 in The Gracious Hand's Vaults ping-ponged B1F/1F/B1F/1F.)
  //
  // Two rules kill that:
  //   1. Learn on DWELL, not on the keypress — record whichever room you've settled in,
  //      which is a real room on a real floor, not the stairs you were passing through.
  //   2. A room that ever contradicts itself is marked AMBIGUOUS, permanently. That is
  //      the stairwell, and the right thing to do with it is nothing at all.
  function learnRoom(room, areaKey, label) {
    if (!validRoom(room) || !areaKey) return;
    const k = roomKey(room);
    const prev = rooms[k];
    if (prev === areaKey || prev === AMBIGUOUS) return;   // known, or known-unknowable

    if (prev && prev !== areaKey) {
      rooms[k] = AMBIGUOUS;
      pendingRoom = { room: k, areaKey: AMBIGUOUS, label, conflict: prev };
      return;
    }
    rooms[k] = areaKey;
    pendingRoom = { room: k, areaKey, label };
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
          // The entrance NAMES the floor it leads to, so the floor is trusted on the way
          // in — which is what makes the arrival room safe to record.
          enterNearest(pos, `the game says you're inside (flag ${pos.insideFlag})`);
          trusted = !!current;
        } else {
          current = null;
          trusted = false;
          lastReason = 'the game says you\'re in the overworld (flag 0)';
        }
        lastRoom = pos.roomHash;
        roomEntryHeight = pos.height;
        roomTicks = 0;
        return current;
      }

      if (!current) return current;

      // Still in the same room. Once you've SETTLED here — and only if we actually
      // believe the floor — record it. Settling, rather than the instant you pressed the
      // key, is what keeps the stairwell out of the table: you press PageUp while in the
      // stairs (which belong to both floors), then walk into a room that belongs to one.
      if (pos.roomHash === lastRoom) {
        roomTicks += 1;
        if (roomTicks === LEARN_DWELL_TICKS && trusted) {
          learnRoom(pos.roomHash, current.key, `${current.name} ${current.floor}`.trim());
        }
        return current;
      }

      // A new room. How much height did we gain or lose getting here? A staircase between
      // floors shows up as a big number.
      const dh = roomEntryHeight === null ? 0 : pos.height - roomEntryHeight;
      lastRoom = pos.roomHash;
      roomEntryHeight = pos.height;
      roomTicks = 0;
      if (!validRoom(pos.roomHash)) return current;

      const known = rooms[roomKey(pos.roomHash)];
      // AMBIGUOUS — a room seen on two floors, i.e. a stairwell. It cannot answer the
      // question, and pretending otherwise is what made the map ping-pong. Ignore it and
      // hold the floor we're on; the room you walk into NEXT will settle it.
      if (known === AMBIGUOUS) return current;

      if (known && known !== current.key) {
        const floor = known.split('|')[1] || '';
        const from = current.floor;
        current = { ...current, floor, key: known };
        trusted = true;   // a room we know is an assertion — as good as you pressing the key
        lastReason = `room ${roomKey(pos.roomHash)} is on ${floor || 'this floor'} (learned)`;
        // The floor may never have been placed (an upper floor has no entrance of its
        // own). You just came off the stair, so offer the crossing as its anchor —
        // exactly as a manual floor change does. Main ignores it if the floor is already
        // placed.
        pendingFloorAnchor = {
          subregionId: current.subregionId,
          name: current.name,
          fromFloor: from,
          toFloor: floor,
          areaKey: current.key,
          gameX: pos.x,
          gameY: pos.y,
        };
        return current;
      }
      if (known) { trusted = true; return current; }   // known, and already the right floor

      // An unknown room. It tells us nothing on its own — a room change is NOT a floor
      // change (one walk through Forgotten Tunnel crossed 8 rooms across 2 floors), so
      // inferring from it would be wrong far more often than right. Hold the floor we're
      // on.
      //
      // But a big height change getting here means we MIGHT just have changed floor
      // without being told — a staircase, or a hole you fell through. Two things follow:
      // say so (the hint), and stop trusting the floor, so nothing further is written
      // down until you confirm it or a known room settles it. Recording rooms while
      // possibly on the wrong floor is precisely how the table gets poisoned.
      if (Math.abs(dh) >= FLOOR_HINT_HEIGHT) {
        floorHint = { dh, room: roomKey(pos.roomHash) };
        trusted = false;
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
      }
      syncedInside = lastPos.insideFlag !== 0;
      lastRoom = lastPos.roomHash;
      roomTicks = 0;
      trusted = !!current;   // you told us; that's an assertion
      return current;
    },

    // PageUp / PageDown: step a floor. It is not just an override — it is the only input
    // that ever teaches the floor table. But NOT by recording the room you're standing in
    // right now: that's the stairwell, which belongs to both floors, and writing it down
    // is what made the map ping-pong. The room is recorded once you've SETTLED somewhere
    // (see tick / LEARN_DWELL_TICKS), which is a room on exactly one floor.
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
      roomTicks = 0;   // restart the dwell: don't learn the stairs you're standing in
      trusted = true;  // you told us; that's the strongest assertion there is

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

    // Drains the stair crossing from the last manual floor change, so main can use it to
    // place a floor that has no entrance of its own.
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
