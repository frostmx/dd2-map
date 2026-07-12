// Tests all 18 candidate pointer chains against the current struct base.
// A correct chain resolves exactly to CURRENT_BASE. Tries both offset orders
// in case CE's convention is reversed from what we assumed.
const { findProcessIdByName, findModuleBase, openProcess, readPointer, readMemory, closeHandle } = require('../src/main/memoryReader');

const CURRENT_BASE = 0x4889d4a0n; // struct base this session (position x at +0x40)

const paths = [
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x28, 0x2D0, 0x150, 0x20, 0x0] },
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x18, 0x168, 0x150, 0x20, 0x0] },
  { base: 0x0F8E4388, off: [0x28, 0x10, 0x20, 0x28, 0x70, 0x20, 0x0] },
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x28, 0x70, 0x20, 0x0] },
  { base: 0x0F8E9420, off: [0x48, 0x10, 0x20, 0x20, 0x70, 0x20, 0x0] },
  { base: 0x0F8E9420, off: [0x40, 0x30, 0x20, 0x20, 0x70, 0x20, 0x0] },
  { base: 0x0F8E9420, off: [0x38, 0x60, 0x20, 0x20, 0x70, 0x20, 0x0] },
  { base: 0x0F8E77E0, off: [0x120, 0xC0, 0x80, 0x198, 0x150, 0x20, 0x0] },
  { base: 0x0F8E20D0, off: [0x20, 0xC0, 0x80, 0x198, 0x150, 0x20, 0x0] },
  { base: 0x0F8E77E0, off: [0x120, 0x88, 0x150, 0x198, 0x150, 0x20, 0x0] },
  { base: 0x0F8E20D0, off: [0x20, 0x88, 0x150, 0x198, 0x150, 0x20, 0x0] },
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x28, 0x70, 0x30, 0x80, 0x0] },
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x18, 0x118, 0x150, 0x20, 0x0] },
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x28, 0x320, 0x150, 0x20, 0x0] },
  { base: 0x0F8FD5B8, off: [0x1D8, 0x1A0, 0x18, 0x1B8, 0x150, 0x20, 0x0] },
  { base: 0x0FE46548, off: [0x1D8, 0x1A0, 0x18, 0x1B8, 0x150, 0x20, 0x0] },
  { base: 0x0FE7D220, off: [0x1D8, 0x1A0, 0x18, 0x1B8, 0x150, 0x20, 0x0] },
  { base: 0x0F8E4388, off: [0x50, 0x20, 0x28, 0x70, 0x38, 0x40, 0x0] },
];

const pid = findProcessIdByName('DD2.exe');
if (!pid) { console.error('DD2.exe not running'); process.exit(1); }
const handle = openProcess(pid);
const moduleBase = BigInt(findModuleBase(pid, 'DD2.exe').base);
console.log('module base = 0x' + moduleBase.toString(16));
console.log('target struct base = 0x' + CURRENT_BASE.toString(16));

function resolveForward(staticBase, offsets) {
  // O_last..O_1 dereferenced, +O_0 final (CE standard)
  let p = readPointer(handle, staticBase);
  for (let i = offsets.length - 1; i >= 1; i--) p = readPointer(handle, p + BigInt(offsets[i]));
  return p + BigInt(offsets[0]);
}
function resolveReverse(staticBase, offsets) {
  // O_0..O_(n-1) dereferenced, +O_n final
  let p = readPointer(handle, staticBase);
  for (let i = 0; i < offsets.length - 1; i++) p = readPointer(handle, p + BigInt(offsets[i]));
  return p + BigInt(offsets[offsets.length - 1]);
}

for (let mode of ['forward', 'reverse']) {
  console.log('\n=== ' + mode + ' order ===');
  paths.forEach((pth, idx) => {
    const sb = moduleBase + BigInt(pth.base);
    try {
      const resolved = mode === 'forward' ? resolveForward(sb, pth.off) : resolveReverse(sb, pth.off);
      const ok = resolved === CURRENT_BASE;
      let posInfo = '';
      if (ok) {
        const buf = readMemory(handle, resolved + 0x40n, 12);
        posInfo = `  -> x=${buf.readFloatLE(0).toFixed(2)} h=${buf.readFloatLE(4).toFixed(2)} y=${buf.readFloatLE(8).toFixed(2)}`;
      }
      console.log(`${ok ? 'MATCH' : '     '} #${idx + 1} DD2.exe+${pth.base.toString(16)} [${pth.off.map((o) => o.toString(16)).join(',')}] -> 0x${resolved.toString(16)}${posInfo}`);
    } catch (e) {
      console.log(`  ERR #${idx + 1} DD2.exe+${pth.base.toString(16)}: ${e.message}`);
    }
  });
}

closeHandle(handle);
