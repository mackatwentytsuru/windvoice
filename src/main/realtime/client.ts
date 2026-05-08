import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import {
  TranscriptionDeltaEvent,
  TranscriptionCompletedEvent,
  ErrorEvent
} from './events';

const REALTIME_BASE = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-whisper';

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
}

export declare interface RealtimeClient {
  on<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): this;
  once<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): this;
  emit<K extends keyof RealtimeClientEvents>(
    event: K,
    ...args: Parameters<RealtimeClientEvents[K]>
  ): boolean;
}

const DEBUG = process.env['WINDVOICE_DEBUG_REALTIME'] === '1';

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: RealtimeClientOptions;
  private opened = false;

  constructor(opts: RealtimeClientOptions) {
    super();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.ws) throw new Error('already connected');

    // For transcription sessions, the URL must use `intent=transcription`
    // and MUST NOT carry a `model=` parameter — the server returns
    // "You must not provide a model parameter for transcription sessions."
    // The model is selected later inside the `session.update` payload.
    const url = `${REALTIME_BASE}?intent=transcription`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` }
    });

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onceOpen = (): void => {
        ws.off('error', onceError);
        this.opened = true;
        this.sendSessionUpdate();
        this.emit('open');
        ws.on('message', (data) => this.onMessage(data));
        ws.on('close', () => {
          this.opened = false;
          this.emit('close');
        });
        ws.on('error', (err) => this.emit('error', err as Error));
        resolve();
      };
      const onceError = (err: Error): void => {
        ws.off('open', onceOpen);
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

  /** Append a base64-encoded PCM chunk. */
  appendAudio(base64: string): void {
    if (!this.opened) return;
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
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
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

    if (DEBUG) {
      process.stderr.write(`[realtime] ${obj.type ?? 'unknown'}\n`);
    }

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
