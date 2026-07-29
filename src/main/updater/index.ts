// Resident-app update flow via electron-updater. Checks stay automatic when
// enabled, while every download starts from an explicit notification, tray,
// or Settings-window action.

import path from 'node:path';
import { BrowserWindow, Notification, app, ipcMain, net } from 'electron';
import pkg from 'electron-updater';
import { debug } from '@main/debug';
import { refuseUntrusted } from '@main/ipc/handlers';
import { settingsStore } from '@main/store/settings';
import { setUpdaterTrayState, type UpdaterTrayActions } from '@main/tray';
import { openExternalSafe } from '@main/util/openExternal';
import { IPC, type UpdateDelivery, type UpdaterState } from '@shared/ipc';

const { autoUpdater } = pkg;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RELEASES_BASE_URL = 'https://github.com/mackatwentytsuru/windvoice/releases';
const LATEST_RELEASE_API =
  'https://api.github.com/repos/mackatwentytsuru/windvoice/releases/latest';

function currentVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

let lastState: UpdaterState = { phase: 'idle', currentVersion: currentVersion() };
let initialized = false;
let pendingInstall: { version: string } | null = null;
let dictationActiveCheck: (() => boolean) | null = null;
let targetVersion: string | null = null;
let targetReleaseName: string | undefined;
let targetDelivery: UpdateDelivery = 'self-update';
let downloadInFlight = false;

/**
 * The AppImage runtime sets APPIMAGE to the absolute path of the original
 * image. electron-updater itself relies on that variable to replace it.
 * A deb install (normally /opt/WindVoice/...) and extract-and-run/unknown
 * Linux launches have no trustworthy replacement target, so they are manual.
 */
export function detectUpdateDelivery(
  platform: NodeJS.Platform | string,
  appImage: string | undefined,
  _exePath: string
): UpdateDelivery {
  if (platform !== 'linux') return 'self-update';
  if (
    typeof appImage === 'string' &&
    path.isAbsolute(appImage) &&
    /\.appimage$/i.test(appImage)
  ) {
    return 'self-update';
  }
  return 'manual';
}

export function isMissingPlatformFeed(message: string): boolean {
  return /cannot find latest[\w.-]*\.yml/i.test(message) && /404/.test(message);
}

function releasePageUrl(version: string | null): string {
  if (!version) return RELEASES_BASE_URL;
  return `${RELEASES_BASE_URL}/tag/v${encodeURIComponent(version)}`;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function deliveryForThisInstall(): UpdateDelivery {
  return detectUpdateDelivery(process.platform, process.env['APPIMAGE'], app.getPath('exe'));
}

export function onCheckDictationActive(cb: () => boolean): void {
  dictationActiveCheck = cb;
}

export function notifyDictationIdle(): void {
  if (pendingInstall) {
    pendingInstall = null;
    autoUpdater.quitAndInstall(false, true);
  }
}

const trayActions: UpdaterTrayActions = {
  download: () => {
    void startAvailableAction();
  },
  restart: () => {
    requestRestart();
  },
  retry: () => {
    void retryLastAction();
  },
  openRelease: () => {
    void openExternalSafe(releasePageUrl(targetVersion));
  }
};

function withCurrentVersion(state: UpdaterState): UpdaterState {
  return { ...state, currentVersion: currentVersion() } as UpdaterState;
}

function broadcast(state: UpdaterState): void {
  lastState = withCurrentVersion(state);
  setUpdaterTrayState(lastState, trayActions);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.UPDATER_STATE, lastState);
  }
}

function persistNotifiedVersion(
  field: 'notifiedUpdateVersion' | 'notifiedDownloadedVersion',
  version: string
): void {
  const settings = settingsStore.get();
  if (settings.ui[field] === version) return;
  settingsStore.set({ ui: { ...settings.ui, [field]: version } });
}

function notifyAvailable(version: string, releaseName?: string): void {
  const settings = settingsStore.get();
  if (settings.ui.notifiedUpdateVersion === version) return;
  // Persist before displaying so a crash after show() cannot create a
  // notification loop on every resident-app restart.
  persistNotifiedVersion('notifiedUpdateVersion', version);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `WindVoice ${version} が利用できます`,
    body: releaseName?.trim() || 'クリックして更新を開始します'
  });
  notification.on('click', () => {
    void startAvailableAction();
  });
  notification.show();
}

function notifyDownloaded(version: string): void {
  const settings = settingsStore.get();
  if (settings.ui.notifiedDownloadedVersion === version) return;
  persistNotifiedVersion('notifiedDownloadedVersion', version);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `WindVoice ${version} の更新準備ができました`,
    body: 'クリックして再起動し、更新を適用します'
  });
  notification.on('click', () => requestRestart());
  notification.show();
}

async function startDownload(): Promise<void> {
  if (downloadInFlight || lastState.phase === 'downloaded') return;
  const version = targetVersion ?? currentVersion();
  downloadInFlight = true;
  try {
    broadcast({ phase: 'downloading', version, percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast({ phase: 'error', message, version, retry: 'download' });
  } finally {
    downloadInFlight = false;
  }
}

async function startAvailableAction(): Promise<void> {
  if (targetDelivery === 'manual') {
    await openExternalSafe(releasePageUrl(targetVersion));
    return;
  }
  await startDownload();
}

async function retryLastAction(): Promise<void> {
  if (lastState.phase === 'error' && lastState.retry === 'download') {
    await startAvailableAction();
    return;
  }
  try {
    await checkForUpdatesForInstall();
  } catch (err) {
    handleCheckFailure(err);
  }
}

async function checkForUpdatesForInstall(): Promise<void> {
  if (deliveryForThisInstall() === 'self-update') {
    await autoUpdater.checkForUpdates();
    return;
  }

  // electron-updater intentionally declines to check when APPIMAGE is absent.
  // For deb/unknown Linux installs, fetch release metadata only; never fetch a
  // binary. This preserves notification/tray discovery while the action opens
  // the HTTPS release page for package-manager/manual installation.
  broadcast({ phase: 'checking' });
  const response = await net.fetch(LATEST_RELEASE_API, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (response.status === 404) {
    broadcast({ phase: 'not-available' });
    return;
  }
  if (!response.ok) throw new Error(`release metadata request failed (${response.status})`);
  const raw: unknown = await response.json();
  const release = raw as { tag_name?: unknown; name?: unknown };
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const version = tag.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('latest release metadata has an invalid version');
  }
  if (compareVersions(version, currentVersion()) <= 0) {
    broadcast({ phase: 'not-available' });
    return;
  }
  targetVersion = version;
  targetReleaseName =
    typeof release.name === 'string' && release.name.trim()
      ? release.name.trim()
      : undefined;
  targetDelivery = 'manual';
  broadcast({
    phase: 'available',
    version,
    ...(targetReleaseName ? { releaseName: targetReleaseName } : {}),
    delivery: 'manual'
  });
  notifyAvailable(version, targetReleaseName);
}

function requestRestart(): { deferred: boolean } {
  if (dictationActiveCheck?.()) {
    const version =
      lastState.phase === 'downloaded' ? lastState.version : targetVersion ?? 'pending';
    pendingInstall = { version };
    debug('DICTATION', 'updater: deferring install — dictation in flight');
    return { deferred: true };
  }
  autoUpdater.quitAndInstall(false, true);
  return { deferred: false };
}

function handleCheckFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (isMissingPlatformFeed(message)) {
    broadcast({ phase: 'not-available' });
    return;
  }
  // Updater/network/feed failures are environmental or transient. They stay
  // visible and retryable but never create an automatic bug report.
  broadcast({ phase: 'error', message, version: targetVersion ?? undefined, retry: 'check' });
}

function isAutoUpdateAllowedOnPlatform(): boolean {
  if (process.platform !== 'darwin') return true;
  // Mac: auto-update only when explicitly opted in. Unsigned builds cannot
  // verify update signatures, so default to OFF.
  if (process.env['WINDVOICE_AUTOUPDATE_DARWIN'] === '1') return true;
  return process.env['WINDVOICE_SIGNED_BUILD'] === '1';
}

export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;
  // Always expose the current version to Settings, including development and
  // unsigned macOS builds where update checks themselves remain disabled.
  ipcMain.handle(IPC.UPDATER_LAST_STATE, (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    return withCurrentVersion(lastState);
  });
  if (!app.isPackaged) {
    debug('DICTATION', 'auto-update disabled (dev mode)');
    return;
  }
  if (!isAutoUpdateAllowedOnPlatform()) {
    debug('DICTATION', 'auto-update disabled (unsigned macOS build)');
    return;
  }

  // A check must never pull an unsigned binary by itself. Downloads begin
  // only after an explicit notification, tray, or Settings-window action.
  autoUpdater.autoDownload = false;
  // If a user downloaded an update but did not choose "restart now", apply
  // that already-approved payload on their next ordinary app exit.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (msg: unknown) => debug('DICTATION', `[updater] ${String(msg)}`),
    warn: (msg: unknown) => process.stderr.write(`[updater] WARN ${String(msg)}\n`),
    error: (msg: unknown) => {
      const text = String(msg);
      if (isMissingPlatformFeed(text)) {
        debug('DICTATION', '[updater] no release feed for this platform yet (404) — skipping');
        return;
      }
      process.stderr.write(`[updater] ERROR ${text}\n`);
    },
    debug: (msg: unknown) => debug('DICTATION', `[updater] ${String(msg)}`)
  };

  autoUpdater.on('checking-for-update', () => broadcast({ phase: 'checking' }));
  autoUpdater.on(
    'update-available',
    (info: { version: string; releaseName?: string | null }) => {
      targetVersion = info.version;
      targetReleaseName = info.releaseName?.trim() || undefined;
      targetDelivery = deliveryForThisInstall();
      broadcast({
        phase: 'available',
        version: info.version,
        ...(targetReleaseName ? { releaseName: targetReleaseName } : {}),
        delivery: targetDelivery
      });
      notifyAvailable(info.version, targetReleaseName);
    }
  );
  autoUpdater.on('update-not-available', () => broadcast({ phase: 'not-available' }));
  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    broadcast({
      phase: 'downloading',
      version: targetVersion ?? currentVersion(),
      percent: Math.round(progress.percent)
    });
  });
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    targetVersion = info.version;
    broadcast({ phase: 'downloaded', version: info.version });
    notifyDownloaded(info.version);
  });
  autoUpdater.on('error', handleCheckFailure);

  ipcMain.handle(IPC.UPDATER_CHECK, async (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    try {
      await checkForUpdatesForInstall();
    } catch (err) {
      handleCheckFailure(err);
    }
    return lastState;
  });

  ipcMain.handle(IPC.UPDATER_DOWNLOAD, async (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    await startAvailableAction();
    return lastState;
  });

  ipcMain.handle(IPC.UPDATER_RESTART, (event) => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    return requestRestart();
  });
  if (settingsStore.get().ui.autoUpdate) {
    checkForUpdatesForInstall().catch(handleCheckFailure);
  }

  const periodic = setInterval(() => {
    if (!settingsStore.get().ui.autoUpdate) return;
    checkForUpdatesForInstall().catch(handleCheckFailure);
  }, UPDATE_CHECK_INTERVAL_MS);
  if (typeof periodic.unref === 'function') periodic.unref();
}
