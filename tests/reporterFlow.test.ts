import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class FakeNotification {
    static instances: FakeNotification[] = [];
    readonly handlers = new Map<string, () => void>();

    static isSupported(): boolean {
      return true;
    }

    constructor(readonly options: { title: string; body?: string }) {
      FakeNotification.instances.push(this);
    }

    on(event: string, handler: () => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    show(): void {}
  }

  return {
    FakeNotification,
    files: new Map<string, string>(),
    ipcHandlers: new Map<string, (...args: any[]) => unknown>(),
    clipboardWrites: [] as string[],
    openedUrls: [] as string[],
    execCalls: [] as string[][],
    settings: {
      ui: {
        errorReporting: false,
        errorReportingConsent: 'undecided' as 'undecided' | 'enabled' | 'disabled',
        errorReportingPrompted: false
      }
    }
  };
});

vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    if (path === '/etc/os-release') return 'PRETTY_NAME="Test Linux"';
    const value = hoisted.files.get(String(path));
    if (value === undefined) throw new Error('ENOENT');
    return value;
  },
  writeFileSync: (path: string, value: string) => {
    hoisted.files.set(String(path), value);
  }
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (err: NodeJS.ErrnoException, stdout: string, stderr: string) => void
  ) => {
    hoisted.execCalls.push(args);
    const err = new Error('gh missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    callback(err, '', '');
  }
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp/windvoice-reporter-test',
    getVersion: () => '0.1.15'
  },
  Notification: hoisted.FakeNotification,
  clipboard: {
    writeText: (text: string) => hoisted.clipboardWrites.push(text)
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      hoisted.ipcHandlers.set(channel, handler);
    }
  }
}));

vi.mock('@main/ipc/handlers', () => ({
  refuseUntrusted: () => null
}));

vi.mock('@main/store/settings', () => ({
  settingsStore: {
    get: () => hoisted.settings,
    set: (partial: { ui?: typeof hoisted.settings.ui }) => {
      if (partial.ui) hoisted.settings.ui = { ...hoisted.settings.ui, ...partial.ui };
      return hoisted.settings;
    }
  }
}));

vi.mock('@main/util/openExternal', () => ({
  openExternalSafe: (url: string) => {
    hoisted.openedUrls.push(url);
    return Promise.resolve(true);
  }
}));

describe('consent-based reporter IPC flow', () => {
  beforeEach(() => {
    hoisted.files.clear();
    hoisted.ipcHandlers.clear();
    hoisted.clipboardWrites.length = 0;
    hoisted.openedUrls.length = 0;
    hoisted.execCalls.length = 0;
    hoisted.FakeNotification.instances.length = 0;
    hoisted.settings.ui = {
      errorReporting: false,
      errorReportingConsent: 'undecided',
      errorReportingPrompted: false
    };
    vi.resetModules();
  });

  it('never invokes gh before review, then falls back to clipboard + HTTPS issue page', async () => {
    const { IPC } = await import('../src/shared/ipc');
    const { initErrorReporter, reportError } = await import('../src/main/report/githubReporter');
    initErrorReporter();

    reportError('storage', 'unexpected invariant at /home/alice/private.txt', 'bug');

    expect(hoisted.execCalls).toHaveLength(0);
    expect(hoisted.FakeNotification.instances).toHaveLength(1);
    expect(hoisted.settings.ui.errorReporting).toBe(false);
    expect(hoisted.settings.ui.errorReportingPrompted).toBe(true);

    const previewHandler = hoisted.ipcHandlers.get(IPC.ERROR_REPORT_PREVIEW);
    const preview = await previewHandler?.({ sender: { id: 1 } });
    expect(preview).toMatchObject({ title: expect.any(String), body: expect.any(String) });
    expect(JSON.stringify(preview)).not.toContain('/home/alice');

    const sendHandler = hoisted.ipcHandlers.get(IPC.ERROR_REPORT_SEND);
    const result = await sendHandler?.({ sender: { id: 1 } });

    expect(hoisted.execCalls).toHaveLength(1);
    expect(result).toEqual({ status: 'manual', copied: true });
    expect(hoisted.clipboardWrites).toHaveLength(1);
    expect(hoisted.openedUrls[0]).toMatch(
      /^https:\/\/github\.com\/mackatwentytsuru\/windvoice\/issues\/new/
    );
    expect(hoisted.settings.ui.errorReportingConsent).toBe('enabled');
  });
});
