import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface WorkletPort {
  onmessage?: (event: { data: unknown }) => void;
  postMessage: ReturnType<typeof vi.fn>;
}

interface WorkletProcessor {
  port: WorkletPort;
  process(inputs: Float32Array[][]): boolean;
}

function loadProcessor(): WorkletProcessor {
  const source = fs.readFileSync(
    new URL('../src/renderer/audio-worklet.js', import.meta.url),
    'utf8'
  );
  let Processor:
    | (new (options: {
        processorOptions: {
          sourceSampleRate: number;
          targetSampleRate: number;
          chunkMs: number;
        };
      }) => WorkletProcessor)
    | undefined;

  class FakeAudioWorkletProcessor {
    readonly port: WorkletPort = {
      postMessage: vi.fn()
    };
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Float32Array,
    Int16Array,
    Math,
    sampleRate: 1,
    registerProcessor: (
      _name: string,
      ctor: new (options: {
        processorOptions: {
          sourceSampleRate: number;
          targetSampleRate: number;
          chunkMs: number;
        };
      }) => WorkletProcessor
    ) => {
      Processor = ctor;
    }
  });

  if (!Processor) throw new Error('pcm-downsampler was not registered');
  return new Processor({
    processorOptions: {
      sourceSampleRate: 1,
      targetSampleRate: 1,
      chunkMs: 1_000
    }
  });
}

function processOneChunk(processor: WorkletProcessor): void {
  processor.process([[new Float32Array([0.25])]]);
}

describe('audio worklet forwarding gate', () => {
  it('keeps processing the warm microphone but emits PCM only during a take', () => {
    const processor = loadProcessor();

    processOneChunk(processor);
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    processor.port.onmessage?.({ data: { type: 'set-forwarding', enabled: true } });
    processOneChunk(processor);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);

    processor.port.onmessage?.({ data: { type: 'set-forwarding', enabled: false } });
    processOneChunk(processor);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
  });
});
