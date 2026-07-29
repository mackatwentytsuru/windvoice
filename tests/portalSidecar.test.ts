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
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(paste).resolves.toMatchObject({
      ok: false,
      injected: null,
      stage: 'inject'
    });
    expect(first.kill).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(children).toHaveLength(2);
  });
});
