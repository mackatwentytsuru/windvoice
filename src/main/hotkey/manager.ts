import { uIOhook, UiohookKey } from 'uiohook-napi';
import { EventEmitter } from 'node:events';
import { debug, isDebug } from '@main/debug';
import type { HotkeyBinding } from '@shared/types';

export interface HotkeyEvents {
  start: (bindingId: string) => void;
  stop: (bindingId: string) => void;
}

export declare interface HotkeyManager {
  on<K extends keyof HotkeyEvents>(event: K, listener: HotkeyEvents[K]): this;
  emit<K extends keyof HotkeyEvents>(event: K, ...args: Parameters<HotkeyEvents[K]>): boolean;
}

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';

interface NormalizedBinding {
  binding: HotkeyBinding;
  triggerKey: number;
  modifiers: Record<Modifier, boolean>;
  /**
   * If the trigger key itself sets a modifier flag (e.g. Right Alt → altKey),
   * the OS reports that flag as `true` while the key is held — so we must
   * skip that flag in the equality check.
   */
  triggerProvidesModifier: Modifier | null;
}

interface UiohookKeyboardEventLike {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export class HotkeyManager extends EventEmitter {
  private bindings: NormalizedBinding[] = [];
  private heldDown: Set<string> = new Set();
  private toggleActive: Set<string> = new Set();
  private started = false;

  setBindings(list: HotkeyBinding[]): void {
    this.bindings = list
      .map((b) => HotkeyManager.normalize(b))
      .filter((x): x is NormalizedBinding => x !== null);
    if (isDebug('HOTKEY')) {
      const summary = this.bindings.map((b) => ({
        id: b.binding.id,
        triggerKey: b.triggerKey,
        modifiers: b.modifiers,
        triggerProvidesModifier: b.triggerProvidesModifier
      }));
      debug('HOTKEY', `bindings ${JSON.stringify(summary)}`);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    uIOhook.on('keydown', (e) => this.onKey(e, true));
    uIOhook.on('keyup', (e) => this.onKey(e, false));
    uIOhook.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
  }

  private onKey(e: UiohookKeyboardEventLike, down: boolean): void {
    if (isDebug('HOTKEY')) {
      debug('HOTKEY', `${down ? 'down' : 'up  '} keycode=${e.keycode} alt=${e.altKey} ctrl=${e.ctrlKey} shift=${e.shiftKey} meta=${e.metaKey}`);
    }
    for (const nb of this.bindings) {
      if (e.keycode !== nb.triggerKey) continue;
      if (!HotkeyManager.modsMatch(e, nb)) continue;

      const id = nb.binding.id;
      if (nb.binding.mode === 'push-to-talk') {
        if (down && !this.heldDown.has(id)) {
          this.heldDown.add(id);
          this.emit('start', id);
        } else if (!down && this.heldDown.has(id)) {
          this.heldDown.delete(id);
          this.emit('stop', id);
        }
      } else if (nb.binding.mode === 'toggle' && down) {
        if (this.toggleActive.has(id)) {
          this.toggleActive.delete(id);
          this.emit('stop', id);
        } else {
          this.toggleActive.add(id);
          this.emit('start', id);
        }
      }
    }
  }

  private static modsMatch(e: UiohookKeyboardEventLike, nb: NormalizedBinding): boolean {
    const checks: Array<[Modifier, boolean]> = [
      ['ctrl', e.ctrlKey],
      ['alt', e.altKey],
      ['shift', e.shiftKey],
      ['meta', e.metaKey]
    ];
    for (const [name, actual] of checks) {
      if (nb.triggerProvidesModifier === name) continue;
      if (actual !== nb.modifiers[name]) return false;
    }
    return true;
  }

  private static normalize(b: HotkeyBinding): NormalizedBinding | null {
    let trigger: number | null = null;
    let triggerProvidesModifier: Modifier | null = null;
    const mods: Record<Modifier, boolean> = {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false
    };
    for (const k of b.keys) {
      const norm = k.trim();
      if (/^ctrl$/i.test(norm)) {
        mods.ctrl = true;
      } else if (/^alt$/i.test(norm)) {
        mods.alt = true;
      } else if (/^shift$/i.test(norm)) {
        mods.shift = true;
      } else if (/^(meta|win|cmd)$/i.test(norm)) {
        mods.meta = true;
      } else {
        const looked = lookupKey(norm);
        if (looked != null) {
          trigger = looked.code;
          triggerProvidesModifier = looked.modifier;
        }
      }
    }
    if (trigger == null) return null;
    return { binding: b, triggerKey: trigger, modifiers: mods, triggerProvidesModifier };
  }
}

interface KeyLookup {
  code: number;
  /** non-null when this key, when pressed alone, also sets a modifier flag */
  modifier: Modifier | null;
}

function lookupKey(name: string): KeyLookup | null {
  const map: Record<string, { key: keyof typeof UiohookKey; modifier: Modifier | null }> = {
    space: { key: 'Space', modifier: null },
    enter: { key: 'Enter', modifier: null },
    tab: { key: 'Tab', modifier: null },
    escape: { key: 'Escape', modifier: null },
    esc: { key: 'Escape', modifier: null },
    capslock: { key: 'CapsLock', modifier: null },
    rightalt: { key: 'AltRight', modifier: 'alt' },
    leftalt: { key: 'Alt', modifier: 'alt' },
    rightctrl: { key: 'CtrlRight', modifier: 'ctrl' },
    leftctrl: { key: 'Ctrl', modifier: 'ctrl' },
    rightshift: { key: 'ShiftRight', modifier: 'shift' },
    leftshift: { key: 'Shift', modifier: 'shift' },
    f1: { key: 'F1', modifier: null },
    f2: { key: 'F2', modifier: null },
    f3: { key: 'F3', modifier: null },
    f4: { key: 'F4', modifier: null },
    f5: { key: 'F5', modifier: null },
    f6: { key: 'F6', modifier: null },
    f7: { key: 'F7', modifier: null },
    f8: { key: 'F8', modifier: null },
    f9: { key: 'F9', modifier: null },
    f10: { key: 'F10', modifier: null },
    f11: { key: 'F11', modifier: null },
    f12: { key: 'F12', modifier: null },
    f13: { key: 'F13', modifier: null },
    f14: { key: 'F14', modifier: null },
    f15: { key: 'F15', modifier: null }
  };
  const entry = map[name.toLowerCase()];
  if (entry && UiohookKey[entry.key] !== undefined) {
    return { code: UiohookKey[entry.key] as number, modifier: entry.modifier };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase() as keyof typeof UiohookKey;
    if (UiohookKey[upper] !== undefined) {
      return { code: UiohookKey[upper] as number, modifier: null };
    }
  }
  return null;
}
