import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  // Mirrors the real sendinput JS wrapper: accepts plain {up, val, type}
  // objects and returns the count of injected events (= array length).
  sendInput: vi.fn((inputs: unknown) => (Array.isArray(inputs) ? inputs.length : 1))
}));

// NOTE: vi.mock('sendinput') would NOT work here — typeText loads the addon
// with a bare CommonJS `require()` that vite-node resolves against the real
// filesystem, bypassing the mock registry. The real addon would then type
// ACTUAL keystrokes during the test run. The __test.setSendInputModuleForTest
// seam is used instead (see beforeEach below).
vi.mock('@main/debug', () => ({ debug: vi.fn() }));
vi.mock('@main/hotkey/manager', () => ({ getActiveHotkeyManager: () => null }));

import { typeTextDirect, isAsciiTypeable, __test } from '@main/inject/typeText';
import { debug } from '@main/debug';

const { inputsForCodeUnit, isHighSurrogate, setSendInputModuleForTest } = __test;

interface KBDInput {
  up: boolean;
  val: number;
  type: number;
}

/** Non-empty SendInput batches only. */
function sentBatches(): KBDInput[][] {
  return hoisted.sendInput.mock.calls
    .map((c) => c[0] as KBDInput[])
    .filter((a) => Array.isArray(a) && a.length > 0);
}

describe('typeTextDirect', () => {
  // The keystroke path is Windows-only; on macOS / Linux the orchestrator
  // must be told nothing was typed so it pastes instead. This expectation
  // is meaningless on Windows where the function does the actual typing,
  // so we skip rather than force a false `process.platform` assertion.
  it.skipIf(process.platform === 'win32')(
    'returns false off-Windows so the caller falls back to paste',
    async () => {
      await expect(typeTextDirect('hello world')).resolves.toBe(false);
    }
  );

  it('returns false for empty text', async () => {
    await expect(typeTextDirect('')).resolves.toBe(false);
  });
});

describe('typeTextDirect batched send loop (win32)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    setSendInputModuleForTest({ SendInput: hoisted.sendInput });
    hoisted.sendInput.mockClear();
    vi.mocked(debug).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('splits long text into BATCH_CHARS (40) chunks of down/up pairs', async () => {
    // 100 chars → flush at 40, flush at 80, final remainder of 20.
    const text = 'a'.repeat(100);
    await expect(typeTextDirect(text)).resolves.toBe(true);

    const batches = sentBatches();
    expect(batches.map((b) => b.length)).toEqual([80, 80, 40]); // 2 inputs per char
    // Every code unit is a Unicode (type 2) down/up pair for 'a'.
    const a = 'a'.charCodeAt(0);
    expect(batches[0]![0]).toEqual({ up: false, val: a, type: 2 });
    expect(batches[0]![1]).toEqual({ up: true, val: a, type: 2 });
  });

  it('never flushes a batch between the two halves of a surrogate pair', async () => {
    // 39 chars + 😀 (2 code units): the high surrogate lands exactly at the
    // 40-char flush threshold, so the flush must be deferred until the low
    // surrogate joins the batch — otherwise KEYEVENTF_UNICODE cannot
    // reassemble the pair across two SendInput calls.
    const text = 'a'.repeat(39) + '😀' + 'b'.repeat(10);
    await expect(typeTextDirect(text)).resolves.toBe(true);

    const batches = sentBatches();
    // First batch carries 41 code units (82 events), not 40 (80).
    expect(batches.map((b) => b.length)).toEqual([82, 20]);
    // The pair sits adjacently at the end of the first batch.
    const high = '😀'.charCodeAt(0);
    const low = '😀'.charCodeAt(1);
    expect(batches[0]!.slice(78)).toEqual([
      { up: false, val: high, type: 2 },
      { up: true, val: high, type: 2 },
      { up: false, val: low, type: 2 },
      { up: true, val: low, type: 2 }
    ]);
    // No batch may end on an unpaired high surrogate.
    for (const b of batches) {
      expect(isHighSurrogate(b[b.length - 1]!.val)).toBe(false);
    }
  });

  it('drops a lone trailing high surrogate instead of sending half a character', async () => {
    await expect(typeTextDirect('ab\uD83D')).resolves.toBe(true);

    const batches = sentBatches();
    expect(batches).toHaveLength(1);
    // Only 'a' and 'b' were sent — the truncated surrogate never reaches
    // SendInput (it would render as U+FFFD / garbage in the target app).
    expect(batches[0]!.map((e) => e.val)).toEqual([
      'a'.charCodeAt(0),
      'a'.charCodeAt(0),
      'b'.charCodeAt(0),
      'b'.charCodeAt(0)
    ]);
    expect(vi.mocked(debug)).toHaveBeenCalledWith(
      'DICTATION',
      expect.stringContaining('lone trailing high surrogate')
    );
  });

  it('returns false when text is ONLY a lone high surrogate (nothing injected → paste fallback)', async () => {
    await expect(typeTextDirect('\uD83D')).resolves.toBe(false);
    expect(sentBatches()).toHaveLength(0);
  });

  it('logs a debug warning when SendInput injects fewer events than requested (UIPI block)', async () => {
    hoisted.sendInput.mockImplementationOnce(() => 0);
    await expect(typeTextDirect('hi')).resolves.toBe(true);
    expect(vi.mocked(debug)).toHaveBeenCalledWith(
      'DICTATION',
      expect.stringContaining('injected 0/4 events')
    );
  });
});

describe('inputsForCodeUnit', () => {
  it('maps a normal character to a Unicode (type 2) down/up pair', () => {
    const cu = 'あ'.charCodeAt(0);
    expect(inputsForCodeUnit(cu)).toEqual([
      { up: false, val: cu, type: 2 },
      { up: true, val: cu, type: 2 }
    ]);
  });

  it('maps a newline to a real VK_RETURN (type 0) so it lands as Enter', () => {
    expect(inputsForCodeUnit(0x0a)).toEqual([
      { up: false, val: 0x0d, type: 0 },
      { up: true, val: 0x0d, type: 0 }
    ]);
  });
});

describe('isAsciiTypeable', () => {
  it('is true for pure ASCII (typed reliably regardless of IME mode)', () => {
    expect(isAsciiTypeable('hello world 123 !@#')).toBe(true);
    expect(isAsciiTypeable('git commit -m "wip"')).toBe(true);
    expect(isAsciiTypeable('line1\nline2\t end')).toBe(true);
    expect(isAsciiTypeable('')).toBe(true);
  });

  it('is false when any non-ASCII char is present (must paste — IME garbles VK_PACKET)', () => {
    expect(isAsciiTypeable('こんにちは')).toBe(false);
    expect(isAsciiTypeable('OK です')).toBe(false); // mixed ASCII + Japanese
    expect(isAsciiTypeable('café')).toBe(false); // Latin-1 accent
    expect(isAsciiTypeable('「全角」')).toBe(false); // U+3000–U+30FF range
    expect(isAsciiTypeable('😀')).toBe(false);
  });

  it('treats U+007F as the inclusive ASCII boundary', () => {
    expect(isAsciiTypeable('\x7f')).toBe(true); // DEL, still ≤ 0x7F
    expect(isAsciiTypeable('')).toBe(false); // U+0080, first non-ASCII code point
  });
});

describe('isHighSurrogate', () => {
  it('identifies the high half of a surrogate pair', () => {
    // U+1F600 (😀) — its UTF-16 high surrogate must not be split off.
    const high = '😀'.charCodeAt(0);
    const low = '😀'.charCodeAt(1);
    expect(isHighSurrogate(high)).toBe(true);
    expect(isHighSurrogate(low)).toBe(false);
    expect(isHighSurrogate('a'.charCodeAt(0))).toBe(false);
  });
});
