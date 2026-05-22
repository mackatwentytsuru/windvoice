import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

const hoisted = vi.hoisted(() => {
  const fsState = {
    files: new Map<string, string>()
  };
  return {
    fsState,
    clipboardText: '',
    writeText: vi.fn((text: string) => {
      hoisted.clipboardText = text;
    }),
    readText: vi.fn(() => hoisted.clipboardText),
    clearClip: vi.fn(() => {
      hoisted.clipboardText = '';
    }),
    keyTap: vi.fn(),
    getPath: vi.fn(() => '/tmp/test-userdata'),
    writeFileSync: vi.fn((p: string, data: string) => {
      fsState.files.set(p, data);
    }),
    readFileSync: vi.fn((p: string) => {
      const v = fsState.files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    }),
    existsSync: vi.fn((p: string) => fsState.files.has(p)),
    unlinkSync: vi.fn((p: string) => {
      fsState.files.delete(p);
    })
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: hoisted.getPath
  },
  clipboard: {
    writeText: hoisted.writeText,
    readText: hoisted.readText,
    clear: hoisted.clearClip,
    // v0.1.5.1 LOW-1: typer.ts now consults `availableFormats()` to skip
    // the persist/restore dance when the clipboard holds a non-text
    // payload. The tests intentionally exercise the text path, so the
    // default mock advertises text/plain.
    availableFormats: vi.fn(() => ['text/plain'])
  },
  // v0.1.2: typer.ts now persists the previous clipboard via `safeStorage`
  // when available, falling back to plaintext. The tests exercise the
  // plaintext path by returning `false` from `isEncryptionAvailable()`.
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(() => Buffer.from('')),
    decryptString: vi.fn(() => '')
  }
}));

// On Windows, the production sendCtrlVAtomic() uses native SendInput
// (sendinput.node) for atomic modifier-safe Ctrl+V and only falls back
// to uIOhook.keyTap when the native module fails. These tests assert
// against uIOhook.keyTap, which is the right level — replace the whole
// helper with a uIOhook.keyTap call so the tests run identically on
// every host platform.
vi.mock('@main/inject/pasteWin32', async () => {
  const { uIOhook, UiohookKey } = await import('uiohook-napi');
  return {
    sendCtrlVAtomic: () => {
      uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
    }
  };
});

vi.mock('uiohook-napi', () => ({
  uIOhook: {
    keyTap: hoisted.keyTap
  },
  UiohookKey: {
    V: 1,
    Ctrl: 2,
    Meta: 3
  }
}));

vi.mock('node:fs', () => {
  const fns = {
    writeFileSync: hoisted.writeFileSync,
    readFileSync: hoisted.readFileSync,
    existsSync: hoisted.existsSync,
    unlinkSync: hoisted.unlinkSync
  };
  return { default: fns, ...fns };
});

import { pasteText, recoverClipboardIfPending } from '../src/main/inject/typer';

// path.join so this matches the platform-normalized output of
// `path.join(app.getPath('userData'), '.clipboard-restore.json')` in typer.ts
// — otherwise Windows assertions fail on the slash direction.
const RESTORE_PATH = path.join('/tmp/test-userdata', '.clipboard-restore.json');

describe('pasteText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.clipboardText = 'PREVIOUS';
    hoisted.fsState.files.clear();
    hoisted.writeText.mockClear();
    hoisted.readText.mockClear();
    hoisted.clearClip.mockClear();
    hoisted.keyTap.mockClear();
    hoisted.writeFileSync.mockClear();
    hoisted.readFileSync.mockClear();
    hoisted.existsSync.mockClear();
    hoisted.unlinkSync.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes to clipboard, simulates paste, restores original', async () => {
    const p = pasteText('hello', true);
    await vi.advanceTimersByTimeAsync(50); // settleMs (balanced) = 25
    await vi.advanceTimersByTimeAsync(200); // restoreDelayMs (balanced) = 180
    await p;

    // First write was the new text.
    const firstWrite = hoisted.writeText.mock.calls[0]?.[0];
    expect(firstWrite).toBe('hello');
    // Last write restored the previous clipboard.
    expect(hoisted.writeText).toHaveBeenLastCalledWith('PREVIOUS');
    expect(hoisted.keyTap).toHaveBeenCalled();
    expect(hoisted.clipboardText).toBe('PREVIOUS');
  });

  it('persists previous clipboard to .clipboard-restore.json before paste', async () => {
    const p = pasteText('hello', true);
    // Even before timers advance, the persist call has already happened
    // synchronously before the first await sleep().
    expect(hoisted.writeFileSync).toHaveBeenCalled();
    const [path, data] = hoisted.writeFileSync.mock.calls[0]!;
    expect(path).toBe(RESTORE_PATH);
    const parsed = JSON.parse(data as string);
    expect(parsed.text).toBe('PREVIOUS');

    await vi.advanceTimersByTimeAsync(50 + 200);
    await p;
  });

  it('deletes the restore file after a successful paste + restore', async () => {
    const p = pasteText('hello', true);
    await vi.advanceTimersByTimeAsync(50 + 200);
    await p;

    expect(hoisted.unlinkSync).toHaveBeenCalledWith(RESTORE_PATH);
    expect(hoisted.fsState.files.has(RESTORE_PATH)).toBe(false);
  });

  it('does NOT crash if uIOhook.keyTap throws; original clipboard is still restored', async () => {
    hoisted.keyTap.mockImplementationOnce(() => {
      throw new Error('uiohook-napi: keyTap not available');
    });

    const p = pasteText('hello', true);
    // Don't need RESTORE_DELAY_MS in the failure path — it short-circuits.
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeUndefined();

    // Last write restores the original clipboard.
    expect(hoisted.writeText).toHaveBeenLastCalledWith('PREVIOUS');
    expect(hoisted.clipboardText).toBe('PREVIOUS');
    // Restore file is cleaned up.
    expect(hoisted.unlinkSync).toHaveBeenCalledWith(RESTORE_PATH);
  });
});

describe('recoverClipboardIfPending', () => {
  beforeEach(() => {
    hoisted.clipboardText = '';
    hoisted.fsState.files.clear();
    hoisted.writeText.mockClear();
    hoisted.readText.mockClear();
    hoisted.existsSync.mockClear();
    hoisted.readFileSync.mockClear();
    hoisted.unlinkSync.mockClear();
  });

  it('reads the restore file if present, restores clipboard, deletes file', () => {
    hoisted.fsState.files.set(
      RESTORE_PATH,
      JSON.stringify({ text: 'RESTORED', savedAt: Date.now() })
    );
    recoverClipboardIfPending();
    // v0.1.2: the restore file may be encrypted (safeStorage) or plaintext,
    // so readFileSync is called with just the path; the typer decodes the
    // buffer itself (decrypt-first, then `.toString('utf8')`).
    expect(hoisted.readFileSync).toHaveBeenCalledWith(RESTORE_PATH);
    expect(hoisted.writeText).toHaveBeenCalledWith('RESTORED');
    expect(hoisted.unlinkSync).toHaveBeenCalledWith(RESTORE_PATH);
    expect(hoisted.fsState.files.has(RESTORE_PATH)).toBe(false);
  });

  it('is a no-op when no restore file is present', () => {
    recoverClipboardIfPending();
    expect(hoisted.readFileSync).not.toHaveBeenCalled();
    expect(hoisted.writeText).not.toHaveBeenCalled();
    expect(hoisted.unlinkSync).not.toHaveBeenCalled();
  });
});
