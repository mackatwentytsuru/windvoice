import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type Settings,
  type DictationStatus,
  type HistoryEntry,
  type OverlayState,
  type BeepKind
} from '../shared/types';

const api = {
  // settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (s: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_SET, s),

  // api key
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(IPC.APIKEY_HAS),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke(IPC.APIKEY_SET, key),

  // dictation control (manual trigger from UI)
  start: (): Promise<void> => ipcRenderer.invoke(IPC.DICTATION_START),
  stop: (): Promise<void> => ipcRenderer.invoke(IPC.DICTATION_STOP),

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
  getLastAudioError: (): Promise<string | null> => ipcRenderer.invoke('audio:lastError'),

  // overlay state subscription (used by overlay window only)
  onOverlayState: (cb: (s: OverlayState) => void): (() => void) => {
    const handler = (_e: unknown, s: OverlayState): void => cb(s);
    ipcRenderer.on(IPC.OVERLAY_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.OVERLAY_STATE, handler);
  },

  // history
  listHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HISTORY_LIST),
  removeHistory: (id: string): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HISTORY_REMOVE, id),
  clearHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HISTORY_CLEAR),
  onHistoryChanged: (cb: (entry: HistoryEntry) => void): (() => void) => {
    const handler = (_e: unknown, entry: HistoryEntry): void => cb(entry);
    ipcRenderer.on(IPC.HISTORY_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.HISTORY_CHANGED, handler);
  },
  copyText: (text: string): void => {
    void ipcRenderer.invoke('clipboard:write', text);
  }
};

const audioBridge = {
  /** From hidden audio renderer → main: signal that capture is ready. */
  ready: (): void => {
    ipcRenderer.send(IPC.AUDIO_READY);
  },
  /** From hidden audio renderer → main: forward a base64-encoded PCM chunk. */
  sendChunk: (base64: string, samples: number, level?: number): void => {
    ipcRenderer.send(IPC.AUDIO_CHUNK, { base64, samples, level });
  },
  /** From hidden audio renderer → main: report a capture error. */
  reportError: (message: string): void => {
    ipcRenderer.send(IPC.AUDIO_ERROR, message);
  },
  /** Main → hidden audio renderer: start capture (optionally with deviceId). */
  onStart: (cb: (deviceId?: string) => void): (() => void) => {
    const handler = (_e: unknown, deviceId?: string): void => cb(deviceId);
    ipcRenderer.on('audio:start', handler);
    return () => ipcRenderer.removeListener('audio:start', handler);
  },
  /** Main → hidden audio renderer: stop capture. */
  onStop: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on('audio:stop', handler);
    return () => ipcRenderer.removeListener('audio:stop', handler);
  },
  /** Main → hidden audio renderer: switch input device. */
  onDeviceChange: (cb: (deviceId: string) => void): (() => void) => {
    const handler = (_e: unknown, deviceId: string): void => cb(deviceId);
    ipcRenderer.on('audio:deviceChange', handler);
    return () => ipcRenderer.removeListener('audio:deviceChange', handler);
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
