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

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string };

let lastState: UpdaterState = { phase: 'idle' };

function broadcast(state: UpdaterState): void {
  lastState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(STATE_CHANNEL, state);
  }
}

/**
 * Initialize electron-updater. Safe to call once at app start. In dev mode
 * (un-packaged) the library is a no-op so we skip the check entirely.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    debug('DICTATION', 'auto-update disabled (dev mode)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => broadcast({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    broadcast({ phase: 'available', version: info.version })
  );
  autoUpdater.on('update-not-available', () => broadcast({ phase: 'not-available' }));
  autoUpdater.on('download-progress', (p) =>
    broadcast({ phase: 'downloading', percent: Math.round(p.percent) })
  );
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ phase: 'downloaded', version: info.version })
  );
  autoUpdater.on('error', (err) =>
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
    autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.handle('updater:lastState', (): UpdaterState => lastState);

  // Optional kickoff at startup if user opted in.
  if (settingsStore.get().ui.autoUpdate) {
    autoUpdater.checkForUpdates().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `auto-update startup check failed: ${msg}`);
    });
  }
}
