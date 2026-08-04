// Clipboard-paste timing profiles.
//
// Pasting works by writing the transcript to the clipboard, synthesizing
// Ctrl/Cmd+V, then restoring the user's original clipboard. The restore
// MUST happen only after the target app has actually consumed the paste —
// otherwise the app reads the already-restored old clipboard and the user
// sees "the thing I copied before" pasted instead of the transcript.
//
// Most platforms expose no signal for "paste consumed", so restore delays
// are a compatibility margin. The Wayland portal path is the exception: its
// sidecar observes a completed SelectionTransfer and refuses to restore an
// unread transcript. The profile delay there is only a small post-transfer
// margin, not the success criterion.

import { isWaylandSession } from '@main/linux/wayland';

export type PasteCompatibility = 'fast' | 'balanced' | 'safe';

export interface PasteTiming {
  /** Wait after clipboard.writeText() before synthesizing Ctrl/Cmd+V, so
   *  the new text has propagated through the OS clipboard chain. */
  settleMs: number;
  /** Wait after Ctrl/Cmd+V before restoring the original clipboard, so a
   *  slow target finishes reading the transcript first. */
  restoreDelayMs: number;
  /** Streaming: settle wait per chunk. */
  streamSettleMs: number;
  /** Streaming: gap between consecutive chunk pastes. */
  streamIntervalMs: number;
  /** Streaming: wait after the final chunk before restoring the clipboard. */
  streamRestoreDelayMs: number;
  /** Wayland portal: gap between synthesized key events. */
  keyEventDelayMs: number;
  /** Wayland portal: slower gap used by verified fallback attempts. */
  retryKeyEventDelayMs: number;
}

const PROFILES: Record<PasteCompatibility, PasteTiming> = {
  // Lowest latency. Matches the pre-existing aggressive constants; fine for
  // fast native text fields but races on slow targets.
  fast: {
    settleMs: 10,
    restoreDelayMs: 60,
    streamSettleMs: 12,
    streamIntervalMs: 60,
    streamRestoreDelayMs: 80,
    keyEventDelayMs: 12,
    retryKeyEventDelayMs: 40
  },
  // Default. Restores the safer margin that existed before the constants
  // were tuned down without live timing data — eliminates the stale-paste
  // race for the large majority of apps at a barely perceptible cost.
  balanced: {
    settleMs: 25,
    restoreDelayMs: 180,
    streamSettleMs: 25,
    streamIntervalMs: 110,
    streamRestoreDelayMs: 220,
    keyEventDelayMs: 20,
    retryKeyEventDelayMs: 60
  },
  // Maximum compatibility for terminals, remote-desktop / VM sessions and
  // other high-latency targets where 'balanced' still drops the paste.
  safe: {
    settleMs: 60,
    restoreDelayMs: 400,
    streamSettleMs: 55,
    streamIntervalMs: 200,
    streamRestoreDelayMs: 450,
    keyEventDelayMs: 30,
    retryKeyEventDelayMs: 90
  }
};

/**
 * Wayland floor values, applied on top of whichever profile is selected.
 *
 * On Wayland the paste chain is much longer than a native XTest/SendInput
 * path: NotifyKeyboardKeycode → D-Bus → compositor virtual keyboard →
 * focused client processes the key event → client asynchronously requests
 * the clipboard from its owner (us), possibly bridged through XWayland's
 * selection sync when owner and target live on different display protocols.
 * The sidecar now observes SelectionTransfer completion before restore, so
 * only pre-dispatch propagation and inter-chunk pacing need Wayland floors.
 * The old 1500ms restore floor was a blind timing guess and kept dictation
 * artificially active after delivery; retaining it would also obscure a
 * target that never requested the selection at all.
 */
const WAYLAND_MIN: PasteTiming = {
  settleMs: 60,
  restoreDelayMs: 0,
  streamSettleMs: 50,
  streamIntervalMs: 150,
  streamRestoreDelayMs: 0,
  keyEventDelayMs: 0,
  retryKeyEventDelayMs: 0
};

export function pasteTiming(profile: PasteCompatibility | undefined): PasteTiming {
  const base = (profile && PROFILES[profile]) || PROFILES.balanced;
  if (!isWaylandSession()) return base;
  return {
    settleMs: Math.max(base.settleMs, WAYLAND_MIN.settleMs),
    restoreDelayMs: Math.max(base.restoreDelayMs, WAYLAND_MIN.restoreDelayMs),
    streamSettleMs: Math.max(base.streamSettleMs, WAYLAND_MIN.streamSettleMs),
    streamIntervalMs: Math.max(base.streamIntervalMs, WAYLAND_MIN.streamIntervalMs),
    streamRestoreDelayMs: Math.max(base.streamRestoreDelayMs, WAYLAND_MIN.streamRestoreDelayMs),
    keyEventDelayMs: Math.max(base.keyEventDelayMs, WAYLAND_MIN.keyEventDelayMs),
    retryKeyEventDelayMs: Math.max(
      base.retryKeyEventDelayMs,
      WAYLAND_MIN.retryKeyEventDelayMs
    )
  };
}
