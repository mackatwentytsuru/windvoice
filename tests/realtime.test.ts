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

// connect() no longer resolves on socket-open: the server must ack our
// session.update (v0.1.8 watchdog). Helper to feed the ack.
function ackSessionUpdate(inst: InstanceType<typeof hoisted.FakeWS>): void {
  inst.emit('message', Buffer.from(JSON.stringify({ type: 'transcription_session.updated' })));
}

// Drive a fresh connect() through open + ready ack and return the FakeWS.
async function openAndReady(p: Promise<void>): Promise<InstanceType<typeof hoisted.FakeWS>> {
  await Promise.resolve();
  const inst = lastInstance();
  inst._open();
  ackSessionUpdate(inst);
  await p;
  return inst;
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    hoisted.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect() resolves on session.updated ack and sets rejectUnauthorized + servername', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);

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
    ackSessionUpdate(inst2);
    await expect(p2).resolves.toBeUndefined();
  });

  it('appendAudio(Buffer) sends base64 in JSON', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);
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
    const inst = await openAndReady(p);
    inst.sent.length = 0;

    const ab = new Uint8Array([1, 2, 3]).buffer;
    client.appendAudio(ab);
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.audio).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('appendAudio(Uint8Array) sends base64', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);
    inst.sent.length = 0;

    client.appendAudio(new Uint8Array([1, 2, 3]));
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.audio).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('appendAudio(string) passes the base64 string through', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);
    inst.sent.length = 0;

    client.appendAudio('AAA=');
    const msg = JSON.parse(inst.sent[0]!);
    expect(msg.audio).toBe('AAA=');
  });

  it('appendAudio is dropped silently when bufferedAmount > 256_000', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);
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
    const inst1 = await openAndReady(p);

    // Abnormal close — abnormal because cleanClose flag is false (no .close() call).
    inst1.emit('close');

    // First backoff: 250ms + jitter (<100). Advance 400ms to be safe.
    await vi.advanceTimersByTimeAsync(400);

    // A new ws instance was created.
    expect(hoisted.instances.length).toBeGreaterThanOrEqual(2);
    const inst2 = lastInstance();
    inst2._open();
    ackSessionUpdate(inst2);
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

  it('emits "reconnecting" before scheduling a silent auto-reconnect after an abnormal close', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);

    let reconnecting = 0;
    let closed = 0;
    client.on('reconnecting', () => reconnecting++);
    client.on('close', () => closed++);

    // Abnormal close (no .close() call → cleanClose false): the client
    // schedules a reconnect and announces it via 'reconnecting' WITHOUT
    // emitting 'close'.
    inst.emit('close');
    expect(reconnecting).toBe(1);
    expect(closed).toBe(0);

    client.dispose();
  });

  it('dispose() clears reconnect timer and detaches listeners', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    const inst = await openAndReady(p);

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
    const inst = await openAndReady(p);

    expect(inst.pinged).toBe(0);
    await vi.advanceTimersByTimeAsync(20_500);
    expect(inst.pinged).toBeGreaterThanOrEqual(1);

    client.dispose();
  });

  // v0.1.8 regression class: the server accepts the WS, then rejects our
  // session.update — the session is dead while looking healthy.
  it('server error during setup rejects connect() and never resends the rejected payload', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    expect(inst.sent.map((s) => (JSON.parse(s) as { type: string }).type)).toEqual([
      'session.update'
    ]);

    inst.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          error: { message: "The 'prompt' parameter is not supported for this model." }
        })
      )
    );
    await expect(p).rejects.toThrow("The 'prompt' parameter is not supported");
    expect(inst.terminated).toBe(true);

    // No reconnect loop: no new ws is constructed however long we wait,
    // so the identical (rejected) session.update is never resent.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hoisted.instances.length).toBe(1);
  });

  it('connect() rejects when no session.updated ack arrives within 5s (ready watchdog)', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();

    const assertion = expect(p).rejects.toThrow('not ready within 5s');
    await vi.advanceTimersByTimeAsync(5_100);
    await assertion;
    expect(inst.terminated).toBe(true);
  });

  it('accepts the GA `session.updated` ack name as ready', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    inst.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    await expect(p).resolves.toBeUndefined();
    client.dispose();
  });

  it('connect() rejects when the socket closes before the setup ack', async () => {
    const client = new RealtimeClient({ apiKey: 'sk-x', vadEnabled: false });
    const p = client.connect();
    await Promise.resolve();
    const inst = lastInstance();
    inst._open();
    inst.emit('close');
    await expect(p).rejects.toThrow('connection closed during session setup');
  });
});
