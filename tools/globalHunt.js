// Hunt the GLOBAL (absolute) player coordinate -- single auto-phased process.
//
// Key identity: between boundary crossings the cell index k is constant, so
//     global = k*128 + local   =>   d(global) == d(local)   EXACTLY.
// Nothing else in the process moves by exactly the player's delta. That filter
// collapses all of memory to "copies of the player coordinate".
// Then at a boundary: local SNAPS ~128, a global coord does NOT. That separates them.
//
// Scans are only taken while you STAND STILL (a sweep takes seconds; sampling
// while moving breaks exact matching). The script detects stillness itself.
//
// WHAT YOU DO:
//   1. Stand still  -> it takes the baseline.
//   2. Walk 10-40 units in a straight line, then STOP  -> it filters (repeat as offered).
//   3. Walk across a BOUNDARY (coord snaps), then STOP -> it reports the global candidates.
//
// Implementation notes: candidates live in chunked typed arrays (a single JS
// array overflows at this scale -- that was the "Invalid array length" crash),
// and regions are swept in ascending address order so the list is already
// sorted, which lets re-reads sweep 64KB windows in one pass with no sort.

const koffi = require('koffi');
const { findProcessIdByName, findModuleBase, openProcess, readMemory } = require('../src/main/memoryReader');

const kernel32 = koffi.load('kernel32.dll');
const MBI = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uintptr_t', AllocationBase: 'uintptr_t', AllocationProtect: 'uint32',
  PartitionId: 'uint16', RegionSize: 'size_t', State: 'uint32', Protect: 'uint32', Type: 'uint32',
});
const VirtualQueryEx = kernel32.func('size_t VirtualQueryEx(void *hProcess, uintptr_t lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, size_t dwLength)');
const RPM = kernel32.func('bool ReadProcessMemory(void *hProcess, uintptr_t lpBaseAddress, _Out_ uint8 *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)');

const MEM_COMMIT = 0x1000, MEM_PRIVATE = 0x20000;
const PAGE_RW = 0x04, PAGE_ERW = 0x40, PAGE_GUARD = 0x100;

const STATIC_A = 0x0fa65f70n;   // clean local: x@+0, h@+4, y@+8 (re-centers to 0)
const WIN = 1 << 16;
const TOL = 0.003;              // lockstep tolerance (float32 rounding)
const SNAP_MIN = 60;
const MIN_ABS = 0.5, MAX_ABS = 1e6;

const STILL_EPS = 0.01;         // per-tick movement below this = standing still
const STILL_TICKS = 12;         // ~1.2s of stillness
const MOVE_MIN = 3;             // must have moved at least this far to filter

// Snaps are detected PER TICK (a 128 jump in 100ms). Comparing anchor-to-stop
// instead was a bug: a plain 72-unit walk tripped the threshold and got
// misread as a boundary crossing.
//
// Each snap is exactly +/-128 (measured), so we can recover the player's TRUE
// displacement across a walk that contained crossings:
//     trueDelta = localDelta - (sum of snap amounts)
// A LOCAL copy moves by localDelta. A GLOBAL coord moves by trueDelta. At a
// crossing those differ by 128, which separates them cleanly.
let snapSumX = 0, snapSumY = 0, sawSnap = false;
const snapAmount = (d) => 128 * Math.round(d / 128);

// ---- chunked candidate store (avoids single-array limits) ------------------
const CAP = 1 << 22; // 4M per chunk
class Store {
  constructor() { this.aChunks = []; this.vChunks = []; this.tChunks = []; this.n = 0; this._fill = CAP; }
  push(addr, val, tag = 0) {
    if (this._fill === CAP) {
      this.aChunks.push(new Float64Array(CAP));
      this.vChunks.push(new Float32Array(CAP));
      this.tChunks.push(new Int8Array(CAP));
      this._fill = 0;
    }
    const c = this.aChunks.length - 1;
    this.aChunks[c][this._fill] = addr;
    this.vChunks[c][this._fill] = val;
    this.tChunks[c][this._fill] = tag;   // 1=X  -1=-X  2=Y  -2=-Y
    this._fill++; this.n++;
  }
  addr(i) { return this.aChunks[(i / CAP) | 0][i % CAP]; }
  val(i) { return this.vChunks[(i / CAP) | 0][i % CAP]; }
  tag(i) { return this.tChunks[(i / CAP) | 0][i % CAP]; }
  get length() { return this.n; }
}
const TAGNAME = { 1: 'X', '-1': '-X', 2: 'Y', '-2': '-Y', 0: '?' };

function enumRegions(h) {
  const out = [];
  let addr = 0n; const mbi = {};
  for (;;) {
    if (VirtualQueryEx(h, addr, mbi, koffi.sizeof(MBI)) === 0) break;
    const p = mbi.Protect >>> 0;
    const rw = (p === PAGE_RW || p === PAGE_ERW) && !(p & PAGE_GUARD);
    if (mbi.State === MEM_COMMIT && mbi.Type === MEM_PRIVATE && rw) {
      out.push({ base: BigInt(mbi.BaseAddress), size: Number(mbi.RegionSize) });
    }
    addr = BigInt(mbi.BaseAddress) + (BigInt(mbi.RegionSize) || 0x1000n);
    if (addr <= 0n) break;
  }
  return out; // ascending -> candidate list comes out pre-sorted
}

function fullScan(h) {
  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK);
  const st = new Store();
  for (const r of enumRegions(h)) {
    let off = 0;
    while (off < r.size) {
      const size = Math.min(CHUNK, r.size - off);
      if (RPM(h, r.base + BigInt(off), buf, size, [0])) {
        const rb = Number(r.base);
        for (let i = 0; i + 4 <= size; i += 4) {
          const v = buf.readFloatLE(i);
          if (!Number.isFinite(v)) continue;
          const a = v < 0 ? -v : v;
          if (a < MIN_ABS || a > MAX_ABS) continue;
          st.push(rb + off + i, v);
        }
      }
      off += size;
    }
  }
  return st;
}

// sequential windowed re-read; assumes st addresses ascending
function reread(h, st) {
  const out = new Float64Array(st.length);
  const buf = Buffer.alloc(WIN);
  let i = 0;
  while (i < st.length) {
    const start = Math.floor(st.addr(i) / WIN) * WIN;
    const ok = RPM(h, BigInt(start), buf, WIN, [0]);
    while (i < st.length && st.addr(i) < start + WIN) {
      const o = st.addr(i) - start;
      out[i] = (ok && o + 4 <= WIN) ? buf.readFloatLE(o) : NaN;
      i++;
    }
  }
  return out;
}

// ---- main ------------------------------------------------------------------
const pid = findProcessIdByName('DD2.exe');
if (!pid) throw new Error('DD2.exe not running');
const h = openProcess(pid);
const base = BigInt(findModuleBase(pid, 'DD2.exe').base);
const readLocal = () => {
  const b = readMemory(h, base + STATIC_A, 12);
  return { x: b.readFloatLE(0), y: b.readFloatLE(8) };
};

let store = null;
let anchor = null;      // local coords when the current baseline was taken
let baselineDone = false;
let stillCount = 0;
let prev = readLocal();
let round = 0;
let loop = null;

console.log('=== GLOBAL COORD HUNT ===');
console.log('STAND STILL. Baseline will be taken automatically...\n');
startLoop();

function startLoop() {
  prev = readLocal();
  stillCount = 0;
  loop = setInterval(onTick, 100);
}

function onTick() {
  let cur;
  try { cur = readLocal(); } catch { return; }

  const tx = cur.x - prev.x, ty = cur.y - prev.y;

  // PER-TICK snap detection (the fix). Record the exact 128 multiple removed.
  if (Math.abs(tx) > SNAP_MIN) { snapSumX += snapAmount(tx); sawSnap = true; console.log(`    [snap X ${tx.toFixed(1)}]`); }
  if (Math.abs(ty) > SNAP_MIN) { snapSumY += snapAmount(ty); sawSnap = true; console.log(`    [snap Y ${ty.toFixed(1)}]`); }

  const still = Math.abs(tx) < STILL_EPS && Math.abs(ty) < STILL_EPS;
  prev = cur;
  stillCount = still ? stillCount + 1 : 0;

  if (!baselineDone) {
    if (stillCount < STILL_TICKS) return;
    clearInterval(loop);
    console.log(`Local: x=${cur.x.toFixed(3)} y=${cur.y.toFixed(3)}  — scanning (hold still)...`);
    const t0 = Date.now();
    store = fullScan(h);
    anchor = cur;
    baselineDone = true;
    snapSumX = snapSumY = 0; sawSnap = false;
    console.log(`Baseline: ${store.length.toLocaleString()} candidates in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    console.log('>>> NOW WALK 10-40 UNITS IN A STRAIGHT LINE, THEN STOP.\n');
    startLoop();
    return;
  }

  const dist = Math.max(Math.abs(cur.x - anchor.x), Math.abs(cur.y - anchor.y));
  if (dist < MOVE_MIN && !sawSnap) return;
  if (stillCount < STILL_TICKS) return;
  clearInterval(loop);
  doFilter(cur);
  startLoop();
}

function doFilter(cur) {
  round++;
  const locDX = cur.x - anchor.x;              // how the LOCAL coord moved
  const locDY = cur.y - anchor.y;
  const trueDX = locDX - snapSumX;             // how the player ACTUALLY moved
  const trueDY = locDY - snapSumY;
  const crossed = sawSnap;

  console.log(`--- round ${round}: local dX=${locDX.toFixed(3)} dY=${locDY.toFixed(3)}` +
    (crossed ? `  |  TRUE dX=${trueDX.toFixed(3)} dY=${trueDY.toFixed(3)}   *** CROSSED ***` : ''));

  const now = reread(h, store);

  if (!crossed) {
    // no crossing: local == true, so every coordinate copy moves the same way.
    const next = new Store();
    let nX = 0, nY = 0;
    for (let i = 0; i < store.length; i++) {
      const d = now[i] - store.val(i);
      if (!Number.isFinite(d)) continue;
      let tag = 0;
      if (Math.abs(d - locDX) < TOL) tag = 1;
      else if (Math.abs(d + locDX) < TOL) tag = -1;
      else if (Math.abs(d - locDY) < TOL) tag = 2;
      else if (Math.abs(d + locDY) < TOL) tag = -2;
      if (!tag) continue;
      next.push(store.addr(i), now[i], tag);
      if (Math.abs(tag) === 1) nX++; else nY++;
    }
    store = next;
    anchor = cur;
    snapSumX = snapSumY = 0; sawSnap = false;
    console.log(`    survivors: ${store.length.toLocaleString()}  (X-like ${nX}, Y-like ${nY})`);
    if (store.length && store.length <= 80) dumpAll();
    if (store.length === 0) { console.log('\n    Nothing tracks the player. Aborting.'); process.exit(0); }
    console.log('\n>>> Walk + stop again to narrow, OR cross a BOUNDARY and stop to finish.\n');
    return;
  }

  // CROSSED: a LOCAL copy moved by locD; a GLOBAL coord moved by trueD (the real
  // displacement), which differs from locD by the 128-multiple that was removed.
  // Works with OR without prior lockstep tags: we just test both axes' true
  // deltas directly. Only globals (few) are collected as objects; everything
  // else is counted, so this stays memory-safe even against the full baseline.
  const globals = [];
  let nLocal = 0, nOther = 0;
  const TOL2 = 0.35;
  const xDistinct = Math.abs(trueDX - locDX) > 1; // an X crossing happened
  const yDistinct = Math.abs(trueDY - locDY) > 1;
  for (let i = 0; i < store.length; i++) {
    const d = now[i] - store.val(i);
    if (!Number.isFinite(d)) continue;
    let isGlobal = false;
    if (xDistinct && (Math.abs(d - trueDX) < TOL2 || Math.abs(d + trueDX) < TOL2)) isGlobal = true;
    else if (yDistinct && (Math.abs(d - trueDY) < TOL2 || Math.abs(d + trueDY) < TOL2)) isGlobal = true;
    if (isGlobal) {
      globals.push({ addr: store.addr(i), before: store.val(i), after: now[i], d });
    } else if (Math.abs(Math.abs(d) - Math.abs(locDX)) < TOL2 || Math.abs(Math.abs(d) - Math.abs(locDY)) < TOL2) {
      nLocal++;
    } else {
      nOther++;
    }
  }

  console.log(`\n    LOCAL copies (snapped with the origin): ${nLocal}`);
  console.log(`    *** GLOBAL (tracked TRUE movement):     ${globals.length} ***`);
  console.log(`    unclassified:                           ${nOther}\n`);

  for (const g of globals.slice(0, 40)) {
    const rel = BigInt(g.addr) - base;
    const mod = (rel > 0n && rel < 0x20000000n) ? `   DD2.exe+${rel.toString(16).toUpperCase()}` : '';
    console.log(`  GLOBAL  0x${g.addr.toString(16).padEnd(11)} ${g.before.toFixed(3).padStart(12)} -> ${g.after.toFixed(3).padStart(12)}  d=${g.d.toFixed(3).padStart(8)}${mod}`);
  }
  if (globals.length === 0) {
    console.log('  (none — every copy snapped with the origin, so DD2 keeps NO absolute');
    console.log('   coordinate live in memory. The cell index is then the only route.)');
  }
  process.exit(0);
}

function dumpAll() {
  console.log('');
  for (let i = 0; i < store.length; i++) {
    const rel = BigInt(store.addr(i)) - base;
    const mod = (rel > 0n && rel < 0x20000000n) ? `   DD2.exe+${rel.toString(16).toUpperCase()}` : '';
    console.log(`  0x${store.addr(i).toString(16).padEnd(11)} = ${store.val(i).toFixed(3).padStart(12)}  [${TAGNAME[store.tag(i)]}]${mod}`);
  }
}
