import { z } from 'zod';

// ─── Settings ──────────────────────────────────────────────────────────────

export const HotkeyBindingSchema = z.object({
  id: z.string(),
  keys: z.array(z.string()).min(1),
  mode: z.enum(['push-to-talk', 'toggle']),
  format: z.boolean().default(true)
});
export type HotkeyBinding = z.infer<typeof HotkeyBindingSchema>;

// Default hotkey is RightCtrl on every platform.
//
// - macOS: RightAlt (Option) is reserved for diacritic input.
// - Windows: RightAlt activates the Alt menu-mode in apps like Notepad.
//   Even after release, menu-mode lingers briefly and can swallow the
//   synthesized Ctrl+V as a menu access key. RightCtrl avoids this and
//   tested clean in Notepad / Windows Terminal / ChatGPT / VS Code.
export function defaultHotkey(): string {
  return 'RightCtrl';
}

export function defaultHotkeyBindings(): HotkeyBinding[] {
  return [{ id: 'primary', keys: [defaultHotkey()], mode: 'push-to-talk', format: true }];
}

export const DictionaryEntrySchema = z.object({
  from: z.string().min(1),
  to: z.string()
});
export type DictionaryEntry = z.infer<typeof DictionaryEntrySchema>;

export const ReplacementEntrySchema = z.object({
  trigger: z.string().min(1),
  expansion: z.string(),
  /** When true, match only at word boundaries (default true). */
  wordBoundary: z.boolean().default(true)
});
export type ReplacementEntry = z.infer<typeof ReplacementEntrySchema>;

export const SettingsSchema = z.object({
  // `.min(1)` makes "no hotkeys configured" an invalid state at the
  // schema boundary (L2). An empty array would leave the orchestrator
  // unable to fire any binding — defaultHotkeyBindings() guarantees at
  // least the primary RightCtrl entry.
  hotkeys: z
    .array(HotkeyBindingSchema)
    .min(1)
    .catch(() => defaultHotkeyBindings())
    .default(() => defaultHotkeyBindings()),
  replacements: z.array(ReplacementEntrySchema).default([]),
  audio: z
    .object({
      device: z.string().default('default')
      // inputGain was scaffolded as `z.number().min(0).max(4)` but never
      // wired into the AudioWorklet pipeline (#16). OS-level microphone
      // gain (System Settings → Sound → Input on macOS, Privacy &
      // Security → Microphone on Windows) is the right surface; the
      // field is removed here to stop suggesting a behavior the app
      // didn't have. Existing settings files with `inputGain` parse
      // fine — Zod ignores unknown properties unless `.strict()`.
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
      // 'paste' is the only implemented insertion method. The 'type'
      // option was a UI surface with no main-process handler (issue #6);
      // the enum is kept as a single-member literal so existing
      // settings files with `method: "type"` still parse via `.catch`
      // below, rather than failing schema validation.
      method: z
        .enum(['paste'])
        .catch('paste')
        .default('paste'),
      restoreClipboard: z.boolean().default(true),
      /** When true, paste partial transcripts during recording instead of waiting for the final. */
      streaming: z.boolean().default(false),
      /**
       * Paste timing profile. Controls how long WindVoice waits for the
       * target app to consume the synthesized Ctrl/Cmd+V before restoring
       * the user's original clipboard. 'fast' is lowest-latency but can
       * race on slow targets (terminals, RDP/VM, busy apps) and paste the
       * previously-copied content instead; 'safe' maximizes reliability.
       */
      pasteCompatibility: z.enum(['fast', 'balanced', 'safe']).catch('balanced').default('balanced'),
      /**
       * Windows only: keep WindVoice's clipboard writes out of the Win+V
       * clipboard history, so dictations don't flood the user's history.
       * No-op on macOS / Linux.
       */
      excludeFromClipboardHistory: z.boolean().default(true)
    })
    .default({}),
  ui: z
    .object({
      startMinimized: z.boolean().default(true),
      theme: z.enum(['light', 'dark', 'system']).default('system'),
      uiLanguage: z.enum(['ja', 'en']).default('ja'),
      overlayEnabled: z.boolean().default(true),
      soundCuesEnabled: z.boolean().default(true),
      duckOtherAudio: z.boolean().default(true),
      duckLevel: z.number().min(0).max(1).default(0.3),
      /** Launch WindVoice automatically when the OS starts. */
      autoLaunch: z.boolean().default(false),
      /** Auto-check + auto-download GitHub releases on startup. */
      autoUpdate: z.boolean().default(true)
    })
    .default({})
});
export type Settings = z.infer<typeof SettingsSchema>;

// ─── Runtime status ────────────────────────────────────────────────────────

// 'connecting': realtime WS handshake in progress (after start, before
//   the first audio chunk lands). Replaces the gap where the tray would
//   stay on 'idle' until 'listening' suddenly jumped in.
// 'unavailable': a permanent precondition is missing (no API key, no
//   Accessibility permission, secure-store unavailable). Distinct from
//   'error' which signals a transient runtime failure.
export type DictationStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'error'
  | 'unavailable';

// ─── History ───────────────────────────────────────────────────────────────

export const HistoryEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  transcript: z.string(),
  durationMs: z.number().optional(),
  app: z.string().optional()
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// Re-export the IPC channel constants and runtime-free types so existing
// `@shared/types` imports keep working. Preload must use `@shared/ipc`
// directly because importing `@shared/types` pulls in zod, which is
// externalized and therefore unavailable in a sandboxed renderer.
export { IPC, type AudioInputDevice, type AudioChunk, type OverlayState, type BeepKind } from './ipc';

// ─── IPC channels ──────────────────────────────────────────────────────────


