import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class FakeNotification {
    static supported = true;
    static instances: FakeNotification[] = [];
    readonly handlers = new Map<string, () => void>();
    shown = false;

    static isSupported(): boolean {
      return FakeNotification.supported;
    }

    constructor(readonly options: { title: string; body?: string }) {
      FakeNotification.instances.push(this);
    }

    on(event: string, handler: () => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    show(): void {
      this.shown = true;
    }

    click(): void {
      this.handlers.get('click')?.();
    }
  }

  return {
    FakeNotification,
    updaterListeners: new Map<string, (...args: any[]) => void>(),
    ipcHandlers: new Map<string, (...args: any[]) => unknown>(),
    sentStates: [] as unknown[],
    trayStates: [] as unknown[],
    trayActions: null as null | {
      download: () => void;
      restart: () => void;
      retry: () => void;
      openRelease: () => void;
    },
    openedUrls: [] as string[],
    netFetch: vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ tag_name: 'v0.1.16', name: 'Linux packages' })
    }),
    settings: {
      current: {
        ui: {
          autoUpdate: false,
          notifiedUpdateVersion: '',
          notifiedDownloadedVersion: ''
        }
      },
      setCalls: [] as unknown[]
    },
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      logger: null as unknown,
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      quitAndInstall: vi.fn(),
      on(event: string, handler: (...args: any[]) => void) {
        hoisted.updaterListeners.set(event, handler);
        return this;
      }
    }
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.15',
    getPath: (name: string) =>
      name === 'exe' ? '/tmp/.mount_WindVoice/windvoice' : '/tmp/windvoice-test'
  },
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (_channel: string, state: unknown) => hoisted.sentStates.push(state) } }
    ]
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      hoisted.ipcHandlers.set(channel, handler);
    }
  },
  Notification: hoisted.FakeNotification,
  shell: {
    openExternal: (url: string) => {
      hoisted.openedUrls.push(url);
      return Promise.resolve();
    }
  },
  net: {
    fetch: (...args: unknown[]) => hoisted.netFetch(...args)
  }
}));

vi.mock('electron-updater', () => ({
  default: { autoUpdater: hoisted.autoUpdater }
}));

vi.mock('@main/store/settings', () => ({
  settingsStore: {
    get: () => hoisted.settings.current,
    set: (partial: { ui?: Record<string, unknown> }) => {
      hoisted.settings.setCalls.push(partial);
      if (partial.ui) {
        hoisted.settings.current = {
          ...hoisted.settings.current,
          ui: { ...hoisted.settings.current.ui, ...partial.ui }
        };
      }
      return hoisted.settings.current;
    }
  }
}));

vi.mock('@main/ipc/handlers', () => ({
  refuseUntrusted: () => null
}));

vi.mock('@main/tray', () => ({
  setUpdaterTrayState: (state: unknown, actions: typeof hoisted.trayActions) => {
    hoisted.trayStates.push(state);
    if (actions) hoisted.trayActions = actions;
  }
}));

vi.mock('@main/report/githubReporter', () => ({
  reportError: vi.fn()
}));

describe('auto updater resident-app flow', () => {
  const originalAppImage = process.env['APPIMAGE'];

  beforeEach(() => {
    process.env['APPIMAGE'] = '/tmp/WindVoice-0.1.15.AppImage';
    hoisted.updaterListeners.clear();
    hoisted.ipcHandlers.clear();
    hoisted.sentStates.length = 0;
    hoisted.trayStates.length = 0;
    hoisted.trayActions = null;
    hoisted.openedUrls.length = 0;
    hoisted.settings.setCalls.length = 0;
    hoisted.settings.current.ui.notifiedUpdateVersion = '';
    hoisted.settings.current.ui.notifiedDownloadedVersion = '';
    hoisted.FakeNotification.instances.length = 0;
    hoisted.FakeNotification.supported = true;
    hoisted.autoUpdater.checkForUpdates.mockClear();
    hoisted.autoUpdater.downloadUpdate.mockClear();
    hoisted.autoUpdater.quitAndInstall.mockClear();
    hoisted.autoUpdater.autoDownload = true;
    hoisted.autoUpdater.autoInstallOnAppQuit = false;
    hoisted.netFetch.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalAppImage === undefined) delete process.env['APPIMAGE'];
    else process.env['APPIMAGE'] = originalAppImage;
  });

  it('transitions available → download → downloaded → restart and persists notifications', async () => {
    const { initAutoUpdater } = await import('../src/main/updater');
    const { IPC } = await import('../src/shared/ipc');
    initAutoUpdater();

    expect(hoisted.autoUpdater.autoDownload).toBe(false);
    expect(hoisted.autoUpdater.autoInstallOnAppQuit).toBe(true);

    hoisted.updaterListeners.get('update-available')?.({
      version: '0.1.16',
      releaseName: 'Safer resident updates'
    });
    hoisted.updaterListeners.get('update-available')?.({
      version: '0.1.16',
      releaseName: 'Safer resident updates'
    });

    expect(hoisted.FakeNotification.instances).toHaveLength(1);
    expect(hoisted.FakeNotification.instances[0]?.options.title).toContain('0.1.16');
    expect(hoisted.settings.current.ui.notifiedUpdateVersion).toBe('0.1.16');
    expect(hoisted.trayStates.at(-1)).toMatchObject({
      phase: 'available',
      version: '0.1.16',
      delivery: 'self-update'
    });

    hoisted.FakeNotification.instances[0]?.click();
    await Promise.resolve();
    expect(hoisted.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    hoisted.updaterListeners.get('download-progress')?.({ percent: 42.4 });
    expect(hoisted.trayStates.at(-1)).toMatchObject({
      phase: 'downloading',
      version: '0.1.16',
      percent: 42
    });

    hoisted.updaterListeners.get('update-downloaded')?.({ version: '0.1.16' });
    expect(hoisted.trayStates.at(-1)).toMatchObject({
      phase: 'downloaded',
      version: '0.1.16'
    });
    expect(hoisted.FakeNotification.instances).toHaveLength(2);
    expect(hoisted.settings.current.ui.notifiedDownloadedVersion).toBe('0.1.16');

    const restart = hoisted.ipcHandlers.get(IPC.UPDATER_RESTART);
    expect(restart).toBeTypeOf('function');
    await restart?.({ sender: { id: 1 } });
    expect(hoisted.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('does not notify the same available version after a module restart', async () => {
    const first = await import('../src/main/updater');
    first.initAutoUpdater();
    hoisted.updaterListeners.get('update-available')?.({ version: '0.1.16' });
    expect(hoisted.FakeNotification.instances).toHaveLength(1);

    hoisted.updaterListeners.clear();
    hoisted.ipcHandlers.clear();
    vi.resetModules();
    const second = await import('../src/main/updater');
    second.initAutoUpdater();
    hoisted.updaterListeners.get('update-available')?.({ version: '0.1.16' });

    expect(hoisted.FakeNotification.instances).toHaveLength(1);
  });

  it('keeps the tray update path when native notifications are unsupported', async () => {
    hoisted.FakeNotification.supported = false;
    const { initAutoUpdater } = await import('../src/main/updater');
    initAutoUpdater();

    hoisted.updaterListeners.get('update-available')?.({ version: '0.1.16' });

    expect(hoisted.FakeNotification.instances).toHaveLength(0);
    expect(hoisted.trayStates.at(-1)).toMatchObject({
      phase: 'available',
      version: '0.1.16'
    });
    hoisted.trayActions?.download();
    await Promise.resolve();
    expect(hoisted.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('uses the release page for deb and unknown Linux installs instead of downloading', async () => {
    delete process.env['APPIMAGE'];
    const { detectUpdateDelivery, initAutoUpdater } = await import('../src/main/updater');
    const { IPC } = await import('../src/shared/ipc');
    expect(detectUpdateDelivery('linux', undefined, '/opt/WindVoice/windvoice')).toBe('manual');
    expect(detectUpdateDelivery('linux', undefined, '/unknown/windvoice')).toBe('manual');

    initAutoUpdater();
    const check = hoisted.ipcHandlers.get(IPC.UPDATER_CHECK);
    await check?.({ sender: { id: 1 } });

    expect(hoisted.netFetch).toHaveBeenCalledTimes(1);
    expect(hoisted.trayStates.at(-1)).toMatchObject({
      phase: 'available',
      version: '0.1.16',
      delivery: 'manual'
    });
    hoisted.trayActions?.download();
    await Promise.resolve();

    expect(hoisted.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(hoisted.openedUrls[0]).toMatch(/^https:\/\/github\.com\//);
  });

  it('treats a missing platform feed 404 as not-available', async () => {
    const { initAutoUpdater, isMissingPlatformFeed } = await import('../src/main/updater');
    initAutoUpdater();
    const err = new Error('Cannot find latest-linux.yml in the latest release artifacts (404)');
    expect(isMissingPlatformFeed(err.message)).toBe(true);

    hoisted.updaterListeners.get('error')?.(err);
    expect(hoisted.trayStates.at(-1)).toMatchObject({ phase: 'not-available' });
  });
});
