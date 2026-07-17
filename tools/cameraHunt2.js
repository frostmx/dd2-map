// Find the camera's WORLD MATRIX (full orientation basis) and its RECamera
// component (dynamic fov/near/far/aspect) — the two reads the AR overlay needs.
//
// Key idea, same family as cameraHunt.js: we don't scan for a value, we scan for a
// RELATION. We already read the camera's position live (the solved chain). A via
// transform world matrix stores position as its 4th row — so scan for the live
// camera position embedded at +0x30 of a 4x4 whose 3x3 part is ORTHONORMAL, then
// separate the real one from stale copies by watching which basis ROTATES while the
// mouse swings and whose translation keeps tracking the live camera.
//
// The RECamera component is found by its constant signature instead (layout from
// REFramework's ReClass_Internal_DD2.hpp):
//   +0x30 nearClipPlane (0.01..10)   +0x34 farClipPlane (100..1e6)
//   +0x38 fov (20..120 deg)          +0x3C lookAtDistance
//   +0x40 verticalEnable+pad         +0x44 aspectRatio (1.0..2.7)
// and validated by watching fov/lookAtDistance move during play (aim, sprint).
//
// Usage (two runs, DD2 running, player in the world):
//   node tools/cameraHunt2.js scan    stand STILL, hands off the mouse, until it returns
//   node tools/cameraHunt2.js track   SWING the mouse in circles (and aim/sprint) until it returns
// scan writes candidates to tools/camera2.candidates.json; track filters them in place.

const koffi = require('koffi');
const fs = require('fs');
const {
  findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle,
} = require('../src/main/memoryReader');

const kernel32 = koffi.load('kernel32.dll');
const MBI = koffi.struct('MEMORY_BASIC_INFORMATION2', {
  BaseAddress: 'uintptr_t', AllocationBase: 'uintptr_t', AllocationProtect: 'uint32',
  PartitionId: 'uint16', RegionSize: 'size_t', State: 'uint32', Protect: 'uint32', Type: 'uint32',
});
const VirtualQueryEx = kernel32.func('size_t VirtualQueryEx(void *hProcess, uintptr_t lpAddress, _Out_ MEMORY_BASIC_INFORMATION2 *lpBuffer, size_t dwLength)');

const MEM_COMMIT = 0x1000, MEM_PRIVATE = 0x20000;
const PAGE_RW = 0x04, PAGE_ERW = 0x40, PAGE_GUARD = 0x100;

// The solved camera-position chain (config/dd2.offsets.json cameraPosition.stableChain).
const CAM_STATIC = 0x0F8E7ED0n;
const CAM_OFFSETS = [0x198n, 0x18n, 0x18n, 0x5F8n, 0x800n];

function enumRegions(handle) {
  const out = [];
  let addr = 0n;
  const mbi = {};
  for (;;) {
    if (VirtualQueryEx(handle, addr, mbi, koffi.sizeof(MBI)) === 0) break;
    const protect = mbi.Protect >>> 0;
    const ok = mbi.State === MEM_COMMIT && mbi.Type === MEM_PRIVATE
      && (protect === PAGE_RW || protect === PAGE_ERW) && !(protect & PAGE_GUARD);
    if (ok) out.push({ base: BigInt(mbi.BaseAddress), size: Number(mbi.RegionSize) });
    const next = BigInt(mbi.BaseAddress) + (BigInt(mbi.RegionSize) || 0x1000n);
    if (next <= addr) break;
    addr = next;
  }
  return out;
}

function tryRead(handle, addr, size) {
  try { return readMemory(handle, addr, size); } catch { return null; }
}

function readCamPos(handle, moduleBase) {
  const addr = resolvePointerChain(handle, moduleBase + CAM_STATIC, CAM_OFFSETS);
  const b = readMemory(handle, addr, 12);
  return { x: b.readFloatLE(0), h: b.readFloatLE(4), y: b.readFloatLE(8) };
}

// Is buf (64 bytes) a plausible world matrix? Rows 0..2: unit length, mutually
// orthogonal, w == 0. Row 3: the position, w == 1.
function matrixScore(buf) {
  const r = [];
  for (let i = 0; i < 3; i++) {
    const v = [buf.readFloatLE(i * 16), buf.readFloatLE(i * 16 + 4), buf.readFloatLE(i * 16 + 8)];
    const w = buf.readFloatLE(i * 16 + 12);
    const len = Math.hypot(...v);
    if (Math.abs(len - 1) > 0.01 || Math.abs(w) > 0.001) return null;
    r.push(v);
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (Math.abs(dot(r[0], r[1])) > 0.01 || Math.abs(dot(r[0], r[2])) > 0.01 || Math.abs(dot(r[1], r[2])) > 0.01) return null;
  const w3 = buf.readFloatLE(0x3C);
  if (Math.abs(w3 - 1) > 0.001) return null;
  return r;
}

// yaw/pitch of the -Z (forward) row, for eyeballing
function fwdOf(buf) {
  return [buf.readFloatLE(0x20), buf.readFloatLE(0x24), buf.readFloatLE(0x28)];
}

const CAND_FILE = 'tools/camera2.candidates.json';

async function scanPhase(handle, moduleBase) {
  const cam = readCamPos(handle, moduleBase);
  console.log(`camera at (${cam.x.toFixed(3)}, ${cam.h.toFixed(3)}, ${cam.y.toFixed(3)}) — scanning...`);

  const regions = enumRegions(handle);
  const EPS = 0.5;                 // idle sway tolerance between the read and the scan
  const CHUNK = 8 << 20;

  const matCands = [];             // matrix base addresses (pos row at +0x30)
  const camCands = [];             // RECamera component base addresses
  let scanned = 0;
  for (const reg of regions) {
    for (let off = 0; off < reg.size; off += CHUNK) {
      const want = Math.min(CHUNK + 0x40, reg.size - off); // overlap so a matrix can't straddle
      const buf = tryRead(handle, reg.base + BigInt(off), want);
      if (!buf) continue;
      scanned += buf.length;
      const f = new Float32Array(buf.buffer, 0, buf.length >> 2);
      for (let i = 0; i < f.length - 2; i++) {
        const v = f[i];
        // --- matrix: live camera position as a matrix row ---
        if (v > cam.x - EPS && v < cam.x + EPS
            && Math.abs(f[i + 1] - cam.h) < EPS && Math.abs(f[i + 2] - cam.y) < EPS) {
          const posOff = i * 4;
          if (posOff >= 0x30) {
            const m = buf.subarray(posOff - 0x30, posOff - 0x30 + 0x40);
            if (m.length === 0x40 && matrixScore(m)) {
              matCands.push(reg.base + BigInt(off + posOff - 0x30));
            }
          }
        }
        // --- RECamera: near/far/fov/aspect signature ---
        if (v >= 0.01 && v <= 10 && f[i + 1] >= 100 && f[i + 1] <= 1e6
            && f[i + 2] >= 20 && f[i + 2] <= 120) {
          const aspect = f[i + 5];
          if (aspect >= 1.0 && aspect <= 2.7) {
            camCands.push(reg.base + BigInt(i * 4) - 0x30n);  // near sits at +0x30
          }
        }
      }
    }
  }
  console.log(`scanned ${(scanned / (1 << 30)).toFixed(2)} GB: ${matCands.length} matrix candidates, ${camCands.length} RECamera candidates`);
  fs.writeFileSync(CAND_FILE, JSON.stringify({
    when: new Date().toISOString(), phase: 'scan', camAt: cam,
    matrices: matCands.map((a) => '0x' + a.toString(16)),
    cameras: camCands.map((a) => '0x' + a.toString(16)),
  }, null, 2));
  console.log(`saved ${CAND_FILE}\nNow run:  node tools/cameraHunt2.js track   and SWING THE MOUSE until it returns.`);
}

// -- track: swing the mouse; the real matrix ROTATES and keeps tracking the cam --
async function trackPhase(handle, moduleBase) {
  const saved = JSON.parse(fs.readFileSync(CAND_FILE, 'utf-8'));
  const matCands = saved.matrices.map(BigInt);
  const camCands = saved.cameras.map(BigInt);
  console.log(`tracking ${matCands.length} matrices / ${camCands.length} cameras for 10s — SWING THE MOUSE, aim, sprint...`);
  const track = matCands.map((a) => ({ addr: a, rot: 0, leashMax: 0, alive: true, lastFwd: null }));
  const camTrack = camCands.map((a) => ({ addr: a, fovMin: Infinity, fovMax: -Infinity, lookMin: Infinity, lookMax: -Infinity, alive: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const live = readCamPos(handle, moduleBase);
    for (const c of track) {
      if (!c.alive) continue;
      const m = tryRead(handle, c.addr, 0x40);
      if (!m || !matrixScore(m)) { c.alive = false; continue; }
      const px = m.readFloatLE(0x30), ph = m.readFloatLE(0x34), py = m.readFloatLE(0x38);
      const leash = Math.hypot(px - live.x, ph - live.h, py - live.y);
      c.leashMax = Math.max(c.leashMax, leash);
      if (leash > 5) { c.alive = false; continue; }   // a stale copy the camera walked away from
      const fw = fwdOf(m);
      if (c.lastFwd) {
        const d = Math.hypot(fw[0] - c.lastFwd[0], fw[1] - c.lastFwd[1], fw[2] - c.lastFwd[2]);
        c.rot += d;
      }
      c.lastFwd = fw;
    }
    for (const c of camTrack) {
      if (!c.alive) continue;
      const b = tryRead(handle, c.addr + 0x30n, 0x18);
      if (!b) { c.alive = false; continue; }
      const near = b.readFloatLE(0), far = b.readFloatLE(4), fov = b.readFloatLE(8), look = b.readFloatLE(12);
      if (!(near >= 0.001 && near <= 20 && far >= 50 && fov >= 5 && fov <= 179)) { c.alive = false; continue; }
      c.fovMin = Math.min(c.fovMin, fov); c.fovMax = Math.max(c.fovMax, fov);
      c.lookMin = Math.min(c.lookMin, look); c.lookMax = Math.max(c.lookMax, look);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const rotOk = track.filter((c) => c.alive && c.rot > 0.5).sort((a, b) => b.rot - a.rot);
  console.log(`\n=== world matrices that rotated with the mouse (${rotOk.length}) ===`);
  for (const c of rotOk.slice(0, 12)) {
    console.log(`  0x${c.addr.toString(16)}  rotation ${c.rot.toFixed(2)}  leashMax ${c.leashMax.toFixed(2)}u`);
  }

  const camAlive = camTrack.filter((c) => c.alive);
  const fovMoved = camAlive.filter((c) => c.fovMax - c.fovMin > 0.01 || c.lookMax - c.lookMin > 0.01);
  console.log(`\n=== RECamera candidates alive ${camAlive.length}, with moving fov/lookAt ${fovMoved.length} ===`);
  for (const c of (fovMoved.length ? fovMoved : camAlive).slice(0, 12)) {
    const b = tryRead(handle, c.addr + 0x30n, 0x18);
    if (!b) continue;
    console.log(`  0x${c.addr.toString(16)}  near ${b.readFloatLE(0).toFixed(3)} far ${b.readFloatLE(4).toFixed(0)} fov ${b.readFloatLE(8).toFixed(2)} (${c.fovMin.toFixed(2)}..${c.fovMax.toFixed(2)}) look ${b.readFloatLE(12).toFixed(2)} aspect ${b.readFloatLE(0x14).toFixed(4)}`);
  }

  fs.writeFileSync(CAND_FILE, JSON.stringify({
    when: new Date().toISOString(),
    phase: 'track',
    matrices: rotOk.map((c) => ({ addr: '0x' + c.addr.toString(16), rot: +c.rot.toFixed(2), leashMax: +c.leashMax.toFixed(2) })),
    cameras: (fovMoved.length ? fovMoved : camAlive).map((c) => ({ addr: '0x' + c.addr.toString(16), fovMin: c.fovMin, fovMax: c.fovMax })),
  }, null, 2));
  console.log(`\nsaved ${CAND_FILE}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'scan' && mode !== 'track') {
    console.error('usage: node tools/cameraHunt2.js scan|track');
    process.exit(1);
  }
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) { console.error('DD2.exe not running'); process.exit(1); }
  const moduleBase = BigInt(findModuleBase(pid, 'DD2.exe').base);
  const handle = openProcess(pid);
  try {
    if (mode === 'scan') await scanPhase(handle, moduleBase);
    else await trackPhase(handle, moduleBase);
  } finally {
    closeHandle(handle);
  }
}

main();
