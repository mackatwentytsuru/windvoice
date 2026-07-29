// Cross-platform "launch on login". Windows + macOS use Electron's
// setLoginItemSettings. Linux uses the XDG autostart spec directly —
// setLoginItemSettings is not implemented for Linux in Electron 32+ — by
// writing/removing ~/.config/autostart/windvoice.desktop.

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { debug } from '@main/debug';

export type AutoLaunchErrorCallback = (message: string) => void;

const errorListeners = new Set<AutoLaunchErrorCallback>();

export function onAutoLaunchError(cb: AutoLaunchErrorCallback): () => void {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

function emitError(message: string): void {
  for (const cb of errorListeners) {
    try {
      cb(message);
    } catch {
      /* swallow listener errors */
    }
  }
}

function linuxAutostartFile(): string {
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', 'windvoice.desktop');
}

/**
 * The command that re-launches this exact build. For AppImage runs Electron
 * unpacks to a temp dir and process.execPath points inside it — APPIMAGE
 * holds the stable on-disk path the user actually installed.
 */
function linuxExecCommand(): string {
  const appImage = process.env['APPIMAGE'];
  const target = appImage && appImage.length > 0 ? appImage : process.execPath;
  // Desktop-entry Exec quoting: wrap in double quotes, escape embedded ones.
  return `"${target.replace(/"/g, '\\"')}"`;
}

function applyAutoLaunchLinux(enabled: boolean): void {
  const file = linuxAutostartFile();
  try {
    if (!enabled) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      debug('DICTATION', 'autoLaunch disabled (removed XDG autostart entry)');
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=WindVoice',
      'Icon=windvoice',
      'Comment=Voice dictation (starts in the tray)',
      `Exec=${linuxExecCommand()}`,
      'Terminal=false',
      'StartupNotify=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n');
    fs.writeFileSync(file, desktop, 'utf8');
    debug('DICTATION', 'autoLaunch enabled (wrote XDG autostart entry)');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `autoLaunch (linux) failed: ${msg}`);
    emitError(msg);
  }
}

export function applyAutoLaunch(enabled: boolean): void {
  if (process.platform === 'linux') {
    applyAutoLaunchLinux(enabled);
    return;
  }
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
    emitError(msg);
  }
}

export function isAutoLaunchEnabled(): boolean {
  if (process.platform === 'linux') {
    try {
      return fs.existsSync(linuxAutostartFile());
    } catch {
      return false;
    }
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}
