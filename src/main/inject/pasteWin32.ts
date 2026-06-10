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
import { getActiveHotkeyManager } from '@main/hotkey/manager';

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

/**
 * Test seam — see tests/pasteWin32.test.ts. The native addon is loaded via
 * a bare `require()` that vitest's module mocks cannot intercept (vite-node
 * resolves it against the real filesystem), so without this hook the tests
 * would load the REAL sendinput.node and inject actual Ctrl+V keystrokes
 * into whatever window has focus during the test run.
 */
export function __setSendInputModuleForTest(mod: SendInputModule | null): void {
  sendInputMod = mod;
  sendInputLoadError = null;
}

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
  if (process.platform === 'darwin') {
    // macOS uses Cmd+V (UiohookKey.Meta). The function name is historical —
    // on darwin this is Cmd+V, not Ctrl+V. Using Ctrl+V here would silently
    // do nothing in every standard mac text field.
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Meta]);
    return;
  }
  if (process.platform !== 'win32') {
    // Linux: no menu-mode quirk, use Ctrl+V.
    // Known issue #34: uIOhook on Linux/X11 occasionally misses a `keyup`
    // for physical Ctrl, leaving `modifierState.ctrl` stuck `true`. That
    // makes `untilAllModifiersUp` hang until its timeout. The timeout in
    // HotkeyManager.untilAllModifiersUp is the safety net; repeated
    // timeouts are surfaced via stderr (see manager.ts).
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
    return;
  }
  const mod = loadSendInput();
  if (!mod) {
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
    return;
  }
  // Modifier-aware atomic batch. Critical for push-to-talk hotkeys
  // bound to Ctrl (Right Ctrl is the WindVoice default): while the user
  // is mid-streaming, they are still physically holding Right Ctrl, so
  // the OS already has Ctrl asserted. If we then SendInput a synth
  // Ctrl-down → V → Ctrl-up, the synth Ctrl-up tells the OS Ctrl is
  // released, but the user's physical Ctrl is still pressed; the next
  // physical keyboard scan re-asserts Ctrl and the receiving terminal
  // sees a Ctrl-up → Ctrl-down spasm that PSReadLine interprets as
  // bracketed-paste-state corruption (manifests as `^V` echoes and
  // mid-stream Enter submissions).
  //
  // Fix: if the user is physically holding Ctrl right now, skip the
  // synth Ctrl press/release and only synth the V keystroke. The user's
  // own Ctrl provides the modifier for the duration of the paste.
  const hkm = getActiveHotkeyManager();
  const ctrlAlreadyHeld = hkm?.isCtrlHeld() === true;

  // Prepend Alt key-up events so any physically-held (or hook-injected) Alt
  // is "released" inside the same atomic SendInput call before V fires —
  // otherwise the target sees Alt+V and Windows opens the View menu instead
  // of pasting (Notepad et al.). A KEYUP for a key that is NOT down is a
  // harmless no-op, so these are safe to send unconditionally.
  const releaseAlt: KBDInput[] = [
    { up: true, val: VK.LMENU, type: 0 },
    { up: true, val: VK.RMENU, type: 0 }
  ];

  const batch: KBDInput[] = ctrlAlreadyHeld
    ? [
        ...releaseAlt,
        { up: false, val: VK.V, type: 0 },
        { up: true, val: VK.V, type: 0 }
      ]
    : [
        ...releaseAlt,
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
