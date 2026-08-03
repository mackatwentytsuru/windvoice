import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  ready: true,
  pasteText: vi.fn(),
  legacyPaste: vi.fn(),
  writeClipboard: vi.fn(),
  notify: vi.fn(),
  untilModifiersUp: vi.fn(() => Promise.resolve()),
  suppress: vi.fn(),
  resetHotkeys: vi.fn()
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/windvoice-test' },
  clipboard: {
    availableFormats: () => ['text/plain'],
    readText: () => 'OLD',
    writeText: vi.fn(),
    clear: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => false,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn()
  }
}));

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => true
}));

vi.mock('@main/linux/portalSidecar', () => ({
  WAYLAND_PASTE_SHORTCUT: 'ctrl-shift-v',
  WAYLAND_PASTE_VERIFICATION_MS: 750,
  portalSidecar: {
    isReady: () => hoisted.ready,
    pasteText: hoisted.pasteText
  }
}));

vi.mock('@main/inject/paste', () => ({
  sendPasteKeystroke: hoisted.legacyPaste
}));

vi.mock('@main/inject/clipboardWrite', () => ({
  writeClipboardText: hoisted.writeClipboard
}));

vi.mock('@main/inject/pasteTiming', () => ({
  pasteTiming: () => ({
    settleMs: 0,
    restoreDelayMs: 0,
    streamSettleMs: 0,
    streamIntervalMs: 0,
    streamRestoreDelayMs: 0
  })
}));

vi.mock('@main/hotkey/manager', () => ({
  getActiveHotkeyManager: () => ({
    untilAllModifiersUp: hoisted.untilModifiersUp,
    suppressFor: hoisted.suppress,
    resetState: hoisted.resetHotkeys
  })
}));

vi.mock('@main/util/sleep', () => ({
  sleep: () => Promise.resolve()
}));

import { pasteText, setPasteFailureListener } from '../src/main/inject/typer';

describe('pasteText Wayland routing', () => {
  beforeEach(() => {
    hoisted.ready = true;
    hoisted.pasteText.mockReset();
    hoisted.legacyPaste.mockReset();
    hoisted.writeClipboard.mockReset();
    hoisted.notify.mockReset();
    hoisted.untilModifiersUp.mockClear();
    hoisted.suppress.mockReset();
    hoisted.resetHotkeys.mockReset();
    setPasteFailureListener(hoisted.notify);
  });

  afterEach(() => {
    setPasteFailureListener(null);
  });

  it('never performs legacy injection after the sidecar injected text', async () => {
    hoisted.pasteText.mockResolvedValue({
      ok: true,
      claimed: true,
      injected: true,
      selectionRead: true,
      restored: false,
      stage: 'restore',
      error: 'restore failed'
    });

    await pasteText('hello', true);

    expect(hoisted.legacyPaste).not.toHaveBeenCalled();
    expect(hoisted.suppress).toHaveBeenCalledWith(250);
    expect(hoisted.notify).toHaveBeenCalledWith(expect.stringContaining('restore'));
  });

  it('keeps text for manual paste instead of using X11 when the sidecar did not inject', async () => {
    hoisted.pasteText.mockResolvedValue({
      ok: false,
      claimed: false,
      injected: false,
      selectionRead: false,
      restored: false,
      stage: 'claim',
      error: 'claim failed'
    });

    await pasteText('hello', true);

    expect(hoisted.legacyPaste).not.toHaveBeenCalled();
    expect(hoisted.writeClipboard).toHaveBeenLastCalledWith('hello', false);
    expect(hoisted.notify).toHaveBeenCalledWith(
      expect.stringContaining('クリップボード')
    );
  });

  it('does not fall back when the injection outcome is unknown', async () => {
    hoisted.pasteText.mockResolvedValue({
      ok: false,
      claimed: false,
      injected: null,
      selectionRead: false,
      restored: false,
      stage: 'inject',
      error: 'paste timed out'
    });

    await pasteText('hello', true);

    expect(hoisted.legacyPaste).not.toHaveBeenCalled();
    expect(hoisted.notify).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    expect(hoisted.resetHotkeys).toHaveBeenCalledOnce();
  });

  it('preserves and surfaces text when the target never reads the selection', async () => {
    hoisted.pasteText.mockResolvedValue({
      ok: false,
      claimed: true,
      injected: true,
      selectionRead: false,
      restored: false,
      sessionRecyclePending: true,
      stage: 'verify',
      error: 'selection was not read'
    });

    const result = await pasteText('hello', true);

    expect(result).toMatchObject({
      ok: false,
      injected: true,
      selectionRead: false,
      stage: 'verify'
    });
    expect(hoisted.legacyPaste).not.toHaveBeenCalled();
    expect(hoisted.writeClipboard).toHaveBeenLastCalledWith('hello', false);
    expect(hoisted.notify).toHaveBeenCalledWith(expect.stringContaining('not confirmed'));
    expect(hoisted.resetHotkeys).toHaveBeenCalledOnce();
  });

  it('keeps text for manual paste when the sidecar is not ready', async () => {
    hoisted.ready = false;

    await pasteText('hello', true);

    expect(hoisted.pasteText).not.toHaveBeenCalled();
    expect(hoisted.legacyPaste).not.toHaveBeenCalled();
    expect(hoisted.writeClipboard).toHaveBeenLastCalledWith('hello', false);
    expect(hoisted.notify).toHaveBeenCalledWith(
      expect.stringContaining('手動で貼り付け')
    );
  });
});
