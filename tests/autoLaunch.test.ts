import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

const hoisted = vi.hoisted(() => ({
  written: '',
  writeFileSync: vi.fn((_path: string, contents: string) => {
    hoisted.written = contents;
  })
}));

vi.mock('electron', () => ({
  app: {
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: () => ({ openAtLogin: false })
  }
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => false,
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: hoisted.writeFileSync
  }
}));

import { applyAutoLaunch } from '@main/autoLaunch';

describe('Linux XDG autostart entry', () => {
  beforeEach(() => {
    hoisted.written = '';
    hoisted.writeFileSync.mockClear();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true
    });
  });

  it('includes a desktop icon and disables startup notification', () => {
    applyAutoLaunch(true);

    expect(hoisted.written).toContain('Icon=windvoice\n');
    expect(hoisted.written).toContain('StartupNotify=false\n');
  });
});
