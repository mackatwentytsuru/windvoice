import { clipboard } from 'electron';
import { debug } from '@main/debug';
import { sendCtrlVAtomic } from '@main/inject/pasteWin32';
import { releaseStuckModifiers } from './typer';
import { getActiveHotkeyManager } from '@main/hotkey/manager';

const PASTE_INTERVAL_MS = 60;
const SETTLE_MS = 12;
const DEBOUNCE_MS = 80;
const COALESCE_MAX_CHARS = 200;
const END_MAX_WAIT_MS = 2_000;

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
  private debounceTimer: NodeJS.Timeout | null = null;
  private flushSeq = 0;

  /** Begin a streaming session; saves the user's current clipboard. */
  begin(restoreClipboard: boolean): void {
    if (this.active) {
      debug('DICTATION', 'streamingTyper.begin re-entry; ignoring');
      return;
    }
    this.active = true;
    this.buffer = '';
    this.flushSeq = 0;
    this.originalClipboard = restoreClipboard ? clipboard.readText() : null;
  }

  /** Append a fragment to be pasted as soon as possible. */
  append(text: string): void {
    if (!this.active || !text) return;
    this.buffer += text;
    if (this.buffer.length >= COALESCE_MAX_CHARS) {
      this.clearDebounce();
      if (!this.flushing) void this.flush();
      return;
    }
    this.scheduleDebounced();
  }

  /** Wait for the queue to drain, restore the clipboard, end the session. */
  async end(): Promise<void> {
    if (!this.active) return;
    this.clearDebounce();
    if (this.buffer.length > 0 && !this.flushing) {
      void this.flush();
    }
    const start = Date.now();
    while (this.flushing || this.buffer.length > 0) {
      if (Date.now() - start > END_MAX_WAIT_MS) {
        debug('DICTATION', 'streamingTyper.end timed out — forcing inactive');
        break;
      }
      await sleep(PASTE_INTERVAL_MS);
    }
    if (this.originalClipboard !== null) {
      try {
        clipboard.writeText(this.originalClipboard);
      } catch {
        /* ignore */
      }
      this.originalClipboard = null;
    }
    this.active = false;
    this.buffer = '';
  }

  private scheduleDebounced(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.flushing) void this.flush();
    }, DEBOUNCE_MS);
    if (typeof this.debounceTimer.unref === 'function') this.debounceTimer.unref();
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const seq = ++this.flushSeq;
        const chunk = this.buffer;
        this.buffer = '';
        try {
          clipboard.writeText(chunk);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debug('DICTATION', `streaming clipboard.writeText failed: ${msg}`);
          continue;
        }
        await sleep(SETTLE_MS);
        // Bail if a later seq has already started; prevents stale callbacks
        // from mutating state of the next paste.
        if (seq !== this.flushSeq) continue;
        // Wait for any user-held modifier to release. Critical when the
        // hotkey is Right Alt and the user is mid-dictation — we don't want
        // a streaming paste to fire while Alt is still being held.
        const hkm = getActiveHotkeyManager();
        if (hkm) await hkm.untilAllModifiersUp(400);
        if (seq !== this.flushSeq) continue;
        // Belt-and-suspenders modifier release for any synthesized state.
        releaseStuckModifiers();
        try {
          sendCtrlVAtomic();
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
