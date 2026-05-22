// Direct character-by-character text injection ("type" insertion method).
//
// Some apps mangle or refuse a Ctrl/Cmd+V paste (custom paste handlers,
// rich-text fields that reformat, security-restricted inputs). For those,
// synthesizing the text as individual keystrokes is the reliable path.
//
// Windows: each UTF-16 code unit is sent via the `sendinput` native
// module as a KEYEVENTF_UNICODE event (type 2), which injects the
// character directly as WM_CHAR — independent of keyboard layout and
// modifier state. Newlines are sent as a real VK_RETURN so they land as
// Enter rather than a literal control character.
//
// macOS / Linux: uiohook-napi has no Unicode-string injection, so this
// returns false there and the caller falls back to the paste path.

import { debug } from '@main/debug';
import { getActiveHotkeyManager } from '@main/hotkey/manager';

interface KBDInput {
  up: boolean;
  /** Virtual-key code (type 0) or UTF-16 code unit (type 2). */
  val: number;
  /** 0 = VirtualKey, 1 = ScanCode, 2 = Unicode. */
  type: 0 | 1 | 2;
}

interface SendInputModule {
  SendInput(inputs: KBDInput[] | KBDInput): void;
}

const VK_RETURN = 0x0d;
/** Code units per SendInput batch — bounds the array size and lets a slow
 *  target's message queue drain between batches. */
const BATCH_CHARS = 40;
const BATCH_DELAY_MS = 6;

let sendInputMod: SendInputModule | null = null;
let loadFailed = false;

function loadSendInput(): SendInputModule | null {
  if (sendInputMod) return sendInputMod;
  if (loadFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sendInputMod = require('sendinput') as SendInputModule;
    return sendInputMod;
  } catch (err) {
    loadFailed = true;
    debug('DICTATION', `sendinput unavailable for type-mode: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function inputsForCodeUnit(cu: number): KBDInput[] {
  if (cu === 0x0a) {
    return [
      { up: false, val: VK_RETURN, type: 0 },
      { up: true, val: VK_RETURN, type: 0 }
    ];
  }
  return [
    { up: false, val: cu, type: 2 },
    { up: true, val: cu, type: 2 }
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Type `text` into the focused control as individual keystrokes.
 *
 * Returns true when the text was delivered (or partially delivered — once
 * some keystrokes have landed, the caller must NOT fall back to a paste,
 * or the text would be inserted twice). Returns false only when nothing
 * was injected at all (non-Windows, `sendinput` missing, or the very
 * first batch failed), so the caller can cleanly fall back to pasting.
 */
export async function typeTextDirect(text: string): Promise<boolean> {
  if (process.platform !== 'win32' || !text) return false;
  const mod = loadSendInput();
  if (!mod) return false;

  // The user has just released the push-to-talk key, but wait for any
  // physically-held modifier to clear so a stray Ctrl/Shift can't combine
  // with the synthesized VK_RETURN (e.g. Ctrl+Enter submits in Slack).
  const hkm = getActiveHotkeyManager();
  if (hkm) await hkm.untilAllModifiersUp(600);

  let sentAny = false;
  try {
    let batch: KBDInput[] = [];
    let charsInBatch = 0;
    for (let i = 0; i < text.length; i++) {
      const cu = text.charCodeAt(i);
      if (cu === 0x0d) continue; // drop CR; LF below becomes a real Enter
      batch.push(...inputsForCodeUnit(cu));
      charsInBatch++;
      if (charsInBatch >= BATCH_CHARS) {
        mod.SendInput(batch);
        sentAny = true;
        batch = [];
        charsInBatch = 0;
        await sleep(BATCH_DELAY_MS);
      }
    }
    if (batch.length > 0) {
      mod.SendInput(batch);
      sentAny = true;
    }
    return true;
  } catch (err) {
    debug('DICTATION', `type-mode SendInput failed: ${err instanceof Error ? err.message : String(err)}`);
    // If keystrokes already landed, report success so the caller does not
    // paste the same text on top of the partial insertion.
    return sentAny;
  }
}
