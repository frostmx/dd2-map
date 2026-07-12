// Minimal live memory scanner (Cheat Engine-style value scanning) built on
// top of memoryReader.js. Used once, interactively, to locate DD2's player
// world-position floats. Not part of the shipped app.
//
// Candidate storage is a flat binary file of 12-byte records:
//   [0..8)  address  (uint64 LE)
//   [8..12) value    (float32 LE)
// This is streamed to disk instead of buffered in JS objects, since a first
// pass over a multi-GB process can produce tens of millions of candidates.

const koffi = require('koffi');
const fs = require('fs');
const { findProcessIdByName, openProcess, closeHandle } = require('../src/main/memoryReader');

const kernel32 = koffi.load('kernel32.dll');

const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uintptr_t',
  AllocationBase: 'uintptr_t',
  AllocationProtect: 'uint32',
  PartitionId: 'uint16',
  RegionSize: 'size_t',
  State: 'uint32',
  Protect: 'uint32',
  Type: 'uint32',
});

const VirtualQueryEx = kernel32.func('size_t VirtualQueryEx(void *hProcess, uintptr_t lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, size_t dwLength)');
const ReadProcessMemoryRaw = kernel32.func(
  'bool ReadProcessMemory(void *hProcess, uintptr_t lpBaseAddress, _Out_ uint8 *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)'
);

const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const PAGE_READWRITE = 0x04;
const PAGE_EXECUTE_READWRITE = 0x40;
const PAGE_GUARD = 0x100;

const RECORD_SIZE = 12;

function enumRegions(handle) {
  const regions = [];
  let addr = 0n;
  const mbi = {};
  for (;;) {
    const written = VirtualQueryEx(handle, addr, mbi, koffi.sizeof(MEMORY_BASIC_INFORMATION));
    if (written === 0) break;
    const protect = mbi.Protect >>> 0;
    const isRW = (protect === PAGE_READWRITE || protect === PAGE_EXECUTE_READWRITE) && !(protect & PAGE_GUARD);
    if (mbi.State === MEM_COMMIT && mbi.Type === MEM_PRIVATE && isRW) {
      regions.push({ base: BigInt(mbi.BaseAddress), size: Number(mbi.RegionSize) });
    }
    const base = BigInt(mbi.BaseAddress);
    const size = BigInt(mbi.RegionSize) || 0x1000n;
    addr = base + size;
    if (addr <= 0n) break;
  }
  return regions;
}

function readChunk(handle, addr, size, outBuf) {
  const bytesRead = [0];
  const ok = ReadProcessMemoryRaw(handle, addr, outBuf, size, bytesRead);
  return ok;
}

const CHUNK = 1 << 20; // 1MB per read call

function cmd_snapshot(outFile, min, max, minAbs) {
  minAbs = minAbs || 0;
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  console.error('Enumerating RW private regions...');
  const regions = enumRegions(handle);
  const totalMB = regions.reduce((s, r) => s + r.size, 0) / (1024 * 1024);
  console.error(`Found ${regions.length} regions, ${totalMB.toFixed(1)} MB total. Scanning for floats in [${min}, ${max}] with |v| >= ${minAbs}...`);

  const out = fs.openSync(outFile, 'w');
  const chunkBuf = Buffer.alloc(CHUNK);
  const recordBuf = Buffer.alloc(1 << 16); // batch of records before flushing
  let recordOffset = 0;
  let count = 0;

  function flush() {
    if (recordOffset > 0) {
      fs.writeSync(out, recordBuf, 0, recordOffset);
      recordOffset = 0;
    }
  }

  for (const region of regions) {
    let offset = 0;
    while (offset < region.size) {
      const size = Math.min(CHUNK, region.size - offset);
      const ok = readChunk(handle, region.base + BigInt(offset), size, chunkBuf);
      if (ok) {
        for (let i = 0; i + 4 <= size; i += 4) {
          const v = chunkBuf.readFloatLE(i);
          if (Number.isFinite(v) && v >= min && v <= max && Math.abs(v) >= minAbs) {
            if (recordOffset + RECORD_SIZE > recordBuf.length) flush();
            recordBuf.writeBigUInt64LE(region.base + BigInt(offset + i), recordOffset);
            recordBuf.writeFloatLE(v, recordOffset + 8);
            recordOffset += RECORD_SIZE;
            count++;
          }
        }
      }
      offset += size;
    }
  }
  flush();
  fs.closeSync(out);
  console.error(`Found ${count} candidates. Saved to ${outFile} (${(count * RECORD_SIZE / 1024 / 1024).toFixed(1)} MB)`);
  closeHandle(handle);
}

function* readRecords(file) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i + RECORD_SIZE <= buf.length; i += RECORD_SIZE) {
    yield { addr: buf.readBigUInt64LE(i), value: buf.readFloatLE(i + 8) };
  }
}

const REREAD_CHUNK = 1 << 16; // 64KB batched re-read window

// Groups candidate file offsets (not objects!) by shared 64KB-aligned
// windows, using typed arrays throughout. At 50M+ candidates, an
// object-per-candidate approach (even briefly, mid-grouping) blows the heap;
// this stays to a handful of Int32Arrays plus the raw input buffer.
function groupByWindow(inFile) {
  const buf = fs.readFileSync(inFile);
  const count = buf.length / RECORD_SIZE;
  const windowCounts = new Map(); // windowStart string -> count
  for (let i = 0; i < count; i++) {
    const addr = buf.readBigUInt64LE(i * RECORD_SIZE);
    const key = (addr - (addr % BigInt(REREAD_CHUNK))).toString();
    windowCounts.set(key, (windowCounts.get(key) || 0) + 1);
  }
  const windowArrays = new Map(); // windowStart string -> Int32Array of record-file offsets
  const fillIdx = new Map();
  for (const [key, cnt] of windowCounts) {
    windowArrays.set(key, new Int32Array(cnt));
    fillIdx.set(key, 0);
  }
  for (let i = 0; i < count; i++) {
    const recOff = i * RECORD_SIZE;
    const addr = buf.readBigUInt64LE(recOff);
    const key = (addr - (addr % BigInt(REREAD_CHUNK))).toString();
    const idx = fillIdx.get(key);
    windowArrays.get(key)[idx] = recOff;
    fillIdx.set(key, idx + 1);
  }
  return { buf, windowArrays };
}

// Streams through each window once, calling onRecord(addr, prevValue,
// currentValue) for every candidate — caller writes directly to the output
// file instead of accumulating a results array (also too much memory at
// this scale).
function rereadAndStream(handle, inFile, onRecord) {
  const { buf, windowArrays } = groupByWindow(inFile);
  const winBuf = Buffer.alloc(REREAD_CHUNK);
  for (const [key, offsets] of windowArrays) {
    const windowStart = BigInt(key);
    const ok = readChunk(handle, windowStart, REREAD_CHUNK, winBuf);
    if (!ok) continue;
    for (let i = 0; i < offsets.length; i++) {
      const recOff = offsets[i];
      const addr = buf.readBigUInt64LE(recOff);
      const prev = buf.readFloatLE(recOff + 8);
      const off = Number(addr - windowStart);
      if (off + 4 > REREAD_CHUNK) continue;
      const value = winBuf.readFloatLE(off);
      onRecord(addr, prev, value);
    }
  }
}

function cmd_filterChanged(inFile, outFile, minDelta, maxDelta) {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  console.error('Batch re-reading candidates...');
  const out = fs.openSync(outFile, 'w');
  const recordBuf = Buffer.alloc(RECORD_SIZE);
  let total = 0, kept = 0;
  rereadAndStream(handle, inFile, (addr, prev, value) => {
    total++;
    if (!Number.isFinite(value)) return;
    const delta = Math.abs(value - prev);
    if (delta >= minDelta && delta <= maxDelta) {
      recordBuf.writeBigUInt64LE(addr, 0);
      recordBuf.writeFloatLE(value, 8);
      fs.writeSync(out, recordBuf);
      kept++;
    }
  });
  fs.closeSync(out);
  console.error(`Re-checked ${total}, kept ${kept} changed by [${minDelta}, ${maxDelta}]. Saved to ${outFile}`);
  closeHandle(handle);
}

function cmd_filterDirection(inFile, outFile, direction, minDelta, maxDelta) {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  console.error('Batch re-reading candidates...');
  const out = fs.openSync(outFile, 'w');
  const recordBuf = Buffer.alloc(RECORD_SIZE);
  let total = 0, kept = 0;
  rereadAndStream(handle, inFile, (addr, prev, value) => {
    total++;
    if (!Number.isFinite(value)) return;
    const delta = value - prev;
    const mag = Math.abs(delta);
    if (mag < minDelta || mag > maxDelta) return;
    if (direction === 'increased' && delta <= 0) return;
    if (direction === 'decreased' && delta >= 0) return;
    recordBuf.writeBigUInt64LE(addr, 0);
    recordBuf.writeFloatLE(value, 8);
    fs.writeSync(out, recordBuf);
    kept++;
  });
  fs.closeSync(out);
  console.error(`Re-checked ${total}, kept ${kept} ${direction} by [${minDelta}, ${maxDelta}]. Saved to ${outFile}`);
  closeHandle(handle);
}

function cmd_filterUnchanged(inFile, outFile) {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  console.error('Batch re-reading candidates...');
  const out = fs.openSync(outFile, 'w');
  const recordBuf = Buffer.alloc(RECORD_SIZE);
  let total = 0, kept = 0;
  rereadAndStream(handle, inFile, (addr, prev, value) => {
    total++;
    if (value === prev) {
      recordBuf.writeBigUInt64LE(addr, 0);
      recordBuf.writeFloatLE(value, 8);
      fs.writeSync(out, recordBuf);
      kept++;
    }
  });
  fs.closeSync(out);
  console.error(`Re-checked ${total}, kept ${kept} unchanged. Saved to ${outFile}`);
  closeHandle(handle);
}

function cmd_list(inFile, limit) {
  let n = 0;
  const max = limit ? parseInt(limit, 10) : 200;
  const items = [...readRecords(inFile)];
  console.log(`${items.length} candidates:`);
  for (const c of items.slice(0, max)) {
    console.log(`  0x${c.addr.toString(16)}  =  ${c.value}`);
    n++;
  }
  if (items.length > max) console.log(`  ... and ${items.length - max} more`);
}

// Groups candidates into xyz triplets: three finite floats at addr, addr+4, addr+8
// all present in the candidate set.
function cmd_triplets(inFile) {
  const items = [...readRecords(inFile)];
  const byAddr = new Map(items.map((c) => [c.addr.toString(), c.value]));
  const results = [];
  for (const c of items) {
    const a2 = (c.addr + 4n).toString();
    const a3 = (c.addr + 8n).toString();
    if (byAddr.has(a2) && byAddr.has(a3)) {
      results.push({ addr: c.addr, x: c.value, y: byAddr.get(a2), z: byAddr.get(a3) });
    }
  }
  console.log(`${results.length} xyz-shaped triplets:`);
  for (const r of results.slice(0, 200)) {
    console.log(`  0x${r.addr.toString(16)}  x=${r.x} y=${r.y} z=${r.z}`);
  }
}

// Reads a window of floats around each candidate address to look for a
// plausible {x,y,z} struct layout (position often stored as 12 contiguous
// bytes, sometimes with a 4th float for w/padding).
function cmd_context(inFile, limit) {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  const items = [...readRecords(inFile)];
  const max = limit ? parseInt(limit, 10) : 50;
  console.log(`Showing context for ${Math.min(max, items.length)} of ${items.length} candidates:`);
  const winBuf = Buffer.alloc(32);
  for (const c of items.slice(0, max)) {
    const start = c.addr - 16n;
    const ok = readChunk(handle, start, 32, winBuf);
    if (!ok) continue;
    const floats = [];
    for (let i = 0; i < 32; i += 4) {
      floats.push(winBuf.readFloatLE(i).toFixed(2));
    }
    // mark which float is the candidate itself (offset 16 = index 4)
    floats[4] = `[${floats[4]}]`;
    console.log(`0x${c.addr.toString(16)}:  ${floats.join('  ')}`);
  }
  closeHandle(handle);
}

// Targeted scan: instead of a blind full-range float scan, look directly for
// {x,h,y} triplets (3 consecutive floats) whose values are each within a
// small delta of a known reference point (e.g. the camera's current
// position) — the real player struct should be spatially close to the
// camera and have the same x/height/y layout, so this narrows a 50M-result
// blind scan down to a handful of candidates in one pass.
function cmd_proximity(outFile, targetX, targetH, targetY, deltaXY, deltaH) {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  console.error('Enumerating RW private regions...');
  const regions = enumRegions(handle);
  console.error(`Scanning for {x,h,y} triplets near (${targetX}, ${targetH}, ${targetY}) +/- (${deltaXY}, ${deltaH})...`);

  const out = fs.openSync(outFile, 'w');
  const chunkBuf = Buffer.alloc(CHUNK + 8); // small overlap so triplets spanning a chunk boundary aren't missed
  const recordBuf = Buffer.alloc(RECORD_SIZE);
  let count = 0;

  for (const region of regions) {
    let offset = 0;
    while (offset < region.size) {
      const size = Math.min(CHUNK, region.size - offset);
      const readSize = Math.min(size + 8, region.size - offset);
      const ok = readChunk(handle, region.base + BigInt(offset), readSize, chunkBuf);
      if (ok) {
        for (let i = 0; i + 12 <= readSize; i += 4) {
          const x = chunkBuf.readFloatLE(i);
          if (Math.abs(x - targetX) > deltaXY) continue;
          const h = chunkBuf.readFloatLE(i + 4);
          if (Math.abs(h - targetH) > deltaH) continue;
          const y = chunkBuf.readFloatLE(i + 8);
          if (Math.abs(y - targetY) > deltaXY) continue;
          const addr = region.base + BigInt(offset + i);
          recordBuf.writeBigUInt64LE(addr, 0);
          recordBuf.writeFloatLE(x, 8);
          fs.writeSync(out, recordBuf);
          count++;
        }
      }
      offset += size;
    }
  }
  fs.closeSync(out);
  console.error(`Found ${count} candidate triplets. Saved to ${outFile}`);
  closeHandle(handle);
}

function cmd_count(inFile) {
  const st = fs.statSync(inFile);
  console.log(`${inFile}: ${st.size / RECORD_SIZE} candidates`);
}

const [, , cmd, ...args] = process.argv;
try {
  if (cmd === 'snapshot') cmd_snapshot(args[0], parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3]));
  else if (cmd === 'filter-changed') cmd_filterChanged(args[0], args[1], parseFloat(args[2]), parseFloat(args[3]));
  else if (cmd === 'filter-unchanged') cmd_filterUnchanged(args[0], args[1]);
  else if (cmd === 'filter-direction') cmd_filterDirection(args[0], args[1], args[2], parseFloat(args[3]), parseFloat(args[4]));
  else if (cmd === 'list') cmd_list(args[0], args[1]);
  else if (cmd === 'triplets') cmd_triplets(args[0]);
  else if (cmd === 'count') cmd_count(args[0]);
  else if (cmd === 'context') cmd_context(args[0], args[1]);
  else if (cmd === 'proximity') cmd_proximity(args[0], parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3]), parseFloat(args[4]), parseFloat(args[5]));
  else {
    console.error('Usage:');
    console.error('  node scanner.js snapshot <out.bin> <min> <max>');
    console.error('  node scanner.js filter-changed <in.bin> <out.bin> <minDelta> <maxDelta>');
    console.error('  node scanner.js filter-unchanged <in.bin> <out.bin>');
    console.error('  node scanner.js list <file.bin> [limit]');
    console.error('  node scanner.js triplets <file.bin>');
    console.error('  node scanner.js count <file.bin>');
    process.exit(1);
  }
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
