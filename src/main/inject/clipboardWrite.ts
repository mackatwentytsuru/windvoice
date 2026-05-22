// Clipboard text writing with optional exclusion from the Windows
// clipboard history (Win+V) and cloud clipboard.
//
// Why this is not just `clipboard.writeText`: WindVoice writes the
// transcript to the clipboard, pastes it, then restores the user's
// previous clipboard. Every one of those writes is recorded by the
// Windows clipboard history, so a user who relies on Win+V finds their
// history flooded with dictation fragments.
//
// Windows lets an app opt a clipboard entry out of history by placing a
// marker format (`ExcludeClipboardContentFromMonitorProcessing`, see
// Microsoft's "Clipboard Formats" docs) in the SAME clipboard session
// as the data. Electron's clipboard API cannot do this — `writeText`
// and `writeBuffer` are each a separate session that clobbers the
// other — so on Windows we drive the Win32 clipboard API directly via
// koffi FFI.
//
// Everything here is best-effort and self-correcting: if the FFI path
// is unavailable or misbehaves, we fall back to `clipboard.writeText`,
// and a read-back check guarantees the worst tolerated outcome is
// "transcript still shows up in Win+V history" — never a failed paste.

import { clipboard } from 'electron';
import { debug } from '@main/debug';

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const EXCLUDE_FORMAT = 'ExcludeClipboardContentFromMonitorProcessing';

interface Win32 {
  OpenClipboard: (hwnd: unknown) => number;
  EmptyClipboard: () => number;
  SetClipboardData: (fmt: number, handle: unknown) => unknown;
  CloseClipboard: () => number;
  RegisterClipboardFormatW: (name: string) => number;
  GlobalAlloc: (flags: number, bytes: number) => unknown;
  GlobalLock: (h: unknown) => unknown;
  GlobalUnlock: (h: unknown) => number;
  GlobalFree: (h: unknown) => unknown;
  RtlMoveMemory: (dest: unknown, src: Buffer, len: number) => void;
}

let win32: Win32 | null = null;
let loadAttempted = false;

function loadWin32(): Win32 | null {
  if (loadAttempted) return win32;
  loadAttempted = true;
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as {
      load: (lib: string) => { func: (proto: string) => (...args: never[]) => unknown };
    };
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    win32 = {
      OpenClipboard: user32.func('int __stdcall OpenClipboard(void *hWnd)') as Win32['OpenClipboard'],
      EmptyClipboard: user32.func('int __stdcall EmptyClipboard()') as Win32['EmptyClipboard'],
      SetClipboardData: user32.func(
        'void * __stdcall SetClipboardData(uint uFormat, void *hMem)'
      ) as Win32['SetClipboardData'],
      CloseClipboard: user32.func('int __stdcall CloseClipboard()') as Win32['CloseClipboard'],
      RegisterClipboardFormatW: user32.func(
        'uint __stdcall RegisterClipboardFormatW(str16 lpszFormat)'
      ) as Win32['RegisterClipboardFormatW'],
      GlobalAlloc: kernel32.func(
        'void * __stdcall GlobalAlloc(uint uFlags, size_t dwBytes)'
      ) as Win32['GlobalAlloc'],
      GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *hMem)') as Win32['GlobalLock'],
      GlobalUnlock: kernel32.func('int __stdcall GlobalUnlock(void *hMem)') as Win32['GlobalUnlock'],
      GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *hMem)') as Win32['GlobalFree'],
      RtlMoveMemory: kernel32.func(
        'void __stdcall RtlMoveMemory(void *Destination, void *Source, size_t Length)'
      ) as Win32['RtlMoveMemory']
    };
  } catch (err) {
    debug('DICTATION', `koffi clipboard FFI unavailable: ${err instanceof Error ? err.message : String(err)}`);
    win32 = null;
  }
  return win32;
}

/** Copy `data` into a fresh GMEM_MOVEABLE HGLOBAL. Returns the handle, or
 *  null on failure (caller must not free a handle once SetClipboardData
 *  has accepted it — the system takes ownership). */
function allocGlobal(w: Win32, data: Buffer): unknown | null {
  const h = w.GlobalAlloc(GMEM_MOVEABLE, data.length);
  if (!h) return null;
  const ptr = w.GlobalLock(h);
  if (!ptr) {
    w.GlobalFree(h);
    return null;
  }
  try {
    w.RtlMoveMemory(ptr, data, data.length);
  } finally {
    w.GlobalUnlock(h);
  }
  return h;
}

/**
 * Write `text` to the Windows clipboard with the history-exclusion
 * marker. Returns true only if the whole Win32 sequence succeeded.
 */
function writeExcludedWin32(text: string): boolean {
  const w = loadWin32();
  if (!w) return false;
  let opened = false;
  try {
    if (!w.OpenClipboard(null)) return false;
    opened = true;
    w.EmptyClipboard();

    // CF_UNICODETEXT expects UTF-16LE terminated by a null wchar.
    const hText = allocGlobal(w, Buffer.from(text + '\0', 'utf16le'));
    if (!hText) return false;
    if (!w.SetClipboardData(CF_UNICODETEXT, hText)) {
      // SetClipboardData rejected the handle — ownership stayed with us.
      w.GlobalFree(hText);
      return false;
    }

    // The exclusion marker: only its presence matters, not its content.
    const fmt = w.RegisterClipboardFormatW(EXCLUDE_FORMAT);
    if (fmt) {
      const hMark = allocGlobal(w, Buffer.from([0]));
      if (hMark && !w.SetClipboardData(fmt, hMark)) w.GlobalFree(hMark);
    }
    return true;
  } catch (err) {
    debug('DICTATION', `excluded clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (opened) {
      try {
        w.CloseClipboard();
      } catch {
        /* nothing actionable — the clipboard re-opens on the next call */
      }
    }
  }
}

/**
 * Write text to the clipboard. When `excludeFromHistory` is true and we
 * are on Windows, the entry is kept out of the Win+V clipboard history.
 * Any failure transparently falls back to `clipboard.writeText`, and a
 * read-back check ensures a misbehaving FFI path can never leave the
 * wrong text on the clipboard.
 */
export function writeClipboardText(text: string, excludeFromHistory: boolean): void {
  if (excludeFromHistory && process.platform === 'win32' && writeExcludedWin32(text)) {
    try {
      if (clipboard.readText() === text) return;
    } catch {
      /* fall through to the plain write */
    }
  }
  clipboard.writeText(text);
}
