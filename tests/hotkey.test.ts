import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('uiohook-napi', () => ({
  uIOhook: { on: vi.fn(), start: vi.fn(), stop: vi.fn(), keyTap: vi.fn() },
  UiohookKey: {
    AltRight: 3640,
    Alt: 56,
    Ctrl: 29,
    CtrlRight: 3613,
    Shift: 42,
    ShiftRight: 54,
    V: 47,
    Space: 57
  }
}));

import { HotkeyManager } from '../src/main/hotkey/manager';

interface KbdEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function dispatch(mgr: HotkeyManager, e: KbdEvent, down: boolean): void {
  // The manager's onKey is private; reach into it the same way uIOhook would.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).onKey(e, down);
}

describe('HotkeyManager modifier-self-match', () => {
  let mgr: HotkeyManager;
  let started: string[] = [];
  let stopped: string[] = [];

  beforeEach(() => {
    mgr = new HotkeyManager();
    started = [];
    stopped = [];
    mgr.on('start', (id) => started.push(id));
    mgr.on('stop', (id) => stopped.push(id));
  });

  it('fires start/stop for RightAlt push-to-talk even when altKey=true on press', () => {
    mgr.setBindings([{ id: 'primary', keys: ['RightAlt'], mode: 'push-to-talk', format: true }]);
    dispatch(mgr, { keycode: 3640, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual(['primary']);
    dispatch(mgr, { keycode: 3640, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }, false);
    expect(stopped).toEqual(['primary']);
  });

  it('toggles on each press for toggle mode', () => {
    mgr.setBindings([{ id: 't', keys: ['RightAlt'], mode: 'toggle', format: true }]);
    dispatch(mgr, { keycode: 3640, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    dispatch(mgr, { keycode: 3640, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }, false);
    dispatch(mgr, { keycode: 3640, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual(['t']);
    expect(stopped).toEqual(['t']);
  });

  it('requires exact modifier match for non-modifier triggers', () => {
    mgr.setBindings([{ id: 'c', keys: ['Ctrl', 'Shift', 'Space'], mode: 'toggle', format: true }]);
    // ctrl+shift+space → match
    dispatch(mgr, { keycode: 57, altKey: false, ctrlKey: true, shiftKey: true, metaKey: false }, true);
    expect(started).toEqual(['c']);
    // ctrl+space alone → no match
    dispatch(mgr, { keycode: 57, altKey: false, ctrlKey: true, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual(['c']);
  });

  it('ignores keys with the wrong keycode', () => {
    mgr.setBindings([{ id: 'p', keys: ['RightAlt'], mode: 'push-to-talk', format: true }]);
    dispatch(mgr, { keycode: 999, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual([]);
  });
});
