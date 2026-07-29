import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}));

vi.mock('@main/report/githubReporter', () => ({
  reportError: vi.fn()
}));

import {
  broadcastToUiWindows,
  clearStickySetupError,
  replayStickySetupErrors
} from '../src/main/broadcast';
import { IPC } from '../src/shared/ipc';

describe('sticky setup errors', () => {
  const target = { send: vi.fn() };

  beforeEach(() => {
    target.send.mockReset();
    clearStickySetupError();
  });

  it('replays the latest setup error when Settings opens later', () => {
    const payload = { source: 'hotkey', message: 'permission denied', setup: true };
    broadcastToUiWindows(IPC.SYSTEM_ERROR, payload);

    replayStickySetupErrors(target);

    expect(target.send).toHaveBeenCalledWith(IPC.SYSTEM_ERROR, payload);
  });

  it('does not replay a setup error after that source recovers', () => {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'paste',
      message: 'portal unavailable',
      setup: true
    });
    clearStickySetupError('paste');

    replayStickySetupErrors(target);

    expect(target.send).not.toHaveBeenCalled();
  });
});
