// Atomic batched Ctrl+V via Win32 SendInput.
//
// Why this exists: uIOhook.keyTap(V, [Ctrl]) issues multiple separate
// SendInput calls (Ctrl-down, V-down, V-up, Ctrl-up). The user's
// physical Alt key — or another app's low-level keyboard hook
// (ShareX, Discord, etc.) — can interleave between those calls, so
// the target app receives `Alt+Ctrl+V` which Windows interprets as a
// menu access (Alt+V = View menu in Notepad and similar apps).
//
// SendInput, when given an array of INPUT structures in a single
// call, guarantees the events are NOT interspersed with user input
// or other SendInput calls. So we batch:
//   [LMENU-up, RMENU-up, LCONTROL-down, V-down, V-up, LCONTROL-up]
// All six events arrive at the target atomically — even if the user
// is physically holding Right Alt during the paste.
//
// This module is Windows-only. On macOS the orchestrator continues
// to use uIOhook.keyTap(V, [Meta]) for Cmd+V — macOS has no
// menu-mode issue and no equivalent SendInput batching is needed.

import { uIOhook, UiohookKey } from 'uiohook-napi';
import { debug } from '@main/debug';

// Windows Virtual-Key codes (winuser.h). All values are platform-stable.
const VK = {
  LMENU: 0xa4, // Left Alt
  RMENU: 0xa5, // Right Alt
  LCONTROL: 0xa2, // Left Ctrl
  RCONTROL: 0xa3, // Right Ctrl
  LSHIFT: 0xa0,
  RSHIFT: 0xa1,
  LWIN: 0x5b,
  RWIN: 0x5c,
  V: 0x56
} as const;

interface KBDInput {
  /** true = key up (KEYEVENTF_KEYUP), false = key down */
  up: boolean;
  /** Virtual-key code (when `type === 0`) */
  val: number;
  /** 0 = VirtualKey, 1 = ScanCode, 2 = Unicode */
  type: 0 | 1 | 2;
}

interface SendInputModule {
  SendInput(inputs: KBDInput[] | KBDInput): void;
}

let sendInputMod: SendInputModule | null = null;
let sendInputLoadError: string | null = null;

function loadSendInput(): SendInputModule | null {
  if (sendInputMod) return sendInputMod;
  if (sendInputLoadError) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sendInputMod = require('sendinput') as SendInputModule;
    return sendInputMod;
  } catch (err) {
    sendInputLoadError = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `sendinput load failed, falling back to uIOhook: ${sendInputLoadError}`);
    return null;
  }
}

/**
 * Send Ctrl+V atomically. On Windows, uses Win32 SendInput batched
 * with explicit Alt/Ctrl/Shift/Win key-up events first, so any modifier
 * the user is physically holding (or another hook is intercepting)
 * is "released" within the same atomic SendInput call before V fires.
 *
 * Falls back to uIOhook.keyTap if the sendinput native module fails
 * to load (e.g. on a future Electron version that breaks the addon).
 */
export function sendCtrlVAtomic(): void {
  if (process.platform !== 'win32') {
    // macOS and Linux: no menu-mode quirk, use the simple path.
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
    return;
  }
  const mod = loadSendInput();
  if (!mod) {
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
    return;
  }
  // Atomic batch — releases all common modifiers, then sends Ctrl+V,
  // then releases Ctrl. We do NOT re-press the released modifiers; if
  // the user is still physically holding one, the OS's next physical
  // keyboard scan will report it as down again on its own.
  const batch: KBDInput[] = [
    { up: true, val: VK.LMENU, type: 0 },
    { up: true, val: VK.RMENU, type: 0 },
    { up: true, val: VK.LSHIFT, type: 0 },
    { up: true, val: VK.RSHIFT, type: 0 },
    { up: true, val: VK.LWIN, type: 0 },
    { up: true, val: VK.RWIN, type: 0 },
    { up: false, val: VK.LCONTROL, type: 0 },
    { up: false, val: VK.V, type: 0 },
    { up: true, val: VK.V, type: 0 },
    { up: true, val: VK.LCONTROL, type: 0 }
  ];
  try {
    mod.SendInput(batch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `SendInput batch failed, falling back: ${msg}`);
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
  }
}
