import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  show: vi.fn(),
  on: vi.fn(),
  setStatus: vi.fn(),
  broadcast: vi.fn()
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true;
    }

    constructor(public readonly options: { title: string; body: string }) {}

    on = hoisted.on;
    show = hoisted.show;
  }
}));

vi.mock('@main/tray', () => ({ setStatus: hoisted.setStatus }));
vi.mock('@main/broadcast', () => ({ broadcastToUiWindows: hoisted.broadcast }));

import { surfacePasteFailure } from '@main/pasteFailure';
import { IPC } from '@shared/ipc';

describe('paste failure surfacing', () => {
  beforeEach(() => {
    hoisted.show.mockReset();
    hoisted.on.mockReset();
    hoisted.setStatus.mockReset();
    hoisted.broadcast.mockReset();
  });

  it('sets error state, broadcasts to Settings, and shows a desktop notification', () => {
    const openSettings = vi.fn();

    surfacePasteFailure('target receipt was not confirmed', openSettings);

    expect(hoisted.setStatus).toHaveBeenCalledWith('error');
    expect(hoisted.broadcast).toHaveBeenCalledWith(IPC.SYSTEM_ERROR, {
      source: 'paste',
      message: 'target receipt was not confirmed',
      kind: 'transient'
    });
    expect(hoisted.show).toHaveBeenCalledOnce();

    const clickListener = hoisted.on.mock.calls.find(([event]) => event === 'click')?.[1];
    expect(clickListener).toBeTypeOf('function');
    clickListener();
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
