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

/**
 * Hard cap on per-profile formatter `instructions`. Instructions flow
 * verbatim into the LLM system prompt (they are user-typed and inside
 * the trust boundary — see the MEDIUM-2 note in postprocess/formatter.ts),
 * but WITHOUT a length cap a settings file synced or imported from
 * elsewhere could smuggle an arbitrarily large prompt-injection payload.
 * 2000 chars is far above any realistic hand-typed instruction set.
 * Enforced both here (settings boundary) and at use (formatter.ts).
 */
export const APP_PROFILE_INSTRUCTIONS_MAX = 2000;

/**
 * Per-application formatter profile. When the foreground app's name
 * contains `match` as a case-insensitive WHOLE WORD (both sides are
 * normalized: lowercased, trailing `.exe` stripped — so "code" matches
 * "Visual Studio Code" and "Code.exe" but not "decode"), `instructions`
 * are appended to the formatter prompt — e.g. "terse, no markdown" for a
 * terminal, "casual tone" for a chat app. Matching lives in
 * postprocess/formatter.ts (`matchAppProfile`).
 */
export const AppProfileSchema = z.object({
  match: z.string().min(1),
  // Clamp (not reject) over-long instructions: a `.max()` would make the
  // whole settings file fail safeParse in store/settings.ts, which resets
  // EVERY setting to defaults — losing the user's hotkeys and dictionary
  // over one oversized field would be far worse than truncating it.
  instructions: z
    .string()
    .transform((s) =>
      s.length > APP_PROFILE_INSTRUCTIONS_MAX ? s.slice(0, APP_PROFILE_INSTRUCTIONS_MAX) : s
    )
});
export type AppProfile = z.infer<typeof AppProfileSchema>;

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
      // MEDIUM: every nested scalar carries its own `.catch(default)` so a
      // single corrupted/out-of-range persisted field falls back to its own
      // default instead of failing the whole-object safeParse in
      // store/settings.ts — which would reset EVERY setting (hotkeys,
      // dictionary, replacements) to defaults over one bad value.
      device: z.string().catch('default').default('default')
      // inputGain was scaffolded as `z.number().min(0).max(4)` but never
      // wired into the AudioWorklet pipeline (#16). OS-level microphone
      // gain (System Settings → Sound → Input on macOS, Privacy &
      // Security → Microphone on Windows) is the right surface; the
      // field is removed here to stop suggesting a behavior the app
      // didn't have. Existing settings files with `inputGain` parse
      // fine — Zod ignores unknown properties unless `.strict()`.
    })
    .default({}),
  language: z.string().catch('ja').default('ja'),
  formatter: z
    .object({
      model: z.string().catch('gpt-5-mini').default('gpt-5-mini'),
      customInstructions: z.string().catch('').default(''),
      enabled: z.boolean().catch(true).default(true),
      /** Per-app formatter profiles, matched against the foreground app name. */
      appProfiles: z.array(AppProfileSchema).default([])
    })
    .default({}),
  dictionary: z.array(DictionaryEntrySchema).default([]),
  insertion: z
    .object({
      // 'paste' = clipboard + Ctrl/Cmd+V (default, all platforms).
      // 'type'  = synthesize the text as individual keystrokes, for apps
      //           that mangle or refuse a paste. Implemented on Windows
      //           via the `sendinput` Unicode path; on macOS / Linux it
      //           transparently falls back to 'paste'.
      method: z
        .enum(['paste', 'type'])
        .catch('paste')
        .default('paste'),
      restoreClipboard: z.boolean().catch(true).default(true),
      /** When true, paste partial transcripts during recording instead of waiting for the final. */
      streaming: z.boolean().catch(false).default(false),
      /**
       * Paste timing profile. Controls clipboard restore timing and the
       * Linux Wayland virtual-key event gap. 'fast' is lowest-latency but can
       * race on slow targets (terminals, RDP/VM, busy apps); 'safe' maximizes
       * reliability.
       */
      pasteCompatibility: z.enum(['fast', 'balanced', 'safe']).catch('balanced').default('balanced'),
      /**
       * Windows only: keep WindVoice's clipboard writes out of the Win+V
       * clipboard history, so dictations don't flood the user's history.
       * No-op on macOS / Linux.
       */
      excludeFromClipboardHistory: z.boolean().catch(true).default(true)
    })
    .default({}),
  ui: z
    .object({
      startMinimized: z.boolean().catch(true).default(true),
      theme: z.enum(['light', 'dark', 'system']).catch('system').default('system'),
      uiLanguage: z.enum(['ja', 'en']).catch('ja').default('ja'),
      overlayEnabled: z.boolean().catch(true).default(true),
      soundCuesEnabled: z.boolean().catch(true).default(true),
      duckOtherAudio: z.boolean().catch(true).default(true),
      duckLevel: z.number().min(0).max(1).catch(0.3).default(0.3),
      /** Launch WindVoice automatically when the OS starts. */
      autoLaunch: z.boolean().catch(false).default(false),
      /** Check GitHub releases on startup and periodically; never auto-download. */
      autoUpdate: z.boolean().catch(true).default(true),
      /** Last versions notified for each stage, persisted across restarts. */
      notifiedUpdateVersion: z.string().catch('').default(''),
      notifiedDownloadedVersion: z.string().catch('').default(''),
      /** Opt-in local JSONL transcript pairs for future dictionary learning. */
      transcriptLogging: z.boolean().catch(false).default(false),
      /**
       * Opt-in only. Reports remain local previews until the user explicitly
       * sends or discards them.
       */
      errorReporting: z.boolean().catch(false).default(false),
      errorReportingConsent: z
        .enum(['undecided', 'enabled', 'disabled'])
        .catch('undecided')
        .default('undecided'),
      errorReportingPrompted: z.boolean().catch(false).default(false)
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
