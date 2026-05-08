import { clipboard } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { debug } from '@main/debug';

const PASTE_INTERVAL_MS = 60;
const SETTLE_MS = 12;

/** macOS uses Cmd, every other platform uses Ctrl, for the paste shortcut. */
function pasteModifier(): number {
  return process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl;
}

/**
 * Streaming text injector. Used when `settings.insertion.streaming === true`.
 *
 * Each `append(text)` enqueues a fragment; the typer paste-flushes the queue
 * one chunk at a time using clipboard + Ctrl+V. The original clipboard is
 * preserved across the entire dictation cycle (begin → end), not per chunk,
 * so multiple Ctrl+V operations don't burn the user's clipboard.
 *
 * Note: this races with user typing. The expected UX is that the user does
 * not type while dictating — the overlay shows "listening" the whole time.
 */
export class StreamingTyper {
  private originalClipboard: string | null = null;
  private buffer = '';
  private flushing = false;
  private active = false;

  /** Begin a streaming session; saves the user's current clipboard. */
  begin(restoreClipboard: boolean): void {
    this.active = true;
    this.buffer = '';
    this.originalClipboard = restoreClipboard ? clipboard.readText() : null;
  }

  /** Append a fragment to be pasted as soon as possible. */
  append(text: string): void {
    if (!this.active || !text) return;
    this.buffer += text;
    if (!this.flushing) void this.flush();
  }

  /** Wait for the queue to drain, restore the clipboard, end the session. */
  async end(): Promise<void> {
    if (!this.active) return;
    while (this.flushing || this.buffer.length > 0) {
      await sleep(PASTE_INTERVAL_MS);
    }
    if (this.originalClipboard !== null) {
      clipboard.writeText(this.originalClipboard);
      this.originalClipboard = null;
    } else if (this.originalClipboard === null) {
      // We never saved; nothing to do.
    }
    this.active = false;
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const chunk = this.buffer;
        this.buffer = '';
        clipboard.writeText(chunk);
        await sleep(SETTLE_MS);
        try {
          uIOhook.keyTap(UiohookKey.V, [pasteModifier()]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debug('DICTATION', `streaming paste failed: ${msg}`);
        }
        await sleep(PASTE_INTERVAL_MS);
      }
    } finally {
      this.flushing = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const streamingTyper = new StreamingTyper();
