// The in-game clock, read straight out of app.TimeManager — the first consumer of the
// managed-singleton chain (FINDINGS.md "Managed singletons via pure RPM").
//
// Chain, from config/singletons.json (written by `tools/singletonHunt.js --save`):
//
//   DD2.exe + vmGlobalRva          -> via.clr.VM        (pattern-scanned once by the tool)
//   VM + staticTblOffsetInVm       -> { elements, size } per-type static field tables
//   elements[holderTypeIndex] + 8  -> the TimeManager instance
//                                     (the _Instance static lives on AppSingleton`1<T>,
//                                      NOT on the type itself — hence "holder")
//   instance + 0x20                -> _TimeData  (field base 0x10 + field offset 0x10)
//   TimeData + 0x2c (i32)          -> in-game day
//   TimeData + 0x40 (f32)          -> seconds into the day, wraps at 2880
//
// The clock constants are the game's own (TimeManager statics, read live 2026-07-17):
// a day is 2880 REAL seconds (48 minutes), an hour 120, a minute 2. So the decode is
// hh = daySec/120, mm = (daySec % 120)/2. The value freezes while the game pauses world
// time (menus, tutorials) — that's the game's clock behaving, not a stale read.
//
// Every read re-resolves the chain (4 pointer hops — same cost profile as the position
// chains, which also resolve per tick). Failure is soft: callers get null and show no
// clock this tick. Values outside the game's own ranges are treated as a failed read,
// never shown.

const store = require('./configStore');
const { readMemory, readPointer } = require('./memoryReader');

const DAY_SECONDS = 2880;   // TimeManager statics: InGameDaySeconds
const HOUR_SECONDS = 120;   //                      InGameHourSeconds
const MINUTE_SECONDS = 2;   //                      InGameMinuteSeconds

let cfg = null;             // parsed singletons.json, or null if absent/unusable
let cfgLoaded = false;

function config() {
  if (!cfgLoaded) {
    cfgLoaded = true;
    const raw = store.load('singletons');
    const tm = raw && raw.types && raw.types['app.TimeManager'];
    if (raw && tm && typeof tm.holderTypeIndex === 'number' && tm.instanceSlot != null) {
      cfg = {
        vmGlobalRva: BigInt(raw.vmGlobalRva),
        staticTblOffset: BigInt(raw.staticTblOffsetInVm),
        holderTypeIndex: tm.holderTypeIndex,
        instanceSlot: BigInt(tm.instanceSlot),
      };
    }
  }
  return cfg;
}

// -> { day, hh, mm } or null. Never throws.
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
    const timeData = readPointer(handle, instance + 0x20n);
    if (timeData === 0n) return null;
    const buf = readMemory(handle, timeData + 0x2cn, 0x18);
    const day = buf.readInt32LE(0);
    const daySec = buf.readFloatLE(0x14);
    if (!Number.isFinite(daySec) || daySec < 0 || daySec > DAY_SECONDS) return null;
    if (day < 0 || day > 1e6) return null;   // MaxGameDay is literally 1000000
    return {
      day,
      hh: Math.floor(daySec / HOUR_SECONDS),
      mm: Math.floor((daySec % HOUR_SECONDS) / MINUTE_SECONDS),
    };
  } catch {
    return null;   // mid-load, wrong build, or the game just closed — no clock this tick
  }
}

module.exports = { read };
