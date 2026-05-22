import { describe, it, expect, vi } from 'vitest';

vi.mock('@main/debug', () => ({ debug: vi.fn() }));
vi.mock('@main/hotkey/manager', () => ({ getActiveHotkeyManager: () => null }));

import { typeTextDirect } from '@main/inject/typeText';

describe('typeTextDirect', () => {
  it('returns false off-Windows so the caller falls back to paste', async () => {
    // The keystroke path is Windows-only; on macOS / Linux the orchestrator
    // must be told nothing was typed so it pastes instead.
    expect(process.platform).not.toBe('win32');
    await expect(typeTextDirect('hello world')).resolves.toBe(false);
  });

  it('returns false for empty text', async () => {
    await expect(typeTextDirect('')).resolves.toBe(false);
  });
});
