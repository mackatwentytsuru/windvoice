import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted state lets each test control what the mocked `get-windows` does
// without re-mocking. Tests reset it in beforeEach.
const hoisted = vi.hoisted(() => {
  const state = {
    activeWindow: vi.fn() as ReturnType<typeof vi.fn>
  };
  return state;
});

vi.mock('get-windows', () => ({
  activeWindow: hoisted.activeWindow
}));

import {
  getActiveWindow,
  __resetActiveWindowCacheForTests
} from '@main/context/activeWindow';

describe('getActiveWindow', () => {
  beforeEach(() => {
    hoisted.activeWindow.mockReset();
    __resetActiveWindowCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns mapped {title, app} when get-windows resolves a window', async () => {
    hoisted.activeWindow.mockResolvedValueOnce({
      title: 'README.md - Visual Studio Code',
      owner: { name: 'Code', processId: 123, path: 'C:/code.exe' }
    });

    const info = await getActiveWindow();
    expect(info).toEqual({
      title: 'README.md - Visual Studio Code',
      app: 'Code'
    });
    expect(hoisted.activeWindow).toHaveBeenCalledTimes(1);
  });

  it('returns null when get-windows resolves undefined', async () => {
    hoisted.activeWindow.mockResolvedValueOnce(undefined);

    const info = await getActiveWindow();
    expect(info).toBeNull();
    expect(hoisted.activeWindow).toHaveBeenCalledTimes(1);
  });

  it('returns null when get-windows throws (does not propagate)', async () => {
    hoisted.activeWindow.mockRejectedValueOnce(new Error('boom'));

    const info = await getActiveWindow();
    expect(info).toBeNull();
    expect(hoisted.activeWindow).toHaveBeenCalledTimes(1);
  });

  it('caches: a second call within 500 ms does NOT call get-windows again', async () => {
    hoisted.activeWindow.mockResolvedValueOnce({
      title: 'Slack',
      owner: { name: 'Slack' }
    });

    const first = await getActiveWindow();
    const second = await getActiveWindow();

    expect(first).toEqual({ title: 'Slack', app: 'Slack' });
    expect(second).toEqual({ title: 'Slack', app: 'Slack' });
    expect(hoisted.activeWindow).toHaveBeenCalledTimes(1);
  });

  it('after 500 ms the cache expires and get-windows is called again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    hoisted.activeWindow.mockResolvedValueOnce({
      title: 'A',
      owner: { name: 'AppA' }
    });
    hoisted.activeWindow.mockResolvedValueOnce({
      title: 'B',
      owner: { name: 'AppB' }
    });

    const first = await getActiveWindow();
    expect(first).toEqual({ title: 'A', app: 'AppA' });

    // Advance just past the 500 ms TTL.
    vi.setSystemTime(501);
    const second = await getActiveWindow();
    expect(second).toEqual({ title: 'B', app: 'AppB' });
    expect(hoisted.activeWindow).toHaveBeenCalledTimes(2);
  });

  it('times out gracefully when get-windows hangs longer than 1500 ms', async () => {
    vi.useFakeTimers();

    // A promise that never resolves — simulates a hung helper process.
    hoisted.activeWindow.mockImplementationOnce(
      () => new Promise(() => undefined)
    );

    const promise = getActiveWindow();
    // Push past the 1500 ms hard timeout.
    await vi.advanceTimersByTimeAsync(1_600);

    const info = await promise;
    expect(info).toBeNull();
    expect(hoisted.activeWindow).toHaveBeenCalledTimes(1);
  });
});
