import { describe, expect, it } from 'vitest';
import {
  LOCAL_STT_SAMPLE_RATE,
  encodeWav,
  pcm24kToWav16k,
  resamplePcm16
} from '../src/main/stt/audio';

describe('resamplePcm16', () => {
  it('downsamples 24 kHz to 16 kHz at a 2/3 ratio with linear interpolation', () => {
    const input = new Int16Array(2400);
    for (let i = 0; i < input.length; i++) input[i] = i * 10;
    const out = resamplePcm16(input, 24_000, 16_000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBe(0);
    // 1.5 source samples per output sample: out[1] sits halfway between 10 and 20.
    expect(out[1]).toBe(15);
    expect(out[2]).toBe(30);
  });

  it('returns a copy of the input when the rates match', () => {
    const input = Int16Array.from([1, -2, 3]);
    const out = resamplePcm16(input, 16_000, 16_000);
    expect(Array.from(out)).toEqual([1, -2, 3]);
    expect(out).not.toBe(input);
  });

  it('handles empty and single-sample input without indexing past the end', () => {
    expect(resamplePcm16(new Int16Array(0), 24_000, 16_000).length).toBe(0);
    const one = resamplePcm16(Int16Array.from([1234]), 24_000, 16_000);
    expect(one.length).toBe(1);
    expect(one[0]).toBe(1234);
  });

  it('does not mutate the input array', () => {
    const input = Int16Array.from([100, 200, 300]);
    const copy = Int16Array.from(input);
    resamplePcm16(input, 24_000, 16_000);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});

describe('encodeWav', () => {
  it('writes a 44-byte PCM16 mono WAV header', () => {
    const pcm = Int16Array.from([0, 1000, -1000]);
    const wav = encodeWav(pcm, 16_000);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length * 2);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2);
  });

  it('writes samples little-endian', () => {
    const wav = encodeWav(Int16Array.from([0x1234, -2]), 16_000);
    expect(wav[44]).toBe(0x34);
    expect(wav[45]).toBe(0x12);
    expect(wav.readInt16LE(46)).toBe(-2);
  });

  it('pcm24kToWav16k resamples before wrapping', () => {
    const wav = pcm24kToWav16k(new Int16Array(2400));
    expect(wav.readUInt32LE(24)).toBe(LOCAL_STT_SAMPLE_RATE);
    expect(wav.readUInt32LE(40)).toBe(1600 * 2);
    expect(wav.length).toBe(44 + 3200);
  });
});
