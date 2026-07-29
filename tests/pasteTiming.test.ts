import { describe, expect, it, vi } from 'vitest';

// Profile assertions below describe the BASE values; pin the session type
// to non-Wayland so running the suite on a Wayland host does not engage
// the Wayland floor clamp. The clamp itself is covered separately via
// dynamic import in the wayland-floor suite.
vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => false
}));

import { pasteTiming } from '../src/main/inject/pasteTiming';

describe('pasteTiming', () => {
  it('returns distinct profiles for fast / balanced / safe', () => {
    const fast = pasteTiming('fast');
    const balanced = pasteTiming('balanced');
    const safe = pasteTiming('safe');
    expect(fast.restoreDelayMs).toBeLessThan(balanced.restoreDelayMs);
    expect(balanced.restoreDelayMs).toBeLessThan(safe.restoreDelayMs);
    expect(fast.settleMs).toBeLessThan(safe.settleMs);
  });

  it('restore delay is long enough to outlast a slow paste consumer', () => {
    // The reported bug: a 50ms restore delay let a slow target read the
    // already-restored old clipboard. The default profile must give a
    // comfortably larger margin than that.
    expect(pasteTiming('balanced').restoreDelayMs).toBeGreaterThanOrEqual(150);
    expect(pasteTiming('safe').restoreDelayMs).toBeGreaterThanOrEqual(300);
  });

  it('streaming timings scale with the chosen profile', () => {
    const fast = pasteTiming('fast');
    const safe = pasteTiming('safe');
    expect(safe.streamIntervalMs).toBeGreaterThan(fast.streamIntervalMs);
    expect(safe.streamRestoreDelayMs).toBeGreaterThan(fast.streamRestoreDelayMs);
  });

  it('falls back to the balanced profile for an undefined / unknown value', () => {
    const balanced = pasteTiming('balanced');
    expect(pasteTiming(undefined)).toEqual(balanced);
    // An out-of-range string (e.g. from a stale settings file) is coerced.
    expect(pasteTiming('nonsense' as never)).toEqual(balanced);
  });
});
