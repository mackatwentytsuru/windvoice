import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  broadcast: vi.fn(),
  destroyedWindow: {
    get webContents(): never {
      throw new Error('Object has been destroyed');
    }
  }
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp', getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [hoisted.destroyedWindow] },
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
    createFromBuffer: vi.fn(() => ({ isEmpty: () => false }))
  },
  Tray: class {}
}));

vi.mock('@main/broadcast', () => ({ broadcastToUiWindows: hoisted.broadcast }));
vi.mock('@main/store/settings', () => ({
  settingsStore: { get: () => ({ ui: { uiLanguage: 'ja' } }) }
}));

import { setStatus } from '@main/tray';
import { IPC } from '@shared/ipc';

describe('tray status broadcast', () => {
  it('uses the destruction-safe UI broadcaster', () => {
    expect(() => setStatus('error')).not.toThrow();
    expect(hoisted.broadcast).toHaveBeenCalledWith(IPC.STATUS_CHANGED, 'error');
  });
});
