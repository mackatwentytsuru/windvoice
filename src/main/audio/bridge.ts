import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';
import { is } from './env';
import { debug, isDebug } from '@main/debug';
import { IPC, type AudioChunk, type BeepKind } from '@shared/types';

interface ChunkPayload {
  /** Either base64-encoded PCM or raw bytes (Buffer/Uint8Array/ArrayBuffer). */
  data: Buffer;
  samples: number;
  level?: number;
}

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
  private chunkListener: ((chunk: ChunkPayload | AudioChunk) => void) | null = null;
  private levelListener: ((level: number) => void) | null = null;
  private lastAudioErrorAt = 0;
  private lastAudioErrorMsg = '';

  // Named handler refs so destroy() can detach them.
  private onReadyHandler: ((event: IpcMainEvent) => void) | null = null;
  private onChunkHandler: ((event: IpcMainEvent, payload: unknown) => void) | null = null;
  private onErrorHandler: ((event: IpcMainEvent, message: unknown) => void) | null = null;

  async init(preloadPath: string): Promise<void> {
    if (this.win) return;

    this.onReadyHandler = (event): void => {
      if (!this.isFromOwnedWindow(event)) {
        debug('AUDIO', 'SECURITY: rejected AUDIO_READY from foreign sender');
        return;
      }
      debug('AUDIO', 'renderer reported ready');
      this.ready = true;
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      resolvers.forEach((r) => r());
    };

    this.onChunkHandler = (event, payload): void => {
      if (!this.isFromOwnedWindow(event)) {
        debug('AUDIO', 'SECURITY: rejected AUDIO_CHUNK from foreign sender');
        return;
      }
      const normalized = normalizeChunk(payload);
      if (!normalized) return;
      if (isDebug('AUDIO') && this.chunkCount < 5) {
        debug(
          'AUDIO',
          `chunk #${this.chunkCount + 1} samples=${normalized.samples} level=${normalized.level?.toFixed(3) ?? '?'}`
        );
      }
      this.chunkCount++;
      if (normalized.level !== undefined) this.levelListener?.(normalized.level);
      if (this.forwarding) this.chunkListener?.(normalized);
    };

    this.onErrorHandler = (event, message): void => {
      if (!this.isFromOwnedWindow(event)) {
        debug('AUDIO', 'SECURITY: rejected AUDIO_ERROR from foreign sender');
        return;
      }
      const msg = typeof message === 'string' ? message : String(message);
      this.lastAudioErrorAt = Date.now();
      this.lastAudioErrorMsg = msg;
    };

    ipcMain.on(IPC.AUDIO_READY, this.onReadyHandler);
    ipcMain.on(IPC.AUDIO_CHUNK, this.onChunkHandler);
    ipcMain.on(IPC.AUDIO_ERROR, this.onErrorHandler);

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

  setChunkListener(cb: ((chunk: ChunkPayload | AudioChunk) => void) | null): void {
    this.chunkListener = cb;
  }

  setLevelListener(cb: ((level: number) => void) | null): void {
    this.levelListener = cb;
  }

  /** Used by main to scope `setPermissionRequestHandler` to this window only. */
  getWebContentsId(): number | null {
    return this.win?.webContents.id ?? null;
  }

  /** Returns the most recent audio error message if one occurred within `maxAgeMs`. */
  getRecentAudioError(maxAgeMs: number): string | null {
    if (!this.lastAudioErrorAt) return null;
    if (Date.now() - this.lastAudioErrorAt > maxAgeMs) return null;
    return this.lastAudioErrorMsg || null;
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
    if (this.onReadyHandler) ipcMain.removeListener(IPC.AUDIO_READY, this.onReadyHandler);
    if (this.onChunkHandler) ipcMain.removeListener(IPC.AUDIO_CHUNK, this.onChunkHandler);
    if (this.onErrorHandler) ipcMain.removeListener(IPC.AUDIO_ERROR, this.onErrorHandler);
    this.onReadyHandler = null;
    this.onChunkHandler = null;
    this.onErrorHandler = null;
    this.win?.close();
    this.win = null;
  }

  private isFromOwnedWindow(event: IpcMainEvent): boolean {
    if (!this.win) return false;
    return event.sender.id === this.win.webContents.id;
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

function normalizeChunk(payload: unknown): ChunkPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { base64?: unknown; data?: unknown; samples?: unknown; level?: unknown };
  const samples = typeof p.samples === 'number' ? p.samples : 0;
  const level = typeof p.level === 'number' ? p.level : undefined;
  // Preferred binary path: { data: Buffer|Uint8Array|ArrayBuffer, samples, level }.
  const raw = (p.data ?? p.base64) as unknown;
  let data: Buffer | null = null;
  if (Buffer.isBuffer(raw)) {
    data = raw;
  } else if (raw instanceof Uint8Array) {
    data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  } else if (raw instanceof ArrayBuffer) {
    data = Buffer.from(raw);
  } else if (typeof raw === 'string') {
    data = Buffer.from(raw, 'base64');
  }
  if (!data) return null;
  return { data, samples, level };
}
