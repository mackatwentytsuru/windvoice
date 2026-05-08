/// <reference types="vite/client" />

import type { Settings, DictationStatus, HistoryEntry } from '../shared/types';

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
      onStatus(cb: (s: DictationStatus) => void): () => void;
      onTranscriptDelta(cb: (text: string) => void): () => void;
      onTranscriptFinal(cb: (text: string) => void): () => void;
      onAudioError(cb: (msg: string) => void): () => void;
      getLastAudioError(): Promise<string | null>;
      listHistory(): Promise<HistoryEntry[]>;
      removeHistory(id: string): Promise<HistoryEntry[]>;
      clearHistory(): Promise<HistoryEntry[]>;
      onHistoryChanged(cb: (entry: HistoryEntry) => void): () => void;
      copyText(text: string): void;
    };
    audio: {
      ready(): void;
      sendChunk(base64: string, samples: number): void;
      reportError(message: string): void;
      onStart(cb: () => void): () => void;
      onStop(cb: () => void): () => void;
    };
  }
}

export {};
