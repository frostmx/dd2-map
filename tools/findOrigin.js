// Given a focused_log.csv containing the local position x (column 47A55E10)
// plus several origin candidate columns, find which origin makes
// global = local + origin continuous across the floating-origin rebase.
//
// Strategy:
//  1. locate rebase ticks: where |Δ local_x| is a large outlier
//  2. for each candidate column, compute global = local_x + origin
//  3. score = largest |Δ global| at the rebase ticks (lower = better)
//     The correct origin cancels the local jump, so global stays smooth.
const fs = require('fs');

const csv = fs.readFileSync(process.argv[2], 'utf-8').trim().split('\n');
const header = csv[0].split(',');
const rows = csv.slice(1).map((l) => l.split(',').map(Number));

const LOCAL_X_COL = header.indexOf('47A55E10');
const localX = rows.map((r) => r[LOCAL_X_COL]);

// Find rebase ticks: local_x steps that are large outliers
const steps = [];
for (let i = 1; i < localX.length; i++) steps.push({ i, d: localX[i] - localX[i - 1] });
const sortedAbs = steps.map((s) => Math.abs(s.d)).sort((a, b) => a - b);
const median = sortedAbs[Math.floor(sortedAbs.length / 2)];
const rebaseTicks = steps.filter((s) => Math.abs(s.d) > Math.max(15, median * 20));

console.log(`Local x range: ${Math.min(...localX).toFixed(1)} .. ${Math.max(...localX).toFixed(1)}`);
console.log(`Detected ${rebaseTicks.length} rebase tick(s):`);
rebaseTicks.forEach((s) => console.log(`  tick ${s.i}: local_x jumped ${s.d.toFixed(2)} (${localX[s.i - 1].toFixed(2)} -> ${localX[s.i].toFixed(2)})`));

if (rebaseTicks.length === 0) {
  console.log('\nNo rebase detected in this capture — walk farther / cross more boundaries.');
  process.exit(0);
}

console.log('\n=== Origin candidate scoring (global = local_x + origin) ===');
const scores = [];
for (let c = 4; c < header.length; c++) {
  const origin = rows.map((r) => r[c]);
  // largest global discontinuity at rebase ticks
  let worstRebaseJump = 0;
  for (const rt of rebaseTicks) {
    const gPrev = localX[rt.i - 1] + origin[rt.i - 1];
    const gNow = localX[rt.i] + origin[rt.i];
    worstRebaseJump = Math.max(worstRebaseJump, Math.abs(gNow - gPrev));
  }
  // also overall smoothness of global (max step), ignoring NaN/huge
  const global = rows.map((r) => r[LOCAL_X_COL] + r[c]);
  let maxStep = 0;
  for (let i = 1; i < global.length; i++) {
    const d = Math.abs(global[i] - global[i - 1]);
    if (Number.isFinite(d) && d < 1e6) maxStep = Math.max(maxStep, d);
  }
  scores.push({ addr: header[c], worstRebaseJump, maxStep });
}
scores.sort((a, b) => a.worstRebaseJump - b.worstRebaseJump);
scores.forEach((s) =>
  console.log(`0x${s.addr}: rebase-jump-in-global=${s.worstRebaseJump.toFixed(3)}  maxGlobalStep=${s.maxStep.toFixed(2)}`)
);

console.log('\nLower rebase-jump-in-global = origin cancels the local jump = likely the cell origin.');
