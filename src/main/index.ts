import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { HotkeyManager } from '@main/hotkey/manager';
import { AudioBridge } from '@main/audio/bridge';
import { OverlayWindow } from '@main/overlay/window';
import { DictationOrchestrator } from '@main/dictation/orchestrator';
import { createTray, setStatus, refreshTrayLanguage } from '@main/tray';
import { registerIpc } from '@main/ipc/handlers';
import { postProcessorPipeline } from '@main/postprocess/pipeline';
import { gptFormatter } from '@main/postprocess/formatter';
import { replacementsProcessor } from '@main/postprocess/replacements';
import { fileTagsProcessor } from '@main/postprocess/fileTags';
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

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (settingsWindow) trustedMicIds.delete(settingsWindow.webContents.id);
    settingsWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
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
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(trustedMicIds.has(wc.id));
    callback(false);
  });

  ipcMain.on(IPC.AUDIO_ERROR, (_e, message: string) => {
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
    }
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
  hotkeys.setBindings(settingsStore.get().hotkeys);
  hotkeys.on('start', () => {
    void orchestrator?.start().catch((err) => process.stderr.write(`[hotkey] start: ${err}\n`));
  });
  hotkeys.on('stop', () => {
    void orchestrator?.stop().catch((err) => process.stderr.write(`[hotkey] stop: ${err}\n`));
  });
  hotkeys.start();

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
    }
  });

  await audio.prewarm(settingsStore.get().audio.device);

  if (await secureStore.hasApiKey()) {
    void orchestrator.prewarmConnection();
  }

  await ensureApiKey();
});

app.on('window-all-closed', () => {
  /* stay alive in tray */
});

app.on('before-quit', () => {
  hotkeys?.stop();
  audio?.destroy();
  overlay?.destroy();
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[unhandledRejection] ${reason}\n`);
});
