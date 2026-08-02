import { describe, expect, it } from 'vitest';
import {
  audioIdleModeForPlatform,
  shouldRecaptureStalledCapture
} from '@shared/audioCapturePolicy';

describe('audioIdleModeForPlatform', () => {
  it('keeps the capture graph warm on Windows to avoid a silent WASAPI resume', () => {
    expect(audioIdleModeForPlatform('win32')).toBe('keep-warm');
  });

  it.each(['darwin', 'linux'])('retains idle suspension on %s', (platform) => {
    expect(audioIdleModeForPlatform(platform)).toBe('suspend');
  });
});

describe('shouldRecaptureStalledCapture', () => {
  it('recaptures once when the graph delivers no chunks at all', () => {
    expect(shouldRecaptureStalledCapture(0, false)).toBe(true);
    expect(shouldRecaptureStalledCapture(0, true)).toBe(false);
  });

  it('does not mistake a quiet user for a dead microphone when chunks are arriving', () => {
    expect(shouldRecaptureStalledCapture(12, false)).toBe(false);
  });
});
