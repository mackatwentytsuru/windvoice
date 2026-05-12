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
  /**
   * One or more uiohook keycodes that should fire this binding. Multiple
   * codes are used when a single token (e.g. "Meta") corresponds to both
   * a left and right physical key (uiohook reports `Meta` for the left
   * Cmd/Win key and `MetaRight` for the right one), and we want either
   * to trigger the binding.
   *
   * Typed as a non-empty tuple so the construction site in `normalize`
   * is forced to provide at least one keycode (L1) — an empty array
   * would silently disable the binding at runtime.
   */
  triggerKeys: readonly [number, ...number[]];
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
  /**
   * When the typer is synthesizing a paste keystroke (uIOhook.keyTap on macOS
   * emits a fresh Meta-down/Meta-up pair), uIOhook reports those synthetic
   * events back through this same listener. Without suppression, a paste of
   * Cmd+V would self-trigger a brand-new push-to-talk dictation cycle. The
   * typer flips this flag for the duration of the synthesized keystroke.
   */
  private suppressUntil = 0;
  /**
   * Live snapshot of the OS modifier state, refreshed on every key event.
   * Used by the typer to wait for the user to physically release any
   * modifier (especially Right Alt as the push-to-talk hotkey) before
   * synthesizing Ctrl+V — otherwise the receiving app sees Alt+Ctrl+V and
   * triggers a menu instead of pasting.
   */
  private modifierState: Record<Modifier, boolean> = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false
  };

  setBindings(list: HotkeyBinding[]): void {
    this.bindings = list
      .map((b) => HotkeyManager.normalize(b))
      .filter((x): x is NormalizedBinding => x !== null);
    if (isDebug('HOTKEY')) {
      const summary = this.bindings.map((b) => ({
        id: b.binding.id,
        triggerKeys: b.triggerKeys,
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

  /**
   * Specifically: is Ctrl physically held right now? Used by the
   * paste-injection path to decide whether to synth Ctrl-down/up around
   * the V keystroke or rely on the user's own held Ctrl as the modifier.
   */
  isCtrlHeld(): boolean {
    return this.modifierState.ctrl;
  }

  /**
   * Ignore all key events for the next `ms` milliseconds. Used by the typer
   * around synthesized paste keystrokes so we don't self-trigger a new
   * push-to-talk cycle from our own Cmd+V emission.
   */
  suppressFor(ms: number): void {
    const deadline = Date.now() + ms;
    if (deadline > this.suppressUntil) this.suppressUntil = deadline;
  }

  /**
   * Returns true if any modifier (Alt/Ctrl/Shift/Meta) is currently
   * physically held by the user, per the latest uIOhook event.
   */
  isAnyModifierHeld(): boolean {
    return (
      this.modifierState.alt ||
      this.modifierState.ctrl ||
      this.modifierState.shift ||
      this.modifierState.meta
    );
  }

  /** Waiters that resolve the next time all modifiers transition to up. */
  private modifierReleaseWaiters: Array<() => void> = [];

  /**
   * Resolve once no modifier key is physically held, or after `timeoutMs`.
   * The typer awaits this before synthesizing Ctrl+V to dodge the
   * Right-Alt-still-held → Alt+Ctrl+V → menu-activation bug.
   *
   * Event-driven: registers a one-shot waiter that fires when `onKey`
   * observes the transition. Previously this busy-polled with a 8ms
   * setTimeout loop (issue #9) — up to 75 timer wakeups per paste,
   * which contended with the paste-settle window we were trying to
   * protect. The fallback `setTimeout(timeoutMs)` guards against
   * uIOhook never delivering the up event.
   */
  untilAllModifiersUp(timeoutMs = 600): Promise<void> {
    if (!this.isAnyModifierHeld()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const idx = this.modifierReleaseWaiters.indexOf(finish);
        if (idx !== -1) this.modifierReleaseWaiters.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(() => {
        debug('HOTKEY', `untilAllModifiersUp: timed out after ${timeoutMs}ms`);
        finish();
      }, timeoutMs);
      this.modifierReleaseWaiters.push(finish);
    });
  }

  private onKey(e: UiohookKeyboardEventLike, down: boolean): void {
    // Refresh modifier snapshot on every key event. This is fed by the OS,
    // so it correctly reflects the user's physical key state at any moment.
    const wasAnyHeld = this.isAnyModifierHeld();
    this.modifierState.ctrl = e.ctrlKey;
    this.modifierState.alt = e.altKey;
    this.modifierState.shift = e.shiftKey;
    this.modifierState.meta = e.metaKey;

    // Wake up any `untilAllModifiersUp` waiters the instant all
    // modifiers transition to released — replaces the 8ms busy-poll.
    if (wasAnyHeld && !this.isAnyModifierHeld() && this.modifierReleaseWaiters.length > 0) {
      const waiters = this.modifierReleaseWaiters.slice();
      this.modifierReleaseWaiters.length = 0;
      for (const w of waiters) {
        try {
          w();
        } catch {
          /* ignore — waiter throw must not break onKey */
        }
      }
    }

    if (isDebug('HOTKEY')) {
      debug('HOTKEY', `${down ? 'down' : 'up  '} keycode=${e.keycode} alt=${e.altKey} ctrl=${e.ctrlKey} shift=${e.shiftKey} meta=${e.metaKey}`);
    }

    // Suppression window: skip the binding loop, but ALWAYS run the
    // physical-release safety check below — otherwise a user releasing
    // the PTT modifier inside the suppression window (e.g. mid-stream
    // on macOS, where each streaming-paste sets suppressUntil) is lost,
    // and the binding stays in heldDown forever — visible to the user
    // as "录音中" stuck on after release.
    const suppressed = Date.now() < this.suppressUntil;

    if (!suppressed) {
      for (const nb of this.bindings) {
        if (!nb.triggerKeys.includes(e.keycode)) continue;
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

    // Safety net for the "stuck listening" bug: if a push-to-talk binding
    // is in heldDown but the modifier it depends on is no longer
    // physically held, force-stop it. This catches user-release events
    // that landed inside `suppressUntil` (streaming paste on macOS) and
    // would otherwise leave the orchestrator recording forever.
    if (this.heldDown.size > 0) {
      for (const nb of this.bindings) {
        const id = nb.binding.id;
        if (!this.heldDown.has(id)) continue;
        if (nb.triggerProvidesModifier === null) continue;
        if (!this.modifierState[nb.triggerProvidesModifier]) {
          this.heldDown.delete(id);
          this.emit('stop', id);
          debug('HOTKEY', `force-stop ${id}: ${nb.triggerProvidesModifier} no longer held`);
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
    let triggerKeys: number[] | null = null;
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
        // Bare Meta/Cmd is allowed as a push-to-talk trigger (e.g. Cmd alone
        // on macOS). The Hotkey rebind UI emits a single "Meta" token regardless
        // of which physical Cmd key was pressed, so we must accept BOTH the
        // left (`UiohookKey.Meta`) and the right (`UiohookKey.MetaRight`)
        // keycodes — otherwise pressing the wrong Cmd silently does nothing.
        if (triggerKeys == null) {
          triggerKeys = metaKeyCodes();
          triggerProvidesModifier = 'meta';
        }
      } else {
        const looked = lookupKey(norm);
        if (looked != null) {
          triggerKeys = [looked.code];
          triggerProvidesModifier = looked.modifier;
        }
      }
    }
    if (triggerKeys == null || triggerKeys.length === 0) return null;
    const tuple = triggerKeys as [number, ...number[]];
    return { binding: b, triggerKeys: tuple, modifiers: mods, triggerProvidesModifier };
  }
}

function metaKeyCodes(): number[] {
  const codes: number[] = [];
  const left = UiohookKey.Meta;
  if (typeof left === 'number') codes.push(left);
  const right = (UiohookKey as Record<string, number | undefined>).MetaRight;
  if (typeof right === 'number' && right !== left) codes.push(right);
  return codes;
}

/**
 * Process-wide accessor so non-EventEmitter callers (e.g. the typer) can
 * await modifier-release without explicit dependency injection. Set by
 * main/index.ts after the manager is constructed.
 */
let activeManager: HotkeyManager | null = null;

export function setActiveHotkeyManager(m: HotkeyManager | null): void {
  activeManager = m;
}

export function getActiveHotkeyManager(): HotkeyManager | null {
  return activeManager;
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
