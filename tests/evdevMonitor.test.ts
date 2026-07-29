import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  class FakeReadStream extends EventEmitter {
    destroyed = false;
    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.emit('close');
      return this;
    }
  }
  return {
    FakeReadStream,
    procText: '',
    streams: [] as InstanceType<typeof FakeReadStream>[]
  };
});

vi.mock('node:fs', () => {
  const fns = {
    readFileSync: vi.fn(() => hoisted.procText),
    openSync: vi.fn(() => 42),
    createReadStream: vi.fn(() => {
      const stream = new hoisted.FakeReadStream();
      hoisted.streams.push(stream);
      return stream;
    }),
    watch: vi.fn(() => ({ close: vi.fn() }))
  };
  return { default: fns, ...fns };
});

import { EvdevKeyboardMonitor } from '../src/main/hotkey/evdev';

const EVENT_SIZE = 24;

function makeKey(code: number, value: number): Buffer {
  const event = Buffer.alloc(EVENT_SIZE);
  event.writeUInt16LE(1, 16);
  event.writeUInt16LE(code, 18);
  event.writeInt32LE(value, 20);
  return event;
}

function keyboardProc(...events: number[]): string {
  return events
    .map(
      (event) =>
        `I: Bus=0003 Vendor=0001 Product=0001 Version=0001\n` +
        `N: Name="Keyboard ${event}"\n` +
        `H: Handlers=sysrq kbd event${event}\n` +
        `B: EV=120013`
    )
    .join('\n\n');
}

describe('EvdevKeyboardMonitor device lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.procText = keyboardProc(1, 2);
    hoisted.streams.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a modifier held until every keyboard releases it', () => {
    const monitor = new EvdevKeyboardMonitor();
    const events: Array<{ keycode: number; down: boolean; modifiers: { ctrl: boolean } }> = [];
    monitor.on('key', (event) => events.push(event));
    monitor.start();

    hoisted.streams[0]!.emit('data', makeKey(97, 1));
    hoisted.streams[1]!.emit('data', makeKey(97, 1));
    hoisted.streams[1]!.emit('data', makeKey(97, 0));
    hoisted.streams[1]!.emit('data', makeKey(47, 1));

    expect(events.at(-1)).toMatchObject({
      keycode: 47,
      down: true,
      modifiers: { ctrl: true }
    });
    expect(events.filter((event) => event.keycode === 3613)).toHaveLength(1);
    monitor.stop();
  });

  it('rescans after a stream error and emits ready again after zero devices', async () => {
    hoisted.procText = keyboardProc(1);
    const monitor = new EvdevKeyboardMonitor();
    const ready = vi.fn();
    const unavailable = vi.fn();
    monitor.on('ready', ready);
    monitor.on('unavailable', unavailable);
    monitor.start();

    hoisted.streams[0]!.emit('error', new Error('device reset'));
    expect(unavailable).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(500);

    expect(hoisted.streams).toHaveLength(2);
    expect(ready).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
