import Store from 'electron-store';
import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { HistoryEntrySchema, type HistoryEntry } from '@shared/types';
import { MAX_HISTORY } from '@shared/constants';
import { debug } from '@main/debug';

const MAX_TEXT_LEN = 64 * 1024;
const FLUSH_DEBOUNCE_MS = 500;
const ENC_PREFIX = 'enc:v1:';

interface PersistedEntry {
  id: string;
  timestamp: number;
  transcript: string;
  durationMs?: number;
  app?: string;
}

interface HistoryShape {
  entries: PersistedEntry[];
}

let warnedNoEncryption = false;

function encryptionAvailable(): boolean {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function maybeEncrypt(value: string): string {
  if (!encryptionAvailable()) {
    if (!warnedNoEncryption) {
      warnedNoEncryption = true;
      debug('DICTATION', 'safeStorage encryption unavailable; storing history in plaintext');
    }
    return value;
  }
  try {
    const buf = safeStorage.encryptString(value);
    return ENC_PREFIX + buf.toString('base64');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `safeStorage.encryptString failed, storing plaintext: ${msg}`);
    return value;
  }
}

function maybeDecrypt(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  if (!encryptionAvailable()) return '';
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `safeStorage.decryptString failed: ${msg}`);
    return '';
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_TEXT_LEN) return s;
  return s.slice(0, MAX_TEXT_LEN);
}

class HistoryStore {
  private store: Store<HistoryShape>;
  private cache: HistoryEntry[];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.store = new Store<HistoryShape>({
      name: 'windvoice-history',
      defaults: { entries: [] },
      clearInvalidConfig: true
    });
    this.cache = this.loadFromDisk();
  }

  private loadFromDisk(): HistoryEntry[] {
    const raw = this.store.get('entries', []) as PersistedEntry[];
    const decoded: HistoryEntry[] = [];
    for (const e of raw) {
      if (!e || typeof e !== 'object') continue;
      const transcript = typeof e.transcript === 'string' ? maybeDecrypt(e.transcript) : '';
      const app = typeof e.app === 'string' ? maybeDecrypt(e.app) : undefined;
      const candidate: PersistedEntry = {
        id: e.id,
        timestamp: e.timestamp,
        transcript,
        ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
        ...(app && app.length > 0 ? { app } : {})
      };
      const parsed = HistoryEntrySchema.safeParse(candidate);
      if (parsed.success) decoded.push(parsed.data);
    }
    return decoded;
  }

  list(): HistoryEntry[] {
    return this.cache.slice();
  }

  add(input: { transcript: string; durationMs?: number; app?: string }): HistoryEntry {
    const transcript = truncate(input.transcript);
    const app = input.app ? truncate(input.app) : undefined;
    const entry: HistoryEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      transcript,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(app ? { app } : {})
    };
    this.cache = [entry, ...this.cache].slice(0, MAX_HISTORY);
    this.scheduleFlush();
    return entry;
  }

  remove(id: string): void {
    const before = this.cache.length;
    this.cache = this.cache.filter((e) => e.id !== id);
    if (this.cache.length !== before) this.scheduleFlush();
  }

  clear(): void {
    this.cache = [];
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushSync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const persisted: PersistedEntry[] = this.cache.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      transcript: maybeEncrypt(e.transcript),
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      ...(e.app ? { app: maybeEncrypt(e.app) } : {})
    }));
    try {
      this.store.set('entries', persisted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `history flush failed: ${msg}`);
    }
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
  }
}

export const historyStore = new HistoryStore();

export function flushHistory(): void {
  historyStore.flush();
}
