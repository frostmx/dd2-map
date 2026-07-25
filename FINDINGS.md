# DD2 Map — Findings & Project State

Personal live-map overlay for **Dragon's Dogma 2**: embeds the mapgenie.io world
map and shows the player's real-time position, read from `DD2.exe` memory.
Personal use only. No kernel driver — DD2 has no anti-cheat, so user-mode
`ReadProcessMemory` (via koffi FFI) is sufficient.

---

**This file is an index.** The findings themselves live in `findings/`, one file
per topic. Each row below says what a file covers and lists the terms worth
grepping for. `CLAUDE.md` covers *where* things live and what the rules are;
`findings/` covers *why* they are that way — the measurements, the dead ends, and
the things that look like they should work and don't.

**Adding a finding:** put it in the topic file it belongs to. Only touch this file
if you create a new topic. Keeping the index to descriptions is the whole point —
it is what stops it growing back into 2000 lines.

## The topics

| File | Covers | Keywords |
|---|---|---|
| [architecture.md](findings/architecture.md) | Repo layout, what each module owns, and how the portable .exe is built. | repo tree, `src/main`, `src/renderer`, `tools/`, config files, `npm run dist`, electron-builder, asar, `asarUnpack`, koffi native addon, userData, `signAndEditExecutable` |
| [memory-re.md](findings/memory-re.md) | How the player position, the pointer chains and the camera angle were found — plus the floating origin that made the naive read wrong. | position struct, `+0x40/+0x44/+0x48`, pointer chain, `findModuleBase`, `resolvePointerChain`, camera facing angle, floating origin, streaming cell, local vs world coords, cell hysteresis, dead reckoning (superseded), Cheat Engine, pointer scan, dead ends |
| [singletons-and-clock.md](findings/singletons-and-clock.md) | Walking the managed-singleton table with plain RPM, and the in-game clock it bought. | managed singleton, `singletonHunt.js`, `config/singletons.json`, `timeReader.js`, in-game clock, day/night |
| [calibration-and-follow.md](findings/calibration-and-follow.md) | The hand-authored world affine, the locked-centre follow loop, and heading-up rotation. | world affine, pure similarity, `worldMapAligner`, conformal, no `points`, retired 3-point fit, retired Refine, `followFrame`, locked-centre follow, `_fadeDuration`, icon flicker, `rotateWithHeading`, bearing, `__dd2_heading__` |
| [mapgenie-map.md](findings/mapgenie-map.md) | Measured facts about the embedded map: library, layers, tile server, found-POI paint, cross-window found sync. | Mapbox GL, MapLibre migration, `mapboxgl-`/`maplibregl-` class prefix, `__dd2_probe`, canvas alpha, zoom range, layer list not stable, icons-only, never restore visibility, z17 403s, `buildClampZoom`, `MAX_TILE_ZOOM`, overzoom, found POIs paint expression, feature-state, `buildFoundSync`, Redux `dispatch` patch, thunk |
| [overlay.md](findings/overlay.md) | The transparent click-through window, the Electron rules behind it, and the zoom model. | overlay window, transparent, frameless, always-on-top, click-through, `setIgnoreMouseEvents`, `backgroundThrottling`, 1 fps throttle, Alt-hold polling, `globalShortcut` has no key-up, foreground rules, zoom steps |
| [dungeons-areas.md](findings/dungeons-areas.md) | Why dungeons need their own transform, mapgenie's portal graph, and how the app decides area and floor. | inset panels, `insetLinear`, `config/dungeons.json`, portal graph, `locationsById`, `locationIds=`, transitions, category taxonomy, groups, named places, `Home`, `placeRadius`, inside-flag `+FA62CAC`, `dungeonEnterRadius`, the 219u bug, LocalArea pointer, floor, retired height-floor mechanic, retired auto-calibration, `zoneLog.js`, crowdsourcing |
| [dungeon-art-and-alignment.md](findings/dungeon-art-and-alignment.md) | Pulling the game's own dungeon minimap art out of memory, and the `.map` tools that align it to mapgenie's tiles. | dungeon edge art, F9, `data:` URL not a custom scheme, `TexSize`/`TexRange`, `.map/*.html`, `worldMapAligner`, `dungeonAligner`, hand alignment, `mergeLocalAreas` clobber, `src:"game"` vs `src:"aligned"` |
| [inset-resolve-wip.md](findings/inset-resolve-wip.md) | **Paused work.** Rebasing every inset translation onto the 2026-07-20 world affine. Read this before touching `config/dungeons.json`. | `resolveInsets.py`, z16, 8 px/unit, the `ncc` block trap, `blindSearch.py`, `matchInset.py`, `sweepAreas.py`, score gate, `REGRESS`, `dungeons_resolved.json`, half-migrated `insetLinear`, tile cache, `python3.12.exe` |
| [almanac-and-ar.md](findings/almanac-and-ar.md) | The vendored Almanac coordinate data, and the AR marker layer that projects it onto the game. | Seeker's Token ground truth, 240 correspondences, `data/almanac/`, `cameraFrameReader.js`, camera basis, FOV, the projection, eye-vs-feet, AR smoothing, `#arCanvas`, `overlay.json → ar`, collected-state, `generateManagerReader.js`, `_NeverGenetateID`, ContextDB, Golden Trove Beetle, gimmick, chests, wrong open/closed state |
| [offline-cache.md](findings/offline-cache.md) | Baking mapgenie's tiles and assets to disk and serving them from a local mirror when mapgenie is unreachable. | `tileCache.js`, `httpMirror.js`, `assetCapture.js`, `buildOfflineMarker`, `config/cache.json`, map source `auto`/`online`/`offline` |

## Quick "where do I look"

- **The marker is in the wrong place outdoors** → [calibration-and-follow](findings/calibration-and-follow.md)
- **…and in a dungeon** → [dungeons-areas](findings/dungeons-areas.md), then [inset-resolve-wip](findings/inset-resolve-wip.md)
- **The app names the wrong building, or none** → [dungeons-areas](findings/dungeons-areas.md) (named places)
- **Part of the map went invisible, black, or blank at max zoom** → [mapgenie-map](findings/mapgenie-map.md)
- **The overlay is slow, opaque, or eats clicks** → [overlay](findings/overlay.md)
- **A memory read returns garbage, or breaks after a restart** → [memory-re](findings/memory-re.md)
- **An AR marker shows the wrong state** → [almanac-and-ar](findings/almanac-and-ar.md)
- **Settings save and then vanish** → [architecture](findings/architecture.md) (the asar is read-only)
- **Map works with no internet, or a baked tile looks stale** → [offline-cache](findings/offline-cache.md)
