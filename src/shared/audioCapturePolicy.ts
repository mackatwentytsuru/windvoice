/**
 * Controls what the hidden audio renderer does between push-to-talk takes.
 *
 * Windows keeps the WebAudio graph running because suspending and resuming it
 * can re-open the underlying WASAPI path as digital silence when another
 * application is using the same input device. Other platforms retain the
 * lower-power suspend behavior.
 */
export type AudioIdleMode = 'suspend' | 'keep-warm';

export function audioIdleModeForPlatform(platform: string): AudioIdleMode {
  return platform === 'win32' ? 'keep-warm' : 'suspend';
}
