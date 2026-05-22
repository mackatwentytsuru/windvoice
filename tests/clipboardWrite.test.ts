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

import { writeClipboardText } from '../src/main/inject/clipboardWrite';

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
