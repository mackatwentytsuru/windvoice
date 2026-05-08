import { app, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { debug } from '@main/debug';

const SETTLE_MS = 30;
const RESTORE_DELAY_MS = 120;
const RESTORE_FILE = '.clipboard-restore.json';

/** macOS uses Cmd, every other platform uses Ctrl, for the paste shortcut. */
function pasteModifier(): number {
  return process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl;
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
 *
 * Serialized via `pasteQueue` so two rapid dictations cannot interleave —
 * cycle B's clipboard write or Ctrl+V used to race with cycle A's
 * restoreClipboard step (firing at t = previous + 30 + 120 ms), which
 * caused the first few characters of cycle B's paste to drop.
 */
let pasteQueue: Promise<unknown> = Promise.resolve();

export function pasteText(text: string, restoreClipboard = true): Promise<void> {
  const job = pasteQueue.then(
    () => doPasteText(text, restoreClipboard),
    () => doPasteText(text, restoreClipboard)
  );
  // Swallow rejections in the queue tail so one failed paste does not
  // poison the queue for subsequent calls.
  pasteQueue = job.catch(() => undefined);
  return job;
}

async function doPasteText(text: string, restoreClipboard: boolean): Promise<void> {
  if (!text) return;

  const previous = restoreClipboard ? clipboard.readText() : null;
  if (restoreClipboard && previous !== null) {
    persistPreviousClipboard(previous);
  }
  clipboard.writeText(text);

  await sleep(SETTLE_MS);
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
