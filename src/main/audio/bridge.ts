import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { is } from './env';
import { IPC, type AudioChunk } from '@shared/types';

const DEBUG = process.env['WINDVOICE_DEBUG_AUDIO'] === '1';

/**
 * Owns a hidden BrowserWindow that performs WebAudio capture and forwards
 * 24 kHz mono PCM16 chunks back over IPC.
 *
 * Lifecycle:
 *   - init()     — create the hidden window, wait for it to load
 *   - prewarm()  — request mic permission and start the AudioWorklet so
 *                  subsequent dictations start instantly. Chunks arrive
 *                  but are dropped while not forwarding.
 *   - setForwarding(true)  — start delivering chunks to the listener
 *   - setForwarding(false) — stop delivering, but keep capture alive
 */
export class AudioBridge {
  private win: BrowserWindow | null = null;
  private ready = false;
  private capturing = false;
  private forwarding = false;
  private chunkCount = 0;
  private readyResolvers: Array<() => void> = [];
  private chunkListener: ((chunk: AudioChunk) => void) | null = null;

  async init(preloadPath: string): Promise<void> {
    if (this.win) return;

    // Register IPC handlers BEFORE creating the window. The renderer's
    // audio.ts sends `audio:ready` synchronously when its module loads,
    // and that fires while loadURL is still pending — if we register
    // afterwards we miss it and prewarm() hangs forever.
    ipcMain.on(IPC.AUDIO_READY, () => {
      if (DEBUG) process.stderr.write('[audio] renderer reported ready\n');
      this.ready = true;
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      resolvers.forEach((r) => r());
    });
    ipcMain.on(IPC.AUDIO_CHUNK, (_e, chunk: AudioChunk) => {
      if (DEBUG && this.chunkCount < 5) {
        process.stderr.write(`[audio] chunk #${this.chunkCount + 1} samples=${chunk.samples}\n`);
      }
      this.chunkCount++;
      if (this.forwarding) {
        this.chunkListener?.(chunk);
      }
    });

    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    this.win = win;

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/audio.html`);
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/audio.html'));
    }
    if (DEBUG) process.stderr.write('[audio] hidden window loaded\n');
  }

  setChunkListener(cb: ((chunk: AudioChunk) => void) | null): void {
    this.chunkListener = cb;
  }

  /**
   * Start the underlying mic + AudioWorklet (idempotent).
   * Call once at app startup (after API key is available) so the first
   * hotkey press doesn't pay the getUserMedia + worklet load latency.
   */
  async prewarm(): Promise<void> {
    if (this.capturing) return;
    await this.waitReady();
    this.win?.webContents.send('audio:start');
    this.capturing = true;
    if (DEBUG) process.stderr.write('[audio] prewarm requested\n');
  }

  /** Begin delivering chunks to the chunk listener. Returns a counter snapshot. */
  beginForwarding(): { startCount: number } {
    this.forwarding = true;
    return { startCount: this.chunkCount };
  }

  /** Stop delivering chunks. Returns how many chunks were forwarded. */
  endForwarding(startCount: number): { delivered: number } {
    this.forwarding = false;
    return { delivered: this.chunkCount - startCount };
  }

  destroy(): void {
    this.win?.webContents.send('audio:stop');
    this.capturing = false;
    this.forwarding = false;
    this.win?.close();
    this.win = null;
  }

  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve) => this.readyResolvers.push(resolve));
  }
}
