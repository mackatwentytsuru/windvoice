import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import type { DictationStatus, OverlayState } from '@shared/types';

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

  async init(preloadPath: string): Promise<void> {
    if (this.win) return;
    const display = screen.getPrimaryDisplay();
    const x = Math.round(display.bounds.x + (display.bounds.width - WIDTH) / 2);
    const y = display.bounds.y + display.bounds.height - HEIGHT - BOTTOM_OFFSET;

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x,
      y,
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
        sandbox: false
      }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: false });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    this.win = win;

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
      // delay so user perceives the final state briefly
      this.scheduleHide(status === 'idle' ? 500 : 1500);
    }
  }

  setLevel(level: number): void {
    this.level = level;
    this.broadcast();
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.hideNow();
  }

  private show(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.repositionToActiveDisplay();
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
    if (!this.win) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const x = Math.round(display.bounds.x + (display.bounds.width - WIDTH) / 2);
    const y = display.bounds.y + display.bounds.height - HEIGHT - BOTTOM_OFFSET;
    this.win.setBounds({ x, y, width: WIDTH, height: HEIGHT });
  }

  private broadcast(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const state: OverlayState = { status: this.status, level: this.level };
    this.win.webContents.send('overlay:state', state);
  }

  destroy(): void {
    this.cancelHide();
    this.win?.close();
    this.win = null;
  }
}
