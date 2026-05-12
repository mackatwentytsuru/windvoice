import { contextBridge, ipcRenderer } from 'electron';
// IMPORTANT: import from `@shared/ipc` (zod-free), NOT `@shared/types`.
// Under sandbox: true the preload runs without Node module resolution,
// and zod (which `types.ts` imports) is externalized — pulling it in via
// types.ts causes "Unable to load preload script: module not found: zod".
import {
  IPC,
  type Settings,
  type DictationStatus,
  type HistoryEntry,
  type OverlayState,
  type BeepKind
} from '../shared/ipc';

type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

/**
 * Unwrap a privileged-IPC result wrapper. The main process gates mutation
 * handlers behind a sender-trust check and a Zod parse; on refusal or
 * validation failure it returns `{ ok: false, error, code }`. Renderer
 * callers expect plain values, so we throw an Error here on `ok: false`
 * (which propagates as a rejected Promise to the caller).
 */
async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  const err = new Error(r.error) as Error & { code?: string };
  if (r.code) err.code = r.code;
  throw err;
}

const api = {
  // settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (s: Partial<Settings>): Promise<Settings> =>
    unwrap<Settings>(ipcRenderer.invoke(IPC.SETTINGS_SET, s)),

  // api key
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(IPC.APIKEY_HAS),
  setApiKey: (key: string): Promise<void> =>
    unwrap<true>(ipcRenderer.invoke(IPC.APIKEY_SET, key)).then(() => undefined),

  // dictation control (manual trigger from UI)
  start: (): Promise<void> =>
    unwrap<true>(ipcRenderer.invoke(IPC.DICTATION_START)).then(() => undefined),
  stop: (): Promise<void> =>
    unwrap<true>(ipcRenderer.invoke(IPC.DICTATION_STOP)).then(() => undefined),

  // status / transcript subscriptions
  onStatus: (cb: (status: DictationStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: DictationStatus): void => cb(s);
    ipcRenderer.on(IPC.STATUS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.STATUS_CHANGED, handler);
  },
  onTranscriptDelta: (cb: (text: string) => void): (() => void) => {
    const handler = (_e: unknown, s: string): void => cb(s);
    ipcRenderer.on(IPC.TRANSCRIPT_DELTA, handler);
    return () => ipcRenderer.removeListener(IPC.TRANSCRIPT_DELTA, handler);
  },
  onTranscriptFinal: (cb: (text: string) => void): (() => void) => {
    const handler = (_e: unknown, s: string): void => cb(s);
    ipcRenderer.on(IPC.TRANSCRIPT_FINAL, handler);
    return () => ipcRenderer.removeListener(IPC.TRANSCRIPT_FINAL, handler);
  },
  onAudioError: (cb: (msg: string) => void): (() => void) => {
    const handler = (_e: unknown, s: string): void => cb(s);
    ipcRenderer.on(IPC.AUDIO_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_ERROR, handler);
  },
  getLastAudioError: (): Promise<string | null> => ipcRenderer.invoke(IPC.AUDIO_LAST_ERROR),

  // overlay state subscription (used by overlay window only)
  onOverlayState: (cb: (s: OverlayState) => void): (() => void) => {
    const handler = (_e: unknown, s: OverlayState): void => cb(s);
    ipcRenderer.on(IPC.OVERLAY_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.OVERLAY_STATE, handler);
  },

  // history
  listHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HISTORY_LIST),
  removeHistory: (id: string): Promise<HistoryEntry[]> =>
    unwrap<HistoryEntry[]>(ipcRenderer.invoke(IPC.HISTORY_REMOVE, id)),
  clearHistory: (): Promise<HistoryEntry[]> =>
    unwrap<HistoryEntry[]>(ipcRenderer.invoke(IPC.HISTORY_CLEAR)),
  onHistoryChanged: (cb: (entry: HistoryEntry) => void): (() => void) => {
    const handler = (_e: unknown, entry: HistoryEntry): void => cb(entry);
    ipcRenderer.on(IPC.HISTORY_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.HISTORY_CHANGED, handler);
  },
  copyText: (text: string): Promise<void> =>
    unwrap<true>(ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text)).then(() => undefined),
  platform: process.platform as 'darwin' | 'win32' | 'linux' | string,
  onSettingsChanged: (cb: (settings: Settings) => void): (() => void) => {
    const handler = (_e: unknown, s: Settings): void => cb(s);
    ipcRenderer.on(IPC.SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, handler);
  }
};

const audioBridge = {
  /** From hidden audio renderer → main: signal that capture is ready. */
  ready: (): void => {
    ipcRenderer.send(IPC.AUDIO_READY);
  },
  /** From hidden audio renderer → main: forward a PCM chunk (ArrayBuffer, Uint8Array, or base64). */
  sendChunk: (data: ArrayBuffer | Uint8Array | string, samples: number, level?: number): void => {
    if (typeof data === 'string') {
      ipcRenderer.send(IPC.AUDIO_CHUNK, { base64: data, data, samples, level });
    } else {
      ipcRenderer.send(IPC.AUDIO_CHUNK, { data, samples, level });
    }
  },
  /** From hidden audio renderer → main: report a capture error. */
  reportError: (message: string): void => {
    ipcRenderer.send(IPC.AUDIO_ERROR, message);
  },
  /** Main → hidden audio renderer: start capture (optionally with deviceId). */
  onStart: (cb: (deviceId?: string) => void): (() => void) => {
    const handler = (_e: unknown, deviceId?: string): void => cb(deviceId);
    ipcRenderer.on(IPC.AUDIO_START_CMD, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_START_CMD, handler);
  },
  /** Main → hidden audio renderer: stop capture. */
  onStop: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.AUDIO_STOP_CMD, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_STOP_CMD, handler);
  },
  /** Main → hidden audio renderer: switch input device. */
  onDeviceChange: (cb: (deviceId: string) => void): (() => void) => {
    const handler = (_e: unknown, deviceId: string): void => cb(deviceId);
    ipcRenderer.on(IPC.AUDIO_DEVICE_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_DEVICE_CHANGE, handler);
  },
  /** Main → hidden audio renderer: suspend AudioContext during idle. */
  onSuspend: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.AUDIO_SUSPEND_CMD, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_SUSPEND_CMD, handler);
  },
  /** Main → hidden audio renderer: resume AudioContext for a new cycle. */
  onResume: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.AUDIO_RESUME_CMD, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_RESUME_CMD, handler);
  },
  /** Main → hidden audio renderer: play a short tone cue. */
  onBeep: (cb: (kind: BeepKind) => void): (() => void) => {
    const handler = (_e: unknown, kind: BeepKind): void => cb(kind);
    ipcRenderer.on(IPC.BEEP_PLAY, handler);
    return () => ipcRenderer.removeListener(IPC.BEEP_PLAY, handler);
  }
};

contextBridge.exposeInMainWorld('windvoice', api);
contextBridge.exposeInMainWorld('audio', audioBridge);
