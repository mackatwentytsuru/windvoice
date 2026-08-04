import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/windvoice-test',
    getAppPath: () => '/tmp/windvoice-app'
  }
}));

class FakePipe extends EventEmitter {
  setEncoding = vi.fn();
  write = vi.fn();
}

class FakeChild extends EventEmitter {
  stdin = new FakePipe();
  stdout = new FakePipe();
  stderr = new FakePipe();
  kill = vi.fn(() => true);
}

import { PortalSidecar } from '../src/main/linux/portalSidecar';

function failed(child: FakeChild, denied: boolean): void {
  child.stdout.emit(
    'data',
    `${JSON.stringify({ event: 'failed', denied, code: denied ? 2 : 1 })}\n`
  );
}

function ready(child: FakeChild): void {
  child.stdout.emit('data', '{"event":"ready","clipboard":true}\n');
}

function lastRequest(child: FakeChild): Record<string, unknown> {
  const line = child.stdin.write.mock.calls.at(-1)?.[0];
  if (typeof line !== 'string') throw new Error('sidecar request was not written');
  return JSON.parse(line) as Record<string, unknown>;
}

function reply(child: FakeChild, request: Record<string, unknown>, fields: object): void {
  child.stdout.emit('data', `${JSON.stringify({ id: request.id, ...fields })}\n`);
}

describe('PortalSidecar supervision', () => {
  let children: FakeChild[];
  let sidecar: PortalSidecar;
  let unavailable: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    unavailable = vi.fn();
    sidecar = new PortalSidecar({
      resolveScript: () => '/tmp/portal-remote.py',
      spawnChild: () => {
        const child = new FakeChild();
        children.push(child);
        return child as never;
      }
    });
    sidecar.setUnavailableListener(unavailable);
  });

  afterEach(() => {
    sidecar.stop();
    vi.useRealTimers();
  });

  it('respawns after a transient failed event', async () => {
    sidecar.start();
    failed(children[0]!, false);

    expect(children[0]!.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(children).toHaveLength(2);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('does not respawn after a denied failed event', async () => {
    sidecar.start();
    failed(children[0]!, true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(children).toHaveLength(1);
    expect(unavailable).toHaveBeenCalledWith(true);
  });

  it('notifies unavailable after exhausting the bounded respawn budget', async () => {
    sidecar.start();

    for (let attempt = 0; attempt < 6; attempt++) {
      failed(children[attempt]!, false);
      await vi.advanceTimersByTimeAsync(3_000);
    }

    expect(children).toHaveLength(6);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith(false);

    sidecar.retryForDictation();
    expect(children).toHaveLength(7);
  });

  it('ignores a late exit from a replaced child', async () => {
    sidecar.start();
    const first = children[0]!;
    sidecar.restart();
    const second = children[1]!;
    second.stdout.emit('data', '{"event":"ready","clipboard":true}\n');

    first.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sidecar.isReady()).toBe(true);
    expect(children).toHaveLength(2);
  });

  it('kills and respawns the child when a mutating paste times out', async () => {
    sidecar.start();
    const first = children[0]!;
    first.stdout.emit('data', '{"event":"ready","clipboard":true}\n');

    const paste = sidecar.pasteText('hello', true, 0, 0);
    // Three verified attempts each own a 750ms receipt window before the
    // supervisor's fixed 15s safety margin expires.
    await vi.advanceTimersByTimeAsync(17_250);

    await expect(paste).resolves.toMatchObject({
      ok: false,
      injected: null,
      stage: 'inject'
    });
    expect(first.kill).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(children).toHaveLength(2);
  });

  it('uses the terminal-safe chord and does not call a key dispatch a successful paste', async () => {
    sidecar.start();
    const child = children[0]!;
    ready(child);

    const paste = sidecar.pasteText('hello', true, 60, 1_500);
    const request = lastRequest(child);
    expect(request).toMatchObject({
      op: 'paste',
      shortcut: 'ctrl-shift-v',
      verifyMs: 750,
      attempts: [
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 20 },
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 60 },
        { shortcut: 'ctrl-v', method: 'keysym', interEventMs: 60 }
      ]
    });
    reply(child, request, {
      ok: false,
      claimed: true,
      injected: true,
      selectionRead: false,
      restored: false,
      targetApp: 'unknown',
      attemptCount: 3,
      shortcut: 'ctrl-v',
      injectionMethod: 'keysym',
      stage: 'verify',
      error: 'selection was not read'
    });

    await expect(paste).resolves.toMatchObject({
      ok: false,
      injected: true,
      selectionRead: false,
      sessionRecyclePending: true,
      targetApp: 'unknown',
      attemptCount: 3,
      shortcut: 'ctrl-v',
      injectionMethod: 'keysym',
      stage: 'verify'
    });
    expect(child.kill).not.toHaveBeenCalled();

    sidecar.retryForDictation();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
  });

  it('recycles a tainted virtual keyboard session before the next paste', async () => {
    sidecar.start();
    const first = children[0]!;
    ready(first);

    const paste = sidecar.pasteText('hello', true, 0, 0);
    const request = lastRequest(first);
    reply(first, request, {
      ok: false,
      claimed: true,
      injected: null,
      selectionRead: false,
      restored: false,
      tainted: true,
      stage: 'inject',
      error: 'modifier release failed'
    });

    await expect(paste).resolves.toMatchObject({
      ok: false,
      injected: null,
      selectionRead: false,
      sessionReset: true
    });
    expect(first.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
  });

  it('rebuilds a session whose standalone selection claim timed out', async () => {
    sidecar.start();
    const first = children[0]!;
    ready(first);

    const mutation = sidecar.setSelection('hello');
    const request = lastRequest(first);
    reply(first, request, {
      ok: false,
      tainted: true,
      error: 'selection ownership was not confirmed before the deadline'
    });

    await expect(mutation).resolves.toMatchObject({
      ok: false,
      uncertain: true
    });
    expect(first.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
  });

  it('keeps a delivered paste successful when restore times out and rebuilds the session', async () => {
    sidecar.start();
    const first = children[0]!;
    ready(first);

    const paste = sidecar.pasteText('hello', true, 0, 0);
    const request = lastRequest(first);
    reply(first, request, {
      ok: true,
      claimed: true,
      injected: true,
      selectionRead: true,
      restored: false,
      tainted: true,
      stage: 'restore',
      error: 'selection ownership was not confirmed before the deadline'
    });

    await expect(paste).resolves.toMatchObject({
      ok: true,
      injected: true,
      selectionRead: true,
      restored: false,
      sessionReset: true,
      stage: 'restore'
    });
    expect(first.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
  });
});
