import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { debug } from '@main/debug';
import {
  TranscriptionDeltaEvent,
  TranscriptionCompletedEvent,
  ErrorEvent
} from './events';

const REALTIME_BASE = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-whisper';

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_MAX_ATTEMPTS = 5;
const IDLE_PING_MS = 20_000;
const AUDIO_BACKPRESSURE_BYTES = 256 * 1024;

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  language?: string;        // e.g. "ja", "en"; undefined for auto-detect
  prompt?: string;
  vadEnabled?: boolean;
}

export interface RealtimeClientEvents {
  open: () => void;
  delta: (text: string) => void;
  final: (text: string) => void;
  error: (err: Error) => void;
  close: () => void;
  reconnect: () => void;
}

export declare interface RealtimeClient {
  on<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): this;
  once<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): this;
  emit<K extends keyof RealtimeClientEvents>(
    event: K,
    ...args: Parameters<RealtimeClientEvents[K]>
  ): boolean;
}

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: RealtimeClientOptions;
  private opened = false;
  private disposed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private cleanClose = false;

  constructor(opts: RealtimeClientOptions) {
    super();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('client disposed');
    if (this.ws) throw new Error('already connected');

    // For transcription sessions, the URL must use `intent=transcription`
    // and MUST NOT carry a `model=` parameter — the server returns
    // "You must not provide a model parameter for transcription sessions."
    // The model is selected later inside the `session.update` payload.
    const url = `${REALTIME_BASE}?intent=transcription`;
    // `servername` is a valid runtime option for the underlying TLS socket
    // (passed through by ws), but the @types/ws ClientOptions don't list it.
    const wsOpts = {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      rejectUnauthorized: true,
      servername: 'api.openai.com'
    } as WebSocket.ClientOptions;
    this.ws = new WebSocket(url, wsOpts);

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onceOpen = (): void => {
        ws.off('error', onceError);
        this.opened = true;
        this.reconnectAttempts = 0;
        this.cleanClose = false;
        this.sendSessionUpdate();
        this.emit('open');
        ws.on('message', (data) => this.onMessage(data));
        ws.on('close', () => this.handleClose(ws));
        ws.on('error', (err) => {
          // ws emits `Error` per its typings, but downstream consumers
          // (and we ourselves) can't trust unverified casts (issue #45).
          // Narrow safely and re-wrap unknown values.
          const wrapped = err instanceof Error ? err : new Error(String(err));
          this.emit('error', wrapped);
        });
        this.startPing();
        resolve();
      };
      const onceError = (err: Error): void => {
        ws.off('open', onceOpen);
        // Ensure a follow-up connect() doesn't see a stale ws.
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        this.ws = null;
        reject(err);
      };
      ws.once('open', onceOpen);
      ws.once('error', onceError);
    });
  }

  private sendSessionUpdate(): void {
    const model = this.opts.model ?? DEFAULT_MODEL;
    const session: Record<string, unknown> = {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: {
            model,
            ...(this.opts.language ? { language: this.opts.language } : {}),
            ...(this.opts.prompt ? { prompt: this.opts.prompt } : {})
          },
          turn_detection: this.opts.vadEnabled
            ? {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
              }
            : null
        }
      }
    };
    this.send({ type: 'session.update', session });
  }

  /** Append a PCM chunk. Accepts a Buffer/Uint8Array/ArrayBuffer or pre-encoded base64 string. */
  appendAudio(buf: Buffer | Uint8Array | ArrayBuffer | string): void {
    if (!this.opened || !this.ws) return;
    if (this.ws.bufferedAmount > AUDIO_BACKPRESSURE_BYTES) {
      debug('REALTIME', 'audio backpressure drop');
      return;
    }
    let base64: string;
    if (typeof buf === 'string') {
      base64 = buf;
    } else if (Buffer.isBuffer(buf)) {
      base64 = buf.toString('base64');
    } else if (buf instanceof Uint8Array) {
      base64 = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64');
    } else {
      base64 = Buffer.from(new Uint8Array(buf)).toString('base64');
    }
    this.send({ type: 'input_audio_buffer.append', audio: base64 });
  }

  commit(): void {
    if (!this.opened) return;
    this.send({ type: 'input_audio_buffer.commit' });
  }

  isOpen(): boolean {
    return this.opened && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.opened = false;
    this.cleanClose = true;
    this.stopPing();
    this.clearReconnectTimer();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Tear down permanently; no further events will be emitted. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanClose = true;
    this.stopPing();
    this.clearReconnectTimer();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000);
      } catch {
        /* ignore */
      }
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.opened = false;
    this.removeAllListeners();
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.disposed) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, IDLE_PING_MS);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleClose(ws: WebSocket | null): void {
    if (this.disposed) return;
    if (this.ws !== ws) return;
    this.opened = false;
    this.stopPing();
    this.ws = null;

    if (this.cleanClose) {
      this.emit('close');
      return;
    }

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      debug('REALTIME', 'reconnect attempts exhausted');
      this.emit('close');
      return;
    }

    const attempt = this.reconnectAttempts++;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const jitter = Math.floor(Math.random() * 100);
    const delay = backoff + jitter;
    debug('REALTIME', `unexpected close — reconnect in ${delay}ms (attempt ${attempt + 1})`);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.connect()
        .then(() => {
          this.emit('reconnect');
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          debug('REALTIME', `reconnect failed: ${message}`);
          // Re-trigger close path to schedule the next attempt. Pass the
          // CURRENT `this.ws` (null after onceError clears it on failure)
          // instead of the captured `ws`. The original captured `ws` is a
          // stale handle from the previous close — the guard
          // `this.ws !== ws` would otherwise silently abort the retry
          // chain from the third attempt onward (issue #23).
          this.handleClose(this.ws);
        });
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private onMessage(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const obj = parsed as { type?: string };

    debug('REALTIME', `${obj.type ?? 'unknown'}`);

    switch (obj.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        const ev = TranscriptionDeltaEvent.safeParse(parsed);
        if (ev.success) this.emit('delta', ev.data.delta);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.done': {
        const ev = TranscriptionCompletedEvent.safeParse(parsed);
        if (ev.success) this.emit('final', ev.data.transcript);
        break;
      }
      case 'error': {
        const ev = ErrorEvent.safeParse(parsed);
        if (ev.success) this.emit('error', new Error(ev.data.error.message));
        break;
      }
      default:
        break;
    }
  }
}
