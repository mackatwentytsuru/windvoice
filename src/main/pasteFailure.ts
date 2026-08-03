import { Notification } from 'electron';
import { broadcastToUiWindows } from '@main/broadcast';
import { setStatus } from '@main/tray';
import { IPC } from '@shared/ipc';

/** Surface a failed delivery even when no Settings BrowserWindow exists. */
export function surfacePasteFailure(message: string, openSettings: () => void): void {
  setStatus('error');
  broadcastToUiWindows(IPC.SYSTEM_ERROR, {
    source: 'paste',
    message,
    kind: 'transient'
  });

  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: 'WindVoice — 貼り付けを確認できませんでした',
      body: message
    });
    notification.on('click', openSettings);
    notification.show();
  } catch {
    // Tray state + Settings IPC already carry the failure. A desktop
    // notification backend failure must not break clipboard preservation.
  }
}
