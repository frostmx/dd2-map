// Collected-collectible tracking, read straight out of app.GenerateManager's
// _NeverGenetateID — the game's own persistent record of every collectible GUID it
// will never spawn again (Capcom's typo, not ours). Confirmed via gibbed's Almanac
// Lua mod (`generate_manager:isNeverGenerate(collectible_id)`); this file is the
// pure-RPM read of the same field, using the app.GenerateManager singleton already
// resolved by tools/singletonHunt.js (see FINDINGS.md "Managed singletons via pure
// RPM"). It is NOT tokens-only: 394 GUIDs were live in the set on a save with 71
// tokens collected, so beetles/chests/other "never regenerate" collectibles share
// this one HashSet — callers must intersect against their own known-GUID list.
//
// Chain, discovered live 2026-07-17 via `tools/singletonHunt.js --deref
// app.GenerateManager _NeverGenetateID` (a field-dereference mode added for exactly
// this) plus manual probing of the resulting HashSet`1<Guid>:
//
//   GenerateManager instance + 0x10 + 0x1f0   -> _NeverGenetateID (HashSet`1<Guid>)
//   HashSet + 0x10 + 0x08                     -> _slots (Slot[] array object)
//   HashSet + 0x10 + 0x20                     -> _count (i32)
//   _slots array object + 0x20                -> Slot[0], packed 16 bytes/slot:
//       Slot: { hashCode: i32 @0, next: i32 @4, valuePtr: i64 @8 }
//   valuePtr + 0x10 (boxed value; +0x10 past header, same convention as every other
//       managed object in this codebase) -> 16 raw bytes = one System.Guid
//
// The field table's own names (_buckets, _slots, _count, _lastIndex, _freeList,
// _comparer, _version, plus the static Lower31BitMask/StackAllocThreshold/
// ShrinkThreshold constants) are a verbatim match for real .NET's
// System.Collections.Generic.HashSet<T> — RE Engine's via.clr VM mirrors the BCL's
// own layout here, not a custom one. Guid decode is .NET's own byte order: Data1/
// Data2/Data3 little-endian, Data4 raw — matching data/almanac/*.json's string keys.
//
// Every read re-resolves the whole chain and re-walks every slot (same cost profile
// as the other readers; this one is polled far less often since collected-state
// rarely changes — see the collectedPollMs timer in index.js). Failure is soft: a
// bad chain hop or an implausible slot count returns null and callers keep showing
// whatever they last had.

const store = require('./configStore');
const { readMemory, readPointer } = require('./memoryReader');

const NEVER_GENERATE_FIELD_OFFSET = 0x1f0n;
const SLOTS_FIELD_OFFSET = 0x08n;
const COUNT_FIELD_OFFSET = 0x20n;
const SLOT_SIZE = 16;
const MAX_PLAUSIBLE_COUNT = 100000; // garbage-read guard, not a real game limit

let cfg = null;
let cfgLoaded = false;

function config() {
  if (!cfgLoaded) {
    cfgLoaded = true;
    const raw = store.load('singletons');
    const gm = raw && raw.types && raw.types['app.GenerateManager'];
    if (raw && gm && typeof gm.holderTypeIndex === 'number' && gm.instanceSlot != null) {
      cfg = {
        vmGlobalRva: BigInt(raw.vmGlobalRva),
        staticTblOffset: BigInt(raw.staticTblOffsetInVm),
        holderTypeIndex: gm.holderTypeIndex,
        instanceSlot: BigInt(gm.instanceSlot),
      };
    }
  }
  return cfg;
}

function guidToString(buf, off) {
  const d1 = buf.readUInt32LE(off).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(off + 4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(off + 6).toString(16).padStart(4, '0');
  const d4a = buf.toString('hex', off + 8, off + 10);
  const d4b = buf.toString('hex', off + 10, off + 16);
  return `${d1}-${d2}-${d3}-${d4a}-${d4b}`;
}

// -> Set<string> of collected GUIDs (lowercase, canonical form), or null. Never throws.
function read(handle, moduleBase) {
  const c = config();
  if (!c || !handle || moduleBase == null) return null;
  try {
    const vm = readPointer(handle, moduleBase + c.vmGlobalRva);
    if (vm === 0n) return null;
    const elements = readPointer(handle, vm + c.staticTblOffset);
    if (elements === 0n) return null;
    const statics = readPointer(handle, elements + BigInt(c.holderTypeIndex * 8));
    if (statics === 0n) return null;
    const instance = readPointer(handle, statics + c.instanceSlot);
    if (instance === 0n) return null;

    const hashSet = readPointer(handle, instance + 0x10n + NEVER_GENERATE_FIELD_OFFSET);
    if (hashSet === 0n) return null;
    const slots = readPointer(handle, hashSet + 0x10n + SLOTS_FIELD_OFFSET);
    if (slots === 0n) return null;
    const count = readMemory(handle, hashSet + 0x10n + COUNT_FIELD_OFFSET, 4).readInt32LE(0);
    if (!Number.isInteger(count) || count < 0 || count > MAX_PLAUSIBLE_COUNT) return null;
    if (count === 0) return new Set();

    const buf = readMemory(handle, slots + 0x20n, count * SLOT_SIZE);
    const guids = new Set();
    for (let i = 0; i < count; i++) {
      const o = i * SLOT_SIZE;
      const valPtr = buf.readBigUInt64LE(o + 8);
      if (valPtr === 0n) continue; // freed slot (next chain), not a live entry
      let peek;
      try { peek = readMemory(handle, valPtr + 0x10n, 16); } catch { continue; }
      guids.add(guidToString(peek, 0));
    }
    return guids;
  } catch {
    return null; // mid-load, wrong build, or the game just closed
  }
}

module.exports = { read };
