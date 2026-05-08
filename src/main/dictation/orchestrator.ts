import { BrowserWindow } from 'electron';
import type { AudioBridge } from '@main/audio/bridge';
import { RealtimeClient } from '@main/realtime/client';
import { pasteText } from '@main/inject/typer';
import { secureStore } from '@main/store/secure';
import { settingsStore } from '@main/store/settings';
import { setStatus } from '@main/tray';
import { historyStore } from '@main/store/history';
import { IPC, type DictationStatus } from '@shared/types';

const MIN_AUDIO_MS = 200;
const MIN_CHUNKS = Math.ceil(MIN_AUDIO_MS / 50);
const FINAL_TIMEOUT_MS = 8_000;
const DEBUG = process.env['WINDVOICE_DEBUG_DICTATION'] === '1';

/**
 * Owns the persistent OpenAI Realtime connection and one-at-a-time
 * dictation cycles:
 *
 *   start →  beginForwarding (audio chunks → input_audio_buffer.append)
 *   stop  →  endForwarding   →  commit  →  await `final`  →  paste
 *
 * The WebSocket is connected once and reused, so subsequent dictations
 * never pay the TLS handshake. start() is also race-safe: if stop() is
 * called before the initial connect resolves, we abort cleanly without
 * closing a half-open socket.
 */
export class DictationOrchestrator {
  private client: RealtimeClient | null = null;
  private connectPromise: Promise<RealtimeClient> | null = null;
  private inFlight = false;
  private partial = '';
  private startCount = 0;
  private pendingFinal: ((text: string) => void) | null = null;
  private cancelRequested = false;

  constructor(private audio: AudioBridge) {}

  /** Connect eagerly so the first hotkey press is instant. Safe to call repeatedly. */
  async prewarmConnection(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (DEBUG) process.stderr.write(`[dictation] prewarm failed: ${msg}\n`);
    }
  }

  async start(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.cancelRequested = false;
    this.partial = '';

    let client: RealtimeClient;
    try {
      client = await this.ensureConnected();
    } catch (err) {
      setStatus('error');
      this.inFlight = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${msg}`);
      return;
    }

    if (this.cancelRequested) {
      // stop() arrived during connect — bail out cleanly without committing.
      this.inFlight = false;
      setStatus('idle');
      return;
    }

    void client; // keep referenced
    const { startCount } = this.audio.beginForwarding();
    this.startCount = startCount;
    setStatus('listening');
  }

  async stop(): Promise<void> {
    if (!this.inFlight) return;

    // If the connection is still being established, request cancellation
    // and return — start() will observe cancelRequested and clean up.
    if (!this.client || !this.client.isOpen()) {
      this.cancelRequested = true;
      if (DEBUG) process.stderr.write('[dictation] stop arrived before connect\n');
      return;
    }

    setStatus('processing');
    const { delivered } = this.audio.endForwarding(this.startCount);
    if (DEBUG) process.stderr.write(`[dictation] delivered=${delivered} chunks\n`);

    // Let any in-flight chunk land before we commit.
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
    } else if (DEBUG) {
      process.stderr.write(
        `[dictation] skip commit: delivered=${delivered} (<${MIN_CHUNKS})\n`
      );
    }

    this.inFlight = false;
    setStatus('idle');

    if (final.trim().length > 0) {
      this.broadcast(IPC.TRANSCRIPT_FINAL, final);
      try {
        await pasteText(final, settingsStore.get().insertion.restoreClipboard);
      } catch (err) {
        if (DEBUG) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[dictation] paste failed: ${msg}\n`);
        }
      }
      try {
        const entry = historyStore.add({
          transcript: final,
          durationMs: delivered * 50
        });
        this.broadcast(IPC.HISTORY_CHANGED, entry);
      } catch (err) {
        if (DEBUG) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[dictation] history.add failed: ${msg}\n`);
        }
      }
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
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
        this.broadcast(IPC.TRANSCRIPT_DELTA, this.partial);
      });
      client.on('final', (text) => {
        if (this.pendingFinal) {
          this.pendingFinal(text);
        }
      });
      client.on('error', (err) => {
        if (DEBUG) process.stderr.write(`[realtime] ${err.message}\n`);
        this.broadcast(IPC.TRANSCRIPT_FINAL, `[error] ${err.message}`);
        if (this.pendingFinal) {
          // unblock the awaiting stop()
          this.pendingFinal('');
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
