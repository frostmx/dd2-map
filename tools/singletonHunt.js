// Resolve RE Engine managed singletons out-of-process, with ReadProcessMemory only.
//
// This is REFramework's singleton resolution (shared/sdk/REContext.cpp, MIT, praydog)
// ported to RPM. Nothing in the chain executes game code — the in-process Lua
// `get_Instance()` call is just sugar over these same pointer reads:
//
//   1. Pattern-scan DD2.exe for `mov rcx, [rip+disp]` loading the via.clr.VM global
//      (48 8B 0D ?? ?? ?? ?? BA FF FF FF FF E8 / 48 8B 0D ?? ?? ?? ?? 83 CA FF E8).
//      The decoded target is a MODULE-STATIC address -> survives restarts by RVA.
//   2. Scan the VM object for a pointer to magic "TDB\0" (version 73 for DD2).
//   3. Walk back from that offset for two adjacent {ptr,count} arrays with equal
//      counts >= 2000: the per-type static-field tables (+ their init flags).
//   4. Parse the TDB (tdb73 layout): types[] @+0x60 (0x48/entry, RETypeDefVersion71),
//      typesImpl[] @+0x68 (0x30/entry, name/namespace string offsets), pool @+0xD0.
//      Find the wanted types by full name.
//   5. staticTbl.elements[type_index] -> that type's static slots. The slot whose
//      target's first qword equals the typedef's managed_vt (@+0x40) IS the singleton.
//
// Usage: node tools/singletonHunt.js [TypeName ...]     (DD2 must be running)
//   default types: app.GenerateManager app.TimeManager app.GimmickManager
//   --save     write resolved addresses/RVAs to config/singletons.json
//   --fields   also dump each type's TDB field table (name, type, static, offset)
//              with live values read from the resolved instance — identifying a
//              field is usually just reading its current value
//   --deref <TypeName> <fieldName>
//              resolve TypeName's instance, find fieldName's offset, dereference the
//              live pointer there, and dump THAT object's own field table (with live
//              values) the same way --fields does for a singleton. For reaching into
//              a non-singleton nested object (a collection field, a component, ...)
//              one hop at a time, without hand-computing offsets first.

const fs = require('fs');
const path = require('path');
const {
  findProcessIdByName, findModuleBase, openProcess, readMemory, readPointer, closeHandle,
} = require('../src/main/memoryReader');

const TDB_MAGIC = 0x00424454; // "TDB\0" little-endian
const TDB_VERSION = 73;       // DD2 (RETypeDefVersion71, TYPE_INDEX_BITS 19)
const TYPE_ENTRY_SIZE = 0x48;
const IMPL_ENTRY_SIZE = 0x30;

const DEFAULT_TYPES = ['app.GenerateManager', 'app.TimeManager', 'app.GimmickManager'];

// The two `mov rcx, [rip+disp32]` shapes REFramework scans for. offset 3 = disp32.
const PATTERNS = [
  { bytes: [0x48, 0x8B, 0x0D, -1, -1, -1, -1, 0xBA, 0xFF, 0xFF, 0xFF, 0xFF, 0xE8], name: 'BA FF..FF E8' },
  { bytes: [0x48, 0x8B, 0x0D, -1, -1, -1, -1, 0x83, 0xCA, 0xFF, 0xE8], name: '83 CA FF E8' },
];

function tryRead(handle, addr, size) {
  try { return readMemory(handle, addr, size); } catch { return null; }
}

// Scan the module image for every pattern match; -1 in the pattern is a wildcard.
function scanModule(handle, base, size, pattern) {
  const CHUNK = 4 << 20;
  const overlap = pattern.length - 1;
  const hits = [];
  for (let off = 0n; off < BigInt(size); off += BigInt(CHUNK - overlap)) {
    const want = Math.min(CHUNK, size - Number(off));
    if (want < pattern.length) break;
    const buf = tryRead(handle, base + off, want);
    if (!buf) continue; // unreadable region (guard pages etc.) — skip
    outer:
    for (let i = 0; i <= buf.length - pattern.length; i++) {
      if (buf[i] !== pattern[0]) continue;
      for (let j = 1; j < pattern.length; j++) {
        if (pattern[j] !== -1 && buf[i + j] !== pattern[j]) continue outer;
      }
      hits.push(base + off + BigInt(i));
    }
  }
  return hits;
}

// mov rcx, [rip+disp]: target = instruction_addr + 7 + disp32
function ripTarget(handle, insnAddr) {
  const buf = tryRead(handle, insnAddr + 3n, 4);
  if (!buf) return null;
  return insnAddr + 7n + BigInt(buf.readInt32LE(0));
}

// Step 2: find the TDB pointer inside the VM object. Returns { tdb, tdbOffset }.
function findTdbInVm(handle, vm) {
  for (let winStart = 0; winStart < 0x20000; winStart += 0x8000) {
    const win = tryRead(handle, vm + BigInt(winStart), 0x8000);
    if (!win) continue;
    for (let i = 0; i < win.length; i += 8) {
      const ptr = win.readBigUInt64LE(i);
      if (ptr === 0n || (ptr & 7n) !== 0n) continue;
      const head = tryRead(handle, ptr, 8);
      if (!head) continue;
      if (head.readUInt32LE(0) === TDB_MAGIC && head.readUInt32LE(4) === TDB_VERSION) {
        return { tdb: ptr, tdbOffset: winStart + i };
      }
    }
  }
  return null;
}

// Step 3: the static tables sit a little before the TDB pointer in the VM: two
// adjacent {ptr, count} arrays (values + "initialized" flags) with equal counts.
function findStaticTbl(handle, vm, tdbOffset) {
  const win = tryRead(handle, vm + BigInt(tdbOffset - 0x110), 0x120);
  if (!win) return null;
  const at = (o) => 0x110 - (tdbOffset - o); // VM offset -> window index
  for (let i = 8; i < 0x100; i += 8) {
    const o = tdbOffset - i;
    if (at(o) < 0x10) break;
    const ptr = win.readBigUInt64LE(at(o));
    const count = win.readUInt32LE(at(o) + 8);
    if (ptr === 0n || (ptr & 7n) !== 0n || count < 2000 || count > 9999999) continue;
    const prevO = o - 0x10;
    const prevPtr = win.readBigUInt64LE(at(prevO));
    const prevCount = win.readUInt32LE(at(prevO) + 8);
    if (prevCount === count && prevPtr !== 0n && (prevPtr & 7n) === 0n) {
      return { staticTblOffset: prevO, elements: prevPtr, size: prevCount };
    }
  }
  // REFramework's default guess when the heuristic finds nothing:
  const o = tdbOffset - 0x30;
  const ptr = win.readBigUInt64LE(at(o));
  const count = win.readUInt32LE(at(o) + 8);
  if (ptr !== 0n && count >= 2000) return { staticTblOffset: o, elements: ptr, size: count };
  return null;
}

// Step 4: bulk-read the TDB arrays and find the wanted types by full name.
function findTypes(handle, tdb, wanted) {
  const hdr = tryRead(handle, tdb, 0xE8);
  if (!hdr) throw new Error('cannot read TDB header');
  const numTypes = hdr.readUInt32LE(0x08);
  const numTypeImpl = hdr.readUInt32LE(0x18);
  const numStringPool = hdr.readUInt32LE(0x50);
  const typesPtr = hdr.readBigUInt64LE(0x60);
  const implPtr = hdr.readBigUInt64LE(0x68);
  const poolPtr = hdr.readBigUInt64LE(0xD0);
  console.log(`TDB: ${numTypes} types, ${numTypeImpl} impls, string pool ${numStringPool} bytes`);

  const readBig = (addr, size) => {
    const buf = Buffer.alloc(size);
    const CHUNK = 8 << 20;
    for (let o = 0; o < size; o += CHUNK) {
      const part = tryRead(handle, addr + BigInt(o), Math.min(CHUNK, size - o));
      if (!part) throw new Error(`bulk read failed at +0x${o.toString(16)}`);
      part.copy(buf, o);
    }
    return buf;
  };
  const types = readBig(typesPtr, numTypes * TYPE_ENTRY_SIZE);
  const impls = readBig(implPtr, numTypeImpl * IMPL_ENTRY_SIZE);
  const pool = readBig(poolPtr, numStringPool);

  const cstr = (off) => {
    if (off <= 0 || off >= pool.length) return '';
    const end = pool.indexOf(0, off);
    return pool.toString('utf8', off, end === -1 ? off : end);
  };

  const found = {};
  const want = new Set(wanted);
  for (let i = 0; i < numTypes && want.size > 0; i++) {
    const o = i * TYPE_ENTRY_SIZE;
    // RETypeDefVersion71 qword1: array:19 | element:19 | impl_index:18 | system:7
    const q1 = types.readBigUInt64LE(o + 8);
    const implIndex = Number((q1 >> 38n) & 0x3FFFFn);
    if (implIndex === 0 || implIndex >= numTypeImpl) continue;
    const io = implIndex * IMPL_ENTRY_SIZE;
    const name = cstr(impls.readInt32LE(io));
    if (!name) continue;
    const ns = cstr(impls.readInt32LE(io + 4));
    const full = ns ? `${ns}.${name}` : name;
    if (!want.has(full)) continue;
    want.delete(full);
    const q0 = types.readBigUInt64LE(o);
    found[full] = {
      typeIndex: Number(q0 & 0x7FFFFn),          // index:19 — should equal i
      arrayPos: i,
      parentTypeId: Number((q0 >> 19n) & 0x7FFFFn),
      staticFieldSize: impls.readInt32LE(io + 0x0C),
      managedVt: types.readBigUInt64LE(o + 0x40),
    };
  }
  // resolver for walking parent chains later (singletons store _Instance on their
  // app.SingletonBehavior<T> base, not on themselves)
  const typeAt = (idx) => {
    if (idx <= 0 || idx >= numTypes) return null;
    const o = idx * TYPE_ENTRY_SIZE;
    const q0 = types.readBigUInt64LE(o);
    const q1 = types.readBigUInt64LE(o + 8);
    const implIndex = Number((q1 >> 38n) & 0x3FFFFn);
    const io = implIndex * IMPL_ENTRY_SIZE;
    const name = implIndex > 0 && implIndex < numTypeImpl ? cstr(impls.readInt32LE(io)) : '?';
    return {
      typeIndex: Number(q0 & 0x7FFFFn),
      parentTypeId: Number((q0 >> 19n) & 0x7FFFFn),
      staticFieldSize: implIndex > 0 && implIndex < numTypeImpl ? impls.readInt32LE(io + 0x0C) : 0,
      managedVt: types.readBigUInt64LE(o + 0x40),
      name,
    };
  };
  return { found, typeAt, typesBuf: types, implsBuf: impls, cstr };
}

// --fields: dump a type's TDB field table. tdb73 layouts:
//   REField (8B):    declaring_typeid:19 | impl_id:19 | field_typeid:19 | init:6 | :1
//   REFieldImpl (12B): attributes_id u16; { unk:1 | flags:15 } u16;
//                      { offset:26 | init_lo:6 } u32; { name_offset:28 | init_mid:4 } u32
// Fields of a type: REField[member_field .. +num_member_fields) — typedef v71 keeps
// member_field in qword@0x20 bits 44..62, RETypeImpl keeps the count in qword@0x10
// bits 33..56. FieldFlag.Static = 0x10.
// Decode a type's REField[] into plain JS objects — no printing, no live reads.
// Kept separate from dumpFields (which prints) so --deref can look up one field by
// name and get its raw fieldTypeId (needed to resolve the field's OWN type via
// typeAt for the next hop) without dumpFields having thrown that id away.
function readFields(handle, tdb, t, typesBuf, implsBuf, cstr) {
  const hdr = readMemory(handle, tdb, 0xE8);
  const numFieldImpl = hdr.readUInt32LE(0x1C);
  const fieldsPtr = hdr.readBigUInt64LE(0x80);
  const fieldImplPtr = hdr.readBigUInt64LE(0x88);

  const to = t.arrayPos * TYPE_ENTRY_SIZE;
  const q20 = typesBuf.readBigUInt64LE(to + 0x20);
  const memberField = Number((q20 >> 44n) & 0x7FFFFn);
  const io = // impl entry of this type, for the field count
    Number((typesBuf.readBigUInt64LE(to + 8) >> 38n) & 0x3FFFFn) * IMPL_ENTRY_SIZE;
  const q10 = implsBuf.readBigUInt64LE(io + 0x10);
  const numMember = Number((q10 >> 33n) & 0xFFFFFFn);
  if (!numMember) return { numMember, memberField, out: [] };

  const fbuf = tryRead(handle, fieldsPtr + BigInt(memberField * 8), numMember * 8);
  if (!fbuf) return { numMember, memberField, out: null };
  const out = [];
  for (let i = 0; i < numMember; i++) {
    const q = fbuf.readBigUInt64LE(i * 8);
    const implId = Number((q >> 19n) & 0x7FFFFn);
    const fieldTypeId = Number((q >> 38n) & 0x7FFFFn);
    if (implId <= 0 || implId >= numFieldImpl) continue;
    const impl = tryRead(handle, fieldImplPtr + BigInt(implId * 12), 12);
    if (!impl) continue;
    const flags = (impl.readUInt16LE(2) >> 1) & 0x7FFF;
    const offset = impl.readUInt32LE(4) & 0x3FFFFFF;
    const nameOff = impl.readUInt32LE(8) & 0xFFFFFFF;
    const name = cstr(nameOff);
    const isStatic = (flags & 0x10) !== 0;
    out.push({ name, offset, isStatic, fieldTypeId });
  }
  return { numMember, memberField, out };
}

function dumpFields(handle, tdb, t, typesBuf, implsBuf, cstr, typeAt, instance) {
  const { numMember, memberField, out: fields } = readFields(handle, tdb, t, typesBuf, implsBuf, cstr);
  console.log(`  fields: ${numMember} starting at REField[${memberField}]`);
  if (!numMember) return [];
  if (fields === null) { console.log('  cannot read field table'); return []; }
  const out = [];
  for (const { name, offset, isStatic, fieldTypeId } of fields) {
    const ftype = typeAt(fieldTypeId);
    let live = '';
    if (!isStatic && instance) {
      // fieldptr base on managed objects is +0x10 past the header in RE Engine
      const v = tryRead(handle, instance + 0x10n + BigInt(offset), 8);
      if (v) {
        live = `  = i32:${v.readInt32LE(0)} f32:${v.readFloatLE(0).toPrecision(6)} f64:${v.readDoubleLE(0).toPrecision(10)}`;
      }
    }
    console.log(`    +0x${offset.toString(16).padStart(3, '0')}${isStatic ? ' [static]' : '         '} ${name}: ${ftype ? ftype.name : fieldTypeId}${live}`);
    out.push({ name, offset, isStatic, fieldTypeId, type: ftype ? ftype.name : String(fieldTypeId) });
  }
  return out;
}

// Step 5: read the type's static slots; the slot pointing at an object whose first
// qword is the typedef's managed_vt is the singleton instance.
function findInstance(handle, staticTbl, t) {
  if (t.typeIndex >= staticTbl.size) return { slots: [], instance: null };
  const slotTblPtr = readPointer(handle, staticTbl.elements + BigInt(t.typeIndex * 8));
  if (slotTblPtr === 0n) return { slots: [], instance: null };
  const size = Math.max(t.staticFieldSize, 8);
  const buf = tryRead(handle, slotTblPtr, size);
  if (!buf) return { slots: [], instance: null };
  const slots = [];
  let instance = null;
  for (let o = 0; o + 8 <= buf.length; o += 8) {
    const p = buf.readBigUInt64LE(o);
    if (p === 0n || (p & 7n) !== 0n) continue;
    const head = tryRead(handle, p, 8);
    if (!head) continue;
    const vt = head.readBigUInt64LE(0);
    const isInstance = t.managedVt !== 0n && vt === t.managedVt;
    slots.push({ offset: o, ptr: p, vt, isInstance });
    if (isInstance && instance === null) instance = { offset: o, ptr: p };
  }
  return { slotTblPtr, slots, instance };
}

function main() {
  const argv = process.argv.slice(2);
  const save = argv.includes('--save');
  const fields = argv.includes('--fields');
  const derefIdx = argv.indexOf('--deref');
  const deref = derefIdx !== -1 ? { typeName: argv[derefIdx + 1], fieldName: argv[derefIdx + 2] } : null;
  if (deref && (!deref.typeName || !deref.fieldName)) {
    console.error('--deref needs a TypeName and a fieldName: --deref app.GenerateManager _NeverGenetateID');
    process.exit(1);
  }
  const args = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (deref && (i === derefIdx + 1 || i === derefIdx + 2)) return false; // consumed by --deref
    return true;
  });
  const wanted = deref ? [deref.typeName] : (args.length ? args : DEFAULT_TYPES);

  const pid = findProcessIdByName('DD2.exe');
  if (!pid) { console.error('DD2.exe is not running'); process.exit(1); }
  const modRaw = findModuleBase(pid, 'DD2.exe');
  const mod = { base: BigInt(modRaw.base), size: Number(modRaw.size) };
  const handle = openProcess(pid);
  console.log(`DD2.exe pid ${pid}, base 0x${mod.base.toString(16)}, size 0x${mod.size.toString(16)}`);

  try {
    // 1. VM global
    let vmGlobal = null, vm = null;
    for (const pat of PATTERNS) {
      const hits = scanModule(handle, mod.base, mod.size, pat.bytes);
      console.log(`pattern [${pat.name}]: ${hits.length} hit(s)`);
      for (const hit of hits) {
        const target = ripTarget(handle, hit);
        if (target === null) continue;
        if (target < mod.base || target >= mod.base + BigInt(mod.size)) continue; // must be module-static
        let ptr; try { ptr = readPointer(handle, target); } catch { continue; }
        if (ptr === 0n || (ptr & 7n) !== 0n) continue;
        const tdbHit = findTdbInVm(handle, ptr);
        if (!tdbHit) continue;
        vmGlobal = target; vm = ptr;
        console.log(`VM global: DD2.exe+0x${(target - mod.base).toString(16)} -> VM 0x${ptr.toString(16)}`);
        console.log(`TDB: VM+0x${tdbHit.tdbOffset.toString(16)} -> 0x${tdbHit.tdb.toString(16)} (version ${TDB_VERSION})`);

        // 2-3. static tables
        const staticTbl = findStaticTbl(handle, vm, tdbHit.tdbOffset);
        if (!staticTbl) { console.error('static table not found'); continue; }
        console.log(`static tbl: VM+0x${staticTbl.staticTblOffset.toString(16)} -> 0x${staticTbl.elements.toString(16)} (${staticTbl.size} entries)`);

        // 4. types
        const { found, typeAt, typesBuf, implsBuf, cstr } = findTypes(handle, tdbHit.tdb, wanted);
        const out = {
          exe: 'DD2.exe', tdbVersion: TDB_VERSION,
          vmGlobalRva: '0x' + (vmGlobal - mod.base).toString(16),
          tdbOffsetInVm: '0x' + tdbHit.tdbOffset.toString(16),
          staticTblOffsetInVm: '0x' + staticTbl.staticTblOffset.toString(16),
          types: {},
        };
        for (const name of wanted) {
          const t = found[name];
          if (!t) { console.log(`\n${name}: NOT FOUND in TDB`); continue; }
          console.log(`\n${name}: type_index ${t.typeIndex}${t.typeIndex !== t.arrayPos ? ` (array pos ${t.arrayPos}!)` : ''}, static block 0x${t.staticFieldSize.toString(16)} bytes, managed_vt 0x${t.managedVt.toString(16)}`);
          // 5. instance: the _Instance static lives on the type itself OR on an
          // ancestor (app.SingletonBehavior<T>). Walk up, matching the DERIVED
          // type's managed_vt at every level.
          let r = null, holder = t, level = 0;
          for (let cur = t; cur && level < 5; cur = typeAt(cur.parentTypeId), level++) {
            if (cur.parentTypeId === cur.typeIndex) break; // root
            const probe = findInstance(handle, staticTbl, { ...cur, managedVt: t.managedVt });
            if (level === 0 || (probe.slots.length && !r?.instance)) { r = probe; holder = cur; }
            if (probe.instance) { r = probe; holder = cur; break; }
          }
          if (holder !== t) console.log(`  (statics of ancestor '${holder.name}', type_index ${holder.typeIndex})`);
          for (const s of (r?.slots || [])) {
            console.log(`  static slot +0x${s.offset.toString(16).padStart(2, '0')}: 0x${s.ptr.toString(16)}  vt=0x${s.vt.toString(16)}${s.isInstance ? '  <-- INSTANCE' : ''}`);
          }
          if (r?.instance) {
            console.log(`  INSTANCE: 0x${r.instance.ptr.toString(16)} (slot +0x${r.instance.offset.toString(16)})`);
            const peek = tryRead(handle, r.instance.ptr, 0x60);
            if (peek) console.log(`  first 0x60 bytes:\n    ${peek.toString('hex').replace(/(.{32})/g, '$1\n    ')}`);
          } else {
            console.log('  no slot matched managed_vt — inspect slots above by hand');
          }
          out.types[name] = {
            typeIndex: t.typeIndex,
            holderTypeIndex: holder.typeIndex,
            staticFieldSize: t.staticFieldSize,
            instance: r?.instance ? '0x' + r.instance.ptr.toString(16) : null,
            instanceSlot: r?.instance ? r.instance.offset : null,
          };
          if (fields) {
            out.types[name].fields = dumpFields(
              handle, tdbHit.tdb, t, typesBuf, implsBuf, cstr, typeAt,
              r?.instance ? r.instance.ptr : null);
          }
          if (deref && name === deref.typeName) {
            if (!r?.instance) {
              console.log(`  cannot --deref: no live instance resolved for ${name}`);
            } else {
              const { out: flds } = readFields(handle, tdbHit.tdb, t, typesBuf, implsBuf, cstr);
              const f = (flds || []).find((x) => x.name === deref.fieldName);
              if (!f) {
                console.log(`  --deref: field '${deref.fieldName}' not found on ${name}`);
              } else if (f.isStatic) {
                console.log(`\n--deref ${name}.${f.name}: +0x${f.offset.toString(16)} [static] — read from the type's own static slot table, not the instance (not implemented; rerun with --fields to see static slots)`);
              } else {
                console.log(`\n--deref ${name}.${f.name}: +0x${f.offset.toString(16)}`);
                const childPtr = readPointer(handle, r.instance.ptr + 0x10n + BigInt(f.offset));
                console.log(`  live pointer: 0x${childPtr.toString(16)}`);
                if (childPtr === 0n) {
                  console.log('  null — field not yet initialized (no save loaded? wrong offset?)');
                } else {
                  const childType = typeAt(f.fieldTypeId);
                  if (!childType) {
                    console.log(`  field's declared type (id ${f.fieldTypeId}) did not resolve`);
                  } else {
                    console.log(`  target type: ${childType.name} (type_index ${childType.typeIndex})`);
                    const peek = tryRead(handle, childPtr, 0x60);
                    if (peek) console.log(`  first 0x60 bytes:\n    ${peek.toString('hex').replace(/(.{32})/g, '$1\n    ')}`);
                    dumpFields(handle, tdbHit.tdb, { ...childType, arrayPos: f.fieldTypeId },
                      typesBuf, implsBuf, cstr, typeAt, childPtr);
                  }
                }
              }
            }
          }
        }
        if (save) {
          const file = path.join(__dirname, '..', 'config', 'singletons.json');
          fs.writeFileSync(file, JSON.stringify(out, null, 2));
          console.log(`\nsaved ${file}`);
        }
        return;
      }
    }
    if (!vm) console.error('VM global not found — no pattern hit validated (is this really DD2, TDB 73?)');
  } finally {
    closeHandle(handle);
  }
}

main();
