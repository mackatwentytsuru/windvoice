import Store from 'electron-store';
import { randomUUID } from 'node:crypto';
import { HistoryEntrySchema, MAX_HISTORY, type HistoryEntry } from '@shared/types';

interface HistoryShape {
  entries: HistoryEntry[];
}

class HistoryStore {
  private store: Store<HistoryShape>;

  constructor() {
    this.store = new Store<HistoryShape>({
      name: 'windvoice-history',
      defaults: { entries: [] },
      clearInvalidConfig: true
    });
  }

  list(): HistoryEntry[] {
    const raw = this.store.get('entries', []);
    const parsed = raw
      .map((e) => HistoryEntrySchema.safeParse(e))
      .filter((r): r is { success: true; data: HistoryEntry } => r.success)
      .map((r) => r.data);
    return parsed;
  }

  add(input: { transcript: string; durationMs?: number; app?: string }): HistoryEntry {
    const entry: HistoryEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      transcript: input.transcript,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.app ? { app: input.app } : {})
    };
    const next = [entry, ...this.list()].slice(0, MAX_HISTORY);
    this.store.set('entries', next);
    return entry;
  }

  remove(id: string): void {
    const next = this.list().filter((e) => e.id !== id);
    this.store.set('entries', next);
  }

  clear(): void {
    this.store.set('entries', []);
  }
}

export const historyStore = new HistoryStore();
