import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

// vi.mock factories are hoisted; collaborate via vi.hoisted state.
// `EventEmitter` must be required inside the hoisted callback because
// the callback runs before any top-level imports resolve.
const hoisted = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  class FakeRealtimeClient extends EventEmitter {
    opts: unknown;
    opened = false;
    appended: string[] = [];
    committed = false;
    closed = false;
    connectDelay = 50;
    failConnect = false;

    constructor(opts: unknown) {
      super();
      this.opts = opts;
      hoisted.instances.push(this);
    }

    async connect(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (this.failConnect) {
            reject(new Error('mock connect failure'));
            return;
          }
          this.opened = true;
          resolve();
        }, this.connectDelay);
      });
    }

    appendAudio(b64: string): void {
      if (!this.opened) return;
      this.appended.push(b64);
    }
    commit(): void {
      if (!this.opened) return;
      this.committed = true;
    }
    close(): void {
      this.opened = false;
      this.closed = true;
      this.emit('close');
    }
    isOpen(): boolean {
      return this.opened;
    }
  }
  return {
    FakeRealtimeClient,
    instances: [] as InstanceType<typeof FakeRealtimeClient>[]
  };
});

vi.mock('@main/realtime/client', () => ({
  RealtimeClient: hoisted.FakeRealtimeClient
}));

vi.mock('@main/store/secure', () => ({
  secureStore: {
    getApiKey: vi.fn().mockResolvedValue('sk-test'),
    hasApiKey: vi.fn().mockResolvedValue(true),
    setApiKey: vi.fn(),
    clearApiKey: vi.fn()
  }
}));

vi.mock('@main/store/settings', () => ({
  settingsStore: {
    get: vi.fn(() => ({
      hotkeys: [],
      audio: { device: 'default', inputGain: 1 },
      language: 'ja',
      formatter: { model: 'gpt-5-mini', customInstructions: '', enabled: true },
      dictionary: [],
      insertion: {
        method: 'paste',
        restoreClipboard: true,
        streaming: false,
        pasteCompatibility: 'balanced',
        excludeFromClipboardHistory: true
      },
      ui: {
        startMinimized: true,
        theme: 'system',
        uiLanguage: 'ja',
        overlayEnabled: true,
        soundCuesEnabled: true,
        duckOtherAudio: false,
        duckLevel: 0.3
      }
    })),
    set: vi.fn(),
    reset: vi.fn()
  }
}));

vi.mock('@main/inject/typer', () => ({
  pasteText: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@main/tray', () => ({
  setStatus: vi.fn()
}));

vi.mock('@main/store/history', () => ({
  historyStore: {
    add: vi.fn((input: { transcript: string }) => ({
      id: 'mock-id',
      timestamp: Date.now(),
      transcript: input.transcript
    })),
    list: vi.fn(() => []),
    remove: vi.fn(),
    clear: vi.fn()
  }
}));

vi.mock('@main/context/activeWindow', () => ({
  getActiveWindow: vi.fn().mockResolvedValue(null)
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}));

class FakeAudioBridge {
  private chunkListener: ((c: { base64: string; samples: number }) => void) | null = null;
  private levelListener: ((level: number) => void) | null = null;
  private chunkCount = 0;
  beeps: Array<'start' | 'stop'> = [];
  devices: string[] = [];
  recentAudioError: string | null = null;

  setChunkListener(cb: ((c: { base64: string; samples: number }) => void) | null): void {
    this.chunkListener = cb;
  }
  getChunkListener(): ((c: { base64: string; samples: number }) => void) | null {
    return this.chunkListener;
  }
  setLevelListener(cb: ((level: number) => void) | null): void {
    this.levelListener = cb;
  }
  beginForwarding(): { startCount: number } {
    return { startCount: this.chunkCount };
  }
  endForwarding(start: number): { delivered: number } {
    return { delivered: this.chunkCount - start };
  }
  playBeep(kind: 'start' | 'stop'): void {
    this.beeps.push(kind);
  }
  changeDevice(deviceId: string): void {
    this.devices.push(deviceId);
  }
  getWebContentsId(): number | null {
    return null;
  }
  getRecentAudioError(_windowMs: number): string | null {
    return this.recentAudioError;
  }
  async prewarm(): Promise<void> {
    /* no-op */
  }
  destroy(): void {
    /* no-op */
  }
  feed(n: number, level = 0.5): void {
    for (let i = 0; i < n; i++) {
      this.chunkCount++;
      this.chunkListener?.({ base64: 'AAA=', samples: 1200 });
      this.levelListener?.(level);
    }
  }
}

import { DictationOrchestrator } from '../src/main/dictation/orchestrator';
import { pasteText } from '@main/inject/typer';
import { historyStore } from '@main/store/history';

describe('DictationOrchestrator', () => {
  let audio: FakeAudioBridge;
  let orch: DictationOrchestrator;

  beforeEach(() => {
    hoisted.instances.length = 0;
    audio = new FakeAudioBridge();
    orch = new DictationOrchestrator(audio as never);
    vi.mocked(pasteText).mockClear();
    vi.mocked(historyStore.add).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles stop() arriving before connect resolves without crashing', async () => {
    const startP = orch.start();
    const stopP = orch.stop();

    await expect(stopP).resolves.toBeUndefined();
    await expect(startP).resolves.toBeUndefined();

    expect(hoisted.instances[0]?.committed).toBe(false);
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('happy path: receives final, pastes, adds to history, plays beeps', async () => {
    await orch.start();
    audio.feed(10);

    const stopP = orch.stop();
    await new Promise((r) => setTimeout(r, 100));
    hoisted.instances[0]!.emit('final', 'hello world');

    await stopP;
    expect(hoisted.instances[0]?.committed).toBe(true);
    expect(pasteText).toHaveBeenCalledWith('hello world', true, 'balanced', true);
    expect(historyStore.add).toHaveBeenCalledWith({
      transcript: 'hello world',
      durationMs: 500
    });
    expect(audio.beeps).toEqual(['start', 'stop']);
  });

  it('skips commit when no audio chunks were delivered', async () => {
    await orch.start();
    await orch.stop();
    expect(hoisted.instances[0]?.committed).toBe(false);
    expect(pasteText).not.toHaveBeenCalled();
    expect(historyStore.add).not.toHaveBeenCalled();
  });

  it('reuses the WebSocket across dictations', async () => {
    await orch.start();
    audio.feed(10);
    const stop1 = orch.stop();
    await new Promise((r) => setTimeout(r, 100));
    hoisted.instances[0]!.emit('final', 'first');
    await stop1;

    await orch.start();
    audio.feed(10);
    const stop2 = orch.stop();
    await new Promise((r) => setTimeout(r, 100));
    hoisted.instances[0]!.emit('final', 'second');
    await stop2;

    expect(hoisted.instances).toHaveLength(1);
    expect(pasteText).toHaveBeenNthCalledWith(1, 'first', true, 'balanced', true);
    expect(pasteText).toHaveBeenNthCalledWith(2, 'second', true, 'balanced', true);
  });

  it('surfaces connect failures without throwing', async () => {
    const original = hoisted.FakeRealtimeClient.prototype.connect;
    hoisted.FakeRealtimeClient.prototype.connect = function (): Promise<void> {
      this.failConnect = true;
      return original.call(this);
    };
    try {
      await expect(orch.start()).resolves.toBeUndefined();
    } finally {
      hoisted.FakeRealtimeClient.prototype.connect = original;
    }
  });

  it('ignores duplicate start() while already in flight', async () => {
    const p1 = orch.start();
    const p2 = orch.start();
    await Promise.all([p1, p2]);
    audio.feed(10);
    const stop = orch.stop();
    await new Promise((r) => setTimeout(r, 100));
    hoisted.instances[0]!.emit('final', 'x');
    await stop;

    expect(hoisted.instances).toHaveLength(1);
  });

  it('isActive() returns false initially, true mid-cycle, false after stop', async () => {
    expect(orch.isActive()).toBe(false);
    await orch.start();
    expect(orch.isActive()).toBe(true);
    audio.feed(10);
    const stop = orch.stop();
    await new Promise((r) => setTimeout(r, 100));
    hoisted.instances[0]!.emit('final', 'done');
    await stop;
    expect(orch.isActive()).toBe(false);
  });

  it('mid-session WS clean close after commit() resolves pendingFinal with current partial', async () => {
    await orch.start();
    audio.feed(10);
    // Simulate a partial delta arriving so `partial` has content.
    hoisted.instances[0]!.emit('delta', 'partial-text');

    const stopP = orch.stop();
    // After ~80ms commit() runs; we want to emit close BEFORE final.
    await new Promise((r) => setTimeout(r, 100));
    // No 'final' event — the WS closes cleanly after commit.
    hoisted.instances[0]!.emit('close');

    // stop() must resolve well before the FINAL_TIMEOUT_MS pendingFinal timer.
    const start = Date.now();
    await stopP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);

    // Orchestrator returns to idle.
    expect(orch.isActive()).toBe(false);
    // The partial was used as the resolved final and pasted.
    expect(pasteText).toHaveBeenCalledWith('partial-text', true, 'balanced', true);
  });

  it('dispose() detaches all client listeners and chunk listener', async () => {
    await orch.start();
    audio.feed(5);

    orch.dispose();

    // After dispose, the chunk listener must be detached.
    expect(audio.getChunkListener()).toBeNull();

    // Emit events on the (now-detached) client; orchestrator state must not change.
    const inst = hoisted.instances[0]!;
    // Silence unhandled 'error' on the EventEmitter.
    inst.on('error', () => {});
    inst.emit('final', 'should-be-ignored');
    inst.emit('delta', 'should-be-ignored');
    inst.emit('error', new Error('should-be-ignored'));
    inst.emit('close');
    await new Promise((r) => setTimeout(r, 20));

    // pasteText should NOT have been called from the post-dispose final.
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('start() aborts with [error] broadcast when getRecentAudioError returns non-null', async () => {
    audio.recentAudioError = 'mic permission denied';
    // No client should be created — start should bail before connect.
    await orch.start();
    expect(hoisted.instances).toHaveLength(0);
    expect(orch.isActive()).toBe(false);
    // No paste, no commit.
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('cycleId cancellation: cancel during duck/connect window does not produce a final paste', async () => {
    // Slow the connect so we have time to cancel during the connect window.
    hoisted.FakeRealtimeClient.prototype.connectDelay = 100 as never;
    const inst = hoisted.FakeRealtimeClient;
    // Patch the connect prototype to stash 100ms delay for this test.
    const origConnect = inst.prototype.connect;
    inst.prototype.connect = function (this: InstanceType<typeof inst>): Promise<void> {
      this.connectDelay = 100;
      return origConnect.call(this);
    };
    try {
      const startP = orch.start();
      // Cancel by calling stop() before connect resolves.
      const stopP = orch.stop();
      await Promise.all([startP, stopP]);

      // No commit since the cycle was cancelled before the WS opened.
      expect(hoisted.instances[0]?.committed).toBe(false);
      // No final paste.
      expect(pasteText).not.toHaveBeenCalled();
      expect(orch.isActive()).toBe(false);
    } finally {
      inst.prototype.connect = origConnect;
    }
  });

  it('recovers when the WS errors mid-flight without an awaiting stop()', async () => {
    await orch.start();
    audio.feed(5);
    // Server-side close: error fires while `inFlight` is true and no stop()
    // is awaiting `pendingFinal`. Orchestrator must reset inFlight so the
    // next hotkey press is not ignored.
    hoisted.instances[0]!.emit('error', new Error('server kicked us'));

    // Allow one event-loop turn for the handler.
    await new Promise((r) => setTimeout(r, 10));

    // Next start() should not be a no-op: it must spin up a new client.
    await orch.start();
    audio.feed(10);
    const stop = orch.stop();
    await new Promise((r) => setTimeout(r, 100));
    hoisted.instances[hoisted.instances.length - 1]!.emit('final', 'recovered');
    await stop;

    expect(pasteText).toHaveBeenCalledWith('recovered', true, 'balanced', true);
  });
});
