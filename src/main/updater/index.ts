// Auto-update via electron-updater. Reads from GitHub Releases
// (configured in `electron-builder.yml`). Wraps the library so the rest
// of the app sees a small interface and can broadcast update state to
// renderer windows.

import { BrowserWindow, app, ipcMain } from 'electron';
import pkg from 'electron-updater';
import { debug } from '@main/debug';
import { reportError } from '@main/report/githubReporter';
import { settingsStore } from '@main/store/settings';
import { refuseUntrusted } from '@main/ipc/handlers';
import { IPC, type UpdaterState } from '@shared/ipc';

const { autoUpdater } = pkg;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

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
    win.webContents.send(IPC.UPDATER_STATE, state);
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

  // Supply-chain hardening (issue #11): the build is unsigned on both
  // macOS (identity: null) and Windows (signtoolOptions: null), so anyone
  // who gains push access to the GitHub release could ship arbitrary code
  // to existing users on next launch. autoDownload stays OFF so a check
  // never pulls a binary on its own — `update-available` only broadcasts
  // to the renderer, which surfaces an explicit "Update now" button. The
  // download is started solely by the UPDATER_DOWNLOAD IPC, i.e. only on
  // a deliberate user click.
  //
  // autoInstallOnAppQuit MUST also stay false so a downloaded update is
  // never silently installed during a graceful quit — every install goes
  // through the explicit UPDATER_RESTART action.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Route update lifecycle events to the project debug() helper instead
  // of swallowing them via `logger = null`. Update events are security-
  // relevant (download started, signature mismatch) and should be
  // visible in any debug capture session (issue #11 / L7).
  autoUpdater.logger = {
    info: (msg: unknown) => debug('DICTATION', `[updater] ${String(msg)}`),
    warn: (msg: unknown) => process.stderr.write(`[updater] WARN ${String(msg)}\n`),
    error: (msg: unknown) => process.stderr.write(`[updater] ERROR ${String(msg)}\n`),
    debug: (msg: unknown) => debug('DICTATION', `[updater] ${String(msg)}`)
  };

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
  autoUpdater.on('error', (err: Error) => {
    reportError('updater', err.message);
    broadcast({ phase: 'error', message: err.message });
  });

  ipcMain.handle(IPC.UPDATER_CHECK, async (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ phase: 'error', message: msg });
    }
    return lastState;
  });

  ipcMain.handle(IPC.UPDATER_DOWNLOAD, async (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    // Only reachable from the trusted settings window, and only after an
    // `update-available` broadcast — i.e. a deliberate "Update now" click.
    try {
      broadcast({ phase: 'downloading', percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ phase: 'error', message: msg });
    }
    return lastState;
  });

  ipcMain.handle(IPC.UPDATER_RESTART, (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
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
  ipcMain.handle(IPC.UPDATER_LAST_STATE, (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    return lastState;
  });

  // Optional kickoff at startup if user opted in.
  if (settingsStore.get().ui.autoUpdate) {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `auto-update startup check failed: ${msg}`);
    });
  }

  // WindVoice typically stays resident for days, so a startup-only check
  // would miss any release published while it runs. Re-check periodically;
  // the setting is read on every tick so toggling it applies immediately.
  // Still notify-only: download/install remain explicit user clicks.
  const periodic = setInterval(() => {
    if (!settingsStore.get().ui.autoUpdate) return;
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `auto-update periodic check failed: ${msg}`);
    });
  }, UPDATE_CHECK_INTERVAL_MS);
  if (typeof periodic.unref === 'function') periodic.unref();
}
