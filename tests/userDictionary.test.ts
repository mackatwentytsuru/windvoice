import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UserDictionaryStore,
  applyDictionary,
  mergeCorrection
} from '../src/main/dictionary/userDictionary';
import {
  UserDictionarySchema,
  type UserDictionary
} from '../src/main/dictionary/schema';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'windvoice-dictionary-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('user dictionary schema and replacement', () => {
  it('accepts the committed seed dictionary as the formal schema', async () => {
    const raw = JSON.parse(
      await readFile(path.join(process.cwd(), 'dictionary', 'seed-corrections.ja.json'), 'utf8')
    );
    expect(UserDictionarySchema.parse(raw).entries.length).toBeGreaterThan(0);
  });

  it('replaces variants with the canonical spelling before injection', () => {
    const dictionary: UserDictionary = {
      version: 1,
      entries: [
        { correct: '9950X', variants: ['QQ50X', '九九五〇X'] },
        { correct: 'windvoice', variants: ['ウィンドボイス'] }
      ]
    };

    expect(applyDictionary('QQ50Xでウィンドボイスを動かす', dictionary)).toBe(
      '9950Xでwindvoiceを動かす'
    );
  });

  it('matches longer variants first so overlapping entries are deterministic', () => {
    const dictionary: UserDictionary = {
      version: 1,
      entries: [
        { correct: '短', variants: ['キング'] },
        { correct: '金剛', variants: ['キングオー'] }
      ]
    };
    expect(applyDictionary('キングオー', dictionary)).toBe('金剛');
  });

  it('skips every entry explicitly marked as context-dependent', () => {
    const dictionary: UserDictionary = {
      version: 1,
      entries: [
        {
          correct: '同期',
          variants: ['真空', 'シンク'],
          context: 'sync。文脈依存のため置換は慎重に'
        }
      ]
    };
    expect(applyDictionary('真空パックとシンクを掃除する', dictionary)).toBe(
      '真空パックとシンクを掃除する'
    );
  });
});

describe('dictionary merge', () => {
  it('merges a correction into the canonical entry and deduplicates variants', () => {
    const source: UserDictionary = {
      version: 1,
      entries: [{ correct: '翔鶴', variants: ['昇格'], context: '艦名' }]
    };
    const once = mergeCorrection(source, { variant: 'しょうかく', correct: '翔鶴' });
    const twice = mergeCorrection(once, { variant: 'しょうかく', correct: '翔鶴' });
    expect(twice.entries).toEqual([
      { correct: '翔鶴', variants: ['昇格', 'しょうかく'], context: '艦名' }
    ]);
  });

  it('moves a variant away from an older conflicting canonical entry', () => {
    const source: UserDictionary = {
      version: 1,
      entries: [
        { correct: '旧', variants: ['同音'] },
        { correct: '新', variants: [] }
      ]
    };
    expect(mergeCorrection(source, { variant: '同音', correct: '新' }).entries).toEqual([
      { correct: '旧', variants: [] },
      { correct: '新', variants: ['同音'] }
    ]);
  });
});

describe('UserDictionaryStore', () => {
  it('copies the seed on first launch and loads it from user data', async () => {
    const root = await tempDir();
    const seedPath = path.join(root, 'seed.json');
    const userDataDir = path.join(root, 'appdata');
    const seed: UserDictionary = {
      version: 1,
      entries: [{ correct: 'Codex', variants: ['コードックス'] }]
    };
    await writeFile(seedPath, JSON.stringify(seed), 'utf8');

    const store = new UserDictionaryStore({ userDataDir, seedPath, watch: false });
    await store.init();
    expect(store.apply('コードックス')).toBe('Codex');
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(seed);
    store.dispose();
  });

  it('reloads a valid external file change while retaining the last good value on invalid JSON', async () => {
    const root = await tempDir();
    const seedPath = path.join(root, 'seed.json');
    const userDataDir = path.join(root, 'appdata');
    await writeFile(
      seedPath,
      JSON.stringify({ version: 1, entries: [{ correct: 'A', variants: ['a'] }] }),
      'utf8'
    );
    const store = new UserDictionaryStore({ userDataDir, seedPath, watch: false });
    await store.init();

    await writeFile(
      store.filePath,
      JSON.stringify({ version: 1, entries: [{ correct: 'B', variants: ['b'] }] }),
      'utf8'
    );
    await store.reload();
    expect(store.apply('a b')).toBe('a B');

    await writeFile(store.filePath, '{broken', 'utf8');
    await expect(store.reload()).resolves.toBe(false);
    expect(store.apply('b')).toBe('B');
    store.dispose();
  });

  it('notifies listeners after addCorrection persists a merged update', async () => {
    const root = await tempDir();
    const seedPath = path.join(root, 'seed.json');
    const userDataDir = path.join(root, 'appdata');
    await writeFile(seedPath, JSON.stringify({ version: 1, entries: [] }), 'utf8');
    const store = new UserDictionaryStore({ userDataDir, seedPath, watch: false });
    await store.init();
    let notifications = 0;
    const off = store.onDidChange(() => notifications++);

    await store.addCorrection({ variant: 'コードックス', correct: 'Codex' });

    expect(store.apply('コードックス')).toBe('Codex');
    expect(store.getVocabularyHints()).toEqual(['Codex']);
    expect(notifications).toBe(1);
    off();
    store.dispose();
  });

  it('serializes concurrent corrections so no learned pair is lost', async () => {
    const root = await tempDir();
    const seedPath = path.join(root, 'seed.json');
    const userDataDir = path.join(root, 'appdata');
    await writeFile(seedPath, JSON.stringify({ version: 1, entries: [] }), 'utf8');
    const store = new UserDictionaryStore({ userDataDir, seedPath, watch: false });
    await store.init();

    await Promise.all([
      store.addCorrection({ variant: 'コードックス', correct: 'Codex' }),
      store.addCorrection({ variant: 'コードクス', correct: 'Codex' })
    ]);

    expect(store.getSnapshot().entries).toEqual([
      { correct: 'Codex', variants: ['コードックス', 'コードクス'] }
    ]);
    store.dispose();
  });

  it('reloads after the user-dictionary file changes on disk', async () => {
    const root = await tempDir();
    const seedPath = path.join(root, 'seed.json');
    const userDataDir = path.join(root, 'appdata');
    await writeFile(
      seedPath,
      JSON.stringify({ version: 1, entries: [{ correct: 'A', variants: ['a'] }] }),
      'utf8'
    );
    let emitWatchChange: ((filename: string | null) => void) | null = null;
    const fakeWatcher = {
      close: vi.fn(),
      on: vi.fn()
    };
    fakeWatcher.on.mockReturnValue(fakeWatcher);
    const watchFactory = vi.fn(
      (
        _dir: string,
        _options: { persistent: boolean },
        listener: (_event: string, filename: string | null) => void
      ) => {
        emitWatchChange = (filename) => listener('change', filename);
        queueMicrotask(() => emitWatchChange?.('.user-dictionary-watch-probe'));
        return fakeWatcher;
      }
    );
    const store = new UserDictionaryStore({
      userDataDir,
      seedPath,
      watchFactory: watchFactory as never
    });
    await store.init();
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dictionary watcher timed out')), 3_000);
      const off = store.onDidChange(() => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });

    await writeFile(
      store.filePath,
      JSON.stringify({ version: 1, entries: [{ correct: 'B', variants: ['b'] }] }),
      'utf8'
    );
    emitWatchChange?.('user-dictionary.json');
    await changed;

    expect(store.apply('b')).toBe('B');
    store.dispose();
  });

  it('filters unsafe Realtime keyword characters without dropping local replacements', async () => {
    const root = await tempDir();
    const seedPath = path.join(root, 'seed.json');
    await writeFile(
      seedPath,
      JSON.stringify({
        version: 1,
        entries: [
          { correct: 'safe', variants: ['s'] },
          { correct: 'bad\nkeyword', variants: ['b'] },
          { correct: '<tag>', variants: ['t'] }
        ]
      }),
      'utf8'
    );
    const store = new UserDictionaryStore({
      userDataDir: path.join(root, 'appdata'),
      seedPath,
      watch: false
    });
    await store.init();
    expect(store.getVocabularyHints()).toEqual(['safe']);
    expect(store.apply('b t')).toBe('bad\nkeyword <tag>');
    store.dispose();
  });
});
