import { BrowserWindow } from 'electron';
import type { AudioBridge } from '@main/audio/bridge';
import type { OverlayWindow } from '@main/overlay/window';
import { audioDuck } from '@main/audio/duck';
import { RealtimeClient } from '@main/realtime/client';
import { pasteText } from '@main/inject/typer';
import { secureStore } from '@main/store/secure';
import { settingsStore } from '@main/store/settings';
import { setStatus } from '@main/tray';
import { historyStore } from '@main/store/history';
import { debug } from '@main/debug';
import { IPC, type DictationStatus } from '@shared/types';
import { CHUNK_MS, FINAL_TIMEOUT_MS, MIN_AUDIO_MS } from '@shared/constants';

const MIN_CHUNKS = Math.ceil(MIN_AUDIO_MS / CHUNK_MS);

/**
 * Owns the persistent OpenAI Realtime connection, runs one-at-a-time
 * dictation cycles, and coordinates auxiliary feedback (overlay, beep,
 * system-volume duck).
 */
export class DictationOrchestrator {
  private client: RealtimeClient | null = null;
  private connectPromise: Promise<RealtimeClient> | null = null;
  private inFlight = false;
  private partial = '';
  private startCount = 0;
  private pendingFinal: ((text: string) => void) | null = null;
  private cancelRequested = false;
  private duckedThisCycle = false;
  private overlay: OverlayWindow | null = null;

  constructor(private audio: AudioBridge, overlay?: OverlayWindow) {
    this.overlay = overlay ?? null;
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

    let client: RealtimeClient;
    try {
      client = await this.ensureConnected();
    } catch (err) {
      this.updateStatus('error');
      this.inFlight = false;
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${errMsg(err)}`);
      return;
    }

    if (this.cancelRequested) {
      this.inFlight = false;
      this.updateStatus('idle');
      return;
    }

    void client;
    const settings = settingsStore.get();

    // Side-effects must happen AFTER the connect-cancel check so we don't
    // duck/beep for a dictation we're about to cancel.
    if (settings.ui.duckOtherAudio) {
      this.duckedThisCycle = true;
      try {
        await audioDuck.duck(settings.ui.duckLevel);
      } catch (err) {
        debug('DICTATION', `duck failed: ${errMsg(err)}`);
        this.duckedThisCycle = false;
      }
    }
    if (settings.ui.soundCuesEnabled) {
      this.audio.playBeep('start');
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
        const timer = setTimeout(() => {
          this.pendingFinal = null;
          resolve(this.partial);
        }, FINAL_TIMEOUT_MS);
        this.pendingFinal = (text: string) => {
          clearTimeout(timer);
          this.pendingFinal = null;
          resolve(text);
        };
        client.commit();
      });
    } else {
      debug('DICTATION', `skip commit: delivered=${delivered} (<${MIN_CHUNKS})`);
    }

    this.inFlight = false;
    this.updateStatus('idle');

    if (this.duckedThisCycle) {
      this.duckedThisCycle = false;
      try {
        await audioDuck.restore();
      } catch (err) {
        // A stuck-low master volume is user-visible, so log unconditionally.
        process.stderr.write(`[dictation] duck restore failed: ${errMsg(err)}\n`);
      }
    }

    if (final.trim().length > 0) {
      this.broadcast(IPC.TRANSCRIPT_FINAL, final);
      try {
        await pasteText(final, settingsStore.get().insertion.restoreClipboard);
      } catch (err) {
        debug('DICTATION', `paste failed: ${errMsg(err)}`);
      }
      try {
        const entry = historyStore.add({
          transcript: final,
          durationMs: delivered * CHUNK_MS
        });
        this.broadcast(IPC.HISTORY_CHANGED, entry);
      } catch (err) {
        debug('DICTATION', `history.add failed: ${errMsg(err)}`);
      }
    }
  }

  private updateStatus(status: DictationStatus): void {
    setStatus(status);
    this.overlay?.setStatus(status);
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  }

  private broadcastDelta(text: string): void {
    this.broadcast(IPC.TRANSCRIPT_DELTA, text);
  }

  private async ensureConnected(): Promise<RealtimeClient> {
    if (this.client && this.client.isOpen()) return this.client;
    if (this.connectPromise) return this.connectPromise;

    const promise = (async (): Promise<RealtimeClient> => {
      const apiKey = await secureStore.getApiKey();
      if (!apiKey) throw new Error('OpenAI API key is not set');

      const settings = settingsStore.get();
      const client = new RealtimeClient({
        apiKey,
        language: settings.language === 'auto' ? undefined : settings.language,
        prompt: dictionaryPrompt(settings.dictionary),
        vadEnabled: false
      });

      client.on('delta', (text) => {
        this.partial += text;
        this.broadcastDelta(this.partial);
      });
      client.on('final', (text) => {
        if (this.pendingFinal) this.pendingFinal(text);
      });
      client.on('error', (err) => {
        debug('REALTIME', err.message);
        this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${err.message}`);
        // Unblock a pending stop() if any.
        if (this.pendingFinal) this.pendingFinal('');
        // If a dictation is in flight without an awaiting stop(), the WS
        // dropped on its own (server kicked us, network blip, etc.). Reset
        // state so the next hotkey press isn't ignored, and surface the
        // error to the tray + overlay.
        if (this.inFlight && !this.pendingFinal) {
          this.inFlight = false;
          this.duckedThisCycle = false;
          this.audio.endForwarding(this.startCount);
          void audioDuck.restore();
          this.updateStatus('error');
        }
      });
      client.on('close', () => {
        if (this.client === client) this.client = null;
      });

      await client.connect();
      this.audio.setChunkListener((chunk) => client.appendAudio(chunk.base64));
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
