import { constants, watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { debug } from '@main/debug';
import {
  UserDictionarySchema,
  type DictionaryCorrection,
  type UserDictionary,
  type UserDictionaryEntry
} from './schema';

const USER_DICTIONARY_FILE = 'user-dictionary.json';
const WATCH_PROBE_FILE = '.user-dictionary-watch-probe';
const CONTEXT_DEPENDENT_MARKER = '文脈依存';
const WATCH_DEBOUNCE_MS = 75;
const WATCH_ARM_ATTEMPTS = 20;
const WATCH_ARM_INTERVAL_MS = 50;
const REALTIME_UNSAFE_KEYWORD = /[<>\r\n]/;

export interface UserDictionaryReader {
  apply(text: string): string;
  getVocabularyHints(): string[];
}

export const emptyUserDictionary: UserDictionaryReader = {
  apply: (text) => text,
  getVocabularyHints: () => []
};

export interface UserDictionaryStoreOptions {
  userDataDir: string;
  seedPath: string;
  watch?: boolean;
  /** Test seam; production always uses node:fs.watch. */
  watchFactory?: typeof watch;
}

function cloneDictionary(dictionary: UserDictionary): UserDictionary {
  return {
    ...dictionary,
    entries: dictionary.entries.map((entry) => ({
      ...entry,
      variants: [...entry.variants]
    }))
  };
}

/** Normalize duplicate entries/variants while retaining their first-seen order. */
export function normalizeDictionary(dictionary: UserDictionary): UserDictionary {
  const base = cloneDictionary(UserDictionarySchema.parse(dictionary));
  const byCorrect = new Map<string, UserDictionaryEntry>();
  const variantOwners = new Map<string, string>();

  for (const candidate of base.entries) {
    const correct = candidate.correct.trim();
    if (!correct) continue;
    let entry = byCorrect.get(correct);
    if (!entry) {
      entry = {
        correct,
        variants: [],
        ...(candidate.context !== undefined ? { context: candidate.context } : {})
      };
      byCorrect.set(correct, entry);
    } else if (!entry.context && candidate.context) {
      entry.context = candidate.context;
    }

    for (const rawVariant of candidate.variants) {
      const variant = rawVariant.trim();
      if (!variant || variant === correct || variantOwners.has(variant)) continue;
      entry.variants.push(variant);
      variantOwners.set(variant, correct);
    }
  }

  return { ...base, entries: [...byCorrect.values()] };
}

/**
 * Deterministic literal replacement. Longer variants run first so a short
 * alias cannot consume the prefix of a more specific alias. Entries marked
 * 文脈依存 are intentionally excluded until contextual matching exists.
 */
export function applyDictionary(text: string, dictionary: UserDictionary): string {
  const replacements = dictionary.entries
    .filter((entry) => !entry.context?.includes(CONTEXT_DEPENDENT_MARKER))
    .flatMap((entry, entryIndex) =>
      entry.variants.map((variant, variantIndex) => ({
        variant,
        correct: entry.correct,
        order: entryIndex * 10_000 + variantIndex
      }))
    )
    .filter(({ variant, correct }) => variant.length > 0 && variant !== correct)
    .sort((a, b) => b.variant.length - a.variant.length || a.order - b.order);

  let output = text;
  for (const { variant, correct } of replacements) {
    if (output.includes(variant)) output = output.split(variant).join(correct);
  }
  return output;
}

/** Merge one learned pair and make the latest explicit owner unambiguous. */
export function mergeCorrection(
  dictionary: UserDictionary,
  correction: DictionaryCorrection
): UserDictionary {
  const variant = correction.variant.trim();
  const correct = correction.correct.trim();
  if (!variant || !correct) throw new Error('Correction values must not be empty');
  if (variant === correct) return normalizeDictionary(dictionary);

  const next = normalizeDictionary(dictionary);
  for (const entry of next.entries) {
    entry.variants = entry.variants.filter((item) => item !== variant);
  }
  let target = next.entries.find((entry) => entry.correct === correct);
  if (!target) {
    target = { correct, variants: [] };
    next.entries.push(target);
  }
  if (!target.variants.includes(variant)) target.variants.push(variant);
  return next;
}

export class UserDictionaryStore implements UserDictionaryReader {
  readonly filePath: string;
  private current: UserDictionary = { version: 1, entries: [] };
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private watchArmResolve: (() => void) | null = null;
  private listeners = new Set<(dictionary: UserDictionary) => void>();
  private serialized = '';
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: UserDictionaryStoreOptions) {
    this.filePath = path.join(options.userDataDir, USER_DICTIONARY_FILE);
  }

  async init(): Promise<void> {
    await mkdir(this.options.userDataDir, { recursive: true });
    try {
      await copyFile(this.options.seedPath, this.filePath, constants.COPYFILE_EXCL);
      debug('MAIN', `created user dictionary from seed: ${this.filePath}`);
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'EEXIST') throw err;
    }

    if (this.options.watch !== false) await this.startWatching();

    if (!(await this.reload())) {
      // A corrupt user file must not brick dictation. Keep it untouched for
      // manual recovery and use the packaged seed in memory for this run.
      const seed = UserDictionarySchema.parse(JSON.parse(await readFile(this.options.seedPath, 'utf8')));
      this.setCurrent(normalizeDictionary(seed), false);
      debug('MAIN', 'user dictionary invalid; using packaged seed in memory');
    }
  }

  apply(text: string): string {
    return applyDictionary(text, this.current);
  }

  getVocabularyHints(): string[] {
    const seen = new Set<string>();
    const hints: string[] = [];
    for (const entry of this.current.entries) {
      const keyword = entry.correct.trim();
      if (!keyword || REALTIME_UNSAFE_KEYWORD.test(keyword) || seen.has(keyword)) continue;
      seen.add(keyword);
      hints.push(keyword);
    }
    return hints;
  }

  getSnapshot(): UserDictionary {
    return cloneDictionary(this.current);
  }

  onDidChange(listener: (dictionary: UserDictionary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async addCorrection(correction: DictionaryCorrection): Promise<UserDictionary> {
    return this.enqueueMutation(async () => {
      // Pull in an edit made directly on disk just before this CLI request so
      // the explicit correction merges with it instead of overwriting it.
      await this.reloadFromDisk();
      const next = mergeCorrection(this.current, correction);
      await this.persist(next);
      this.setCurrent(next, true);
      return this.getSnapshot();
    });
  }

  /** Merge entries from the legacy Settings-page dictionary without deleting seed data. */
  async mergeLegacy(entries: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.reloadFromDisk();
      let next = this.current;
      for (const entry of entries) {
        if (!entry.from.trim() || !entry.to.trim()) continue;
        next = mergeCorrection(next, { variant: entry.from, correct: entry.to });
      }
      if (serialize(next) === this.serialized) return;
      await this.persist(next);
      this.setCurrent(next, true);
    });
  }

  async reload(): Promise<boolean> {
    return this.enqueueMutation(() => this.reloadFromDisk());
  }

  private async reloadFromDisk(): Promise<boolean> {
    try {
      const parsed = UserDictionarySchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      const next = normalizeDictionary(parsed);
      const changed = serialize(next) !== this.serialized;
      this.setCurrent(next, changed && this.serialized.length > 0);
      return true;
    } catch (err) {
      debug('MAIN', `user dictionary reload rejected: ${errMsg(err)}`);
      return false;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.watchArmResolve = null;
    this.listeners.clear();
  }

  private async persist(dictionary: UserDictionary): Promise<void> {
    const normalized = normalizeDictionary(dictionary);
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private setCurrent(dictionary: UserDictionary, notify: boolean): void {
    this.current = normalizeDictionary(dictionary);
    this.serialized = serialize(this.current);
    if (!notify) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        debug('MAIN', `user dictionary listener failed: ${errMsg(err)}`);
      }
    }
  }

  private async startWatching(): Promise<void> {
    const armed = new Promise<void>((resolve) => {
      this.watchArmResolve = resolve;
    });
    const watchDirectory = this.options.watchFactory ?? watch;
    this.watcher = watchDirectory(this.options.userDataDir, { persistent: false }, (_event, filename) => {
      const name = filename == null ? null : path.basename(filename.toString());
      if (this.watchArmResolve && (name === null || name === WATCH_PROBE_FILE)) {
        this.watchArmResolve();
        if (name === WATCH_PROBE_FILE || name === null) return;
      }
      // A null filename means the backend cannot identify the changed entry.
      // Re-read safely instead of silently dropping a real external edit.
      if (name !== null && name !== USER_DICTIONARY_FILE) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        void this.reload();
      }, WATCH_DEBOUNCE_MS);
      if (typeof this.reloadTimer.unref === 'function') this.reloadTimer.unref();
    });
    this.watcher.on('error', (err) => debug('MAIN', `user dictionary watcher failed: ${errMsg(err)}`));

    const probePath = path.join(this.options.userDataDir, WATCH_PROBE_FILE);
    let observed = false;
    try {
      for (let attempt = 0; attempt < WATCH_ARM_ATTEMPTS; attempt++) {
        await writeFile(probePath, `${Date.now()}-${attempt}`, 'utf8');
        observed = await Promise.race([
          armed.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), WATCH_ARM_INTERVAL_MS)
          )
        ]);
        if (observed) break;
      }
      if (!observed) {
        debug('MAIN', 'user dictionary watcher readiness probe timed out');
      }
    } finally {
      this.watchArmResolve = null;
      await rm(probePath, { force: true }).catch(() => undefined);
    }
  }
}

function serialize(dictionary: UserDictionary): string {
  return JSON.stringify(dictionary);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
