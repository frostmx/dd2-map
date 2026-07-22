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
  edgeArtAvailable: () => ipcRenderer.invoke('overlay:edge-available'),

  // Offline cache: a local snapshot of mapgenie's tiles + page bundle, so the map still
  // works with mapgenie unreachable. Exactly one backup slot; see cacheStore.js.
  loadCacheStatus: () => ipcRenderer.invoke('cache:status'),
  buildCache: () => ipcRenderer.invoke('cache:build'),
  cancelCacheBuild: () => ipcRenderer.send('cache:cancel'),
  revertCache: () => ipcRenderer.invoke('cache:revert'),
  onCacheProgress: (callback) => ipcRenderer.on('cache:progress', (_event, data) => callback(data)),
  // Map source: 'auto' (probe on startup, fall back to cache if mapgenie is down),
  // 'online' (never use the cache), 'offline' (always use it).
  setMapSource: (source) => ipcRenderer.send('cache:source', source),
  probeMapgenie: () => ipcRenderer.invoke('cache:probe'),
  onCacheState: (callback) => ipcRenderer.on('cache:state', (_event, data) => callback(data)),
  // Revert restores calibration.json, and this window caches the affine in a module-level
  // variable loaded once at startup — without this push the marker would keep using the
  // pre-revert transform until restart.
  onCalibrationChanged: (callback) => ipcRenderer.on('calibration:changed', (_event, data) => callback(data)),

  // Dungeon areas: mapgenie's portal graph, and the (read-only) per-dungeon inset transforms.
  // Dungeon transforms are authored in config/dungeons.json — there is no in-app calibration.
  saveAreaMetadata: (meta) => ipcRenderer.invoke('areas:metadata', meta),
  loadAreas: () => ipcRenderer.invoke('areas:load'),
  onAreasState: (callback) => ipcRenderer.on('areas:state', (_event, data) => callback(data)),
});
