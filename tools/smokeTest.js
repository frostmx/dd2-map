const { findProcessIdByName, findModuleBase, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const pid = findProcessIdByName('DD2.exe');
if (!pid) {
  console.error('DD2.exe not found — is the game running?');
  process.exit(1);
}
console.log('Found DD2.exe, PID =', pid);

const mod = findModuleBase(pid, 'DD2.exe');
if (!mod) {
  console.error('Could not resolve DD2.exe module base');
  process.exit(1);
}
console.log('Module base =', '0x' + mod.base.toString(16), 'size =', mod.size);

const handle = openProcess(pid);
console.log('OpenProcess succeeded without elevation, handle =', handle);

// PE header smoke test: bytes at module base should start with "MZ" (0x4D 0x5A)
const header = readMemory(handle, mod.base, 64);
console.log('First bytes at module base:', header.subarray(0, 16).toString('hex'));
console.log('MZ magic check:', header[0] === 0x4d && header[1] === 0x5a ? 'PASS' : 'FAIL');

closeHandle(handle);
