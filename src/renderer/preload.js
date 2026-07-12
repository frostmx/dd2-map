const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dd2', {
  onGamePosition: (callback) => ipcRenderer.on('game-position', (_event, data) => callback(data)),
  loadCalibration: () => ipcRenderer.invoke('calibration:load'),
  saveCalibration: (data) => ipcRenderer.invoke('calibration:save', data),
  onCalibrationClickResult: (callback) => ipcRenderer.on('calibration-click-result', (_event, data) => callback(data)),
  loadView: () => ipcRenderer.invoke('view:load'),
  saveView: (data) => ipcRenderer.invoke('view:save', data),

  // Overlay controls that live in this window (the overlay itself has no UI).
  loadOverlayConfig: () => ipcRenderer.invoke('overlay:config:load'),
  setOverlayNumber: (key, value) => ipcRenderer.send('overlay:number', { key, value }),
  setOverlaySetting: (key, value) => ipcRenderer.send('overlay:setting', { key, value }),
});
