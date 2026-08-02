import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => true
}));

import { pasteTiming } from '../src/main/inject/pasteTiming';

describe('pasteTiming (Wayland floor)', () => {
  it('keeps propagation floors without the obsolete fixed 1500ms restore guess', () => {
    // SelectionTransfer is now observed before restore, so Wayland still
    // needs claim/dispatch settle floors but no longer needs a blind 1500ms
    // post-key delay to guess whether the target has read the transcript.
    expect(pasteTiming('fast')).toEqual({
      settleMs: 60,
      restoreDelayMs: 60,
      streamSettleMs: 50,
      streamIntervalMs: 150,
      streamRestoreDelayMs: 80
    });
    expect(pasteTiming('balanced')).toEqual({
      settleMs: 60,
      restoreDelayMs: 180,
      streamSettleMs: 50,
      streamIntervalMs: 150,
      streamRestoreDelayMs: 220
    });
    expect(pasteTiming('safe')).toEqual({
      settleMs: 60,
      restoreDelayMs: 400,
      streamSettleMs: 55,
      streamIntervalMs: 200,
      streamRestoreDelayMs: 450
    });
  });

  it('never lowers a profile value that already exceeds the floor', () => {
    const safe = pasteTiming('safe');
    expect(safe.streamIntervalMs).toBeGreaterThanOrEqual(200);
  });
});
