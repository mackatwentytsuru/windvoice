// Shared helper for broadcasting IPC events to UI windows only.
//
// The hidden audio renderer has no business receiving UI-state events
// (SETTINGS_CHANGED, SYSTEM_ERROR, ...). Filtering it out at every
// emitter would require each caller to know about the audio renderer.
// Centralize the rule here and let each subsystem register the audio
// renderer's webContents id once at startup.

import { BrowserWindow } from 'electron';
import { reportError } from '@main/report/githubReporter';
import { scrubSecrets } from '@main/debug';
import { IPC } from '@shared/ipc';

let audioWebContentsId: number | null = null;

/**
 * Register (or clear) the hidden audio renderer's webContents id. Called
 * from main/index.ts once AudioBridge is up; cleared when the bridge is
 * destroyed.
 */
export function setAudioWebContentsId(id: number | null): void {
  audioWebContentsId = id;
}

/**
 * Send `payload` on `channel` to every BrowserWindow that is a UI window,
 * skipping the hidden audio renderer. If the audio id has not been
 * registered yet, fall back to broadcasting to all windows (the audio
 * renderer simply ignores channels it has not subscribed to).
 */
export function broadcastToUiWindows(channel: string, payload: unknown): void {
  let safePayload = payload;
  if (
    typeof payload === 'string' &&
    (channel === IPC.AUDIO_ERROR ||
      channel === IPC.SYSTEM_ERROR ||
      channel === IPC.FORMATTER_ERROR ||
      (channel === IPC.TRANSCRIPT_FINAL && payload.startsWith('[error]')))
  ) {
    safePayload = scrubSecrets(payload);
  }
  // Single choke point for user-visible errors: everything surfaced as a
  // SYSTEM_ERROR / FORMATTER_ERROR banner is also queued for the automatic
  // GitHub issue reporter (deduplicated + scrubbed there; fire-and-forget).
  if (channel === IPC.SYSTEM_ERROR || channel === IPC.FORMATTER_ERROR) {
    const p = payload as { source?: unknown; code?: unknown; message?: unknown };
    const source =
      typeof p?.source === 'string'
        ? p.source
        : typeof p?.code === 'string'
          ? `formatter:${p.code}`
          : 'formatter';
    if (typeof p?.message === 'string') {
      const message = scrubSecrets(p.message);
      safePayload = { ...p, message };
      reportError(source, message);
    }
  }
  const skip = audioWebContentsId;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      const wc = win.webContents;
      if (wc.isDestroyed()) continue;
      if (skip !== null && wc.id === skip) continue;
      wc.send(channel, safePayload);
    } catch {
      // A window may be destroyed between enumeration and send. UI broadcast
      // is best-effort and must never crash the Electron main process.
    }
  }
}
