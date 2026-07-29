import { describe, expect, it } from 'vitest';
import {
  evdevToUiohookKeycode,
  parseInputEvents,
  parseKeyboardEventNodes
} from '../src/main/hotkey/evdev';

const EVENT_SIZE = 24;

function makeEvent(type: number, code: number, value: number): Buffer {
  const b = Buffer.alloc(EVENT_SIZE);
  // tv_sec / tv_usec left zero — the parser ignores timestamps.
  b.writeUInt16LE(type, 16);
  b.writeUInt16LE(code, 18);
  b.writeInt32LE(value, 20);
  return b;
}

describe('evdevToUiohookKeycode', () => {
  it('passes base-block scancodes through unchanged', () => {
    expect(evdevToUiohookKeycode(29)).toBe(29); // Left Ctrl
    expect(evdevToUiohookKeycode(57)).toBe(57); // Space
    expect(evdevToUiohookKeycode(47)).toBe(47); // V
    expect(evdevToUiohookKeycode(59)).toBe(59); // F1
    expect(evdevToUiohookKeycode(88)).toBe(88); // F12
  });

  it('maps extended keys to uiohook 0xE0xx codes', () => {
    expect(evdevToUiohookKeycode(97)).toBe(3613); // Right Ctrl
    expect(evdevToUiohookKeycode(100)).toBe(3640); // Right Alt
    expect(evdevToUiohookKeycode(125)).toBe(3675); // Left Meta
    expect(evdevToUiohookKeycode(126)).toBe(3676); // Right Meta
  });

  it('maps F13-F15 to uiohook codes', () => {
    expect(evdevToUiohookKeycode(183)).toBe(91);
    expect(evdevToUiohookKeycode(184)).toBe(92);
    expect(evdevToUiohookKeycode(185)).toBe(93);
  });
});

describe('parseInputEvents', () => {
  it('extracts EV_KEY events and skips others', () => {
    const chunk = Buffer.concat([
      makeEvent(4, 4, 458976), // EV_MSC scan
      makeEvent(1, 97, 1), // EV_KEY Right Ctrl down
      makeEvent(0, 0, 0), // EV_SYN
      makeEvent(1, 97, 0) // EV_KEY Right Ctrl up
    ]);
    const seen: Array<[number, number]> = [];
    const rest = parseInputEvents(chunk, (code, value) => seen.push([code, value]));
    expect(seen).toEqual([
      [97, 1],
      [97, 0]
    ]);
    expect(rest.length).toBe(0);
  });

  it('carries partial trailing bytes to the next chunk', () => {
    const full = makeEvent(1, 47, 1);
    const split = 10;
    const seen: Array<[number, number]> = [];
    const rest1 = parseInputEvents(full.subarray(0, split), (c, v) => seen.push([c, v]));
    expect(seen.length).toBe(0);
    expect(rest1.length).toBe(split);
    const rest2 = parseInputEvents(
      Buffer.concat([rest1, full.subarray(split)]),
      (c, v) => seen.push([c, v])
    );
    expect(seen).toEqual([[47, 1]]);
    expect(rest2.length).toBe(0);
  });
});

describe('parseKeyboardEventNodes', () => {
  const sample = [
    'I: Bus=0018 Vendor=045e Product=0000 Version=0000',
    'N: Name="Surface Keyboard"',
    'H: Handlers=sysrq kbd leds event3',
    'B: EV=120013',
    '',
    'I: Bus=0018 Vendor=045e Product=0000 Version=0000',
    'N: Name="Some Touchpad"',
    'H: Handlers=mouse0 event4',
    'B: EV=b',
    '',
    'I: Bus=0003 Vendor=046d Product=c52b Version=0111',
    'N: Name="USB Receiver Keyboard"',
    'H: Handlers=sysrq kbd leds event10',
    'B: EV=120013',
    ''
  ].join('\n');

  it('returns event nodes only for devices with a kbd handler', () => {
    expect(parseKeyboardEventNodes(sample)).toEqual([
      '/dev/input/event3',
      '/dev/input/event10'
    ]);
  });

  it('handles empty input', () => {
    expect(parseKeyboardEventNodes('')).toEqual([]);
  });
});
