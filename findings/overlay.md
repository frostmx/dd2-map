# The in-game overlay

The transparent click-through window, the Electron rules that make it work, and the zoom model.

See also: [mapgenie map internals](mapgenie-map.md), [world calibration & follow](calibration-and-follow.md).

## Overlay (in-game, shipped)

Second BrowserWindow (`src/main/overlayWindow.js` + `src/renderer/overlay.*`):
fullscreen, transparent, frameless, always-on-top, click-through, no UI at all.
It has to be a SEPARATE window — `transparent` and `frame` are constructor-only in
Electron, so overlay mode cannot be a runtime flip of the control window. Both
windows run the same guest script (`src/renderer/mapAgent.js`, shared so the two
can't drift) off the same broadcast `game-position` feed.

Hotkeys (`globalShortcut`, all rebindable in `config/overlay.json`): F8 overlay,
F9 base map on/off, F10/F11 zoom out/in, hold Alt for mouse.

### Electron overlay gotchas (all load-bearing)
- **Background throttling.** The overlay is never the focused window, so Chromium
  throttles its rAF to ~1fps and the marker freezes. Needs ALL of:
  `backgroundThrottling:false` on the window, `webpreferences="backgroundThrottling=no"`
  on the `<webview>` (the 60fps follow loop lives in the *guest*), and the
  `disable-background-timer-throttling` / `disable-renderer-backgrounding` /
  `disable-backgrounding-occluded-windows` command-line switches (before `whenReady`).
- **DD2 CONFINES the cursor — so the overlay MUST take focus to be clickable.**
  This killed the original `focusable: false` (WS_EX_NOACTIVATE) design, which was
  chosen precisely so the overlay would never disturb the game. DD2 pins the cursor
  to screen centre and only releases it when it loses focus, so with a non-focusing
  overlay: Alt produced a cursor stuck at centre, POI clicks did nothing, and the
  map couldn't be panned (no drag possible with a pinned cursor). `focusable: true`
  is now the default. Two things were needed to make that actually work:
  - **`win.focus()` is not enough — Windows silently denies it.** SetForegroundWindow
    is refused to any process that didn't receive the last input event, and while
    you're playing that's always DD2. The call no-ops and the overlay never
    activates. `win32Input.forceForeground()` gets around it with the
    **AttachThreadInput** trick: attach our input queue to the foreground window's
    thread (which makes Windows treat us as part of that input context, lifting the
    restriction), SetForegroundWindow, detach immediately.
  - **The game re-applies `ClipCursor` every frame** while it believes it owns the
    mouse, so clearing the clip once on Alt-down doesn't stick. The clip is
    system-wide state (not per-process), so `ClipCursor(NULL)` from our process
    works — we just have to keep calling it, every poll tick while Alt is held.
- **Alt must LOCK follow, not just suspend it.** `__dd2_apply` cancels a manual pan
  whenever the player moves past the deadband, so any drift while you were dragging
  yanked the map back to centre mid-pan. `__dd2_interactive_lock__` blocks that
  cancellation for as long as Alt is held.
- **Do NOT pass `{ forward: true }` to `setIgnoreMouseEvents`.** Forwarding
  mouse-move to the renderer while click-through made mapgenie fire POI hover
  tooltips under the game's trapped centre-screen cursor — labels popping up over
  the game with no cursor visible anywhere near them. Click-through has no use for
  hover; don't forward.
- Scroll-wheel zoom over the overlay is routed by Windows to the *focused* window,
  so it only works while Alt is held. Hence the zoom hotkeys.
- **Alt-hold must be POLLED** (`GetAsyncKeyState` via koffi/user32,
  `src/main/win32Input.js`): `globalShortcut` only ever fires on key PRESS — there
  is no key-release event, so hold-to-interact cannot be built on it.
- **DD2 must run Borderless Windowed** — nothing draws over exclusive fullscreen.
- Closing the control window quits the app: the hidden, frameless overlay is also
  a window, so it would otherwise keep the app alive with no way to reach it.

### Zoom model
Manual and automatic zoom compose instead of fighting: the hotkeys move a persisted
`baseZoom` (the STANDING zoom) and running eases out to `baseZoom - runZoomDelta`
from wherever you set it. Speed comes from the position feed (game units/sec) with
**hysteresis + a dwell on each edge** — without the dwell, shuffling in combat
strobes the zoom. Zoom is folded into the follow loop's existing per-frame `jumpTo`
(center + zoom in one move), so it adds no *extra* Mapbox symbol churn beyond the
locked-center cost already documented below.

