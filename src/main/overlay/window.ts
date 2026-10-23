import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { is } from '@main/audio/env';
import { debug } from '@main/debug';
import { IPC, type DictationStatus, type OverlayState } from '@shared/types';
import { isWaylandSession } from '@main/linux/wayland';

const WIDTH = 280;
// Must fit the pill drawn by overlay.css: 40px content + 16px padding + 2px
// border + 8px margin = 66px. At 56px the bottom edge was clipped.
const HEIGHT = 72;
// Reduced by the same 16px HEIGHT grew, so the pill stays where it was.
const BOTTOM_OFFSET = 64;
// A renderer that dies again right after being rebuilt is not going to be
// saved by another rebuild; stop instead of spinning.
const CRASH_RECREATE_MIN_INTERVAL_MS = 5_000;

/**
 * Frameless, transparent, click-through, always-on-top window that floats at
 * the bottom-center of the active display while dictation is in flight.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private preloadPath: string | null = null;
  private status: DictationStatus = 'idle';
  private level = 0;
  private hideTimer: NodeJS.Timeout | null = null;
  private displayListener: (() => void) | null = null;
  private lastCrashRecreateAt = 0;

  async init(preloadPath: string): Promise<void> {
    if (this.win) return;
    this.preloadPath = preloadPath;
    if (!isWaylandSession()) {
      const onDisplayChange = (): void => this.repositionToActiveDisplay();
      screen.on('display-removed', onDisplayChange);
      screen.on('display-metrics-changed', onDisplayChange);
      this.displayListener = onDisplayChange;
    }
    await this.createWindow();
  }

  /**
   * Throw the BrowserWindow away and build a fresh one.
   *
   * The overlay lives for the whole app session and is only ever hidden and
   * re-shown. After days of sleep/lock cycles (or a GPU process restart) its
   * transparent compositor surface can go stale on Windows: the window
   * reports visible and topmost and its renderer still paints, but nothing
   * reaches the screen until the app restarts. A rebuilt window is cheap
   * (it is hidden) and always comes back with a live surface.
   */
  recreate(reason: string): void {
    if (!this.preloadPath) return;
    debug('OVERLAY', `recreating overlay window (${reason})`);
    const old = this.win;
    this.win = null;
    if (old && !old.isDestroyed()) old.destroy();
    void this.createWindow().catch((err: unknown) => {
      debug('OVERLAY', `overlay recreate failed: ${String(err)}`);
    });
  }

  private async createWindow(): Promise<void> {
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
        preload: this.preloadPath ?? undefined,
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

    win.webContents.on('render-process-gone', (_event, details) => {
      if (this.win !== win) return;
      const now = Date.now();
      if (now - this.lastCrashRecreateAt < CRASH_RECREATE_MIN_INTERVAL_MS) {
        debug('OVERLAY', `overlay renderer gone again (${details.reason}) — not recreating`);
        return;
      }
      this.lastCrashRecreateAt = now;
      this.recreate(`renderer gone: ${details.reason}`);
    });

    this.win = win;

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`);
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/overlay.html'));
    }

    // A take may have started while this window was loading (recreate on
    // unlock races the first hotkey press); the state sent then was lost.
    if (this.win !== win) return;
    this.broadcast();
    if (this.status === 'listening' || this.status === 'processing') this.show();
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
    this.preloadPath = null;
    this.win?.close();
    this.win = null;
  }
}
