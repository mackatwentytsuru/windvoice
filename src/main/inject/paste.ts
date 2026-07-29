// Platform-routing façade for the synthesized paste keystroke.
//
// win32 / darwin / Linux-X11 → sendCtrlVAtomic (SendInput / uIOhook.keyTap,
// synchronous). Linux-Wayland → the portal sidecar's virtual keyboard.
//
// NOTE: on Wayland the preferred path is portalSidecar.pasteText(), which
// the typer calls directly — it claims the selection AND injects in one
// sequence. This helper is the keystroke-only fallback used when that
// path is unavailable; if the sidecar is down too, XTest at least reaches
// XWayland-hosted windows.

import { debug } from '@main/debug';
import { sendCtrlVAtomic } from '@main/inject/pasteWin32';
import { isWaylandSession } from '@main/linux/wayland';
import { portalSidecar } from '@main/linux/portalSidecar';

/**
 * Synthesize the paste chord (Ctrl+V / Cmd+V) for the current platform.
 * Rejects only when every available injection path failed — callers treat a
 * rejection exactly like the old synchronous throw from sendCtrlVAtomic.
 */
export async function sendPasteKeystroke(): Promise<void> {
  if (isWaylandSession() && portalSidecar.isReady()) {
    const result = await portalSidecar.keyPaste();
    if (result.ok) return;
    if (result.uncertain) {
      // The child is recycled by PortalSidecar on timeout/exit. Do not add
      // an XTest injection while the first Ctrl+V may already have landed.
      throw new Error(result.error ?? 'Wayland portal key injection outcome is unknown');
    }
    debug('DICTATION', 'portal key injection failed, falling back to XTest');
    // XTest below reaches XWayland windows only — better than nothing.
  }
  sendCtrlVAtomic();
}
