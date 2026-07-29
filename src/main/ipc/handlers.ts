import { ipcMain, clipboard, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, SettingsSchema, type Settings, type HistoryEntry } from '@shared/types';
import { API_KEY_MIN_LENGTH, API_KEY_MAX_LENGTH } from '@shared/apiKey';
import { settingsStore } from '@main/store/settings';
import { secureStore, SecureStoreUnavailableError, InvalidApiKeyError } from '@main/store/secure';
import { historyStore } from '@main/store/history';
import { broadcastToUiWindows } from '@main/broadcast';

interface ManualTriggers {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  quit: () => Promise<void> | void;
  getLastAudioError: () => string | null;
  onApiKeyChanged: () => Promise<void> | void;
  onSettingsChanged: (next: Settings, prev: Settings) => void;
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

const HistoryRemoveSchema = z.object({ id: z.string().min(1).max(128) });
// Length bounds come from the shared `@shared/apiKey` module so the IPC
// boundary and the keytar-backed SecureStore.setApiKey check cannot drift
// (LOW-3). Keeping them centralized also makes a future format tweak a
// single-source-of-truth edit.
// LOW-3: `.trim()` first so the schema measures the SAME trimmed value that
// SecureStore.setApiKey stores. Without it, a whitespace-padded too-short
// key passed the raw-length check here, then got trimmed + rejected deeper
// in the keyring layer — surfacing as a misleading 'E_SECURE_STORE'.
const ApiKeySchema = z.string().trim().min(API_KEY_MIN_LENGTH).max(API_KEY_MAX_LENGTH);
const ClipboardWriteMaxBytes = 1_000_000;

let trustedSettingsSenderId: number | null = null;

export function setTrustedSettingsSender(id: number | null): void {
  trustedSettingsSenderId = id;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Privileged-IPC sender check. Returns a refusal `IpcResult` when:
 *   - no Settings window is open (`trustedSettingsSenderId === null`), or
 *   - the call came from any other webContents (overlay, hidden audio
 *     renderer, or anything else that shares the preload).
 *
 * Read-only handlers (SETTINGS_GET, APIKEY_HAS, HISTORY_LIST,
 * AUDIO_LAST_ERROR) intentionally do NOT call this — every renderer needs
 * to fetch its initial state from the main process. Mutation handlers
 * (SETTINGS_SET, APIKEY_SET, DICTATION_*, HISTORY_REMOVE/CLEAR,
 * CLIPBOARD_WRITE) all gate on this.
 */
export function refuseUntrusted(event: IpcMainInvokeEvent): IpcResult<never> | null {
  if (
    trustedSettingsSenderId !== null &&
    event.sender.id === trustedSettingsSenderId
  ) {
    return null;
  }
  return { ok: false, error: 'untrusted sender', code: 'E_UNTRUSTED' };
}

export function registerIpc(triggers: ManualTriggers): void {
  ipcMain.handle(IPC.SETTINGS_GET, (): Settings => settingsStore.get());

  ipcMain.handle(
    IPC.SETTINGS_SET,
    (event, partial: unknown): IpcResult<Settings> => {
      const refusal = refuseUntrusted(event);
      if (refusal) return refusal;
      try {
        const parsed = SettingsSchema.partial().parse(partial);
        const prev = settingsStore.get();
        const next = settingsStore.set(parsed);
        try {
          triggers.onSettingsChanged(next, prev);
        } catch (err) {
          process.stderr.write(`[settings] onSettingsChanged threw: ${errMsg(err)}\n`);
        }
        // MEDIUM-6: use the shared `broadcastToUiWindows` so SETTINGS_CHANGED
        // skips the hidden audio renderer like every other UI event does.
        // The audio renderer has no settings UI; receiving the broadcast
        // was pure noise (and a forced IPC payload roundtrip on each save).
        broadcastToUiWindows(IPC.SETTINGS_CHANGED, next);
        return { ok: true, value: next };
      } catch (err) {
        return { ok: false, error: errMsg(err), code: 'E_INVALID' };
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
      const refusal = refuseUntrusted(event);
      if (refusal) return refusal;
      let parsed: string;
      try {
        parsed = ApiKeySchema.parse(value);
      } catch (err) {
        return { ok: false, error: errMsg(err), code: 'E_INVALID' };
      }
      try {
        await secureStore.setApiKey(parsed);
      } catch (err) {
        // LOW-3: a bad-input rejection from the keyring layer must NOT be
        // reported as a secure-store/keyring failure. Classify it explicitly.
        let code = 'E_SECURE_STORE';
        if (err instanceof SecureStoreUnavailableError) code = err.code;
        else if (err instanceof InvalidApiKeyError) code = err.code;
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

  ipcMain.handle(IPC.DICTATION_START, async (event): Promise<IpcResult<true>> => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    try {
      await triggers.start();
      return { ok: true, value: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(IPC.DICTATION_STOP, async (event): Promise<IpcResult<true>> => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    try {
      await triggers.stop();
      return { ok: true, value: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(IPC.APP_QUIT, async (event): Promise<IpcResult<true>> => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    try {
      await triggers.quit();
      return { ok: true, value: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  ipcMain.handle(IPC.AUDIO_LAST_ERROR, (): string | null => triggers.getLastAudioError());

  ipcMain.handle(IPC.HISTORY_LIST, (): HistoryEntry[] => historyStore.list());

  ipcMain.handle(
    IPC.HISTORY_REMOVE,
    (event, payload: unknown): IpcResult<HistoryEntry[]> => {
      const refusal = refuseUntrusted(event);
      if (refusal) return refusal;
      try {
        const id =
          typeof payload === 'string'
            ? HistoryRemoveSchema.parse({ id: payload }).id
            : HistoryRemoveSchema.parse(payload).id;
        historyStore.remove(id);
        return { ok: true, value: historyStore.list() };
      } catch (err) {
        return { ok: false, error: errMsg(err), code: 'E_INVALID' };
      }
    }
  );

  ipcMain.handle(IPC.HISTORY_CLEAR, (event): IpcResult<HistoryEntry[]> => {
    const refusal = refuseUntrusted(event);
    if (refusal) return refusal;
    historyStore.clear();
    return { ok: true, value: historyStore.list() };
  });

  ipcMain.handle(
    IPC.CLIPBOARD_WRITE,
    (event, text: unknown): IpcResult<true> => {
      const refusal = refuseUntrusted(event);
      if (refusal) return refusal;
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
