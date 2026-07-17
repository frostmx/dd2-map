# Prompt: make the AR collectible markers smooth

Hand this to a fresh agent/session. DD2 must be running (Borderless Windowed) to verify.

---

Make the AR collectible markers in the DD2 map overlay SMOOTH. They're currently
дёрганные (jerky/juddery) during movement and camera rotation; the goal is buttery-smooth
motion glued to the world, with no swim, stutter, or micro-jitter.

START by reading CLAUDE.md and the AR-relevant parts of FINDINGS.md (the "Camera frame +
AR token layer" section, especially "Feed rate: matched to the renderer's clock, then
decoupled from it entirely"). Do NOT re-invent the render-time interpolation that already
exists — build on it.

CURRENT ARCHITECTURE (know it before touching anything):
- src/main/index.js: a 30 Hz position poll broadcasts `game-position` (player x/height/y);
  a SEPARATE ~60 Hz `camTimer` (setInterval, 16 ms) reads the camera each tick and
  broadcasts `camera-frame` (pos, right/up/fwd basis, fov, aspect).
- src/renderer/overlay.js: `arLoop` is a requestAnimationFrame loop. It interpolates the
  CAMERA between the two most recent `camera-frame` samples (`arSampleCamera`), delayed by
  `ar.interpMs`, lerping+renormalizing the basis vectors. Frames are timestamped with
  performance.now() on ARRIVAL in the `camera-frame` onCommand handler. `arPlayer` is set
  directly from `game-position` (30 Hz) and is NOT interpolated. The projection uses the
  interpolated camera + static POI positions; `arPlayer` feeds viewSign, distance culling,
  the distance-faded marker "float", and marker size/alpha.
- Config knobs live in src/main/overlayConfig.js `ar` block (interpMs, etc.); the on-disk
  values are in config/overlay.json — CHECK the actual on-disk `ar.interpMs`, it has been
  as low as 8 ms before, which is too small (see below).

INVESTIGATE FIRST, then fix the DOMINANT cause. Don't guess or stack speculative smoothing.
Instrument it: log the actual inter-arrival intervals of camera-frame, the rAF frame
intervals, the monitor refresh rate, and how often `arSampleCamera`'s interpolation factor
`a` clamps to 0 or 1 (clamping = you ran out of straddling frames = judder). Likely
culprits, in rough priority:
  1. interpMs too small vs the feed interval. To ALWAYS have two frames straddling the
     render time you need interpMs >= ~1.5x the feed interval (>= ~25 ms for a 60 Hz feed).
     Too small -> `a` pins to 1 and the scene freezes on the latest frame until the next
     arrives, then jumps -> judder. Verify and tune.
  2. The PLAYER position is not interpolated (only the camera is). arPlayer steps at 30 Hz,
     so anything derived from it — the distance-faded float (marker vertical lift near a
     collectible), distance culling, size/alpha — steps too. Apply the same two-sample
     timestamped interpolation to arPlayer as the camera uses, ideally at the SAME render
     time so camera and player stay consistent.
  3. Timestamp jitter. Frames are stamped on IPC arrival, which adds delivery-latency noise
     to the sample spacing that interpolation assumes is clean. Consider stamping each
     frame at CAPTURE time in main and carrying that timestamp through (mind the two clock
     domains — map main's clock to the renderer's, or send a monotonic delta), OR raise the
     feed rate / steady its cadence. Node setInterval is not precise; uneven samples hurt.
  4. Confirm the overlay's rAF is NOT being Chromium-throttled. The overlay window is never
     focused; per CLAUDE.md/FINDINGS.md it needs backgroundThrottling:false on the window,
     the webview, AND the command-line switches. The AR canvas is in the overlay renderer —
     make sure IT actually runs at full refresh (a throttled rAF looks exactly like bad
     judder). Measure the real rAF rate.
  5. Basis interpolation is nlerp (lerp + renormalize) — a chord approximation of rotation.
     Fine for small per-frame angles; only pursue slerp if measurement shows fast flicks are
     the residual problem AFTER 1-4 are fixed.

CONSTRAINTS:
- Keep the existing feel/tuning approach: numbers that decide feel go in overlayConfig.js
  `ar` defaults, and note that overlayConfig.save() deliberately never authors the `ar`
  block (don't reintroduce that trap). Prefer a new knob over a hardcoded constant.
- Latency vs smoothness is a real trade — a few ms of added latency for perfect smoothness
  is the right call for a finder overlay, but keep it minimal and configurable.
- No architectural rewrite unless justified by measurement. The 30 Hz position / 60 Hz
  camera / rAF-render split is intentional (decoupled feeds); improve the interpolation and
  the feeds, don't collapse them blindly.

VERIFY behaviorally — there is no test suite. DD2 must be RUNNING in Borderless Windowed.
Run `npm start`, open the overlay (F9 mode), and judge smoothness live while walking and
swinging the camera. Report the measured numbers (feed intervals, rAF rate, clamp rate)
before and after, so the improvement is demonstrated, not asserted. `node --check` is the
only static check. When it's smooth and measured, update FINDINGS.md's AR interpolation
notes and commit.
