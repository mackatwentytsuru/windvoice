import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  getPrimaryDisplay: vi.fn(),
  getCursorScreenPoint: vi.fn(),
  getDisplayNearestPoint: vi.fn(),
  on: vi.fn(),
  setBounds: vi.fn(),
  showInactive: vi.fn()
}));

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => true
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = { send: vi.fn() };
    constructor(options: Record<string, unknown>) {
      hoisted.options = options;
    }
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    loadFile = vi.fn().mockResolvedValue(undefined);
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = () => false;
    isVisible = () => false;
    showInactive = hoisted.showInactive;
    setBounds = hoisted.setBounds;
    hide = vi.fn();
    close = vi.fn();
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: hoisted.getPrimaryDisplay,
      getCursorScreenPoint: hoisted.getCursorScreenPoint,
      getDisplayNearestPoint: hoisted.getDisplayNearestPoint,
      on: hoisted.on,
      removeListener: vi.fn()
    }
  };
});

import { OverlayWindow } from '@main/overlay/window';

describe('OverlayWindow on Wayland', () => {
  beforeEach(() => {
    hoisted.options = null;
    hoisted.getPrimaryDisplay.mockReset();
    hoisted.getCursorScreenPoint.mockReset();
    hoisted.getDisplayNearestPoint.mockReset();
    hoisted.on.mockReset();
    hoisted.setBounds.mockReset();
    hoisted.showInactive.mockReset();
  });

  it('does not calculate or request client-side coordinates', async () => {
    const overlay = new OverlayWindow();
    await overlay.init('/tmp/preload.js');
    overlay.setStatus('listening');

    expect(hoisted.getPrimaryDisplay).not.toHaveBeenCalled();
    expect(hoisted.getCursorScreenPoint).not.toHaveBeenCalled();
    expect(hoisted.getDisplayNearestPoint).not.toHaveBeenCalled();
    expect(hoisted.on).not.toHaveBeenCalled();
    expect(hoisted.setBounds).not.toHaveBeenCalled();
    expect(hoisted.options).not.toHaveProperty('x');
    expect(hoisted.options).not.toHaveProperty('y');
  });
});
