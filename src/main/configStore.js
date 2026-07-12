// Tiny JSON store over config/<name>.json. Everything the app persists
// (calibration, overlay settings) goes through here so there's one place that
// knows where config lives and one definition of "missing file = null".

const path = require('node:path');
const fs = require('node:fs');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

function pathFor(name) {
  return path.join(CONFIG_DIR, `${name}.json`);
}

function load(name) {
  try {
    return JSON.parse(fs.readFileSync(pathFor(name), 'utf-8'));
  } catch {
    return null;
  }
}

function save(name, data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(pathFor(name), JSON.stringify(data, null, 2));
}

module.exports = { load, save, pathFor };
