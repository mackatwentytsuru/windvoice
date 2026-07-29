// Linux/Wayland hotkey capture via evdev (/dev/input/event*).
//
// Why this exists: uiohook's Linux backend is X11 XRecord. Under a Wayland
// compositor (GNOME, KDE-Wayland, …) XRecord only observes keys delivered to
// XWayland clients — keys typed while a Wayland-native window has focus are
// invisible, which makes a global push-to-talk hotkey useless. The kernel
// evdev layer sits below the display server, so reading the keyboard
// character devices directly restores true global key visibility on any
// session type.
//
// Requirements: read access to /dev/input/event* — on virtually every
// distribution that means the user must be a member of the `input` group
// (`sudo usermod -aG input $USER` + re-login). When no device can be opened
// the monitor emits `permission-denied` once per unavailable episode so the caller can
// surface setup instructions; it keeps watching /dev/input and recovers
// automatically once permissions appear (e.g. after re-login the app's
// autostart instance can open the devices immediately).
//
// This module intentionally has no native dependencies: input_event structs
// are parsed with Buffer reads.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { debug } from '@main/debug';

const DEV_INPUT = '/dev/input';
const PROC_DEVICES = '/proc/bus/input/devices';

/** struct input_event on 64-bit: __u64 sec + __u64 usec + __u16 type + __u16 code + __s32 value */
const EVENT_SIZE = 24;
const EV_KEY = 1;

/** evdev KEY_* codes for modifier tracking (input-event-codes.h). */
const EV_LEFTCTRL = 29;
const EV_RIGHTCTRL = 97;
const EV_LEFTSHIFT = 42;
const EV_RIGHTSHIFT = 54;
const EV_LEFTALT = 56;
const EV_RIGHTALT = 100;
const EV_LEFTMETA = 125;
const EV_RIGHTMETA = 126;

/**
 * evdev keycode → uiohook keycode.
 *
 * uiohook keycodes are PS/2 scan-code set 1 values, and the Linux KEY_*
 * codes for the "base" keyboard block (letters, digits, F1–F12, left-side
 * modifiers, Space/Enter/Tab/Esc/CapsLock) are numerically identical to
 * set-1 scancodes — those pass through unchanged. Extended keys differ:
 * uiohook encodes them as 0xE000|scancode while evdev assigns fresh codes.
 * Only the extended keys WindVoice bindings can reference are mapped here;
 * unmapped extended codes fall back to pass-through, which at worst means a
 * binding on an exotic key does not fire (never a mis-fire, since uiohook
 * bindings for those keys would hold the 0xE0xx value).
 */
const EVDEV_TO_UIOHOOK: Readonly<Record<number, number>> = {
  [EV_RIGHTCTRL]: 3613, // UiohookKey.CtrlRight (0xE01D)
  [EV_RIGHTALT]: 3640, // UiohookKey.AltRight (0xE038)
  [EV_LEFTMETA]: 3675, // UiohookKey.Meta (0xE05B)
  [EV_RIGHTMETA]: 3676, // UiohookKey.MetaRight (0xE05C)
  183: 91, // F13
  184: 92, // F14
  185: 93 // F15
};

export function evdevToUiohookKeycode(code: number): number {
  return EVDEV_TO_UIOHOOK[code] ?? code;
}

export interface EvdevModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface EvdevKeyEvent {
  /** uiohook-compatible keycode (post-mapping) */
  keycode: number;
  down: boolean;
  modifiers: EvdevModifiers;
}

export interface EvdevMonitorEvents {
  key: (e: EvdevKeyEvent) => void;
  /** No readable keyboard device — user is likely missing `input` group membership. */
  'permission-denied': () => void;
  /** A previously-ready monitor lost its last readable device. */
  unavailable: () => void;
  /** At least one keyboard device opened successfully. */
  ready: (deviceCount: number) => void;
}

export declare interface EvdevKeyboardMonitor {
  on<K extends keyof EvdevMonitorEvents>(event: K, listener: EvdevMonitorEvents[K]): this;
  emit<K extends keyof EvdevMonitorEvents>(
    event: K,
    ...args: Parameters<EvdevMonitorEvents[K]>
  ): boolean;
}

/**
 * Parse /proc/bus/input/devices and return the /dev/input/eventN paths of
 * devices whose handlers include `kbd` — the kernel's own "this device can
 * produce keyboard input" classification. Exported for tests.
 */
export function parseKeyboardEventNodes(procText: string): string[] {
  const nodes: string[] = [];
  for (const block of procText.split(/\n\s*\n/)) {
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1];
    if (!handlers) continue;
    if (!/\bkbd\b/.test(handlers)) continue;
    const event = /\bevent(\d+)\b/.exec(handlers)?.[1];
    if (event === undefined) continue;
    nodes.push(path.join(DEV_INPUT, `event${event}`));
  }
  return nodes;
}

/**
 * Incremental input_event parser. Handles chunk boundaries that split an
 * event struct. Returns the leftover partial bytes to carry into the next
 * chunk. Exported for tests.
 */
export function parseInputEvents(
  chunk: Buffer,
  onKey: (code: number, value: number) => void
): Buffer {
  let offset = 0;
  while (offset + EVENT_SIZE <= chunk.length) {
    const type = chunk.readUInt16LE(offset + 16);
    if (type === EV_KEY) {
      const code = chunk.readUInt16LE(offset + 18);
      const value = chunk.readInt32LE(offset + 20);
      onKey(code, value);
    }
    offset += EVENT_SIZE;
  }
  return chunk.subarray(offset);
}

export class EvdevKeyboardMonitor extends EventEmitter {
  private streams = new Map<string, fs.ReadStream>();
  private remainders = new Map<string, Buffer>();
  private heldByDevice = new Map<string, Set<number>>();
  private watcher: fs.FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private started = false;
  private permissionDeniedEmitted = false;
  private readyEmitted = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scan();
    // Hotplug: a USB keyboard appearing (or permissions appearing after the
    // user joins the `input` group and re-logs in with the app autostarted)
    // triggers a debounced rescan.
    try {
      this.watcher = fs.watch(DEV_INPUT, () => this.scheduleRescan());
    } catch (err) {
      debug('HOTKEY', `evdev: watch ${DEV_INPUT} failed: ${err}`);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    for (const [, stream] of this.streams) stream.destroy();
    this.streams.clear();
    this.remainders.clear();
    this.heldByDevice.clear();
    this.readyEmitted = false;
  }

  isAnyDeviceOpen(): boolean {
    return this.streams.size > 0;
  }

  private scheduleRescan(): void {
    if (!this.started || this.rescanTimer) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.scan();
    }, 500);
    if (typeof this.rescanTimer.unref === 'function') this.rescanTimer.unref();
  }

  private scan(): void {
    if (!this.started) return;
    let procText: string;
    try {
      procText = fs.readFileSync(PROC_DEVICES, 'utf8');
    } catch (err) {
      debug('HOTKEY', `evdev: read ${PROC_DEVICES} failed: ${err}`);
      return;
    }
    const nodes = parseKeyboardEventNodes(procText);
    // Close streams for devices that disappeared.
    for (const [node, stream] of this.streams) {
      if (!nodes.includes(node)) {
        this.removeDevice(node, stream, false);
        stream.destroy();
      }
    }
    let denied = 0;
    for (const node of nodes) {
      if (this.streams.has(node)) continue;
      try {
        // Open synchronously so EACCES is caught here rather than surfacing
        // as an async stream error we would have to correlate back.
        const fd = fs.openSync(node, 'r');
        const stream = fs.createReadStream('', { fd, highWaterMark: 4096 });
        stream.on('data', (chunk) => this.onChunk(node, chunk as Buffer));
        stream.on('error', (err) => {
          debug('HOTKEY', `evdev: ${node} stream error: ${err}`);
          this.removeDevice(node, stream, true);
          stream.destroy();
        });
        stream.on('close', () => {
          this.removeDevice(node, stream, true);
        });
        this.heldByDevice.set(node, new Set());
        this.streams.set(node, stream);
        debug('HOTKEY', `evdev: reading ${node}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') denied += 1;
        else debug('HOTKEY', `evdev: open ${node} failed: ${err}`);
      }
    }
    if (this.streams.size > 0) {
      if (!this.readyEmitted) {
        this.readyEmitted = true;
        this.permissionDeniedEmitted = false;
        this.emit('ready', this.streams.size);
      }
    } else if (denied > 0 && !this.permissionDeniedEmitted) {
      this.permissionDeniedEmitted = true;
      this.emit('permission-denied');
    }
  }

  private onChunk(node: string, chunk: Buffer): void {
    if (!this.heldByDevice.has(node)) return;
    const prev = this.remainders.get(node);
    const buf = prev && prev.length > 0 ? Buffer.concat([prev, chunk]) : chunk;
    const rest = parseInputEvents(buf, (code, value) => this.onKeyEvent(node, code, value));
    this.remainders.set(node, Buffer.from(rest));
  }

  private removeDevice(node: string, stream: fs.ReadStream, rescan: boolean): void {
    if (this.streams.get(node) !== stream) return;
    const released = this.heldByDevice.get(node) ?? new Set<number>();
    this.streams.delete(node);
    this.remainders.delete(node);
    this.heldByDevice.delete(node);

    // Synthesize releases only for keys no other keyboard still holds.
    // This keeps HotkeyManager's own heldDown state in sync on unplug.
    for (const code of released) {
      if (!this.isHeld(code)) this.emitKey(code, false);
    }

    if (this.started && this.streams.size === 0 && this.readyEmitted) {
      this.readyEmitted = false;
      this.emit('unavailable');
    }
    if (rescan) this.scheduleRescan();
  }

  private isHeld(code: number): boolean {
    for (const held of this.heldByDevice.values()) {
      if (held.has(code)) return true;
    }
    return false;
  }

  private currentModifiers(): EvdevModifiers {
    return {
      ctrl: this.isHeld(EV_LEFTCTRL) || this.isHeld(EV_RIGHTCTRL),
      alt: this.isHeld(EV_LEFTALT) || this.isHeld(EV_RIGHTALT),
      shift: this.isHeld(EV_LEFTSHIFT) || this.isHeld(EV_RIGHTSHIFT),
      meta: this.isHeld(EV_LEFTMETA) || this.isHeld(EV_RIGHTMETA)
    };
  }

  private onKeyEvent(node: string, code: number, value: number): void {
    // value: 0 = release, 1 = press, 2 = auto-repeat. Auto-repeat is
    // forwarded as a keydown — mirroring uiohook, whose repeats HotkeyManager
    // already de-bounces (heldDown / toggleHeld guards).
    const held = this.heldByDevice.get(node);
    if (!held) return;
    const down = value !== 0;
    if (value === 2) {
      this.emitKey(code, true);
      return;
    }
    const wasDown = this.isHeld(code);
    if (down) held.add(code);
    else held.delete(code);
    const isDown = this.isHeld(code);
    // Multiple keyboards can report the same key. Only forward the global
    // up/down transition so releasing B cannot release a key still held on A.
    if (wasDown === isDown) return;
    this.emitKey(code, isDown);
  }

  private emitKey(code: number, down: boolean): void {
    const modifiers = this.currentModifiers();
    // Never log raw key transitions. Even numeric codes plus timing form a
    // recoverable keystroke trace and the debug log persists across sessions.
    this.emit('key', { keycode: evdevToUiohookKeycode(code), down, modifiers });
  }
}
