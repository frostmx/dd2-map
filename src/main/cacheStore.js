// Where the offline map cache lives on disk, and the only code allowed to move it.
//
// The cache is a ~950MB snapshot of everything the mapgenie embed needs — tiles, the
// page bundle, style, sprites, glyphs, POI payloads — so the map still works with
// mapgenie unreachable. See findings/offline-cache.md.
//
// TWO THINGS ABOUT THE LOCATION, both learned the hard way elsewhere in this project:
//
//   1. It MUST live under userData, never the repo. The dev hot-reloader watches the
//      whole tree (index.js:36-49) and its ignore list covers only config/, tools/ and
//      .txt|csv|bin|log — a .jpg written into the repo IS watched. An 87,000-file build
//      would reload the app 87,000 times. (.map/tilecache/ is gitignored but NOT
//      reloader-ignored; the Python tooling gets away with it only because the app
//      isn't running when you use it.)
//   2. Tiles go in a {z}/{y}/{x} tree, not the flat {z}/{tx}_{ty} of matchInset.py.
//      z16 alone is 65,536 tiles; flat means 65,536 entries in one directory, which
//      NTFS survives but Defender and enumeration do not enjoy. The tree also mirrors
//      mapgenie's URL path 1:1, so there's no mental translation when debugging.
//
// Everything destructive lives here rather than in tileCache.js, so the risky part is
// small and reviewable. The swap is renames only — never a copy. A 950MB copy is
// minutes of I/O and a correspondingly larger window to crash inside.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { app } = require('electron');

const ROOT = path.join(app.getPath('userData'), 'mapcache');

const CURRENT = path.join(ROOT, 'current');
const BACKUP = path.join(ROOT, 'backup');
const BUILDING = path.join(ROOT, 'building');
const BACKUP_OLD = path.join(ROOT, 'backup.old');   // transient, mid-swap only
const SWAP_TMP = path.join(ROOT, 'swap.tmp');       // transient, mid-revert only

// The live found-set mirror sits OUTSIDE current/ on purpose: it has to keep working
// when no cache exists at all, and a build must not race with it. It's *copied* into
// current/snapshot/ at promote time.
const FOUND_FILE = path.join(ROOT, 'found.json');

const MANIFEST_VERSION = 1;

function manifestPath(dir) { return path.join(dir, 'manifest.json'); }

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf-8'));
  } catch {
    return null;
  }
}

// Temp-then-rename, so a crash mid-write can't leave a truncated manifest that would
// make an otherwise-good cache unreadable. The build checkpoints this every 500 tiles.
function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = manifestPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath(dir));
}

function emptyManifest(source) {
  return {
    version: MANIFEST_VERSION,
    state: 'building',
    createdAt: new Date().toISOString(),
    completedAt: null,
    app: { version: app.getVersion(), electron: process.versions.electron },
    source,
    tiles: {
      expected: 0, have: 0, negative: 0, failed: 0, bytes: 0,
      cursor: null,           // {z, y} — resume point; row-major means this is enough
      perZoom: {},
    },
    http: { count: 0, bytes: 0, hosts: {} },
    assets: { styleJson: false, sprite: false, spriteRetina: false, glyphStacks: {}, apiPayloads: [] },
    snapshot: { calibration: false, areas: false, found: false },
    missing: [],
    verify: { ranAt: null, misses: null, missUrls: [] },
  };
}

// `state` is COMPUTED, never asserted by a caller — a cache that claims to be complete
// while missing its sprite sheet is exactly the silent half-working failure this whole
// feature has to avoid.
function computeState(m) {
  if (!m) return 'absent';
  const t = m.tiles;
  const tilesDone = t.expected > 0 && (t.have + t.negative) >= t.expected;
  const assetsDone = m.assets.styleJson && m.assets.sprite
    && Object.keys(m.assets.glyphStacks).length > 0;
  // 'complete' requires verify to have (a) actually brought the offline page up and
  // (b) recorded no misses. The `loaded === true` check is what rejects the false-complete
  // caches whose bootstrap died early (0 misses only because nothing got requested). Older
  // manifests without the flag are treated as NOT verified-loaded, so they read as partial
  // until rebuilt — which is correct, since those are exactly the suspect ones.
  const verifyOk = m.verify.misses === 0 && m.verify.loaded === true;
  if (tilesDone && assetsDone && verifyOk) return 'complete';
  if (tilesDone || t.have > 0) return 'partial';
  return 'building';
}

function exists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

async function rmrf(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// A directory rename within one volume is a MoveFile — atomic enough for our purposes.
// It fails with EBUSY/EPERM if ANY file inside is open: our own protocol handler
// mid-read, Defender scanning, an Explorer window sitting in the folder. Callers must
// quiesce the handler first; this retries for the rest.
async function renameWithRetry(from, to, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// Seed a fresh build from the current cache's tiles, so a rebuild that only needs to
// re-capture the page bundle (e.g. to pick up the logged-in variant, or a mapgenie JS
// update) doesn't re-download ~940MB. Tiles are HARDLINKED, not copied — near-instant and
// no extra disk; current and the new build share the same tile inodes (they're identical
// bytes anyway). The manifest is copied too, so tileCache sees a complete tile set and
// fast-path-skips the download entirely.
function hardlinkTree(srcDir, dstDir) {
  let n = 0;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) { n += hardlinkTree(s, d); continue; }
    try { fs.linkSync(s, d); n++; }
    catch { try { fs.copyFileSync(s, d); n++; } catch { /* skip */ } }
  }
  return n;
}

function seedBuildFromCurrent() {
  const srcTiles = path.join(CURRENT, 'tiles');
  if (!fs.existsSync(srcTiles)) return 0;
  const n = hardlinkTree(srcTiles, path.join(BUILDING, 'tiles'));
  // Carry the manifest so tileCache reads a complete, non-fresh state and skips fetching.
  const m = readManifest(CURRENT);
  if (m) { m.missing = []; writeManifest(BUILDING, m); }
  return n;
}

// Promote a finished build to current, demoting the old current to the single backup
// slot. Five steps, and at EVERY instant between them a complete cache exists on disk
// under some name — steps 1 and 5 are the only destructive ones and both are idempotent.
async function promoteBuild() {
  if (!exists(BUILDING)) throw new Error('no build to promote');
  await rmrf(BACKUP_OLD);                                       // 1: prior crash debris
  if (exists(BACKUP)) await renameWithRetry(BACKUP, BACKUP_OLD); // 2
  if (exists(CURRENT)) await renameWithRetry(CURRENT, BACKUP);   // 3
  await renameWithRetry(BUILDING, CURRENT);                      // 4
  await rmrf(BACKUP_OLD);                                        // 5: best effort
}

// Swap current <-> backup. Deliberately its OWN INVERSE: reverting twice puts you back
// exactly where you started, and the rebuilt cache is only ever demoted, never
// destroyed. That property is the whole point — you revert precisely when you're not
// sure the rebuild was good, so revert itself must not be a one-way door.
async function revert() {
  if (!exists(BACKUP)) throw new Error('no backup to revert to');
  await rmrf(SWAP_TMP);
  if (exists(CURRENT)) await renameWithRetry(CURRENT, SWAP_TMP);
  await renameWithRetry(BACKUP, CURRENT);
  if (exists(SWAP_TMP)) await renameWithRetry(SWAP_TMP, BACKUP);
}

// Runs before the windows are created. Clears debris from a crash mid-swap and rescues
// the case where current/ was renamed away but its replacement never landed.
async function reconcile() {
  await fsp.mkdir(ROOT, { recursive: true }).catch(() => {});

  // Crashed between steps 1 and 3 of a revert: current/ is gone, the real cache is
  // sitting in swap.tmp. Put it back before anything tries to read current/.
  if (!exists(CURRENT) && exists(SWAP_TMP)) {
    await renameWithRetry(SWAP_TMP, CURRENT).catch(() => {});
  }
  // Crashed mid-promote with current/ already demoted and building/ not yet moved.
  if (!exists(CURRENT) && exists(BACKUP)) {
    await renameWithRetry(BACKUP, CURRENT).catch(() => {});
  }
  await rmrf(BACKUP_OLD);
  await rmrf(SWAP_TMP);
}

function status() {
  const cur = readManifest(CURRENT);
  const bak = readManifest(BACKUP);
  const bld = readManifest(BUILDING);
  return {
    root: ROOT,
    current: cur ? { ...cur, state: computeState(cur) } : null,
    backup: bak ? { ...bak, state: computeState(bak) } : null,
    building: bld ? { ...bld, state: 'building' } : null,
    hasCurrent: exists(CURRENT),
    hasBackup: exists(BACKUP),
    hasBuilding: exists(BUILDING),
  };
}

// --- the found-set mirror -------------------------------------------------------
// Written debounced by index.js on every __DD2_FOUNDSET__ bridge. Online this is
// overwritten by the server's authoritative set on every page load; the reason it
// exists at all is marks made OFFLINE, which by design never reach the server and so
// live nowhere else.

function loadFound() {
  try {
    const d = JSON.parse(fs.readFileSync(FOUND_FILE, 'utf-8'));
    return Array.isArray(d.ids) ? d.ids : [];
  } catch {
    return [];
  }
}

function saveFound(ids, source) {
  fs.mkdirSync(ROOT, { recursive: true });
  const tmp = FOUND_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    source,                                   // 'online' | 'offline'
    ids: ids.map(Number).filter(Number.isFinite),
  }, null, 2));
  fs.renameSync(tmp, FOUND_FILE);
}

module.exports = {
  ROOT, CURRENT, BACKUP, BUILDING, FOUND_FILE,
  MANIFEST_VERSION,
  readManifest, writeManifest, emptyManifest, computeState,
  exists, promoteBuild, revert, reconcile, status, seedBuildFromCurrent,
  loadFound, saveFound,
};
