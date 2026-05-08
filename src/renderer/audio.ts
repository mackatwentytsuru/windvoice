// Hidden renderer: captures the microphone, downsamples to 24 kHz mono PCM16,
// and forwards base64 chunks to the main process.

import workletSource from './audio-worklet.js?raw';

const TARGET_SAMPLE_RATE = 24_000;
const CHUNK_MS = 50;

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let workletUrl: string | null = null;

async function startCapture(): Promise<void> {
  if (audioCtx) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
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
    workletNode.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; samples: number }>) => {
      const bytes = new Uint8Array(e.data.pcm);
      const base64 = bytesToBase64(bytes);
      window.audio.sendChunk(base64, e.data.samples);
    };
    source.connect(workletNode);
    workletNode.connect(audioCtx.destination);
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length)))
    );
  }
  return btoa(binary);
}

window.audio.onStart(() => {
  void startCapture();
});
window.audio.onStop(() => {
  void stopCapture();
});

window.audio.ready();
