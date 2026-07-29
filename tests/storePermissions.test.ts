import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const chmodSync = vi.fn();
  const stores = new Map<string, Record<string, unknown>>();
  class FakeStore {
    path: string;
    private name: string;

    constructor(options: { name: string; defaults?: Record<string, unknown> }) {
      this.name = options.name;
      this.path = `/tmp/${options.name}.json`;
      if (!stores.has(this.name)) stores.set(this.name, { ...(options.defaults ?? {}) });
    }

    get store(): Record<string, unknown> {
      return { ...(stores.get(this.name) ?? {}) };
    }

    set store(value: Record<string, unknown>) {
      stores.set(this.name, { ...value });
    }

    get(key: string, fallback?: unknown): unknown {
      return stores.get(this.name)?.[key] ?? fallback;
    }

    set(key: string, value: unknown): void {
      const current = stores.get(this.name) ?? {};
      stores.set(this.name, { ...current, [key]: value });
    }
  }
  return { chmodSync, stores, FakeStore };
});

vi.mock('electron-store', () => ({ default: hoisted.FakeStore }));
vi.mock('node:fs', () => ({
  default: {
    existsSync: () => true,
    chmodSync: hoisted.chmodSync
  }
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  BrowserWindow: { getAllWindows: () => [] }
}));

describe('private store file permissions', () => {
  beforeEach(() => {
    hoisted.chmodSync.mockClear();
    hoisted.stores.clear();
    vi.resetModules();
  });

  it('chmods settings to 0600 at load and after a write', async () => {
    const { settingsStore } = await import('@main/store/settings');
    settingsStore.set({ language: 'en' });

    expect(hoisted.chmodSync).toHaveBeenCalledWith(
      '/tmp/windvoice-settings.json',
      0o600
    );
    expect(hoisted.chmodSync).toHaveBeenCalledTimes(2);
  });

  it('chmods history to 0600 at load and after a write', async () => {
    const { historyStore, flushHistory } = await import('@main/store/history');
    historyStore.add({ transcript: 'private' });
    flushHistory();

    expect(hoisted.chmodSync).toHaveBeenCalledWith(
      '/tmp/windvoice-history.json',
      0o600
    );
    expect(hoisted.chmodSync).toHaveBeenCalledTimes(2);
  });
});
