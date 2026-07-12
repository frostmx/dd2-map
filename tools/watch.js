// Live-watch a candidate {x,y,z} triplet to confirm it tracks the player in
// real time. Usage: node watch.js <hexAddrOfMiddleFloat> [offsetX] [offsetY]
const { findProcessIdByName, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const addrArg = process.argv[2];
if (!addrArg) {
  console.error('Usage: node watch.js <hexAddr>  (address of the candidate float itself)');
  process.exit(1);
}
const centerAddr = BigInt(addrArg);
const xAddr = centerAddr - 4n;
const zAddr = centerAddr + 4n;

const pid = findProcessIdByName('DD2.exe');
if (!pid) {
  console.error('DD2.exe not running');
  process.exit(1);
}
const handle = openProcess(pid);

console.log(`Watching 0x${xAddr.toString(16)} (x?)  0x${centerAddr.toString(16)} (y?)  0x${zAddr.toString(16)} (z?) — Ctrl+C to stop`);

setInterval(() => {
  try {
    const x = readMemory(handle, xAddr, 4).readFloatLE(0);
    const y = readMemory(handle, centerAddr, 4).readFloatLE(0);
    const z = readMemory(handle, zAddr, 4).readFloatLE(0);
    console.log(`${new Date().toISOString()}  x=${x.toFixed(3)}  y=${y.toFixed(3)}  z=${z.toFixed(3)}`);
  } catch (err) {
    console.log(`${new Date().toISOString()}  read error: ${err.message}`);
  }
}, 250);

process.on('SIGINT', () => {
  closeHandle(handle);
  process.exit(0);
});
