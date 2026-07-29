// Platform-routing façade for the synthesized paste keystroke.
//
// win32 / darwin / Linux-X11 → sendCtrlVAtomic (SendInput / uIOhook.keyTap,
// synchronous). Linux-Wayland → RemoteDesktop portal (async D-Bus round
// trip); if the portal is unavailable we still attempt the XTest path,
// which reaches XWayland-hosted apps — strictly better than dropping the
// paste on the floor.

import { debug } from '@main/debug';
import { sendCtrlVAtomic } from '@main/inject/pasteWin32';
import { isWaylandSession } from '@main/linux/wayland';
import { portalRemoteDesktop } from '@main/linux/portalRemoteDesktop';

/**
 * Synthesize the paste chord (Ctrl+V / Cmd+V) for the current platform.
 * Rejects only when every available injection path failed — callers treat a
 * rejection exactly like the old synchronous throw from sendCtrlVAtomic.
 */
export async function sendPasteKeystroke(): Promise<void> {
  if (isWaylandSession()) {
    try {
      await portalRemoteDesktop.pasteCtrlV();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `portal paste failed, falling back to XTest: ${msg}`);
      // XTest fallback below reaches XWayland windows only. If the user
      // denied the portal there is no full-coverage path — surface the
      // portal's message when XTest also throws.
      try {
        sendCtrlVAtomic();
        return;
      } catch {
        throw err instanceof Error ? err : new Error(msg);
      }
    }
  }
  sendCtrlVAtomic();
}
