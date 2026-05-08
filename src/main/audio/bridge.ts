import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { is } from './env';
import { IPC, type AudioChunk, type BeepKind } from '@shared/types';

const DEBUG = process.env['WINDVOICE_DEBUG_AUDIO'] === '1';

/**
 * Owns a hidden BrowserWindow that performs WebAudio capture and forwards
 * 24 kHz mono PCM16 chunks back over IPC. Also dispatches beep cues.
 */
export class AudioBridge {
  private win: BrowserWindow | null = null;
  private ready = false;
  private capturing = false;
  private forwarding = false;
  private chunkCount = 0;
  private readyResolvers: Array<() => void> = [];
  private chunkListener: ((chunk: AudioChunk) => void) | null = null;
  private levelListener: ((level: number) => void) | null = null;

  async init(preloadPath: string): Promise<void> {
    if (this.win) return;

    ipcMain.on(IPC.AUDIO_READY, () => {
      if (DEBUG) process.stderr.write('[audio] renderer reported ready\n');
      this.ready = true;
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      resolvers.forEach((r) => r());
    });
    ipcMain.on(IPC.AUDIO_CHUNK, (_e, chunk: AudioChunk) => {
      if (DEBUG && this.chunkCount < 5) {
        process.stderr.write(`[audio] chunk #${this.chunkCount + 1} samples=${chunk.samples} level=${chunk.level?.toFixed(3) ?? '?'}\n`);
      }
      this.chunkCount++;
      // Always emit the level (used by the overlay meter while visible).
      if (chunk.level !== undefined) this.levelListener?.(chunk.level);
      if (this.forwarding) this.chunkListener?.(chunk);
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

  setLevelListener(cb: ((level: number) => void) | null): void {
    this.levelListener = cb;
  }

  async prewarm(deviceId?: string): Promise<void> {
    if (this.capturing) return;
    await this.waitReady();
    this.win?.webContents.send('audio:start', deviceId);
    this.capturing = true;
    if (DEBUG) process.stderr.write(`[audio] prewarm requested (device=${deviceId ?? 'default'})\n`);
  }

  changeDevice(deviceId: string): void {
    this.win?.webContents.send('audio:deviceChange', deviceId);
  }

  beginForwarding(): { startCount: number } {
    this.forwarding = true;
    return { startCount: this.chunkCount };
  }

  endForwarding(startCount: number): { delivered: number } {
    this.forwarding = false;
    return { delivered: this.chunkCount - startCount };
  }

  playBeep(kind: BeepKind): void {
    this.win?.webContents.send(IPC.BEEP_PLAY, kind);
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
