import { describe, expect, it, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The orchestrator must pick the local engine without touching any OpenAI
// code path: no realtime client, no API key, PCM buffered and POSTed to
// 127.0.0.1, then the usual post-processing / paste path.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class FakeRealtimeClient extends EventEmitter {
    opened = false;
    appended = 0;
    committed = false;
    disposed = false;

    async connect(): Promise<void> {
      this.opened = true;
    }
    isOpen(): boolean {
      return this.opened;
    }
    appendAudio(): void {
      this.appended++;
    }
    commit(): boolean {
      this.committed = true;
      return true;
    }
    clearInput(): void {
      /* no-op */
    }
    dispose(): void {
      this.disposed = true;
      this.opened = false;
    }
  }

  return {
    FakeRealtimeClient,
    instances: [] as InstanceType<typeof FakeRealtimeClient>[],
    engine: 'local' as 'local' | 'openai',
    apiKey: null as string | null,
    ensureRunning: vi.fn(async (_stt: unknown) => undefined),
    transcribe: vi.fn(async (_pcm: Int16Array, _url: string) => 'ローカルの結果')
  };
});

vi.mock('@main/realtime/client', () => ({
  RealtimeClient: class extends hoisted.FakeRealtimeClient {
    constructor(opts: unknown) {
      super();
      void opts;
      hoisted.instances.push(this);
    }
  }
}));

vi.mock('@main/store/secure', () => ({
  secureStore: {
    getApiKey: vi.fn(async () => hoisted.apiKey),
    hasApiKey: vi.fn(async () => hoisted.apiKey !== null),
    setApiKey: vi.fn(),
    clearApiKey: vi.fn()
  }
}));

vi.mock('@main/store/settings', () => ({
  settingsStore: {
    get: vi.fn(() => ({
      hotkeys: [{ id: 'primary', keys: ['RightCtrl'], mode: 'push-to-talk', format: true }],
      audio: { device: 'default' },
      language: 'ja',
      stt: {
        engine: hoisted.engine,
        localUrl: 'http://127.0.0.1:5312',
        autoStart: true,
        pythonPath: 'python',
        serverScript: 'resources/stt/sherpa_server.py',
        modelDir: 'C:/models/parakeet',
        threads: 4
      },
      formatter: { model: 'gpt-5-mini', customInstructions: '', enabled: true, appProfiles: [] },
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

vi.mock('@main/stt/server', () => ({
  localSttServer: { ensureRunning: hoisted.ensureRunning, stop: vi.fn() }
}));

vi.mock('@main/stt/client', () => ({
  transcribeWithLocalStt: hoisted.transcribe
}));

vi.mock('@main/inject/typer', () => ({
  pasteText: vi.fn(async () => undefined)
}));

vi.mock('@main/inject/typeText', async (importActual) => {
  const actual = await importActual<typeof import('../src/main/inject/typeText')>();
  return { ...actual, typeTextDirect: vi.fn(async () => false) };
});

vi.mock('@main/tray', () => ({ setStatus: vi.fn() }));
vi.mock('@main/broadcast', () => ({
  broadcastToUiWindows: vi.fn(),
  setAudioWebContentsId: vi.fn()
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
  getActiveWindow: vi.fn(async () => null)
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}));

class FakeAudioBridge {
  private chunkListener: ((c: { data: Buffer; samples: number }) => void) | null = null;
  private chunkCount = 0;
  private maxLevel = 0;
  recaptures = 0;
  beeps: Array<'start' | 'stop'> = [];

  setChunkListener(cb: ((c: { data: Buffer; samples: number }) => void) | null): void {
    this.chunkListener = cb;
  }
  getChunkListener(): ((c: { data: Buffer; samples: number }) => void) | null {
    return this.chunkListener;
  }
  setLevelListener(_cb: ((level: number) => void) | null): void {
    /* not used by the local path */
  }
  beginForwarding(): { startCount: number } {
    this.maxLevel = 0;
    return { startCount: this.chunkCount };
  }
  endForwarding(start: number): { delivered: number; maxLevel: number } {
    return { delivered: this.chunkCount - start, maxLevel: this.maxLevel };
  }
  recapture(): void {
    this.recaptures++;
  }
  playBeep(kind: 'start' | 'stop'): void {
    this.beeps.push(kind);
  }
  getWebContentsId(): number | null {
    return null;
  }
  getRecentAudioError(): string | null {
    return null;
  }
  feed(n: number, level = 0.5): void {
    for (let i = 0; i < n; i++) {
      this.chunkCount++;
      // 1200 samples = 50 ms at 24 kHz, 2400 bytes of PCM16.
      this.chunkListener?.({ data: Buffer.alloc(2400, 1), samples: 1200 });
      if (level > this.maxLevel) this.maxLevel = level;
    }
  }
}

import { DictationOrchestrator } from '../src/main/dictation/orchestrator';
import { secureStore } from '@main/store/secure';
import { pasteText } from '@main/inject/typer';
import { broadcastToUiWindows } from '@main/broadcast';
import { IPC } from '../src/shared/ipc';

describe('DictationOrchestrator — local STT engine', () => {
  let audio: FakeAudioBridge;
  let orch: DictationOrchestrator;

  beforeEach(() => {
    hoisted.engine = 'local';
    hoisted.apiKey = null;
    hoisted.instances.length = 0;
    hoisted.ensureRunning.mockClear();
    hoisted.ensureRunning.mockResolvedValue(undefined);
    hoisted.transcribe.mockReset();
    hoisted.transcribe.mockResolvedValue('ローカルの結果');
    vi.mocked(pasteText).mockClear();
    vi.mocked(broadcastToUiWindows).mockClear();
    vi.mocked(secureStore.getApiKey).mockClear();
    audio = new FakeAudioBridge();
    orch = new DictationOrchestrator(audio as never);
  });

  it('buffers PCM and pastes the local transcript without a realtime session', async () => {
    await orch.start();
    audio.feed(10);
    await orch.stop();

    expect(hoisted.instances).toHaveLength(0);
    // The on-device server was checked/warmed with the configured settings.
    expect(hoisted.ensureRunning).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'local', localUrl: 'http://127.0.0.1:5312' })
    );
    expect(hoisted.transcribe).toHaveBeenCalledTimes(1);
    const [pcm, url] = hoisted.transcribe.mock.calls[0] as [Int16Array, string];
    expect(pcm.length).toBe(10 * 1200);
    expect(url).toBe('http://127.0.0.1:5312');
    expect(pasteText).toHaveBeenCalledWith('ローカルの結果', true, 'balanced', true);
    expect(audio.beeps).toEqual(['start', 'stop']);
    expect(audio.getChunkListener()).toBeNull();
  });

  it('waits for the server start before sending the audio', async () => {
    // A cold start can outlast a short take, so stop() must await the
    // in-flight start instead of POSTing into a closed port.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hoisted.ensureRunning.mockImplementation(async () => gate);

    await orch.start();
    audio.feed(10);
    const stopping = orch.stop();
    await Promise.resolve();
    expect(hoisted.transcribe).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(hoisted.transcribe).toHaveBeenCalledTimes(1);
  });

  it('does not require an OpenAI API key in local mode', async () => {
    await orch.start();
    expect(secureStore.getApiKey).not.toHaveBeenCalled();
    audio.feed(10);
    await orch.stop();
    expect(pasteText).toHaveBeenCalledWith('ローカルの結果', true, 'balanced', true);
  });

  it('surfaces a localized notice when the local server fails', async () => {
    hoisted.transcribe.mockRejectedValueOnce(
      Object.assign(new Error('ECONNREFUSED 127.0.0.1:5312'), { code: 'unreachable' })
    );
    await orch.start();
    audio.feed(10);
    await orch.stop();

    expect(pasteText).not.toHaveBeenCalled();
    expect(broadcastToUiWindows).toHaveBeenCalledWith(
      IPC.SYSTEM_ERROR,
      expect.objectContaining({ source: 'notice', message: expect.stringContaining('ローカル音声認識') })
    );
  });

  it('does not transcribe an accidental tap with no audio', async () => {
    await orch.start();
    await orch.stop();
    expect(hoisted.transcribe).not.toHaveBeenCalled();
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('does not transcribe a silent take (no energy captured)', async () => {
    await orch.start();
    audio.feed(10, 0);
    await orch.stop();
    expect(hoisted.transcribe).not.toHaveBeenCalled();
    expect(pasteText).not.toHaveBeenCalled();
    expect(broadcastToUiWindows).toHaveBeenCalledWith(
      IPC.SYSTEM_ERROR,
      expect.objectContaining({ source: 'notice' })
    );
  });

  it('keeps the OpenAI engine on the realtime path when selected', async () => {
    hoisted.engine = 'openai';
    hoisted.apiKey = 'sk-test';

    await orch.start();
    expect(hoisted.instances).toHaveLength(1);

    audio.feed(10);
    const stopP = orch.stop();
    await new Promise((r) => setTimeout(r, 50));
    hoisted.instances[0]!.emit('final', 'クラウドの結果');
    await stopP;

    expect(hoisted.ensureRunning).not.toHaveBeenCalled();
    expect(hoisted.transcribe).not.toHaveBeenCalled();
    expect(pasteText).toHaveBeenCalledWith('クラウドの結果', true, 'balanced', true);
  });
});
