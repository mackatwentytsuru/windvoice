import type { SystemErrorPayload } from '@shared/ipc';
import { t, type UiLang } from '@shared/i18n';
import { sessionBusNameHasOwner } from '@main/linux/sessionBus';

export const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher';

export interface StatusNotifierStartupOptions {
  platform?: NodeJS.Platform;
  language: UiLang;
  nameHasOwner?: (name: string) => Promise<boolean>;
  openSettings: () => Promise<unknown> | unknown;
  notify: (payload: SystemErrorPayload) => void;
}

/**
 * Detect the SNI host by its well-known D-Bus name. Electron's Tray
 * constructor is not evidence: on Linux it succeeds even when no watcher is
 * present and the icon can never be displayed.
 */
export async function ensureStatusNotifierWatcher(
  options: StatusNotifierStartupOptions
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'linux') return true;
  const query = options.nameHasOwner ?? sessionBusNameHasOwner;
  let available = false;
  try {
    available = await query(STATUS_NOTIFIER_WATCHER);
  } catch {
    available = false;
  }
  if (available) return true;

  options.notify({
    source: 'tray',
    kind: 'setup',
    message: t('error.statusNotifierUnavailable', options.language)
  });
  await options.openSettings();
  return false;
}
