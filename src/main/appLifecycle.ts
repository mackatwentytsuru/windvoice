/**
 * WindVoice is a resident tray application. BrowserWindow lifetime is UI
 * lifetime, not process lifetime, so closing the last Settings/overlay/audio
 * window must never be translated into app.quit().
 */
export interface ResidentWindowApp {
  on(event: 'window-all-closed', listener: () => void): unknown;
}

export function registerResidentWindowLifecycle(app: ResidentWindowApp): void {
  app.on('window-all-closed', () => {
    // Intentionally empty. The process exits only through an explicit Quit.
  });
}
