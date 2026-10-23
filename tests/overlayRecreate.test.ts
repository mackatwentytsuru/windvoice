import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const hoisted = vi.hoisted(() => ({
  windows: [] as Array<{
    destroyed: boolean;
    visible: boolean;
    destroy: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn>; listeners: Map<string, Listener> };
  }>
}));

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => false
}));

vi.mock('@main/debug', () => ({
  debug: vi.fn()
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    destroyed = false;
    visible = false;
    webContents = {
      send: vi.fn(),
      listeners: new Map<string, Listener>(),
      on: (event: string, cb: Listener): void => {
        this.webContents.listeners.set(event, cb);
      }
    };
    constructor() {
      hoisted.windows.push(this as never);
    }
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    loadFile = vi.fn().mockResolvedValue(undefined);
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = (): boolean => this.destroyed;
    isVisible = (): boolean => this.visible;
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    setBounds = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    close = vi.fn();
  }
  const display = { workArea: { x: 0, y: 0, width: 1536, height: 912 } };
  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => display,
      on: vi.fn(),
      removeListener: vi.fn()
    }
  };
});

import { OverlayWindow } from '@main/overlay/window';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('OverlayWindow.recreate', () => {
  beforeEach(() => {
    hoisted.windows.length = 0;
  });

  it('replaces the window and routes later state to the new one', async () => {
    const overlay = new OverlayWindow();
    await overlay.init('/tmp/preload.js');
    overlay.recreate('test');
    await flush();

    expect(hoisted.windows).toHaveLength(2);
    expect(hoisted.windows[0]!.destroy).toHaveBeenCalled();

    overlay.setStatus('listening');
    expect(hoisted.windows[1]!.showInactive).toHaveBeenCalled();
    expect(hoisted.windows[0]!.showInactive).not.toHaveBeenCalled();
  });

  it('re-shows the rebuilt window when a take is already in progress', async () => {
    const overlay = new OverlayWindow();
    await overlay.init('/tmp/preload.js');
    overlay.setStatus('listening');
    overlay.recreate('test');
    await flush();

    const fresh = hoisted.windows[1]!;
    expect(fresh.showInactive).toHaveBeenCalled();
    expect(fresh.webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'listening' })
    );
  });

  it('rebuilds once when the renderer dies, but not in a crash loop', async () => {
    const overlay = new OverlayWindow();
    await overlay.init('/tmp/preload.js');

    hoisted.windows[0]!.webContents.listeners.get('render-process-gone')!({}, { reason: 'crashed' });
    await flush();
    expect(hoisted.windows).toHaveLength(2);

    hoisted.windows[1]!.webContents.listeners.get('render-process-gone')!({}, { reason: 'crashed' });
    await flush();
    expect(hoisted.windows).toHaveLength(2);
  });
});
