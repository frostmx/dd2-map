// Continuous multi-address logger. Reads every address in a list every ~200ms
// and appends a CSV row (timestamp + one column per address). Used to catch a
// floating-origin rebase in the act: while the player walks across a streaming
// boundary, we can then diff columns to classify each address as:
//   - LOCAL position   : smooth, but with a sudden discontinuity at the rebase
//   - GLOBAL position  : smooth throughout, no discontinuity (the prize)
//   - ORIGIN / cell     : ~constant while walking, single step-jump at the rebase
//
// Usage: node ctLogger.js <addressListFile> <outCsv>
const fs = require('fs');
const { findProcessIdByName, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const listFile = process.argv[2];
const outCsv = process.argv[3] || 'ct_log.csv';

const pid = findProcessIdByName('DD2.exe');
if (!pid) { console.error('DD2.exe not running'); process.exit(1); }
const handle = openProcess(pid);

const addrs = fs.readFileSync(listFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
const bigAddrs = addrs.map((a) => BigInt('0x' + a));

const out = fs.openSync(outCsv, 'w');
fs.writeSync(out, 't,' + addrs.join(',') + '\n');

console.log(`Logging ${addrs.length} addresses to ${outCsv} every 200ms. Ctrl+C to stop.`);

const start = Date.now();
const timer = setInterval(() => {
  const t = ((Date.now() - start) / 1000).toFixed(2);
  const vals = [t];
  for (const a of bigAddrs) {
    try {
      vals.push(readMemory(handle, a, 4).readFloatLE(0).toFixed(4));
    } catch {
      vals.push('NaN');
    }
  }
  fs.writeSync(out, vals.join(',') + '\n');
}, 200);

process.on('SIGINT', () => {
  clearInterval(timer);
  fs.closeSync(out);
  closeHandle(handle);
  console.log('\nStopped.');
  process.exit(0);
});
