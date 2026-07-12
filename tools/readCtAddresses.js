const fs = require('fs');
const { findProcessIdByName, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const pid = findProcessIdByName('DD2.exe');
if (!pid) {
  console.error('DD2.exe not running');
  process.exit(1);
}
const handle = openProcess(pid);

const lines = fs.readFileSync(process.argv[2], 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);

for (const line of lines) {
  const addr = BigInt('0x' + line);
  try {
    const buf = readMemory(handle, addr - 8n, 32);
    const floats = [];
    for (let i = 0; i < 32; i += 4) floats.push(buf.readFloatLE(i).toFixed(3));
    floats[2] = `[${floats[2]}]`; // mark the target address itself (offset 8 into our -8..+24 window)
    console.log(`0x${line}:  ${floats.join('  ')}`);
  } catch (err) {
    console.log(`0x${line}:  READ FAILED (${err.message})`);
  }
}

closeHandle(handle);
