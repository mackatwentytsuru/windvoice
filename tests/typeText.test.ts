import { describe, it, expect, vi } from 'vitest';

vi.mock('@main/debug', () => ({ debug: vi.fn() }));
vi.mock('@main/hotkey/manager', () => ({ getActiveHotkeyManager: () => null }));

import { typeTextDirect, __test } from '@main/inject/typeText';

const { inputsForCodeUnit, isHighSurrogate } = __test;

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
