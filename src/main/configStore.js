// Tiny JSON store over config/<name>.json. Everything the app persists
// (calibration, saved view, overlay settings) goes through here so there's one
// place that knows where config lives.
//
// Packaged vs dev is the whole reason this is careful:
//   dev       -> the repo's config/ directory, so hand-editing config/overlay.json
//                works the way you'd expect while developing.
//   packaged  -> %APPDATA%/<app>/config. The bundled config/ ends up INSIDE
//                app.asar, which is READ-ONLY — writing there fails silently, so
//                calibration and every setting would appear to save and then be
//                gone on restart.
//
// On first packaged run there's nothing in userData yet, so load() falls back to
// the copy shipped inside the asar (that's how the hard-won calibration.json
// ships with the binary). The first save() then writes to userData for real.

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const BUNDLED_DIR = path.join(__dirname, '..', '..', 'config');
const WRITABLE_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'config')
  : BUNDLED_DIR;

function pathFor(name) {
  return path.join(WRITABLE_DIR, `${name}.json`);
}

function load(name) {
  try {
    return JSON.parse(fs.readFileSync(pathFor(name), 'utf-8'));
  } catch {
    // Not written yet. In a packaged build, seed from the read-only copy inside
    // the asar so a fresh install starts with the shipped calibration/defaults.
    if (app.isPackaged) {
      try {
        return JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, `${name}.json`), 'utf-8'));
      } catch { /* not shipped either — caller gets null and uses its defaults */ }
    }
    return null;
  }
}

function save(name, data) {
  fs.mkdirSync(WRITABLE_DIR, { recursive: true });
  fs.writeFileSync(pathFor(name), JSON.stringify(data, null, 2));
}

module.exports = { load, save, pathFor, WRITABLE_DIR };
