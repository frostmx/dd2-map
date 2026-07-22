# Memory & reverse engineering

How the player position, the pointer chains and the camera angle were found — and the floating origin that made the naive read wrong.

See also: [managed singletons & the clock](singletons-and-clock.md).

## Memory findings (the hard-won part)

### Player position struct
- Layout: 3 consecutive float32 at **structBase + 0x40 (x), +0x44 (height), +0x48 (y)**.
- Writing instruction: `DD2.exe+~0x54BB683` (`addss xmm3,xmm4` at post-write RIP;
  real `movss [rbx+0x40]` just before). Struct base held in RBX/RCX.
- **These are LOCAL coordinates under a floating origin** (see below).

### Stable pointer chain (survives reallocation + full restart)
Raw addresses reallocate during play AND on restart — both the position struct and
any origin values move. Solved via Cheat Engine pointer scan, narrowed through a
full DD2 restart + 2 reloads (559330 -> 5047 -> 124 -> 18 survivors), all 18
validated live by `tools/testChains.js`.

**Primary chain** (`config/dd2.offsets.json`):
```
"DD2.exe" + 0x0F8E4388  ->  offsets [0x50, 0x20, 0x28, 0x70, 0x20, 0x0]  ->  structBase
   x = structBase + 0x40,  height = +0x44,  y = +0x48
```
Backup chains: base `0x0F8E9420` [48,10,20,20,70,20,0]; bases `0x0F8FD5B8` /
`0x0FE46548` / `0x0FE7D220` all with [1D8,1A0,18,1B8,150,20,0].

**CE offset order (verified):** deref `[moduleBase+staticOffset]`, then apply
offsets[0..n-1] each with a deref, add offsets[n] LAST without deref. (Implemented
in `memoryReader.js:resolvePointerChain`.) DD2.exe module base = `0x140000000`
(not ASLR-randomized across the restarts observed).

**Persistent anchor:** `RSI = 0x1D4B83500` stayed byte-identical across the
original capture, a reload, AND a full restart — a deterministic singleton
(player manager?). Fallback anchor if the chain ever breaks.

### Camera position (solved 2026-07-13) — a real facing angle
The camera is a Vec3 laid out exactly like the player's (`x @+0, h @+4, y @+8`), and it
exists in **both** frames, like the player: `camGlobal - camLocal` came out as exactly
`(640, -1024)` = `(5, -8)` cells = *precisely* the player's own cell offset, with the
camera's offset from the player identical in both frames to 3 decimals. Use the **global**
one (`config/dd2.offsets.json` → `cameraPosition.stableChain`) — it sidesteps the floating
origin and matches the frame the app already reads.

Why it's worth having: **the camera looks at the player**, so the horizontal vector
`camera -> player` *is* the view direction. `heading = atan2(px - cx, py - cy)` is a true
facing angle that works **while standing still** — which the movement-derived
`__dd2_heading__` fundamentally cannot do (stop moving and it has nothing to report).

**Wired in.** Main ships `facing` (a unit vector in GAME coords) on the position feed; both
renderers turn it into a **look-ahead point** — the player pushed 25u along it, through the
*same* transform as the player — and the guest projects both points and takes the pixel
angle (`setHeadingFromAhead`). It feeds the existing `__dd2_heading__`, so the marker arrow
and the heading-up bearing consume it unchanged. If the camera chain misses a tick, the
guest silently falls back to the old movement heading.

**Facing must cross into map space as a POINT, not an angle.** The vector itself is
calibration-independent (it's just player - camera), but *drawing* it isn't: the affine's
`b`/`d` cross-terms carry the rotation between the game's axes and mapgenie's north-up
ones, and a dungeon inset applies its own transform on top. Convert the angle by hand and
the arrow disagrees with the direction the marker actually slides — wrong in the overworld,
wrong differently underground. Project two points that both went through the real transform
and the rotation comes along for free (the translation cancels in the subtraction, so only
the linear part survives, which is exactly the correction wanted). On the current
calibration that rotation happens to be 0.09°, so a hand-converted angle would *look* fine
and quietly break on a recalibration or in an inset.

**How it was found (`tools/cameraHunt.js`) — a relation, not a value.** There is no value
to scan for. But the camera is the one thing in memory **on a leash**: it stays a few units
from the player through walking, sprinting, teleports and cell-boundary snaps. So the
search key is a *relation* — a Vec3 that never leaves the leash — and float soup walks off
it within a few metres of running. Rotation then does the naming: stand still, swing the
mouse, and the camera is the thing that **moves while the player floats are frozen**.

Three traps, each of which cost a run:
- **Rank by ROAM, not by proximity.** The first pass ranked by tightest leash and returned
  548 hits sitting 0.3–0.7u from the player, all "moving while you stood still" — those are
  **skeleton bones**. The idle animation sways them while the root position is frozen, so
  they pass the rotation test exactly like a camera. What separates them: swing the mouse
  and the camera sweeps *metres* of arc at constant radius; a bone jiggles centimetres.
- **Measure the roam RELATIVE TO THE PLAYER.** Boxing the candidate's absolute position
  measures where *you walked*, not what the camera did — local coords wrap ±128 at every
  cell boundary, so it reported a "148u arc" under a 12u leash. That was the map, not the
  camera.
- **In the local frame the leash must be TIGHT.** Local coords are cell-relative and wrap
  inside a 128-unit box, so a generous leash spans much of the reachable range and the soup
  simply sits inside it forever: a 30u leash stalled at 2.3M candidates that could not be
  walked off. (In the *global* frame this problem largely vanishes — coords are large and
  specific, and junk landing within metres of them on both axes essentially doesn't happen.
  Same reason `pointerScan validatecam --global` narrows and the local one barely does.)

**It is NOT module-static.** All 92MB of DD2.exe's writable `.data` was swept; every leashed
Vec3 there was walked off the leash. Unlike `staticLocalPosition`, there is no static mirror
to find — don't go looking for one. Hence the pointer chain, narrowed
8148 → 7529 (teleport) → 5595 (save reload) → **285 (full game restart)**.

### Dead ends / corrections (so we don't repeat them)
- First "position" found (`0x3b8c4c60` struct) was **camera position, not player** —
  it moved when only rotating the camera. Discriminators that separated them:
  (1) camera-rotation-invariance, (2) jump raises/lowers height, (3) large smooth
  X/Z change on walk while height stays flat. (That address was then *discarded* rather
  than recorded, so the camera had to be re-found from scratch later. It is now written
  down properly — see above.)
- Raw session addresses (`0x47a55e10`, `0x3ea477c0`, `0x43b6bc20`, `0x4889d4a0`
  across rounds) all reallocate — never hardcode one; that's why the pointer chain
  exists.

## Floating origin — SOLVED by reading the absolute coordinate (Path B, shipped)
DD2 uses a floating origin: raw ("local") coords re-center at streaming-cell
boundaries (constant 128-unit grid with hysteresis; see the geometry notes
below). But the game **also keeps the true absolute position live in memory**,
and we read it directly, so the origin churn never reaches the marker.

- `global = local + k*128`. The global is a Vec3: **X @ +0, height @ +4, Y @ +8**.
  - **`+4` was written off as junk at first, and that was wrong.** It fails the
    128-grid test the other two axes pass, which read as "not a coordinate" — so
    it was dismissed with "ignored; the map is 2D". It *is* the global height;
    the vertical axis rebases too, just not by a multiple of 128. Measured
    2026-07-17: global `236.29` vs local `8.29`, offset exactly **228.00**.
    `readGlobal` returns it as `h` (`index.js:402-409`) and the position feed
    carries it as `heightGlobal`. Anything mixing frames must offset height the
    same way it offsets x/y — assuming it doesn't is what cost the AR layer a
    full misdiagnosis (see [almanac-and-ar.md](almanac-and-ar.md), "Two
    floating-origin gotchas").
- **Primary chain:** `DD2.exe+0x0FD26358 -> [0x1A8, 0x410]`.
  Fallback (different base/structure): `DD2.exe+0x0F8E1130 -> [0x210, 0x50]`.
  Offset order = CE display order = `resolvePointerChain` order.
- Validated across **teleport + reload + a full game restart** (ASLR), so the
  chains are module-relative and permanently stable. Each tick the app also
  sanity-checks `global - local` is a multiple of 128 before trusting the read,
  and falls back to the second chain otherwise (`src/main/index.js`).
- **Teleport lesson (important):** the first chain we shipped
  (`0BB0E1D0 -> [0x40,0x20,0x190,0x3F8,0x88,0x3E0]`) survived reload/restart but
  read GARBAGE after a fast-travel *until the in-game map was opened* — it threaded
  a **map-owned copy** only refreshed when the map is up. Always add a teleport
  test (fast-travel WITHOUT opening the map) and keep only chains that stay
  consistent; those reach the **gameplay-live copy**. Shorter isn't automatically
  better either, but here the teleport-robust chains happened to be the shortest.

### How it was found (reusable)
1. `tools/globalHunt.js` finds the live global address: filter memory to
   values that move in lockstep with the player between crossings
   (`d(global) == d(local)`), then a boundary crossing separates global (tracks
   the player's TRUE displacement) from local (snaps ~128 with the origin).
   121M candidates -> a handful of global copies.
2. Pointer-scan a *stable* global copy (CE, or `tools/pointerScan.js scan`).
   Low-heap copies are transient (no stable path); pick one that survives a
   reload. Narrow the scan across reloads (`findglobal` to get the new address +
   CE rescan, or `tools/pointerScan.js validate`, which auto-identifies via the
   128-consistency test so it needs no manual re-targeting).
3. `tools/pointerScan.js validate tools/global.chains.json` across a reload + a full restart
   keeps only permanently-stable chains. Shortest survivor wins.

Note: raw heap addresses die on any reload/teleport — never hardcode one; a chain
must be re-validated across a restart before trusting it. Also, the SHORTEST
chains are not always the most stable: here the 4-5 offset chains were transient
and the 6-offset one won.

### Cell geometry (measured, for reference)
Not needed by the app anymore (we read global directly), but documented since it
took real work to establish:
- **Grid step is exactly 128.** The origin only ever moves in 128-unit steps.
  (Raw observed jumps look like ~127.6 — that is `128 − the real movement during
  that tick`; subtracting measured per-tick motion gives ±128.000.)
- The local field re-centers to about **−8** (a constant offset; calibration
  absorbs it).
- **NOT a constant-border grid — there is hysteresis.** The anchor holds until
  the player is 128 from its center, so the valid band is local ∈ **[−136, +120]**
  = 256 wide = twice the step; adjacent anchors overlap by 128. So the flip has no
  fixed world position — it depends which anchor you're on. Standard engine design
  (the overlap stops the origin thrashing when you walk along a boundary).

### Superseded approach: dead reckoning (Path A)
An earlier version accumulated the 128 re-centers live (`world = accum + local`,
detect a jump in band `64 < |Δ| < 400`, subtract the reset portion with an EMA
velocity estimate) — sub-pixel drift, but per-session calibration and no
fast-travel. Fully replaced by the global read above and removed from `index.js`.
`tools/globalHunt.js` / `tools/scanner.js` retain the tooling if ever needed again.

## Reusable RE workflow (for finding cell index or any future value)
1. Value-scan for candidates; discriminate with camera-rotation (unchanged) +
   jump (height up/down) + movement (changed) filters. Tools: `tools/scanner.js`
   (snapshot/filter-changed/filter-unchanged/filter-direction/proximity/context).
2. Confirm struct + get base: `tools/ce_find_pointer.lua` in CE ("find what writes" ->
   captures base register + offset to `ce_out.txt`).
3. Pointer-scan the base in CE GUI; narrow across a full restart + reloads (re-run
   the Lua after each to get the new base fast); validate survivors with
   `tools/testChains.js`.
4. Wire into `index.js` via `resolvePointerChain`.

