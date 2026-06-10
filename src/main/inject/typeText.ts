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
import { sleep } from '@main/util/sleep';

interface KBDInput {
  up: boolean;
  /** Virtual-key code (type 0) or UTF-16 code unit (type 2). */
  val: number;
  /** 0 = VirtualKey, 1 = ScanCode, 2 = Unicode. */
  type: 0 | 1 | 2;
}

// Contract note: `require('sendinput')` resolves to the package's JS
// wrapper (index.js), NOT the raw .node binary. The wrapper accepts plain
// `{up, val, type}` objects and converts each one itself via the native
// `CreateKBDInpVKey/ScanCode/Unicode` factories into the `Napi::External`
// handles that the native `SendInput` consumes. Passing externals from
// here would be wrong — the wrapper would reject them ("Expecting val to
// be an integer"). The Win32 SendInput return value (number of events
// actually injected) is propagated back through the wrapper, which lets
// us detect blocked/partial injection below.
interface SendInputModule {
  SendInput(inputs: KBDInput[] | KBDInput): number;
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
    const mod = require('sendinput') as SendInputModule;
    // Runtime contract smoke-test: an empty array is a true no-op (the
    // native side skips the Win32 call when len === 0), but it still
    // round-trips the full wrapper → addon path. If a future sendinput
    // version changes the call contract (e.g. stops accepting plain
    // `{up, val, type}` objects), this throws HERE with a debug log,
    // instead of every dictation silently falling back to paste.
    if (typeof mod.SendInput !== 'function') {
      throw new Error('sendinput contract break: SendInput is not a function');
    }
    mod.SendInput([]);
    sendInputMod = mod;
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

/** UTF-16 high surrogate — the first half of a code point above U+FFFF. */
function isHighSurrogate(cu: number): boolean {
  return cu >= 0xd800 && cu <= 0xdbff;
}

/**
 * Test seam — see tests/typeText.test.ts. Same rationale as the seam in
 * pasteWin32.ts: the bare `require('sendinput')` above is invisible to
 * vitest's module mocks, and letting the real addon load in tests would
 * type real keystrokes into the focused window.
 */
function setSendInputModuleForTest(mod: SendInputModule | null): void {
  sendInputMod = mod;
  loadFailed = false;
}

/** Exported for unit testing — see tests/typeText.test.ts. */
export const __test = { inputsForCodeUnit, isHighSurrogate, setSendInputModuleForTest };

/**
 * Win32 SendInput returns the number of events it actually injected.
 * Fewer than requested means the rest were blocked (UIPI when the target
 * window is elevated, or another hook swallowed them) — surface that in
 * the debug log so a partial insertion is diagnosable instead of silent.
 */
function checkInjectedCount(sent: number, batch: KBDInput[]): void {
  if (typeof sent === 'number' && sent !== batch.length) {
    debug('DICTATION', `type-mode SendInput injected ${sent}/${batch.length} events — input may be blocked (UIPI?)`);
  }
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
      // A lone trailing high surrogate (string truncated mid-code-point)
      // is dropped rather than sent: KEYEVENTF_UNICODE delivers it as an
      // unpaired WM_CHAR, which most apps render as U+FFFD or garbage.
      // Dropping the half-character is the least-bad outcome — the rest
      // of the text still lands intact.
      if (isHighSurrogate(cu) && i === text.length - 1) {
        debug('DICTATION', 'type-mode: dropping lone trailing high surrogate');
        continue;
      }
      batch.push(...inputsForCodeUnit(cu));
      charsInBatch++;
      // Flush full batches — but never between the two halves of a
      // surrogate pair. KEYEVENTF_UNICODE reassembles a surrogate pair
      // only when both code units arrive adjacently; splitting them
      // across two SendInput calls (with the inter-batch sleep) would
      // break the character.
      if (charsInBatch >= BATCH_CHARS && !isHighSurrogate(cu)) {
        checkInjectedCount(mod.SendInput(batch), batch);
        sentAny = true;
        batch = [];
        charsInBatch = 0;
        await sleep(BATCH_DELAY_MS);
      }
    }
    if (batch.length > 0) {
      checkInjectedCount(mod.SendInput(batch), batch);
      sentAny = true;
    }
    // `sentAny` is false only when nothing survived filtering (text was
    // all CRs, or a single lone high surrogate); returning false lets the
    // caller fall back to a paste in that case.
    return sentAny;
  } catch (err) {
    debug('DICTATION', `type-mode SendInput failed: ${err instanceof Error ? err.message : String(err)}`);
    // If keystrokes already landed, report success so the caller does not
    // paste the same text on top of the partial insertion.
    return sentAny;
  }
}
