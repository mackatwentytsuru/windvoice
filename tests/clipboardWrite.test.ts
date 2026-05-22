import { describe, expect, it, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  text: '',
  writeText: vi.fn((t: string) => {
    hoisted.text = t;
  }),
  readText: vi.fn(() => hoisted.text)
}));

vi.mock('electron', () => ({
  clipboard: { writeText: hoisted.writeText, readText: hoisted.readText }
}));

vi.mock('@main/debug', () => ({ debug: vi.fn() }));

import { writeClipboardText, __test } from '../src/main/inject/clipboardWrite';

describe('writeClipboardText', () => {
  beforeEach(() => {
    hoisted.text = '';
    hoisted.writeText.mockClear();
    hoisted.readText.mockClear();
  });

  it('writes the text to the clipboard when exclusion is off', () => {
    writeClipboardText('hello', false);
    expect(hoisted.writeText).toHaveBeenCalledWith('hello');
    expect(hoisted.text).toBe('hello');
  });

  // The native history-exclusion path is win32-only; on macOS / Linux the
  // request must degrade to a normal clipboard.writeText so the paste still
  // works. On Windows the function takes the native FFI path instead, so
  // this fallback expectation does not apply — skip rather than coerce.
  it.skipIf(process.platform === 'win32')(
    'falls back to a plain write off-Windows even when exclusion is requested',
    () => {
      writeClipboardText('world', true);
      expect(hoisted.writeText).toHaveBeenCalledWith('world');
      expect(hoisted.text).toBe('world');
    }
  );
});

// HIGH-3: GlobalFree ownership-transfer regression coverage. These tests
// inject a mock Win32 surface so they run on every host platform; the
// real win32-only guard inside writeExcludedWin32 is bypassed via
// __test.injectWin32().
describe('writeExcludedWin32 ownership semantics (HIGH-3)', () => {
  function makeMockWin32(overrides: Record<string, unknown> = {}) {
    let nextHandle = 1;
    const handles = new Map<number, { freed: boolean; owner: 'caller' | 'os' }>();
    const alloc = (): number => {
      const h = nextHandle++;
      handles.set(h, { freed: false, owner: 'caller' });
      return h;
    };
    const mock = {
      handles,
      OpenClipboard: vi.fn(() => 1),
      EmptyClipboard: vi.fn(() => 1),
      SetClipboardData: vi.fn((_fmt: number, h: number) => {
        const rec = handles.get(h);
        if (rec) rec.owner = 'os';
        return h; // success: return non-null handle
      }),
      CloseClipboard: vi.fn(() => 1),
      RegisterClipboardFormatW: vi.fn(() => 0xc000), // arbitrary non-zero
      GlobalAlloc: vi.fn(() => alloc()),
      GlobalLock: vi.fn((h: number) => h),
      GlobalUnlock: vi.fn(() => 1),
      GlobalFree: vi.fn((h: number) => {
        const rec = handles.get(h);
        if (rec) {
          if (rec.owner === 'os') {
            throw new Error(`double-free: handle ${h} was owned by the OS`);
          }
          rec.freed = true;
        }
        return null;
      }),
      RtlMoveMemory: vi.fn(),
      ...overrides
    };
    return mock;
  }

  beforeEach(() => {
    __test.resetState();
  });

  it('returns false and never allocates when OpenClipboard fails', () => {
    const mock = makeMockWin32({ OpenClipboard: vi.fn(() => 0) });
    __test.injectWin32(mock as never);
    expect(__test.writeExcludedWin32('hello')).toBe(false);
    expect(mock.GlobalAlloc).not.toHaveBeenCalled();
    expect(mock.CloseClipboard).not.toHaveBeenCalled();
  });

  it('frees hText when SetClipboardData(CF_UNICODETEXT) fails', () => {
    const mock = makeMockWin32({ SetClipboardData: vi.fn(() => null) });
    __test.injectWin32(mock as never);
    expect(__test.writeExcludedWin32('hello')).toBe(false);
    // hText was allocated then must be freed since the OS rejected it.
    expect(mock.GlobalAlloc).toHaveBeenCalled();
    expect(mock.GlobalFree).toHaveBeenCalled();
    expect(mock.CloseClipboard).toHaveBeenCalled();
  });

  it('does NOT free hText when SetClipboardData succeeds (ownership transferred)', () => {
    const mock = makeMockWin32();
    __test.injectWin32(mock as never);
    expect(__test.writeExcludedWin32('hello')).toBe(true);
    // Both hText (CF_UNICODETEXT) and hMark (exclude marker) were accepted
    // by the OS — neither must be freed by us, or it's a double-free.
    expect(mock.GlobalFree).not.toHaveBeenCalled();
    expect(mock.CloseClipboard).toHaveBeenCalled();
  });

  it('returns false when GlobalAlloc returns null up front', () => {
    const mock = makeMockWin32({ GlobalAlloc: vi.fn(() => null) });
    __test.injectWin32(mock as never);
    expect(__test.writeExcludedWin32('hello')).toBe(false);
    expect(mock.SetClipboardData).not.toHaveBeenCalled();
    expect(mock.CloseClipboard).toHaveBeenCalled();
  });
});

describe('isNullHandle', () => {
  it('treats null / undefined as null', () => {
    expect(__test.isNullHandle(null)).toBe(true);
    expect(__test.isNullHandle(undefined)).toBe(true);
  });
  it('treats non-zero numeric handles as non-null', () => {
    expect(__test.isNullHandle(1)).toBe(false);
    expect(__test.isNullHandle(0x1234)).toBe(false);
  });
});
