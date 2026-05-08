// Auto-update via electron-updater. Reads from GitHub Releases
// (configured in `electron-builder.yml`). Wraps the library so the rest
// of the app sees a small interface and can broadcast update state to
// renderer windows.

import { BrowserWindow, app, ipcMain } from 'electron';
import pkg from 'electron-updater';
import { debug } from '@main/debug';
import { settingsStore } from '@main/store/settings';

const { autoUpdater } = pkg;

const CHECK_CHANNEL = 'updater:check';
const STATE_CHANNEL = 'updater:state';
const RESTART_CHANNEL = 'updater:restart';
const LAST_STATE_CHANNEL = 'updater:lastState';

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string };

let lastState: UpdaterState = { phase: 'idle' };
let initialized = false;
let pendingInstall: { version: string } | null = null;
let dictationActiveCheck: (() => boolean) | null = null;

/**
 * Allow the orchestrator (wired in main/index.ts) to expose an
 * "is dictation in flight?" probe, so we don't yank the app out from under
 * an active dictation when an update finishes downloading.
 */
export function onCheckDictationActive(cb: () => boolean): void {
  dictationActiveCheck = cb;
}

/**
 * Call when dictation transitions to idle. If a downloaded update was
 * deferred, install it now.
 */
export function notifyDictationIdle(): void {
  if (pendingInstall) {
    pendingInstall = null;
    autoUpdater.quitAndInstall(false, true);
  }
}

function broadcast(state: UpdaterState): void {
  lastState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(STATE_CHANNEL, state);
  }
}

function isAutoUpdateAllowedOnPlatform(): boolean {
  if (process.platform !== 'darwin') return true;
  // Mac: auto-update only when explicitly opted in. Unsigned builds cannot
  // verify update signatures, so default to OFF.
  if (process.env['WINDVOICE_AUTOUPDATE_DARWIN'] === '1') return true;
  // Build-time signed-build flag, for future signed releases.
  return process.env['WINDVOICE_SIGNED_BUILD'] === '1';
}

/**
 * Initialize electron-updater. Safe to call multiple times — guarded so
 * IPC handlers and listeners aren't registered twice.
 */
export function initAutoUpdater(): void {
  if (initialized) return;
  if (!app.isPackaged) {
    debug('DICTATION', 'auto-update disabled (dev mode)');
    return;
  }
  if (!isAutoUpdateAllowedOnPlatform()) {
    debug('DICTATION', 'auto-update disabled (unsigned macOS build)');
    return;
  }
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    // If we previously surfaced an error, reset state so the UI doesn't
    // continue to display a stale error pill.
    if (lastState.phase === 'error') lastState = { phase: 'idle' };
    broadcast({ phase: 'checking' });
  });
  autoUpdater.on('update-available', (info: { version: string }) =>
    broadcast({ phase: 'available', version: info.version })
  );
  autoUpdater.on('update-not-available', () => broadcast({ phase: 'not-available' }));
  autoUpdater.on('download-progress', (p: { percent: number }) =>
    broadcast({ phase: 'downloading', percent: Math.round(p.percent) })
  );
  autoUpdater.on('update-downloaded', (info: { version: string }) =>
    broadcast({ phase: 'downloaded', version: info.version })
  );
  autoUpdater.on('error', (err: Error) =>
    broadcast({ phase: 'error', message: err.message })
  );

  ipcMain.handle(CHECK_CHANNEL, async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ phase: 'error', message: msg });
    }
    return lastState;
  });

  ipcMain.handle(RESTART_CHANNEL, () => {
    if (dictationActiveCheck && dictationActiveCheck()) {
      const version =
        lastState.phase === 'downloaded' ? lastState.version : 'pending';
      pendingInstall = { version };
      debug('DICTATION', 'updater: deferring install — dictation in flight');
      return { deferred: true };
    }
    autoUpdater.quitAndInstall(false, true);
    return { deferred: false };
  });
  ipcMain.handle(LAST_STATE_CHANNEL, (): UpdaterState => lastState);

  // Optional kickoff at startup if user opted in.
  if (settingsStore.get().ui.autoUpdate) {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `auto-update startup check failed: ${msg}`);
    });
  }
}
