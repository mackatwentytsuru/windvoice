import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { debug } from '@main/debug';
import {
  TranscriptionDeltaEvent,
  TranscriptionCompletedEvent,
  ErrorEvent
} from './events';
import {
  BYTES_PER_SAMPLE,
  MIN_COMMIT_AUDIO_MS,
  TARGET_SAMPLE_RATE
} from '@shared/constants';

const REALTIME_BASE = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-whisper';

// Minimum PCM bytes that must reach the server before a commit can succeed.
// 100 ms × 24 000 Hz × 2 bytes/sample = 4 800 bytes. Committing below this
// draws the server's "buffer too small … 0.00ms of audio" error, so the
// client refuses client-side instead (see `commit`).
const MIN_COMMIT_BYTES = Math.ceil((MIN_COMMIT_AUDIO_MS / 1000) * TARGET_SAMPLE_RATE) * BYTES_PER_SAMPLE;

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_MAX_ATTEMPTS = 5;
// v0.1.8 incident: the server can accept the WS handshake and emit
// `session.created`, then reject our `session.update` — leaving a session
// that looks healthy but transcribes nothing. connect() therefore resolves
// only on the `session.updated` ack, raced against this watchdog.
const READY_TIMEOUT_MS = 5_000;
const IDLE_PING_MS = 20_000;
const AUDIO_BACKPRESSURE_BYTES = 256 * 1024;
// MEDIUM-4: sustained backpressure surfacing threshold. With ~50 ms PCM
// chunks, 10 drops within a 5-second window ≈ 500 ms of lost audio —
// the floor for "the transcript is going to have noticeable gaps".
const BACKPRESSURE_NOTIFY_THRESHOLD = 10;
const BACKPRESSURE_WINDOW_MS = 5_000;
// Cooldown so we don't re-fire the listener every chunk while bufferedAmount
// stays high — once notified, wait this long before reporting again.
const BACKPRESSURE_NOTIFY_COOLDOWN_MS = 5_000;

let onAudioBackpressureCb: (() => void) | null = null;
/**
 * Register a single listener fired when sustained audio backpressure is
 * detected (drops exceeding BACKPRESSURE_NOTIFY_THRESHOLD inside a
 * BACKPRESSURE_WINDOW_MS window). Pass `null` to clear. Process-wide;
 * there is one orchestrator at any time, so a single listener is enough.
 */
export function setAudioBackpressureListener(cb: (() => void) | null): void {
  onAudioBackpressureCb = cb;
}

/**
 * Decoded byte length of a base64 string without allocating a Buffer.
 * Used to count PCM bytes when `appendAudio` is handed a pre-encoded string
 * (legacy/test path) so the commit gate sees the same byte total as the
 * binary path.
 */
function base64DecodedBytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(len - 1) === 61 /* '=' */) padding++;
  if (len > 1 && b64.charCodeAt(len - 2) === 61) padding++;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  language?: string;        // e.g. "ja", "en"; undefined for auto-detect
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
  // MEDIUM-4: sliding window of recent backpressure drops (timestamps in ms).
  // Kept short — only the last BACKPRESSURE_WINDOW_MS worth — so old drops
  // age out and a brief network blip does not stay "armed" forever.
  private dropTimestamps: number[] = [];
  private lastBackpressureNotifyAt = 0;
  // PCM bytes successfully pushed to the server since the last commit/clear.
  // Counts only bytes that actually left over the socket (post backpressure
  // and open-state checks), so it reflects what the server's input buffer
  // really holds — the authoritative gate for `commit` (see MIN_COMMIT_BYTES).
  // Reset on commit, clear, and on each fresh `session.updated` ack so a
  // mid-take reconnect (which starts a new, empty server buffer) cannot let a
  // stale count wave through a commit against an empty buffer.
  private appendedBytesSinceCommit = 0;
  // Diagnostics: how many appends were dropped since the last commit/clear, by
  // cause. Logged at commit time so a failed take's log line shows whether the
  // audio was lost to a closed socket or to send-buffer backpressure.
  private droppedNotOpen = 0;
  private droppedBackpressure = 0;
  /**
   * Pending connect() settle while we wait for the server to ack our
   * `session.update` (FIX for the v0.1.8 dead-after-session.created class:
   * resolving connect() on socket-open made a setup-rejected session look
   * healthy). Cleared on ack, setup error, watchdog timeout, close/dispose.
   */
  private setupPending: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

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

    // MEDIUM-7: `dispose()` may run between the `new WebSocket(...)` call
    // and the first listener attachment below (e.g. the orchestrator
    // tears down mid-reconnect because the user revoked the API key).
    // Re-check `disposed` immediately after constructing the socket so a
    // mid-build dispose leaves no live socket holding the API-key header
    // in flight. Without this guard the WS handshake would complete
    // against a torn-down client and ws-level events would land on a
    // detached EventEmitter.
    if (this.disposed) {
      const stillborn = this.ws;
      this.ws = null;
      try {
        stillborn.terminate();
      } catch {
        /* ignore */
      }
      throw new Error('client disposed during reconnect');
    }

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onceOpen = (): void => {
        ws.off('error', onceError);
        this.opened = true;
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
        // v0.1.8: do NOT resolve here. Socket-open + session.created is not
        // a usable session — the server may still reject our session.update.
        // Resolve on the `session.updated` ack (onMessage), raced against
        // the READY_TIMEOUT_MS watchdog. `reconnectAttempts` is reset on
        // ack, not here, so a server that accepts the socket but never
        // becomes ready cannot reconnect-loop forever.
        const timer = setTimeout(() => {
          this.failSetup(
            new Error(
              `realtime session not ready within ${READY_TIMEOUT_MS / 1000}s (no session.updated ack)`
            )
          );
        }, READY_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        this.setupPending = { resolve, reject, timer };
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

  /** Clear + reject the pending connect() settle. Returns false if none. */
  private rejectSetup(err: Error): boolean {
    const pending = this.setupPending;
    if (!pending) return false;
    this.setupPending = null;
    clearTimeout(pending.timer);
    pending.reject(err);
    return true;
  }

  /**
   * Fail the in-flight connect() during the setup phase (between sending
   * session.update and receiving its ack) and tear the socket down.
   * `fatal` marks a server-side rejection of our session.update payload:
   * auto-reconnecting would resend the identical payload and loop forever
   * (the v0.1.8 `prompt` rejection), so reconnect is suppressed via
   * cleanClose. Non-fatal (watchdog timeout) leaves reconnect policy to
   * the caller / normal close path.
   */
  private failSetup(err: Error, fatal = false): void {
    if (!this.setupPending) return;
    if (fatal) this.cleanClose = true;
    this.opened = false;
    this.stopPing();
    const deadWs = this.ws;
    this.ws = null;
    if (deadWs) {
      try {
        deadWs.removeAllListeners();
        deadWs.terminate();
      } catch {
        /* ignore */
      }
    }
    this.rejectSetup(err);
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
            ...(this.opts.language ? { language: this.opts.language } : {})
            // Note: `prompt` (dictionary biasing) was removed here. As of
            // 2026-05-26 the Realtime API rejects it ("The 'prompt' parameter
            // is not supported for this model.") right after session.created.
            // The dictionary is still applied in the gpt-5-mini formatter
            // step (postprocess/formatter.ts).
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

  private recordBackpressureDrop(): void {
    const now = Date.now();
    this.dropTimestamps.push(now);
    // Age out drops outside the sliding window — find the first still-live
    // entry and splice once instead of shifting one element at a time.
    const cutoff = now - BACKPRESSURE_WINDOW_MS;
    let firstLive = 0;
    while (firstLive < this.dropTimestamps.length && this.dropTimestamps[firstLive]! < cutoff) {
      firstLive++;
    }
    if (firstLive > 0) this.dropTimestamps.splice(0, firstLive);
    if (
      this.dropTimestamps.length >= BACKPRESSURE_NOTIFY_THRESHOLD &&
      now - this.lastBackpressureNotifyAt >= BACKPRESSURE_NOTIFY_COOLDOWN_MS
    ) {
      this.lastBackpressureNotifyAt = now;
      try {
        onAudioBackpressureCb?.();
      } catch (err) {
        debug('REALTIME', `backpressure listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Append a PCM chunk. Accepts a Buffer/Uint8Array/ArrayBuffer or pre-encoded base64 string. */
  appendAudio(buf: Buffer | Uint8Array | ArrayBuffer | string): void {
    if (!this.opened || !this.ws) {
      this.droppedNotOpen++;
      return;
    }
    if (this.ws.bufferedAmount > AUDIO_BACKPRESSURE_BYTES) {
      this.droppedBackpressure++;
      debug('REALTIME', 'audio backpressure drop');
      // MEDIUM-4: silent drop was previously invisible to the user. At
      // 24 kHz mono PCM16 with ~50 ms chunks each drop ≈ 50 ms of audio,
      // so 10 drops in a 5 s window means roughly half a second has been
      // tossed — enough that the resulting transcript will miss words.
      // Surface that to the UI banner so the user knows their network is
      // the reason, not WindVoice. Old drops age out of the sliding window
      // so a one-off blip does not trigger.
      this.recordBackpressureDrop();
      return;
    }
    let base64: string;
    let pcmBytes: number;
    if (typeof buf === 'string') {
      base64 = buf;
      pcmBytes = base64DecodedBytes(buf);
    } else if (Buffer.isBuffer(buf)) {
      base64 = buf.toString('base64');
      pcmBytes = buf.byteLength;
    } else if (buf instanceof Uint8Array) {
      base64 = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64');
      pcmBytes = buf.byteLength;
    } else {
      base64 = Buffer.from(new Uint8Array(buf)).toString('base64');
      pcmBytes = buf.byteLength;
    }
    this.send({ type: 'input_audio_buffer.append', audio: base64 });
    // Count only what we actually sent: backpressure/closed-socket drops
    // returned early above, so this mirrors the server-side buffer length.
    this.appendedBytesSinceCommit += pcmBytes;
  }

  /**
   * Commit the buffered audio for transcription. Returns `true` only when a
   * commit was actually sent. When less than 100 ms (MIN_COMMIT_BYTES) has
   * reached the server, the commit is REFUSED client-side and `false` is
   * returned — committing here is what produces the server's "buffer too
   * small … 0.00ms of audio" error after a silent or dropped take. The
   * caller decides how to surface the empty take (see the orchestrator's
   * `handleEmptyTake`) and may call `clearInput()` to discard the partial
   * buffer.
   */
  commit(): boolean {
    if (!this.opened) {
      debug('REALTIME', 'commit refused: client not open');
      return false;
    }
    debug(
      'REALTIME',
      `commit gate: buffered=${this.appendedBytesSinceCommit}B (floor ${MIN_COMMIT_BYTES}B) ` +
        `droppedNotOpen=${this.droppedNotOpen} droppedBackpressure=${this.droppedBackpressure} ` +
        `wsBuffered=${this.ws?.bufferedAmount ?? -1}`
    );
    if (this.appendedBytesSinceCommit < MIN_COMMIT_BYTES) {
      this.resetAppendCounters();
      return false;
    }
    this.send({ type: 'input_audio_buffer.commit' });
    this.resetAppendCounters();
    return true;
  }

  private resetAppendCounters(): void {
    this.appendedBytesSinceCommit = 0;
    this.droppedNotOpen = 0;
    this.droppedBackpressure = 0;
  }

  /**
   * Discard the server-side input buffer without transcribing it. Used to
   * drop a sub-threshold / silent take so its leftover audio does not bleed
   * into the next dictation's commit.
   */
  clearInput(): void {
    if (!this.opened) return;
    this.send({ type: 'input_audio_buffer.clear' });
    this.resetAppendCounters();
  }

  isOpen(): boolean {
    return this.opened && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.opened = false;
    this.cleanClose = true;
    this.stopPing();
    this.clearReconnectTimer();
    // A connect() still waiting for the session.update ack must not hang.
    this.rejectSetup(new Error('client closed during session setup'));
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
    this.rejectSetup(new Error('client disposed during session setup'));
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

    // Transport dropped between session.update and its ack: fail the
    // pending connect() and let its caller own the retry decision —
    // scheduling our own reconnect here would race the caller's error
    // handling and double-drive the connection.
    if (this.rejectSetup(new Error('connection closed during session setup'))) {
      return;
    }

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
      // Setup ack: the server accepted our session.update — only now is the
      // session actually usable (see READY_TIMEOUT_MS). The transcription
      // intent emits `transcription_session.updated`; GA uses
      // `session.updated`. Accept both (events.ts SessionUpdatedEvent).
      case 'transcription_session.updated':
      case 'session.updated': {
        // Fresh / reconfigured session ⇒ empty server-side input buffer.
        // Drop any byte count carried over (e.g. from a take interrupted by a
        // reconnect) so the commit gate judges only audio appended to THIS
        // session and can't wave a commit through against an empty buffer.
        this.resetAppendCounters();
        const pending = this.setupPending;
        if (pending) {
          this.setupPending = null;
          clearTimeout(pending.timer);
          // Ready is the only place reconnect attempts reset — a server
          // that accepts the socket but never acks must hit the cap.
          this.reconnectAttempts = 0;
          pending.resolve();
        }
        break;
      }
      case 'error': {
        const ev = ErrorEvent.safeParse(parsed);
        if (!ev.success) break;
        const err = new Error(ev.data.error.message);
        if (this.setupPending) {
          // Server rejected our session.update (v0.1.8: "The 'prompt'
          // parameter is not supported for this model."). Fatal: a
          // reconnect would resend the identical payload and loop, so
          // fail the pending connect() and suppress auto-reconnect.
          this.failSetup(err, true);
        } else {
          this.emit('error', err);
        }
        break;
      }
      default:
        break;
    }
  }
}
