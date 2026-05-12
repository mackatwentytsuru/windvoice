import { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { HotkeyManager, setActiveHotkeyManager } from '@main/hotkey/manager';
import { AudioBridge } from '@main/audio/bridge';
import { OverlayWindow } from '@main/overlay/window';
import { DictationOrchestrator } from '@main/dictation/orchestrator';
import { createTray, setStatus, refreshTrayLanguage, onStatusChanged, setAccessibilityWarning } from '@main/tray';
import { registerIpc, setTrustedSettingsSender } from '@main/ipc/handlers';
import { postProcessorPipeline } from '@main/postprocess/pipeline';
import { gptFormatter } from '@main/postprocess/formatter';
import { replacementsProcessor } from '@main/postprocess/replacements';
import { fileTagsProcessor } from '@main/postprocess/fileTags';
import { initAutoUpdater, onCheckDictationActive, notifyDictationIdle } from '@main/updater';
import { applyAutoLaunch, onAutoLaunchError } from '@main/autoLaunch';
import { onDuckError } from '@main/audio/duck';
import { recoverClipboardIfPending } from '@main/inject/typer';
import { flushHistory } from '@main/store/history';
import { IPC } from '@shared/types';
import { t } from '@shared/i18n';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

let settingsWindow: BrowserWindow | null = null;
let audio: AudioBridge | null = null;
let overlay: OverlayWindow | null = null;
let hotkeys: HotkeyManager | null = null;
let orchestrator: DictationOrchestrator | null = null;
let lastAudioError: string | null = null;

/**
 * webContents IDs that are allowed to receive a `media` (microphone) grant.
 * Lazily populated as windows are created. The overlay window is NEVER added
 * because it has no business calling getUserMedia.
 */
const trustedMicIds = new Set<number>();

async function createSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 660,
    show: false,
    backgroundColor: '#101216',
    title: 'WindVoice',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow = win;
  // Settings page calls getUserMedia to enumerate microphones with labels.
  trustedMicIds.add(win.webContents.id);
  // Restrict privileged IPCs (APIKEY_SET, CLIPBOARD_WRITE) to this sender.
  setTrustedSettingsSender(win.webContents.id);

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (settingsWindow) trustedMicIds.delete(settingsWindow.webContents.id);
    settingsWindow = null;
    setTrustedSettingsSender(null);
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

let accessibilityPollTimer: NodeJS.Timeout | null = null;

function startHotkeysWithAccessibilityRecovery(): void {
  if (!hotkeys) return;
  try {
    hotkeys.start();
    setAccessibilityWarning(false);
    if (accessibilityPollTimer) {
      clearInterval(accessibilityPollTimer);
      accessibilityPollTimer = null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[hotkey] start failed (likely missing Accessibility permission): ${message}\n`
    );
    if (process.platform !== 'darwin') return;
    setAccessibilityWarning(true);
    if (accessibilityPollTimer) return;
    accessibilityPollTimer = setInterval(() => {
      try {
        if (systemPreferences.isTrustedAccessibilityClient(false)) {
          startHotkeysWithAccessibilityRecovery();
        }
      } catch {
        /* ignore */
      }
    }, 2000);
  }
}

async function ensureApiKey(): Promise<void> {
  if (await secureStore.hasApiKey()) return;
  const lang = settingsStore.get().ui.uiLanguage;
  await dialog.showMessageBox({
    type: 'info',
    title: t('dialog.firstRun.title', lang),
    message: t('dialog.firstRun.message', lang),
    detail: t('dialog.firstRun.detail', lang),
    buttons: [t('dialog.firstRun.button', lang)]
  });
  await createSettingsWindow();
}

app.whenReady().then(async () => {
  // macOS: hide the Dock icon — WindVoice is a tray-only app.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // macOS: trigger the OS Accessibility prompt the first time so global hotkeys
  // and synthesized paste actually work. `prompt: true` displays the system
  // dialog if not yet trusted; subsequent launches return immediately.
  if (process.platform === 'darwin') {
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch {
      /* dev/non-macOS Electron builds may not expose this */
    }
  }

  // Restore clipboard if a prior session crashed mid-paste.
  recoverClipboardIfPending();

  // Register IPC handlers BEFORE any BrowserWindow is created. The hidden audio
  // renderer, the overlay window, and the settings window all run preload code
  // that immediately calls `ipcRenderer.invoke('settings:get')`; if the handler
  // is not yet registered the call rejects with "No handler registered for
  // 'settings:get'" and the UI fails to load its initial state.
  registerIpc({
    start: () => orchestrator?.start() ?? Promise.resolve(),
    stop: () => orchestrator?.stop() ?? Promise.resolve(),
    getLastAudioError: () => lastAudioError,
    onApiKeyChanged: async () => {
      await orchestrator?.prewarmConnection();
    },
    onSettingsChanged: (next, prev) => {
      if (next.audio.device !== prev.audio.device) {
        audio?.changeDevice(next.audio.device);
      }
      if (next.hotkeys !== prev.hotkeys) {
        hotkeys?.setBindings(next.hotkeys);
      }
      if (!next.ui.overlayEnabled) {
        overlay?.setEnabled(false);
      }
      if (next.ui.uiLanguage !== prev.ui.uiLanguage) {
        refreshTrayLanguage();
      }
      if (next.ui.autoLaunch !== prev.ui.autoLaunch) {
        applyAutoLaunch(next.ui.autoLaunch);
      }
    }
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(trustedMicIds.has(wc.id));
    callback(false);
  });

  ipcMain.on(IPC.AUDIO_ERROR, (e, message: string) => {
    // Only accept from the trusted hidden audio renderer.
    const audioWcId = audio?.getWebContentsId();
    if (audioWcId !== null && audioWcId !== undefined && e.sender.id !== audioWcId) {
      return;
    }
    if (typeof message !== 'string') return;
    lastAudioError = message;
    process.stderr.write(`[audio] ${message}\n`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.AUDIO_ERROR, message);
    }
  });

  createTray({
    openSettings: () => void createSettingsWindow(),
    quit: () => {
      app.quit();
    },
    openAccessibility:
      process.platform === 'darwin'
        ? () => {
            void shell.openExternal(
              'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            );
          }
        : undefined
  });
  setStatus('idle');

  audio = new AudioBridge();
  await audio.init(PRELOAD_PATH);
  const audioWcId = audio.getWebContentsId();
  if (audioWcId !== null) trustedMicIds.add(audioWcId);

  // Register post-processors. Order matters: formatter first (cleans
  // hallucinations + applies dictionary via prompt), then deterministic
  // local steps (replacements, file tags).
  postProcessorPipeline.register(gptFormatter);
  postProcessorPipeline.register(replacementsProcessor);
  postProcessorPipeline.register(fileTagsProcessor);

  overlay = new OverlayWindow();
  await overlay.init(PRELOAD_PATH);
  // Audio level updates flow: audio renderer → main → overlay window
  audio.setLevelListener((level) => overlay?.setLevel(level));

  orchestrator = new DictationOrchestrator(audio, overlay);

  hotkeys = new HotkeyManager();
  setActiveHotkeyManager(hotkeys);
  hotkeys.setBindings(settingsStore.get().hotkeys);
  hotkeys.on('start', () => {
    void orchestrator?.start().catch((err) => process.stderr.write(`[hotkey] start: ${err}\n`));
  });
  hotkeys.on('stop', () => {
    void orchestrator?.stop().catch((err) => process.stderr.write(`[hotkey] stop: ${err}\n`));
  });

  // Start global hotkey hook. uIOhook.start() throws on macOS when Accessibility
  // permission has not been granted; we recover by polling permissions and
  // retrying once the user grants access, plus a tray menu item that opens the
  // relevant System Settings pane.
  startHotkeysWithAccessibilityRecovery();

  await audio.prewarm(settingsStore.get().audio.device);

  if (await secureStore.hasApiKey()) {
    void orchestrator.prewarmConnection();
  }

  // Surface duck / auto-launch errors to stderr (visible in dev console).
  // A future iteration could also show a tray balloon; keep simple for now.
  onDuckError((phase, message) => process.stderr.write(`[duck:${phase}] ${message}\n`));
  onAutoLaunchError((message) => process.stderr.write(`[autoLaunch] ${message}\n`));

  applyAutoLaunch(settingsStore.get().ui.autoLaunch);

  // Defer auto-update install while a dictation cycle is in flight.
  onCheckDictationActive(() => orchestrator?.isActive() ?? false);
  onStatusChanged((status) => {
    if (status === 'idle') notifyDictationIdle();
  });
  initAutoUpdater();

  await ensureApiKey();
});

app.on('window-all-closed', () => {
  /* stay alive in tray */
});

app.on('before-quit', () => {
  hotkeys?.stop();
  orchestrator?.dispose();
  audio?.destroy();
  overlay?.destroy();
  flushHistory();
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[unhandledRejection] ${reason}\n`);
});
