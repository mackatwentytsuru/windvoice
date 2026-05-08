import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────
//
// Capture every channel handler that handlers.ts registers via `ipcMain.handle`
// so we can invoke them directly from tests.

const hoisted = vi.hoisted(() => {
  return {
    captured: new Map<string, (...args: unknown[]) => unknown>(),
    onListeners: new Map<string, (...args: unknown[]) => unknown>(),
    clipboardWriteText: { calls: [] as string[] },
    secure: {
      setApiKey: ((..._args: unknown[]) => Promise.resolve()) as (
        ...args: unknown[]
      ) => Promise<void>,
      clearApiKey: ((..._args: unknown[]) => Promise.resolve()) as (
        ...args: unknown[]
      ) => Promise<void>,
      hasApiKey: (() => Promise.resolve(false)) as () => Promise<boolean>,
      getApiKey: (() => Promise.resolve(null)) as () => Promise<string | null>
    },
    settings: {
      current: { hotkeys: [{ id: 'primary', keys: ['RightAlt'], mode: 'push-to-talk', format: true }] },
      setCalls: [] as unknown[],
      shouldThrowOnSet: false
    },
    history: {
      list: [] as unknown[],
      removed: [] as string[]
    }
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => {
      hoisted.captured.set(ch, fn);
    },
    on: (ch: string, fn: (...args: unknown[]) => unknown) => {
      hoisted.onListeners.set(ch, fn);
    },
    removeHandler: (ch: string) => {
      hoisted.captured.delete(ch);
    },
    removeAllListeners: (ch: string) => {
      hoisted.onListeners.delete(ch);
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: {
    writeText: (text: string) => {
      hoisted.clipboardWriteText.calls.push(text);
    }
  }
}));

vi.mock('@main/store/secure', () => {
  class SecureStoreUnavailableError extends Error {
    code = 'SECURE_STORE_UNAVAILABLE' as const;
    constructor(message: string) {
      super(message);
      this.name = 'SecureStoreUnavailableError';
    }
  }
  return {
    SecureStoreUnavailableError,
    secureStore: {
      setApiKey: (...args: unknown[]) => hoisted.secure.setApiKey(...args),
      clearApiKey: (...args: unknown[]) => hoisted.secure.clearApiKey(...args),
      hasApiKey: () => hoisted.secure.hasApiKey(),
      getApiKey: () => hoisted.secure.getApiKey()
    }
  };
});

vi.mock('@main/store/settings', () => ({
  settingsStore: {
    get: () => hoisted.settings.current,
    set: (partial: unknown) => {
      if (hoisted.settings.shouldThrowOnSet) {
        throw new Error('store set rejected');
      }
      hoisted.settings.setCalls.push(partial);
      hoisted.settings.current = { ...hoisted.settings.current, ...(partial as object) };
      return hoisted.settings.current;
    },
    reset: () => hoisted.settings.current
  }
}));

vi.mock('@main/store/history', () => ({
  historyStore: {
    list: () => hoisted.history.list,
    add: (e: unknown) => e,
    remove: (id: string) => {
      hoisted.history.removed.push(id);
    },
    clear: () => {
      hoisted.history.list = [];
    }
  }
}));

import { IPC } from '@shared/ipc';
import { registerIpc, setTrustedSettingsSender } from '@main/ipc/handlers';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface IpcHandler {
  (event: { sender: { id: number } }, ...args: unknown[]): unknown;
}

function getHandler(channel: string): IpcHandler {
  const fn = hoisted.captured.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn as IpcHandler;
}

function fakeEvent(senderId = 1): { sender: { id: number } } {
  return { sender: { id: senderId } };
}

interface MaybeOk {
  ok?: boolean;
  error?: string;
  code?: string;
  value?: unknown;
}

function isFailureResult(v: unknown): v is { ok: false; error: string; code?: string } {
  return typeof v === 'object' && v !== null && (v as MaybeOk).ok === false;
}

// ─── Setup ─────────────────────────────────────────────────────────────────

const triggers = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  getLastAudioError: vi.fn(() => null),
  onApiKeyChanged: vi.fn().mockResolvedValue(undefined),
  onSettingsChanged: vi.fn()
};

beforeAll(() => {
  registerIpc(triggers);
});

beforeEach(() => {
  hoisted.clipboardWriteText.calls.length = 0;
  hoisted.history.removed.length = 0;
  hoisted.settings.setCalls.length = 0;
  hoisted.settings.shouldThrowOnSet = false;
  hoisted.secure.setApiKey = () => Promise.resolve();
  triggers.onSettingsChanged.mockClear();
  triggers.onApiKeyChanged.mockClear();
  setTrustedSettingsSender(null);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('IPC handlers — HISTORY_REMOVE', () => {
  it('rejects an oversize id (>128 chars)', async () => {
    const handler = getHandler(IPC.HISTORY_REMOVE);
    const result = await handler(fakeEvent(), 'a'.repeat(200));
    expect(isFailureResult(result)).toBe(true);
    expect(hoisted.history.removed).toEqual([]);
  });

  it('accepts a valid string id', async () => {
    const handler = getHandler(IPC.HISTORY_REMOVE);
    const result = await handler(fakeEvent(), 'short-id');
    // success returns the list (not an IpcResult shape)
    expect(isFailureResult(result)).toBe(false);
    expect(hoisted.history.removed).toContain('short-id');
  });
});

describe('IPC handlers — APIKEY_SET', () => {
  it('rejects strings shorter than 10 chars', async () => {
    const handler = getHandler(IPC.APIKEY_SET);
    const result = (await handler(fakeEvent(), 'sk-tiny')) as MaybeOk;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_INVALID');
  });

  it('rejects strings longer than 512 chars', async () => {
    const handler = getHandler(IPC.APIKEY_SET);
    const result = (await handler(fakeEvent(), 'sk-' + 'x'.repeat(600))) as MaybeOk;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_INVALID');
  });

  it('rejects non-trusted sender when trusted id is set', async () => {
    setTrustedSettingsSender(42);
    const handler = getHandler(IPC.APIKEY_SET);
    const result = (await handler(fakeEvent(99), 'sk-valid-key-1234567890')) as MaybeOk;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_UNTRUSTED');
  });

  it('accepts from trusted sender when sender id matches', async () => {
    setTrustedSettingsSender(42);
    const calls: unknown[] = [];
    hoisted.secure.setApiKey = (k: unknown) => {
      calls.push(k);
      return Promise.resolve();
    };
    const handler = getHandler(IPC.APIKEY_SET);
    const result = (await handler(fakeEvent(42), 'sk-valid-key-1234567890')) as MaybeOk;
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['sk-valid-key-1234567890']);
    expect(triggers.onApiKeyChanged).toHaveBeenCalled();
  });

  it('accepts from any sender when no trusted id is set', async () => {
    setTrustedSettingsSender(null);
    hoisted.secure.setApiKey = () => Promise.resolve();
    const handler = getHandler(IPC.APIKEY_SET);
    const result = (await handler(fakeEvent(7), 'sk-valid-key-1234567890')) as MaybeOk;
    expect(result.ok).toBe(true);
  });
});

describe('IPC handlers — CLIPBOARD_WRITE', () => {
  it('rejects strings larger than 1MB', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    // 1MB threshold = 1_000_000 chars; pass slightly above.
    const big = 'x'.repeat(1_000_001);
    const result = (await handler(fakeEvent(), big)) as MaybeOk;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_TOO_LARGE');
    expect(hoisted.clipboardWriteText.calls).toEqual([]);
  });

  it('accepts smaller strings and writes to clipboard', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    const result = (await handler(fakeEvent(), 'hello world')) as MaybeOk;
    expect(result.ok).toBe(true);
    expect(hoisted.clipboardWriteText.calls).toEqual(['hello world']);
  });

  it('rejects non-string payload', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    const result = (await handler(fakeEvent(), 12345)) as MaybeOk;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E_INVALID');
  });
});

describe('IPC handlers — SETTINGS_SET', () => {
  it('returns { ok: false, error } on invalid payload and does NOT broadcast', async () => {
    const handler = getHandler(IPC.SETTINGS_SET);
    // invalid: hotkeys must be array of HotkeyBindingSchema; pass a number.
    const result = (await handler(fakeEvent(), { hotkeys: 12345 })) as MaybeOk;
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(triggers.onSettingsChanged).not.toHaveBeenCalled();
  });

  it('accepts a valid partial', async () => {
    const handler = getHandler(IPC.SETTINGS_SET);
    const result = await handler(fakeEvent(), { language: 'en' });
    // success returns the merged Settings object (not IpcResult)
    expect(isFailureResult(result)).toBe(false);
    expect(hoisted.settings.setCalls).toHaveLength(1);
    expect(triggers.onSettingsChanged).toHaveBeenCalledTimes(1);
  });
});
