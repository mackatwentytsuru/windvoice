// Hidden renderer: captures the microphone, downsamples to 24 kHz mono PCM16,
// computes per-chunk RMS for the overlay meter, and forwards raw PCM bytes +
// optional level to the main process. Electron's structured-clone serializer
// transfers Uint8Array buffers efficiently — no base64 round-trip.

import workletSource from './audio-worklet.js?raw';
import { CHUNK_MS, TARGET_SAMPLE_RATE } from '../shared/constants';
import type { AudioIdleMode } from '../shared/audioCapturePolicy';

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let workletUrl: string | null = null;
let currentDeviceId: string | null = null;
let beepCtx: AudioContext | null = null;
// Windows keeps the capture graph running between takes to avoid a WASAPI
// resume that can deliver digital silence while another app uses the mic.
// The worklet forwarding gate still prevents idle PCM from crossing IPC.
let idleMode: AudioIdleMode = 'suspend';
let forwardingRequested = false;
// Synchronous in-flight guard for startCapture. `audioCtx` is only assigned
// AFTER the awaited getUserMedia, so two interleaving callers both pass an
// `if (audioCtx) return` check, each build a MediaStream + AudioContext, and
// the second assignment overwrites the first without stopping its tracks —
// leaking a live mic track. This boolean (set before any await, cleared in a
// finally) closes that check-then-act gap.
let starting = false;
// Guards against overlapping recoveries: a sleep/resume can fire the power
// monitor AND a `track.ended` event almost simultaneously, and each would
// otherwise kick off its own stop→start cycle.
let recovering = false;
// Set when a dictation-start resume arrives while a suspend-mode recapture()
// is in flight. recapture() resumes the rebuilt context in its finally so the
// in-progress rebuild does not leave the current take without a running graph.
let pendingResume = false;

function setWorkletForwarding(enabled: boolean): void {
  workletNode?.port.postMessage({ type: 'set-forwarding', enabled });
}

/**
 * When the OS suspends/resumes (sleep, audio device reset, headset unplug),
 * the live MediaStreamTrack goes to `ended`/`muted` and never recovers on its
 * own — the worklet keeps running on a dead track, so the meter freezes and
 * dictation captures only silence. Watch the track and rebuild on loss.
 */
function watchTrackHealth(stream: MediaStream): void {
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      window.audio.reportError('mic track ended — re-acquiring');
      void recapture();
    });
  }
}

/**
 * True only when the capture graph is wired AND a live mic track is actually
 * able to deliver audio (not `ended`, not `muted`). A track can silently go
 * `muted`/silent after a display-off, audio-device reset, or another app
 * grabbing the mic — WITHOUT firing `ended` and WITHOUT a powerMonitor
 * resume/unlock event — leaving the prewarmed graph alive but deaf until the
 * app restarts. This is the liveness probe used right before each dictation.
 */
function isCaptureHealthy(): boolean {
  if (!audioCtx || !mediaStream) return false;
  const tracks = mediaStream.getAudioTracks();
  return tracks.length > 0 && tracks.some((t) => t.readyState === 'live' && !t.muted);
}

async function startCapture(deviceId?: string): Promise<void> {
  // Reentrancy guard: `starting` is checked/set synchronously before any
  // await so a second call cannot slip past while the first is mid-build
  // (the `audioCtx` check alone is too late — see the flag's declaration).
  if (starting || audioCtx) return;
  starting = true;
  try {
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,
        // Dictation needs the RAW mic feed. Chromium's call-oriented DSP can
        // latch into a state that classifies real speech as noise and clamps
        // the signal to a near-zero floor (~0.005 RMS) mid-session and keeps it
        // there — observed in the field as the mic "dying", level collapsing
        // from ~0.8 to a stuck 0.0047 with empty transcripts. Disabling all
        // three gives a stable, unprocessed feed the transcription model
        // handles well, and removes the most common cause of mid-session
        // capture degradation. (noiseSuppression is the prime offender; AGC and
        // echoCancellation are off too so nothing pumps or cancels the input.)
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {})
      }
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    currentDeviceId = deviceId ?? null;
    watchTrackHealth(mediaStream);
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
    setWorkletForwarding(forwardingRequested);
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
    // macOS/Linux retain the issue #7 idle optimization. Windows deliberately
    // keeps the graph alive: resuming a suspended Chromium/WASAPI path while
    // another app uses the same device can yield digital silence for the first
    // take. The closed worklet gate above avoids idle IPC on every platform.
    if (idleMode === 'suspend' && !forwardingRequested) {
      audioCtx.suspend().catch((e: unknown) => {
        window.audio.reportError(
          `audioCtx.suspend failed: ${e instanceof Error ? e.message : String(e)}`
        );
      });
    } else if (idleMode === 'keep-warm' && audioCtx.state === 'suspended') {
      // Electron normally starts this context in `running`, but explicitly
      // warm it if Chromium's autoplay policy created it suspended.
      audioCtx.resume().catch((e: unknown) => {
        window.audio.reportError(
          `audioCtx warm-up resume failed: ${e instanceof Error ? e.message : String(e)}`
        );
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    window.audio.reportError(msg);
    await stopCapture();
    throw err;
  } finally {
    starting = false;
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

/**
 * Rebuild the capture graph from scratch, preserving the selected device.
 * Triggered by the main process after the OS resumes from sleep, and by the
 * `track.ended` watcher. If the previously selected device has vanished
 * (e.g. an unplugged USB mic), fall back to the system default rather than
 * leaving the user with no working microphone.
 */
async function recapture(): Promise<void> {
  if (recovering) return;
  recovering = true;
  const device = currentDeviceId ?? undefined;
  try {
    await stopCapture();
    try {
      await startCapture(device);
    } catch {
      // `{ deviceId: { exact } }` throws OverconstrainedError when the device
      // is gone. Retry on the default input so capture still works.
      if (device) await startCapture(undefined);
    }
  } catch (e: unknown) {
    window.audio.reportError(
      `recapture failed: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    recovering = false;
    // A dictation-start resume may have arrived mid-rebuild. Resume now so this
    // take captures audio instead of waiting for the next PTT press. A release
    // clears pendingResume, and resume() is idempotent on a running context.
    if (pendingResume) {
      pendingResume = false;
      if (audioCtx) {
        audioCtx.resume().catch((e: unknown) => {
          window.audio.reportError(
            `audioCtx.resume after rebuild failed: ${e instanceof Error ? e.message : String(e)}`
          );
        });
      }
    }
  }
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

window.audio.onStart((deviceId: string | undefined, requestedIdleMode: AudioIdleMode) => {
  idleMode = requestedIdleMode;
  void startCapture(deviceId);
});
window.audio.onStop(() => {
  void stopCapture();
});
window.audio.onDeviceChange((deviceId: string) => {
  void restartWithDevice(deviceId);
});
// Close/open the worklet forwarding gate around each take. macOS/Linux also
// suspend the AudioContext (issue #7); Windows keeps it running to prevent a
// silent WASAPI resume while another application is using the same mic.
window.audio.onSuspend?.(() => {
  forwardingRequested = false;
  pendingResume = false;
  setWorkletForwarding(false);
  if (idleMode === 'suspend' && audioCtx && audioCtx.state === 'running') {
    audioCtx.suspend().catch((e: unknown) => {
      window.audio.reportError(
        `audioCtx.suspend failed: ${e instanceof Error ? e.message : String(e)}`
      );
    });
  }
});
window.audio.onResume?.(() => {
  forwardingRequested = true;
  setWorkletForwarding(true);
  // PTT pressed: this fires at the very start of every dictation. Before
  // resuming the prewarmed graph, verify the mic is still actually live —
  // a silent/`muted` track that never fired `ended` (the most common cause
  // of "the overlay shows but nothing is captured until I restart") would
  // otherwise feed only silence. Rebuild, then resume so THIS dictation
  // still captures audio rather than waiting for the next press.
  // If a rebuild is already in flight (a forced recapture fired just before
  // this PTT press — the deterministic AUDIO_RECOVER_CMD → AUDIO_RESUME_CMD
  // ordering), do NOT start a second recapture and do NOT resume now: the
  // context is mid-teardown (audioCtx may be null), so an immediate resume is a
  // no-op and the rebuilt context would be left suspended forever. Flag the
  // resume; recapture()'s finally performs it once the new context exists.
  if (recovering || !isCaptureHealthy()) {
    if (!recovering) window.audio.reportError('mic not live at capture start — rebuilding');
    pendingResume = true;
    void recapture(); // no-op if a rebuild is already running
    return;
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    pendingResume = false;
    audioCtx.resume().catch((e: unknown) => {
      window.audio.reportError(
        `audioCtx.resume failed: ${e instanceof Error ? e.message : String(e)}`
      );
    });
  }
});
// Power resume / device-loss recovery: rebuild the whole capture graph.
// `resumeAfterRebuild` is true only when the rebuild fires mid-dictation
// (e.g. the main-process silence watchdog firing during active forwarding).
// In suspend mode, a rebuild that started during an active dictation may need
// the new context resumed after the async rebuild. The forwardingRequested
// guard prevents a short take that already ended from waking it back up.
// Mirror the onResume rebuild branch: resume AFTER awaiting recapture to avoid
// cross-process races.
// Param is optional so this stays assignable to the `() => void` callback type
// declared in env.d.ts; the preload always sends an explicit boolean.
window.audio.onRecover?.((resumeAfterRebuild?: boolean) => {
  void recapture().then(() => {
    if (
      idleMode === 'suspend' &&
      resumeAfterRebuild &&
      forwardingRequested &&
      audioCtx
    ) {
      audioCtx.resume().catch((e: unknown) => {
        window.audio.reportError(
          `audioCtx.resume after recover failed: ${e instanceof Error ? e.message : String(e)}`
        );
      });
    }
  });
});
// Audio device topology changed (USB mic unplugged, Bluetooth headset
// handoff, default device switched). `devicechange` fires for ANY add/remove
// — including unrelated devices like a webcam — so only rebuild when OUR
// capture actually broke, leaving a healthy mic untouched mid-dictation.
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (audioCtx && !isCaptureHealthy()) {
    window.audio.reportError('device change broke mic — re-acquiring');
    void recapture();
  }
});
window.audio.onBeep((kind: 'start' | 'stop') => {
  playBeep(kind);
});

window.audio.ready();
