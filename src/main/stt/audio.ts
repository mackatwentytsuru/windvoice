// PCM helpers for the local STT path.
//
// The audio bridge delivers 24 kHz mono PCM16 (see TARGET_SAMPLE_RATE).
// The sherpa-onnx server expects a WAV upload; we resample to 16 kHz with
// linear interpolation (good enough for speech recognition) and wrap the
// result in a minimal 44-byte PCM WAV container. Everything is little
// endian — that is both the WAV format and what the renderer's Int16Array
// worklet produces on every platform WindVoice supports.

import { TARGET_SAMPLE_RATE } from '@shared/constants';

/** Sample rate the local sherpa-onnx server is fed. */
export const LOCAL_STT_SAMPLE_RATE = 16_000;

/**
 * Resample PCM16 with linear interpolation. Returns a fresh array (as a
 * copy when the rates match) so callers never share the input buffer.
 * A single-sample input (or an empty one) is handled without indexing out
 * of bounds.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (fromRate === toRate) return Int16Array.from(input);

  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const ratio = fromRate / toRate;
  const last = input.length - 1;

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    if (lo >= last) {
      out[i] = input[last] as number;
      continue;
    }
    const frac = pos - lo;
    const a = input[lo] as number;
    const b = input[lo + 1] as number;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Build a mono PCM16 WAV file (44-byte RIFF header + little-endian samples). */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (rate * channels * 2)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i] as number, 44 + i * 2);
  }
  return buf;
}

/** 24 kHz PCM16 → 16 kHz mono WAV, ready to POST to /transcribe. */
export function pcm24kToWav16k(pcm24k: Int16Array): Buffer {
  const pcm16k = resamplePcm16(pcm24k, TARGET_SAMPLE_RATE, LOCAL_STT_SAMPLE_RATE);
  return encodeWav(pcm16k, LOCAL_STT_SAMPLE_RATE);
}
