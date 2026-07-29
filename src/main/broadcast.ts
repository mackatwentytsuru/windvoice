// Shared helper for broadcasting IPC events to UI windows only.
//
// The hidden audio renderer has no business receiving UI-state events
// (SETTINGS_CHANGED, SYSTEM_ERROR, ...). Filtering it out at every
// emitter would require each caller to know about the audio renderer.
// Centralize the rule here and let each subsystem register the audio
// renderer's webContents id once at startup.

import { BrowserWindow, type WebContents } from 'electron';
import { reportError } from '@main/report/githubReporter';
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
  // Single choke point for user-visible errors: everything surfaced as a
  // Only explicitly classified bugs become local report previews. External
  // transmission still requires the user's Send action in Settings.
  if (channel === IPC.SYSTEM_ERROR || channel === IPC.FORMATTER_ERROR) {
    const p = payload as {
      source?: unknown;
      code?: unknown;
      message?: unknown;
      kind?: unknown;
    };
    // Setup guidance is sticky so it survives a closed Settings window.
    // Transient conditions remain visible but are neither sticky nor
    // reportable. Unknown/missing classifications fail closed as transient.
    if (channel === IPC.SYSTEM_ERROR && p?.kind === 'setup') {
      const source = typeof p.source === 'string' ? p.source : 'setup';
      stickySetupErrors.set(source, payload);
      broadcastOnly(channel, payload);
      return;
    }
    const source =
      typeof p?.source === 'string'
        ? p.source
        : typeof p?.code === 'string'
          ? `formatter:${p.code}`
          : 'formatter';
    if (p?.kind === 'bug' && typeof p?.message === 'string') {
      reportError(source, p.message, 'bug');
    }
  }
  broadcastOnly(channel, payload);
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
    if (skip !== null && win.webContents.id === skip) continue;
    win.webContents.send(channel, payload);
  }
}
