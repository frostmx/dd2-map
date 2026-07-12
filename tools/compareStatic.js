// Compare the pointer-chain position against the two static addresses, live.
// Confirms (a) they track the player, (b) the exact constant offset between them
// (we expect static = chain + 8 on the horizontal axes, since the chain value
// re-centers to -8 while the static one re-centers to 0).
//
//   node src/main/compareStatic.js

const { findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle } = require('../src/main/memoryReader');

const POINTER_STATIC_OFFSET = 0x0f8e4388n;
const POINTER_OFFSETS = [0x50, 0x20, 0x28, 0x70, 0x20, 0x0];
const STATIC_A = 0x0fa65f70n;
const STATIC_B = 0x0fc26890n;

const pid = findProcessIdByName('DD2.exe');
if (!pid) throw new Error('DD2.exe not running');
const handle = openProcess(pid);
const base = BigInt(findModuleBase(pid, 'DD2.exe').base);

const f3 = (addr) => {
  const b = readMemory(handle, addr, 12);
  return [b.readFloatLE(0), b.readFloatLE(4), b.readFloatLE(8)];
};

const p = (n) => (n >= 0 ? ' ' : '') + n.toFixed(3).padStart(9);

console.log('chain = pointer chain (x@+0x40, h@+0x44, y@+0x48)   A/B = static addresses');
console.log('Watch the deltas: a CONSTANT delta means same value, different centering.\n');

setInterval(() => {
  try {
    const sb = resolvePointerChain(handle, base + POINTER_STATIC_OFFSET, POINTER_OFFSETS);
    const cb = readMemory(handle, sb + 0x40n, 12);
    const chain = [cb.readFloatLE(0), cb.readFloatLE(4), cb.readFloatLE(8)];
    const a = f3(base + STATIC_A);
    const b = f3(base + STATIC_B);

    const dA = [a[0] - chain[0], a[1] - chain[1], a[2] - chain[2]];
    const dB = [b[0] - chain[0], b[1] - chain[1], b[2] - chain[2]];

    console.log(
      `chain[${p(chain[0])},${p(chain[1])},${p(chain[2])}]  ` +
      `A[${p(a[0])},${p(a[1])},${p(a[2])}]  ` +
      `A-chain[${p(dA[0])},${p(dA[1])},${p(dA[2])}]  ` +
      `B-chain[${p(dB[0])},${p(dB[1])},${p(dB[2])}]`
    );
  } catch (e) {
    console.log('read error:', e.message);
  }
}, 400);
