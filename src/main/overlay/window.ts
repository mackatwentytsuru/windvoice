import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { IPC, type DictationStatus, type OverlayState } from '@shared/types';
import { isWaylandSession } from '@main/linux/wayland';

const WIDTH = 280;
const HEIGHT = 56;
const BOTTOM_OFFSET = 80;

/**
 * Frameless, transparent, click-through, always-on-top window that floats at
 * the bottom-center of the active display while dictation is in flight.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private status: DictationStatus = 'idle';
  private level = 0;
  private hideTimer: NodeJS.Timeout | null = null;
  private displayListener: (() => void) | null = null;

  async init(preloadPath: string): Promise<void> {
    if (this.win) return;
    const wayland = isWaylandSession();
    let requestedPosition: { x: number; y: number } | undefined;
    if (!wayland) {
      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      requestedPosition = {
        x: Math.round(area.x + (area.width - WIDTH) / 2),
        y: area.y + area.height - HEIGHT - BOTTOM_OFFSET
      };
    }

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      ...requestedPosition,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // xdg-shell gives clients no placement or stacking authority. Mutter may
    // ignore these requests on native Wayland even though Electron reports
    // the requested internal state; retain them for Windows, macOS, and X11.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: false });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    this.win = win;

    if (!wayland) {
      const onDisplayChange = (): void => this.repositionToActiveDisplay();
      screen.on('display-removed', onDisplayChange);
      screen.on('display-metrics-changed', onDisplayChange);
      this.displayListener = onDisplayChange;
    }

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`);
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/overlay.html'));
    }
  }

  setStatus(status: DictationStatus): void {
    this.status = status;
    this.broadcast();
    if (status === 'listening' || status === 'processing') {
      this.cancelHide();
      this.show();
    } else {
      this.scheduleHide(status === 'idle' ? 500 : 1500);
    }
  }

  /**
   * Receive RMS level updates. Skipped when the window is hidden so we don't
   * burn ~20 Hz of IPC traffic while idle.
   */
  setLevel(level: number): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.level = level;
    this.broadcast();
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.hideNow();
  }

  private show(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (!isWaylandSession()) this.repositionToActiveDisplay();
    if (!this.win.isVisible()) this.win.showInactive();
  }

  private hideNow(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isVisible()) this.win.hide();
  }

  private scheduleHide(ms: number): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideNow();
      this.hideTimer = null;
    }, ms);
  }

  private cancelHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private repositionToActiveDisplay(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const area = display.workArea;
    const x = Math.round(area.x + (area.width - WIDTH) / 2);
    const y = area.y + area.height - HEIGHT - BOTTOM_OFFSET;
    this.win.setBounds({ x, y, width: WIDTH, height: HEIGHT });
  }

  private broadcast(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const state: OverlayState = { status: this.status, level: this.level };
    this.win.webContents.send(IPC.OVERLAY_STATE, state);
  }

  destroy(): void {
    this.cancelHide();
    if (this.displayListener) {
      screen.removeListener('display-removed', this.displayListener);
      screen.removeListener('display-metrics-changed', this.displayListener);
      this.displayListener = null;
    }
    this.win?.close();
    this.win = null;
  }
}
