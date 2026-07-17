// Collected collectibles from the LIVE gimmicks — the IN-SESSION half of collected-state,
// the complement to contextDbReader.js (the persistent, save-wide half). Both are needed:
//
//   - The ContextDB (contextDbReader) is the SAVE database — its context byte only flips
//     to "collected" when the game writes the save, so a collectible you just took stays
//     "available" there until you save. It covers everything after a save/reload, near or
//     far (and for beetles, which vanish when gathered, it's the ONLY source past that).
//   - This reader watches the LIVE gimmick's flag, which flips the instant you interact —
//     while the gimmick is still loaded (you're standing on it). It covers the gap between
//     taking a collectible and saving, for whatever is streamed in near the player.
//
// Union the two and a collectible's marker disappears immediately AND stays gone across
// reloads. Structure (config/singletons.json beetleGimmickChain), per gimmick:
//
//   GimmickManager instance + 0x10 + 0x18   -> ManagedGimmicks (HashSet<GimmickBase>)
//   HashSet + 0x10 + 0x08                    -> _slots array,  + 0x10 + 0x20 -> _count
//   _slots array + 0x20                      -> Slot[16 bytes]{..,valuePtr@+0x08} = gimmick
//   gimmick + 0x10 (GameObject) + 0x18 (Transform) + 0x80 (worldMatrix) + 0x30 -> pos
//       (CELL-LOCAL; add the caller's global-local frame offset to compare to almanac)
//   a byte flag on the gimmick == collectedValue -> collected/interacted this session
//
// Identity is by POSITION: a collectible is the gimmick within ~2.5u of a known almanac
// position. Beetles additionally pre-filter by vtable (app.Gm82_009) since that's cheap
// and exact; chests can't (their runtime type varies by size and some don't resolve by
// name), so they rely on the position match alone with the shared GimmickBase interacted
// byte +0x374. Both go through the same generalized `read` (see its comment for the spec
// shape). Failure is soft — callers get null and keep their last set.

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
const MATCH_RADIUS = 2.5;           // a collectible gimmick this close to an almanac pt
const MAX_GIMMICKS = 100000;        // garbage-read guard on the HashSet count
const TYPE_ENTRY_SIZE = 0x48n;      // TDB RETypeDefVersion71 stride; managed_vt @+0x40

let cfg = null;
let cfgLoaded = false;

function config() {
  if (!cfgLoaded) {
    cfgLoaded = true;
    const raw = store.load('singletons');
    const gm = raw && raw.types && raw.types['app.GimmickManager'];
    if (raw && gm && typeof gm.holderTypeIndex === 'number' && gm.instanceSlot != null) {
      cfg = {
        vmGlobalRva: BigInt(raw.vmGlobalRva),
        staticTblOffset: BigInt(raw.staticTblOffsetInVm),
        tdbOffset: BigInt(raw.tdbOffsetInVm),
        holderTypeIndex: gm.holderTypeIndex,
        instanceSlot: BigInt(gm.instanceSlot),
      };
    }
  }
  return cfg;
}

// Collected GUIDs across one or more collectible specs, from the LIVE gimmicks in
// GimmickManager.ManagedGimmicks. Each spec = { pois: [{guid,x,y}], flagOffset (number),
// collectedValue (number), vtableTypeIndex? (number) }:
//   - flagOffset/collectedValue: the byte on the gimmick that means collected/interacted
//     this session (beetle Gm82_009 uses +0x3e4==1; chests use the shared GimmickBase
//     "interacted" byte +0x374==1, since their runtime type varies by size).
//   - vtableTypeIndex (optional): if set, only gimmicks of that type are considered (cheap
//     pre-filter, used for beetles). If omitted, EVERY gimmick is a candidate and identity
//     comes purely from the position match — right for chests, whose gimmick types differ
//     per size and some don't resolve by name.
// A gimmick is matched to a POI within MATCH_RADIUS; the flag is read first so the position
// walk is skipped for the many un-interacted gimmicks. -> Set<string>, or null. Never throws.
// frameOffset: { x, y } global-minus-local, so gimmickGlobal = gimmickLocal + frameOffset.
function read(handle, moduleBase, frameOffset, specs) {
  const c = config();
  if (!c || !handle || moduleBase == null || !frameOffset || !specs || !specs.length) return null;
  try {
    const vm = readPointer(handle, moduleBase + c.vmGlobalRva);
    if (vm === 0n) return null;
    const tdb = readPointer(handle, vm + c.tdbOffset);
    if (tdb === 0n) return null;
    const typesPtr = readPointer(handle, tdb + 0x60n);
    if (typesPtr === 0n) return null;

    // Resolve each spec's optional vtable filter live, and pre-square its radius.
    const resolved = [];
    for (const s of specs) {
      if (!s.pois || !s.pois.length) continue;
      let vt = null;
      if (s.vtableTypeIndex != null) {
        vt = readPointer(handle, typesPtr + BigInt(s.vtableTypeIndex) * TYPE_ENTRY_SIZE + 0x40n);
        if (vt === 0n) return null;
      }
      resolved.push({ pois: s.pois, flagOffset: BigInt(s.flagOffset), collectedValue: s.collectedValue, vt, r2: MATCH_RADIUS * MATCH_RADIUS });
    }
    if (!resolved.length) return new Set();

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
    const collected = new Set();
    for (let i = 0; i < count; i++) {
      const gimmick = slotBuf.readBigUInt64LE(i * SLOT_SIZE + SLOT_VALUE);
      if (gimmick === 0n) continue;
      let head;
      try { head = readMemory(handle, gimmick, 8); } catch { continue; }
      const gvt = head.readBigUInt64LE(0);

      let pos = null; // { x, y } resolved lazily on first spec that needs it
      for (const spec of resolved) {
        if (spec.vt !== null && gvt !== spec.vt) continue;   // type pre-filter
        // Flag first: skip the position walk for un-interacted gimmicks.
        let flag;
        try { flag = readMemory(handle, gimmick + spec.flagOffset, 1).readUInt8(0); } catch { continue; }
        if (flag !== spec.collectedValue) continue;
        if (pos === null) {
          try {
            const go = readPointer(handle, gimmick + GO_OFF);
            if (go === 0n) { pos = false; continue; }
            const tf = readPointer(handle, go + TF_OFF);
            if (tf === 0n) { pos = false; continue; }
            const mtx = readMemory(handle, tf + WORLD_MTX + POS_ROW, 12);
            const gx = mtx.readFloatLE(0) + frameOffset.x;
            const gy = mtx.readFloatLE(8) + frameOffset.y;
            pos = (Number.isFinite(gx) && Number.isFinite(gy)) ? { x: gx, y: gy } : false;
          } catch { pos = false; }
        }
        if (!pos) continue;
        let bestGuid = null, bestD2 = spec.r2;
        for (const p of spec.pois) {
          const dx = p.x - pos.x, dy = p.y - pos.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) { bestD2 = d2; bestGuid = p.guid; }
        }
        if (bestGuid) collected.add(bestGuid);
      }
    }
    return collected;
  } catch {
    return null;
  }
}

module.exports = { read };
