// Shared helper for broadcasting IPC events to UI windows only.
//
// The hidden audio renderer has no business receiving UI-state events
// (SETTINGS_CHANGED, SYSTEM_ERROR, ...). Filtering it out at every
// emitter would require each caller to know about the audio renderer.
// Centralize the rule here and let each subsystem register the audio
// renderer's webContents id once at startup.

import { BrowserWindow, type WebContents } from 'electron';
import { reportError } from '@main/report/githubReporter';
import { scrubSecrets } from '@main/debug';
import { IPC } from '@shared/ipc';

let audioWebContentsId: number | null = null;
const stickySetupErrors = new Map<string, unknown>();

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
  // Single choke point for user-visible errors. Only explicitly classified
  // bugs become local report previews. External transmission still requires
  // the user's Send action in Settings.
  if (channel === IPC.SYSTEM_ERROR || channel === IPC.FORMATTER_ERROR) {
    const p = payload as {
      source?: unknown;
      code?: unknown;
      message?: unknown;
      kind?: unknown;
    };
    if (typeof p?.message === 'string') {
      safePayload = { ...p, message: scrubSecrets(p.message) };
    }
    // Setup guidance is sticky so it survives a closed Settings window.
    // Transient conditions remain visible but are neither sticky nor
    // reportable. Unknown/missing classifications fail closed as transient.
    if (channel === IPC.SYSTEM_ERROR && p?.kind === 'setup') {
      const source = typeof p.source === 'string' ? p.source : 'setup';
      stickySetupErrors.set(source, safePayload);
      broadcastOnly(channel, safePayload);
      return;
    }
    const source =
      typeof p?.source === 'string'
        ? p.source
        : typeof p?.code === 'string'
          ? `formatter:${p.code}`
          : 'formatter';
    if (p?.kind === 'bug' && typeof p?.message === 'string') {
      const message = scrubSecrets(p.message);
      reportError(source, message, 'bug');
    }
  }
  broadcastOnly(channel, safePayload);
}

/** Clear one recovered setup error, or all sticky errors in tests/teardown. */
export function clearStickySetupError(source?: string): void {
  if (source === undefined) stickySetupErrors.clear();
  else stickySetupErrors.delete(source);
}

/** Replay setup guidance after a Settings renderer has installed IPC listeners. */
export function replayStickySetupErrors(target: Pick<WebContents, 'send'>): void {
  for (const payload of stickySetupErrors.values()) {
    target.send(IPC.SYSTEM_ERROR, payload);
  }
}

function broadcastOnly(channel: string, payload: unknown): void {
  const skip = audioWebContentsId;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      const wc = win.webContents;
      if (wc.isDestroyed()) continue;
      if (skip !== null && wc.id === skip) continue;
      wc.send(channel, payload);
    } catch {
      // A window may be destroyed between enumeration and send. UI broadcast
      // is best-effort and must never crash the Electron main process.
    }
  }
}
