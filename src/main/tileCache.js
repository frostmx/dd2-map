// Bulk-downloads mapgenie's world tiles into the offline cache.
//
// 87,903 tiles, ~950MB, roughly an hour. That length is why almost every design
// decision here is about surviving interruption rather than going fast.
//
// THE TILE URL IS {z}/{y}/{x}, NOT {z}/{x}/{y}. y comes first. Every aligner in .map/
// gets this right and it is the first thing to re-check if the cache comes back looking
// transposed (see .map/README.md:49).
//
// z17 IS A LIE. Both raster sources declare maxzoom 17 and every z17 tile 403s; z16 is
// the deepest that exists. mapAgent.buildClampZoom already clamps the live source so
// MapLibre overzooms z16 instead of going blank. So z16 is the floor of the loop here —
// caching z17 would download 260,000 error pages. See findings/mapgenie-map.md.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { session } = require('electron');
const cacheStore = require('./cacheStore');

const TILE_TEMPLATE = 'https://tiles.mapgenie.io/games/dragons-dogma-2/world/world-v1/{z}/{y}/{x}.jpg';
const BBOX = [-1.4, 0.0, 0.0, 1.4];   // [west, south, east, north] — mapgenie's own source bounds
const MIN_ZOOM = 7;
const MAX_ZOOM = 16;

// matchInset.py:81-82 found both of these necessary against this CDN.
const REQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://mapgenie.io/',
};

// --- enumeration ----------------------------------------------------------------
// DERIVED BY DOUBLING FROM z8, NOT by projecting the bbox at each zoom. That is not a
// shortcut — projecting gives the wrong answer, verified against the live server:
//
//   - The naive `floor(fx(west) * 2^z)` undershoots at z16. It yields x0=32513, but
//     x=32512 returns 200. mapgenie generates ALL FOUR children of any non-empty
//     parent tile, so the tileset spills one tile past the declared bbox wherever an
//     edge falls mid-tile (z15's x0=16256 sits at .46 of a tile, so both its children
//     exist). Projection can't know that; doubling can.
//   - The naive INCLUSIVE upper bound `floor(fx(east) * 2^z)` overshoots. east lng=0
//     and south lat=0 land on exact integers (fx=fy=0.5), so floor lands on the first
//     tile of the next column — entirely outside the data. That added a guaranteed-403
//     row AND column: 1,032 doomed requests, 511 of them at z16.
//
// Both edges verified by probing the live server: at z16, x=32512 → 200, x=32768 → 403;
// at z15, x=16255 → 403, x=16256 → 200. The bbox is retained in the manifest for
// provenance, but nothing computes from it.
//
// The base is z8 = a single tile (127,127). Every zoom is then an exact power-of-two
// grid, which is the sanity check: if a grid isn't square and a power of two, the
// enumeration is wrong.
//
// z7 is the one zoom with NO tiles at all — its single tile (63,63) 403s. It's still
// enumerated (one request, negative-cached) because the style declares minzoom 7 and
// MapLibre may ask for it.

const BASE_Z = 8;
const BASE_LO = 127;
const BASE_HI = 128;   // exclusive

function rangeFor(z) {
  const shift = z - BASE_Z;
  const lo = shift >= 0 ? BASE_LO << shift : BASE_LO >> -shift;
  const hi = (shift >= 0 ? BASE_HI << shift : BASE_HI >> -shift) - 1;
  // The region is square in Mercator pixel space, so x and y share the same range.
  return { x0: lo, x1: hi, y0: lo, y1: hi };
}

function countFor(z) {
  const r = rangeFor(z);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

function totalTiles(maxZoom = MAX_ZOOM) {
  let n = 0;
  for (let z = MIN_ZOOM; z <= maxZoom; z++) n += countFor(z);
  return n;
}

// --- the build ------------------------------------------------------------------

const CONCURRENCY_DEFAULT = 6;
const DELAY_MS_DEFAULT = 15;
const CHECKPOINT_TILES = 500;
const CHECKPOINT_MS = 2000;
const PROGRESS_HZ = 4;              // per-tile IPC at 6-way concurrency would be
                                    // thousands of msgs/sec and would cost frame time
                                    // on the 30Hz position feed.
// Rate-limit poisoning guard. If mapgenie starts refusing us, a naive build writes
// tens of thousands of zero-byte "this tile doesn't exist" markers and produces a cache
// that is permanently, silently empty. Distinguishing "absent" from "blocked" matters.
//
// THE SIGNAL IS AMBIGUOUS AND THE OBVIOUS READING IS WRONG. mapgenie's tiles sit in an
// S3 bucket without ListBucket permission, so a MISSING tile returns **403 with an
// AccessDenied XML body, not 404**. 404 essentially never occurs. So 403 cannot be
// treated as "we got blocked" — doing that trips the guard on the first legitimately
// empty tile and pauses the build forever.
//
// What makes a clean split possible is that with the enumeration above, legitimate 403s
// are ~0%: probing a z16 row gave 8/8 200s, and the only known all-403 zoom is z7 (one
// tile). A real block, by contrast, is ~100%. So:
//   - 429 / 5xx  -> unambiguous throttle signal, tight threshold.
//   - 403        -> normally "absent"; only a MAJORITY of them means blocked.
const GUARD_WINDOW = 200;
const GUARD_THROTTLE_RATIO = 0.02;   // 429/5xx — anything above noise is real
const GUARD_FORBID_RATIO = 0.5;      // 403 — must be a landslide, not a few empty tiles

let active = null;   // the in-flight build, or null

function tilePath(dir, z, y, x) {
  return path.join(dir, 'tiles', String(z), String(y), `${x}.jpg`);
}

function start(opts) {
  if (active) return active.promise;

  const dir = opts.dir || cacheStore.BUILDING;
  const onProgress = opts.onProgress || (() => {});
  const concurrency = opts.concurrency || CONCURRENCY_DEFAULT;
  const delayMs = opts.delayMs == null ? DELAY_MS_DEFAULT : opts.delayMs;
  // Capped for the smoke test, which exercises the whole pipeline over the ~342 tiles
  // of z7-z12 rather than the full hour.
  const maxZoom = Math.min(opts.maxZoom || MAX_ZOOM, MAX_ZOOM);
  const ses = session.defaultSession;

  fs.mkdirSync(dir, { recursive: true });

  // Resume from an interrupted build rather than restarting an hour of downloading.
  // Row-major order is what makes the resume state a single {z,y} cursor: we re-do at
  // most one row (256 tiles at z16) instead of stat()ing 87,000 files at startup.
  let manifest = cacheStore.readManifest(dir);
  // Whether we're starting from scratch decides how already-on-disk tiles are counted.
  // A RESUMED manifest already counted everything a previous run fetched, so counting a
  // stat-hit again double-counts (have went 341 -> 682 across two passes). A FRESH
  // manifest over existing files — manifest deleted, or a build interrupted before its
  // first checkpoint — must count them, or the totals read as zero with a full disk.
  const freshManifest = !manifest || manifest.version !== cacheStore.MANIFEST_VERSION;
  if (freshManifest) {
    manifest = cacheStore.emptyManifest({
      tileTemplate: TILE_TEMPLATE, bbox: BBOX, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    });
    manifest.tiles.expected = totalTiles(maxZoom);
    for (let z = MIN_ZOOM; z <= maxZoom; z++) {
      manifest.tiles.perZoom[z] = { expected: countFor(z), have: 0 };
    }
  }
  const t = manifest.tiles;

  let cancelled = false;
  let paused = false;
  let pauseReason = null;
  const recent = [];               // rolling window for the rate-limit guard
  let lastCheckpoint = Date.now();
  let sinceCheckpoint = 0;
  let lastProgress = 0;
  const startedAt = Date.now();
  const startHave = t.have + t.negative;

  // kind: 'ok' | 'forbidden' (403, normally just an absent tile) | 'throttle' (429/5xx)
  function note(kind) {
    recent.push(kind);
    if (recent.length > GUARD_WINDOW) recent.shift();
    if (recent.length < GUARD_WINDOW) return;
    const throttle = recent.filter((k) => k === 'throttle').length / GUARD_WINDOW;
    const forbid = recent.filter((k) => k === 'forbidden').length / GUARD_WINDOW;
    if (throttle > GUARD_THROTTLE_RATIO) {
      paused = true;
      pauseReason = `mapgenie is throttling us (${Math.round(throttle * 100)}% of the last ${GUARD_WINDOW} were 429/5xx)`;
    } else if (forbid > GUARD_FORBID_RATIO) {
      paused = true;
      pauseReason = `mapgenie is refusing us (${Math.round(forbid * 100)}% of the last ${GUARD_WINDOW} were 403 — expected near 0%)`;
    }
  }

  function checkpoint(force) {
    sinceCheckpoint++;
    const due = force || sinceCheckpoint >= CHECKPOINT_TILES || (Date.now() - lastCheckpoint) >= CHECKPOINT_MS;
    if (!due) return;
    sinceCheckpoint = 0;
    lastCheckpoint = Date.now();
    cacheStore.writeManifest(dir, manifest);
  }

  function emitProgress(force) {
    const now = Date.now();
    if (!force && now - lastProgress < 1000 / PROGRESS_HZ) return;
    lastProgress = now;
    const done = t.have + t.negative;
    const elapsed = (now - startedAt) / 1000;
    const rate = elapsed > 0 ? (done - startHave) / elapsed : 0;
    onProgress({
      phase: 'tiles',
      done, total: t.expected, negative: t.negative, failed: t.failed,
      bytes: t.bytes,
      ratePerSec: Math.round(rate * 10) / 10,
      etaSec: rate > 0 ? Math.round((t.expected - done) / rate) : null,
      paused, pauseReason,
    });
  }

  async function fetchTile(z, y, x) {
    const url = TILE_TEMPLATE.replace('{z}', z).replace('{y}', y).replace('{x}', x);
    let delay = 500;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await ses.fetch(url, { headers: REQ_HEADERS });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const p = tilePath(dir, z, y, x);
          await fsp.mkdir(path.dirname(p), { recursive: true });
          await fsp.writeFile(p, buf);
          note('ok');
          return { kind: 'ok', bytes: buf.length };
        }
        // 403 (S3 AccessDenied) is mapgenie's "no such tile" — see the guard notes
        // above. 404 is handled identically for the day they fix their bucket policy.
        if (res.status === 403 || res.status === 404) {
          note(res.status === 403 ? 'forbidden' : 'ok');
          const p = tilePath(dir, z, y, x);
          await fsp.mkdir(path.dirname(p), { recursive: true });
          await fsp.writeFile(p, Buffer.alloc(0));   // zero-byte negative, per matchInset.py:88
          return { kind: 'negative' };
        }
        if (res.status === 429 || res.status >= 500) {
          note('throttle');
          const retryAfter = Number(res.headers.get('retry-after'));
          await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) ? retryAfter * 1000 : delay));
          delay *= 4;
          continue;
        }
        note('ok');
        return { kind: 'failed', status: res.status };
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 4;
      }
    }
    return { kind: 'failed' };
  }

  // One worker pulls from a shared row-major cursor. Workers share `queue` state so a
  // slow tile can't stall the others.
  async function run() {
    // Fast path for a build whose tiles finished but whose asset capture failed: the
    // next Create re-enters here with a null cursor (= "done"), and without this we'd
    // re-walk and stat() all ~87k files just to skip every one. Jump straight to done so
    // capture retries near-instantly.
    if (!t.cursor && !freshManifest && (t.have + t.negative) >= t.expected && t.expected > 0) {
      emitProgress(true);
      return { cancelled: false, paused: false, pauseReason: null, manifest };
    }

    let z = MIN_ZOOM;
    let y = null;
    let x = null;
    if (t.cursor) { z = t.cursor.z; y = t.cursor.y; }

    let r = rangeFor(z);
    if (y == null) y = r.y0;
    x = r.x0;

    function next() {
      // Advance the shared cursor; returns null when the whole range is done.
      if (z > maxZoom) return null;
      const job = { z, y, x };
      x++;
      if (x > r.x1) {
        x = r.x0;
        y++;
        t.cursor = { z, y };
        if (y > r.y1) {
          z++;
          if (z > maxZoom) { t.cursor = null; return job; }
          r = rangeFor(z);
          y = r.y0;
          x = r.x0;
          t.cursor = { z, y };
        }
      }
      return job;
    }

    async function worker() {
      for (;;) {
        if (cancelled || paused) return;
        const job = next();
        if (!job) return;

        // Resume: a tile already on disk (including a zero-byte negative) is done.
        // Only counted when the manifest is fresh — see freshManifest above.
        let already = false;
        try {
          const st = await fsp.stat(tilePath(dir, job.z, job.y, job.x));
          already = true;
          if (freshManifest) {
            if (st.size === 0) t.negative++; else { t.have++; t.bytes += st.size; }
          }
        } catch { /* not fetched yet */ }

        if (!already) {
          const out = await fetchTile(job.z, job.y, job.x);
          if (out.kind === 'ok') {
            t.have++;
            t.bytes += out.bytes;
            const pz = t.perZoom[job.z];
            if (pz) pz.have++;
          } else if (out.kind === 'negative') {
            t.negative++;
          } else {
            t.failed++;
          }
          if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
        }

        checkpoint(false);
        emitProgress(false);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));

    manifest.state = cancelled ? 'building' : cacheStore.computeState(manifest);
    if (!cancelled && !paused) manifest.completedAt = new Date().toISOString();
    checkpoint(true);
    emitProgress(true);

    return { cancelled, paused, pauseReason, manifest };
  }

  const promise = run().finally(() => { active = null; });
  active = {
    promise,
    cancel() { cancelled = true; },
    get paused() { return paused; },
  };
  return promise;
}

function cancel() {
  if (active) active.cancel();
}

function isBuilding() { return active !== null; }

module.exports = {
  TILE_TEMPLATE, BBOX, MIN_ZOOM, MAX_ZOOM,
  rangeFor, countFor, totalTiles,
  start, cancel, isBuilding,
};
