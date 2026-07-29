import { describe, expect, it, vi } from 'vitest';
import {
  STATUS_NOTIFIER_WATCHER,
  ensureStatusNotifierWatcher
} from '@main/linux/statusNotifier';

describe('StatusNotifierWatcher startup fallback', () => {
  it('keeps tray-only startup when the watcher owns its D-Bus name', async () => {
    const nameHasOwner = vi.fn().mockResolvedValue(true);
    const openSettings = vi.fn();
    const notify = vi.fn();

    await expect(
      ensureStatusNotifierWatcher({
        platform: 'linux',
        language: 'ja',
        nameHasOwner,
        openSettings,
        notify
      })
    ).resolves.toBe(true);

    expect(nameHasOwner).toHaveBeenCalledWith(STATUS_NOTIFIER_WATCHER);
    expect(openSettings).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('opens Settings and emits a setup error when the watcher is absent', async () => {
    const nameHasOwner = vi.fn().mockResolvedValue(false);
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();

    await expect(
      ensureStatusNotifierWatcher({
        platform: 'linux',
        language: 'en',
        nameHasOwner,
        openSettings,
        notify
      })
    ).resolves.toBe(false);

    expect(openSettings).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      source: 'tray',
      kind: 'setup',
      message: expect.stringMatching(
        /gnome-shell-extension-appindicator.*AppIndicator and KStatusNotifierItem Support.*launch WindVoice again/is
      )
    });
  });

  it('does not query D-Bus on non-Linux platforms', async () => {
    const nameHasOwner = vi.fn();

    await expect(
      ensureStatusNotifierWatcher({
        platform: 'darwin',
        language: 'en',
        nameHasOwner,
        openSettings: vi.fn(),
        notify: vi.fn()
      })
    ).resolves.toBe(true);

    expect(nameHasOwner).not.toHaveBeenCalled();
  });
});
