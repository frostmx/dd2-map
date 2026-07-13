// Node pointer scanner — finds module-static pointer chains to a heap target,
// then narrows them across reloads. Replaces the Cheat Engine GUI workflow.
//
//   node src/main/pointerScan.js scan <targetHex> <out.json> [maxLevel=7] [maxOff=2048]
//       Build a reverse pointer index of DD2.exe and walk back from <target>
//       to every DD2.exe-static base within maxLevel hops / maxOff per hop.
//
//   node src/main/pointerScan.js validate <in.json> [out.json]
//       After a RELOAD/teleport (target address is now different), keep only the
//       chains that still resolve to the player's global position. Test: the
//       resolved (gx,gh,gy) must satisfy global = local + k*128 with integer k
//       on ALL THREE axes (local read from the static mirror). Random pointers
//       don't. Run after each reload to intersect down to the truly stable chain.
//
//   node src/main/pointerScan.js resolve <in.json>
//       Just resolve every chain now and print what it points at (sanity check).
//
// HOW TO USE (fully automated, no CE):
//   1. While the global address is live:  scan 0x39d128d0 chains.json
//   2. Reload the game (walk is fine too, but a reload is the real test).
//   3. validate chains.json chains.json   (repeat step 2-3 once or twice)
//   4. A handful survive every reload -> that's the stable chain. Wire it in.

const fs = require('fs');
const koffi = require('koffi');
const { findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain } = require('../src/main/memoryReader');

const kernel32 = koffi.load('kernel32.dll');
const MBI = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uintptr_t', AllocationBase: 'uintptr_t', AllocationProtect: 'uint32',
  PartitionId: 'uint16', RegionSize: 'size_t', State: 'uint32', Protect: 'uint32', Type: 'uint32',
});
const VirtualQueryEx = kernel32.func('size_t VirtualQueryEx(void *hProcess, uintptr_t lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, size_t dwLength)');
const RPM = kernel32.func('bool ReadProcessMemory(void *hProcess, uintptr_t lpBaseAddress, _Out_ uint8 *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)');

const MEM_COMMIT = 0x1000, MEM_IMAGE = 0x1000000, MEM_PRIVATE = 0x20000;
const PAGE_GUARD = 0x100, PAGE_NOACCESS = 0x01;
const READABLE = 0x02 | 0x04 | 0x20 | 0x40 | 0x08 | 0x80; // R, RW, XR, XRW, WC, XWC

const STATIC_A = 0x0fa65f70n;   // local mirror: x@+0, h@+4, y@+8
const ALIGN = 8;                // pointer field alignment (x64: 8; lower to 4 if needed)
const CELL = 128;

function attach() {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const h = openProcess(pid);
  const m = findModuleBase(pid, 'DD2.exe');
  return { h, modBase: BigInt(m.base), modSize: BigInt(m.size) };
}

// committed, readable IMAGE|PRIVATE regions (image => static bases; private => heap)
function enumRegions(h) {
  const out = [];
  let addr = 0n; const mbi = {};
  for (;;) {
    if (VirtualQueryEx(h, addr, mbi, koffi.sizeof(MBI)) === 0) break;
    const p = mbi.Protect >>> 0;
    const readable = (p & READABLE) && !(p & PAGE_GUARD) && !(p & PAGE_NOACCESS);
    const type = mbi.Type >>> 0;
    if (mbi.State === MEM_COMMIT && readable && (type === MEM_IMAGE || type === MEM_PRIVATE)) {
      out.push({ base: BigInt(mbi.BaseAddress), size: Number(mbi.RegionSize) });
    }
    addr = BigInt(mbi.BaseAddress) + (BigInt(mbi.RegionSize) || 0x1000n);
    if (addr <= 0n) break;
  }
  return out; // ascending
}

// ---- growable flat arrays (single-array length limit-safe via manual growth) --
function grow(a) { const b = new Float64Array(a.length * 2); b.set(a); return b; }

// Collect every pointer-like qword: value must land inside a committed region.
function collectPointers(h, regions) {
  const starts = regions.map((r) => Number(r.base));
  const ends = regions.map((r) => Number(r.base) + r.size);
  const nReg = regions.length;
  const inRegion = (v) => {
    let lo = 0, hi = nReg - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (v < starts[m]) hi = m - 1; else if (v >= ends[m]) lo = m + 1; else return true; }
    return false;
  };

  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK + 8);
  let addrs = new Float64Array(1 << 20);
  let vals = new Float64Array(1 << 20);
  let n = 0;
  let scanned = 0;

  for (const r of regions) {
    let off = 0;
    while (off < r.size) {
      const size = Math.min(CHUNK, r.size - off);
      const readSize = Math.min(size + 8, r.size - off); // small overlap for boundary qword
      if (RPM(h, r.base + BigInt(off), buf, readSize, [0])) {
        const rb = Number(r.base) + off;
        for (let i = 0; i + 8 <= readSize; i += ALIGN) {
          // user-space pointers fit in 48 bits; high 2 bytes must be zero
          if (buf.readUInt16LE(i + 6) !== 0) continue;
          const val = buf.readUIntLE(i, 6); // low 48 bits
          if (val < 0x10000 || !inRegion(val)) continue;
          if (n === addrs.length) { addrs = grow(addrs); vals = grow(vals); }
          addrs[n] = rb + i;
          vals[n] = val;
          n++;
        }
      }
      off += size;
      scanned += size;
    }
  }
  return { addrs, vals, n };
}

// LSD radix sort (base 2^16, 3 passes = 48 bits) sorting vals with addrs carried.
function radixSortByValue(vals, addrs, n) {
  let vIn = vals, aIn = addrs;
  let vOut = new Float64Array(n), aOut = new Float64Array(n);
  const RAD = 65536;
  const count = new Uint32Array(RAD + 1);
  const divs = [1, 65536, 4294967296];
  for (const div of divs) {
    count.fill(0);
    for (let i = 0; i < n; i++) { const d = Math.floor(vIn[i] / div) % RAD; count[d + 1]++; }
    for (let i = 0; i < RAD; i++) count[i + 1] += count[i];
    for (let i = 0; i < n; i++) {
      const d = Math.floor(vIn[i] / div) % RAD;
      const pos = count[d]++;
      vOut[pos] = vIn[i]; aOut[pos] = aIn[i];
    }
    [vIn, vOut] = [vOut, vIn];
    [aIn, aOut] = [aOut, aIn];
  }
  return { vals: vIn, addrs: aIn };
}

function lowerBound(vals, n, x) { // first i with vals[i] >= x
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

function cmdScan(targetHex, outFile, maxLevel, maxOff) {
  const target = Number(BigInt(targetHex));
  const { h, modBase, modSize } = attach();
  const mBase = Number(modBase), mEnd = Number(modBase + modSize);
  console.log(`target=0x${target.toString(16)}  module=[0x${mBase.toString(16)}..0x${mEnd.toString(16)}]  maxLevel=${maxLevel} maxOff=${maxOff}`);

  console.log('Collecting pointers (this reads all IMAGE+PRIVATE committed memory)...');
  let t0 = Date.now();
  const regions = enumRegions(h);
  const { addrs, vals, n } = collectPointers(h, regions);
  console.log(`  ${n.toLocaleString()} pointers in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('Sorting by value...');
  t0 = Date.now();
  const sorted = radixSortByValue(vals, addrs, n);
  const V = sorted.vals, A = sorted.addrs;
  console.log(`  sorted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('Reverse-scanning for static chains...');
  t0 = Date.now();
  const results = [];
  const MAX_RESULTS = 400000;
  const CHILD_CAP = 256;          // pointers examined per node
  const visited = new Set();      // addresses already expanded (dedupe subtrees)

  function walk(tgt, depth, offsets) {
    if (results.length >= MAX_RESULTS) return;
    const lo = lowerBound(V, n, tgt - maxOff);
    const hi = lowerBound(V, n, tgt + 1); // inclusive of value==tgt
    let seen = 0;
    for (let i = lo; i < hi && seen < CHILD_CAP; i++) {
      const X = A[i];
      const off = tgt - V[i]; // 0..maxOff
      seen++;
      const chain = [off, ...offsets];
      if (X >= mBase && X < mEnd) {
        results.push({ staticOffset: '0x' + (X - mBase).toString(16).toUpperCase(), offsets: chain.map((o) => '0x' + o.toString(16)) });
        if (results.length >= MAX_RESULTS) return;
      }
      if (depth + 1 < maxLevel && !visited.has(X)) {
        visited.add(X);
        walk(X, depth + 1, chain);
      }
    }
  }
  walk(target, 0, []);
  console.log(`  found ${results.length.toLocaleString()} static chains in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.writeFileSync(outFile, JSON.stringify({ targetHex, maxLevel, maxOff, foundAt: new Date().toISOString(), count: results.length, chains: results }, null, 0));
  console.log(`Saved to ${outFile}. Now RELOAD the game and run: node src/main/pointerScan.js validate ${outFile} ${outFile}`);
}

function readLocal(h, modBase) {
  const b = readMemory(h, modBase + STATIC_A, 12);
  return { x: b.readFloatLE(0), h: b.readFloatLE(4), y: b.readFloatLE(8) };
}

// global = local + k*128 with integer k -> it's the real global pointer. Only X
// and Y are checked (the map coords); the middle field isn't on the 128-grid.
function isConsistentGlobal(g, loc) {
  const check = (gv, lv) => {
    if (!Number.isFinite(gv)) return false;
    const k = (gv - lv) / CELL;
    return Math.abs(k - Math.round(k)) < 0.02 && Math.abs(k) < 100000;
  };
  return check(g.x, loc.x) && check(g.y, loc.y);
}

function cmdValidate(inFile, outFile) {
  const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { h, modBase } = attach();
  const loc = readLocal(h, modBase);
  console.log(`Validating ${data.chains.length.toLocaleString()} chains. local x=${loc.x.toFixed(2)} h=${loc.h.toFixed(2)} y=${loc.y.toFixed(2)}`);

  const kept = [];
  for (const c of data.chains) {
    try {
      const staticBase = modBase + BigInt(c.staticOffset);
      const offs = c.offsets.map((o) => Number(BigInt(o)));
      const addr = resolvePointerChain(h, staticBase, offs);
      const b = readMemory(h, addr, 12);
      const g = { x: b.readFloatLE(0), h: b.readFloatLE(4), y: b.readFloatLE(8) };
      if (isConsistentGlobal(g, loc)) kept.push(c);
    } catch { /* unresolvable this session — drop */ }
  }

  console.log(`  survivors: ${kept.length.toLocaleString()} / ${data.chains.length.toLocaleString()}`);
  for (const c of kept.slice(0, 25)) console.log(`    DD2.exe+${c.staticOffset}  [${c.offsets.join(', ')}]`);
  if (kept.length > 25) console.log(`    ... and ${kept.length - 25} more`);

  const out = outFile || inFile;
  fs.writeFileSync(out, JSON.stringify({ ...data, count: kept.length, chains: kept, validatedAt: new Date().toISOString() }, null, 0));
  console.log(`Saved ${kept.length} to ${out}.` + (kept.length > 8 ? ' Reload and validate again to narrow further.' : ' Small enough — pick one and wire it in.'));
}

// The CAMERA's version of the same idea. The global's test is "sits on the 128-grid"; the
// camera's is "sits on the player's LEASH" — a few units away, orbiting.
//
// The FRAME decides how much that test is worth, and it is worth a great deal more in the
// global one. Near the local coords a stray Vec3 lands within a few metres of the player
// by sheer accident all the time: they are small numbers wrapped into a 128-unit box, and
// the float soup is full of small numbers. The global coords are large and specific — a
// junk pointer landing within a few metres of (626.88, -1029.47) on BOTH axes essentially
// doesn't happen. Same test, orders of magnitude fewer coincidences.
//
// The camera exists in both frames (verified: camGlobal - camLocal was exactly the
// player's cell offset, (5, -8) cells, and the camera's offset from the player was
// identical in both). So prefer --global and use the strong version.
const CAM_MIN = 0.2, CAM_MAX = 12.0, CAM_DH_MIN = -4.0, CAM_DH_MAX = 12.0;

function isOnLeash(c, ref) {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.h) || !Number.isFinite(c.y)) return false;
  const dh = c.h - ref.h;
  if (dh < CAM_DH_MIN || dh > CAM_DH_MAX) return false;
  const d = Math.hypot(c.x - ref.x, c.y - ref.y);
  return d >= CAM_MIN && d <= CAM_MAX;
}

// The player's global position, via the chain the app itself ships with.
const GLOBAL_STATIC = 0x0fd26358n, GLOBAL_OFFS = [0x1a8, 0x410];
const GLOBAL_FALLBACK_STATIC = 0x0f8e1130n, GLOBAL_FALLBACK_OFFS = [0x210, 0x50];

function readGlobal(h, modBase, loc) {
  const onGrid = (g, l) => Number.isFinite(g) && Math.abs((g - l) / CELL - Math.round((g - l) / CELL)) < 0.05;
  for (const [st, offs] of [[GLOBAL_STATIC, GLOBAL_OFFS], [GLOBAL_FALLBACK_STATIC, GLOBAL_FALLBACK_OFFS]]) {
    try {
      const a = resolvePointerChain(h, modBase + st, offs);
      const b = readMemory(h, a, 12);
      const g = { x: b.readFloatLE(0), h: loc.h, y: b.readFloatLE(8) };
      if (onGrid(g.x, loc.x) && onGrid(g.y, loc.y)) return g;
    } catch { /* try the fallback */ }
  }
  throw new Error('cannot read the player global position');
}

function cmdValidateCam(inFile, outFile, frameArg) {
  const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { h, modBase } = attach();
  const loc = readLocal(h, modBase);
  const useGlobal = frameArg === '--global';
  const ref = useGlobal ? readGlobal(h, modBase, loc) : loc;
  console.log(`Validating ${data.chains.length.toLocaleString()} camera chains against the ` +
    `${useGlobal ? 'GLOBAL' : 'local'} player at x=${ref.x.toFixed(2)} h=${ref.h.toFixed(2)} y=${ref.y.toFixed(2)}`);

  const kept = [];
  for (const c of data.chains) {
    try {
      const staticBase = modBase + BigInt(c.staticOffset);
      const offs = c.offsets.map((o) => Number(BigInt(o)));
      const addr = resolvePointerChain(h, staticBase, offs);
      const b = readMemory(h, addr, 12);
      const cam = { x: b.readFloatLE(0), h: b.readFloatLE(4), y: b.readFloatLE(8) };
      if (isOnLeash(cam, ref)) kept.push(c);
    } catch { /* unresolvable this session — drop */ }
  }

  console.log(`  survivors: ${kept.length.toLocaleString()} / ${data.chains.length.toLocaleString()}`);
  for (const c of kept.slice(0, 25)) console.log(`    DD2.exe+${c.staticOffset}  [${c.offsets.join(', ')}]`);
  if (kept.length > 25) console.log(`    ... and ${kept.length - 25} more`);

  const out = outFile || inFile;
  fs.writeFileSync(out, JSON.stringify({ ...data, count: kept.length, chains: kept, validatedAt: new Date().toISOString() }, null, 0));
  console.log(`Saved ${kept.length} to ${out}.` + (kept.length > 8 ? ' Travel far away (or reload) and validate again.' : ' Small enough — pick one and verify with cameraHunt watch.'));
}

// Directly locate the CURRENT global-position Vec3 in memory (no walking needed):
// scan for a triplet (x,h,y) where each equals local + k*128 with integer k.
function cmdFindGlobal() {
  const { h, modBase } = attach();
  const loc = readLocal(h, modBase);
  console.log(`local: x=${loc.x.toFixed(3)} h=${loc.h.toFixed(3)} y=${loc.y.toFixed(3)}  — scanning for the consistent global triplet...`);
  // EXACT cell alignment (true global has ~0 remainder; near-misses are noise),
  // with sane cell bounds (height barely changes -> small |m|; x/y within the map).
  const isK = (g, l, maxAbs) => {
    if (!Number.isFinite(g)) return false;
    const k = (g - l) / CELL;
    return Math.abs(k - Math.round(k)) < 0.004 && Math.abs(k) < maxAbs;
  };
  const regions = enumRegions(h);
  const CHUNK = 1 << 20;
  const buf = Buffer.alloc(CHUNK + 12);
  const hits = [];
  for (const r of regions) {
    let off = 0;
    while (off < r.size) {
      const size = Math.min(CHUNK, r.size - off);
      const rs = Math.min(size + 12, r.size - off);
      if (RPM(h, r.base + BigInt(off), buf, rs, [0])) {
        for (let i = 0; i + 12 <= rs; i += 4) {
          const gx = buf.readFloatLE(i);
          if (!isK(gx, loc.x, 4000)) continue;
          const gh = buf.readFloatLE(i + 4);
          if (!isK(gh, loc.h, 6)) continue;   // vertical: few cells at most
          const gy = buf.readFloatLE(i + 8);
          if (!isK(gy, loc.y, 4000)) continue;
          hits.push({ addr: r.base + BigInt(off + i), gx, gh, gy });
        }
      }
      off += size;
    }
  }
  // Partition into module-static (the jackpot: no pointer chain needed) vs heap.
  const mEnd = modBase + (findModuleBase(findProcessIdByName('DD2.exe'), 'DD2.exe').size ? BigInt(findModuleBase(findProcessIdByName('DD2.exe'), 'DD2.exe').size) : 0n);
  const inModule = (a) => a >= modBase && a < mEnd;
  const kOf = (g, l) => Math.round((g - l) / CELL);
  const nonZero = (x) => kOf(x.gx, loc.x) !== 0 || kOf(x.gy, loc.y) !== 0; // global != local => real
  const modHits = hits.filter((x) => inModule(x.addr));
  const heapNonZero = hits.filter((x) => !inModule(x.addr) && nonZero(x));

  console.log(`\n${hits.length} consistent triplet(s) total.`);
  console.log(`\n*** MODULE-STATIC hits (DD2.exe+off, NO pointer chain needed): ${modHits.length} ***`);
  for (const x of modHits) {
    console.log(`  DD2.exe+${(x.addr - modBase).toString(16).toUpperCase()}  (${x.gx.toFixed(1)}, ${x.gh.toFixed(1)}, ${x.gy.toFixed(1)})  kx=${kOf(x.gx, loc.x)} ky=${kOf(x.gy, loc.y)}`);
  }
  if (!modHits.length) console.log('  (none — no static global mirror; a heap pointer chain would be required)');

  console.log(`\nHeap hits with k!=0 (genuine global copies): ${heapNonZero.length}`);
  for (const x of heapNonZero.slice(0, 30)) {
    console.log(`  0x${x.addr.toString(16)}  (${x.gx.toFixed(1)}, ${x.gh.toFixed(1)}, ${x.gy.toFixed(1)})  kx=${kOf(x.gx, loc.x)} ky=${kOf(x.gy, loc.y)}`);
  }
  if (heapNonZero.length > 30) console.log(`  ... and ${heapNonZero.length - 30} more`);
  return hits;
}

function cmdResolve(inFile) {
  const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { h, modBase } = attach();
  const loc = readLocal(h, modBase);
  console.log(`local x=${loc.x.toFixed(2)} h=${loc.h.toFixed(2)} y=${loc.y.toFixed(2)}\n`);
  for (const c of data.chains.slice(0, 40)) {
    try {
      const addr = resolvePointerChain(h, modBase + BigInt(c.staticOffset), c.offsets.map((o) => Number(BigInt(o))));
      const b = readMemory(h, addr, 12);
      const g = { x: b.readFloatLE(0), h: b.readFloatLE(4), y: b.readFloatLE(8) };
      const ok = isConsistentGlobal(g, loc) ? '  <== consistent global' : '';
      console.log(`DD2.exe+${c.staticOffset} [${c.offsets.join(',')}] -> 0x${addr.toString(16)}  (${g.x.toFixed(1)}, ${g.h.toFixed(1)}, ${g.y.toFixed(1)})${ok}`);
    } catch (e) {
      console.log(`DD2.exe+${c.staticOffset} [${c.offsets.join(',')}] -> unresolvable`);
    }
  }
}

const [, , cmd, a1, a2, a3, a4] = process.argv;
try {
  if (cmd === 'scan') cmdScan(a1, a2 || 'chains.json', a3 ? parseInt(a3, 10) : 7, a4 ? parseInt(a4, 10) : 2048);
  else if (cmd === 'validate') cmdValidate(a1, a2);
  else if (cmd === 'validatecam') cmdValidateCam(a1, a2, a3);
  else if (cmd === 'findglobal') cmdFindGlobal();
  else if (cmd === 'resolve') cmdResolve(a1);
  else {
    console.log('Usage:');
    console.log('  node src/main/pointerScan.js scan <targetHex> <out.json> [maxLevel=7] [maxOff=2048]');
    console.log('  node src/main/pointerScan.js validate <in.json> [out.json]');
    console.log('  node src/main/pointerScan.js resolve <in.json>');
    process.exit(1);
  }
} catch (e) { console.error('ERROR:', e.message); process.exit(1); }
