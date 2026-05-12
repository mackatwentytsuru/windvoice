import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Settings } from '@shared/types';
import type { PostProcessContext } from '@main/postprocess/pipeline';

// vi.mock factories are hoisted; expose state via vi.hoisted so tests can
// inspect/override what the fake OpenAI client returns or throws.
const hoisted = vi.hoisted(() => {
  const state = {
    createCalls: [] as Array<{ args: unknown; options: unknown }>,
    nextResponse: null as unknown,
    nextError: null as Error | null,
    delayMs: 0,
    abortDelayMs: -1
  };
  return state;
});

vi.mock('openai', () => {
  class FakeOpenAI {
    chat: {
      completions: {
        create: (args: unknown, options: unknown) => Promise<unknown>;
      };
    };
    constructor(_opts: unknown) {
      this.chat = {
        completions: {
          create: async (args: unknown, options: unknown): Promise<unknown> => {
            hoisted.createCalls.push({ args, options });

            const optsRecord = (options ?? {}) as { signal?: AbortSignal };
            const signal = optsRecord.signal;

            if (hoisted.delayMs > 0 || hoisted.abortDelayMs >= 0) {
              await new Promise<void>((resolve, reject) => {
                let settled = false;
                const onAbort = (): void => {
                  if (settled) return;
                  settled = true;
                  reject(new Error('aborted'));
                };
                if (signal) {
                  if (signal.aborted) {
                    onAbort();
                    return;
                  }
                  signal.addEventListener('abort', onAbort, { once: true });
                }
                const wait = hoisted.delayMs > 0 ? hoisted.delayMs : 60_000;
                setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  resolve();
                }, wait);
              });
            }

            if (hoisted.nextError) throw hoisted.nextError;
            return hoisted.nextResponse;
          }
        }
      };
    }
  }
  return { default: FakeOpenAI };
});

// v0.1.2: when no API key is provided in the context, the formatter falls
// back to `secureStore.getApiKey()` which calls real `keytar` and can
// hang the test environment. Stub it to always return null so the "no
// key" branch resolves synchronously.
vi.mock('@main/store/secure', () => ({
  secureStore: {
    getApiKey: vi.fn(async () => null)
  }
}));

import { gptFormatter, buildSystemPrompt, resetFormatterFailure } from '@main/postprocess/formatter';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    hotkeys: [],
    replacements: [],
    // v0.1.2: `audio.inputGain` was removed from the schema (#16); only
    // `device` remains. Older settings with `inputGain` still parse fine
    // because Zod ignores unknown properties without `.strict()`.
    audio: { device: 'default' },
    language: 'ja',
    formatter: { model: 'gpt-5-mini', customInstructions: '', enabled: true },
    dictionary: [],
    insertion: { method: 'paste', restoreClipboard: true, streaming: false },
    ui: {
      startMinimized: true,
      theme: 'system',
      uiLanguage: 'ja',
      overlayEnabled: true,
      soundCuesEnabled: true,
      duckOtherAudio: false,
      duckLevel: 0.3,
      autoLaunch: false,
      autoUpdate: true
    },
    ...overrides
  } as Settings;
}

function makeCtx(overrides: Partial<PostProcessContext> = {}): PostProcessContext {
  return {
    settings: overrides.settings ?? makeSettings(),
    apiKey: 'sk-test',
    ...overrides
  };
}

function setOkResponse(content: string): void {
  hoisted.nextResponse = {
    choices: [{ message: { role: 'assistant', content } }]
  };
}

describe('gptFormatter', () => {
  beforeEach(() => {
    hoisted.createCalls.length = 0;
    hoisted.nextResponse = null;
    hoisted.nextError = null;
    hoisted.delayMs = 0;
    hoisted.abortDelayMs = -1;
    // v0.1.2: the formatter caches a permanent-failure marker (E_AUTH /
    // E_NOT_FOUND) and an OpenAI client cache. Reset both so test order
    // doesn't leak state between cases.
    resetFormatterFailure();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns input unchanged when formatter.enabled is false', async () => {
    const ctx = makeCtx({
      settings: makeSettings({
        formatter: { model: 'gpt-5-mini', customInstructions: '', enabled: false }
      })
    });
    const out = await gptFormatter.process('hello world', ctx);
    expect(out).toBe('hello world');
    expect(hoisted.createCalls).toHaveLength(0);
  });

  it('returns input unchanged when no API key is provided', async () => {
    const ctx = makeCtx({ apiKey: undefined });
    const out = await gptFormatter.process('hello world', ctx);
    expect(out).toBe('hello world');
    expect(hoisted.createCalls).toHaveLength(0);

    const ctxEmpty = makeCtx({ apiKey: '' });
    const out2 = await gptFormatter.process('hello world', ctxEmpty);
    expect(out2).toBe('hello world');
    expect(hoisted.createCalls).toHaveLength(0);
  });

  it('returns input unchanged when text is empty or whitespace', async () => {
    const ctx = makeCtx();
    expect(await gptFormatter.process('', ctx)).toBe('');
    expect(await gptFormatter.process('   \n\t', ctx)).toBe('   \n\t');
    expect(hoisted.createCalls).toHaveLength(0);
  });

  it('calls OpenAI when enabled with non-empty text and key, returns the response content', async () => {
    setOkResponse('こんにちは。');
    const ctx = makeCtx();
    const out = await gptFormatter.process('結結結こんにちはこんにちは', ctx);
    expect(out).toBe('こんにちは。');
    expect(hoisted.createCalls).toHaveLength(1);

    const call = hoisted.createCalls[0]!;
    // v0.1.2: `gpt-5-mini` is classified as a reasoning model in
    // formatter.ts. Reasoning / "o-series" / GPT-5 models reject the
    // legacy `temperature` + `max_tokens` parameters and require
    // `max_completion_tokens` plus an explicit `reasoning_effort`.
    const args = call.args as {
      model: string;
      temperature?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
      reasoning_effort?: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(args.model).toBe('gpt-5-mini');
    expect(args.temperature).toBeUndefined();
    expect(args.max_tokens).toBeUndefined();
    expect(args.max_completion_tokens).toBeGreaterThanOrEqual(256);
    expect(args.reasoning_effort).toBe('minimal');
    expect(args.messages[0]?.role).toBe('system');
    expect(args.messages[1]?.role).toBe('user');
    expect(args.messages[1]?.content).toBe('結結結こんにちはこんにちは');

    const options = call.options as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns original text on API error (does not throw)', async () => {
    hoisted.nextError = new Error('500 Internal Server Error');
    const ctx = makeCtx();
    const original = 'hello there';
    const out = await gptFormatter.process(original, ctx);
    expect(out).toBe(original);
    expect(hoisted.createCalls).toHaveLength(1);
  });

  it('times out gracefully when the API hangs, returning original text', async () => {
    // v0.1.2: HARD_TIMEOUT_MS is 2_000 in formatter.ts. The mocked OpenAI
    // delay is set well past that so the formatter's AbortController has
    // to fire for the call to resolve.
    hoisted.delayMs = 60_000;
    vi.useFakeTimers();

    const ctx = makeCtx();
    const original = 'hangs forever';
    const promise = gptFormatter.process(original, ctx);

    // Advance well past the hard timeout (2s).
    await vi.advanceTimersByTimeAsync(5_500);

    const out = await promise;
    expect(out).toBe(original);
    expect(hoisted.createCalls).toHaveLength(1);
  });

  it('builds a system prompt that contains dictionary entries, customInstructions, and a language hint', async () => {
    setOkResponse('formatted');
    const settings = makeSettings({
      language: 'en',
      formatter: {
        model: 'gpt-5-mini',
        customInstructions: 'Always use Oxford commas.',
        enabled: true
      },
      dictionary: [
        { from: 'gpt 5 mini', to: 'GPT-5-mini' },
        { from: 'open ai', to: 'OpenAI' }
      ]
    });
    const ctx = makeCtx({ settings });

    const prompt = buildSystemPrompt(settings);
    expect(prompt).toContain('GPT-5-mini');
    expect(prompt).toContain('OpenAI');
    expect(prompt).toContain('gpt 5 mini');
    expect(prompt).toContain('open ai');
    expect(prompt).toContain('Always use Oxford commas.');
    expect(prompt.toLowerCase()).toContain('en');

    await gptFormatter.process('some text', ctx);
    expect(hoisted.createCalls).toHaveLength(1);
    const args = hoisted.createCalls[0]!.args as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = args.messages[0]?.content ?? '';
    expect(systemMsg).toContain('GPT-5-mini');
    expect(systemMsg).toContain('Always use Oxford commas.');
  });

  it('uses configured model when overridden in settings', async () => {
    setOkResponse('ok');
    const settings = makeSettings({
      formatter: { model: 'gpt-4o-mini', customInstructions: '', enabled: true }
    });
    const ctx = makeCtx({ settings });
    await gptFormatter.process('hello', ctx);
    const args = hoisted.createCalls[0]!.args as { model: string };
    expect(args.model).toBe('gpt-4o-mini');
  });

  it('falls back to original text when the model returns an empty completion', async () => {
    setOkResponse('   ');
    const ctx = makeCtx();
    const out = await gptFormatter.process('hello', ctx);
    expect(out).toBe('hello');
  });
});
