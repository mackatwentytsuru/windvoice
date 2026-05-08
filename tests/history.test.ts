import { describe, expect, it, beforeEach, vi } from 'vitest';

// Pure in-memory mock for electron-store. Each test gets a fresh map.
const hoisted = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  class FakeStore {
    constructor(_opts?: unknown) {
      // ignore options; we share state across instances within a test
    }
    get(key: string, fallback?: unknown): unknown {
      return data.has(key) ? data.get(key) : fallback;
    }
    set(key: string, value: unknown): void {
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
  return {
    data,
    FakeStore: FakeStore as unknown
  };
});

vi.mock('electron-store', () => ({
  default: hoisted.FakeStore
}));

import { MAX_HISTORY } from '../src/shared/constants';
import type { HistoryEntry } from '../src/shared/types';

describe('historyStore', () => {
  beforeEach(() => {
    hoisted.data.clear();
    vi.resetModules();
  });

  async function freshStore(): Promise<typeof import('../src/main/store/history').historyStore> {
    const { historyStore } = await import('../src/main/store/history');
    return historyStore;
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
});
