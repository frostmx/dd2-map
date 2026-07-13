// Log DD2's dungeon-zone state against the dungeon we THINK you're in, so the two
// can be matched up.
//
//   node tools/zoneLog.js
//
// WHY THIS EXISTS
//
// Two module-static ints (found by CE value-scanning, 2026-07-13) tell us the game's
// own view of where you are:
//
//   DD2.exe+FA62CAC  insideFlag   0 = overworld, 1 and 2 = inside a dungeon
//   DD2.exe+FA62CB0  zoneIndex    the game's dungeon id
//
// The flag is enough to know WHETHER you're inside, and the app already uses it. But
// zoneIndex is the GAME's numbering, and mapgenie's subregion ids are a completely
// different one — mapgenie runs 2441-2514, and an observed zoneIndex was 18. So
// zoneIndex cannot name a dungeon today, and the app falls back to "whichever known
// entrance you're standing nearest to", which depends on the world affine being
// accurate and can't see the two dungeons mapgenie has no entrance for.
//
// The fix is a lookup table, and the only way to get one is to visit dungeons and
// write down what the game said. That's this. Run it, play, and every time the zone
// state CHANGES it prints and appends a line pairing:
//
//   the game's (insideFlag, zoneIndex)   <->   the nearest mapgenie entrance's name
//
// Enough dungeons and the mapping falls out. Then "which dungeon" becomes a lookup
// instead of a guess, the world affine stops mattering for it, and the two orphan
// dungeons work too.
//
// It also settles the open question about flag value 2: both 1 and 2 mean "inside",
// but what makes them different isn't known. If 2 turns out to be, say, towns rather
// than caves, this log will show it plainly.
//
// Needs DD2 running. Does NOT need the Electron app running — but it does need
// config/mapgenie-areas.json, which the app writes on launch (it's the cached portal
// graph). If it's missing, start the app once and let the map load.

const fs = require('node:fs');
const path = require('node:path');
const {
  findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle,
} = require('../src/main/memoryReader');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'zone_log.txt');

// The zone struct. insideFlag is the anchor; the rest are read to work out what they
// are. Confirmed live 2026-07-13 by walking a dungeon and back out:
//
//   -24  roomHash   -1 in the overworld; inside, it CHANGES AS YOU WALK (5 steps in one
//                   dungeon, one of which was a floor change). Best floor/room candidate
//                   we have — logged here to find out if it tracks floors.
//     0  insideFlag  0 = overworld, 1 and 2 = inside
//    +4  zoneIndex  -1 (0xFFFFFFFF) in the overworld — a sentinel, NOT 0
//   +12  float       0.0 outside; 0.46-0.75 inside, wandering. Unknown; logged to see.
const ZONE_BASE_OFFSET = 0x0fa62cacn;     // insideFlag
const ROOM_HASH_REL = -24;
const FLOAT12_REL = 12;
const WINDOW_START = -24;                 // one read covering roomHash .. +12
const WINDOW_SIZE = 40;
const LOCAL_MIRROR_OFFSET = 0x0fa65f70n;  // local x @+0, height @+4, y @+8
const GLOBAL_STATIC_OFFSET = 0x0fd26358n;
const GLOBAL_OFFSETS = [0x1a8, 0x410];
const GLOBAL_FALLBACK_STATIC_OFFSET = 0x0f8e1130n;
const GLOBAL_FALLBACK_OFFSETS = [0x210, 0x50];
const CELL = 128;

const POLL_MS = 100;   // the state changes at walking pace; 30Hz would be pointless

// Height change across one room boundary that's worth calling out as a possible floor
// change. Forgotten Tunnel's two floors were separated by ~17u, and its rooms within a
// floor stepped 2-4u at a time.
const FLOOR_HINT_HEIGHT = 12;

function loadJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Same inverse the tracker uses: mapgenie lng/lat -> game coords, via the world affine.
function makeInvert(cal) {
  if (!cal || typeof cal.e !== 'number') return null;
  const det = cal.a * cal.e - cal.b * cal.d;
  if (!Number.isFinite(det) || det === 0) return null;
  return (lng, lat) => {
    const dl = lng - cal.c - (cal.offsetLng || 0);
    const dt = lat - cal.f - (cal.offsetLat || 0);
    return {
      x: (cal.e * dl - cal.b * dt) / det,
      y: (-cal.d * dl + cal.a * dt) / det,
    };
  };
}

// Every overworld->dungeon entrance, in game coords. Identical to areaTracker.rebuild().
function buildDoors(meta, invert) {
  const overworld = new Set(meta.overworldRegionIds);
  const doors = [];
  for (const p of meta.portals) {
    if (!overworld.has(p.fromRegion) || overworld.has(p.toRegion)) continue;
    const g = invert(p.fromLng, p.fromLat);
    if (!g) continue;
    const sub = meta.subregions[p.toRegion];
    doors.push({
      x: g.x,
      y: g.y,
      subregionId: p.toRegion,
      title: p.toTitle || '',
      name: (sub && sub.title) || String(p.toRegion),
    });
  }
  return doors;
}

function nearest(doors, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const d of doors) {
    const dist = Math.hypot(x - d.x, y - d.y);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best ? { door: best, dist: bestDist } : null;
}

function main() {
  const meta = loadJson('mapgenie-areas');
  const cal = loadJson('calibration');
  if (!meta) throw new Error('config/mapgenie-areas.json missing — run the app once and let the map load');
  const invert = makeInvert(cal);
  if (!invert) throw new Error('config/calibration.json missing or not a full affine — calibrate the world map first');
  const doors = buildDoors(meta, invert);

  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  const moduleBase = BigInt(findModuleBase(pid, 'DD2.exe').base);

  const log = (line) => {
    console.log(line);
    fs.appendFileSync(OUT, line + '\n');
  };

  log('');
  log(`=== ${new Date().toISOString()} — ${doors.length} known entrances, ${Object.keys(meta.subregions).length} mapgenie subregions ===`);
  console.log(`Appending to ${OUT}. Ctrl+C to stop.`);
  console.log('Walk into dungeons. Every change in the game\'s zone state prints a line.\n');

  // The consistency check the app makes: a global read is only trustworthy if it sits
  // on the 128-grid relative to the local mirror (rejects a bad pointer resolution).
  const onGrid = (g, l) => Number.isFinite(g) && Math.abs((g - l) / CELL - Math.round((g - l) / CELL)) < 0.05;

  const readGlobal = (staticOff, offs) => {
    const addr = resolvePointerChain(handle, moduleBase + staticOff, offs);
    const buf = readMemory(handle, addr, 12);
    return { x: buf.readFloatLE(0), y: buf.readFloatLE(8) };
  };

  let prev = null;            // last (flag, zone, roomHash) triple seen
  let entered = null;         // what we were, when we last went inside
  let roomEntryHeight = null; // height when the current room was entered, for the floor hint

  setInterval(() => {
    try {
      // One read covering roomHash(-24) .. +12.
      const buf = readMemory(handle, moduleBase + ZONE_BASE_OFFSET + BigInt(WINDOW_START), WINDOW_SIZE);
      const at32 = (rel) => buf.readInt32LE(rel - WINDOW_START);
      const flag = at32(0);
      const zone = at32(4);
      const room = at32(ROOM_HASH_REL);
      const f12 = buf.readFloatLE(FLOAT12_REL - WINDOW_START);
      const roomHex = (room >>> 0).toString(16).padStart(8, '0');

      const mirror = readMemory(handle, moduleBase + LOCAL_MIRROR_OFFSET, 12);
      const localX = mirror.readFloatLE(0);
      const height = mirror.readFloatLE(4);
      const localY = mirror.readFloatLE(8);

      let g = null;
      try {
        const p = readGlobal(GLOBAL_STATIC_OFFSET, GLOBAL_OFFSETS);
        if (onGrid(p.x, localX) && onGrid(p.y, localY)) g = p;
      } catch { /* fall through */ }
      if (!g) {
        try {
          const f = readGlobal(GLOBAL_FALLBACK_STATIC_OFFSET, GLOBAL_FALLBACK_OFFSETS);
          if (onGrid(f.x, localX) && onGrid(f.y, localY)) g = f;
        } catch { /* no position this tick */ }
      }
      if (!g) return;  // mid-load; try again next tick

      // roomHash is in the key: inside a dungeon it steps as you move between sections,
      // and one of those steps should be the FLOOR change we can't otherwise see. Height
      // is logged on every line precisely so those two can be correlated afterwards — a
      // room change with a big height swing is a staircase.
      const key = `${flag}|${zone}|${room}`;
      if (key === prev) return;
      const first = prev === null;
      const prevParts = prev ? prev.split('|') : null;
      const onlyRoomChanged = prevParts
        && prevParts[0] === String(flag) && prevParts[1] === String(zone);
      prev = key;

      const near = nearest(doors, g.x, g.y);
      const at = `pos (${g.x.toFixed(0)}, ${g.y.toFixed(0)}) h=${height.toFixed(1)}`;
      const stamp = new Date().toTimeString().slice(0, 8);

      if (flag === 0) {
        // Went outside. Worth pairing with what we were inside, so the log reads as a
        // story rather than a pile of unconnected lines.
        const was = entered ? `  (was: ${entered})` : '';
        entered = null;
        log(`${stamp}  flag=0 zone=${zone} room=${roomHex}   OVERWORLD   ${at}${was}`);
        return;
      }

      // Same dungeon, different room. THIS is the line to watch for the floor: if the
      // height jumped with it, you probably took a staircase — or fell down a hole.
      //
      // Flagged, not concluded. A big height change across a room boundary is what a
      // staircase looks like, but so is a long ramp or a deep shaft WITHIN one floor, so
      // it's far too fragile to trust. It's here because it's the only trace left by
      // falling through a hole, which no portal and no lookup table can catch.
      if (onlyRoomChanged) {
        const dh = roomEntryHeight === null ? 0 : height - roomEntryHeight;
        const hint = Math.abs(dh) >= FLOOR_HINT_HEIGHT
          ? `  <- ${Math.abs(dh).toFixed(0)}u ${dh < 0 ? 'DOWN' : 'UP'} — FLOOR CHANGE? (or just a ramp/shaft)`
          : `  (${dh >= 0 ? '+' : ''}${dh.toFixed(1)}u)`;
        roomEntryHeight = height;
        log(`${stamp}  flag=${flag} zone=${zone} room=${roomHex}   ...room change (same dungeon)   ${at}  f12=${f12.toFixed(2)}${hint}`);
        return;
      }
      roomEntryHeight = height;

      // Inside. The nearest entrance is our best guess at WHICH dungeon — and the
      // distance is the whole point: small means the guess is solid and this zone
      // number can be trusted to mean that dungeon. Large means we're deep inside
      // somewhere and this line should NOT be used to build the mapping (you were
      // already in when the zone changed — e.g. a floor transition, or a connected
      // second dungeon), or you're in one of the two dungeons mapgenie has no
      // entrance for.
      const who = near
        ? `${near.door.name}${near.door.title && near.door.title !== near.door.name ? ` [${near.door.title}]` : ''}`
        : '(no known entrance)';
      const dist = near ? `${near.dist.toFixed(0)}u` : '-';
      const sub = near ? `mapgenie subregion ${near.door.subregionId}` : '-';
      const trust = near && near.dist < 40 ? 'CLOSE — good mapping sample' : 'far — treat with suspicion';

      entered = `flag=${flag} zone=${zone} near "${who}"`;
      log(
        `${stamp}  flag=${flag} zone=${zone} room=${roomHex}   INSIDE   nearest entrance: "${who}" ${dist} away  ` +
        `(${sub})  ${at}  f12=${f12.toFixed(2)}  <- ${trust}${first ? '  [already inside when the log started]' : ''}`,
      );
    } catch {
      // DD2 closed or a transient read failure — keep going, it'll come back.
    }
  }, POLL_MS);

  process.on('SIGINT', () => {
    log(`=== stopped ${new Date().toISOString()} ===`);
    closeHandle(handle);
    process.exit(0);
  });
}

try {
  main();
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
