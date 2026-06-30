import { BrowserWindow, type WebContents } from 'electron';
import type { AudioBridge, ChunkPayload } from '@main/audio/bridge';
import type { AudioChunk } from '@shared/types';
import type { OverlayWindow } from '@main/overlay/window';
import { audioDuck } from '@main/audio/duck';
import { RealtimeClient } from '@main/realtime/client';
import { pasteText } from '@main/inject/typer';
import { typeTextDirect, isAsciiTypeable } from '@main/inject/typeText';
import { streamingTyper } from '@main/inject/streamingTyper';
import { secureStore } from '@main/store/secure';
import { settingsStore } from '@main/store/settings';
import { setStatus } from '@main/tray';
import { historyStore } from '@main/store/history';
import { postProcessorPipeline } from '@main/postprocess/pipeline';
import { getActiveWindow } from '@main/context/activeWindow';
import { debug } from '@main/debug';
import { sleep } from '@main/util/sleep';
import { broadcastToUiWindows } from '@main/broadcast';
import { IPC, type DictationStatus } from '@shared/types';
import type { Settings } from '@shared/types';
import { t } from '@shared/i18n';
import {
  CHUNK_MS,
  FINAL_TIMEOUT_MS,
  MIN_AUDIO_MS,
  SILENCE_RMS_THRESHOLD
} from '@shared/constants';

const MIN_CHUNKS = Math.ceil(MIN_AUDIO_MS / CHUNK_MS);
const RECENT_AUDIO_ERROR_WINDOW_MS = 3_000;

type ChunkLike = ChunkPayload | AudioChunk;

/**
 * Owns the persistent OpenAI Realtime connection, runs one-at-a-time
 * dictation cycles, and coordinates auxiliary feedback (overlay, beep,
 * system-volume duck) and post-processing.
 */
export class DictationOrchestrator {
  private client: RealtimeClient | null = null;
  private connectPromise: Promise<RealtimeClient> | null = null;
  // Set by dispose(). _doConnect re-checks it after `await client.connect()`
  // so a client whose connect was still in flight when the orchestrator was
  // torn down is closed once the connect settles, instead of leaking a live
  // WS that nothing references (orphan-window fix).
  private disposed = false;
  private inFlight = false;
  private partial = '';
  private startCount = 0;
  private pendingFinal: ((text: string) => void) | null = null;
  private pendingFinalTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;
  // Number of back-to-back takes that captured no real audio. Drives the
  // escalation from a one-off "no audio detected" hint to actionable mic
  // guidance (another app holding the device, wrong input). Reset on any
  // take that actually commits.
  private consecutiveSilentTakes = 0;
  private duckedThisCycle = false;
  private duckPromise: Promise<void> | null = null;
  private streamingActive = false;
  /** How many chars of `partial` have already been streaming-pasted. */
  private streamedPrefixLen = 0;
  private overlay: OverlayWindow | null = null;
  private cycleId = 0;
  // Listeners we attach to the active client; tracked so we can detach them on
  // stop/error/dispose without leaking when the client is reused.
  private clientChunkListener: ((chunk: ChunkLike) => void) | null = null;
  private clientHandlers: {
    delta?: (text: string) => void;
    final?: (text: string) => void;
    error?: (err: Error) => void;
    close?: () => void;
  } = {};
  /**
   * Snapshot of UI-window webContents to receive TRANSCRIPT_DELTA events,
   * captured once per cycle in `start()` and reused for the lifetime of
   * the cycle (issue #37). Previously each delta walked
   * `BrowserWindow.getAllWindows()` and enumerated 20+ times per second
   * during streaming. The audio renderer is filtered out via its
   * webContents id at capture time so deltas never leak to it.
   */
  private deltaTargets: WebContents[] = [];

  constructor(private audio: AudioBridge, overlay?: OverlayWindow) {
    this.overlay = overlay ?? null;
  }

  isActive(): boolean {
    return this.inFlight;
  }

  async prewarmConnection(): Promise<void> {
    try {
      await this.ensureConnected();
      // Reset the tray/overlay back to 'idle' after a successful prewarm.
      // Two paths land here:
      //   1) Startup: status was 'idle' (no-op).
      //   2) onApiKeyChanged: status was 'unavailable' (the user just
      //      pasted a key); transition back to a usable state.
      // Guard with !inFlight so we never clobber a live cycle's
      // 'listening' or 'processing' state from a stray prewarm.
      if (!this.inFlight) {
        this.updateStatus('idle');
      }
    } catch (err) {
      debug('DICTATION', `prewarm failed: ${errMsg(err)}`);
      if (this.inFlight) return;
      if (isMissingApiKeyError(err)) {
        // No API key configured: 'unavailable' (setup needed). The
        // onApiKeyChanged hook in main/index.ts re-invokes prewarm once
        // the user pastes a key, which resolves and transitions to idle.
        this.updateStatus('unavailable');
      } else {
        // Any other failure (WS handshake rejected, session.update
        // rejected by the server, ready watchdog timeout, secure storage
        // error, etc.). Surface it — a silent prewarm failure here is
        // exactly how v0.1.8 looked alive while every dictation failed.
        this.updateStatus('error');
        this.reportTranscriptionError(errMsg(err));
      }
    }
  }

  async start(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.cancelRequested = false;
    this.partial = '';
    this.duckedThisCycle = false;
    this.streamingActive = false;
    this.streamedPrefixLen = 0;
    const myCycle = ++this.cycleId;

    // Surface a recent renderer-side audio error before we burn a connection.
    const recentErr =
      typeof this.audio.getRecentAudioError === 'function'
        ? this.audio.getRecentAudioError(RECENT_AUDIO_ERROR_WINDOW_MS)
        : null;
    if (recentErr) {
      this.updateStatus('error');
      this.inFlight = false;
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${recentErr}`);
      return;
    }

    // Short-circuit: if the user never set an API key (or it has been
    // cleared), the tray must reflect 'unavailable' (setup needed) rather
    // than 'error' (transient runtime failure). The onApiKeyChanged hook
    // in main/index.ts will call prewarmConnection() once the user pastes
    // a key, which transitions the tray back to 'idle'.
    let apiKey: string | null = null;
    try {
      apiKey = await secureStore.getApiKey();
    } catch (err) {
      this.updateStatus('error');
      this.inFlight = false;
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] secure storage unavailable: ${errMsg(err)}`);
      return;
    }
    if (!apiKey) {
      this.updateStatus('unavailable');
      this.inFlight = false;
      return;
    }

    let client: RealtimeClient;
    try {
      // Emit 'connecting' from the dictation cycle itself, not inside
      // _doConnect: a startup/api-key prewarm may already own the in-flight
      // connect, and a hotkey press that joins it via ensureConnected's
      // coalescing would otherwise never observe the transition (the
      // prewarm "consumed" it). Warm path: ensureConnected returns the
      // open client immediately and the transition is idle → listening.
      if (!this.client?.isOpen()) this.updateStatus('connecting');
      client = await this.ensureConnected();
    } catch (err) {
      this.updateStatus('error');
      this.inFlight = false;
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${errMsg(err)}`);
      this.reportTranscriptionError(errMsg(err));
      return;
    }

    if (myCycle !== this.cycleId || this.cancelRequested) {
      this.inFlight = false;
      this.updateStatus('idle');
      return;
    }

    void client;
    const settings = settingsStore.get();

    if (settings.ui.duckOtherAudio) {
      this.duckedThisCycle = true;
      // Kick off non-blocking; await in stop() so we still restore cleanly.
      this.duckPromise = audioDuck.duck(settings.ui.duckLevel).catch((err) => {
        debug('DICTATION', `duck failed: ${errMsg(err)}`);
        this.duckedThisCycle = false;
      });
    }
    if (settings.ui.soundCuesEnabled) {
      this.audio.playBeep('start');
    }

    // Streaming insertion is clipboard-paste based; it does not apply to
    // the keystroke-based 'type' method, which always inserts the final
    // transcript in one pass.
    if (settings.insertion.streaming && settings.insertion.method === 'paste') {
      streamingTyper.begin(
        settings.insertion.restoreClipboard,
        settings.insertion.pasteCompatibility,
        settings.insertion.excludeFromClipboardHistory
      );
      this.streamingActive = true;
    }

    const { startCount } = this.audio.beginForwarding();
    this.startCount = startCount;
    // Snapshot UI windows for delta broadcasts now, so the per-delta hot
    // path does not enumerate BrowserWindow.getAllWindows() 20+ times per
    // second (issue #37). The audio renderer is excluded explicitly via
    // its webContents id — it has no business receiving transcript text.
    this.refreshDeltaTargets();
    this.updateStatus('listening');
  }

  private refreshDeltaTargets(): void {
    const audioWcId = this.audio.getWebContentsId();
    const targets: WebContents[] = [];
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const wc = win.webContents;
      if (audioWcId !== null && audioWcId !== undefined && wc.id === audioWcId) continue;
      targets.push(wc);
    }
    this.deltaTargets = targets;
  }

  async stop(): Promise<void> {
    if (!this.inFlight) return;

    if (!this.client || !this.client.isOpen()) {
      // Stop arrived before ensureConnected resolved (user tapped the
      // hotkey faster than the WS handshake). The connect path checks
      // `cancelRequested` and bails. Crucially, reset `inFlight` here
      // so the NEXT `start()` is not blocked indefinitely — without this
      // line, the orchestrator silently refuses every subsequent
      // dictation until app restart (issue #3).
      this.cancelRequested = true;
      this.inFlight = false;
      this.updateStatus('idle');
      debug('DICTATION', 'stop arrived before connect');
      return;
    }

    const myCycle = this.cycleId;
    this.updateStatus('processing');
    const settings = settingsStore.get();
    const { delivered, maxLevel } = this.audio.endForwarding(this.startCount);
    debug('DICTATION', `delivered=${delivered} chunks maxLevel=${maxLevel.toFixed(4)}`);

    if (settings.ui.soundCuesEnabled) {
      this.audio.playBeep('stop');
    }

    // Brief flush window before commit. 80ms was conservative; one
    // extra 50ms chunk is enough to drain the in-flight buffer at the
    // WS layer, so 20ms suffices and shaves ~60ms off the perceived
    // latency between key-up and visible text (issue #8).
    await sleep(20);

    // The flush window above yields the event loop. A WS close (onClose) or a
    // before-quit dispose() can null `this.client` or drop it to CLOSING during
    // those 20ms. If so, that path already reset state and surfaced any error —
    // bail cleanly here instead of dereferencing a null client (crash) or
    // emitting a second, contradictory banner. Restore the duck/streaming we
    // grabbed for this cycle in case onClose ran after we'd flipped inFlight.
    if (!this.client || !this.client.isOpen()) {
      if (myCycle === this.cycleId) {
        this.inFlight = false;
        this.updateStatus('idle');
        if (this.duckedThisCycle) {
          this.duckedThisCycle = false;
          void audioDuck.restore().catch(() => {
            /* best-effort */
          });
        }
        if (this.streamingActive) {
          this.streamingActive = false;
          void streamingTyper.end().catch(() => {
            /* best-effort */
          });
        }
      }
      debug('DICTATION', 'stop: client closed during flush window — abandoning take');
      return;
    }

    let final = '';
    const client = this.client;
    // A take is "silent" when its peak energy never rose above the noise
    // floor — the live-but-silent mic case (digital zeros). Don't even try
    // to commit those: transcribing silence wastes a round-trip and the
    // commit gate below would reject it anyway.
    const silentTake = maxLevel < SILENCE_RMS_THRESHOLD;
    const enoughChunks = delivered >= MIN_CHUNKS;

    // `commit()` returns false when less than 100 ms of audio actually
    // reached the server (silent mic, or appends dropped by a connection
    // blip) — refusing client-side is what keeps the raw "buffer too small …
    // 0.00ms of audio" server error from ever reaching the user.
    let committed = false;
    if (enoughChunks && client.isOpen() && !silentTake) {
      committed = client.commit();
    }

    // One-line diagnostic per take — the single most useful record for
    // explaining a "became unusable" stall after the fact (see debug log file).
    debug(
      'DICTATION',
      `take result: delivered=${delivered} maxLevel=${maxLevel.toFixed(4)} ` +
        `isOpen=${client.isOpen()} enoughChunks=${enoughChunks} silent=${silentTake} committed=${committed}`
    );

    if (committed) {
      this.consecutiveSilentTakes = 0;
      final = await new Promise<string>((resolve) => {
        this.clearPendingFinalTimer();
        this.pendingFinalTimer = setTimeout(() => {
          this.pendingFinal = null;
          this.pendingFinalTimer = null;
          resolve(this.partial);
        }, FINAL_TIMEOUT_MS);
        this.pendingFinal = (text: string) => {
          this.clearPendingFinalTimer();
          this.pendingFinal = null;
          resolve(text);
        };
        // commit() was already sent above; just await the final here.
      });
    } else if (enoughChunks) {
      // The user dictated long enough, but nothing usable reached the
      // server. Discard any partial server buffer so it can't bleed into
      // the next take, then guide the user instead of failing silently.
      if (client.isOpen()) client.clearInput();
      this.handleEmptyTake(silentTake, settings);
    } else {
      // Sub-threshold tap (accidental key press, no speech) — a no-op, as
      // before. No banner: nagging on every stray tap would be worse.
      debug('DICTATION', `skip commit: delivered=${delivered} (<${MIN_CHUNKS})`);
    }

    // If the cycle was superseded while we awaited the final, bail.
    if (myCycle !== this.cycleId) {
      return;
    }

    this.inFlight = false;
    this.updateStatus('idle');

    if (this.duckedThisCycle) {
      this.duckedThisCycle = false;
      try {
        if (this.duckPromise) await this.duckPromise;
      } catch {
        /* ignore */
      }
      this.duckPromise = null;
      try {
        await audioDuck.restore();
      } catch (err) {
        process.stderr.write(`[dictation] duck restore failed: ${errMsg(err)}\n`);
      }
    }

    // Streaming mode: the tail of `final` may not have been pasted yet
    // (the last delta could arrive after we drain). Push the remaining
    // suffix and end the streaming session. NO post-processing in this
    // mode — the user explicitly opted into raw streaming.
    if (this.streamingActive) {
      const tail = final.slice(this.streamedPrefixLen);
      if (tail) streamingTyper.append(tail);
      try {
        await streamingTyper.end();
      } catch (err) {
        debug('DICTATION', `streamingTyper.end failed: ${errMsg(err)}`);
      }
      this.streamingActive = false;
      this.streamedPrefixLen = 0;
      // Still record history (raw transcript).
      if (final.trim().length > 0) {
        this.broadcast(IPC.TRANSCRIPT_FINAL, final);
        this.tryAddHistory(final, delivered);
      }
      return;
    }

    if (final.trim().length === 0) return;

    // Active window context (best-effort, cached). Used by the formatter
    // for app-aware behavior and by history for the `app` field.
    //
    // Issue #35 — threat model: the `title` and `app` strings returned by
    // get-windows are OS-derived and effectively attacker-controlled at the
    // edges (the foreground window can be ANY application, and an adversary
    // who can rename a window title can plant arbitrary content). Today
    // neither value flows into any LLM prompt — `app` is stored in history
    // and `title` is passed via `activeWindowTitle` on the pipeline context
    // but no registered processor (formatter/replacements/fileTags)
    // interpolates it into a prompt sent to OpenAI. If a future processor
    // or formatter change wires the active-window title (or process name)
    // into a system/user prompt, it MUST escape the value first using
    // `sanitizePromptValue()` from `@main/postprocess/formatter` —
    // otherwise a window title containing newlines or quotes could inject
    // arbitrary directives into the formatter prompt.
    const active = await getActiveWindow();

    // Post-processing pipeline: formatter (if enabled) → replacements →
    // file tags. Each step is best-effort; failures fall through.
    // The formatter resolves the API key lazily from secureStore.
    const processed = await postProcessorPipeline.run(final, {
      settings,
      activeWindowTitle: active?.title,
      activeWindowApp: active?.app
    });

    this.broadcast(IPC.TRANSCRIPT_FINAL, processed);
    try {
      const ins = settings.insertion;
      // 'type' mode synthesizes keystrokes (Windows). KEYEVENTF_UNICODE is
      // reliable for ASCII regardless of IME state, but an active IME
      // (Japanese/Chinese/Korean) intercepts and garbles non-ASCII VK_PACKET
      // injection (the "fine in half-width English, garbled in Japanese"
      // symptom). So non-ASCII text is routed through the IME-safe paste path
      // even in 'type' mode. typeTextDirect returns false when nothing was
      // injected (non-Windows / module missing); only then is a paste fallback
      // safe, since a partial type must not be followed by a full paste.
      const typed =
        ins.method === 'type' &&
        isAsciiTypeable(processed) &&
        (await typeTextDirect(processed));
      if (!typed) {
        await pasteText(
          processed,
          ins.restoreClipboard,
          ins.pasteCompatibility,
          ins.excludeFromClipboardHistory
        );
      }
    } catch (err) {
      debug('DICTATION', `insert failed: ${errMsg(err)}`);
    }
    this.tryAddHistory(processed, delivered, active?.app);
  }

  /** Detach all listeners and tear down the realtime client. */
  dispose(): void {
    this.disposed = true;
    this.cancelRequested = true;
    this.cycleId++;
    this.clearPendingFinalTimer();
    this.detachClientListeners();
    if (this.client) {
      try {
        this.client.dispose();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.audio.setChunkListener(null);
    // HIGH-2: when dispose() lands mid-cycle (e.g. on `before-quit`),
    // release everything else we may have grabbed for the dictation:
    //   - audio duck (otherwise the user's system volume stays low)
    //   - streaming typer (otherwise its debounce timer + clipboard
    //     save linger past app quit)
    //   - audio forwarding (otherwise the audio renderer keeps
    //     piping samples to a dead consumer)
    // All three are fire-and-forget — we cannot await in dispose().
    this.inFlight = false;
    this.streamingActive = false;
    if (this.duckedThisCycle) {
      this.duckedThisCycle = false;
      void audioDuck.restore().catch(() => {
        /* best-effort on shutdown */
      });
    }
    void streamingTyper.end().catch(() => {
      /* best-effort on shutdown */
    });
    try {
      this.audio.endForwarding(this.startCount);
    } catch {
      /* best-effort on shutdown */
    }
  }

  private clearPendingFinalTimer(): void {
    if (this.pendingFinalTimer) {
      clearTimeout(this.pendingFinalTimer);
      this.pendingFinalTimer = null;
    }
  }

  private detachClientListeners(target?: RealtimeClient | null): void {
    // Pass `target` explicitly when cleaning up a client that is no longer
    // `this.client` (e.g. an old instance about to be superseded by a
    // replacement). Defaults to `this.client` for normal teardown.
    const client = target === undefined ? this.client : target;
    if (client) {
      if (this.clientHandlers.delta) client.off('delta', this.clientHandlers.delta);
      if (this.clientHandlers.final) client.off('final', this.clientHandlers.final);
      if (this.clientHandlers.error) client.off('error', this.clientHandlers.error);
      if (this.clientHandlers.close) client.off('close', this.clientHandlers.close);
    }
    this.clientHandlers = {};
    if (this.clientChunkListener) {
      this.audio.setChunkListener(null);
      this.clientChunkListener = null;
    }
  }

  private tryAddHistory(text: string, deliveredChunks: number, app?: string): void {
    try {
      const entry = historyStore.add({
        transcript: text,
        durationMs: deliveredChunks * CHUNK_MS,
        ...(app ? { app } : {})
      });
      this.broadcast(IPC.HISTORY_CHANGED, entry);
    } catch (err) {
      debug('DICTATION', `history.add failed: ${errMsg(err)}`);
    }
  }

  private updateStatus(status: DictationStatus): void {
    setStatus(status);
    this.overlay?.setStatus(status);
  }

  /**
   * Surface a realtime/server-side dictation failure as a SYSTEM_ERROR
   * banner in the Settings UI (v0.1.8 incident: server errors after
   * session.created were downgraded to a TRANSCRIPT_FINAL '[error]…' token
   * and a tray color — invisible unless a transcript view happened to be
   * open, so every dictation failed silently). Same wiring as
   * main/index.ts's paste/duck/autoLaunch error surfacing.
   */
  private reportTranscriptionError(message: string): void {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'transcription', message });
  }

  /**
   * A take captured no usable audio. Turn that into actionable, localized
   * guidance instead of the cryptic raw server error the old path surfaced:
   *
   *  - Had energy but didn't land server-side  → connection hiccup.
   *  - Silent (live-but-silent mic), first time → gentle "no audio detected".
   *  - Silent again (the bridge's silence watchdog already rebuilt the mic
   *    and it's STILL dead) → the device itself is the problem; force a fresh
   *    rebuild and tell the user to free the mic / check their input device.
   */
  private handleEmptyTake(silentTake: boolean, settings: Settings): void {
    const lang = settings.ui.uiLanguage;
    if (!silentTake) {
      // Energy WAS captured but nothing reached the server — the realtime
      // socket is closed, half-open, or back-pressured (its send buffer never
      // drained). Left alone, every subsequent take fails the same way and the
      // app "becomes unusable". Tear the client down so the NEXT dictation
      // reconnects on a fresh socket; this take's audio is already lost, so the
      // notice asks the user to retry — which now succeeds.
      this.resetClientForReconnect();
      this.reportNotice(t('error.audioNotSent', lang));
      return;
    }
    this.consecutiveSilentTakes++;
    if (this.consecutiveSilentTakes >= 2) {
      // Proactively rebuild in case the per-cycle watchdog didn't trip this
      // time; recapture() is a no-op when capture isn't active.
      this.audio.recapture();
      this.reportNotice(t('error.micUnavailable', lang));
    } else {
      this.reportNotice(t('error.noAudioDetected', lang));
    }
  }

  /**
   * User-facing, already-localized guidance (not a raw error). Uses the
   * 'notice' source so the Settings banner renders the message verbatim,
   * without the technical "source:" prefix applied to real errors.
   */
  private reportNotice(message: string): void {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'notice', message });
  }

  /**
   * Drop the current realtime client so the NEXT dictation builds a fresh one.
   * Called when a take had real audio energy but nothing reached the server —
   * the socket is dead/half-open/back-pressured and would keep swallowing every
   * future take. `ensureConnected()` in the next `start()` reconnects lazily.
   */
  private resetClientForReconnect(): void {
    // A connection failure is NOT a silent-mic streak — clear the counter so
    // the next genuinely-silent take starts the escalation from level 1 ("no
    // audio detected") instead of jumping to the mic-unavailable guidance.
    this.consecutiveSilentTakes = 0;
    const old = this.client;
    if (!old) return;
    this.detachClientListeners(old);
    this.client = null;
    try {
      old.dispose();
    } catch {
      /* ignore */
    }
    debug('DICTATION', 'reset realtime client after undelivered audio — reconnect on next take');
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  }

  private broadcastDelta(text: string): void {
    // Hot path: 20+ calls/sec during streaming. Use the per-cycle snapshot
    // (issue #37) instead of enumerating BrowserWindow.getAllWindows().
    for (const wc of this.deltaTargets) {
      if (wc.isDestroyed()) continue;
      wc.send(IPC.TRANSCRIPT_DELTA, text);
    }
  }

  private ensureConnected(): Promise<RealtimeClient> {
    // Fast path: an already-open client serves all callers.
    if (this.client && this.client.isOpen()) return Promise.resolve(this.client);
    // Coalesce concurrent callers onto the SAME in-flight connect attempt.
    // The promise is cleared inside _doConnect's finally — never here —
    // so a second caller cannot observe a null `connectPromise` mid-build
    // and spawn a duplicate RealtimeClient (issue #20).
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async _doConnect(): Promise<RealtimeClient> {
    let apiKey: string | null;
    try {
      apiKey = await secureStore.getApiKey();
    } catch (err) {
      throw new Error(`secure storage unavailable: ${errMsg(err)}`);
    }
    if (!apiKey) throw new Error('OpenAI API key is not set');

    const settings = settingsStore.get();
    const client = new RealtimeClient({
      apiKey,
      language: settings.language === 'auto' ? undefined : settings.language,
      vadEnabled: false
    });

    const onDelta = (text: string): void => {
      this.partial += text;
      this.broadcastDelta(this.partial);
      // Streaming insertion: flush the new tail to the streaming typer.
      if (this.streamingActive) {
        const tail = this.partial.slice(this.streamedPrefixLen);
        if (tail) {
          streamingTyper.append(tail);
          this.streamedPrefixLen = this.partial.length;
        }
      }
    };
    const onFinal = (text: string): void => {
      if (this.pendingFinal) this.pendingFinal(text);
    };
    const onError = (err: Error): void => {
      debug('REALTIME', err.message);
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${err.message}`);
      this.reportTranscriptionError(err.message);
      if (this.pendingFinal) {
        this.pendingFinal('');
      }
      if (this.inFlight) {
        this.inFlight = false;
        this.duckedThisCycle = false;
        this.audio.endForwarding(this.startCount);
        this.audio.setChunkListener(null);
        void audioDuck.restore();
        if (this.streamingActive) {
          void streamingTyper.end().catch((e) =>
            debug(
              'DICTATION',
              `streamingTyper.end rejected: ${e instanceof Error ? e.message : String(e)}`
            )
          );
          this.streamingActive = false;
        }
        this.updateStatus('error');
      }
    };
    const onClose = (): void => {
      // A clean close after `commit` should resolve pendingFinal, not
      // reject — the server may have closed us right after the final.
      if (this.pendingFinal) {
        this.pendingFinal(this.partial);
      }
      const isOurClient = this.client === client;
      if (isOurClient) {
        // Detach listeners from the now-defunct client BEFORE clearing
        // the reference. Without this, if anything (auto-reconnect,
        // late events) caused the old EventEmitter to fire again, the
        // stale onDelta would keep mutating `this.partial` even after
        // a replacement client has been built (issue #21).
        this.detachClientListeners(client);
        this.client = null;
      }
      // If the WS reconnects mid-flight, do not keep state — surface the
      // error and reset.
      if (this.inFlight && !this.pendingFinal) {
        this.inFlight = false;
        this.duckedThisCycle = false;
        this.audio.endForwarding(this.startCount);
        this.audio.setChunkListener(null);
        void audioDuck.restore();
        if (this.streamingActive) {
          void streamingTyper.end().catch((e) =>
            debug(
              'DICTATION',
              `streamingTyper.end rejected: ${e instanceof Error ? e.message : String(e)}`
            )
          );
          this.streamingActive = false;
        }
        this.updateStatus('error');
        this.broadcast(IPC.TRANSCRIPT_FINAL, '[error] connection closed');
        this.reportTranscriptionError('connection closed mid-dictation');
      } else if (isOurClient) {
        // H7: WS closed (likely reconnect-attempts exhausted) while no
        // dictation was in flight. Previously the tray stayed on
        // whatever status it had — silently, the next dictation press
        // would also fail because the client is gone. Mark error so
        // the tray reflects reality; the next start() reconnects.
        this.updateStatus('error');
      }
    };

    this.clientHandlers = {
      delta: onDelta,
      final: onFinal,
      error: onError,
      close: onClose
    };
    client.on('delta', onDelta);
    client.on('final', onFinal);
    client.on('error', onError);
    client.on('close', onClose);

    // The 'connecting' status emit lives in start(), not here: this method
    // also serves prewarm, and a prewarm-owned connect must neither flash
    // the overlay nor swallow the transition a joining dictation expects.

    try {
      await client.connect();
    } catch (err) {
      // Connect failed (handshake error, session.update rejected, ready
      // watchdog). Detach our handlers and dispose so nothing lingers on
      // the dead client's emitter.
      this.detachClientListeners(client);
      try {
        client.dispose();
      } catch {
        /* ignore */
      }
      throw err;
    }
    if (this.disposed) {
      // dispose() ran while the connect was in flight — this client was
      // never published to `this.client`, so without this check its live
      // WS would be orphaned (connected, unreferenced, unkillable).
      this.detachClientListeners(client);
      try {
        client.dispose();
      } catch {
        /* ignore */
      }
      throw new Error('orchestrator disposed during connect');
    }
    const chunkListener = (chunk: ChunkLike): void => {
      // Prefer the binary path; fall back to base64 for legacy/test paths.
      if ('data' in chunk && chunk.data) client.appendAudio(chunk.data as Buffer);
      else if ('base64' in chunk && chunk.base64) client.appendAudio(chunk.base64);
    };
    this.clientChunkListener = chunkListener;
    this.audio.setChunkListener(chunkListener);
    this.client = client;
    return client;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when the error originates from the no-API-key branch inside
 * ensureConnected. Used by prewarmConnection to surface 'unavailable'
 * (setup needed) instead of leaving the tray on its previous status.
 */
function isMissingApiKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message === 'OpenAI API key is not set';
}
