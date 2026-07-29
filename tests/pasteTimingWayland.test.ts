import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => true
}));

import { pasteTiming } from '../src/main/inject/pasteTiming';

describe('pasteTiming (Wayland floor)', () => {
  it('raises restore delays to the Wayland floor on every profile', () => {
    // The Wayland paste chain (portal → compositor → target app → async
    // clipboard transfer) needs a far larger restore margin than XTest;
    // observed live: 180ms 'balanced' restored the clipboard before the
    // target read it, pasting the user's OLD clipboard content.
    for (const profile of ['fast', 'balanced', 'safe'] as const) {
      const t = pasteTiming(profile);
      expect(t.restoreDelayMs).toBeGreaterThanOrEqual(1500);
      expect(t.streamRestoreDelayMs).toBeGreaterThanOrEqual(1500);
      expect(t.settleMs).toBeGreaterThanOrEqual(60);
    }
  });

  it('never lowers a profile value that already exceeds the floor', () => {
    const safe = pasteTiming('safe');
    expect(safe.streamIntervalMs).toBeGreaterThanOrEqual(200);
  });
});
