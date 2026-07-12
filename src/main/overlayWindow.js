// The in-game overlay: a fullscreen, transparent, always-on-top, click-through
// window holding nothing but the mapgenie webview and the player marker.
//
// It is a SEPARATE window from the main one on purpose: `transparent` and
// `frame` are constructor-only in Electron, so overlay mode cannot be a runtime
// flip of the existing calibration window.
//
// Three details below are load-bearing; each one silently breaks the overlay if
// dropped. They're marked (1)(2)(3) at their site.

const { BrowserWindow, screen, app } = require('electron');
const path = require('node:path');

let overlay = null;
let enabled = false; // user's F8 intent, distinct from isVisible() — the
                     // focus-follow watcher hides/shows within an enabled overlay

// (1) Background throttling. The overlay is NEVER the focused window, so
// Chromium would throttle its timers and rAF to ~1fps and the marker would
// freeze. Killing that needs all three of these switches plus
// backgroundThrottling:false on the window AND on the <webview> tag (the 60fps
// follow loop actually lives in the guest, not the host page).
function applyThrottlingSwitches() {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

function create(cfg) {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  overlay = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    // (2) Focusability decides whether Alt can actually give you the mouse.
    // DD2 CONFINES the cursor to screen centre with raw input and only releases
    // it when it loses focus — so a focusable:false overlay (which never takes
    // focus, to avoid disturbing the game) leaves the cursor trapped at centre
    // and clicks land nowhere. Hence focusable defaults to TRUE: Alt focuses the
    // overlay, the game releases the cursor, and on release we hand focus
    // straight back with SetForegroundWindow. Set false in config if you'd rather
    // the game never lose focus and you don't need to click POIs.
    focusable: cfg.focusable !== false,
    show: false,
    title: 'DD2 Map Overlay',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'overlayPreload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // (1)
    },
  });

  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  // 'screen-saver' is the highest ordinary level — it keeps the overlay above a
  // borderless-windowed game. (3) DD2 must run in Borderless Windowed: nothing
  // draws over exclusive fullscreen. That's a game setting, not something we
  // can fix from here.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-through by default; Alt flips it (see setInteractive).
  // NOT { forward: true }: forwarding mouse-move to the renderer made mapgenie
  // fire POI hover tooltips under the game's trapped centre-screen cursor —
  // labels popping up over the game with no visible cursor anywhere near them.
  // Click-through mode has no use for hover, so don't forward.
  overlay.setIgnoreMouseEvents(true);

  overlay.on('closed', () => { overlay = null; });

  return overlay;
}

function isAlive() {
  return !!overlay && !overlay.isDestroyed();
}

function send(channel, payload) {
  if (isAlive()) overlay.webContents.send(channel, payload);
}

// showInactive, never show(): show() would focus the overlay and yank input out
// of the game.
function show() {
  if (isAlive() && !overlay.isVisible()) overlay.showInactive();
}

function hide() {
  if (isAlive() && overlay.isVisible()) overlay.hide();
}

function toggle() {
  enabled = !enabled;
  if (enabled) show(); else hide();
  return enabled;
}

function isEnabled() {
  return enabled;
}

// Alt held: take the mouse. Released: go back to click-through with NO event
// forwarding (see the note in create()).
function setInteractive(interactive) {
  if (!isAlive()) return;
  if (interactive) overlay.setIgnoreMouseEvents(false);
  else overlay.setIgnoreMouseEvents(true);
}

function focus() {
  if (isAlive()) overlay.focus();
}

// The raw Win32 HWND, so win32Input can force it to the foreground (Electron's
// own focus() is a plain SetForegroundWindow, which Windows denies to a
// non-foreground process — see win32Input.forceForeground).
function getHwnd() {
  if (!isAlive()) return null;
  const buf = overlay.getNativeWindowHandle();
  return Number(buf.readBigUInt64LE(0));
}

function getWindow() {
  return isAlive() ? overlay : null;
}

module.exports = {
  applyThrottlingSwitches,
  create,
  isAlive,
  isEnabled,
  send,
  show,
  hide,
  toggle,
  setInteractive,
  focus,
  getHwnd,
  getWindow,
};
