import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  defaultHotkey,
  defaultHotkeyBindings,
  SettingsSchema
} from '../src/shared/types';

describe('types defaults / platform-aware factories', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      value,
      configurable: true,
      writable: true
    });
  }

  // defaultHotkey() is RightCtrl everywhere now — see comment in
  // src/shared/types.ts. RightAlt was the previous Win32 default but caused
  // menu-mode activation in Notepad/Windows Terminal even with paste guards.
  it('defaultHotkey() returns RightCtrl on darwin', () => {
    setPlatform('darwin');
    expect(defaultHotkey()).toBe('RightCtrl');
  });

  it('defaultHotkey() returns RightCtrl on win32', () => {
    setPlatform('win32');
    expect(defaultHotkey()).toBe('RightCtrl');
  });

  it('defaultHotkey() returns RightCtrl on linux', () => {
    setPlatform('linux');
    expect(defaultHotkey()).toBe('RightCtrl');
  });

  it('defaultHotkeyBindings() is a non-empty array reflecting defaultHotkey()', () => {
    setPlatform('linux');
    const linuxBindings = defaultHotkeyBindings();
    expect(Array.isArray(linuxBindings)).toBe(true);
    expect(linuxBindings.length).toBeGreaterThan(0);
    expect(linuxBindings[0]?.keys).toContain('RightCtrl');

    setPlatform('darwin');
    const darwinBindings = defaultHotkeyBindings();
    expect(darwinBindings.length).toBeGreaterThan(0);
    expect(darwinBindings[0]?.keys).toContain('RightCtrl');
  });

  it('SettingsSchema with no input produces hotkeys matching the platform default', () => {
    setPlatform('darwin');
    const macSettings = SettingsSchema.parse({});
    expect(macSettings.hotkeys.length).toBeGreaterThan(0);
    expect(macSettings.hotkeys[0]?.keys).toContain('RightCtrl');

    setPlatform('win32');
    const winSettings = SettingsSchema.parse({});
    expect(winSettings.hotkeys.length).toBeGreaterThan(0);
    expect(winSettings.hotkeys[0]?.keys).toContain('RightCtrl');
  });
});
