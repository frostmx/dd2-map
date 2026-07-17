// Collected Golden Trove Beetles — the IN-SESSION half of beetle collected-state, the
// complement to contextDbReader.js (the persistent, save-wide half). Both are needed:
//
//   - The ContextDB (contextDbReader) is the SAVE database — its GatherContext byte only
//     flips to "collected" when the game writes the save, so a beetle you just gathered
//     stays "available" there until you save. It covers everything after a save/reload.
//   - This reader watches the LIVE gimmick's flag, which flips the instant you gather —
//     while the gimmick is still loaded (i.e. you're standing on it, right after picking
//     it up). It covers the gap between gathering and saving.
//
// Union the two and a gathered beetle's marker disappears immediately AND stays gone
// across reloads. This reader only ever sees beetles currently streamed in near the
// player — which is exactly when an unsaved just-gathered beetle needs catching.
//
// Everything here was discovered live 2026-07-17 by walking the manager and byte-diffing
// a beetle before/after gathering it against a 0-drift alive baseline (see FINDINGS.md
// "Golden Trove Beetle collected-state" and config/singletons.json beetleGimmickChain):
//
//   GimmickManager instance + 0x10 + 0x18   -> ManagedGimmicks (HashSet<GimmickBase>)
//   HashSet + 0x10 + 0x08                    -> _slots array,  + 0x10 + 0x20 -> _count
//   _slots array + 0x20                      -> Slot[16 bytes]{..,valuePtr@+0x08} = gimmick
//   gimmick vtable (@+0x00) == app.Gm82_009's managed_vt  -> it's a beetle-or-gatherable
//   gimmick + 0x10 (GameObject) + 0x18 (Transform) + 0x80 (worldMatrix) + 0x30 -> pos
//       (CELL-LOCAL; add the caller's global-local frame offset to compare to almanac)
//   gimmick + 0x3e4 (byte) == 1              -> gathered/collected
//
// app.Gm82_009 is the runtime component for a beetle (and other gatherables — the far
// ones are NOT beetles), so a beetle is specifically a Gm82_009 sitting within ~2.5u of
// a known almanac beetle position. The vtable value moves each launch, so it is resolved
// fresh from the TDB (types[typeIndex] + 0x40) rather than stored.
//
// read() takes the caller's frame offset and the beetle POI list, and returns a
// Set<string> of collected beetle GUIDs (or null on any failure — same soft-fail
// doctrine as timeReader.js / generateManagerReader.js). Only nearby (streamed-in)
// beetles can be reported; a beetle the game hasn't loaded stays absent from the set
// (its marker keeps showing), which is the intended "resolve when close" behaviour.

const store = require('./configStore');
const { readMemory, readPointer } = require('./memoryReader');

const MANAGED_GIMMICKS_OFF = 0x18n;   // GimmickManager instance +0x10 + this
const SLOTS_OFF = 0x08n;              // HashSet +0x10 + this
const COUNT_OFF = 0x20n;             // HashSet +0x10 + this
const SLOTS_DATA = 0x20n;            // array object + this -> Slot[0]
const SLOT_SIZE = 16;
const SLOT_VALUE = 8;               // Slot { hashCode:i32, next:i32, valuePtr:i64@+8 }
const GO_OFF = 0x10n;               // gimmick +0x10 -> GameObject
const TF_OFF = 0x18n;               // GameObject +0x18 -> Transform
const WORLD_MTX = 0x80n;            // Transform +0x80 -> worldMatrix (4x4)
const POS_ROW = 0x30n;              // worldMatrix + this -> row3 (pos): x@+0, z@+8
const FLAG_OFF = 0x3e4n;            // gimmick + this (byte) == 1 -> collected
const MATCH_RADIUS = 2.5;           // a beetle is a Gm82_009 this close to an almanac pt
const MAX_GIMMICKS = 100000;        // garbage-read guard on the HashSet count
const TYPE_ENTRY_SIZE = 0x48n;      // TDB RETypeDefVersion71 stride; managed_vt @+0x40

let cfg = null;
let cfgLoaded = false;

function config() {
  if (!cfgLoaded) {
    cfgLoaded = true;
    const raw = store.load('singletons');
    const gm = raw && raw.types && raw.types['app.GimmickManager'];
    const beetle = raw && raw.types && raw.types['app.Gm82_009'];
    if (raw && gm && typeof gm.holderTypeIndex === 'number' && gm.instanceSlot != null
      && beetle && typeof beetle.typeIndex === 'number') {
      cfg = {
        vmGlobalRva: BigInt(raw.vmGlobalRva),
        staticTblOffset: BigInt(raw.staticTblOffsetInVm),
        tdbOffset: BigInt(raw.tdbOffsetInVm),
        holderTypeIndex: gm.holderTypeIndex,
        instanceSlot: BigInt(gm.instanceSlot),
        beetleTypeIndex: BigInt(beetle.typeIndex),
      };
    }
  }
  return cfg;
}

// -> Set<string> of collected beetle GUIDs (lowercase), or null. Never throws.
// frameOffset: { x, y } global-minus-local, so gimmickGlobal = gimmickLocal + frameOffset.
// beetlePois: [{ guid, x, y }] in almanac/global coords (engine x, z).
function read(handle, moduleBase, frameOffset, beetlePois) {
  const c = config();
  if (!c || !handle || moduleBase == null || !frameOffset || !beetlePois || !beetlePois.length) return null;
  try {
    const vm = readPointer(handle, moduleBase + c.vmGlobalRva);
    if (vm === 0n) return null;

    // Resolve app.Gm82_009's managed_vt live: TDB types[] @ tdb+0x60, entry+0x40.
    const tdb = readPointer(handle, vm + c.tdbOffset);
    if (tdb === 0n) return null;
    const typesPtr = readPointer(handle, tdb + 0x60n);
    if (typesPtr === 0n) return null;
    const beetleVt = readPointer(handle, typesPtr + c.beetleTypeIndex * TYPE_ENTRY_SIZE + 0x40n);
    if (beetleVt === 0n) return null;

    const elements = readPointer(handle, vm + c.staticTblOffset);
    if (elements === 0n) return null;
    const statics = readPointer(handle, elements + BigInt(c.holderTypeIndex * 8));
    if (statics === 0n) return null;
    const instance = readPointer(handle, statics + c.instanceSlot);
    if (instance === 0n) return null;

    const hashSet = readPointer(handle, instance + 0x10n + MANAGED_GIMMICKS_OFF);
    if (hashSet === 0n) return null;
    const slots = readPointer(handle, hashSet + 0x10n + SLOTS_OFF);
    if (slots === 0n) return null;
    const count = readMemory(handle, hashSet + 0x10n + COUNT_OFF, 4).readInt32LE(0);
    if (!Number.isInteger(count) || count < 0 || count > MAX_GIMMICKS) return null;
    if (count === 0) return new Set();

    const slotBuf = readMemory(handle, slots + SLOTS_DATA, count * SLOT_SIZE);
    const r2 = MATCH_RADIUS * MATCH_RADIUS;
    const collected = new Set();
    for (let i = 0; i < count; i++) {
      const gimmick = slotBuf.readBigUInt64LE(i * SLOT_SIZE + SLOT_VALUE);
      if (gimmick === 0n) continue;
      let head;
      try { head = readMemory(handle, gimmick, 8); } catch { continue; }
      if (head.readBigUInt64LE(0) !== beetleVt) continue; // not a Gm82_009

      // Only collected ones matter — read the flag first, skip uncollected cheaply.
      let flag;
      try { flag = readMemory(handle, gimmick + FLAG_OFF, 1).readUInt8(0); } catch { continue; }
      if (flag !== 1) continue;

      // Global position, to match against an almanac beetle GUID.
      let go, tf, mtx;
      try {
        go = readPointer(handle, gimmick + GO_OFF);
        if (go === 0n) continue;
        tf = readPointer(handle, go + TF_OFF);
        if (tf === 0n) continue;
        mtx = readMemory(handle, tf + WORLD_MTX + POS_ROW, 12);
      } catch { continue; }
      const gx = mtx.readFloatLE(0) + frameOffset.x;
      const gy = mtx.readFloatLE(8) + frameOffset.y;
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;

      // Nearest almanac beetle within the match radius -> that GUID is collected.
      let bestGuid = null, bestD2 = r2;
      for (const p of beetlePois) {
        const dx = p.x - gx, dy = p.y - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) { bestD2 = d2; bestGuid = p.guid; }
      }
      if (bestGuid) collected.add(bestGuid);
    }
    return collected;
  } catch {
    return null;
  }
}

module.exports = { read };
