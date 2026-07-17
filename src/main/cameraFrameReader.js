// The camera's full orientation basis + dynamic FOV — what turns a POI's world
// position into a screen position (the AR overlay). Second consumer of the
// managed-singleton chain (see timeReader.js for the first, FINDINGS.md for the map).
//
// Chain (constants from config/singletons.json, regenerate after a game patch with
// `node tools/singletonHunt.js --save` + the cameraChain block):
//
//   DD2.exe+vmGlobalRva -> VM -> staticTbl -> elements[holder(app.CameraManager)]
//   +0x8  -> CameraManager instance
//   +0x10 -> _CameraObjects (fixed array)     +0x20 -> [0] = the camera GameObject
//   +0x18 -> Transform
//       +0x80  rows 0..2 = right/up/forward basis (orthonormal, checked every read)
//       +0xB0  row 3     = position — in the CELL-LOCAL frame, so it is NOT used;
//                          the caller supplies the global camera position (the same
//                          solved chain the facing vector already reads)
//   Transform+0x18 (childComponent) -> RECamera
//       +0x30 near   +0x34 far   +0x38 fov(deg)   +0x3C lookAtDistance   +0x44 aspect
//
// A read that fails any sanity check returns null: the AR layer holds its last frame
// (or draws nothing) rather than spraying markers from a garbage matrix.

const store = require('./configStore');
const { readMemory, readPointer } = require('./memoryReader');

let cfg = null;
let cfgLoaded = false;

function config() {
  if (!cfgLoaded) {
    cfgLoaded = true;
    const raw = store.load('singletons');
    const cm = raw && raw.types && raw.types['app.CameraManager'];
    if (raw && cm && raw.cameraChain) {
      cfg = {
        vmGlobalRva: BigInt(raw.vmGlobalRva),
        staticTblOffset: BigInt(raw.staticTblOffsetInVm),
        holderTypeIndex: cm.holderTypeIndex,
      };
    }
  }
  return cfg;
}

const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 0.01;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// -> { right, up, fwd, posLocal, fovDeg, aspect, near } or null. Never throws.
// Vectors are [x, h, y] in GAME axes (engine y-up), same convention as positions.
function read(handle, moduleBase) {
  const c = config();
  if (!c || !handle || moduleBase == null) return null;
  try {
    const vm = readPointer(handle, moduleBase + c.vmGlobalRva);
    const elements = readPointer(handle, vm + c.staticTblOffset);
    const statics = readPointer(handle, elements + BigInt(c.holderTypeIndex * 8));
    const inst = readPointer(handle, statics + 0x8n);
    const arr = readPointer(handle, inst + 0x10n);
    const go = readPointer(handle, arr + 0x20n);
    const tf = readPointer(handle, go + 0x18n);
    if (tf === 0n) return null;

    const m = readMemory(handle, tf + 0x80n, 0x40);
    const row = (i) => [m.readFloatLE(i * 16), m.readFloatLE(i * 16 + 4), m.readFloatLE(i * 16 + 8)];
    const right = row(0), up = row(1), fwd = row(2), posLocal = row(3);
    if (!unit(right) || !unit(up) || !unit(fwd)) return null;
    if (Math.abs(dot(right, up)) > 0.01 || Math.abs(dot(right, fwd)) > 0.01) return null;

    const cam = readPointer(handle, tf + 0x18n);
    const f = readMemory(handle, cam + 0x30n, 0x18);
    const near = f.readFloatLE(0);
    const fovDeg = f.readFloatLE(8);
    const aspect = f.readFloatLE(0x14);
    if (!(fovDeg > 5 && fovDeg < 179) || !(aspect > 0.5 && aspect < 4)) return null;

    return { right, up, fwd, posLocal, fovDeg, aspect, near };
  } catch {
    return null;
  }
}

module.exports = { read };
