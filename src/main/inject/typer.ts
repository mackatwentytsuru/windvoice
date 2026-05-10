import { app, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { debug } from '@main/debug';
import { getActiveHotkeyManager } from '@main/hotkey/manager';

const SETTLE_MS = 30;
const RESTORE_DELAY_MS = 120;
const RESTORE_FILE = '.clipboard-restore.json';

/** macOS uses Cmd, every other platform uses Ctrl, for the paste shortcut. */
function pasteModifier(): number {
  return process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl;
}

/**
 * If the user's hotkey is Right Alt (the WindVoice default for push-to-talk),
 * the OS may still see Alt as held when our `Ctrl+V` keyTap fires —
 * the physical keyup hasn't been processed yet. The receiving app then
 * interprets the input as `Alt+Ctrl+V` and triggers the menu (e.g. Notepad
 * shows the access-key overlay and `V` activates the View menu instead of
 * pasting).
 *
 * Workaround: explicitly release every modifier key before each Ctrl+V.
 * uIOhook's `keyToggle(_, 'up')` is a no-op if the key isn't actually held,
 * so this is safe to call unconditionally.
 */
const MODIFIER_KEYS_TO_CLEAR: number[] = [
  UiohookKey.Alt,
  UiohookKey.AltRight,
  UiohookKey.Ctrl,
  UiohookKey.CtrlRight,
  UiohookKey.Shift,
  UiohookKey.ShiftRight,
  UiohookKey.Meta,
  UiohookKey.MetaRight
];

export function releaseStuckModifiers(): void {
  for (const k of MODIFIER_KEYS_TO_CLEAR) {
    try {
      uIOhook.keyToggle(k, 'up');
    } catch {
      /* ignore — best-effort */
    }
  }
}

function restoreFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), RESTORE_FILE);
  } catch {
    return null;
  }
}

function persistPreviousClipboard(text: string): void {
  const fp = restoreFilePath();
  if (!fp) return;
  try {
    fs.writeFileSync(fp, JSON.stringify({ text, savedAt: Date.now() }), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `persist clipboard failed: ${msg}`);
  }
}

function clearPersistedClipboard(): void {
  const fp = restoreFilePath();
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `clear persisted clipboard failed: ${msg}`);
  }
}

/**
 * If a previous WindVoice run crashed mid-paste and left a clipboard-
 * restore file behind, put the saved text back into the user's clipboard.
 * Safe to call multiple times — the file is deleted after restore.
 */
export function recoverClipboardIfPending(): void {
  const fp = restoreFilePath();
  if (!fp) return;
  try {
    if (!fs.existsSync(fp)) return;
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === 'string') {
      clipboard.writeText(parsed.text);
      debug('DICTATION', 'recovered clipboard from prior crash');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `recoverClipboard failed: ${msg}`);
  } finally {
    clearPersistedClipboard();
  }
}

/**
 * Insert text at the focused cursor by:
 *   1. saving current clipboard text (also persists to disk for crash safety)
 *   2. writing the new text into clipboard
 *   3. simulating Ctrl+V (Cmd+V on macOS)
 *   4. restoring the original clipboard
 *
 * Compared to per-character typing, this is faster and IME-safe.
 */
export async function pasteText(text: string, restoreClipboard = true): Promise<void> {
  if (!text) return;

  const previous = restoreClipboard ? clipboard.readText() : null;
  if (restoreClipboard && previous !== null) {
    persistPreviousClipboard(previous);
  }
  clipboard.writeText(text);

  // Wait for the user to physically release any modifier key. Synthesized
  // keyToggle('up') events alone are NOT enough — Windows re-reads the
  // pressed-by-user state on the next keyboard scan. We have to wait for
  // an actual hardware keyup. uIOhook reports modifier state on every
  // event so this resolves the moment the user lets go.
  const hkm = getActiveHotkeyManager();
  if (hkm) await hkm.untilAllModifiersUp(600);

  await sleep(SETTLE_MS);
  // Belt-and-suspenders: even after waitForModifierRelease, send keyToggle
  // 'up' for every modifier to clear any sticky synthesized state.
  releaseStuckModifiers();
  await sleep(20);
  try {
    uIOhook.keyTap(UiohookKey.V, [pasteModifier()]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[error] paste keyTap failed: ${msg}\n`);
    if (restoreClipboard) {
      try {
        if (previous !== null) clipboard.writeText(previous);
        else clipboard.clear();
      } catch {
        /* ignore */
      }
      clearPersistedClipboard();
    }
    return;
  }

  if (restoreClipboard) {
    // Wait long enough for the receiving app to consume the paste before
    // we put the old clipboard back.
    await sleep(RESTORE_DELAY_MS);
    try {
      if (previous !== null) {
        clipboard.writeText(previous);
      } else {
        clipboard.clear();
      }
    } catch {
      /* ignore */
    }
    clearPersistedClipboard();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
