import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import path from 'node:path';
import { IPC, type DictationStatus } from '@shared/types';
import { t } from '@shared/i18n';
import { settingsStore } from '@main/store/settings';

let tray: Tray | null = null;
let bindings: TrayBindings | null = null;
const setupWarnings = new Set<string>();

/**
 * Candidate on-disk locations for a bundled resource icon.
 *
 * `resources/**` is listed under electron-builder `files`, so in a
 * packaged build the icons live INSIDE `app.asar` — reachable via
 * `app.getAppPath()` (asar-aware), NOT under `process.resourcesPath`.
 * The previous code looked only under `process.resourcesPath/resources`
 * when packaged, always missed, and fell back to a plain colored square
 * (the "green square" users saw in the Windows tray). Try every
 * plausible location and use the first that loads.
 */
function iconCandidates(name: string): string[] {
  return [
    path.join(app.getAppPath(), 'resources', name),
    path.join(process.resourcesPath, 'resources', name),
    path.join(process.resourcesPath, name)
  ];
}

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
  setSetupWarning('accessibility', needsGrant);
}

export function setSetupWarning(source: string, active: boolean): void {
  const changed = active ? !setupWarnings.has(source) : setupWarnings.has(source);
  if (!changed) return;
  if (active) setupWarnings.add(source);
  else setupWarnings.delete(source);
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
  if (setupWarnings.size > 0) {
    const accessibility = setupWarnings.has('accessibility') && bindings.openAccessibility;
    template.push(
      { type: 'separator' },
      {
        label: t(accessibility ? 'tray.accessibilityWarning' : 'tray.setupWarning', lang),
        click: () =>
          accessibility ? bindings?.openAccessibility?.() : bindings?.openSettings()
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
  for (const candidate of iconCandidates(name)) {
    const img = nativeImage.createFromPath(candidate);
    if (!img.isEmpty()) return img;
  }
  // Last resort only — should be unreachable now that the packaged path
  // is correct. Keeps the tray functional rather than crashing.
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

// Module-level CRC32 lookup table — computed once at load. Previously this
// table was rebuilt on every crc32() call (which itself only runs for the
// fallback PNG-icon path), but keeping the construction inside the function
// allocated 256 numbers on every chunk write. Hoisting is a strict
// efficiency win with no behavior change.
const CRC32_TABLE: readonly number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
