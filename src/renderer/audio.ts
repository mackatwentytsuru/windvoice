// Hidden renderer: captures the microphone, downsamples to 24 kHz mono PCM16,
// computes per-chunk RMS for the overlay meter, and forwards raw PCM bytes +
// optional level to the main process. Electron's structured-clone serializer
// transfers Uint8Array buffers efficiently — no base64 round-trip.

import workletSource from './audio-worklet.js?raw';
import { CHUNK_MS, TARGET_SAMPLE_RATE } from '../shared/constants';

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let workletUrl: string | null = null;
let currentDeviceId: string | null = null;
let beepCtx: AudioContext | null = null;

async function startCapture(deviceId?: string): Promise<void> {
  if (audioCtx) return;
  try {
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {})
      }
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    currentDeviceId = deviceId ?? null;
    audioCtx = new AudioContext();
    if (!workletUrl) {
      const blob = new Blob([workletSource], { type: 'application/javascript' });
      workletUrl = URL.createObjectURL(blob);
    }
    await audioCtx.audioWorklet.addModule(workletUrl);
    source = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-downsampler', {
      processorOptions: {
        sourceSampleRate: audioCtx.sampleRate,
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkMs: CHUNK_MS
      }
    });
    workletNode.port.onmessage = (
      e: MessageEvent<{ pcm: ArrayBuffer; samples: number; level: number }>
    ) => {
      const bytes = new Uint8Array(e.data.pcm);
      // Pass the Uint8Array directly; preload signature is typed as `string`,
      // but Electron's structured-clone serializer copies binary data without
      // round-tripping through a JS string. Cast to satisfy the type.
      (window.audio.sendChunk as unknown as (
        data: Uint8Array,
        samples: number,
        level?: number
      ) => void)(bytes, e.data.samples, e.data.level);
    };
    source.connect(workletNode);
    workletNode.connect(audioCtx.destination);
    // Idle suspension (issue #7): once the audio graph is wired and
    // mic permission is granted, suspend the context immediately. The
    // next `beginForwarding()` on main will fire AUDIO_RESUME_CMD,
    // which resumes in ~5-15ms — well within perceptual start-recording
    // latency. This stops the 20Hz IPC + Buffer churn during idle.
    try {
      await audioCtx.suspend();
    } catch {
      /* best-effort */
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    window.audio.reportError(msg);
    await stopCapture();
    throw err;
  }
}

async function stopCapture(): Promise<void> {
  try {
    if (workletNode) {
      try {
        workletNode.disconnect();
      } catch {
        /* ignore */
      }
      workletNode = null;
    }
    if (source) {
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      source = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioCtx) {
      await audioCtx.close();
      audioCtx = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    window.audio.reportError(`stopCapture: ${msg}`);
  }
}

async function restartWithDevice(deviceId: string): Promise<void> {
  if (deviceId === currentDeviceId && audioCtx) return;
  await stopCapture();
  await startCapture(deviceId);
}

// ─── beep generator ────────────────────────────────────────────────────────

function ensureBeepCtx(): AudioContext {
  if (!beepCtx) beepCtx = new AudioContext();
  return beepCtx;
}

function playBeep(kind: 'start' | 'stop'): void {
  try {
    const ctx = ensureBeepCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.type = 'sine';
    const now = ctx.currentTime;
    if (kind === 'start') {
      osc.frequency.setValueAtTime(540, now);
      osc.frequency.exponentialRampToValueAtTime(720, now + 0.07);
    } else {
      osc.frequency.setValueAtTime(820, now);
      osc.frequency.exponentialRampToValueAtTime(560, now + 0.06);
    }
    const peak = 0.16;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'start' ? 0.09 : 0.07));
    osc.start(now);
    osc.stop(now + 0.12);
  } catch {
    /* ignore: best-effort cue */
  }
}

// ─── wiring ────────────────────────────────────────────────────────────────

window.audio.onStart((deviceId?: string) => {
  void startCapture(deviceId);
});
window.audio.onStop(() => {
  void stopCapture();
});
window.audio.onDeviceChange((deviceId: string) => {
  void restartWithDevice(deviceId);
});
// Suspend / resume the AudioContext on idle to stop the 20Hz chunk
// pipeline when the user is not dictating (issue #7).
window.audio.onSuspend?.(() => {
  if (audioCtx && audioCtx.state === 'running') {
    void audioCtx.suspend();
  }
});
window.audio.onResume?.(() => {
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
});
window.audio.onBeep((kind: 'start' | 'stop') => {
  playBeep(kind);
});

window.audio.ready();
