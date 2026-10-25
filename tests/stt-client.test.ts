import { describe, expect, it, vi } from 'vitest';
import {
  LocalSttClient,
  assertLoopback,
  localSttPort
} from '../src/main/stt/client';
import { LocalSttError } from '../src/main/stt/errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function codeOf(err: unknown): string | undefined {
  return err instanceof LocalSttError ? err.code : undefined;
}

describe('loopback guard', () => {
  it('accepts 127.0.0.1, localhost and [::1] over http', () => {
    expect(assertLoopback('http://127.0.0.1:5312').port).toBe('5312');
    expect(assertLoopback('http://localhost:5312').hostname).toBe('localhost');
    expect(assertLoopback('http://[::1]:5312').hostname).toBe('[::1]');
    expect(localSttPort('http://127.0.0.1:5312')).toBe(5312);
  });

  it('rejects https, remote hosts and malformed URLs', () => {
    expect(codeOf(catchErr(() => assertLoopback('https://127.0.0.1:5312')))).toBe('invalid-url');
    expect(codeOf(catchErr(() => assertLoopback('http://192.168.0.10:5312')))).toBe('invalid-url');
    expect(codeOf(catchErr(() => assertLoopback('not a url')))).toBe('invalid-url');
  });
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('LocalSttClient.health', () => {
  it('returns model/threads from a 200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, model: 'parakeet-ja', threads: 4, load_ms: 1200 })
    );
    const client = new LocalSttClient('http://127.0.0.1:5312', fetchImpl as unknown as typeof fetch);
    await expect(client.health()).resolves.toEqual({
      ok: true,
      model: 'parakeet-ja',
      threads: 4,
      loadMs: 1200
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5312/health',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('throws a typed server error on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    const client = new LocalSttClient('http://127.0.0.1:5312', fetchImpl as unknown as typeof fetch);
    await expect(client.health()).rejects.toMatchObject({ code: 'server' });
  });

  it('maps a connection failure to "unreachable"', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new LocalSttClient('http://127.0.0.1:5312', fetchImpl as unknown as typeof fetch);
    await expect(client.health()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('aborts and reports "timeout" when the server never answers', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const client = new LocalSttClient(
      'http://127.0.0.1:5312',
      fetchImpl as unknown as typeof fetch,
      { healthMs: 10 }
    );
    await expect(client.health()).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('LocalSttClient.transcribe', () => {
  it('posts a resampled WAV and returns the trimmed text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ text: '  こんにちは  ', ms: 42 }));
    const client = new LocalSttClient('http://127.0.0.1:5312', fetchImpl as unknown as typeof fetch);

    const pcm24k = new Int16Array(2400); // 100 ms at 24 kHz
    const text = await client.transcribe(pcm24k);

    expect(text).toBe('こんにちは');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5312/transcribe');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'audio/wav' });
    const body = init.body as Buffer;
    // 2400 samples @24k → 1600 @16k → 3200 bytes + 44-byte header.
    expect(body.length).toBe(44 + 3200);
    expect(body.toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('throws "server" for a non-2xx /transcribe response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'WAV として読めません' }), { status: 400 })
    );
    const client = new LocalSttClient('http://127.0.0.1:5312', fetchImpl as unknown as typeof fetch);
    await expect(client.transcribe(new Int16Array(10))).rejects.toMatchObject({ code: 'server' });
  });

  it('throws "server" when the JSON body has no text field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ms: 3 }));
    const client = new LocalSttClient('http://127.0.0.1:5312', fetchImpl as unknown as typeof fetch);
    await expect(client.transcribe(new Int16Array(10))).rejects.toMatchObject({ code: 'server' });
  });

  it('never sends audio to a non-loopback host', async () => {
    const fetchImpl = vi.fn();
    const client = new LocalSttClient('http://example.com:5312', fetchImpl as unknown as typeof fetch);
    await expect(client.transcribe(new Int16Array(10))).rejects.toMatchObject({
      code: 'invalid-url'
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
