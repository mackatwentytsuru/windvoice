import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// GitHub issue #15: tests/typer.test.ts mocks the entire pasteWin32 module,
// so sendCtrlVAtomic's branch logic (the ctrlAlreadyHeld batch shape in
// particular) had ZERO direct coverage. This file tests the real module
// with only the natives mocked: the `sendinput` addon and uiohook-napi.

const hoisted = vi.hoisted(() => ({
  // Default: report success by echoing the batch length back, matching the
  // real wrapper which returns the Win32 SendInput injected-event count.
  sendInput: vi.fn((inputs: unknown) => (Array.isArray(inputs) ? inputs.length : 1)),
  keyTap: vi.fn(),
  /** Controls the mocked HotkeyManager.isCtrlHeld() result. */
  ctrlHeld: false,
  /** When false, getActiveHotkeyManager() returns null. */
  hkmPresent: true
}));

// NOTE: vi.mock('sendinput') would NOT work here — pasteWin32 loads the
// addon with a bare CommonJS `require()` that vite-node resolves against
// the real filesystem, bypassing the mock registry. The real addon would
// then inject ACTUAL Ctrl+V keystrokes during the test run. The module's
// __setSendInputModuleForTest seam is used instead (see beforeEach).

vi.mock('uiohook-napi', () => ({
  uIOhook: { keyTap: hoisted.keyTap },
  UiohookKey: { V: 1, Ctrl: 2, Meta: 3 }
}));

vi.mock('@main/debug', () => ({ debug: vi.fn() }));

vi.mock('@main/hotkey/manager', () => ({
  getActiveHotkeyManager: () =>
    hoisted.hkmPresent ? { isCtrlHeld: () => hoisted.ctrlHeld } : null
}));

import { sendCtrlVAtomic, __setSendInputModuleForTest } from '@main/inject/pasteWin32';

// Windows Virtual-Key codes asserted below (must mirror pasteWin32.ts).
const VK_LMENU = 0xa4;
const VK_RMENU = 0xa5;
const VK_LCONTROL = 0xa2;
const VK_V = 0x56;

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('sendCtrlVAtomic (win32 SendInput batches)', () => {
  beforeEach(() => {
    setPlatform('win32');
    __setSendInputModuleForTest({ SendInput: hoisted.sendInput });
    hoisted.sendInput.mockClear();
    hoisted.keyTap.mockClear();
    hoisted.ctrlHeld = false;
    hoisted.hkmPresent = true;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('Ctrl NOT held: sends the full 6-event batch with synth Ctrl press/release around V', () => {
    hoisted.ctrlHeld = false;
    sendCtrlVAtomic();

    expect(hoisted.sendInput).toHaveBeenCalledTimes(1);
    expect(hoisted.keyTap).not.toHaveBeenCalled();
    // Exact composition AND ordering matter: Alt key-ups must precede the
    // Ctrl-down so a physically-held Alt cannot turn the paste into Alt+V
    // (menu access), and V-up must precede Ctrl-up.
    expect(hoisted.sendInput.mock.calls[0]![0]).toEqual([
      { up: true, val: VK_LMENU, type: 0 },
      { up: true, val: VK_RMENU, type: 0 },
      { up: false, val: VK_LCONTROL, type: 0 },
      { up: false, val: VK_V, type: 0 },
      { up: true, val: VK_V, type: 0 },
      { up: true, val: VK_LCONTROL, type: 0 }
    ]);
  });

  it('Ctrl ALREADY held: omits the synth Ctrl press/release entirely (user Ctrl is the modifier)', () => {
    hoisted.ctrlHeld = true;
    sendCtrlVAtomic();

    expect(hoisted.sendInput).toHaveBeenCalledTimes(1);
    const batch = hoisted.sendInput.mock.calls[0]![0] as Array<{ up: boolean; val: number; type: number }>;
    // 4 events only — releasing the user's physically-held Ctrl with a
    // synth Ctrl-up would cause the PSReadLine Ctrl up/down spasm
    // documented in pasteWin32.ts. No LCONTROL events may appear.
    expect(batch).toEqual([
      { up: true, val: VK_LMENU, type: 0 },
      { up: true, val: VK_RMENU, type: 0 },
      { up: false, val: VK_V, type: 0 },
      { up: true, val: VK_V, type: 0 }
    ]);
    expect(batch.some((e) => e.val === VK_LCONTROL)).toBe(false);
  });

  it('no active hotkey manager: treated as Ctrl-not-held (full 6-event batch)', () => {
    hoisted.hkmPresent = false;
    sendCtrlVAtomic();

    expect(hoisted.sendInput).toHaveBeenCalledTimes(1);
    const batch = hoisted.sendInput.mock.calls[0]![0] as Array<{ up: boolean; val: number }>;
    expect(batch).toHaveLength(6);
    expect(batch.filter((e) => e.val === VK_LCONTROL)).toHaveLength(2);
  });

  it('falls back to uIOhook.keyTap(Ctrl+V) when SendInput throws', () => {
    hoisted.sendInput.mockImplementationOnce(() => {
      throw new Error('Expected an array with only INPUT elements!');
    });
    sendCtrlVAtomic();

    // UiohookKey mock: V = 1, Ctrl = 2.
    expect(hoisted.keyTap).toHaveBeenCalledWith(1, [2]);
  });
});

describe('sendCtrlVAtomic (non-win32 platforms)', () => {
  beforeEach(() => {
    hoisted.sendInput.mockClear();
    hoisted.keyTap.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('darwin: uses uIOhook Cmd+V (Meta), never the win32 SendInput path', () => {
    setPlatform('darwin');
    sendCtrlVAtomic();
    // UiohookKey mock: V = 1, Meta = 3.
    expect(hoisted.keyTap).toHaveBeenCalledWith(1, [3]);
    expect(hoisted.sendInput).not.toHaveBeenCalled();
  });

  it('linux: uses uIOhook Ctrl+V, never the win32 SendInput path', () => {
    setPlatform('linux');
    sendCtrlVAtomic();
    expect(hoisted.keyTap).toHaveBeenCalledWith(1, [2]);
    expect(hoisted.sendInput).not.toHaveBeenCalled();
  });
});
