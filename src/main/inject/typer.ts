import { clipboard } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';

const SETTLE_MS = 30;

/**
 * Insert text at the focused cursor by:
 *   1. saving current clipboard text
 *   2. writing the new text into clipboard
 *   3. simulating Ctrl+V
 *   4. restoring the original clipboard
 *
 * Compared to per-character typing, this is faster and IME-safe.
 */
export async function pasteText(text: string, restoreClipboard = true): Promise<void> {
  if (!text) return;

  const previous = restoreClipboard ? clipboard.readText() : null;
  clipboard.writeText(text);

  await sleep(SETTLE_MS);
  uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);

  if (restoreClipboard) {
    // Wait long enough for the receiving app to consume the paste
    // before we put the old clipboard back.
    await sleep(120);
    if (previous !== null) {
      clipboard.writeText(previous);
    } else {
      clipboard.clear();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
