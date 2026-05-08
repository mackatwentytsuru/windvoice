import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
