import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// FakeWS captures constructor args and `send` payloads. Tests can drive it
// by emitting `open`, `error`, `close`, etc.
const hoisted = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  // Match Node ws WebSocket readyState values.
  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;

  class FakeWS extends EventEmitter {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    url: string;
    opts: unknown;
    readyState = CONNECTING;
    bufferedAmount = 0;
    sent: string[] = [];
    pinged = 0;
    terminated = false;
    closed = false;

    constructor(url: string, opts: unknown) {
      super();
      this.url = url;
      this.opts = opts;
      hoisted.instances.push(this);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    ping(): void {
      this.pinged++;
    }
    close(_code?: number): void {
      this.closed = true;
      this.readyState = CLOSED;
    }
    terminate(): void {
      this.terminated = true;
      this.readyState = CLOSED;
    }
    // Helper to simulate the server side opening the socket.
    _open(): void {
      this.readyState = OPEN;
      this.emit('open');
    }
  }

  return {
    FakeWS,
    instances: [] as InstanceType<typeof FakeWS>[]
  };
});

vi.mock('ws', () => {
  // The client imports ws as default plus references `WebSocket.OPEN`.
  // Provide both default and named.
  return {
    default: hoisted.FakeWS,
    WebSocket: hoisted.FakeWS
  };
});

import { RealtimeClient } from '../src/main/realtime/client';

function lastInstance(): InstanceType<typeof hoisted.FakeWS> {
  return hoisted.instances[hoisted.instances.length - 1]!;
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    hoisted.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect() resolves on `open` and sets rejectUnauthorized + servername', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    // Simulate ws open after one microtask.
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;

    const opts = inst.opts as Record<string, unknown>;
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.servername).toBe('api.openai.com');
    // Client emitted session.update on open.
    expect(inst.sent.length).toBe(1);
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.type).toBe('session.update');
  });

  it('connect() rejects on `error` before `open`; subsequent connect() does not throw "already connected"', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p1 = client.connect();
    await Promise.resolve();
    const inst1 = lastInstance();
    inst1.emit('error', new Error('boom'));
    await expect(p1).rejects.toThrow('boom');

    // Second connect should construct a new ws (i.e. ws field was nulled).
    const p2 = client.connect();
    await Promise.resolve();
    expect(hoisted.instances.length).toBe(2);
    const inst2 = lastInstance();
    inst2._open();
    await expect(p2).resolves.toBeUndefined();
  });

  it('appendAudio(Buffer) sends base64 in JSON', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;
    inst.sent.length = 0; // clear session.update

    client.appendAudio(Buffer.from([1, 2, 3]));
    expect(inst.sent.length).toBe(1);
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.type).toBe('input_audio_buffer.append');
    expect(msg.audio).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('appendAudio(ArrayBuffer) sends base64', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;
    inst.sent.length = 0;

    const ab = new Uint8Array([1, 2, 3]).buffer;
    client.appendAudio(ab);
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.audio).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('appendAudio(Uint8Array) sends base64', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;
    inst.sent.length = 0;

    client.appendAudio(new Uint8Array([1, 2, 3]));
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.audio).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('appendAudio(string) passes the base64 string through', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;
    inst.sent.length = 0;

    client.appendAudio('AAA=');
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.audio).toBe('AAA=');
  });

  it('appendAudio is dropped silently when bufferedAmount > 256_000', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;
    inst.sent.length = 0;

    // Threshold is 256 * 1024 = 262_144 bytes.
    inst.bufferedAmount = 300_000;
    client.appendAudio(Buffer.from([1, 2, 3]));
    expect(inst.sent.length).toBe(0);
  });

  it('after abnormal close, schedules a reconnect; cap at 5 attempts', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst1 = lastInstance();
    inst1._open();
    await p;

    // Abnormal close — abnormal because cleanClose flag is false (no .close() call).
    inst1.emit('close');

    // First backoff: 250ms + jitter (<100). Advance 400ms to be safe.
    await vi.advanceTimersByTimeAsync(400);

    // A new ws instance was created.
    expect(hoisted.instances.length).toBeGreaterThanOrEqual(2);
    const inst2 = lastInstance();
    inst2._open();
    await Promise.resolve();
    // Reconnect succeeded — emit a fresh close to test the cap.
    // Force 5 more failures: each reconnect will create a new ws then close it abnormally.

    // Run reconnect-fail loop. Each iteration: emit close on latest, advance backoff.
    for (let i = 0; i < 6; i++) {
      const cur = lastInstance();
      cur.emit('close');
      // Largest backoff cap is 5_000ms + 100 jitter.
      await vi.advanceTimersByTimeAsync(5_200);
    }

    // After RECONNECT_MAX_ATTEMPTS=5 abnormal closes since the most recent
    // successful open, no further reconnect ws should be created.
    const finalCount = hoisted.instances.length;
    // Drive timers further — count must not grow.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.instances.length).toBe(finalCount);
  });

  it('dispose() clears reconnect timer and detaches listeners', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;

    let closeCount = 0;
    client.on('close', () => closeCount++);

    client.dispose();
    // Subsequent close emits from old ws must NOT cause reconnect or 'close' on client.
    inst.emit('close');
    await vi.advanceTimersByTimeAsync(10_000);
    // No new instance constructed.
    expect(hoisted.instances.length).toBe(1);
    // dispose calls removeAllListeners on the emitter, so the listener we
    // attached above won't fire; close count remains 0.
    expect(closeCount).toBe(0);
  });

  it('idle ping: after 20s without activity, the client sends a ping', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    await p;

    expect(inst.pinged).toBe(0);
    await vi.advanceTimersByTimeAsync(20_500);
    expect(inst.pinged).toBeGreaterThanOrEqual(1);

    client.dispose();
  });
});
