// Temporarily lowers the Windows master volume while a dictation is in
// flight, then restores it. Mirrors AquaVoice's "ducks other audio" behavior.
//
// Per-app session ducking would be ideal but requires native WASAPI bindings;
// master-volume ducking is good enough for v1 and ships with no native deps.

import loudness from 'loudness';
import { debug } from '@main/debug';

// macOS `loudness` shells out to osascript and changes the GLOBAL system
// output volume — surprising. Skip on darwin unless the user explicitly opts
// in via env var.
function isDuckingAllowed(): boolean {
  if (process.platform !== 'darwin') return true;
  return process.env['WINDVOICE_DUCK_MAC'] === '1';
}

export class AudioDuck {
  private originalVolume: number | null = null;
  private active = false;
  private disabled = false;

  /**
   * Save the current volume and lower it.
   * @param multiplier  0..1, target is `original * multiplier`
   */
  async duck(multiplier: number): Promise<void> {
    if (this.disabled) return;
    if (this.active) return;
    if (multiplier >= 1) return;
    if (!isDuckingAllowed()) {
      debug('DUCK', 'skipped (mac default; set WINDVOICE_DUCK_MAC=1 to enable)');
      return;
    }
    try {
      const v = await loudness.getVolume();
      this.originalVolume = v;
      const target = Math.max(0, Math.min(100, Math.round(v * multiplier)));
      await loudness.setVolume(target);
      this.active = true;
      debug('DUCK', `${v} → ${target}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.disabled = true;
      this.active = false;
      this.originalVolume = null;
      debug('DUCK', `disabled for this launch after duck backend failure: ${msg}`);
    }
  }

  async restore(): Promise<void> {
    if (this.disabled) return;
    if (!this.active || this.originalVolume == null) return;
    // Await the restore BEFORE clearing state. If setVolume rejects, keep
    // active=true + originalVolume so duck()'s `if (this.active) return` guard
    // preserves the TRUE original (not the lowered value) and a later restore
    // can retry — otherwise a failed restore would leave volume stuck low and
    // the next duck() would re-save the lowered value, ratcheting it down.
    const original = this.originalVolume;
    try {
      await loudness.setVolume(original);
      this.active = false;
      this.originalVolume = null;
      debug('DUCK', `restored to ${original}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.disabled = true;
      this.active = false;
      this.originalVolume = null;
      debug('DUCK', `disabled for this launch after restore backend failure: ${msg}`);
    }
  }
}

export const audioDuck = new AudioDuck();
