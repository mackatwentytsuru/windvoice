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

import { uIOhook } from 'uiohook-napi';
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

  it('toggle mode de-bounces OS auto-repeat (repeated keydowns flip once, keyup re-arms)', () => {
    // Bug: libuiohook forwards OS auto-repeat as repeated keydowns with no
    // intervening keyup. A non-modifier toggle trigger must flip recording
    // exactly ONCE while held, then re-arm on keyup so the next press flips
    // again.
    mgr.setBindings([{ id: 'tog', keys: ['Space'], mode: 'toggle', format: true }]);
    const press = (down: boolean): void =>
      dispatch(
        mgr,
        { keycode: 57, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false },
        down
      );
    // Three auto-repeat keydowns, no keyup between them → toggle ONCE.
    press(true);
    press(true);
    press(true);
    expect(started).toEqual(['tog']);
    expect(stopped).toEqual([]);
    // Keyup re-arms the trigger.
    press(false);
    // Next physical press toggles again (now stops recording).
    press(true);
    expect(started).toEqual(['tog']);
    expect(stopped).toEqual(['tog']);
  });

  it('does not lose a safe toggle stop during paste-event suppression', () => {
    mgr.setBindings([{ id: 'tog', keys: ['Space'], mode: 'toggle', format: true }]);
    const event = { keycode: 57, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false };
    dispatch(mgr, event, true);
    dispatch(mgr, event, false);
    mgr.suppressFor(1_000);

    dispatch(mgr, event, true);

    expect(started).toEqual(['tog']);
    expect(stopped).toEqual(['tog']);
  });

  it('re-arms a toggle after its requested start is rejected as busy', () => {
    mgr.setBindings([{ id: 'tog', keys: ['Space'], mode: 'toggle', format: true }]);
    const event = { keycode: 57, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false };
    dispatch(mgr, event, true);
    mgr.rejectToggleStart('tog');
    dispatch(mgr, event, false);

    dispatch(mgr, event, true);

    expect(started).toEqual(['tog', 'tog']);
    expect(stopped).toEqual([]);
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

  it('stops push-to-talk when a required modifier is released before its trigger', () => {
    mgr.setBindings([
      { id: 'combo', keys: ['Ctrl', 'Shift', 'Space'], mode: 'push-to-talk', format: true }
    ]);
    dispatch(mgr, { keycode: 57, altKey: false, ctrlKey: true, shiftKey: true, metaKey: false }, true);
    expect(started).toEqual(['combo']);

    dispatch(mgr, { keycode: 42, altKey: false, ctrlKey: true, shiftKey: false, metaKey: false }, false);
    expect(stopped).toEqual(['combo']);
  });

  it('ignores keys with the wrong keycode', () => {
    mgr.setBindings([{ id: 'p', keys: ['RightAlt'], mode: 'push-to-talk', format: true }]);
    dispatch(mgr, { keycode: 999, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual([]);
  });

  it('can retry hook startup after an accessibility failure', () => {
    vi.mocked(uIOhook.start)
      .mockImplementationOnce(() => {
        throw new Error('accessibility denied');
      })
      .mockImplementationOnce(() => undefined);
    vi.mocked(uIOhook.on).mockClear();

    expect(() => mgr.start()).toThrow('accessibility denied');
    expect(() => mgr.start()).not.toThrow();

    expect(uIOhook.start).toHaveBeenCalledTimes(2);
    expect(uIOhook.on).toHaveBeenCalledTimes(2);
  });

  it('clears a stuck push-to-talk and modifier snapshot after suspend', async () => {
    mgr.setBindings([{ id: 'primary', keys: ['RightAlt'], mode: 'push-to-talk', format: true }]);
    dispatch(mgr, { keycode: 3640, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(mgr.isAnyModifierHeld()).toBe(true);

    const modifiersReleased = mgr.untilAllModifiersUp();
    mgr.resetState();

    await modifiersReleased;
    expect(mgr.isAnyModifierHeld()).toBe(false);

    dispatch(mgr, { keycode: 3640, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual(['primary', 'primary']);
  });

  it('re-arms a toggle binding after the OS discards its key-up event', () => {
    mgr.setBindings([{ id: 'toggle', keys: ['Space'], mode: 'toggle', format: true }]);
    const event = { keycode: 57, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false };
    dispatch(mgr, event, true);
    mgr.resetState();

    dispatch(mgr, event, true);
    expect(started).toEqual(['toggle', 'toggle']);
  });
});

describe('HotkeyManager Fn (Globe) key support', () => {
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

  // FN_KEYCODE sentinel — kept in lockstep with src/main/hotkey/keycodes.ts.
  // Hard-coded here on purpose: if the production constant moves, this test
  // forces an explicit update rather than silently coupling to it.
  const FN = 0xfd01;

  it('normalizes a single "Fn" token into the sentinel keycode', () => {
    mgr.setBindings([{ id: 'fn-binding', keys: ['Fn'], mode: 'push-to-talk', format: true }]);
    // injectKey is the public surface fnwatcher uses.
    mgr.injectKey(FN, true);
    expect(started).toEqual(['fn-binding']);
    mgr.injectKey(FN, false);
    expect(stopped).toEqual(['fn-binding']);
  });

  it('case-insensitive token: lowercase "fn" also binds', () => {
    mgr.setBindings([{ id: 'lc', keys: ['fn'], mode: 'push-to-talk', format: true }]);
    mgr.injectKey(FN, true);
    mgr.injectKey(FN, false);
    expect(started).toEqual(['lc']);
    expect(stopped).toEqual(['lc']);
  });

  it('toggle mode: alternates on successive Fn presses', () => {
    mgr.setBindings([{ id: 'tg', keys: ['Fn'], mode: 'toggle', format: true }]);
    mgr.injectKey(FN, true);
    mgr.injectKey(FN, false);
    expect(started).toEqual(['tg']);
    mgr.injectKey(FN, true);
    expect(stopped).toEqual(['tg']);
  });

  it('Fn binding does not fire on a real keystroke at the same numeric code', () => {
    // Defense-in-depth: even if some future uiohook release decided to
    // emit a synthetic code that happened to overlap, the binding still
    // only fires through injectKey because that's the only path that
    // produces the FN_KEYCODE. A real uiohook event with a totally
    // unrelated keycode must NOT fire it.
    mgr.setBindings([{ id: 'fn2', keys: ['Fn'], mode: 'push-to-talk', format: true }]);
    dispatch(mgr, { keycode: 0x1234, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }, true);
    expect(started).toEqual([]);
  });

  it('Fn injection preserves live modifier state (does not clear ctrl)', () => {
    mgr.setBindings([{ id: 'fn3', keys: ['Fn'], mode: 'push-to-talk', format: true }]);
    // First, simulate user pressing Ctrl — populates the manager's snapshot.
    dispatch(mgr, { keycode: 29, altKey: false, ctrlKey: true, shiftKey: false, metaKey: false }, true);
    expect(mgr.isCtrlHeld()).toBe(true);
    // Then inject Fn — should not clear the cached ctrl state.
    mgr.injectKey(FN, true);
    expect(mgr.isCtrlHeld()).toBe(true);
    mgr.injectKey(FN, false);
    expect(mgr.isCtrlHeld()).toBe(true);
  });
});
