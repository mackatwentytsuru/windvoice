import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { is } from './env';
import { debug, isDebug } from '@main/debug';
import { IPC, type AudioChunk, type BeepKind } from '@shared/types';

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
      debug('AUDIO', 'renderer reported ready');
      this.ready = true;
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      resolvers.forEach((r) => r());
    });
    ipcMain.on(IPC.AUDIO_CHUNK, (_e, chunk: AudioChunk) => {
      if (isDebug('AUDIO') && this.chunkCount < 5) {
        debug('AUDIO', `chunk #${this.chunkCount + 1} samples=${chunk.samples} level=${chunk.level?.toFixed(3) ?? '?'}`);
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
        // Note: must remain `false`. With sandbox=true under Electron 42,
        // AudioWorklet.addModule() is denied for blob: URLs in the renderer,
        // which breaks our PCM downsampler. The other security knobs
        // (contextIsolation + the scoped permission handler in main/index.ts)
        // already cover the threat model for this hidden capture window.
        sandbox: false
      }
    });
    this.win = win;

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/audio.html`);
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/audio.html'));
    }
    debug('AUDIO', 'hidden window loaded');
  }

  setChunkListener(cb: ((chunk: AudioChunk) => void) | null): void {
    this.chunkListener = cb;
  }

  setLevelListener(cb: ((level: number) => void) | null): void {
    this.levelListener = cb;
  }

  /** Used by main to scope `setPermissionRequestHandler` to this window only. */
  getWebContentsId(): number | null {
    return this.win?.webContents.id ?? null;
  }

  async prewarm(deviceId?: string): Promise<void> {
    if (this.capturing) return;
    await this.waitReady();
    this.win?.webContents.send(IPC.AUDIO_START_CMD, deviceId);
    this.capturing = true;
    debug('AUDIO', `prewarm requested (device=${deviceId ?? 'default'})`);
  }

  changeDevice(deviceId: string): void {
    this.win?.webContents.send(IPC.AUDIO_DEVICE_CHANGE, deviceId);
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
    this.win?.webContents.send(IPC.AUDIO_STOP_CMD);
    this.capturing = false;
    this.forwarding = false;
    this.win?.close();
    this.win = null;
  }

  private waitReady(timeoutMs = 8_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.readyResolvers.indexOf(wrapped);
        if (idx >= 0) this.readyResolvers.splice(idx, 1);
        reject(new Error(`AudioBridge.waitReady timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const wrapped = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.readyResolvers.push(wrapped);
    });
  }
}
