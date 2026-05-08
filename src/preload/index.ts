import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type Settings, type DictationStatus, type HistoryEntry } from '../shared/types';

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
  sendChunk: (base64: string, samples: number): void => {
    ipcRenderer.send(IPC.AUDIO_CHUNK, { base64, samples });
  },
  /** From hidden audio renderer → main: report a capture error. */
  reportError: (message: string): void => {
    ipcRenderer.send(IPC.AUDIO_ERROR, message);
  },
  /** Main → hidden audio renderer: start capture. */
  onStart: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on('audio:start', handler);
    return () => ipcRenderer.removeListener('audio:start', handler);
  },
  /** Main → hidden audio renderer: stop capture. */
  onStop: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on('audio:stop', handler);
    return () => ipcRenderer.removeListener('audio:stop', handler);
  }
};

contextBridge.exposeInMainWorld('windvoice', api);
contextBridge.exposeInMainWorld('audio', audioBridge);

declare global {
  interface Window {
    windvoice: typeof api;
    audio: typeof audioBridge;
  }
}
