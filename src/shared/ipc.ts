// Pure-value module: contains only the IPC channel name constants and
// runtime-free types. Imported by `src/preload/index.ts`, which runs in a
// sandboxed renderer and therefore cannot require Node-only deps like zod.
//
// Anything that uses zod (e.g. Settings schema, HistoryEntry schema) lives
// in `src/shared/types.ts` and must NOT be imported from preload.

import type { DictationStatus, HistoryEntry, Settings } from './types';

export const IPC = {
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHANGED: 'settings:changed',
  // api key
  APIKEY_SET: 'apikey:set',
  APIKEY_HAS: 'apikey:has',
  // dictation control
  DICTATION_START: 'dictation:start',
  DICTATION_STOP: 'dictation:stop',
  // history
  HISTORY_LIST: 'history:list',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_REMOVE: 'history:remove',
  HISTORY_CHANGED: 'history:changed',
  // events fired from main → renderer
  STATUS_CHANGED: 'status:changed',
  TRANSCRIPT_DELTA: 'transcript:delta',
  TRANSCRIPT_FINAL: 'transcript:final',
  // audio worker IPC (renderer → main)
  AUDIO_CHUNK: 'audio:chunk',
  AUDIO_READY: 'audio:ready',
  AUDIO_ERROR: 'audio:error',
  // audio worker IPC (main → renderer commands)
  AUDIO_START_CMD: 'audio:start',
  AUDIO_STOP_CMD: 'audio:stop',
  AUDIO_DEVICE_CHANGE: 'audio:deviceChange',
  // Enter/leave idle capture. macOS/Linux suspend the AudioContext; Windows
  // keeps it warm but gates worklet output. Both avoid 20Hz idle IPC churn.
  AUDIO_SUSPEND_CMD: 'audio:suspend',
  AUDIO_RESUME_CMD: 'audio:resume',
  // Tear down and re-acquire the microphone stream. Fired after the OS
  // resumes from sleep (powerMonitor 'resume') or when the active capture
  // track dies — the existing MediaStreamTrack goes silent/ended and must
  // be replaced or the spectrogram + dictation receive only silence.
  AUDIO_RECOVER_CMD: 'audio:recover',
  // overlay / level / beep
  AUDIO_LEVEL: 'audio:level',
  BEEP_PLAY: 'beep:play',
  OVERLAY_STATE: 'overlay:state',
  // utilities
  AUDIO_LAST_ERROR: 'audio:lastError',
  CLIPBOARD_WRITE: 'clipboard:write',
  // formatter / post-process errors that should surface in the UI
  FORMATTER_ERROR: 'formatter:error',
  // misc system errors that the Settings UI should display inline
  // (e.g. autoLaunch refused by the OS, duck failed to restore volume)
  SYSTEM_ERROR: 'system:error',
  // auto-updater (renderer ↔ main)
  UPDATER_CHECK: 'updater:check',
  UPDATER_DOWNLOAD: 'updater:download',
  UPDATER_RESTART: 'updater:restart',
  UPDATER_STATE: 'updater:state',
  UPDATER_LAST_STATE: 'updater:lastState'
} as const;

/**
 * Auto-updater lifecycle state, broadcast from main → renderer on every
 * transition. Defined here (zod-free) so both the preload bridge and the
 * renderer UI can import it without pulling in main-process modules.
 */
export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string };

export interface FormatterErrorPayload {
  code: string;
  message: string;
  /** Whether subsequent dictation will continue with this failure
   * sticky (true → user must update the API key / model to recover). */
  permanent: boolean;
}

export interface SystemErrorPayload {
  // Every `source` main actually sends must be listed here. v0.1.8 shipped
  // with 'storage' (store/history.ts) and 'audio-backpressure' (main/index.ts)
  // missing from this union — the payloads still flowed (the renderer treats
  // source as an opaque label), but the type lied. 'transcription' carries
  // realtime/server-side dictation failures (the v0.1.8 silent-error class).
  source:
    | 'duck'
    | 'autoLaunch'
    | 'updater'
    | 'paste'
    | 'storage'
    | 'audio-backpressure'
    | 'transcription';
  message: string;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export interface OverlayState {
  status: DictationStatus;
  level: number;
}

export type BeepKind = 'start' | 'stop';

export interface AudioChunk {
  /** base64-encoded 16-bit PCM, 24 kHz, mono */
  base64: string;
  /** sample count in this chunk */
  samples: number;
  /** RMS level in [0..1] for the chunk; renderer-computed */
  level?: number;
}

// Re-export for the rare case a consumer wants both via a single import.
export type { DictationStatus, HistoryEntry, Settings };
