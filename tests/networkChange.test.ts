import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkChangeDebouncer } from '../src/main/network/changeDebouncer';

describe('NetworkChangeDebouncer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid network signals until the debounce window settles', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const debouncer = new NetworkChangeDebouncer(onChange, 4_000);

    debouncer.notify();
    vi.advanceTimersByTime(3_000);
    debouncer.notify();
    vi.advanceTimersByTime(3_999);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending callback when disposed', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const debouncer = new NetworkChangeDebouncer(onChange, 4_000);

    debouncer.notify();
    debouncer.dispose();
    vi.advanceTimersByTime(4_000);

    expect(onChange).not.toHaveBeenCalled();
  });
});
