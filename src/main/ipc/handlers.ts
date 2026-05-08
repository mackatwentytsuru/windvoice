import { ipcMain, clipboard, BrowserWindow } from 'electron';
import { IPC, SettingsSchema, type Settings, type HistoryEntry } from '@shared/types';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { historyStore } from '@main/store/history';

interface ManualTriggers {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  getLastAudioError: () => string | null;
  onApiKeyChanged: () => Promise<void> | void;
  onSettingsChanged: (next: Settings, prev: Settings) => void;
}

export function registerIpc(triggers: ManualTriggers): void {
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => settingsStore.get());
  ipcMain.handle(IPC.SETTINGS_SET, (_e, partial: Partial<Settings>): Settings => {
    const parsed = SettingsSchema.partial().parse(partial);
    const prev = settingsStore.get();
    const next = settingsStore.set(parsed);
    triggers.onSettingsChanged(next, prev);
    // Broadcast to all renderer windows so they can react to language /
    // overlay-toggle / etc. changes without polling status.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.SETTINGS_CHANGED, next);
    }
    return next;
  });

  ipcMain.handle(IPC.APIKEY_HAS, (): Promise<boolean> => secureStore.hasApiKey());
  ipcMain.handle(IPC.APIKEY_SET, async (_e, value: string): Promise<void> => {
    await secureStore.setApiKey(value);
    try {
      await triggers.onApiKeyChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[apikey] post-save hook failed: ${msg}\n`);
    }
  });

  ipcMain.handle(IPC.DICTATION_START, async () => {
    await triggers.start();
  });
  ipcMain.handle(IPC.DICTATION_STOP, async () => {
    await triggers.stop();
  });
  ipcMain.handle(IPC.AUDIO_LAST_ERROR, (): string | null => triggers.getLastAudioError());

  ipcMain.handle(IPC.HISTORY_LIST, (): HistoryEntry[] => historyStore.list());
  ipcMain.handle(IPC.HISTORY_REMOVE, (_e, id: string): HistoryEntry[] => {
    historyStore.remove(id);
    return historyStore.list();
  });
  ipcMain.handle(IPC.HISTORY_CLEAR, (): HistoryEntry[] => {
    historyStore.clear();
    return historyStore.list();
  });

  ipcMain.handle(IPC.CLIPBOARD_WRITE, (_e, text: string): void => {
    if (typeof text !== 'string') return;
    if (text.length > 50_000) return;
    clipboard.writeText(text);
  });
}
