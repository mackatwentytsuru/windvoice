import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import path from 'node:path';
import { IPC, type DictationStatus } from '@shared/types';
import { t } from '@shared/i18n';
import { settingsStore } from '@main/store/settings';

let tray: Tray | null = null;
let bindings: TrayBindings | null = null;
let accessibilityWarning = false;

const iconPath = (name: string): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', name);
  }
  return path.join(app.getAppPath(), 'resources', name);
};

const STATUS_ICON: Record<DictationStatus, string> = {
  idle: 'tray-idle.png',
  connecting: 'tray-processing.png',
  listening: 'tray-listening.png',
  processing: 'tray-processing.png',
  error: 'tray-error.png',
  unavailable: 'tray-error.png'
};

type TrayLabelKey =
  | 'tray.ready'
  | 'tray.connecting'
  | 'tray.listening'
  | 'tray.processing'
  | 'tray.error'
  | 'tray.unavailable';

const STATUS_LABEL_KEY: Record<DictationStatus, TrayLabelKey> = {
  idle: 'tray.ready',
  connecting: 'tray.connecting',
  listening: 'tray.listening',
  processing: 'tray.processing',
  error: 'tray.error',
  unavailable: 'tray.unavailable'
};

let currentStatus: DictationStatus = 'idle';

export interface TrayBindings {
  openSettings: () => void;
  quit: () => void;
  openAccessibility?: () => void;
}

export function setAccessibilityWarning(needsGrant: boolean): void {
  if (accessibilityWarning === needsGrant) return;
  accessibilityWarning = needsGrant;
  if (tray) {
    tray.setToolTip(statusLabel(currentStatus));
    refreshMenu();
  }
}

export function createTray(b: TrayBindings): void {
  bindings = b;
  const image = loadIcon('tray-idle.png');
  tray = new Tray(image);
  tray.setToolTip(statusLabel('idle'));
  tray.on('click', () => bindings?.openSettings());
  tray.on('double-click', () => bindings?.openSettings());
  refreshMenu();
}

type StatusListener = (status: DictationStatus) => void;
const statusListeners = new Set<StatusListener>();

export function onStatusChanged(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

export function setStatus(status: DictationStatus): void {
  currentStatus = status;
  if (tray) {
    tray.setToolTip(statusLabel(status));
    const img = loadIcon(STATUS_ICON[status]);
    if (!img.isEmpty()) tray.setImage(img);
    refreshMenu();
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.STATUS_CHANGED, status);
  }
  for (const l of statusListeners) {
    try {
      l(status);
    } catch (err) {
      process.stderr.write(`[tray] status listener: ${err}\n`);
    }
  }
}

/** Rebuild the tray menu after a language change. */
export function refreshTrayLanguage(): void {
  if (tray) tray.setToolTip(statusLabel(currentStatus));
  refreshMenu();
}

function statusLabel(status: DictationStatus): string {
  const lang = settingsStore.get().ui.uiLanguage;
  return t(STATUS_LABEL_KEY[status], lang);
}

function refreshMenu(): void {
  if (!tray || !bindings) return;
  const lang = settingsStore.get().ui.uiLanguage;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: statusLabel(currentStatus), enabled: false }
  ];
  if (accessibilityWarning && bindings.openAccessibility) {
    template.push(
      { type: 'separator' },
      {
        label: t('tray.accessibilityWarning', lang),
        click: () => bindings?.openAccessibility?.()
      }
    );
  }
  template.push(
    { type: 'separator' },
    { label: t('tray.settings', lang), click: () => bindings?.openSettings() },
    { type: 'separator' },
    { label: t('tray.quit', lang), click: () => bindings?.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function loadIcon(name: string): Electron.NativeImage {
  const fromFile = nativeImage.createFromPath(iconPath(name));
  if (!fromFile.isEmpty()) return fromFile;
  return nativeImage.createFromBuffer(buildSolidPng(16, 16, 92, 200, 168));
}

function buildSolidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
