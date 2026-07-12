// Inspect the two static (module-relative) coordinate addresses the user found,
// and the memory AROUND them — hunting for the cell index that would let us
// reconstruct true world coords without dead reckoning.
//
//   node src/main/readStatic.js            -> one-shot dump of both windows
//   node src/main/readStatic.js watch       -> poll, print only what CHANGES
//
// Why the surroundings matter: if `world = k*128 + local`, then k (an integer,
// possibly stored as an integer-valued float) must live somewhere. A value that
// steps by exactly +/-1 at the same instant the local coord snaps is the cell index.

const { findProcessIdByName, findModuleBase, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const TARGETS = [
  { name: 'A', offset: 0x0fa65f70n },
  { name: 'B', offset: 0x0fc26890n },
];

const WINDOW_BEFORE = 32; // bytes to read before the target
const WINDOW_AFTER = 48;  // bytes to read after

function dumpWindow(handle, base, t) {
  const addr = base + t.offset;
  const start = addr - BigInt(WINDOW_BEFORE);
  const size = WINDOW_BEFORE + WINDOW_AFTER;
  const buf = readMemory(handle, start, size);
  const rows = [];
  for (let i = 0; i + 4 <= size; i += 4) {
    const rel = i - WINDOW_BEFORE;
    const f = buf.readFloatLE(i);
    const i32 = buf.readInt32LE(i);
    rows.push({
      rel,
      addrHex: '0x' + (start + BigInt(i)).toString(16),
      modOff: 'DD2.exe+' + (t.offset + BigInt(rel)).toString(16).toUpperCase(),
      f,
      i32,
    });
  }
  return rows;
}

function fmt(rows, label) {
  console.log(`\n=== ${label} ===`);
  console.log('  rel   module offset        float            int32       note');
  for (const r of rows) {
    const isTarget = r.rel === 0;
    const looksInt = Number.isFinite(r.f) && Math.abs(r.f) > 0.5 && Math.abs(r.f) < 1e7 && Math.abs(r.f - Math.round(r.f)) < 1e-4;
    const notes = [];
    if (isTarget) notes.push('<<< TARGET');
    if (looksInt) notes.push('integer-valued float (cell index?)');
    if (Number.isInteger(r.i32) && Math.abs(r.i32) > 0 && Math.abs(r.i32) < 10000) notes.push('small int32');
    const fs = Number.isFinite(r.f) ? r.f.toFixed(4).padStart(14) : String(r.f).padStart(14);
    console.log(
      `  ${String(r.rel).padStart(4)}  ${r.modOff.padEnd(18)} ${fs}  ${String(r.i32).padStart(12)}   ${notes.join(', ')}`
    );
  }
}

function main() {
  const watch = process.argv[2] === 'watch';
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  const base = BigInt(findModuleBase(pid, 'DD2.exe').base);
  console.log(`DD2.exe pid=${pid} moduleBase=0x${base.toString(16)}`);

  if (!watch) {
    for (const t of TARGETS) fmt(dumpWindow(handle, base, t), `${t.name}: DD2.exe+${t.offset.toString(16).toUpperCase()}`);
    closeHandle(handle);
    return;
  }

  // watch mode: report any slot in either window whose value changes
  const prev = new Map();
  console.log('\nWatching for changes (Ctrl+C to stop). Move around / cross a boundary.\n');
  setInterval(() => {
    for (const t of TARGETS) {
      const rows = dumpWindow(handle, base, t);
      for (const r of rows) {
        const key = t.name + ':' + r.rel;
        const old = prev.get(key);
        const cur = r.f;
        if (old !== undefined && Number.isFinite(cur) && Number.isFinite(old) && cur !== old) {
          const d = cur - old;
          // Flag the two things we care about: a coordinate snap, and an integer step of +/-1
          let tag = '';
          if (Math.abs(d) > 60) tag = '   *** SNAP ***';
          if (Math.abs(Math.abs(d) - 1) < 1e-3) tag = '   *** STEPPED BY +/-1  <-- CELL INDEX? ***';
          if (tag) {
            console.log(
              `${t.name}${String(r.rel).padStart(4)}  ${r.modOff.padEnd(18)} ${old.toFixed(3).padStart(11)} -> ${cur.toFixed(3).padStart(11)}  d=${d.toFixed(3).padStart(10)}${tag}`
            );
          }
        }
        prev.set(key, cur);
      }
    }
  }, 100);
}

try {
  main();
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
