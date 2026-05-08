import { ipcMain, clipboard } from 'electron';
import { IPC, SettingsSchema, type Settings, type HistoryEntry } from '@shared/types';
import { settingsStore } from '@main/store/settings';
import { secureStore } from '@main/store/secure';
import { historyStore } from '@main/store/history';

interface ManualTriggers {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  getLastAudioError: () => string | null;
  onApiKeyChanged: () => void;
  onSettingsChanged: (next: Settings, prev: Settings) => void;
}

export function registerIpc(triggers: ManualTriggers): void {
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => settingsStore.get());
  ipcMain.handle(IPC.SETTINGS_SET, (_e, partial: Partial<Settings>): Settings => {
    const parsed = SettingsSchema.partial().parse(partial);
    const prev = settingsStore.get();
    const next = settingsStore.set(parsed);
    triggers.onSettingsChanged(next, prev);
    return next;
  });

  ipcMain.handle(IPC.APIKEY_HAS, (): Promise<boolean> => secureStore.hasApiKey());
  ipcMain.handle(IPC.APIKEY_SET, async (_e, value: string): Promise<void> => {
    await secureStore.setApiKey(value);
    triggers.onApiKeyChanged();
  });

  ipcMain.handle(IPC.DICTATION_START, async () => {
    await triggers.start();
  });
  ipcMain.handle(IPC.DICTATION_STOP, async () => {
    await triggers.stop();
  });
  ipcMain.handle('audio:lastError', (): string | null => triggers.getLastAudioError());

  ipcMain.handle(IPC.HISTORY_LIST, (): HistoryEntry[] => historyStore.list());
  ipcMain.handle(IPC.HISTORY_REMOVE, (_e, id: string): HistoryEntry[] => {
    historyStore.remove(id);
    return historyStore.list();
  });
  ipcMain.handle(IPC.HISTORY_CLEAR, (): HistoryEntry[] => {
    historyStore.clear();
    return historyStore.list();
  });

  ipcMain.handle('clipboard:write', (_e, text: string): void => {
    clipboard.writeText(text);
  });
}
