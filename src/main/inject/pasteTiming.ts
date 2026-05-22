// Clipboard-paste timing profiles.
//
// Pasting works by writing the transcript to the clipboard, synthesizing
// Ctrl/Cmd+V, then restoring the user's original clipboard. The restore
// MUST happen only after the target app has actually consumed the paste —
// otherwise the app reads the already-restored old clipboard and the user
// sees "the thing I copied before" pasted instead of the transcript.
//
// There is no OS signal for "paste consumed", so every delay is a guess.
// Slow targets (Windows Terminal / ConPTY / WSL, RDP / VNC / VM sessions,
// busy Electron apps, browsers, machines running clipboard managers) need
// a longer margin than a native text field. These profiles let the user
// trade paste latency for cross-environment reliability.

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
}

const PROFILES: Record<PasteCompatibility, PasteTiming> = {
  // Lowest latency. Matches the pre-existing aggressive constants; fine for
  // fast native text fields but races on slow targets.
  fast: {
    settleMs: 10,
    restoreDelayMs: 60,
    streamSettleMs: 12,
    streamIntervalMs: 60,
    streamRestoreDelayMs: 80
  },
  // Default. Restores the safer margin that existed before the constants
  // were tuned down without live timing data — eliminates the stale-paste
  // race for the large majority of apps at a barely perceptible cost.
  balanced: {
    settleMs: 25,
    restoreDelayMs: 180,
    streamSettleMs: 25,
    streamIntervalMs: 110,
    streamRestoreDelayMs: 220
  },
  // Maximum compatibility for terminals, remote-desktop / VM sessions and
  // other high-latency targets where 'balanced' still drops the paste.
  safe: {
    settleMs: 60,
    restoreDelayMs: 400,
    streamSettleMs: 55,
    streamIntervalMs: 200,
    streamRestoreDelayMs: 450
  }
};

export function pasteTiming(profile: PasteCompatibility | undefined): PasteTiming {
  return (profile && PROFILES[profile]) || PROFILES.balanced;
}
