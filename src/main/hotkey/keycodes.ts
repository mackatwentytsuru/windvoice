/**
 * Sentinel keycode used by HotkeyManager to represent the macOS Fn (Globe)
 * key. uiohook never emits a real keycode for Fn (its Darwin
 * FlagsChanged handler only wires Shift/Ctrl/Option/Cmd), so the manager
 * uses this fixed synthetic code in its trigger-match logic. The value is
 * chosen well outside the uiohook keycode space (which stays under
 * ~0x4000 even with the right-side modifier high-byte set) to guarantee
 * no collision with a real OS keystroke.
 *
 * Kept in its own module to avoid pulling Electron's `app` API (consumed
 * by fnwatcher.ts) into the unit-test import graph for HotkeyManager.
 */
export const FN_KEYCODE = 0xfd01;
