const fs = require('fs');
const { findProcessIdByName, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const pid = findProcessIdByName('DD2.exe');
if (!pid) { console.error('DD2.exe not running'); process.exit(1); }
const handle = openProcess(pid);

const lines = fs.readFileSync(process.argv[2], 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
const outFile = process.argv[3];

const results = {};
for (const line of lines) {
  const addr = BigInt('0x' + line);
  try {
    const v = readMemory(handle, addr, 4).readFloatLE(0);
    results[line] = v;
  } catch {
    results[line] = null;
  }
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`Saved ${Object.keys(results).length} values to ${outFile}`);
closeHandle(handle);
