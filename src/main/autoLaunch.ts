// Cross-platform "launch on login" via Electron's setLoginItemSettings.
// Honored on Windows + macOS; on Linux this is a no-op (setLoginItemSettings
// is not implemented for Linux in Electron 32+, behavior tolerated).

import { app } from 'electron';
import { debug } from '@main/debug';

export function applyAutoLaunch(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // On macOS, openAsHidden launches without showing a Dock icon flash.
      openAsHidden: process.platform === 'darwin',
      // On Windows, args are passed through to the launcher; nothing extra.
      args: []
    });
    debug('DICTATION', `autoLaunch ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `autoLaunch failed: ${msg}`);
  }
}

export function isAutoLaunchEnabled(): boolean {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}
