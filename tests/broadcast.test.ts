import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  }>,
  reportError: vi.fn()
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => hoisted.windows }
}));

vi.mock('@main/report/githubReporter', () => ({ reportError: hoisted.reportError }));

import { broadcastToUiWindows, setAudioWebContentsId } from '../src/main/broadcast';
import { IPC } from '../src/shared/ipc';

describe('broadcastToUiWindows', () => {
  beforeEach(() => {
    hoisted.windows.length = 0;
    hoisted.reportError.mockClear();
    setAudioWebContentsId(null);
  });

  it('scrubs secrets before both UI IPC and automatic reporting', () => {
    const send = vi.fn();
    hoisted.windows.push({
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send }
    });

    broadcastToUiWindows(IPC.SYSTEM_ERROR, {
      source: 'transcription',
      message: 'failed with api_key=top-secret-value'
    });

    expect(send).toHaveBeenCalledWith(IPC.SYSTEM_ERROR, {
      source: 'transcription',
      message: 'failed with ***REDACTED***'
    });
    expect(hoisted.reportError).toHaveBeenCalledWith(
      'transcription',
      'failed with ***REDACTED***'
    );
  });

  it('scrubs string error channels before renderer IPC', () => {
    const send = vi.fn();
    hoisted.windows.push({
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send }
    });

    broadcastToUiWindows(IPC.TRANSCRIPT_FINAL, '[error] Bearer top.secret.token');

    expect(send).toHaveBeenCalledWith(IPC.TRANSCRIPT_FINAL, '[error] ***REDACTED***');
  });

  it('skips the hidden audio renderer and destroyed windows without throwing', () => {
    const audioSend = vi.fn();
    const uiSend = vi.fn();
    hoisted.windows.push(
      {
        isDestroyed: () => false,
        webContents: { id: 10, isDestroyed: () => false, send: audioSend }
      },
      {
        isDestroyed: () => true,
        webContents: { id: 11, isDestroyed: () => true, send: vi.fn() }
      },
      {
        isDestroyed: () => false,
        webContents: { id: 12, isDestroyed: () => false, send: uiSend }
      }
    );
    setAudioWebContentsId(10);

    expect(() => broadcastToUiWindows(IPC.TRANSCRIPT_FINAL, 'private speech')).not.toThrow();
    expect(audioSend).not.toHaveBeenCalled();
    expect(uiSend).toHaveBeenCalledWith(IPC.TRANSCRIPT_FINAL, 'private speech');
  });
});
