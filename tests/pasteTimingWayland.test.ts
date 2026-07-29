import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => true
}));

import { pasteTiming } from '../src/main/inject/pasteTiming';

describe('pasteTiming (Wayland floor)', () => {
  it('applies all five Wayland timing fields to every profile', () => {
    // The Wayland paste chain (portal → compositor → target app → async
    // clipboard transfer) needs a far larger restore margin than XTest;
    // observed live: 180ms 'balanced' restored the clipboard before the
    // target read it, pasting the user's OLD clipboard content.
    expect(pasteTiming('fast')).toEqual({
      settleMs: 60,
      restoreDelayMs: 1500,
      streamSettleMs: 50,
      streamIntervalMs: 150,
      streamRestoreDelayMs: 1500
    });
    expect(pasteTiming('balanced')).toEqual({
      settleMs: 60,
      restoreDelayMs: 1500,
      streamSettleMs: 50,
      streamIntervalMs: 150,
      streamRestoreDelayMs: 1500
    });
    expect(pasteTiming('safe')).toEqual({
      settleMs: 60,
      restoreDelayMs: 1500,
      streamSettleMs: 55,
      streamIntervalMs: 200,
      streamRestoreDelayMs: 1500
    });
  });

  it('never lowers a profile value that already exceeds the floor', () => {
    const safe = pasteTiming('safe');
    expect(safe.streamIntervalMs).toBeGreaterThanOrEqual(200);
  });
});
