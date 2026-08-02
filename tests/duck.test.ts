import { describe, expect, it, vi, afterAll, beforeEach, afterEach } from 'vitest';

// v0.1.2: AudioDuck refuses to act on darwin unless WINDVOICE_DUCK_MAC=1
// (#15). Force the process.platform to 'linux' at module load so the
// generic behavior tests in the outer describe are unaffected by the
// dev host's actual platform. The nested 'platform gating' describe
// already manages its own platform overrides per test.
//
// IMPORTANT: this must happen at module scope, BEFORE the nested
// describe blocks evaluate — `const originalPlatform = process.platform`
// inside the nested describe captures at evaluation time, so we need
// the platform to already read 'linux' by then or its afterEach will
// "restore" to darwin and break tests after the gating block.
const __originalPlatformAtLoad = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

const hoisted = vi.hoisted(() => ({
  state: { volume: 50 },
  getVolume: vi.fn(),
  setVolume: vi.fn()
}));

vi.mock('loudness', () => ({
  default: {
    getVolume: hoisted.getVolume,
    setVolume: hoisted.setVolume
  }
}));

import { AudioDuck, onDuckError } from '../src/main/audio/duck';

describe('AudioDuck', () => {
  afterAll(() => {
    // Restore the host's true platform after all duck tests run, in case
    // anything later (vitest's own diagnostics, follow-up test files in
    // the same worker) inspects process.platform.
    Object.defineProperty(process, 'platform', {
      value: __originalPlatformAtLoad,
      writable: true
    });
  });

  beforeEach(() => {
    hoisted.state.volume = 50;
    hoisted.getVolume.mockReset();
    hoisted.setVolume.mockReset();
    hoisted.getVolume.mockImplementation(async () => hoisted.state.volume);
    hoisted.setVolume.mockImplementation(async (v: number) => {
      hoisted.state.volume = v;
    });
  });

  it('lowers volume by the multiplier and restores it', async () => {
    const duck = new AudioDuck();
    await duck.duck(0.3);
    expect(hoisted.setVolume).toHaveBeenCalledWith(15); // 50 * 0.3
    await duck.restore();
    expect(hoisted.setVolume).toHaveBeenLastCalledWith(50);
  });

  it('is a no-op when multiplier is 1.0', async () => {
    const duck = new AudioDuck();
    await duck.duck(1.0);
    expect(hoisted.setVolume).not.toHaveBeenCalled();
  });

  it('ignores duplicate duck() calls', async () => {
    const duck = new AudioDuck();
    await duck.duck(0.3);
    expect(hoisted.setVolume).toHaveBeenCalledTimes(1);
    await duck.duck(0.5);
    expect(hoisted.setVolume).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent duck() calls before getVolume resolves', async () => {
    let release!: (value: number) => void;
    hoisted.getVolume.mockImplementationOnce(
      () => new Promise<number>((resolve) => {
        release = resolve;
      })
    );
    const duck = new AudioDuck();

    const first = duck.duck(0.3);
    const duplicate = duck.duck(0.5);
    release(50);
    await Promise.all([first, duplicate]);

    expect(hoisted.getVolume).toHaveBeenCalledTimes(1);
    expect(hoisted.setVolume).toHaveBeenCalledTimes(1);
    expect(hoisted.setVolume).toHaveBeenCalledWith(15);
  });

  it('honors restore() requested while duck() is still lowering the volume', async () => {
    let releaseSet!: () => void;
    hoisted.setVolume.mockImplementationOnce(
      (v: number) =>
        new Promise<void>((resolve) => {
          hoisted.state.volume = v;
          releaseSet = resolve;
        })
    );
    const duck = new AudioDuck();

    const lowering = duck.duck(0.3);
    await Promise.resolve();
    const restoring = duck.restore();
    releaseSet();
    await Promise.all([lowering, restoring]);

    expect(hoisted.setVolume).toHaveBeenNthCalledWith(1, 15);
    expect(hoisted.setVolume).toHaveBeenNthCalledWith(2, 50);
    expect(hoisted.state.volume).toBe(50);
  });

  it('restore is a no-op if never ducked', async () => {
    const duck = new AudioDuck();
    await duck.restore();
    expect(hoisted.setVolume).not.toHaveBeenCalled();
  });

  it('clamps the target into [0, 100]', async () => {
    hoisted.state.volume = 100;
    const duck = new AudioDuck();
    await duck.duck(0.5);
    expect(hoisted.setVolume).toHaveBeenCalledWith(50);
    await duck.restore();
    expect(hoisted.setVolume).toHaveBeenLastCalledWith(100);
  });

  it('survives loudness throwing', async () => {
    hoisted.getVolume.mockRejectedValueOnce(new Error('boom'));
    const duck = new AudioDuck();
    await expect(duck.duck(0.3)).resolves.toBeUndefined();
    // restore is a no-op since duck never marked active
    hoisted.setVolume.mockClear();
    await duck.restore();
    expect(hoisted.setVolume).not.toHaveBeenCalled();
  });

  it('keeps state on failed restore so a later cycle restores the TRUE original', async () => {
    const duck = new AudioDuck();
    // First cycle: duck from 50 → 15, then a failing restore. State must be
    // preserved (active + originalVolume=50) so the lowered value is never
    // re-saved as the original (which would ratchet volume permanently down).
    await duck.duck(0.3);
    expect(hoisted.state.volume).toBe(15);
    hoisted.setVolume.mockRejectedValueOnce(new Error('restore failed'));
    await duck.restore();
    // restore failed: volume still lowered, but state is intact.
    expect(hoisted.state.volume).toBe(15);

    // A second duck() must be a no-op (still active), NOT re-save 15 as original.
    await duck.duck(0.3);
    expect(hoisted.state.volume).toBe(15);

    // A retried restore now succeeds and returns to the TRUE original (50).
    await duck.restore();
    expect(hoisted.setVolume).toHaveBeenLastCalledWith(50);
    expect(hoisted.state.volume).toBe(50);
  });

  describe('platform gating', () => {
    const originalPlatform = process.platform;
    const originalEnv = process.env['WINDVOICE_DUCK_MAC'];

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
      if (originalEnv === undefined) {
        delete process.env['WINDVOICE_DUCK_MAC'];
      } else {
        process.env['WINDVOICE_DUCK_MAC'] = originalEnv;
      }
    });

    it('on darwin without WINDVOICE_DUCK_MAC, duck() is a no-op', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      delete process.env['WINDVOICE_DUCK_MAC'];
      const duck = new AudioDuck();
      await duck.duck(0.3);
      expect(hoisted.setVolume).not.toHaveBeenCalled();
      expect(hoisted.getVolume).not.toHaveBeenCalled();
    });

    it('on darwin with WINDVOICE_DUCK_MAC=1, duck() proceeds', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
      process.env['WINDVOICE_DUCK_MAC'] = '1';
      const duck = new AudioDuck();
      await duck.duck(0.3);
      expect(hoisted.setVolume).toHaveBeenCalled();
    });

    it('on non-darwin (linux), duck() proceeds regardless of env var', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
      delete process.env['WINDVOICE_DUCK_MAC'];
      const duck = new AudioDuck();
      await duck.duck(0.3);
      expect(hoisted.setVolume).toHaveBeenCalledWith(15);
    });

    it('on non-darwin (win32), duck() proceeds regardless of env var', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      delete process.env['WINDVOICE_DUCK_MAC'];
      const duck = new AudioDuck();
      await duck.duck(0.3);
      expect(hoisted.setVolume).toHaveBeenCalledWith(15);
    });
  });

  describe('onDuckError', () => {
    it('fires with phase "duck" when setVolume throws during ducking', async () => {
      hoisted.setVolume.mockRejectedValueOnce(new Error('cannot set volume'));
      const events: Array<{ phase: string; message: string }> = [];
      const off = onDuckError((phase, message) => events.push({ phase, message }));
      try {
        const duck = new AudioDuck();
        await duck.duck(0.3);
        expect(events).toHaveLength(1);
        expect(events[0]!.phase).toBe('duck');
        expect(events[0]!.message).toContain('cannot set volume');
      } finally {
        off();
      }
    });

    it('fires with phase "restore" when setVolume throws during restore', async () => {
      const events: Array<{ phase: string; message: string }> = [];
      const off = onDuckError((phase, message) => events.push({ phase, message }));
      try {
        const duck = new AudioDuck();
        await duck.duck(0.3);
        expect(events).toHaveLength(0);
        // Now arrange the next setVolume call (restore) to fail.
        hoisted.setVolume.mockRejectedValueOnce(new Error('restore failed'));
        await duck.restore();
        expect(events).toHaveLength(1);
        expect(events[0]!.phase).toBe('restore');
        expect(events[0]!.message).toContain('restore failed');
      } finally {
        off();
      }
    });

    it('returns an unsubscribe function that detaches the listener', async () => {
      const events: Array<{ phase: string; message: string }> = [];
      const off = onDuckError((phase, message) => events.push({ phase, message }));
      off();
      hoisted.setVolume.mockRejectedValueOnce(new Error('boom'));
      const duck = new AudioDuck();
      await duck.duck(0.3);
      expect(events).toHaveLength(0);
    });
  });
});
