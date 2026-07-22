# Architecture & packaging

Where the code lives, what each file owns, and how the portable .exe is built.

See also: [the overlay](overlay.md), [memory & RE](memory-re.md).

## Architecture (monolith Electron app)

```
dd2-map/
  src/main/           # the app's main process — nothing else lives here
    index.js          # poll loop (30Hz memory read -> IPC), hotkeys, Alt/foreground
                      #   poll, found-mark bridge between the two windows
    memoryReader.js   # koffi/kernel32: OpenProcess/ReadProcessMemory,
                      #   findModuleBase, resolvePointerChain, readPointer
    win32Input.js     # koffi/user32: Alt-hold, foreground forcing, ClipCursor release
    overlayWindow.js  # the transparent, click-through, always-on-top overlay window
    overlayConfig.js  # overlay settings + defaults
    configStore.js    # config/<name>.json load/save (userData when packaged)
    areaTracker.js    # which area you're in: the game's inside-flag (in/out) and the
                      #   nearest entrance (which dungeon). Floor comes from the pointer.
    localAreaReader.js # the LocalArea pointer: an id unique per (area, floor)
    areaStore.js      # config/areas.json: named places only. Main is its ONLY writer.
    timeReader.js     # the in-game clock, off a managed singleton
    cameraFrameReader.js      # camera basis + FOV, for the AR layer
    generateManagerReader.js  # collected-state for Seeker's Tokens
    contextDbReader.js        # save-wide ContextDB (beetles, chests)
    gimmickReader.js          # live gimmick state near the player
    timerResolution.js        # raises the Windows timer resolution for the poll loop
  src/renderer/
    index.html/.js    # control window: mapgenie <webview>, overlay settings (no calibration UI)
    overlay.html/.js  # overlay: map + player marker only, no UI
    mapAgent.js       # the scripts injected into the mapgenie guest — shared by both:
                      #   buildInstallMarker (marker, follow, zoom, icons-only,
                      #   hide-found), buildFoundSync, buildOfflineMarker,
                      #   buildExtractAreas, buildClampZoom
    calibration.js    # the affines (world + per-area), shared by both
    preload.js / overlayPreload.js   # contextBridges
  config/
    dd2.offsets.json  # THE memory findings (pointer chains, offsets, backups)
    calibration.json  # world->map affine — AUTHORED by hand (.map/worldMapAligner.html); app read-only
    dungeons.json     # THE dungeon inset transforms — AUTHORED; the app only reads it
    areas.json        # named buildings/places only (written by MAIN)
    localAreas.json   # LocalArea metadata (box/score/title); its c,f are NOT consulted
    overlay.json      # overlay prefs (gitignored; bundled into the .exe on build)
    mapgenie-areas.json # cached region/portal graph (gitignored; re-derived on launch)
    singletons.json   # resolved managed-singleton chains
  tools/              # RE tooling — how the offsets were FOUND. Not part of the app.
    scanner.js, globalHunt.js, pointerScan.js, testChains.js, findOrigin.js,
    findCellIndex.js, verifyCellIndex.js, watch.js, globalWatch.js, ctLogger.js,
    ctSnapshot.js, readCtAddresses.js, readStatic.js, compareStatic.js,
    analyzeRebase.js, probeMapLib.js, smokeTest.js
    zoneLog.js                # logs the game's (insideFlag, zoneIndex) against the
                              #   nearest mapgenie entrance — builds the id mapping
    ce_find_pointer.lua       # Cheat Engine: "find what writes" -> struct base
    global.chains{,2}.json    # the validated pointer chains these produced
```

Run the tools from the repo root (`node tools/testChains.js`); they write their
dumps and logs to the working directory, and those are gitignored — they're
gigabytes and all reproducible.

- No driver, no bridge service, no signing cost. One process.
- Map: the official mapgenie embed `?embed=light`, in an Electron `<webview>`.
- The map library, the injection constraint, the layers and the MapLibre migration are in
  [mapgenie's map internals](mapgenie-map.md).

## Packaging (portable .exe, shipped)

`npm run dist` (electron-builder) → `dist/DD2Map.exe`, one ~72 MB portable binary.

- **The bundled `config/` is inside `app.asar` and READ-ONLY.** This is the trap:
  writing there fails *silently*, so calibration and every setting would appear to
  save and then be gone on the next launch, with no error anywhere. `configStore.js`
  therefore writes to `app.getPath('userData')/config` when `app.isPackaged`, and on
  first run falls back to reading the copy shipped inside the asar (which is how the
  calibration and tuned overlay settings ship with the binary). Dev still reads and
  writes the repo's `config/`, so hand-editing `config/overlay.json` keeps working.
- **koffi must be `asarUnpack`ed.** It's a native addon and cannot be loaded from
  inside an asar — without this there is no `ReadProcessMemory` and no player
  position.
- **`win.signAndEditExecutable: false`.** Otherwise electron-builder downloads its
  `winCodeSign` package, which contains macOS symlinks that Windows refuses to
  extract without Developer Mode or admin rights, and the build dies there
  ("Cannot create symbolic link"). Cost: the .exe keeps the default Electron icon
  and metadata.
- userData resolves to `%APPDATA%\dd2-map` — Electron's `app.getName()` uses
  package.json's `name`, NOT electron-builder's `productName` ("DD2 Map").

