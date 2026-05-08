// Temporarily lowers the Windows master volume while a dictation is in
// flight, then restores it. Mirrors AquaVoice's "ducks other audio" behavior.
//
// Per-app session ducking would be ideal but requires native WASAPI bindings;
// master-volume ducking is good enough for v1 and ships with no native deps.

import loudness from 'loudness';

const DEBUG = process.env['WINDVOICE_DEBUG_DUCK'] === '1';

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
      if (DEBUG) process.stderr.write(`[duck] ${v} → ${target}\n`);
    } catch (err) {
      if (DEBUG) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[duck] failed to duck: ${msg}\n`);
      }
    }
  }

  async restore(): Promise<void> {
    if (!this.active || this.originalVolume == null) return;
    const original = this.originalVolume;
    this.active = false;
    this.originalVolume = null;
    try {
      await loudness.setVolume(original);
      if (DEBUG) process.stderr.write(`[duck] restored to ${original}\n`);
    } catch (err) {
      if (DEBUG) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[duck] failed to restore: ${msg}\n`);
      }
    }
  }
}

export const audioDuck = new AudioDuck();
