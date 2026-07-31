import { describe, expect, it } from 'vitest';
import { audioIdleModeForPlatform } from '@shared/audioCapturePolicy';

describe('audioIdleModeForPlatform', () => {
  it('keeps the capture graph warm on Windows to avoid a silent WASAPI resume', () => {
    expect(audioIdleModeForPlatform('win32')).toBe('keep-warm');
  });

  it.each(['darwin', 'linux'])('retains idle suspension on %s', (platform) => {
    expect(audioIdleModeForPlatform(platform)).toBe('suspend');
  });
});
