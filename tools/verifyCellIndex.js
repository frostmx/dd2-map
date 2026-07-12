// Verify cell-index candidates by the property we actually need:
//   world = k*128 + local   must be CONTINUOUS across a boundary snap.
//
// At a snap the local coord jumps by J (~ +/-128). For world to stay continuous,
// k must move by exactly -J/128 (rounded). A true cell index does this every time;
// a coincidental flag does not.
//
// This also sidesteps the teleport problem: we test the property directly instead
// of assuming every boundary event is a clean +/-1 step.
//
// Usage: node src/main/verifyCellIndex.js
//   Walk across boundaries. Prefer several crossings in the SAME direction -- a
//   real index marches monotonically (0,1,2,3...), a flag just toggles.

const { findProcessIdByName, findModuleBase, openProcess, readMemory } = require('../src/main/memoryReader');

const STATIC_A = 0x0fa65f70n;   // clean local: x@+0, h@+4, y@+8 (re-centers to 0)
const SNAP_MIN = 60;
const CELL = 128;

// survivors of the X hunt (session addresses -- valid only while DD2 stays running)
const CANDIDATES = [
  0x1b668cd04n, 0x1b66bd80cn, 0x1b66c542cn,
  0x1bdc040e4n, 0x1bdc047ecn, 0x1bdc097ecn, 0x1bdc1ca04n, 0x1bdc2b264n,
  0x108b9e603cn, 0x1170b4ceecn,
];

const pid = findProcessIdByName('DD2.exe');
if (!pid) throw new Error('DD2.exe not running');
const h = openProcess(pid);
const base = BigInt(findModuleBase(pid, 'DD2.exe').base);

const readLocal = () => {
  const b = readMemory(h, base + STATIC_A, 12);
  return { x: b.readFloatLE(0), y: b.readFloatLE(8) };
};
const readK = (addr) => {
  try { return readMemory(h, addr, 4).readFloatLE(0); } catch { return NaN; }
};

// score[i] = { pass, fail } for each sign convention
const stats = CANDIDATES.map(() => ({ posPass: 0, posFail: 0, negPass: 0, negFail: 0, seen: [] }));

let prevLocal = readLocal();
let prevK = CANDIDATES.map(readK);
let crossings = 0;

console.log('Verifying', CANDIDATES.length, 'candidates. Walk across boundaries (same direction preferred).\n');

setInterval(() => {
  let cur;
  try { cur = readLocal(); } catch { return; }
  const dx = cur.x - prevLocal.x;
  const curK = CANDIDATES.map(readK);

  if (Math.abs(dx) > SNAP_MIN) {
    crossings++;
    // For world = k*128 + local to be continuous, k must absorb the jump:
    const needPos = Math.round(-dx / CELL);   // convention: world = +k*128 + local
    const needNeg = Math.round(dx / CELL);    // convention: world = -k*128 + local
    console.log(`\n*** X SNAP #${crossings}: local jumped ${dx.toFixed(2)}  ->  k must step ${needPos > 0 ? '+' : ''}${needPos} (or ${needNeg > 0 ? '+' : ''}${needNeg} if sign-flipped)`);

    for (let i = 0; i < CANDIDATES.length; i++) {
      const dk = curK[i] - prevK[i];
      const s = stats[i];
      if (dk === needPos) s.posPass++; else s.posFail++;
      if (dk === needNeg) s.negPass++; else s.negFail++;
      s.seen.push(curK[i]);
      const okP = dk === needPos ? 'OK ' : '   ';
      const okN = dk === needNeg ? 'OK(-)' : '     ';
      console.log(
        `   0x${CANDIDATES[i].toString(16).padEnd(11)}  ${String(prevK[i]).padStart(6)} -> ${String(curK[i]).padStart(6)}  dk=${dk > 0 ? '+' : ''}${dk}   ${okP}${okN}`
      );
    }
  }

  prevLocal = cur;
  prevK = curK;
}, 100);

process.on('SIGINT', report);
setTimeout(report, 240000);

function report() {
  console.log('\n\n================ VERDICT ================');
  console.log('A true cell index passes EVERY crossing under ONE consistent convention,');
  console.log('and its values should march (not just toggle between two numbers).\n');
  for (let i = 0; i < CANDIDATES.length; i++) {
    const s = stats[i];
    const uniq = [...new Set(s.seen)];
    const total = s.posPass + s.posFail;
    if (!total) continue;
    const best = s.posPass >= s.negPass
      ? { name: 'world=+k*128+local', pass: s.posPass }
      : { name: 'world=-k*128+local', pass: s.negPass };
    const verdict = best.pass === total ? '<<< PASSES ALL' : '';
    console.log(
      `0x${CANDIDATES[i].toString(16).padEnd(11)}  ${best.name}  ${best.pass}/${total} crossings` +
      `   values seen: [${uniq.join(', ')}]  ${verdict}`
    );
  }
  console.log('\nA candidate that only ever toggles between two values (e.g. 0 and 1) while you');
  console.log('cross several cells in the SAME direction is a flag, not an index.');
  process.exit(0);
}
