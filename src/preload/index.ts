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
  type BeepKind,
  type UpdaterState,
  type ErrorKind,
  type ErrorReportPreview,
  type ErrorReportSendResult
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

// ── Lightweight runtime guards for inbound IPC payloads (issue #32). ──────
// zod is unavailable here (preload runs sandboxed without zod resolution),
// so we use inline `typeof` / membership checks. On mismatch we log to the
// renderer console and DROP the event rather than forward garbage upstream.

const DICTATION_STATUS_VALUES: ReadonlySet<DictationStatus> = new Set<DictationStatus>([
  'idle',
  'connecting',
  'listening',
  'processing',
  'error',
  'unavailable'
]);

function isDictationStatus(v: unknown): v is DictationStatus {
  return typeof v === 'string' && DICTATION_STATUS_VALUES.has(v as DictationStatus);
}

const BEEP_KIND_VALUES: ReadonlySet<BeepKind> = new Set<BeepKind>(['start', 'stop']);

function isBeepKind(v: unknown): v is BeepKind {
  return typeof v === 'string' && BEEP_KIND_VALUES.has(v as BeepKind);
}

function isOverlayState(v: unknown): v is OverlayState {
  if (!v || typeof v !== 'object') return false;
  const o = v as { status?: unknown; level?: unknown };
  return isDictationStatus(o.status) && typeof o.level === 'number';
}

const UPDATER_PHASES: ReadonlySet<string> = new Set([
  'idle',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'error'
]);

function isUpdaterState(v: unknown): v is UpdaterState {
  if (!v || typeof v !== 'object') return false;
  return UPDATER_PHASES.has((v as { phase?: unknown }).phase as string);
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as { id?: unknown; timestamp?: unknown; transcript?: unknown };
  return (
    typeof o.id === 'string' &&
    typeof o.timestamp === 'number' &&
    typeof o.transcript === 'string'
  );
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
  quit: (): Promise<void> =>
    unwrap<true>(ipcRenderer.invoke(IPC.APP_QUIT)).then(() => undefined),

  // status / transcript subscriptions
  onStatus: (cb: (status: DictationStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: unknown): void => {
      if (!isDictationStatus(s)) {
        console.error('[preload] dropped STATUS_CHANGED with invalid payload', s);
        return;
      }
      cb(s);
    };
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
  onSystemError: (cb: (payload: { source: string; message: string; kind: ErrorKind }) => void): (() => void) => {
    const handler = (_e: unknown, p: { source: string; message: string; kind: ErrorKind }): void => cb(p);
    ipcRenderer.on(IPC.SYSTEM_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.SYSTEM_ERROR, handler);
  },
  onFormatterError: (cb: (payload: { code: string; message: string; permanent: boolean; kind: ErrorKind }) => void): (() => void) => {
    const handler = (_e: unknown, p: { code: string; message: string; permanent: boolean; kind: ErrorKind }): void => cb(p);
    ipcRenderer.on(IPC.FORMATTER_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.FORMATTER_ERROR, handler);
  },
  getLastAudioError: (): Promise<string | null> => ipcRenderer.invoke(IPC.AUDIO_LAST_ERROR),

  // overlay state subscription (used by overlay window only)
  onOverlayState: (cb: (s: OverlayState) => void): (() => void) => {
    const handler = (_e: unknown, s: unknown): void => {
      if (!isOverlayState(s)) {
        console.error('[preload] dropped OVERLAY_STATE with invalid payload', s);
        return;
      }
      cb(s);
    };
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
    const handler = (_e: unknown, entry: unknown): void => {
      if (!isHistoryEntry(entry)) {
        console.error('[preload] dropped HISTORY_CHANGED with invalid payload', entry);
        return;
      }
      cb(entry);
    };
    ipcRenderer.on(IPC.HISTORY_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.HISTORY_CHANGED, handler);
  },
  copyText: (text: string): Promise<void> =>
    unwrap<true>(ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text)).then(() => undefined),
  platform: process.platform as 'darwin' | 'win32' | 'linux' | string,
  sessionType:
    process.platform === 'linux'
      ? process.env['WINDVOICE_FORCE_X11'] === '1'
        ? 'x11'
        : process.env['WAYLAND_DISPLAY'] ||
            process.env['XDG_SESSION_TYPE'] === 'wayland'
          ? 'wayland'
          : 'x11'
      : 'other',
  onSettingsChanged: (cb: (settings: Settings) => void): (() => void) => {
    const handler = (_e: unknown, s: Settings): void => cb(s);
    ipcRenderer.on(IPC.SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, handler);
  },

  // auto-updater. check/download/restart are gated to the trusted settings
  // window in main; they resolve to the latest UpdaterState (or a refusal
  // object, which the trusted settings window never triggers).
  checkForUpdate: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC.UPDATER_CHECK),
  downloadUpdate: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD),
  restartToUpdate: (): Promise<{ deferred: boolean }> =>
    ipcRenderer.invoke(IPC.UPDATER_RESTART),
  getUpdaterState: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC.UPDATER_LAST_STATE),
  onUpdaterState: (cb: (s: UpdaterState) => void): (() => void) => {
    const handler = (_e: unknown, s: unknown): void => {
      if (!isUpdaterState(s)) {
        console.error('[preload] dropped UPDATER_STATE with invalid payload', s);
        return;
      }
      cb(s);
    };
    ipcRenderer.on(IPC.UPDATER_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATER_STATE, handler);
  },

  // Error reports remain local until these trusted Settings-window actions.
  getErrorReportPreview: (): Promise<ErrorReportPreview | null> =>
    ipcRenderer.invoke(IPC.ERROR_REPORT_PREVIEW),
  sendErrorReport: (): Promise<ErrorReportSendResult> =>
    ipcRenderer.invoke(IPC.ERROR_REPORT_SEND),
  discardErrorReport: (disableReporting: boolean): Promise<ErrorReportPreview | null> =>
    ipcRenderer.invoke(IPC.ERROR_REPORT_DISCARD, disableReporting),
  onErrorReportPending: (cb: (preview: ErrorReportPreview | null) => void): (() => void) => {
    const handler = (_e: unknown, preview: ErrorReportPreview | null): void => cb(preview);
    ipcRenderer.on(IPC.ERROR_REPORT_PENDING, handler);
    return () => ipcRenderer.removeListener(IPC.ERROR_REPORT_PENDING, handler);
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
      ipcRenderer.send(IPC.AUDIO_CHUNK, { base64: data, samples, level });
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
  /**
   * Main → hidden audio renderer: rebuild the capture stream after sleep/resume.
   * `resumeAfterRebuild` is true when the rebuild fires during an active
   * dictation, telling the renderer to resume the freshly built (and otherwise
   * idle-suspended) AudioContext so THIS dictation still captures audio.
   */
  onRecover: (cb: (resumeAfterRebuild: boolean) => void): (() => void) => {
    const handler = (_e: unknown, resumeAfterRebuild?: unknown): void =>
      cb(resumeAfterRebuild === true);
    ipcRenderer.on(IPC.AUDIO_RECOVER_CMD, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_RECOVER_CMD, handler);
  },
  /** Main → hidden audio renderer: play a short tone cue. */
  onBeep: (cb: (kind: BeepKind) => void): (() => void) => {
    const handler = (_e: unknown, kind: unknown): void => {
      if (!isBeepKind(kind)) {
        console.error('[preload] dropped BEEP_PLAY with invalid payload', kind);
        return;
      }
      cb(kind);
    };
    ipcRenderer.on(IPC.BEEP_PLAY, handler);
    return () => ipcRenderer.removeListener(IPC.BEEP_PLAY, handler);
  }
};

contextBridge.exposeInMainWorld('windvoice', api);
contextBridge.exposeInMainWorld('audio', audioBridge);
