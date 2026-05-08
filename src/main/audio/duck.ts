// Temporarily lowers the Windows master volume while a dictation is in
// flight, then restores it. Mirrors AquaVoice's "ducks other audio" behavior.
//
// Per-app session ducking would be ideal but requires native WASAPI bindings;
// master-volume ducking is good enough for v1 and ships with no native deps.

import loudness from 'loudness';
import { debug } from '@main/debug';

export type DuckErrorPhase = 'duck' | 'restore';
export type DuckErrorCallback = (phase: DuckErrorPhase, message: string) => void;

const errorListeners = new Set<DuckErrorCallback>();

export function onDuckError(cb: DuckErrorCallback): () => void {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

function emitError(phase: DuckErrorPhase, message: string): void {
  for (const cb of errorListeners) {
    try {
      cb(phase, message);
    } catch {
      /* swallow listener errors */
    }
  }
}

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

  /**
   * Save the current volume and lower it.
   * @param multiplier  0..1, target is `original * multiplier`
   */
  async duck(multiplier: number): Promise<void> {
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
      debug('DUCK', `failed to duck: ${msg}`);
      emitError('duck', msg);
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
      emitError('restore', msg);
    }
  }
}

export const audioDuck = new AudioDuck();
