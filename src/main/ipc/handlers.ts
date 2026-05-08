import { ipcMain, clipboard, BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC, SettingsSchema, type Settings, type HistoryEntry } from '@shared/types';
import { settingsStore } from '@main/store/settings';
import { secureStore, SecureStoreUnavailableError } from '@main/store/secure';
import { historyStore } from '@main/store/history';

interface ManualTriggers {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  getLastAudioError: () => string | null;
  onApiKeyChanged: () => Promise<void> | void;
  onSettingsChanged: (next: Settings, prev: Settings) => void;
}

type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

const HistoryRemoveSchema = z.object({ id: z.string().min(1).max(128) });
const ApiKeySchema = z.string().min(10).max(512);
const ClipboardWriteMaxBytes = 1_000_000;

let trustedSettingsSenderId: number | null = null;

export function setTrustedSettingsSender(id: number | null): void {
  trustedSettingsSenderId = id;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerIpc(triggers: ManualTriggers): void {
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => settingsStore.get());

  ipcMain.handle(
    IPC.SETTINGS_SET,
    (_e, partial: unknown): IpcResult<Settings> | Settings => {
      try {
        const parsed = SettingsSchema.partial().parse(partial);
        const prev = settingsStore.get();
        const next = settingsStore.set(parsed);
        try {
          triggers.onSettingsChanged(next, prev);
        } catch (err) {
          process.stderr.write(`[settings] onSettingsChanged threw: ${errMsg(err)}\n`);
        }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.SETTINGS_CHANGED, next);
        }
        return next;
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.APIKEY_HAS,
    async (): Promise<boolean> => {
      try {
        return await secureStore.hasApiKey();
      } catch (err) {
        process.stderr.write(`[apikey] has failed: ${errMsg(err)}\n`);
        return false;
      }
    }
  );

  ipcMain.handle(
    IPC.APIKEY_SET,
    async (event, value: unknown): Promise<IpcResult<true>> => {
      if (
        trustedSettingsSenderId !== null &&
        event.sender.id !== trustedSettingsSenderId
      ) {
        return { ok: false, error: 'untrusted sender', code: 'E_UNTRUSTED' };
      }
      let parsed: string;
      try {
        parsed = ApiKeySchema.parse(value);
      } catch (err) {
        return { ok: false, error: errMsg(err), code: 'E_INVALID' };
      }
      try {
        await secureStore.setApiKey(parsed);
      } catch (err) {
        const code = err instanceof SecureStoreUnavailableError ? err.code : 'E_SECURE_STORE';
        return { ok: false, error: errMsg(err), code };
      }
      try {
        await triggers.onApiKeyChanged();
      } catch (err) {
        process.stderr.write(`[apikey] post-save hook failed: ${errMsg(err)}\n`);
      }
      return { ok: true, value: true };
    }
  );

  ipcMain.handle(IPC.DICTATION_START, async (): Promise<IpcResult<true>> => {
    try {
      await triggers.start();
      return { ok: true, value: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(IPC.DICTATION_STOP, async (): Promise<IpcResult<true>> => {
    try {
      await triggers.stop();
      return { ok: true, value: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(IPC.AUDIO_LAST_ERROR, (): string | null => triggers.getLastAudioError());

  ipcMain.handle(IPC.HISTORY_LIST, (): HistoryEntry[] => historyStore.list());

  ipcMain.handle(
    IPC.HISTORY_REMOVE,
    (_e, payload: unknown): HistoryEntry[] | IpcResult<HistoryEntry[]> => {
      try {
        const id =
          typeof payload === 'string'
            ? HistoryRemoveSchema.parse({ id: payload }).id
            : HistoryRemoveSchema.parse(payload).id;
        historyStore.remove(id);
        return historyStore.list();
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    }
  );

  ipcMain.handle(IPC.HISTORY_CLEAR, (): HistoryEntry[] => {
    historyStore.clear();
    return historyStore.list();
  });

  ipcMain.handle(
    IPC.CLIPBOARD_WRITE,
    (_e, text: unknown): IpcResult<true> => {
      if (typeof text !== 'string') {
        return { ok: false, error: 'expected string payload', code: 'E_INVALID' };
      }
      if (text.length > ClipboardWriteMaxBytes) {
        return { ok: false, error: 'payload too large', code: 'E_TOO_LARGE' };
      }
      try {
        clipboard.writeText(text);
        return { ok: true, value: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    }
  );
}
