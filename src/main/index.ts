import { app, BrowserWindow, dialog, powerMonitor, session, systemPreferences } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { HotkeyManager, setActiveHotkeyManager } from '@main/hotkey/manager';
import { FnWatcher, FN_KEYCODE } from '@main/hotkey/fnwatcher';
import { AudioBridge } from '@main/audio/bridge';
import { OverlayWindow } from '@main/overlay/window';
import { DictationOrchestrator } from '@main/dictation/orchestrator';
import {
  createTray,
  setStatus,
  refreshTrayLanguage,
  onStatusChanged,
  setAccessibilityWarning,
  setSetupWarning
} from '@main/tray';
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
import { pasteText, recoverClipboardIfPending, setPasteFailureListener } from '@main/inject/typer';
import { streamingTyper } from '@main/inject/streamingTyper';
import { setAudioBackpressureListener } from '@main/realtime/client';
import { flushHistory } from '@main/store/history';
import {
  broadcastToUiWindows,
  clearStickySetupError,
  replayStickySetupErrors,
  setAudioWebContentsId
} from '@main/broadcast';
import { initErrorReporter } from '@main/report/githubReporter';
import { debug } from '@main/debug';
import { isWaylandSession } from '@main/linux/wayland';
import { EvdevKeyboardMonitor } from '@main/hotkey/evdev';
import { portalSidecar } from '@main/linux/portalSidecar';
import { IPC } from '@shared/types';
import { t } from '@shared/i18n';
import { openExternalSafe } from '@main/util/openExternal';

const PRELOAD_PATH = path.join(__dirname, '../preload/index.js');

let settingsWindow: BrowserWindow | null = null;
let audio: AudioBridge | null = null;
let overlay: OverlayWindow | null = null;
let hotkeys: HotkeyManager | null = null;
let fnWatcher: FnWatcher | null = null;
let evdevMonitor: EvdevKeyboardMonitor | null = null;
let orchestrator: DictationOrchestrator | null = null;
let lastAudioError: string | null = null;
let shutdownRunning = false;
let shutdownComplete = false;

// `broadcastToUiWindows` now lives in `@main/broadcast` and is shared with
// `@main/ipc/handlers` so SETTINGS_CHANGED skips the hidden audio renderer
// too (MEDIUM-6). Audio's webContents id is registered once AudioBridge is
// up (see `setAudioWebContentsId` call below).

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
  // Cache the webContents id BEFORE the window has any chance to be
  // destroyed. By the time `closed` fires, `win.webContents` is destroyed
  // and any property access on it (including `.id`) throws "Object has
  // been destroyed", which Electron then re-raises as an Uncaught
  // Exception dialog. Caching the primitive here is the canonical fix.
  const winWebContentsId = win.webContents.id;
  // Settings page calls getUserMedia to enumerate microphones with labels.
  trustedMicIds.add(winWebContentsId);
  // Restrict privileged IPCs (APIKEY_SET, CLIPBOARD_WRITE) to this sender.
  setTrustedSettingsSender(winWebContentsId);

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    trustedMicIds.delete(winWebContentsId);
    settingsWindow = null;
    setTrustedSettingsSender(null);
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  replayStickySetupErrors(win.webContents);
  return win;
}

let accessibilityPollTimer: NodeJS.Timeout | null = null;

function startHotkeysWithAccessibilityRecovery(): void {
  if (!hotkeys) return;
  try {
    hotkeys.start();
    setAccessibilityWarning(false);
    // H-BUG2: the Fn sidecar (Swift) exit(1)s when Accessibility is denied
    // and permanently gives up after MAX_RESTARTS (~10s), with no recovery
    // path of its own. Now that uIOhook has confirmed Accessibility is
    // granted, re-arm the sidecar too so granting permission late recovers
    // Fn without a full app restart. No-op when fnWatcher is not yet created
    // (first call) or still alive.
    fnWatcher?.restart();
    if (accessibilityPollTimer) {
      clearInterval(accessibilityPollTimer);
      accessibilityPollTimer = null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug('HOTKEY', `start failed (likely missing Accessibility permission): ${message}`);
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
          debug(
            'HOTKEY',
            'accessibility recovery poll disabled after 10 consecutive errors — re-grant Accessibility permission and restart WindVoice'
          );
        }
      }
    }, 2000);
  }
}

async function ensureApiKey(): Promise<void> {
  if (await secureStore.hasApiKey()) return;
  const lang = settingsStore.get().ui.uiLanguage;
  const storageKey =
    process.platform === 'darwin'
      ? 'firstRun.apiKey.darwin'
      : process.platform === 'win32'
        ? 'firstRun.apiKey.win32'
        : 'firstRun.apiKey.linux';
  await dialog.showMessageBox({
    type: 'info',
    title: t('dialog.firstRun.title', lang),
    message: t('dialog.firstRun.message', lang),
    detail: `${t('dialog.firstRun.detail', lang)}\n\n${t(storageKey, lang)}`,
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
    broadcastToUiWindows(IPC.FORMATTER_ERROR, {
      code,
      message,
      permanent: true,
      kind: 'setup'
    });
  });

  // Surface paste failures (H6/M11) — the user has a working transcript
  // but it never landed in their target app, AND there is now no signal
  // to that fact without this event.
  setPasteFailureListener((message) => {
    setStatus('error');
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'paste', message, kind: 'transient' });
  });

  // MEDIUM-4: surface sustained audio backpressure (drops > threshold in a
  // 5s window). Until this listener existed the drops were debug-only, so
  // the user observed "the transcript missed words" with no signal that
  // the network was the cause. The realtime client cools down its own
  // notifications, so this fires at most every few seconds.
  setAudioBackpressureListener(() => {
    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'audio-backpressure',
      kind: 'transient',
      message:
        'Network is slow — audio chunks are being dropped. Some words may be missing from the transcript.'
    });
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
  // Register the audio renderer with the shared broadcaster so every
  // UI-bound event (including SETTINGS_CHANGED, MEDIUM-6) skips the
  // hidden audio renderer uniformly.
  setAudioWebContentsId(audioWcId);
  // Consolidated audio-error path. The bridge already validates the sender
  // against its owned webContents id before invoking this callback, so we
  // no longer need a parallel `ipcMain.on(AUDIO_ERROR, ...)` listener
  // (which could otherwise be reached by any renderer before `audio` was
  // initialized — issue #22).
  audio.setErrorListener((message) => {
    lastAudioError = message;
    debug('AUDIO', message);
    broadcastToUiWindows(IPC.AUDIO_ERROR, message);
  });

  // After the machine wakes from sleep, the microphone's MediaStreamTrack is
  // dead — the worklet keeps running but only silence flows, so the meter
  // freezes and dictation captures nothing until the app restarts. Rebuild
  // the capture stream on resume. `unlock-screen` covers the case where the
  // display sleeps/locks without a full system suspend.
  // The realtime WebSocket dies the same way but half-open (no FIN/RST ever
  // arrives), so it still reports open while every audio chunk piles up in
  // the send buffer and the take is silently lost (issue #54) — recycle it
  // proactively alongside the microphone.
  powerMonitor.on('resume', () => {
    debug('AUDIO', 'power resume — re-acquiring microphone');
    audio?.recapture();
    orchestrator?.recycleConnection('power resume');
  });
  powerMonitor.on('unlock-screen', () => {
    audio?.recapture();
    orchestrator?.recycleConnection('unlock-screen');
    // Wayland: mutter refuses RemoteDesktop session creation while the
    // session is locked ("Session creation inhibited"), so a sidecar that
    // launched behind a lock screen never got a session. Retry now.
    if (isWaylandSession() && !portalSidecar.isReady()) {
      debug('DICTATION', 'screen unlocked — retrying portal sidecar');
      portalSidecar.restart();
    }
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
    void orchestrator?.start().catch((err) => debug('DICTATION', `hotkey start: ${err}`));
  });
  hotkeys.on('stop', () => {
    void orchestrator?.stop().catch((err) => debug('DICTATION', `hotkey stop: ${err}`));
  });

  // Start global hotkey capture. On Wayland uiohook (X11 XRecord) cannot see
  // keys typed into Wayland-native windows, so a kernel-level evdev monitor
  // feeds the same HotkeyManager instead. Everywhere else, uIOhook.start()
  // is used; on macOS it throws when Accessibility permission has not been
  // granted and we recover by polling permissions, plus a tray menu item
  // that opens the relevant System Settings pane.
  if (isWaylandSession()) {
    evdevMonitor = new EvdevKeyboardMonitor();
    evdevMonitor.on('key', (e) => {
      hotkeys?.feedExternalKey(e.keycode, e.down, e.modifiers);
    });
    evdevMonitor.on('permission-denied', () => {
      const message =
        'Cannot read keyboard devices — the global hotkey will not work. ' +
        'Add your user to the `input` group (`sudo usermod -aG input $USER`), then log out and back in.';
      debug('HOTKEY', message);
      setSetupWarning('hotkey', true);
      broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'hotkey', message, kind: 'setup' });
    });
    evdevMonitor.on('ready', (count) => {
      debug('HOTKEY', `evdev monitor ready (${count} keyboard device(s))`);
      setSetupWarning('hotkey', false);
      clearStickySetupError('hotkey');
    });
    evdevMonitor.on('unavailable', () => {
      const message =
        'Keyboard devices became unavailable — the global hotkey is paused while WindVoice reconnects.';
      setSetupWarning('hotkey', true);
      broadcastToUiWindows(IPC.SYSTEM_ERROR, {
        source: 'hotkey',
        message,
        kind: 'transient'
      });
    });
    evdevMonitor.start();
    // Start the portal sidecar up front so the one-time consent dialog
    // appears at launch, not in the middle of the user's first dictation.
    // Silently reconnects via restore_token afterwards. The sidecar owns
    // the clipboard capability too — see linux/portalSidecar.ts for why
    // Electron's clipboard cannot be used on Wayland.
    portalSidecar.setUnavailableListener((denied) => {
      setSetupWarning('paste', true);
      broadcastToUiWindows(IPC.SYSTEM_ERROR, {
        source: 'paste',
        kind: denied ? 'setup' : 'transient',
        message: denied
          ? 'Wayland input-injection permission was denied — pasting will not work. ' +
            'Re-enable WindVoice under Settings > Apps > Remote Desktop and restart.'
          : 'Wayland paste backend unavailable (python3-gi missing, portal too old, or the screen was ' +
            'locked at launch) — pasting will only reach X11 apps until it recovers.',
      });
    });
    portalSidecar.setReadyListener(() => {
      setSetupWarning('paste', false);
      clearStickySetupError('paste');
    });
    portalSidecar.start();
  } else {
    startHotkeysWithAccessibilityRecovery();
  }

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
    fnWatcher.on('error', (msg) => debug('HOTKEY', `fnwatcher: ${msg}`));
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
    debug('DUCK', `${phase}: ${message}`);
    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'duck',
      message: `${phase}: ${message}`,
      kind: 'transient'
    });
  });
  onAutoLaunchError((message) => {
    debug('MAIN', `autoLaunch: ${message}`);
    broadcastToUiWindows(IPC.SYSTEM_ERROR, { source: 'autoLaunch', message, kind: 'setup' });
  });

  applyAutoLaunch(settingsStore.get().ui.autoLaunch);

  // Defer auto-update install while a dictation cycle is in flight.
  onCheckDictationActive(() => orchestrator?.isActive() ?? false);
  onStatusChanged((status) => {
    if (status === 'idle') notifyDictationIdle();
  });
  initAutoUpdater();
  // Consent-based GitHub error previews. No `gh` command runs until the user
  // reviews a preview and presses Send in Settings.
  initErrorReporter({
    openSettings: () => {
      void createSettingsWindow();
    },
    broadcastPending: (preview) =>
      broadcastToUiWindows(IPC.ERROR_REPORT_PENDING, preview)
  });

  await ensureApiKey();

  // Headless paste self-test (debug hook): WINDVOICE_PASTE_SELFTEST=1
  // pastes a marker string into the focused window ~6s after startup;
  // =stream drives the streaming typer with three incremental chunks.
  // Lets the full production paste path (typer → sidecar/portal → target)
  // be exercised end-to-end on a test box without a microphone or hotkey.
  const selftest = process.env['WINDVOICE_PASTE_SELFTEST'];
  if (selftest === '1') {
    setTimeout(() => {
      debug('DICTATION', 'paste self-test firing');
      void pasteText('WINDVOICE_SELFTEST_OK_424242').then(
        () => debug('DICTATION', 'paste self-test completed'),
        (err) => debug('DICTATION', `paste self-test failed: ${err}`)
      );
    }, 6000);
  } else if (selftest === 'stream') {
    setTimeout(() => {
      debug('DICTATION', 'streaming self-test firing');
      void (async () => {
        streamingTyper.begin(true, 'balanced');
        streamingTyper.append('ALPHA_');
        await new Promise((r) => setTimeout(r, 900));
        streamingTyper.append('BRAVO_');
        await new Promise((r) => setTimeout(r, 900));
        streamingTyper.append('CHARLIE_424242');
        await streamingTyper.end();
        debug('DICTATION', 'streaming self-test completed');
      })().catch((err) => debug('DICTATION', `streaming self-test failed: ${err}`));
    }, 6000);
  }
});

app.on('window-all-closed', () => {
  // WindVoice is a tray-resident dictation app: closing the Settings window
  // (or any other transient UI window) MUST NOT quit the process. The tray
  // icon, the global hotkey hook, and the persistent Realtime connection
  // all need to stay alive until the user explicitly chooses Tray → Quit.
});

app.on('before-quit', (event) => {
  // The second app.quit(), issued after the asynchronous barrier, must pass
  // through without being prevented again.
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownRunning) return;
  shutdownRunning = true;

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
  evdevMonitor?.stop();
  void (async () => {
    try {
      // The streaming session owns the user's original clipboard snapshot.
      // Keep the portal alive until its final restore has completed.
      await streamingTyper.end();
    } catch (err) {
      debug(
        'DICTATION',
        `streaming shutdown restore failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Dispose the orchestrator while AudioBridge is still alive, then stop
    // the sidecar → audio renderer → visible window in that order.
    orchestrator?.dispose();
    portalSidecar.stop();
    audio?.destroy();
    setAudioWebContentsId(null);
    overlay?.destroy();
    flushHistory();

    shutdownComplete = true;
    app.quit();
  })().catch((err) => {
    debug('MAIN', `shutdown barrier failed: ${err instanceof Error ? err.message : String(err)}`);
    shutdownComplete = true;
    app.quit();
  });
});

process.on('unhandledRejection', (reason) => {
  debug('MAIN', `unhandledRejection: ${reason}`);
});
