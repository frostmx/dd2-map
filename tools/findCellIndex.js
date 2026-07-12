// Hunt for the CELL INDEX (or cell ORIGIN) by intersecting boundary crossings.
//
// The ONLY filter that discriminates: at the instant the local coord snaps ~128,
// the cell index for THAT axis steps by exactly +/-1 (or the origin by +/-128).
// Everything else in the process either doesn't move at that instant or doesn't
// move by exactly 1.
//
// (An earlier version also tried "must stay constant while walking". That prunes
// almost nothing -- most integer floats in a game are static asset data, which
// trivially passes -- while costing a full re-read every tick. Removed.)
//
// X and Y are tracked as SEPARATE candidate lists so an X crossing narrows only
// the X-index list. Each further crossing on an axis intersects that list again,
// so 2-3 crossings per axis should collapse it to a handful.
//
// Usage: node src/main/findCellIndex.js
//   Cross a boundary. Then cross another. Then another. Survivors print each time.
//   Ctrl+C when the list is small.

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

const STATIC_A = 0x0fa65f70n; // clean local coord: x@+0, h@+4, y@+8 (re-centers to 0)
const SNAP_MIN = 60;
const WIN = 1 << 16;
const MIN_ABS = 2, MAX_ABS = 200000; // exclude 0/+-1 (process-wide noise)

function enumRegions(h) {
  const out = [];
  let addr = 0n;
  const mbi = {};
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
  return out;
}

function snapshot(h) {
  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK);
  const addrs = [], vals = [];
  for (const r of enumRegions(h)) {
    let off = 0;
    while (off < r.size) {
      const size = Math.min(CHUNK, r.size - off);
      if (RPM(h, r.base + BigInt(off), buf, size, [0])) {
        for (let i = 0; i + 4 <= size; i += 4) {
          const v = buf.readFloatLE(i);
          if (!Number.isInteger(v)) continue;
          const a = Math.abs(v);
          if (a < MIN_ABS || a > MAX_ABS) continue;
          addrs.push(Number(r.base) + off + i);
          vals.push(v);
        }
      }
      off += size;
    }
  }
  return { addrs, vals };
}

function reread(h, addrs) {
  const out = new Float64Array(addrs.length);
  const buf = Buffer.alloc(WIN);
  let i = 0;
  while (i < addrs.length) {
    const start = Math.floor(addrs[i] / WIN) * WIN;
    const ok = RPM(h, BigInt(start), buf, WIN, [0]);
    while (i < addrs.length && addrs[i] < start + WIN) {
      const o = addrs[i] - start;
      out[i] = (ok && o + 4 <= WIN) ? buf.readFloatLE(o) : NaN;
      i++;
    }
  }
  return out;
}

function main() {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const h = openProcess(pid);
  const base = BigInt(findModuleBase(pid, 'DD2.exe').base);
  const readLocal = () => {
    const b = readMemory(h, base + STATIC_A, 12);
    return { x: b.readFloatLE(0), y: b.readFloatLE(8) };
  };

  console.log('Baseline snapshot (exact-integer floats, 2 <= |v| <= 200000)...');
  const snap = snapshot(h);
  const order = Array.from(snap.addrs.keys()).sort((a, b) => snap.addrs[a] - snap.addrs[b]);
  const A0 = order.map((i) => snap.addrs[i]);
  const V0 = order.map((i) => snap.vals[i]);
  console.log(`Baseline: ${A0.length.toLocaleString()} candidates.\n`);

  // separate candidate lists per axis
  const cand = {
    X: { addrs: A0, vals: V0.slice(), crossings: 0 },
    Y: { addrs: A0.slice(), vals: V0.slice(), crossings: 0 },
  };

  console.log('CROSS A BOUNDARY (walk straight until the coord snaps). Repeat 2-3x.\n');

  let prev = readLocal();

  setInterval(() => {
    let cur;
    try { cur = readLocal(); } catch { return; }
    const dx = cur.x - prev.x, dy = cur.y - prev.y;
    prev = cur;

    const axis = Math.abs(dx) > SNAP_MIN ? 'X' : (Math.abs(dy) > SNAP_MIN ? 'Y' : null);
    if (!axis) return;

    const c = cand[axis];
    c.crossings++;
    const jump = axis === 'X' ? dx : dy;
    console.log(`\n*** ${axis} CROSSING #${c.crossings} (local jumped ${jump.toFixed(2)}) — ${c.addrs.length.toLocaleString()} candidates`);

    const now = reread(h, c.addrs);
    const kA = [], kV = [], hits = [];
    for (let i = 0; i < c.addrs.length; i++) {
      const a = now[i];
      if (!Number.isInteger(a)) continue;
      const d = a - c.vals[i];
      const ad = Math.abs(d);
      if (ad !== 1 && ad !== 128) continue;
      kA.push(c.addrs[i]);
      kV.push(a);
      hits.push({ addr: c.addrs[i], before: c.vals[i], after: a, d, kind: ad === 1 ? 'INDEX' : 'ORIGIN' });
    }
    c.addrs = kA; c.vals = kV;

    console.log(`  ${hits.length.toLocaleString()} stepped by exactly +/-1 or +/-128`);
    const show = hits.length <= 40 ? hits : hits.slice(0, 40);
    for (const x of show) {
      const rel = BigInt(x.addr) - base;
      const mod = (rel > 0n && rel < 0x20000000n) ? `   DD2.exe+${rel.toString(16).toUpperCase()}` : '';
      console.log(`    0x${x.addr.toString(16)}  ${String(x.before).padStart(9)} -> ${String(x.after).padStart(9)}  d=${x.d > 0 ? '+' : ''}${x.d}  [${x.kind}]${mod}`);
    }
    if (hits.length > 40) console.log(`    ... and ${(hits.length - 40).toLocaleString()} more`);
    console.log(`  ${axis} list now ${c.addrs.length.toLocaleString()}. Cross ${axis} again to narrow.\n`);
  }, 120);
}

try { main(); } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
