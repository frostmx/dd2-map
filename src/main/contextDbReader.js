// Collected Golden Trove Beetles, read from the game's persistent ContextDB — the
// beetle equivalent of tokens' _NeverGenetateID (generateManagerReader.js), and the same
// source gibbed's Almanac mod uses for save-wide/offline state. It is GLOBAL: it knows
// every beetle you've ever collected, near or far, surviving reloads.
//
// Why not the live beetle gimmick? A COLLECTED beetle doesn't respawn a gimmick at all —
// there's no object in the world to read a flag off. Collected-state only lives in the
// save-wide ContextDB. (See FINDINGS.md "Golden Trove Beetle collected-state" and the
// config/singletons.json beetleContextChain block for the full discovery.)
//
// The walk mirrors the mod's managed calls, out-of-process (all offsets in
// beetleContextChain; managed field base is +0x10 past each object header):
//
//   ContextDBMS instance +0x10+0x08          -> OfflineDB (== CurrentDB, a ContextDatabase)
//   ContextDatabase +0x10+0x18               -> IndexCreator
//   IndexCreator +0x10+0x00                  -> UniqueID2Keys (Dictionary<UniqueID, Key>)
//       _entries @ (dict+0x10+0x08 ->arr)+0x20, stride 24: {hash,next,keyPtr@8,valPtr@0x10}
//       keyPtr -> UniqueID;  UniqueID +0x10 = _RowID Guid (16B, .NET order)
//       valPtr -> ContextDatabaseKey;  +0x10 = KeyForSystem (i32)
//   ContextDatabase +0x10+0x08               -> Records (List<RecordInfo>)
//       Records._items+0x20, [KeyForSystem] -> RecordInfo;  +0x10+0x08 = the Record
//   ContextDatabaseRecord +0x10+0x00         -> Contexts (List): the element whose vtable
//       is app.GatherContext's is the beetle's gather record
//   GatherContext BYTE +0x28                 -> 0 = collected, 1 = available
//
// GatherContext's vtable value moves each launch, so it's resolved fresh from the TDB
// (types[typeIndex] +0x40) each call. A beetle GUID absent from UniqueID2Keys was never
// approached -> uncollected. read() returns a Set<string> of collected GUIDs among the
// wanted set, or null on any failure (soft-fail like the other readers).

const store = require('./configStore');
const { readMemory, readPointer } = require('./memoryReader');

const TYPE_ENTRY_SIZE = 0x48n;   // TDB RETypeDefVersion71 stride; managed_vt @ +0x40
const FB = 0x10n;                // managed field base: +0x10 past the object header
const MAX_DICT = 2000000;        // garbage-read guard on the dictionary entry count

let cfg = null;
let cfgLoaded = false;

function config() {
  if (!cfgLoaded) {
    cfgLoaded = true;
    const raw = store.load('singletons');
    const dbms = raw && raw.types && raw.types['app.ContextDBMS'];
    const gather = raw && raw.types && raw.types['app.GatherContext'];
    if (raw && dbms && typeof dbms.holderTypeIndex === 'number' && dbms.instanceSlot != null
      && gather && typeof gather.typeIndex === 'number') {
      cfg = {
        vmGlobalRva: BigInt(raw.vmGlobalRva),
        staticTblOffset: BigInt(raw.staticTblOffsetInVm),
        tdbOffset: BigInt(raw.tdbOffsetInVm),
        holderTypeIndex: dbms.holderTypeIndex,
        instanceSlot: BigInt(dbms.instanceSlot),
        gatherTypeIndex: BigInt(gather.typeIndex),
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

// -> Set<string> of collected GUIDs among `wantGuids` (a Set of lowercase GUID strings),
// or null. Never throws. Beetles absent from the DB are simply not in the returned set.
function read(handle, moduleBase, wantGuids) {
  const c = config();
  if (!c || !handle || moduleBase == null || !wantGuids || !wantGuids.size) return null;
  try {
    const vm = readPointer(handle, moduleBase + c.vmGlobalRva);
    if (vm === 0n) return null;

    // Resolve app.GatherContext's managed_vt live from the TDB (types[] @ tdb+0x60).
    const tdb = readPointer(handle, vm + c.tdbOffset);
    if (tdb === 0n) return null;
    const typesPtr = readPointer(handle, tdb + 0x60n);
    if (typesPtr === 0n) return null;
    const gatherVt = readPointer(handle, typesPtr + c.gatherTypeIndex * TYPE_ENTRY_SIZE + 0x40n);
    if (gatherVt === 0n) return null;

    // ContextDBMS singleton -> OfflineDB -> IndexCreator + Records.
    const elements = readPointer(handle, vm + c.staticTblOffset);
    if (elements === 0n) return null;
    const statics = readPointer(handle, elements + BigInt(c.holderTypeIndex * 8));
    if (statics === 0n) return null;
    const instance = readPointer(handle, statics + c.instanceSlot);
    if (instance === 0n) return null;
    const db = readPointer(handle, instance + FB + 0x08n);
    if (db === 0n) return null;
    const indexCreator = readPointer(handle, db + FB + 0x18n);
    const records = readPointer(handle, db + FB + 0x08n);
    if (indexCreator === 0n || records === 0n) return null;

    // UniqueID2Keys dictionary -> build the entries we care about.
    const dict = readPointer(handle, indexCreator + FB + 0x00n);
    if (dict === 0n) return null;
    const entriesArr = readPointer(handle, dict + FB + 0x08n);
    if (entriesArr === 0n) return null;
    const dictCount = readMemory(handle, dict + FB + 0x20n, 4).readInt32LE(0);
    if (!Number.isInteger(dictCount) || dictCount < 0 || dictCount > MAX_DICT) return null;
    if (dictCount === 0) return new Set();

    const recItems = readPointer(handle, records + FB + 0x00n);
    if (recItems === 0n) return null;

    const entries = readMemory(handle, entriesArr + 0x20n, dictCount * 24);
    const collected = new Set();
    for (let i = 0; i < dictCount; i++) {
      const o = i * 24;
      if (entries.readInt32LE(o) < -1) continue;          // free slot
      const keyPtr = entries.readBigUInt64LE(o + 8);      // UniqueID object
      if (keyPtr === 0n) continue;
      let kb;
      try { kb = readMemory(handle, keyPtr + FB, 16); } catch { continue; }
      const guid = guidToString(kb, 0);
      if (!wantGuids.has(guid)) continue;                 // not a beetle we care about

      // value -> ContextDatabaseKey.KeyForSystem -> Records[i] -> Record -> Contexts.
      const dbKey = entries.readBigUInt64LE(o + 0x10);
      if (dbKey === 0n) continue;
      const idx = readMemory(handle, dbKey + FB + 0x00n, 4).readInt32LE(0);
      if (idx < 0) continue;
      const recInfo = readPointer(handle, recItems + 0x20n + BigInt(idx * 8));
      if (recInfo === 0n) continue;
      const record = readPointer(handle, recInfo + FB + 0x08n);
      if (record === 0n) continue;
      const list = readPointer(handle, record + FB + 0x00n);      // Contexts List
      if (list === 0n) continue;
      const items = readPointer(handle, list + FB + 0x00n);
      const size = readMemory(handle, list + FB + 0x08n, 4).readInt32LE(0);
      if (items === 0n || size <= 0 || size > 64) continue;
      const arr = readMemory(handle, items + 0x20n, size * 8);
      for (let j = 0; j < size; j++) {
        const ctx = arr.readBigUInt64LE(j * 8);
        if (ctx === 0n) continue;
        let head;
        try { head = readMemory(handle, ctx, 8); } catch { continue; }
        if (head.readBigUInt64LE(0) !== gatherVt) continue;      // not the GatherContext
        const flag = readMemory(handle, ctx + 0x28n, 1).readUInt8(0);
        if (flag === 0) collected.add(guid);                     // 0 = collected
        break;
      }
    }
    return collected;
  } catch {
    return null;
  }
}

module.exports = { read };
