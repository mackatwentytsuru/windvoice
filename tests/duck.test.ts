import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import { AudioDuck } from '../src/main/audio/duck';

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
});
