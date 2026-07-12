// One-off probe: detect which JS map library the mapgenie embed page uses,
// and whether the host process can call into it via executeJavaScript.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`
        (function () {
          function describe(obj) {
            if (!obj || typeof obj !== 'object') return obj;
            const out = {};
            for (const k of Object.keys(obj)) {
              out[k] = typeof obj[k];
            }
            return out;
          }
          const mm = window.mapManager;
          const info = {
            liveLocationControl: mm ? describe(mm.liveLocationControl) : null,
            playerMarker: mm ? describe(mm.playerMarker) : null,
            playerFollowingEnabled: mm ? mm.playerFollowingEnabled : null,
            storeKeys: mm && mm.store ? Object.keys(mm.store) : null,
            storeStateKeys: mm && mm.store && mm.store.getState ? Object.keys(mm.store.getState()) : null,
          };
          return JSON.stringify(info, null, 1);
        })();
      `);
      console.log('PROBE RESULT:', result);
    } catch (err) {
      console.error('PROBE ERROR:', err);
    } finally {
      app.quit();
    }
  });
  win.loadURL('https://mapgenie.io/dragons-dogma-2/maps/world?embed=light');
});
