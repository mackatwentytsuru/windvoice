import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';
import { is } from './env';
import { debug, isDebug } from '@main/debug';
import { IPC, type AudioChunk, type BeepKind } from '@shared/types';
import { SILENCE_RMS_THRESHOLD } from '@shared/constants';

export interface ChunkPayload {
  /** Either base64-encoded PCM or raw bytes (Buffer/Uint8Array/ArrayBuffer). */
  data: Buffer;
  samples: number;
  level?: number;
}

// ─── live-but-silent watchdog ────────────────────────────────────────────────
// A microphone MediaStreamTrack can report readyState==='live' && !muted while
// the underlying OS pipeline delivers only digital silence — e.g. another app
// holds WASAPI exclusive mode (Teams/Zoom), a Bluetooth headset hands off, a
// driver resets, or the display slept via DPMS (which fires NO powerMonitor
// event). The renderer's flag-based health probe cannot see this: the worklet
// keeps emitting all-zero PCM chunks, chunkCount advances normally, and the
// dictation transcribes silence — staying broken until the app restarts. The
// only reliable signal is the audio ENERGY actually delivered, which the
// worklet already computes per chunk as `level` (RMS). After each dictation
// starts we watch that energy and force a microphone rebuild if it stays flat.
const SILENCE_WATCHDOG_MS = 600;

/** Public listener signature exposed by `setChunkListener`. */
export type ChunkListener = (chunk: ChunkPayload | AudioChunk) => void;

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
  // Highest RMS level seen since the current dictation began forwarding. Reset
  // in beginForwarding and inspected by the silence watchdog.
  private maxLevelSinceForward = 0;
  private silenceWatchdog: NodeJS.Timeout | null = null;
  private readyResolvers: Array<() => void> = [];
  private chunkListener: ((chunk: ChunkPayload | AudioChunk) => void) | null = null;
  private levelListener: ((level: number) => void) | null = null;
  private errorListener: ((message: string) => void) | null = null;
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
      if (this.forwarding) {
        if (normalized.level !== undefined && normalized.level > this.maxLevelSinceForward) {
          this.maxLevelSinceForward = normalized.level;
        }
        this.chunkListener?.(normalized);
      }
    };

    this.onErrorHandler = (event, message): void => {
      if (!this.isFromOwnedWindow(event)) {
        debug('AUDIO', 'SECURITY: rejected AUDIO_ERROR from foreign sender');
        return;
      }
      const msg = typeof message === 'string' ? message : String(message);
      this.lastAudioErrorAt = Date.now();
      this.lastAudioErrorMsg = msg;
      this.errorListener?.(msg);
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

  setChunkListener(cb: ChunkListener | null): void {
    this.chunkListener = cb;
  }

  setLevelListener(cb: ((level: number) => void) | null): void {
    this.levelListener = cb;
  }

  /**
   * Register a listener that fires when the trusted audio renderer reports
   * an error. The bridge already validates `event.sender.id` against the
   * owned window's webContents id, so any message reaching this callback is
   * known to be from the legitimate audio renderer.
   */
  setErrorListener(cb: ((message: string) => void) | null): void {
    this.errorListener = cb;
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

  /**
   * Ask the hidden audio renderer to tear down and re-acquire the microphone
   * stream. Called when the OS resumes from sleep — the previously captured
   * MediaStreamTrack is dead after suspend and yields only silence (frozen
   * spectrogram, empty dictation) until it is replaced.
   */
  recapture(): void {
    if (!this.capturing) return;
    this.win?.webContents.send(IPC.AUDIO_RECOVER_CMD);
    debug('AUDIO', 'recapture requested (power resume / track loss)');
  }

  beginForwarding(): { startCount: number } {
    this.forwarding = true;
    this.maxLevelSinceForward = 0;
    // Resume the AudioContext if it was suspended during idle. The
    // first chunk after resume arrives in ~5-15ms, well within the
    // perceived start-recording window.
    this.win?.webContents.send(IPC.AUDIO_RESUME_CMD);
    this.armSilenceWatchdog(this.chunkCount);
    return { startCount: this.chunkCount };
  }

  endForwarding(startCount: number): { delivered: number; maxLevel: number } {
    this.forwarding = false;
    this.clearSilenceWatchdog();
    // Suspend the AudioContext so the worklet stops generating 50ms
    // chunks (issue #7). Saves ~20 IPC crossings + Buffer.from copies
    // per idle second.
    this.win?.webContents.send(IPC.AUDIO_SUSPEND_CMD);
    // `maxLevel` is the peak RMS seen across this take. The orchestrator
    // uses it to tell "the user actually spoke" from a live-but-silent mic
    // delivering digital zeros, and to surface mic guidance instead of a
    // raw server commit error.
    return { delivered: this.chunkCount - startCount, maxLevel: this.maxLevelSinceForward };
  }

  /**
   * Catch a "live-but-silent" microphone (see the watchdog note above). A short
   * time after forwarding starts, if NO chunks arrived (graph stuck suspended)
   * or every chunk was effectively digital silence (dead OS pipeline), force a
   * full microphone rebuild via `recapture()`. This measures the energy the mic
   * actually delivers rather than the OS API's `live`/`muted` flags, which lie
   * when another app holds the device or a driver/display reset has occurred.
   */
  private armSilenceWatchdog(startCount: number): void {
    this.clearSilenceWatchdog();
    this.silenceWatchdog = setTimeout(() => {
      this.silenceWatchdog = null;
      if (!this.forwarding) return;
      const delivered = this.chunkCount - startCount;
      const silent = delivered === 0 || this.maxLevelSinceForward < SILENCE_RMS_THRESHOLD;
      if (silent) {
        debug(
          'AUDIO',
          `silent capture detected (delivered=${delivered} maxLevel=${this.maxLevelSinceForward.toFixed(4)}) — rebuilding mic`
        );
        this.recapture();
      }
    }, SILENCE_WATCHDOG_MS);
    if (typeof this.silenceWatchdog.unref === 'function') this.silenceWatchdog.unref();
  }

  private clearSilenceWatchdog(): void {
    if (this.silenceWatchdog) {
      clearTimeout(this.silenceWatchdog);
      this.silenceWatchdog = null;
    }
  }

  playBeep(kind: BeepKind): void {
    this.win?.webContents.send(IPC.BEEP_PLAY, kind);
  }

  destroy(): void {
    this.clearSilenceWatchdog();
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
