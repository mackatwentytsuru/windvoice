import { BrowserWindow } from 'electron';
import type { AudioBridge } from '@main/audio/bridge';
import type { OverlayWindow } from '@main/overlay/window';
import { audioDuck } from '@main/audio/duck';
import { RealtimeClient } from '@main/realtime/client';
import { pasteText } from '@main/inject/typer';
import { streamingTyper } from '@main/inject/streamingTyper';
import { secureStore } from '@main/store/secure';
import { settingsStore } from '@main/store/settings';
import { setStatus } from '@main/tray';
import { historyStore } from '@main/store/history';
import { postProcessorPipeline } from '@main/postprocess/pipeline';
import { getActiveWindow } from '@main/context/activeWindow';
import { debug } from '@main/debug';
import { IPC, type DictationStatus } from '@shared/types';
import { CHUNK_MS, FINAL_TIMEOUT_MS, MIN_AUDIO_MS } from '@shared/constants';

const MIN_CHUNKS = Math.ceil(MIN_AUDIO_MS / CHUNK_MS);
const RECENT_AUDIO_ERROR_WINDOW_MS = 3_000;

type ChunkLike = { base64?: string; data?: Buffer | Uint8Array | ArrayBuffer };

/**
 * Owns the persistent OpenAI Realtime connection, runs one-at-a-time
 * dictation cycles, and coordinates auxiliary feedback (overlay, beep,
 * system-volume duck) and post-processing.
 */
export class DictationOrchestrator {
  private client: RealtimeClient | null = null;
  private connectPromise: Promise<RealtimeClient> | null = null;
  private inFlight = false;
  private partial = '';
  private startCount = 0;
  private pendingFinal: ((text: string) => void) | null = null;
  private pendingFinalTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;
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

  constructor(private audio: AudioBridge, overlay?: OverlayWindow) {
    this.overlay = overlay ?? null;
  }

  isActive(): boolean {
    return this.inFlight;
  }

  async prewarmConnection(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (err) {
      debug('DICTATION', `prewarm failed: ${errMsg(err)}`);
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

    let client: RealtimeClient;
    try {
      client = await this.ensureConnected();
    } catch (err) {
      this.updateStatus('error');
      this.inFlight = false;
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${errMsg(err)}`);
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

    if (settings.insertion.streaming) {
      streamingTyper.begin(settings.insertion.restoreClipboard);
      this.streamingActive = true;
    }

    const { startCount } = this.audio.beginForwarding();
    this.startCount = startCount;
    this.updateStatus('listening');
  }

  async stop(): Promise<void> {
    if (!this.inFlight) return;

    if (!this.client || !this.client.isOpen()) {
      this.cancelRequested = true;
      debug('DICTATION', 'stop arrived before connect');
      return;
    }

    const myCycle = this.cycleId;
    this.updateStatus('processing');
    const settings = settingsStore.get();
    const { delivered } = this.audio.endForwarding(this.startCount);
    debug('DICTATION', `delivered=${delivered} chunks`);

    if (settings.ui.soundCuesEnabled) {
      this.audio.playBeep('stop');
    }

    await sleep(80);

    let final = '';
    const client = this.client;
    if (delivered >= MIN_CHUNKS && client.isOpen()) {
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
        client.commit();
      });
    } else {
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
    const active = await getActiveWindow();

    // Post-processing pipeline: formatter (if enabled) → replacements →
    // file tags. Each step is best-effort; failures fall through.
    // The formatter resolves the API key lazily from secureStore.
    const processed = await postProcessorPipeline.run(final, {
      settings,
      activeWindowTitle: active?.title
    });

    this.broadcast(IPC.TRANSCRIPT_FINAL, processed);
    try {
      await pasteText(processed, settings.insertion.restoreClipboard);
    } catch (err) {
      debug('DICTATION', `paste failed: ${errMsg(err)}`);
    }
    this.tryAddHistory(processed, delivered, active?.app);
  }

  /** Detach all listeners and tear down the realtime client. */
  dispose(): void {
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
  }

  private clearPendingFinalTimer(): void {
    if (this.pendingFinalTimer) {
      clearTimeout(this.pendingFinalTimer);
      this.pendingFinalTimer = null;
    }
  }

  private detachClientListeners(): void {
    const client = this.client;
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

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        /* window torn down mid-broadcast */
      }
    }
  }

  private broadcastDelta(text: string): void {
    this.broadcast(IPC.TRANSCRIPT_DELTA, text);
  }

  private async ensureConnected(): Promise<RealtimeClient> {
    if (this.client && this.client.isOpen()) return this.client;
    if (this.connectPromise) return this.connectPromise;

    const promise = (async (): Promise<RealtimeClient> => {
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
        prompt: dictionaryPrompt(settings.dictionary),
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
            void streamingTyper.end();
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
        if (this.client === client) this.client = null;
        // If the WS reconnects mid-flight, do not keep state — surface the
        // error and reset.
        if (this.inFlight && !this.pendingFinal) {
          this.inFlight = false;
          this.duckedThisCycle = false;
          this.audio.endForwarding(this.startCount);
          this.audio.setChunkListener(null);
          void audioDuck.restore();
          if (this.streamingActive) {
            void streamingTyper.end();
            this.streamingActive = false;
          }
          this.updateStatus('error');
          this.broadcast(IPC.TRANSCRIPT_FINAL, '[error] connection closed');
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

      await client.connect();
      const chunkListener = (chunk: ChunkLike): void => {
        // Prefer the binary path; fall back to base64 for legacy/test paths.
        if (chunk.data) client.appendAudio(chunk.data as Buffer);
        else if (chunk.base64) client.appendAudio(chunk.base64);
      };
      this.clientChunkListener = chunkListener;
      this.audio.setChunkListener(chunkListener as never);
      this.client = client;
      return client;
    })();

    this.connectPromise = promise;
    try {
      const c = await promise;
      return c;
    } finally {
      this.connectPromise = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dictionaryPrompt(entries: { from: string; to: string }[]): string | undefined {
  if (!entries.length) return undefined;
  const terms = entries.map((e) => e.to).join(', ');
  return `Use these proper nouns when relevant: ${terms}.`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
