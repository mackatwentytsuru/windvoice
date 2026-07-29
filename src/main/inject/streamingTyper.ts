import { clipboard } from 'electron';
import { debug } from '@main/debug';
import { sendPasteKeystroke } from '@main/inject/paste';
import { isWaylandSession } from '@main/linux/wayland';
import {
  portalSidecar,
  type PortalSnapshotResult
} from '@main/linux/portalSidecar';
// releaseStuckModifiers no longer used — see note in typer.ts.
import { getActiveHotkeyManager } from '@main/hotkey/manager';
import { pasteTiming, type PasteCompatibility, type PasteTiming } from '@main/inject/pasteTiming';
import { writeClipboardText } from '@main/inject/clipboardWrite';
import { clipboardHasText, notifyPasteFailed } from '@main/inject/typer';
import { sleep } from '@main/util/sleep';

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
  private timing: PasteTiming = pasteTiming('balanced');
  private excludeHistory = false;
  /**
   * Wayland portal mode: Electron's clipboard never becomes the Wayland
   * selection for a background app, so each chunk goes through the portal
   * sidecar instead (claim selection + inject). The original selection is
   * snapshotted via the sidecar at begin() and restored at end().
   */
  private wayland = false;
  private waylandOld: Promise<PortalSnapshotResult> | null = null;
  private waylandRestoreRequested = false;
  private waylandClaimed = false;
  /**
   * Bumped on every begin(). A flush loop captures it and bails out the
   * moment it changes: on Wayland a single chunk paste can outlive
   * `end()`'s 2s drain timeout, and without this guard the late paste
   * would re-claim the clipboard AFTER the restore (leaving the transcript
   * on the user's clipboard) and its `finally` would resolve the NEXT
   * session's idle promise, letting that end() return before it drained.
   */
  private generation = 0;
  /** In-flight chunk paste, so end() can await it before restoring. */
  private inFlight: Promise<unknown> | null = null;
  /** Serializes end(); begin() refuses a new generation until it settles. */
  private ending: Promise<void> | null = null;
  /** Stops the queue after a delivery failure while preserving its text. */
  private pasteFailed = false;

  /** Begin a streaming session; saves the user's current clipboard. */
  begin(
    restoreClipboard: boolean,
    compatibility: PasteCompatibility = 'balanced',
    excludeFromClipboardHistory = false
  ): boolean {
    if (this.active || this.ending || this.flushing || this.inFlight) {
      debug('DICTATION', 'streamingTyper.begin rejected while prior session is active/ending');
      return false;
    }
    this.active = true;
    this.generation += 1;
    this.flushing = false;
    this.inFlight = null;
    this.pasteFailed = false;
    this.buffer = '';
    this.flushSeq = 0;
    this.idlePromise = null;
    this.resolveIdle = null;
    this.timing = pasteTiming(compatibility);
    this.excludeHistory = excludeFromClipboardHistory;
    this.wayland = isWaylandSession() && portalSidecar.isReady();
    this.waylandRestoreRequested = this.wayland && restoreClipboard;
    this.waylandClaimed = false;
    if (this.wayland) {
      this.waylandOld = restoreClipboard
        ? portalSidecar.snapshot()
        : Promise.resolve({ ok: true, kind: 'empty' });
      this.originalClipboard = null;
      return true;
    }
    // Only snapshot the clipboard for restore when it holds TEXT. If the user
    // has an image or file list copied, `readText()` returns '' — restoring
    // that at end() would silently wipe their non-text clipboard. In that
    // case we skip restore (originalClipboard stays null) rather than destroy
    // their data. Mirrors the non-streaming guard in typer.ts (LOW-1).
    this.originalClipboard =
      restoreClipboard && clipboardHasText() ? clipboard.readText() : null;
    return true;
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
    if (this.pasteFailed) return;
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
    if (this.ending) return this.ending;
    if (!this.active) return;
    const ending = this.endSession().finally(() => {
      if (this.ending === ending) this.ending = null;
    });
    this.ending = ending;
    return ending;
  }

  private async endSession(): Promise<void> {
    this.clearDebounce();
    if (this.buffer.length > 0 && !this.flushing && !this.pasteFailed) {
      void this.flush();
    }
    // Event-driven drain (issue #26): `flush` resolves `idlePromise` in its
    // `finally` block when both `flushing` is false and `buffer` is empty.
    // We loop because `append()` can re-arm `idlePromise` if a fragment
    // arrives between two flush passes — we must re-check buffer state
    // after each await.
    const start = Date.now();
    while (this.flushing || (this.buffer.length > 0 && !this.pasteFailed)) {
      const remaining = END_MAX_WAIT_MS - (Date.now() - start);
      if (remaining <= 0) {
        debug('DICTATION', 'streamingTyper.end drain timed out — awaiting active operation boundary');
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
        debug('DICTATION', 'streamingTyper.end drain timed out — awaiting active operation boundary');
        break;
      }
    }
    // Never let a new generation begin while an old flush can still mutate
    // the clipboard. Portal requests are bounded by PortalSidecar.send();
    // after its timeout it destroys the child, resolving this promise with
    // an indeterminate result rather than executing later.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* the flush path reports the user-visible failure */
      }
    }
    if (this.flushing && this.idlePromise) await this.idlePromise;
    if (this.wayland) {
      this.inFlight = null;
      const old = this.waylandOld
        ? await this.waylandOld
        : ({ ok: true, kind: 'empty' } as const);
      if (old.ok && old.kind === 'text' && this.waylandClaimed) {
        if (this.flushSeq > 0) await sleep(this.timing.streamRestoreDelayMs);
        const restore = await portalSidecar.setSelection(old.text);
        if (!restore.ok) {
          debug('DICTATION', 'streaming portal selection restore failed');
          notifyPasteFailed(
            `clipboard restore failed (Wayland portal): ${restore.error ?? 'unknown error'}`
          );
        }
      } else if (!old.ok && !this.pasteFailed) {
        notifyPasteFailed(`clipboard snapshot failed (Wayland portal): ${old.error}`);
      }
      this.waylandOld = null;
      this.wayland = false;
      this.waylandRestoreRequested = false;
      this.waylandClaimed = false;
      this.active = false;
      this.buffer = '';
      this.flushing = false;
      this.pasteFailed = false;
      this.idlePromise = null;
      this.resolveIdle = null;
      return;
    }
    if (this.originalClipboard !== null) {
      // Wait for the target app to consume the final chunk's paste before
      // restoring the original clipboard. Without this margin a slow
      // target (terminal, RDP/VM, busy app) reads the restored clipboard
      // and the last words of the dictation are lost / replaced by the
      // user's previously-copied content. Only needed when something was
      // actually pasted (flushSeq > 0).
      if (this.flushSeq > 0) await sleep(this.timing.streamRestoreDelayMs);
      try {
        writeClipboardText(this.originalClipboard, this.excludeHistory);
      } catch (err) {
        // M11: clipboard restore failure was previously completely silent
        // here — the streaming path regressed the non-streaming fix in
        // typer.ts. Surface it to debug + UI so the user knows their
        // pre-dictation clipboard was replaced.
        const m = err instanceof Error ? err.message : String(err);
        debug('DICTATION', `clipboard restore failed: ${m}`);
        notifyPasteFailed(`clipboard restore failed: ${m}`);
      }
      this.originalClipboard = null;
    }
    this.active = false;
    this.buffer = '';
    this.flushing = false;
    this.pasteFailed = false;
    // Discard any lingering idle promise so a future `begin()` starts clean.
    this.idlePromise = null;
    this.resolveIdle = null;
  }

  private scheduleDebounced(): void {
    if (this.pasteFailed) return;
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
    if (!this.active || this.flushing || this.pasteFailed) return;
    const gen = this.generation;
    this.flushing = true;
    // Ensure an idle promise exists so `end()` can await drain even if
    // flush() was invoked directly (e.g. via COALESCE_MAX_CHARS path)
    // without going through the empty→non-empty transition in append().
    this.armIdlePromise();
    try {
      while (this.buffer.length > 0) {
        // `flushSeq` is bumped after confirmed injection so `end()` can
        // tell whether any paste actually fired this dictation cycle (see the
        // `if (this.flushSeq > 0)` check before the restore delay).
        // MEDIUM-3: the previous `if (seq !== this.flushSeq) continue`
        // guards after each await were dead — only this loop increments
        // `flushSeq` and `flushing=true` blocks re-entry from
        // append()'s COALESCE branch, so `seq` can never lag behind.
        const chunk = this.buffer;
        this.buffer = '';
        if (this.wayland) {
          // Portal path: modifier-release wait + full claim/inject handled
          // per chunk; restore deferred to end().
          if (this.waylandRestoreRequested && this.waylandOld) {
            const snapshot = await this.waylandOld;
            if (gen !== this.generation) return;
            if (!snapshot.ok || snapshot.kind === 'non-text') {
              this.buffer = chunk + this.buffer;
              this.pasteFailed = true;
              const detail = snapshot.ok
                ? 'the existing clipboard is non-text and cannot be restored'
                : `clipboard snapshot failed: ${snapshot.error}`;
              debug('DICTATION', `streaming portal paste stopped: ${detail}`);
              notifyPasteFailed(`Wayland streaming paste stopped — ${detail}`);
              return;
            }
          }
          const hkmW = getActiveHotkeyManager();
          if (hkmW) await hkmW.untilAllModifiersUp(400);
          if (gen !== this.generation) return;
          hkmW?.suppressFor(40);
          const paste = portalSidecar.pasteText(chunk, false, this.timing.streamSettleMs, 0);
          this.inFlight = paste;
          const result = await paste;
          if (this.inFlight === paste) this.inFlight = null;
          this.waylandClaimed =
            this.waylandClaimed || result.claimed || result.injected === true;
          if (result.injected !== true) {
            // Preserve the undelivered/uncertain chunk and stop this session.
            // Retrying an uncertain operation could duplicate dictated text.
            this.buffer = chunk + this.buffer;
            this.pasteFailed = true;
            const detail =
              result.injected === null
                ? 'delivery outcome is unknown'
                : `delivery failed at ${result.stage ?? 'unknown stage'}`;
            debug('DICTATION', `streaming portal paste failed for a chunk: ${detail}`);
            notifyPasteFailed(
              `Wayland streaming paste stopped — ${detail}: ${result.error ?? 'unknown error'}`
            );
            return;
          }
          this.flushSeq++;
          if (gen !== this.generation) return;
          await sleep(this.timing.streamIntervalMs);
          if (gen !== this.generation) return;
          continue;
        }
        try {
          writeClipboardText(chunk, this.excludeHistory);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debug('DICTATION', `streaming clipboard.writeText failed: ${msg}`);
          continue;
        }
        await sleep(this.timing.streamSettleMs);
        // Wait for any user-held modifier to release. Critical when the
        // hotkey is Right Alt and the user is mid-dictation — we don't want
        // a streaming paste to fire while Alt is still being held.
        const hkm = getActiveHotkeyManager();
        if (hkm) await hkm.untilAllModifiersUp(400);
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
          const paste = sendPasteKeystroke();
          this.inFlight = paste;
          await paste;
          if (this.inFlight === paste) this.inFlight = null;
          this.flushSeq++;
        } catch (err) {
          this.inFlight = null;
          const msg = err instanceof Error ? err.message : String(err);
          debug('DICTATION', `streaming paste failed: ${msg}`);
        }
        await sleep(this.timing.streamIntervalMs);
      }
    } finally {
      // begin() cannot start a new generation until end() has observed this
      // cleanup, so even an early/superseded return must release flushing.
      this.flushing = false;
      // Wake any `end()` await iff the queue truly drained. If `append()`
      // re-filled the buffer while we were yielding, leave idlePromise
      // alive — the buffer-non-empty branch in `end()` will re-flush and
      // resolve on the next pass.
      if (this.buffer.length === 0 || this.pasteFailed) this.signalIdle();
    }
  }
}

export const streamingTyper = new StreamingTyper();
