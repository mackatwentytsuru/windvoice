import Store from 'electron-store';
import { BrowserWindow, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { HistoryEntrySchema, type HistoryEntry } from '@shared/types';
import { MAX_HISTORY } from '@shared/constants';
import { IPC } from '@shared/ipc';
import { debug } from '@main/debug';
import { enforcePrivateFileMode } from '@main/store/privateMode';

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

/**
 * HIGH: in-memory cache entry. Extends the public `HistoryEntry` with
 * non-schema passthrough fields used ONLY when a stored value was
 * ciphertext we could not decrypt at load (keyring transiently locked or
 * `decryptString` threw). In that case we retain the ORIGINAL ciphertext
 * verbatim so a later `flushSync()` re-emits it unchanged instead of
 * overwriting still-valid ciphertext with a blanked transcript. These
 * fields never leave the store — `toPublicEntry` strips them.
 */
interface CachedEntry extends HistoryEntry {
  /** Original `enc:v1:` transcript string, retained when decryption failed. */
  rawTranscript?: string;
  /** Original `enc:v1:` app string, retained when decryption failed. */
  rawApp?: string;
  /** True when this entry could not be decrypted and must be hidden from the UI. */
  undecryptable?: boolean;
}

interface DecryptResult {
  /** Decrypted plaintext, or '' when the ciphertext could not be decrypted. */
  value: string;
  /** True when the stored value was ciphertext we could NOT decrypt. */
  failed: boolean;
}

function toPublicEntry(e: CachedEntry): HistoryEntry {
  const { rawTranscript: _t, rawApp: _a, undecryptable: _u, ...pub } = e;
  return pub;
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

function broadcastSystemError(message: string): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.SYSTEM_ERROR, { source: 'storage', message, kind: 'setup' });
    }
  } catch {
    /* broadcast must never break the storage path */
  }
}

function maybeEncrypt(value: string): string {
  if (!encryptionAvailable()) {
    if (!warnedNoEncryption) {
      warnedNoEncryption = true;
      debug('DICTATION', 'safeStorage encryption unavailable; storing history in plaintext');
      broadcastSystemError('History is being stored unencrypted (system keyring unavailable)');
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

/**
 * HIGH: decrypt a stored value, distinguishing "plaintext / decrypted
 * fine" from "ciphertext we could NOT read". The previous `maybeDecrypt`
 * collapsed BOTH a transient `encryptionAvailable() === false` and a
 * `decryptString` throw to '' — which then got re-serialized over the
 * good ciphertext on the next add/remove/clear, turning a brief keychain
 * lock into permanent total data loss. Callers now retain the original
 * ciphertext when `failed` is true and never persist a blank in its place.
 */
function tryDecrypt(value: string): DecryptResult {
  if (!value.startsWith(ENC_PREFIX)) return { value, failed: false };
  if (!encryptionAvailable()) return { value: '', failed: true };
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
    return { value: safeStorage.decryptString(buf), failed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `safeStorage.decryptString failed: ${msg}`);
    return { value: '', failed: true };
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_TEXT_LEN) return s;
  return s.slice(0, MAX_TEXT_LEN);
}

class HistoryStore {
  private store: Store<HistoryShape>;
  private cache: CachedEntry[];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /**
   * HIGH: set true when at least one stored entry failed to decrypt at
   * load (transient keyring lock or `decryptString` throw). Those entries
   * are hidden from the UI list but their ciphertext is preserved verbatim
   * on every flush, so the data returns once the keyring unlocks.
   */
  public loadDegraded = false;
  /**
   * MEDIUM-5: when `flushSync` throws (transient EBUSY on Windows
   * because an antivirus is scanning the JSON, ENOSPC, etc.), the
   * previous code left `dirty=true` so the NEXT add/remove would
   * retry — but if the user never dictated again, that pending data
   * stayed unwritten forever. Schedule a single deferred retry so the
   * cached delta lands on disk even when activity has gone quiet.
   */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RETRY_DELAY_MS = 5_000;

  constructor() {
    this.store = new Store<HistoryShape>({
      name: 'windvoice-history',
      defaults: { entries: [] },
      clearInvalidConfig: true
    });
    enforcePrivateFileMode(this.store.path);
    this.cache = this.loadFromDisk();
  }

  private loadFromDisk(): CachedEntry[] {
    const raw = this.store.get('entries', []) as PersistedEntry[];
    const decoded: CachedEntry[] = [];
    for (const e of raw) {
      if (!e || typeof e !== 'object') continue;
      const transcriptStored = typeof e.transcript === 'string' ? e.transcript : '';
      const appStored = typeof e.app === 'string' ? e.app : undefined;
      // HIGH: decrypt without collapsing undecryptable ciphertext to ''.
      const tRes = tryDecrypt(transcriptStored);
      const aRes: DecryptResult =
        appStored !== undefined ? tryDecrypt(appStored) : { value: '', failed: false };
      const app = aRes.value;
      const candidate: PersistedEntry = {
        id: e.id,
        timestamp: e.timestamp,
        transcript: tRes.value,
        ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
        ...(app && app.length > 0 ? { app } : {})
      };
      const parsed = HistoryEntrySchema.safeParse(candidate);
      if (!parsed.success) continue;
      const cached: CachedEntry = { ...parsed.data };
      if (tRes.failed) {
        // HIGH: retain the ORIGINAL ciphertext so flushSync re-emits it
        // verbatim instead of overwriting it with the blanked transcript.
        cached.rawTranscript = transcriptStored;
        cached.undecryptable = true;
      }
      if (aRes.failed && appStored !== undefined) {
        cached.rawApp = appStored;
        cached.undecryptable = true;
      }
      if (tRes.failed || aRes.failed) this.loadDegraded = true;
      decoded.push(cached);
    }
    return decoded;
  }

  list(): HistoryEntry[] {
    // HIGH: hide entries that could not be decrypted (their plaintext is
    // unknown right now) — but they stay in `cache` so flushSync keeps
    // re-persisting their original ciphertext until the keyring unlocks.
    return this.cache.filter((e) => !e.undecryptable).map(toPublicEntry);
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
    const persisted: PersistedEntry[] = this.cache.map((e) => {
      // HIGH: for entries we could not decrypt at load, re-emit the
      // retained original ciphertext verbatim — NEVER re-encrypt a blanked
      // transcript over still-valid ciphertext.
      const transcript =
        e.rawTranscript !== undefined ? e.rawTranscript : maybeEncrypt(e.transcript);
      const app = e.rawApp !== undefined ? e.rawApp : e.app ? maybeEncrypt(e.app) : undefined;
      return {
        id: e.id,
        timestamp: e.timestamp,
        transcript,
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(app !== undefined ? { app } : {})
      };
    });
    try {
      this.store.set('entries', persisted);
      enforcePrivateFileMode(this.store.path);
      // Clear `dirty` only after a successful write. If the write throws
      // we leave it set so the next scheduleFlush retries — otherwise the
      // in-memory cache would diverge from disk permanently (next add /
      // remove sets dirty=true but the failed entry is also dirty=false).
      this.dirty = false;
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `history flush failed: ${msg}`);
      // MEDIUM-5: schedule a deferred retry so the dirty cache eventually
      // reaches disk even if no further add/remove triggers a new flush
      // (an antivirus EBUSY can persist for several seconds). Only one
      // retry is in flight at a time; the next failed flush re-arms it.
      // The timer is unref()'d so a pending retry never blocks app quit.
      if (this.retryTimer === null) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flushSync();
        }, HistoryStore.RETRY_DELAY_MS);
        if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
      }
    }
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.flushSync();
  }
}

export const historyStore = new HistoryStore();

export function flushHistory(): void {
  historyStore.flush();
}
