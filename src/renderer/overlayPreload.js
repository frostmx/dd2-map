const { contextBridge, ipcRenderer } = require('electron');

// The overlay's bridge. Mirrors preload.js, minus the calibration-authoring
// channels (the overlay only ever reads the calibration) and plus the hotkey
// commands main pushes down.
contextBridge.exposeInMainWorld('dd2overlay', {
  onGamePosition: (callback) => ipcRenderer.on('game-position', (_event, data) => callback(data)),

  // Hotkey commands from main: 'overlay:basemap' (bool), 'overlay:zoom-delta'
  // (number), 'overlay:interactive' (bool — Alt held).
  onCommand: (channel, callback) => ipcRenderer.on(channel, (_event, data) => callback(data)),

  loadCalibration: () => ipcRenderer.invoke('calibration:load'),
  loadOverlayConfig: () => ipcRenderer.invoke('overlay:config:load'),
  saveOverlayConfig: (data) => ipcRenderer.invoke('overlay:config:save', data),

  // Probe results go up to main so they land in the terminal, where you'll
  // actually see them.
  reportProbe: (data) => ipcRenderer.send('overlay:probe', data),
});
