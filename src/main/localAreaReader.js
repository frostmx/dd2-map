// Reads the game's current map area+floor directly, from a static pointer chain, instead
// of guessing it from position (the old areaTracker.js path). This is the primary source.
//
// WHY THIS EXISTS
//
// The game keeps a "current map area" record whose int32 `LocalArea` field is UNIQUE per
// (area, floor): one read names the dungeon AND the floor, and it is -1 in the overworld.
// It is immune to falls, lifts, teleports and stairs -- it is the value the game itself
// uses to pick which minimap to draw, not anything derived from coordinates or height. See
// .map/README.md for how the chain and the field were found.
//
// THE ONE CATCH, AND THE DEFENCE
//
// The record is one slot in a ~43,000-slot array (idle slots read UIArea 0 / LocalArea -1),
// and a pointer chain can occasionally resolve to a STALE slot after a game restart. So we
// do not trust any single chain:
//
//   1. resolve EVERY chain in config/dd2.localarea.json,
//   2. take the LocalArea value the majority of chains agree on,
//   3. verify (UIArea, LocalArea) is a real pair in config/localAreas.json.
//
// A chain that drifted reads a slot whose pair is not in the table and is outvoted and
// rejected. If nothing verifies, we return null and the caller falls back to the old
// guessing path (which still runs the overworld nearest-dungeon offer anyway).

const {
  findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle,
} = require('./memoryReader');

function createLocalAreaReader(cfg, localAreas) {
  // cfg: parsed config/dd2.localarea.json ; localAreas: parsed config/localAreas.json
  const uiAreaRel = BigInt(cfg.uiAreaRel);
  const chains = cfg.chains.map((c) => ({
    static: BigInt(c.static),
    offsets: c.offsets.map((o) => Number(o)),
  }));

  // (uiArea, localArea) pairs that actually exist, for the verification step.
  const validPairs = new Set();
  validPairs.add('0:-1'); // overworld: UIArea 0, LocalArea -1
  for (const [la, v] of Object.entries(localAreas.byLocalArea || {})) {
    validPairs.add(`${v.uiArea}:${la}`);
  }

  let handle = null;
  let base = null;
  let pid = null;

  // Attach once and keep the handle; re-scan only when detached (after the process is
  // gone). findProcessIdByName enumerates every process, so calling it each 30Hz tick
  // would cost far more than the reads themselves.
  function ensureAttached() {
    if (handle) return true;
    const found = findProcessIdByName('DD2.exe');
    if (!found) return false;
    try {
      pid = found;
      handle = openProcess(pid);
      base = BigInt(findModuleBase(pid, 'DD2.exe').base);
      return true;
    } catch { detach(); return false; }
  }

  function detach() {
    if (handle) { try { closeHandle(handle); } catch { /* already gone */ } }
    handle = null; base = null; pid = null;
  }

  // Returns { localArea, uiArea } for the agreed, verified slot, or null.
  function read() {
    if (!ensureAttached()) return null;
    const votes = new Map();       // "uiArea:localArea" -> count
    let bestKey = null;
    let bestCount = 0;
    let threw = 0;
    for (const chain of chains) {
      let addr; let localArea; let uiArea;
      try {
        addr = BigInt(resolvePointerChain(handle, base + chain.static, chain.offsets));
        localArea = readMemory(handle, addr, 4).readInt32LE(0);
        uiArea = readMemory(handle, addr + uiAreaRel, 4).readInt32LE(0);
      } catch { threw += 1; continue; }
      const key = `${uiArea}:${localArea}`;
      if (!validPairs.has(key)) continue;        // stale/garbage slot -> ignore this chain
      const n = (votes.get(key) || 0) + 1;
      votes.set(key, n);
      if (n > bestCount) { bestCount = n; bestKey = key; }
    }
    // Every chain threw -> the process is almost certainly gone; drop the handle so the
    // next tick re-attaches (rather than reading a dead handle forever).
    if (threw === chains.length) detach();
    if (!bestKey) return null;                    // nothing verified this tick
    const [ui, la] = bestKey.split(':').map(Number);
    return { localArea: la, uiArea: ui, agree: bestCount, of: chains.length };
  }

  return { read, detach };
}

module.exports = { createLocalAreaReader };
