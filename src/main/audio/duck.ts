// Temporarily lowers the Windows master volume while a dictation is in
// flight, then restores it. Mirrors AquaVoice's "ducks other audio" behavior.
//
// Per-app session ducking would be ideal but requires native WASAPI bindings;
// master-volume ducking is good enough for v1 and ships with no native deps.

import loudness from 'loudness';
import { debug } from '@main/debug';

export class AudioDuck {
  private originalVolume: number | null = null;
  private active = false;

  /**
   * Save the current volume and lower it.
   * @param multiplier  0..1, target is `original * multiplier`
   */
  async duck(multiplier: number): Promise<void> {
    if (this.active) return;
    if (multiplier >= 1) return;
    try {
      const v = await loudness.getVolume();
      this.originalVolume = v;
      const target = Math.max(0, Math.min(100, Math.round(v * multiplier)));
      await loudness.setVolume(target);
      this.active = true;
      debug('DUCK', `${v} → ${target}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DUCK', `failed to duck: ${msg}`);
    }
  }

  async restore(): Promise<void> {
    if (!this.active || this.originalVolume == null) return;
    const original = this.originalVolume;
    this.active = false;
    this.originalVolume = null;
    try {
      await loudness.setVolume(original);
      debug('DUCK', `restored to ${original}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DUCK', `failed to restore: ${msg}`);
    }
  }
}

export const audioDuck = new AudioDuck();
