import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { HotkeyManager } from '@main/hotkey/manager';
import { AudioBridge } from '@main/audio/bridge';
import { DictationOrchestrator } from '@main/dictation/orchestrator';
import { createTray, setStatus } from '@main/tray';
import { registerIpc } from '@main/ipc/handlers';
import { IPC } from '@shared/types';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

let settingsWindow: BrowserWindow | null = null;
let audio: AudioBridge | null = null;
let hotkeys: HotkeyManager | null = null;
let orchestrator: DictationOrchestrator | null = null;
let lastAudioError: string | null = null;

async function createSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  const win = new BrowserWindow({
    width: 720,
    height: 600,
    show: false,
    backgroundColor: '#101216',
    title: 'WindVoice',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  settingsWindow = win;

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
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
  await dialog.showMessageBox({
    type: 'info',
    title: 'WindVoice — first run',
    message: 'No OpenAI API key configured.',
    detail:
      'Open the settings window, paste your OpenAI API key in the API Key field, and save.\n\nThe key is stored in the Windows Credential Manager (via keytar).',
    buttons: ['Open Settings']
  });
  await createSettingsWindow();
}

app.whenReady().then(async () => {
  // Auto-grant microphone permission for our own renderers.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') return callback(true);
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

  orchestrator = new DictationOrchestrator(audio);

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
    onApiKeyChanged: () => {
      // Re-establish the WS with the new key on demand.
      orchestrator?.prewarmConnection();
    }
  });

  // Start the mic + AudioWorklet now so the first hotkey press is instant.
  audio.prewarm().catch((err) => process.stderr.write(`[audio] prewarm: ${err}\n`));

  // Pre-connect to OpenAI if we already have an API key — eliminates the
  // TLS-handshake latency on the first dictation, which is what causes the
  // "WebSocket was closed before connection was established" race when the
  // user hits and releases the hotkey faster than the connection can open.
  if (await secureStore.hasApiKey()) {
    void orchestrator.prewarmConnection();
  }

  await ensureApiKey();
});

app.on('window-all-closed', () => {
  // Stay alive in tray; do nothing.
});

app.on('before-quit', () => {
  hotkeys?.stop();
  audio?.destroy();
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[unhandledRejection] ${reason}\n`);
});
