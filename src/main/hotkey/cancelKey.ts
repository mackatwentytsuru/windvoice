// Esc cancels the take in progress (recording or waiting for the transcript).
//
// Registered as an Electron global shortcut only while a take is active, so
// Esc is swallowed then (it must not also close a dialog in the target app)
// and behaves normally the rest of the time. Mirrors Handy's
// register_cancel_shortcut and VoiceInk's cancel shortcut.

import { globalShortcut } from 'electron';
import { debug } from '@main/debug';

const ACCELERATOR = 'Escape';
let armed = false;

export function armCancelKey(onCancel: () => void): void {
  if (armed) return;
  try {
    armed = globalShortcut.register(ACCELERATOR, onCancel);
    if (!armed) debug('HOTKEY', 'cancel key: Escape is taken by another app');
  } catch {
    armed = false;
  }
}

export function disarmCancelKey(): void {
  if (!armed) return;
  armed = false;
  try {
    globalShortcut.unregister(ACCELERATOR);
  } catch {
    /* app shutting down */
  }
}
