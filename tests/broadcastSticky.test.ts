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
import { reportError } from '../src/main/report/githubReporter';

describe('sticky setup errors', () => {
  const target = { send: vi.fn() };

  beforeEach(() => {
    target.send.mockReset();
    clearStickySetupError();
    vi.mocked(reportError).mockReset();
  });

  it('replays the latest setup error when Settings opens later', () => {
    const payload = { source: 'hotkey', message: 'permission denied', kind: 'setup' as const };
    broadcastToUiWindows(IPC.SYSTEM_ERROR, payload);

    replayStickySetupErrors(target);

    expect(target.send).toHaveBeenCalledWith(IPC.SYSTEM_ERROR, payload);
  });

  it('does not replay a setup error after that source recovers', () => {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'paste',
      message: 'portal unavailable',
      kind: 'setup'
    });
    clearStickySetupError('paste');

    replayStickySetupErrors(target);

    expect(target.send).not.toHaveBeenCalled();
  });

  it.each(['setup', 'transient'] as const)('does not report kind:%s errors', (kind) => {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'paste',
      message: 'environmental failure',
      kind
    });

    expect(reportError).not.toHaveBeenCalled();
  });

  it('queues only explicitly classified bugs for preview', () => {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'storage',
      message: 'unexpected invariant failure',
      kind: 'bug'
    });

    expect(reportError).toHaveBeenCalledWith(
      'storage',
      'unexpected invariant failure',
      'bug'
    );
  });
});
