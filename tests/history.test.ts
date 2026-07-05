import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Pure in-memory mock for electron-store. Each test gets a fresh map.
const hoisted = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const setSpy = vi.fn();
  class FakeStore {
    constructor(_opts?: unknown) {
      // ignore options; we share state across instances within a test
    }
    get(key: string, fallback?: unknown): unknown {
      return data.has(key) ? data.get(key) : fallback;
    }
    set(key: string, value: unknown): void {
      setSpy(key, value);
      data.set(key, value);
    }
    get store(): Record<string, unknown> {
      return Object.fromEntries(data.entries());
    }
    set store(v: Record<string, unknown>) {
      data.clear();
      for (const [k, val] of Object.entries(v)) data.set(k, val);
    }
  }
  // safeStorage mock: tests can flip these per case.
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from('enc:' + s, 'utf8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, ''))
  };
  return {
    data,
    setSpy,
    safeStorage,
    FakeStore: FakeStore as unknown
  };
});

vi.mock('electron-store', () => ({
  default: hoisted.FakeStore
}));

vi.mock('electron', () => ({
  safeStorage: hoisted.safeStorage
}));

import { MAX_HISTORY } from '../src/shared/constants';
import type { HistoryEntry } from '../src/shared/types';

describe('historyStore', () => {
  beforeEach(() => {
    hoisted.data.clear();
    hoisted.setSpy.mockClear();
    hoisted.safeStorage.isEncryptionAvailable.mockReset();
    hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    hoisted.safeStorage.encryptString.mockClear();
    hoisted.safeStorage.encryptString.mockImplementation((s: string) =>
      Buffer.from('enc:' + s, 'utf8')
    );
    hoisted.safeStorage.decryptString.mockClear();
    hoisted.safeStorage.decryptString.mockImplementation((b: Buffer) =>
      b.toString('utf8').replace(/^enc:/, '')
    );
    vi.resetModules();
  });

  async function freshStore(): Promise<typeof import('../src/main/store/history').historyStore> {
    const { historyStore } = await import('../src/main/store/history');
    return historyStore;
  }

  async function freshModule(): Promise<typeof import('../src/main/store/history')> {
    return await import('../src/main/store/history');
  }

  it('starts empty', async () => {
    const store = await freshStore();
    expect(store.list()).toEqual([]);
  });

  it('add() prepends a new entry with id+timestamp+transcript', async () => {
    const store = await freshStore();
    const entry = store.add({ transcript: 'hello' });
    expect(entry.id).toMatch(/^[0-9a-f-]+$/i);
    expect(typeof entry.timestamp).toBe('number');
    expect(entry.transcript).toBe('hello');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toEqual(entry);
  });

  it('newest entries come first', async () => {
    const store = await freshStore();
    store.add({ transcript: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    store.add({ transcript: 'second' });
    const list = store.list();
    expect(list[0]?.transcript).toBe('second');
    expect(list[1]?.transcript).toBe('first');
  });

  it('caps at MAX_HISTORY entries', async () => {
    const store = await freshStore();
    for (let i = 0; i < MAX_HISTORY + 30; i++) {
      store.add({ transcript: `entry ${i}` });
    }
    expect(store.list()).toHaveLength(MAX_HISTORY);
    // The newest entry survives.
    expect(store.list()[0]?.transcript).toBe(`entry ${MAX_HISTORY + 29}`);
  });

  it('remove() drops the entry by id', async () => {
    const store = await freshStore();
    const a = store.add({ transcript: 'a' });
    const b = store.add({ transcript: 'b' });
    store.remove(a.id);
    expect(store.list().map((e) => e.id)).toEqual([b.id]);
  });

  it('remove() ignores unknown ids', async () => {
    const store = await freshStore();
    store.add({ transcript: 'a' });
    store.remove('does-not-exist');
    expect(store.list()).toHaveLength(1);
  });

  it('clear() empties the store', async () => {
    const store = await freshStore();
    store.add({ transcript: 'a' });
    store.add({ transcript: 'b' });
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('list() filters out entries that fail Zod validation', async () => {
    // Inject a corrupt entry directly into the backing store.
    hoisted.data.set('entries', [
      { id: 'good', timestamp: 1, transcript: 'ok' } as HistoryEntry,
      { id: 'bad', timestamp: 'not-a-number', transcript: 'corrupt' } as unknown as HistoryEntry
    ]);
    const store = await freshStore();
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('good');
  });

  it('preserves optional fields (durationMs, app)', async () => {
    const store = await freshStore();
    const entry = store.add({ transcript: 'x', durationMs: 1234, app: 'Notepad' });
    expect(entry.durationMs).toBe(1234);
    expect(entry.app).toBe('Notepad');
    expect(store.list()[0]?.durationMs).toBe(1234);
  });

  describe('encryption (safeStorage)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('encrypts persisted entries when isEncryptionAvailable() is true', async () => {
      hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(true);
      vi.useFakeTimers();
      const { historyStore, flushHistory } = await freshModule();
      historyStore.add({ transcript: 'top secret transcript', app: 'AppName' });
      flushHistory();

      expect(hoisted.safeStorage.encryptString).toHaveBeenCalled();
      const persisted = hoisted.data.get('entries') as Array<{ transcript: string; app?: string }>;
      expect(persisted).toHaveLength(1);
      // Plaintext must NOT appear; encrypted form has the prefix marker.
      expect(persisted[0]!.transcript).toMatch(/^enc:v1:/);
      expect(persisted[0]!.transcript).not.toContain('top secret transcript');
      expect(persisted[0]!.app).toMatch(/^enc:v1:/);
      expect(persisted[0]!.app).not.toContain('AppName');
    });

    it('falls back to plaintext when isEncryptionAvailable() is false', async () => {
      hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      vi.useFakeTimers();
      const { historyStore, flushHistory } = await freshModule();
      historyStore.add({ transcript: 'plain text saved' });
      flushHistory();

      expect(hoisted.safeStorage.encryptString).not.toHaveBeenCalled();
      const persisted = hoisted.data.get('entries') as Array<{ transcript: string }>;
      expect(persisted[0]!.transcript).toBe('plain text saved');
    });

    it('reads plaintext entries (backward-compatible: no enc:v1: prefix)', async () => {
      hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(true);
      hoisted.data.set('entries', [
        { id: 'legacy', timestamp: 1700000000000, transcript: 'legacy plain' }
      ]);
      const store = await freshStore();
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.transcript).toBe('legacy plain');
      // No decryption attempted on plaintext entries.
      expect(hoisted.safeStorage.decryptString).not.toHaveBeenCalled();
    });

    it('reads encrypted entries (backward-compatible: enc:v1: prefix)', async () => {
      hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(true);
      const cipherBuf = Buffer.from('enc:secret-content', 'utf8');
      const encoded = 'enc:v1:' + cipherBuf.toString('base64');
      hoisted.data.set('entries', [
        { id: 'encx', timestamp: 1700000000000, transcript: encoded }
      ]);
      const store = await freshStore();
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.transcript).toBe('secret-content');
      expect(hoisted.safeStorage.decryptString).toHaveBeenCalled();
    });

    // HIGH: a transient keyring lock at load (isEncryptionAvailable() === false)
    // must NOT blank pre-existing ciphertext. The undecryptable entry is hidden
    // from the UI list, but its original ciphertext is preserved verbatim on the
    // next flush — even though a brand-new add() re-serializes the WHOLE cache.
    it('does NOT overwrite undecryptable ciphertext when encryption is transiently unavailable', async () => {
      const cipher = 'enc:v1:' + Buffer.from('enc:still valid secret', 'utf8').toString('base64');
      hoisted.data.set('entries', [
        { id: 'enc-old', timestamp: 1700000000000, transcript: cipher }
      ]);
      hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(false);
      vi.useFakeTimers();
      const { historyStore, flushHistory } = await freshModule();

      // The undecryptable entry is hidden from the UI (its plaintext is unknown).
      expect(historyStore.list()).toHaveLength(0);

      // A new dictation arrives and triggers a full-cache re-serialization.
      historyStore.add({ transcript: 'new dictation' });
      flushHistory();

      const persisted = hoisted.data.get('entries') as Array<{ id: string; transcript: string }>;
      const old = persisted.find((p) => p.id === 'enc-old');
      // Original ciphertext re-emitted UNCHANGED — not blanked, not re-encrypted.
      expect(old).toBeDefined();
      expect(old!.transcript).toBe(cipher);
      // The new entry is still persisted alongside it.
      expect(persisted.some((p) => p.transcript === 'new dictation')).toBe(true);
    });

    // HIGH: same guarantee when decryptString THROWS (corrupt buffer / keyring
    // hiccup) even though isEncryptionAvailable() reports true.
    it('preserves ciphertext when decryptString throws at load', async () => {
      const cipher = 'enc:v1:' + Buffer.from('enc:secret', 'utf8').toString('base64');
      hoisted.data.set('entries', [
        { id: 'enc-throw', timestamp: 1700000000000, transcript: cipher }
      ]);
      hoisted.safeStorage.isEncryptionAvailable.mockReturnValue(true);
      hoisted.safeStorage.decryptString.mockImplementation(() => {
        throw new Error('decrypt failed');
      });
      vi.useFakeTimers();
      const { historyStore, flushHistory } = await freshModule();

      expect(historyStore.list()).toHaveLength(0);

      historyStore.add({ transcript: 'fresh' });
      flushHistory();

      const persisted = hoisted.data.get('entries') as Array<{ id: string; transcript: string }>;
      const stuck = persisted.find((p) => p.id === 'enc-throw');
      expect(stuck!.transcript).toBe(cipher);
    });
  });

  describe('truncation', () => {
    it('caps stored transcript length at ~64KB', async () => {
      const store = await freshStore();
      const big = 'x'.repeat(70 * 1024);
      const entry = store.add({ transcript: big });
      expect(entry.transcript.length).toBeLessThanOrEqual(64 * 1024);
      expect(entry.transcript.length).toBe(64 * 1024);
    });
  });

  describe('debounced flush', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('multiple add() calls within the debounce window result in a single write', async () => {
      vi.useFakeTimers();
      const { historyStore } = await freshModule();
      hoisted.setSpy.mockClear();
      historyStore.add({ transcript: 'a' });
      historyStore.add({ transcript: 'b' });
      historyStore.add({ transcript: 'c' });
      // Within the debounce window, no write yet.
      expect(hoisted.setSpy).not.toHaveBeenCalled();
      // Advance past the debounce.
      vi.advanceTimersByTime(600);
      expect(hoisted.setSpy).toHaveBeenCalledTimes(1);
    });

    it('flushHistory() forces an immediate write', async () => {
      vi.useFakeTimers();
      const { historyStore, flushHistory } = await freshModule();
      hoisted.setSpy.mockClear();
      historyStore.add({ transcript: 'now' });
      expect(hoisted.setSpy).not.toHaveBeenCalled();
      flushHistory();
      expect(hoisted.setSpy).toHaveBeenCalledTimes(1);
      // The pending debounce timer must not produce a second write.
      vi.advanceTimersByTime(1000);
      expect(hoisted.setSpy).toHaveBeenCalledTimes(1);
    });
  });
});
