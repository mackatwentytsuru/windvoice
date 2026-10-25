// HTTP client for the local (127.0.0.1 only) speech-to-text server.
//
// Protocol (resources/stt/sherpa_server.py):
//   GET  /health      -> 200 + {"ok":true,"model":..,"threads":..,"load_ms":..}
//   POST /transcribe   body = WAV (16 kHz mono PCM16) -> {"text":"...","ms":123}
//
// Audio never leaves the machine: `assertLoopback` rejects any URL whose
// scheme is not http or whose host is not a loopback name, so a mistyped /
// copied setting can never exfiltrate a dictation to a remote host.

import { pcm24kToWav16k } from './audio';
import { LocalSttError } from './errors';

export const DEFAULT_LOCAL_STT_URL = 'http://127.0.0.1:5312';

const HEALTH_TIMEOUT_MS = 3_000;
// CPU-only recognition of a long take can take tens of seconds; the server
// answers in one response, so this is a single generous ceiling.
const TRANSCRIBE_TIMEOUT_MS = 120_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Validate that `rawUrl` is an http URL on a loopback host; return it parsed. */
export function assertLoopback(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LocalSttError('invalid-url', 'invalid local STT URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    // The raw URL is not echoed: it may carry user:password and messages end
    // up in the debug log / error reports.
    throw new LocalSttError('invalid-url', 'local STT URL must be http on 127.0.0.1');
  }
  return url;
}

/** Port of the configured local URL (server manager spawns with it). */
export function localSttPort(rawUrl: string): number {
  return Number(assertLoopback(rawUrl).port || '80');
}

export interface LocalSttHealthInfo {
  ok: boolean;
  model?: string;
  threads?: number;
  loadMs?: number;
}

/** Overridable deadlines (tests shrink these; production uses the defaults). */
export interface LocalSttTimeouts {
  healthMs?: number;
  transcribeMs?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class LocalSttClient {
  private readonly url: string;
  private readonly healthMs: number;
  private readonly transcribeMs: number;

  constructor(
    url: string = DEFAULT_LOCAL_STT_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    timeouts: LocalSttTimeouts = {}
  ) {
    this.url = url.trim() || DEFAULT_LOCAL_STT_URL;
    this.healthMs = timeouts.healthMs ?? HEALTH_TIMEOUT_MS;
    this.transcribeMs = timeouts.transcribeMs ?? TRANSCRIBE_TIMEOUT_MS;
  }

  /** GET /health. Throws LocalSttError on unreachable / timeout / bad status. */
  async health(): Promise<LocalSttHealthInfo> {
    const res = await this.request('/health', { method: 'GET' }, this.healthMs);
    if (!res.ok) {
      throw new LocalSttError('server', `local STT /health responded ${res.status}`);
    }
    const json = await this.jsonOrThrow(res);
    const o = json as { ok?: unknown; model?: unknown; threads?: unknown; load_ms?: unknown };
    return {
      ok: o.ok === true,
      ...(typeof o.model === 'string' ? { model: o.model } : {}),
      ...(typeof o.threads === 'number' ? { threads: o.threads } : {}),
      ...(typeof o.load_ms === 'number' ? { loadMs: o.load_ms } : {})
    };
  }

  /**
   * Resample 24 kHz PCM16 → 16 kHz WAV, POST it, and return the transcript.
   * The server itself never sees anything but loopback traffic (assertLoopback).
   */
  async transcribe(pcm24k: Int16Array): Promise<string> {
    const wav = pcm24kToWav16k(pcm24k);
    const res = await this.request(
      '/transcribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav
      },
      this.transcribeMs
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LocalSttError(
        'server',
        `local STT /transcribe responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }
    const json = await this.jsonOrThrow(res);
    const text = (json as { text?: unknown }).text;
    if (typeof text !== 'string') {
      throw new LocalSttError('server', 'local STT /transcribe response is missing "text"');
    }
    return text.trim();
  }

  private endpoint(pathname: string): string {
    const base = assertLoopback(this.url);
    const root = `${base.protocol}//${base.host}${base.pathname.replace(/\/+$/, '')}`;
    return `${root}${pathname}`;
  }

  private async request(
    pathname: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      return await this.fetchImpl(this.endpoint(pathname), {
        ...init,
        // Never follow a redirect off the loopback host.
        redirect: 'error',
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LocalSttError('timeout', `local STT ${pathname} timed out after ${timeoutMs} ms`);
      }
      // assertLoopback errors are already typed; re-throw them untouched.
      if (err instanceof LocalSttError) throw err;
      throw new LocalSttError('unreachable', `local STT server not reachable: ${errMsg(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async jsonOrThrow(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new LocalSttError('server', 'local STT server returned invalid JSON');
    }
  }
}

/**
 * Transcribe a take recorded at the app's capture rate. Kept as a free
 * function so the orchestrator has one dependency to mock in tests.
 */
export async function transcribeWithLocalStt(
  pcm24k: Int16Array,
  url: string = DEFAULT_LOCAL_STT_URL,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  return new LocalSttClient(url, fetchImpl).transcribe(pcm24k);
}
