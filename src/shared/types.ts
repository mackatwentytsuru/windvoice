import { z } from 'zod';

// ─── Settings ──────────────────────────────────────────────────────────────

export const HotkeyBindingSchema = z.object({
  id: z.string(),
  keys: z.array(z.string()).min(1),
  mode: z.enum(['push-to-talk', 'toggle']),
  format: z.boolean().default(true)
});
export type HotkeyBinding = z.infer<typeof HotkeyBindingSchema>;

export const DictionaryEntrySchema = z.object({
  from: z.string().min(1),
  to: z.string()
});
export type DictionaryEntry = z.infer<typeof DictionaryEntrySchema>;

export const SettingsSchema = z.object({
  hotkeys: z.array(HotkeyBindingSchema).default([
    { id: 'primary', keys: ['RightAlt'], mode: 'push-to-talk', format: true }
  ]),
  audio: z
    .object({
      device: z.string().default('default'),
      inputGain: z.number().min(0).max(4).default(1.0)
    })
    .default({}),
  language: z.string().default('ja'),
  formatter: z
    .object({
      model: z.string().default('gpt-5-mini'),
      customInstructions: z.string().default(''),
      enabled: z.boolean().default(true)
    })
    .default({}),
  dictionary: z.array(DictionaryEntrySchema).default([]),
  insertion: z
    .object({
      method: z.enum(['paste', 'type']).default('paste'),
      restoreClipboard: z.boolean().default(true)
    })
    .default({}),
  ui: z
    .object({
      startMinimized: z.boolean().default(true),
      theme: z.enum(['light', 'dark', 'system']).default('system')
    })
    .default({})
});
export type Settings = z.infer<typeof SettingsSchema>;

// ─── Runtime status ────────────────────────────────────────────────────────

export type DictationStatus = 'idle' | 'listening' | 'processing' | 'error';

// ─── History ───────────────────────────────────────────────────────────────

export const HistoryEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  transcript: z.string(),
  durationMs: z.number().optional(),
  app: z.string().optional()
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const MAX_HISTORY = 200;

// ─── IPC channels ──────────────────────────────────────────────────────────

export const IPC = {
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // api key
  APIKEY_GET: 'apikey:get',
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
  // audio worker (hidden renderer → main)
  AUDIO_CHUNK: 'audio:chunk',
  AUDIO_READY: 'audio:ready',
  AUDIO_ERROR: 'audio:error'
} as const;

// ─── Audio chunk envelope ──────────────────────────────────────────────────

export interface AudioChunk {
  /** base64-encoded 16-bit PCM, 24 kHz, mono */
  base64: string;
  /** sample count in this chunk */
  samples: number;
}
