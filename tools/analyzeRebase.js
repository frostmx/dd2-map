// Analyzes a ctLogger CSV to classify each address column by behavioral
// signature during a walk-through-rebase capture.
//
// For each column we compute:
//   range     = max - min                 (did it track movement at all?)
//   maxStep   = largest single-tick jump   (discontinuity size)
//   p90Step   = 90th-percentile tick step  (typical movement rate)
//   jumpiness = maxStep / p90Step          (outlier discontinuity => LOCAL)
//   changes   = number of non-zero ticks   (constant vs continuous)
//
// Signatures:
//   GLOBAL  : range large, changes high, jumpiness LOW  (smooth throughout)
//   LOCAL   : range large, changes high, jumpiness HIGH (one big rebase jump)
//   ORIGIN  : range large, changes LOW  (flat, then a step or two)
const fs = require('fs');

const csv = fs.readFileSync(process.argv[2], 'utf-8').trim().split('\n');
const header = csv[0].split(',');
const rows = csv.slice(1).map((l) => l.split(',').map(Number));

const results = [];
for (let c = 1; c < header.length; c++) {
  const vals = rows.map((r) => r[c]).filter((v) => Number.isFinite(v));
  if (vals.length < 10) continue;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min;
  if (range < 1) continue; // ignore addresses that barely moved

  const steps = [];
  for (let i = 1; i < vals.length; i++) steps.push(Math.abs(vals[i] - vals[i - 1]));
  const nonzero = steps.filter((s) => s > 0.001).sort((a, b) => a - b);
  const changes = nonzero.length;
  const maxStep = Math.max(...steps);
  const p90 = nonzero.length ? nonzero[Math.floor(nonzero.length * 0.9)] : 0;
  const jumpiness = p90 > 0 ? maxStep / p90 : Infinity;

  results.push({
    addr: header[c],
    range: range.toFixed(1),
    maxStep: maxStep.toFixed(2),
    p90: p90.toFixed(3),
    jumpiness: jumpiness.toFixed(1),
    changes,
    first: vals[0].toFixed(2),
    last: vals[vals.length - 1].toFixed(2),
  });
}

// GLOBAL candidates: big range, many changes, LOW jumpiness (smooth, no rebase jump)
console.log('=== GLOBAL position candidates (smooth, no discontinuity) ===');
results
  .filter((r) => r.changes > 30 && parseFloat(r.jumpiness) < 4 && parseFloat(r.range) > 10)
  .sort((a, b) => parseFloat(a.jumpiness) - parseFloat(b.jumpiness))
  .slice(0, 30)
  .forEach((r) => console.log(`0x${r.addr}  range=${r.range}  maxStep=${r.maxStep}  p90=${r.p90}  jumpiness=${r.jumpiness}  changes=${r.changes}  ${r.first}->${r.last}`));

console.log('\n=== ORIGIN / cell candidates (flat, then step-jump) ===');
results
  .filter((r) => r.changes < 15 && parseFloat(r.maxStep) > 20)
  .sort((a, b) => a.changes - b.changes)
  .slice(0, 30)
  .forEach((r) => console.log(`0x${r.addr}  range=${r.range}  maxStep=${r.maxStep}  changes=${r.changes}  ${r.first}->${r.last}`));

console.log('\n=== LOCAL position (tracks movement but has a rebase discontinuity) ===');
results
  .filter((r) => r.changes > 30 && parseFloat(r.jumpiness) > 8 && parseFloat(r.range) > 10)
  .sort((a, b) => parseFloat(b.jumpiness) - parseFloat(a.jumpiness))
  .slice(0, 15)
  .forEach((r) => console.log(`0x${r.addr}  range=${r.range}  maxStep=${r.maxStep}  p90=${r.p90}  jumpiness=${r.jumpiness}  changes=${r.changes}`));
