// Win32 input/window control via koffi, same pattern as memoryReader.js (koffi is
// already a dependency; nothing native is compiled).
//
// Why this exists at all: Electron's globalShortcut only ever fires on key PRESS
// — it has no key-release event. Hold-to-interact (hold Alt to give the overlay
// the mouse, release to hand it back) therefore cannot be built on it, and has to
// be polled. GetAsyncKeyState is the cheap way to do that.
//
// The rest of this file exists because DD2 does two things that a plain Electron
// overlay cannot fight:
//   1. It holds the foreground, and Windows REFUSES SetForegroundWindow from a
//      process that didn't receive the last input event — so Electron's
//      win.focus() is silently denied and the overlay never actually activates.
//      forceForeground() uses the AttachThreadInput trick to get around that.
//   2. It calls ClipCursor to pin the cursor to screen centre. That's a
//      system-wide clip, so any process can clear it — releaseCursorClip() does.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const VK_MENU = 0x12; // Alt (either side)
const KEY_DOWN_MASK = 0x8000;

// HWND/HANDLE are passed as uintptr_t rather than void*: we deal in raw handle
// VALUES here (Electron hands us the window handle as an integer in a Buffer),
// never in pointers to memory we own.
const GetAsyncKeyState = user32.func('int16 GetAsyncKeyState(int vKey)');
const GetForegroundWindow = user32.func('uintptr_t GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(uintptr_t hWnd)');
const BringWindowToTop = user32.func('bool BringWindowToTop(uintptr_t hWnd)');
const GetWindowThreadProcessId = user32.func(
  'uint32 GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)'
);
const AttachThreadInput = user32.func(
  'bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'
);
const ClipCursor = user32.func('bool ClipCursor(uintptr_t lpRect)');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');

function isAltDown() {
  return (GetAsyncKeyState(VK_MENU) & KEY_DOWN_MASK) !== 0;
}

function foregroundWindow() {
  return GetForegroundWindow();
}

// pid of the window that currently has focus, or null if there isn't one.
function foregroundProcessId() {
  const hwnd = GetForegroundWindow();
  if (!hwnd) return null;
  const out = [0];
  GetWindowThreadProcessId(hwnd, out);
  return out[0] || null;
}

// Actually activate a window, even when we're not the foreground process.
//
// Windows only honours SetForegroundWindow from the process that received the
// last input event — while you're playing, that's DD2, so a plain call (and
// Electron's win.focus(), which is a plain call underneath) just gets ignored.
// Attaching our input queue to the foreground window's thread makes Windows treat
// us as part of that input context for the duration, which lifts the restriction.
// Detach immediately after: staying attached would couple the two message loops.
function forceForeground(hwnd) {
  if (!hwnd) return false;

  const fg = GetForegroundWindow();
  if (!fg || fg === hwnd) return SetForegroundWindow(hwnd);

  const fgThread = GetWindowThreadProcessId(fg, [0]);
  const ourThread = GetCurrentThreadId();

  let attached = false;
  if (fgThread && fgThread !== ourThread) {
    attached = AttachThreadInput(ourThread, fgThread, true);
  }
  const ok = SetForegroundWindow(hwnd);
  BringWindowToTop(hwnd);
  if (attached) AttachThreadInput(ourThread, fgThread, false);
  return ok;
}

// Undo the game's ClipCursor. The clip is system-wide state, not per-process, so
// clearing it from here works — but DD2 re-applies it while it holds focus, so
// this gets called every poll tick while Alt is held, not just once.
function releaseCursorClip() {
  return ClipCursor(0); // NULL = unconfine
}

module.exports = {
  isAltDown,
  foregroundWindow,
  foregroundProcessId,
  forceForeground,
  releaseCursorClip,
};
