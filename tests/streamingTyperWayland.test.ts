import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  ready: true,
  pasteText: vi.fn(),
  snapshot: vi.fn(),
  setSelection: vi.fn(),
  notify: vi.fn(),
  copyForManualPaste: vi.fn()
}));

vi.mock('electron', () => ({
  clipboard: {
    availableFormats: () => ['text/plain'],
    readText: () => 'OLD',
    writeText: vi.fn(),
    clear: vi.fn()
  }
}));

vi.mock('@main/linux/wayland', () => ({
  isWaylandSession: () => true
}));

vi.mock('@main/linux/portalSidecar', () => ({
  WAYLAND_PASTE_VERIFICATION_MS: 750,
  portalSidecar: {
    isReady: () => hoisted.ready,
    pasteText: hoisted.pasteText,
    snapshot: hoisted.snapshot,
    setSelection: hoisted.setSelection
  }
}));

vi.mock('@main/inject/typer', () => ({
  clipboardHasText: () => true,
  notifyPasteFailed: hoisted.notify,
  copyTextForManualPaste: hoisted.copyForManualPaste,
  manualPasteMessage: () =>
    'クリップボードにコピーしました。手動で貼り付けてください。'
}));

vi.mock('@main/inject/paste', () => ({
  sendPasteKeystroke: vi.fn()
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

vi.mock('@main/util/sleep', () => ({
  sleep: () => Promise.resolve()
}));

vi.mock('@main/hotkey/manager', () => ({
  getActiveHotkeyManager: () => null
}));

import { StreamingTyper } from '../src/main/inject/streamingTyper';

describe('StreamingTyper Wayland lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.ready = true;
    hoisted.pasteText.mockReset();
    hoisted.snapshot.mockReset().mockResolvedValue({ ok: true, kind: 'empty' });
    hoisted.setSelection.mockReset().mockResolvedValue({ ok: true, uncertain: false });
    hoisted.notify.mockReset();
    hoisted.copyForManualPaste.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops and surfaces a failed chunk instead of silently dropping it', async () => {
    hoisted.pasteText.mockResolvedValue({
      ok: false,
      claimed: false,
      injected: false,
      selectionRead: false,
      restored: false,
      stage: 'claim',
      error: 'claim failed'
    });
    const typer = new StreamingTyper();

    expect(typer.begin(true)).toBe(true);
    typer.append('x'.repeat(200));
    await vi.runAllTimersAsync();
    typer.append('later');
    await vi.runAllTimersAsync();

    expect(hoisted.pasteText).toHaveBeenCalledOnce();
    expect(hoisted.notify).toHaveBeenCalledWith(expect.stringContaining('streaming'));
  });

  it('does not use the legacy path when the sidecar is unavailable and keeps the transcript', async () => {
    hoisted.ready = false;
    const typer = new StreamingTyper();

    expect(typer.begin(true)).toBe(true);
    typer.append('first ');
    typer.append('second');
    const ending = typer.end();
    await vi.runAllTimersAsync();
    await ending;

    expect(hoisted.pasteText).not.toHaveBeenCalled();
    expect(hoisted.copyForManualPaste).toHaveBeenLastCalledWith(
      'first second',
      false
    );
    expect(hoisted.notify).toHaveBeenCalledWith(
      expect.stringContaining('手動で貼り付け')
    );
  });

  it('does not overwrite a non-text Wayland clipboard', async () => {
    hoisted.snapshot.mockResolvedValue({ ok: true, kind: 'non-text' });
    hoisted.pasteText.mockResolvedValue({
      ok: true,
      claimed: true,
      injected: true,
      selectionRead: true,
      restored: false
    });
    const typer = new StreamingTyper();

    expect(typer.begin(true)).toBe(true);
    typer.append('x'.repeat(200));
    await vi.runAllTimersAsync();

    expect(hoisted.pasteText).not.toHaveBeenCalled();
    expect(hoisted.notify).toHaveBeenCalledWith(expect.stringContaining('non-text'));
  });

  it('leaves the transcript on a claimed selection when injection failed', async () => {
    hoisted.snapshot.mockResolvedValue({ ok: true, kind: 'text', text: 'OLD' });
    hoisted.pasteText.mockResolvedValue({
      ok: false,
      claimed: true,
      injected: false,
      selectionRead: false,
      restored: false,
      stage: 'inject',
      error: 'inject failed'
    });
    const typer = new StreamingTyper();

    expect(typer.begin(true)).toBe(true);
    typer.append('x'.repeat(200));
    await vi.runAllTimersAsync();
    const ending = typer.end();
    await vi.runAllTimersAsync();
    await ending;

    expect(hoisted.setSelection).toHaveBeenCalledWith('x'.repeat(200));
  });

  it('rejects begin while end is in progress, then accepts the next session', async () => {
    let finishPaste!: (value: {
      ok: true;
      claimed: true;
      injected: true;
      selectionRead: true;
      restored: false;
    }) => void;
    hoisted.pasteText.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPaste = resolve;
      })
    );
    const typer = new StreamingTyper();

    expect(typer.begin(true)).toBe(true);
    typer.append('x'.repeat(200));
    const ending = typer.end();
    expect(typer.begin(true)).toBe(false);

    finishPaste({
      ok: true,
      claimed: true,
      injected: true,
      selectionRead: true,
      restored: false
    });
    await vi.runAllTimersAsync();
    await ending;

    expect(typer.begin(true)).toBe(true);
  });

  it('stops streaming when dispatch succeeded but no selection read was observed', async () => {
    hoisted.pasteText.mockResolvedValue({
      ok: false,
      claimed: true,
      injected: true,
      selectionRead: false,
      restored: false,
      stage: 'verify',
      error: 'selection was not read'
    });
    const typer = new StreamingTyper();

    expect(typer.begin(true)).toBe(true);
    typer.append('x'.repeat(200));
    await vi.runAllTimersAsync();

    expect(hoisted.copyForManualPaste).toHaveBeenCalledWith('x'.repeat(200), false);
    expect(hoisted.notify).toHaveBeenCalledWith(expect.stringContaining('streaming'));
  });
});
