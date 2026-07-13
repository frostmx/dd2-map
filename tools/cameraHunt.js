// Hunt the CAMERA position in DD2's memory.
//
//   node tools/cameraHunt.js              -> scan, then narrow live while you play
//   node tools/cameraHunt.js watch <addr> -> verify one address (hex, absolute or DD2.exe+X)
//
// WHY
//
// The camera was found once, on 2026-07-10, as raw address 0x3b8c4c60 — and thrown
// away, because we were looking for the player and it wasn't. It reallocates, so that
// address is dead. Nothing about the camera survives except the note in
// config/dd2.offsets.json saying it existed.
//
// It's worth having: the camera looks AT the player, so the horizontal vector
// camera->player IS the view direction. That's a real facing angle — available while
// standing still, unlike the movement-derived heading the map uses today.
//
// HOW (the leash)
//
// A value scan for "the camera" has no value to scan for. But the camera has a
// property nothing else in memory has: it is ON A LEASH. Whatever you do — walk,
// sprint, teleport, cross a floating-origin cell boundary — it stays a few units from
// the player. So the filter is a RELATION, not a number:
//
//   a Vec3 (x, h, y) laid out like the local mirror, whose horizontal distance to the
//   player stays inside [LEASH_MIN, LEASH_MAX] on EVERY sample, and which moves.
//
// Pass 1 sweeps all committed memory (module image included — the local mirror and the
// inside flag are both module-static, so the camera may well be too) and keeps every
// address satisfying the leash right now. That's a lot of float soup. Every later pass
// re-reads only the survivors and drops the ones that left the leash. Float soup is not
// on a leash; it dies within a few metres of walking.
//
// The second discriminator is the one that unmasked the camera as the camera last time,
// now run in reverse: while the player floats are FROZEN and a candidate is still
// moving, you are turning the mouse and nothing but the camera does that. Candidates
// that show it are ranked first.
//
// Both reference frames are tested. The player has a LOCAL (cell-relative) position and
// an ABSOLUTE one; the camera could be stored against either, so a candidate qualifies
// on whichever frame it holds the leash in, and the frame is reported.
//
// Stand still and swing the mouse for a few seconds, then walk a good distance, then
// stand still and swing again. Ctrl+C prints the survivors.

const koffi = require('koffi');
const {
  findProcessIdByName, findModuleBase, openProcess, readMemory, resolvePointerChain, closeHandle,
} = require('../src/main/memoryReader');

const kernel32 = koffi.load('kernel32.dll');

const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uintptr_t',
  AllocationBase: 'uintptr_t',
  AllocationProtect: 'uint32',
  PartitionId: 'uint16',
  RegionSize: 'size_t',
  State: 'uint32',
  Protect: 'uint32',
  Type: 'uint32',
});
const VirtualQueryEx = kernel32.func(
  'size_t VirtualQueryEx(void *hProcess, uintptr_t lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, size_t dwLength)'
);
const ReadProcessMemoryRaw = kernel32.func(
  'bool ReadProcessMemory(void *hProcess, uintptr_t lpBaseAddress, _Out_ uint8 *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)'
);

const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const MEM_IMAGE = 0x1000000;
const PAGE_READWRITE = 0x04;
const PAGE_EXECUTE_READWRITE = 0x40;
const PAGE_WRITECOPY = 0x08;
const PAGE_GUARD = 0x100;

// Where the player is, as the app reads it (src/main/index.js).
const LOCAL_MIRROR_OFFSET = 0x0fa65f70n;          // x @+0, h @+4, y @+8
const GLOBAL_STATIC_OFFSET = 0x0fd26358n;
const GLOBAL_OFFSETS = [0x1a8, 0x410];
const GLOBAL_FALLBACK_STATIC_OFFSET = 0x0f8e1130n;
const GLOBAL_FALLBACK_OFFSETS = [0x210, 0x50];
const CELL = 128;

// The leash. DD2's third-person camera orbits a couple of metres out.
//
// Tighter than instinct says it should be, and that is deliberate. The LOCAL coords are
// CELL-RELATIVE — they wrap inside a 128-unit box, so the player's x never leaves ±64
// however far you run. A generous leash therefore spans a large slice of the entire
// reachable value range, and random float soup simply sits inside it forever: a first
// run with a 30-unit leash stalled at 2.3M candidates that could not be walked off.
// In the local frame the leash only has teeth if it is genuinely tight.
const LEASH_MIN = 0.20;   // 0 would keep every copy of the player position itself
const LEASH_MAX = 12.0;
const DH_MIN = -4.0;      // camera height relative to the player: can dip below on a slope
const DH_MAX = 12.0;

// "The player did not move this sample" — the frames where only the mouse is moving.
const STILL_EPS = 0.02;
const MOVED_EPS = 0.03;   // ...and the candidate did. That's a camera swing.

const PASS_MS = 700;

// staticOnly restricts the sweep to DD2.exe's own writable image pages — its .data, where
// the local mirror (+FA65F70) and the inside flag (+FA62CAC) already live. 92MB instead of
// 9.4GB: 5 seconds instead of 137, which is the difference between spending the session
// sweeping and spending it NARROWING. Note .text is excluded by the writable test, and must
// be: x86 code reinterpreted as floats lands inside the leash by chance often enough to
// bury the result (a first attempt over the whole image returned 230k junk hits).
function enumRegions(handle, staticOnly, moduleBase, moduleSize) {
  const regions = [];
  let addr = staticOnly ? moduleBase : 0n;
  const end = staticOnly ? moduleBase + BigInt(moduleSize) : null;
  const mbi = {};
  for (;;) {
    if (end && addr >= end) break;
    const written = VirtualQueryEx(handle, addr, mbi, koffi.sizeof(MEMORY_BASIC_INFORMATION));
    if (written === 0) break;
    const protect = mbi.Protect >>> 0;
    const writable = protect === PAGE_READWRITE || protect === PAGE_EXECUTE_READWRITE || protect === PAGE_WRITECOPY;
    const interesting = staticOnly ? mbi.Type === MEM_IMAGE : (mbi.Type === MEM_PRIVATE || mbi.Type === MEM_IMAGE);
    if (mbi.State === MEM_COMMIT && interesting && writable && !(protect & PAGE_GUARD)) {
      regions.push({ base: BigInt(mbi.BaseAddress), size: Number(mbi.RegionSize) });
    }
    const base = BigInt(mbi.BaseAddress);
    const size = BigInt(mbi.RegionSize) || 0x1000n;
    addr = base + size;
    if (addr <= 0n) break;
  }
  return regions;
}

function readInto(handle, addr, size, buf) {
  const got = [0];
  return ReadProcessMemoryRaw(handle, addr, buf, size, got) ? Number(got[0]) : 0;
}

function readPlayer(handle, moduleBase) {
  const m = readMemory(handle, moduleBase + LOCAL_MIRROR_OFFSET, 12);
  const local = { x: m.readFloatLE(0), h: m.readFloatLE(4), y: m.readFloatLE(8) };

  // Same grid check the app makes: a global read is only believable if it sits on the
  // 128-unit cell grid relative to the local mirror. Anything else is a bad resolve.
  const onGrid = (g, l) => Number.isFinite(g) && Math.abs((g - l) / CELL - Math.round((g - l) / CELL)) < 0.05;
  const tryChain = (staticOff, offs) => {
    try {
      const a = resolvePointerChain(handle, moduleBase + staticOff, offs);
      const b = readMemory(handle, a, 12);
      const g = { x: b.readFloatLE(0), h: local.h, y: b.readFloatLE(8) };
      return onGrid(g.x, local.x) && onGrid(g.y, local.y) ? g : null;
    } catch {
      return null;
    }
  };
  const global = tryChain(GLOBAL_STATIC_OFFSET, GLOBAL_OFFSETS)
    || tryChain(GLOBAL_FALLBACK_STATIC_OFFSET, GLOBAL_FALLBACK_OFFSETS);

  if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return null;
  return { local, global };
}

// The whole test, in one place: does this Vec3 sit on the player's leash?
function onLeash(cx, ch, cy, p) {
  if (!Number.isFinite(cx) || !Number.isFinite(ch) || !Number.isFinite(cy)) return false;
  const dh = ch - p.h;
  if (dh < DH_MIN || dh > DH_MAX) return false;
  const d = Math.hypot(cx - p.x, cy - p.y);
  return d >= LEASH_MIN && d <= LEASH_MAX;
}

function frameOf(cx, ch, cy, player) {
  if (onLeash(cx, ch, cy, player.local)) return 'local';
  if (player.global && onLeash(cx, ch, cy, player.global)) return 'global';
  return null;
}

// ---------------------------------------------------------------- pass 1: full sweep

const CHUNK = 1 << 20;

function sweep(handle, moduleBase, moduleSize, player, staticOnly) {
  const regions = enumRegions(handle, staticOnly, moduleBase, moduleSize);
  const totalMB = regions.reduce((s, r) => s + r.size, 0) / (1024 * 1024);
  console.log(`Sweeping ${regions.length} ${staticOnly ? 'STATIC ' : ''}regions, ${totalMB.toFixed(0)} MB, for Vec3s on the player's leash...`);

  // A Float32Array VIEW over the same bytes koffi writes into, not Buffer.readFloatLE.
  // The whole heap is 2.4 billion 4-byte positions; the readFloatLE call overhead alone
  // made pass 1 take 137s, which is most of a hunting session spent not hunting.
  const ab = new ArrayBuffer(CHUNK);
  const buf = Buffer.from(ab);
  const f32 = new Float32Array(ab);

  const hits = [];   // absolute addresses, as Numbers (user-space fits in a double)
  const px = player.local.x;
  const gx = player.global ? player.global.x : NaN;
  const hasGlobal = Number.isFinite(gx);

  for (const region of regions) {
    for (let off = 0; off < region.size; off += CHUNK) {
      const size = Math.min(CHUNK, region.size - off);
      const addr = region.base + BigInt(off);
      const got = readInto(handle, addr, size, buf);
      if (!got) continue;
      const limit = (got - 12) >> 2;
      for (let j = 0; j <= limit; j++) {
        // Cheap gate first: x alone must be within reach in SOME frame. Kills almost
        // everything before we pay for two more reads and a hypot.
        const cx = f32[j];
        if (!(Math.abs(cx - px) <= LEASH_MAX) && !(hasGlobal && Math.abs(cx - gx) <= LEASH_MAX)) continue;
        if (frameOf(cx, f32[j + 1], f32[j + 2], player)) hits.push(Number(addr + BigInt(j << 2)));
      }
    }
  }
  return hits;
}

// ------------------------------------------------------- later passes: only survivors

// Re-reading N candidates individually is N ReadProcessMemory calls per pass, which is
// unaffordable while N is in the millions. Group them by page and read each page once.
function readCandidates(handle, addrs) {
  const byPage = new Map();
  for (const a of addrs) {
    const page = Math.floor(a / 4096) * 4096;
    let list = byPage.get(page);
    if (!list) byPage.set(page, (list = []));
    list.push(a);
  }
  const buf = Buffer.alloc(4096 + 16);   // +16 so a Vec3 straddling the page end still reads
  const out = new Map();
  for (const [page, list] of byPage) {
    const got = readInto(handle, BigInt(page), 4096 + 16, buf);
    if (!got) continue;
    for (const a of list) {
      const i = a - page;
      if (i + 12 > got) continue;
      out.set(a, [buf.readFloatLE(i), buf.readFloatLE(i + 4), buf.readFloatLE(i + 8)]);
    }
  }
  return out;
}

const hex = (n) => '0x' + BigInt(n).toString(16);

function describe(addr, moduleBase, moduleSize) {
  const a = BigInt(addr);
  if (a >= moduleBase && a < moduleBase + BigInt(moduleSize)) {
    return `DD2.exe+${(a - moduleBase).toString(16).toUpperCase()}   <<< MODULE-STATIC`;
  }
  return `${hex(addr)}   (heap — would need a pointer scan)`;
}

function main() {
  const pid = findProcessIdByName('DD2.exe');
  if (!pid) throw new Error('DD2.exe not running');
  const handle = openProcess(pid);
  const mod = findModuleBase(pid, 'DD2.exe');
  const moduleBase = BigInt(mod.base);

  const arg = process.argv[2];
  if (arg === 'watch') return watch(handle, moduleBase, process.argv[3]);
  if (arg === 'check') return check(handle, moduleBase, process.argv.slice(3));

  const player = readPlayer(handle, moduleBase);
  if (!player) throw new Error('cannot read the player position — is a save loaded?');
  console.log(`DD2.exe pid=${pid} base=${hex(moduleBase)}`);
  console.log(`player local  (${player.local.x.toFixed(2)}, ${player.local.y.toFixed(2)}) h=${player.local.h.toFixed(2)}`);
  console.log(player.global
    ? `player global (${player.global.x.toFixed(1)}, ${player.global.y.toFixed(1)})`
    : 'player global UNAVAILABLE — only the local frame will be searched');
  console.log('');

  // Default to the static sweep: it's 30x faster, and the player position, the inside
  // flag and the zone id are ALL module-static in this game, so it's where to look first.
  // `--all` widens to the whole 9.4GB heap when static comes up empty.
  const staticOnly = !process.argv.includes('--all');
  const t0 = Date.now();
  let alive = sweep(handle, moduleBase, mod.size, player, staticOnly);
  console.log(`pass 1: ${alive.length.toLocaleString()} candidates (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  console.log('Now PLAY. Stand still and swing the camera, then walk a long way, then swing again.');
  console.log('Ctrl+C when the count stops falling.\n');

  // Per-candidate history: which frame it holds the leash in, whether it has ever moved,
  // and whether it has ever moved WHILE THE PLAYER DIDN'T (the camera-swing signature).
  const state = new Map();
  for (const a of alive) state.set(a, { moved: false, swung: 0, frame: null, dMin: Infinity, dMax: 0, span: 0, box: null });

  let prevPlayer = player;
  let pass = 1;

  const tick = () => {
    const p = readPlayer(handle, moduleBase);
    if (!p) return;
    pass++;

    const stillLocal = Math.hypot(p.local.x - prevPlayer.local.x, p.local.y - prevPlayer.local.y) < STILL_EPS
      && Math.abs(p.local.h - prevPlayer.local.h) < STILL_EPS;

    const values = readCandidates(handle, alive);
    const next = [];
    for (const a of alive) {
      const v = values.get(a);
      const st = state.get(a);
      if (!v) continue;                       // page went away — the allocation died
      const [cx, ch, cy] = v;
      const frame = frameOf(cx, ch, cy, p);
      if (!frame) continue;                   // LEFT THE LEASH. Not the camera.
      st.frame = frame;

      const ref = frame === 'local' ? p.local : p.global;
      const d = Math.hypot(cx - ref.x, cy - ref.y);
      if (d < st.dMin) st.dMin = d;
      if (d > st.dMax) st.dMax = d;

      if (st.prev) {
        const moved = Math.hypot(cx - st.prev[0], cy - st.prev[2]) > MOVED_EPS
          || Math.abs(ch - st.prev[1]) > MOVED_EPS;
        if (moved) st.moved = true;
        // "It moved and the player didn't" is necessary but NOT sufficient — it also
        // describes every bone in the skeleton, which sways through the idle animation
        // while the root position is frozen. A first run ranked by tightest leash and
        // returned 548 hits sitting 0.3-0.7u from the player: bones, all of them.
        //
        // What separates them is HOW FAR they roam while you stand still. Swing the mouse
        // 180 degrees and the camera sweeps an arc around you — metres of travel at a
        // near-constant radius. A bone jiggles by centimetres. So track the bounding box
        // of each candidate over the still frames only; its span IS the discriminator.
        //
        // Box the offset FROM THE PLAYER, never the absolute position. Absolute boxes
        // measure where you walked, not what the camera did: the local coords wrap by
        // +/-128 at every cell boundary, so a first attempt reported a 148u "arc" under
        // a 12u leash, which is just the map. The offset is what sweeps the circle.
        if (moved && stillLocal) {
          st.swung++;
          const ox = cx - ref.x;
          const oy = cy - ref.y;
          if (!st.box) st.box = { x0: ox, x1: ox, y0: oy, y1: oy };
          else {
            if (ox < st.box.x0) st.box.x0 = ox;
            if (ox > st.box.x1) st.box.x1 = ox;
            if (oy < st.box.y0) st.box.y0 = oy;
            if (oy > st.box.y1) st.box.y1 = oy;
          }
          st.span = Math.max(st.box.x1 - st.box.x0, st.box.y1 - st.box.y0);
        }
      }
      st.prev = v;
      next.push(a);
    }
    alive = next;
    prevPlayer = p;

    const swung = alive.filter((a) => state.get(a).swung > 0).length;
    console.log(`pass ${String(pass).padStart(3)}: ${String(alive.length).padStart(9)} on the leash   ` +
      `(${swung} of them have moved while you stood still)`);

    if (alive.length && alive.length <= 40) report(alive, state, moduleBase, mod.size);
  };

  const timer = setInterval(tick, PASS_MS);

  const finish = () => {
    clearInterval(timer);
    console.log('\n=== survivors ===');
    report(alive, state, moduleBase, mod.size, true);
    closeHandle(handle);
    process.exit(0);
  };
  process.on('SIGINT', finish);

  // Optional run length, so the hunt can be driven by someone who is busy playing
  // rather than watching the terminal:  node tools/cameraHunt.js 60
  const seconds = Number(process.argv[2]);
  if (Number.isFinite(seconds) && seconds > 0) {
    console.log(`(auto-stops after ${seconds}s)\n`);
    setTimeout(finish, seconds * 1000);
  }
}

function report(alive, state, moduleBase, moduleSize, final = false) {
  // Rank by how far it ROAMED while you stood still. A camera swinging around you tops
  // this list by metres; a bone can't, however close to the player it sits.
  const rows = alive.map((a) => ({ a, st: state.get(a) }))
    .sort((r1, r2) => r2.st.span - r1.st.span || r1.st.dMax - r2.st.dMax);

  const show = final ? rows.slice(0, 25) : rows.slice(0, 8);
  console.log('');
  for (const { a, st } of show) {
    const tag = st.swung > 0 ? `swung x${st.swung}` : (st.moved ? 'moves' : 'STATIC (suspect)');
    const verdict = st.span > 1.5 ? '  <<< SWEEPS AN ARC — camera-shaped' : (st.span > 0 ? '  (jiggles — bone?)' : '');
    console.log(`  ${describe(a, moduleBase, moduleSize)}`);
    console.log(`      frame=${st.frame}  dist ${st.dMin.toFixed(2)}..${st.dMax.toFixed(2)}u  ` +
      `roam-while-still ${st.span.toFixed(2)}u  ${tag}${verdict}`);
  }
  if (rows.length > show.length) console.log(`  ... and ${rows.length - show.length} more`);
  console.log('');
  if (final && rows.length) {
    console.log(`Verify one with:  node tools/cameraHunt.js watch ${hex(rows[0].a)}`);
  }
}

// ------------------------------------------------------------------------- check mode
//
//   node tools/cameraHunt.js check FD2BE20 FD2C230 ...
//
// Triage a list of addresses you already have (a CE scan, a hunch) instead of sweeping
// for new ones. Each is read as a Vec3 — but ALSO at every 4-byte offset from -32 to +48
// around it, because a scan hit usually lands on one COMPONENT, not on the struct base:
// the answer is often "yes, and the struct actually starts 8 bytes earlier".
//
// Verdict per address = the same two tests the sweep uses. On the leash (a few units from
// the player, always) and moving while the player is frozen (you swung the mouse).

const CHECK_REL_MIN = -32;
const CHECK_REL_MAX = 48;

function parseAddr(spec, moduleBase) {
  const m = /^(?:DD2\.exe\+)?(?:0x)?([0-9a-f]+)$/i.exec(spec.trim());
  if (!m) throw new Error(`cannot parse address: ${spec}`);
  const v = BigInt('0x' + m[1]);
  // A bare offset like FD2BE20 is module-relative; a full 0x14xxxxxxx is absolute.
  return v < moduleBase ? moduleBase + v : v;
}

function check(handle, moduleBase, specs) {
  if (!specs.length) throw new Error('check needs at least one address');
  const targets = specs.map((s) => ({ spec: s, addr: parseAddr(s, moduleBase), hits: new Map() }));

  console.log('Checking as Vec3 (x, h, y), and at every 4-byte offset around each address.\n');
  console.log('STAND STILL and swing the camera for ~5s, then WALK a long way, then stand and swing again.');
  console.log('Ctrl+C for the verdict.\n');

  let prevPlayer = null;
  const span = CHECK_REL_MAX - CHECK_REL_MIN + 12;

  const tick = () => {
    const p = readPlayer(handle, moduleBase);
    if (!p) return;
    const still = prevPlayer
      && Math.hypot(p.local.x - prevPlayer.local.x, p.local.y - prevPlayer.local.y) < STILL_EPS
      && Math.abs(p.local.h - prevPlayer.local.h) < STILL_EPS;

    for (const t of targets) {
      let buf;
      try {
        buf = readMemory(handle, t.addr + BigInt(CHECK_REL_MIN), span);
      } catch {
        continue;   // unreadable this tick
      }
      for (let rel = CHECK_REL_MIN; rel + 12 <= CHECK_REL_MAX + 12; rel += 4) {
        const i = rel - CHECK_REL_MIN;
        const v = [buf.readFloatLE(i), buf.readFloatLE(i + 4), buf.readFloatLE(i + 8)];
        const frame = frameOf(v[0], v[1], v[2], p);

        let h = t.hits.get(rel);
        if (!frame) {
          // Left the leash (or never was on it). One violation is fatal — the camera
          // NEVER leaves. Mark it dead so a later coincidence can't resurrect it.
          if (h) h.dead = true;
          continue;
        }
        if (!h) t.hits.set(rel, (h = { swung: 0, moved: false, dMin: Infinity, dMax: 0, samples: 0 }));
        if (h.dead) continue;

        const ref = frame === 'local' ? p.local : p.global;
        const d = Math.hypot(v[0] - ref.x, v[2] - ref.y);
        h.frame = frame;
        h.samples++;
        h.last = v;
        h.dh = v[1] - ref.h;
        if (d < h.dMin) h.dMin = d;
        if (d > h.dMax) h.dMax = d;
        if (h.prev) {
          const moved = Math.hypot(v[0] - h.prev[0], v[2] - h.prev[2]) > MOVED_EPS
            || Math.abs(v[1] - h.prev[1]) > MOVED_EPS;
          if (moved) h.moved = true;
          if (moved && still) h.swung++;
        }
        h.prev = v;
      }
    }
    prevPlayer = p;
    process.stdout.write(`\r  sampling... player (${p.local.x.toFixed(1)}, ${p.local.y.toFixed(1)}) h=${p.local.h.toFixed(1)}   `);
  };

  const timer = setInterval(tick, 150);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n\n=== verdict ===\n');
    let any = false;
    for (const t of targets) {
      const live = [...t.hits.entries()]
        .filter(([, h]) => !h.dead && h.samples > 3)
        .sort((a, b) => b[1].swung - a[1].swung || a[1].dMax - b[1].dMax);
      if (!live.length) {
        console.log(`  ${t.spec}   — not a camera. Nothing here stayed on the player's leash.`);
        continue;
      }
      console.log(`  ${t.spec}`);
      for (const [rel, h] of live) {
        const relTag = rel === 0 ? 'as given' : `struct base ${rel > 0 ? '+' : ''}${rel}`;
        const verdict = h.swung > 0
          ? `*** CAMERA: moved while you stood still (x${h.swung}) ***`
          : (h.moved ? 'on the leash and moving — plausible (swing the mouse more)' : 'on the leash but NEVER MOVES — a static, not the camera');
        console.log(`      ${relTag.padEnd(18)} frame=${h.frame}  dist ${h.dMin.toFixed(2)}..${h.dMax.toFixed(2)}u  dh=${h.dh.toFixed(2)}`);
        console.log(`      ${' '.repeat(18)} ${verdict}`);
        if (h.swung > 0) any = true;
      }
      console.log('');
    }
    if (!any) console.log('No camera among these. Run the full sweep:  node tools/cameraHunt.js\n');
    closeHandle(handle);
    process.exit(0);
  });
}

// ------------------------------------------------------------------------- watch mode

function watch(handle, moduleBase, spec) {
  if (!spec) throw new Error('watch needs an address: 0x… or DD2.exe+FA65F70');
  const m = /^DD2\.exe\+([0-9a-f]+)$/i.exec(spec);
  const addr = m ? moduleBase + BigInt('0x' + m[1]) : BigInt(spec);

  console.log(`watching ${hex(addr)} — rotate the camera; heading is the direction the camera LOOKS.\n`);
  const seconds = Number(process.argv[4]);
  if (Number.isFinite(seconds) && seconds > 0) setTimeout(() => process.exit(0), seconds * 1000);
  setInterval(() => {
    try {
      const p = readPlayer(handle, moduleBase);
      if (!p) return;
      const b = readMemory(handle, addr, 12);
      const cx = b.readFloatLE(0);
      const ch = b.readFloatLE(4);
      const cy = b.readFloatLE(8);
      const frame = frameOf(cx, ch, cy, p) || '—';
      const ref = frame === 'global' && p.global ? p.global : p.local;
      const d = Math.hypot(cx - ref.x, cy - ref.y);
      // Camera -> player: the camera looks at the player, so this IS the view direction.
      const heading = (Math.atan2(ref.x - cx, ref.y - cy) * 180) / Math.PI;
      console.log(
        `cam (${cx.toFixed(2)}, ${cy.toFixed(2)}) h=${ch.toFixed(2)}   ` +
        `dist=${d.toFixed(2)}u  dh=${(ch - ref.h).toFixed(2)}  ` +
        `heading=${heading.toFixed(1)}°  frame=${frame}`
      );
    } catch (err) {
      console.log('read failed: ' + err.message);
    }
  }, 200);
}

try {
  main();
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
