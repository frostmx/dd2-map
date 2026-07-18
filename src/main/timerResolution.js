// Raise the Windows multimedia timer resolution via koffi (already a dependency; nothing
// native is compiled — same pattern as win32Input.js / memoryReader.js).
//
// Why: the camera feed (see index.js camTimer) is a main-process setInterval, and Windows
// floors setInterval at the system timer quantum — ~15.6ms by default. Measured 2026-07-19,
// setInterval(8) and setInterval(16) BOTH produced a ~26ms feed, which pins the AR marker
// latency floor at ~28ms (the render delay must stay >= the feed interval or the markers
// judder). timeBeginPeriod(1) drops the quantum to 1ms process/system-wide, so the 8ms
// timer actually fires at ~8ms and the AR delay can come down to ~12-14ms — roughly half
// the rotation lag.
//
// Cost: a slightly higher timer-interrupt rate for as long as it's in effect (negligible on
// a gaming desktop; games typically request 1ms themselves). It is a global setting that
// MUST be released with timeEndPeriod on exit, or it leaks until the process dies — so this
// is paired begin()/end() and end() is wired to app quit.

const koffi = require('koffi');

const winmm = koffi.load('winmm.dll');

// MMRESULT timeBeginPeriod(UINT uPeriod) / timeEndPeriod(UINT uPeriod). 0 = TIMERR_NOERROR.
const timeBeginPeriod = winmm.func('uint32 timeBeginPeriod(uint32 uPeriod)');
const timeEndPeriod = winmm.func('uint32 timeEndPeriod(uint32 uPeriod)');

const PERIOD_MS = 1;
let active = false;

// Request the 1ms timer quantum. Idempotent; returns true if it's in effect.
function begin() {
  if (active) return true;
  try {
    active = timeBeginPeriod(PERIOD_MS) === 0; // TIMERR_NOERROR
  } catch {
    active = false;
  }
  return active;
}

// Release it. Must be called once per successful begin() (paired), on app quit.
function end() {
  if (!active) return;
  try { timeEndPeriod(PERIOD_MS); } catch { /* nothing we can do on exit */ }
  active = false;
}

module.exports = { begin, end, isActive: () => active };
