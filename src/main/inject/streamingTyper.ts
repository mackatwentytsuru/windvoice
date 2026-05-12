import { clipboard } from 'electron';
import { debug } from '@main/debug';
import { sendCtrlVAtomic } from '@main/inject/pasteWin32';
// releaseStuckModifiers no longer used — see note in typer.ts.
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
  /**
   * Issue #26: previously `end()` busy-polled every 60ms (up to 2s) waiting
   * for the flush loop to drain. Replaced with an event-driven idle promise:
   * `flush` resolves `idlePromise` in its `finally` once `flushing` is false
   * and `buffer` is empty. `end()` awaits that promise (with a timeout).
   *
   * `append()` re-arms `idlePromise` when the buffer transitions from empty
   * to non-empty, so a late fragment arriving during `end()` correctly
   * keeps the await alive until the new chunk drains too.
   */
  private idlePromise: Promise<void> | null = null;
  private resolveIdle: (() => void) | null = null;

  /** Begin a streaming session; saves the user's current clipboard. */
  begin(restoreClipboard: boolean): void {
    if (this.active) {
      debug('DICTATION', 'streamingTyper.begin re-entry; ignoring');
      return;
    }
    this.active = true;
    this.buffer = '';
    this.flushSeq = 0;
    this.idlePromise = null;
    this.resolveIdle = null;
    this.originalClipboard = restoreClipboard ? clipboard.readText() : null;
  }

  /**
   * Lazily (re)create the idle promise when we transition from "empty +
   * not flushing" to a state where work is pending. Called from `append`
   * when the buffer becomes non-empty and from `flush` on entry.
   */
  private armIdlePromise(): void {
    if (this.idlePromise !== null) return;
    this.idlePromise = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
  }

  private signalIdle(): void {
    const r = this.resolveIdle;
    this.resolveIdle = null;
    this.idlePromise = null;
    if (r) r();
  }

  /** Append a fragment to be pasted as soon as possible. */
  append(text: string): void {
    if (!this.active || !text) return;
    // Strip CR/LF from streaming text. Whisper-style transcripts can emit
    // `\n` at phrase boundaries; with Ctrl+V into a terminal or REPL input
    // that's treated as Enter, causing the partial paste to be submitted
    // mid-dictation. Streaming insertion is meant to grow a single line of
    // text — explicit line breaks via voice aren't a use case worth the
    // ambiguity. The final paste path (non-streaming) leaves newlines
    // intact via the GPT formatter pipeline.
    const safe = text.replace(/[\r\n]+/g, ' ');
    if (!safe) return;
    const wasEmpty = this.buffer.length === 0;
    this.buffer += safe;
    // Re-arm the idle promise on the empty→non-empty transition so a late
    // fragment arriving while `end()` is awaiting correctly extends the
    // wait until the new chunk has drained.
    if (wasEmpty) this.armIdlePromise();
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
    // Event-driven drain (issue #26): `flush` resolves `idlePromise` in its
    // `finally` block when both `flushing` is false and `buffer` is empty.
    // We loop because `append()` can re-arm `idlePromise` if a fragment
    // arrives between two flush passes — we must re-check buffer state
    // after each await.
    const start = Date.now();
    while (this.flushing || this.buffer.length > 0) {
      const remaining = END_MAX_WAIT_MS - (Date.now() - start);
      if (remaining <= 0) {
        debug('DICTATION', 'streamingTyper.end timed out — forcing inactive');
        break;
      }
      const waitFor = this.idlePromise ?? Promise.resolve();
      let timedOut = false;
      await Promise.race([
        waitFor,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, remaining)
        )
      ]);
      if (timedOut) {
        debug('DICTATION', 'streamingTyper.end timed out — forcing inactive');
        break;
      }
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
    // Discard any lingering idle promise so a future `begin()` starts clean.
    this.idlePromise = null;
    this.resolveIdle = null;
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
    // Ensure an idle promise exists so `end()` can await drain even if
    // flush() was invoked directly (e.g. via COALESCE_MAX_CHARS path)
    // without going through the empty→non-empty transition in append().
    this.armIdlePromise();
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
        // No phantom modifier release. sendCtrlVAtomic detects a held
        // physical Ctrl (the user's PTT key) and omits the synth Ctrl
        // press/release so the user's own Ctrl provides the modifier.
        // On macOS we also mute hotkey detection during the synthesized
        // Cmd+V so uIOhook's own re-broadcast of the Meta-down does not
        // self-trigger a new dictation cycle.
        // 40ms covers the synth Meta+V events from uIOhook.keyTap (which
        // arrive within ~1-5ms) without swallowing real physical key
        // releases. Each chunk re-arms this, so the safety net in
        // HotkeyManager.onKey is the ultimate guarantee that a user
        // release inside the window is not lost.
        hkm?.suppressFor(40);
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
      // Wake any `end()` await iff the queue truly drained. If `append()`
      // re-filled the buffer while we were yielding, leave idlePromise
      // alive — the buffer-non-empty branch in `end()` will re-flush and
      // resolve on the next pass.
      if (this.buffer.length === 0) this.signalIdle();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const streamingTyper = new StreamingTyper();
