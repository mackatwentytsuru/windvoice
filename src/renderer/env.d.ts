/// <reference types="vite/client" />

import type {
  Settings,
  DictationStatus,
  HistoryEntry,
  OverlayState,
  BeepKind
} from '../shared/types';
import type {
  ErrorKind,
  ErrorReportPreview,
  ErrorReportSendResult,
  UpdaterState
} from '../shared/ipc';

declare module '*?raw' {
  const content: string;
  export default content;
}

declare global {
  interface Window {
    windvoice: {
      getSettings(): Promise<Settings>;
      setSettings(s: Partial<Settings>): Promise<Settings>;
      hasApiKey(): Promise<boolean>;
      setApiKey(key: string): Promise<void>;
      start(): Promise<void>;
      stop(): Promise<void>;
      quit(): Promise<void>;
      platform: 'darwin' | 'win32' | 'linux' | string;
      sessionType: 'wayland' | 'x11' | 'other';
      onStatus(cb: (s: DictationStatus) => void): () => void;
      onTranscriptDelta(cb: (text: string) => void): () => void;
      onTranscriptFinal(cb: (text: string) => void): () => void;
      onAudioError(cb: (msg: string) => void): () => void;
      onSystemError(cb: (payload: { source: string; message: string; kind: ErrorKind }) => void): () => void;
      onFormatterError(
        cb: (payload: { code: string; message: string; permanent: boolean; kind: ErrorKind }) => void
      ): () => void;
      getLastAudioError(): Promise<string | null>;
      onOverlayState(cb: (s: OverlayState) => void): () => void;
      listHistory(): Promise<HistoryEntry[]>;
      removeHistory(id: string): Promise<HistoryEntry[]>;
      clearHistory(): Promise<HistoryEntry[]>;
      onHistoryChanged(cb: (entry: HistoryEntry) => void): () => void;
      copyText(text: string): Promise<void>;
      onSettingsChanged(cb: (s: Settings) => void): () => void;
      checkForUpdate(): Promise<UpdaterState>;
      downloadUpdate(): Promise<UpdaterState>;
      restartToUpdate(): Promise<{ deferred: boolean }>;
      getUpdaterState(): Promise<UpdaterState>;
      onUpdaterState(cb: (s: UpdaterState) => void): () => void;
      getErrorReportPreview(): Promise<ErrorReportPreview | null>;
      sendErrorReport(): Promise<ErrorReportSendResult>;
      discardErrorReport(disableReporting: boolean): Promise<ErrorReportPreview | null>;
      onErrorReportPending(cb: (preview: ErrorReportPreview | null) => void): () => void;
    };
    audio: {
      ready(): void;
      sendChunk(base64: string, samples: number, level?: number): void;
      reportError(message: string): void;
      onStart(cb: (deviceId?: string) => void): () => void;
      onStop(cb: () => void): () => void;
      onDeviceChange(cb: (deviceId: string) => void): () => void;
      onSuspend?(cb: () => void): () => void;
      onResume?(cb: () => void): () => void;
      onRecover?(cb: (resumeAfterRebuild: boolean) => void): () => void;
      onBeep(cb: (kind: BeepKind) => void): () => void;
    };
  }
}

export {};
