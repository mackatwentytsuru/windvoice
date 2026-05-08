// AudioWorkletProcessor: downsamples Float32 audio to 24 kHz Int16 PCM
// and emits ~50 ms chunks via port.postMessage.
//
// Loaded as a Blob URL by audio.ts (imported with ?raw).
// Plain JS so it runs unchanged in the worklet global scope.

class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceSampleRate || sampleRate;
    this.targetRate = opts.targetSampleRate || 24000;
    this.ratio = this.sourceRate / this.targetRate;
    const chunkMs = opts.chunkMs || 50;
    this.chunkSamples = Math.round((this.targetRate * chunkMs) / 1000);
    this.accumulator = new Float32Array(this.chunkSamples * 4);
    this.accumLen = 0;
    this.resamplePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    while (this.resamplePos < channel.length) {
      const idx = this.resamplePos;
      const lo = Math.floor(idx);
      const hi = lo + 1 < channel.length ? lo + 1 : lo;
      const frac = idx - lo;
      const a = channel[lo] || 0;
      const b = channel[hi] || 0;
      const sample = a * (1 - frac) + b * frac;
      this.pushSample(sample);
      this.resamplePos += this.ratio;
    }
    this.resamplePos -= channel.length;
    return true;
  }

  pushSample(value) {
    if (this.accumLen >= this.accumulator.length) {
      const grown = new Float32Array(this.accumulator.length * 2);
      grown.set(this.accumulator);
      this.accumulator = grown;
    }
    this.accumulator[this.accumLen++] = value;
    if (this.accumLen >= this.chunkSamples) this.flush();
  }

  flush() {
    const samples = this.accumLen;
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
      let s = this.accumulator[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    this.accumLen = 0;
    this.port.postMessage({ pcm: pcm.buffer, samples }, [pcm.buffer]);
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
