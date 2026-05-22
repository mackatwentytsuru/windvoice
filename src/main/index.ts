import { app, BrowserWindow, dialog, session, shell, systemPreferences } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { HotkeyManager, setActiveHotkeyManager } from '@main/hotkey/manager';
import { FnWatcher, FN_KEYCODE } from '@main/hotkey/fnwatcher';
import { AudioBridge } from '@main/audio/bridge';
import { OverlayWindow } from '@main/overlay/window';
import { DictationOrchestrator } from '@main/dictation/orchestrator';
import { createTray, setStatus, refreshTrayLanguage, onStatusChanged, setAccessibilityWarning } from '@main/tray';
import { registerIpc, setTrustedSettingsSender } from '@main/ipc/handlers';
import { postProcessorPipeline } from '@main/postprocess/pipeline';
import {
  gptFormatter,
  resetFormatterFailure,
  setFormatterFailureListener
} from '@main/postprocess/formatter';
import { replacementsProcessor } from '@main/postprocess/replacements';
import { fileTagsProcessor } from '@main/postprocess/fileTags';
import { initAutoUpdater, onCheckDictationActive, notifyDictationIdle } from '@main/updater';
import { applyAutoLaunch, onAutoLaunchError } from '@main/autoLaunch';
import { onDuckError } from '@main/audio/duck';
import { recoverClipboardIfPending, setPasteFailureListener } from '@main/inject/typer';
import { flushHistory } from '@main/store/history';
import { IPC } from '@shared/types';
import { t } from '@shared/i18n';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

/**
 * Issue #46: guard `shell.openExternal` behind a small, explicit scheme
 * allowlist. Today the single call site uses a compile-time-known
 * `x-apple.systempreferences:` URL, so this is purely defense-in-depth:
 * any future code path that pipes a user/network-derived URL into this
 * helper (e.g. a deep-link from settings, an HTTP redirect target) is
 * limited to schemes we have explicitly vetted. Anything else logs a
 * warning to stderr and returns without invoking the shell — preventing
 * abuse of openExternal to launch arbitrary handlers (file:, vbscript:,
 * smb:, etc.).
 */
const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'x-apple.systempreferences:',
  'https:',
  'mailto:'
]);

async function openExternalSafe(url: string): Promise<void> {
  const lower = url.toLowerCase();
  let allowed = false;
  for (const scheme of ALLOWED_EXTERNAL_SCHEMES) {
    if (lower.startsWith(scheme)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    process.stderr.write(`[security] openExternal blocked disallowed scheme: ${url}\n`);
    return;
  }
  try {
    await shell.openExternal(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[security] openExternal failed: ${message}\n`);
  }
}

let settingsWindow: BrowserWindow | null = null;
let audio: AudioBridge | null = null;
let overlay: OverlayWindow | null = null;
let hotkeys: HotkeyManager | null = null;
let fnWatcher: FnWatcher | null = null;
let orchestrator: DictationOrchestrator | null = null;
let lastAudioError: string | null = null;

/**
 * Broadcast an IPC message to every UI BrowserWindow, skipping the hidden
 * audio renderer (which has no business receiving UI-state events and can
 * also be torn down/recreated independently of the windows). If `audio` is
 * not yet initialized at the time of the call, fall back to broadcasting to
 * all windows — acceptable degradation since the audio renderer simply
 * ignores channels it has not subscribed to.
 */
function broadcastToUiWindows(channel: string, payload: unknown): void {
  const audioWcId = audio?.getWebContentsId();
  for (const win of BrowserWindow.getAllWindows()) {
    if (audioWcId !== null && audioWcId !== undefined && win.webContents.id === audioWcId) {
      continue;
    }
    win.webContents.send(channel, payload);
  }
}

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
    let consecutiveErrors = 0;
    accessibilityPollTimer = setInterval(() => {
      try {
        if (systemPreferences.isTrustedAccessibilityClient(false)) {
          startHotkeysWithAccessibilityRecovery();
        }
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 10) {
          if (accessibilityPollTimer) {
            clearInterval(accessibilityPollTimer);
            accessibilityPollTimer = null;
          }
          process.stderr.write(
            '[hotkey] accessibility recovery poll disabled after 10 consecutive errors — re-grant Accessibility permission and restart WindVoice\n'
          );
        }
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

// Single-instance guard. WindVoice is a tray app started at login; a
// double-click on the shortcut — or the OS auto-start firing while a copy
// is already running — must not spin up a duplicate process. A second
// process would install its own global hotkey hook and a second tray
// icon. The first instance holds the lock; any later launch fails the
// lock, asks the primary to surface its settings window via the
// 'second-instance' event, and quits immediately.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void createSettingsWindow();
  });
}

app.whenReady().then(async () => {
  // A losing second instance can still reach here briefly before its
  // app.quit() settles — bail so it never touches the tray, hotkeys,
  // audio devices, or the clipboard-recovery file.
  if (!gotInstanceLock) return;

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

  // Defense-in-depth Content-Security-Policy for all renderer responses
  // (issue #29). The hidden audio renderer runs with `sandbox: false` for
  // AudioWorklet+blob compatibility, so a CSP is the next strongest barrier
  // if a renderer is ever subverted. The realtime WebSocket runs in the
  // main process, so `connect-src 'self'` is sufficient for renderer code.
  // `blob:` worker-src and media-src are required by the AudioWorklet path.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    // `script-src` must include `blob:` because the hidden audio renderer
    // creates the AudioWorklet module via `URL.createObjectURL(blob)` and
    // Chromium evaluates worklet modules under script-src in addition to
    // worker-src. Without blob: here, addModule rejects with
    // `AbortError: Unable to load a worklet's module` and the dictation
    // path fails before the first chunk.
    responseHeaders['Content-Security-Policy'] = [
      "default-src 'self'; " +
        "script-src 'self' blob:; " +
        "style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "img-src 'self' data:; " +
        "media-src 'self' blob:; " +
        "worker-src blob:"
    ];
    callback({ responseHeaders });
  });

  // Restore clipboard if a prior session crashed mid-paste.
  recoverClipboardIfPending();

  // Wire up formatter failure surfacing: tray flashes error, settings
  // UI gets an IPC event with a code so it can render an inline message.
  setFormatterFailureListener((code, message) => {
    setStatus('error');
    broadcastToUiWindows(IPC.FORMATTER_ERROR, { code, message, permanent: true });
  });

  // Surface paste failures (H6/M11) — the user has a working transcript
  // but it never landed in their target app, AND there is now no signal
  // to that fact without this event.
  setPasteFailureListener((message) => {
    setStatus('error');
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'paste', message });
  });

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
      // Clear any sticky formatter failure (bad-key / model-not-found):
      // the user just rotated the key, retry on the next dictation.
      resetFormatterFailure();
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

  createTray({
    openSettings: () => void createSettingsWindow(),
    quit: () => {
      app.quit();
    },
    openAccessibility:
      process.platform === 'darwin'
        ? () => {
            void openExternalSafe(
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
  // Consolidated audio-error path. The bridge already validates the sender
  // against its owned webContents id before invoking this callback, so we
  // no longer need a parallel `ipcMain.on(AUDIO_ERROR, ...)` listener
  // (which could otherwise be reached by any renderer before `audio` was
  // initialized — issue #22).
  audio.setErrorListener((message) => {
    lastAudioError = message;
    process.stderr.write(`[audio] ${message}\n`);
    broadcastToUiWindows(IPC.AUDIO_ERROR, message);
  });

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

  // macOS-only: spawn the Fn (Globe) key sidecar. uiohook does not surface
  // Fn — it lives on a `kCGEventFlagsChanged` path that libuiohook's macOS
  // handler explicitly ignores (only Shift/Ctrl/Option/Cmd are wired). The
  // fnwatcher sidecar taps CGEventTap directly and pipes FN_DOWN / FN_UP
  // lines back to us, which we then inject into HotkeyManager as if they
  // were uiohook events.
  if (process.platform === 'darwin') {
    fnWatcher = new FnWatcher();
    fnWatcher.on('down', () => hotkeys?.injectKey(FN_KEYCODE, true));
    fnWatcher.on('up', () => hotkeys?.injectKey(FN_KEYCODE, false));
    fnWatcher.on('error', (msg) => process.stderr.write(`[fnwatcher] ${msg}\n`));
    fnWatcher.start();
  }

  await audio.prewarm(settingsStore.get().audio.device);

  if (await secureStore.hasApiKey()) {
    void orchestrator.prewarmConnection();
  }

  // Surface duck / auto-launch errors to stderr (visible in dev console).
  // A future iteration could also show a tray balloon; keep simple for now.
  // Forward background errors to the Settings UI so they don't vanish
  // into stderr (which is invisible in packaged builds — M10).
  onDuckError((phase, message) => {
    process.stderr.write(`[duck:${phase}] ${message}\n`);
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'duck', message: `${phase}: ${message}` });
  });
  onAutoLaunchError((message) => {
    process.stderr.write(`[autoLaunch] ${message}\n`);
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'autoLaunch', message });
  });

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
  // Clear the accessibility-recovery poll first — otherwise the
  // interval can fire after the tray has been destroyed and call
  // systemPreferences.isTrustedAccessibilityClient on a teardown-
  // state app (issue H3).
  if (accessibilityPollTimer) {
    clearInterval(accessibilityPollTimer);
    accessibilityPollTimer = null;
  }
  hotkeys?.stop();
  fnWatcher?.stop();
  orchestrator?.dispose();
  audio?.destroy();
  overlay?.destroy();
  flushHistory();
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[unhandledRejection] ${reason}\n`);
});
