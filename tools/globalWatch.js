// Live global-position watcher. Combines the local player position struct with
// the discovered cell-origin struct to produce a continuous world coordinate:
//   global = local + origin   (per horizontal axis)
//
// Local  struct @ 0x47a55e10 : [x, height, y] float32
// Origin struct @ 0x45718A10 : [ox, oh, oy]   float32 (assumed same layout)
const { findProcessIdByName, openProcess, readMemory, closeHandle } = require('../src/main/memoryReader');

const LOCAL = 0x47a55e10n;
const ORIGIN = 0x45718a10n;

const pid = findProcessIdByName('DD2.exe');
if (!pid) { console.error('DD2.exe not running'); process.exit(1); }
const handle = openProcess(pid);

const timer = setInterval(() => {
  try {
    const L = readMemory(handle, LOCAL, 12);
    const O = readMemory(handle, ORIGIN, 12);
    const lx = L.readFloatLE(0), lh = L.readFloatLE(4), ly = L.readFloatLE(8);
    const ox = O.readFloatLE(0), oh = O.readFloatLE(4), oy = O.readFloatLE(8);
    const gx = lx + ox, gy = ly + oy;
    console.log(
      `${new Date().toISOString()}  ` +
      `GLOBAL x=${gx.toFixed(3)} y=${gy.toFixed(3)}  |  ` +
      `local(${lx.toFixed(2)}, ${ly.toFixed(2)})  origin(${ox.toFixed(2)}, ${oy.toFixed(2)})`
    );
  } catch (err) {
    console.log('read error:', err.message);
  }
}, 250);

process.on('SIGINT', () => { clearInterval(timer); closeHandle(handle); process.exit(0); });
