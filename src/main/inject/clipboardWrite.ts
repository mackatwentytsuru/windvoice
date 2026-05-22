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

/**
 * Cached return value from `RegisterClipboardFormatW(EXCLUDE_FORMAT)`. The
 * format ID is system-wide and stable for the life of the session, so we
 * only need to register once. A zero value means "registration failed";
 * we never retry (LOW-7) — a failure here is a Win32 problem that won't
 * fix itself between dictation cycles, and re-issuing the call on every
 * paste would just rebuild the same lookup over and over.
 */
let cachedExcludeFormatId: number | null = null;

/** Opaque handle type for Win32 pointer returns from koffi. koffi
 * normalises NULL pointers to JavaScript `null`, but we still keep
 * `unknown` here and route every check through `isNullHandle` so a
 * future koffi version that switches to an opaque NULL wrapper does
 * not silently turn a failed alloc into a "valid" handle (HIGH-3). */
type Handle = unknown;

interface KoffiModule {
  load: (lib: string) => { func: (proto: string) => (...args: never[]) => unknown };
  /** koffi 3.x: returns the underlying pointer address as a bigint;
   * 0n for NULL. Older or alternate ports may not provide this. */
  address?: (ptr: unknown) => bigint;
}

interface Win32 {
  OpenClipboard: (hwnd: Handle) => number;
  EmptyClipboard: () => number;
  SetClipboardData: (fmt: number, handle: Handle) => Handle;
  CloseClipboard: () => number;
  RegisterClipboardFormatW: (name: string) => number;
  GlobalAlloc: (flags: number, bytes: number) => Handle;
  GlobalLock: (h: Handle) => Handle;
  GlobalUnlock: (h: Handle) => number;
  GlobalFree: (h: Handle) => Handle;
  RtlMoveMemory: (dest: Handle, src: Buffer, len: number) => void;
}

let win32: Win32 | null = null;
let koffiRef: KoffiModule | null = null;
let loadAttempted = false;

/**
 * Defensive NULL-handle check that works across koffi releases. koffi
 * 3.x returns `null` for a NULL pointer, but using `!h` would also be
 * true for `0n` or `0` if a future version exposed raw addresses, and
 * a truthy non-null object would slip through. Going through the
 * documented `koffi.address(h) === 0n` route fixes both directions —
 * a freed/never-allocated handle reads back as 0n, a real allocation
 * reads back as a non-zero address. Falls back to a loose JS check
 * when `address` is unavailable.
 */
function isNullHandle(h: Handle): boolean {
  if (h === null || h === undefined) return true;
  if (koffiRef?.address) {
    try {
      return koffiRef.address(h) === 0n;
    } catch {
      /* fall through */
    }
  }
  return !h;
}

function loadWin32(): Win32 | null {
  if (loadAttempted) return win32;
  loadAttempted = true;
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as KoffiModule;
    koffiRef = koffi;
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
    koffiRef = null;
  }
  return win32;
}

/** Copy `data` into a fresh GMEM_MOVEABLE HGLOBAL. Returns the handle, or
 *  null on failure (caller must not free a handle once SetClipboardData
 *  has accepted it — the system takes ownership). */
function allocGlobal(w: Win32, data: Buffer): Handle | null {
  const h = w.GlobalAlloc(GMEM_MOVEABLE, data.length);
  if (isNullHandle(h)) return null;
  const ptr = w.GlobalLock(h);
  if (isNullHandle(ptr)) {
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
 *
 * Ownership semantics (HIGH-3): SetClipboardData(fmt, h) takes ownership
 * of `h` on success — the OS is responsible for freeing it via
 * subsequent EmptyClipboard / CloseClipboard. The caller must NOT call
 * GlobalFree(h) after a successful SetClipboardData; doing so causes a
 * heap double-free. We enforce this by setting our local handle ref to
 * `null` immediately on a successful call, and the finally block only
 * frees handles that are still non-null (i.e. ownership was never
 * transferred). isNullHandle() is used everywhere instead of `!h` so
 * a future koffi release that returns an opaque object for NULL cannot
 * silently regress this invariant.
 */
function writeExcludedWin32(text: string): boolean {
  const w = loadWin32();
  if (!w) return false;
  let opened = false;
  let hText: Handle | null = null;
  let hMark: Handle | null = null;
  try {
    if (!w.OpenClipboard(null)) return false;
    opened = true;
    w.EmptyClipboard();

    // CF_UNICODETEXT expects UTF-16LE terminated by a null wchar.
    hText = allocGlobal(w, Buffer.from(text + '\0', 'utf16le'));
    if (hText === null) return false;
    const setRes = w.SetClipboardData(CF_UNICODETEXT, hText);
    if (isNullHandle(setRes)) return false; // SetClipboardData failed; finally will free hText
    hText = null; // success: OS owns the handle now

    // The exclusion marker: only its presence matters, not its content.
    // LOW-7: cache the format ID; RegisterClipboardFormatW returns the
    // same value for the same name session-wide, so the per-paste call
    // is wasted work.
    if (cachedExcludeFormatId === null) {
      cachedExcludeFormatId = w.RegisterClipboardFormatW(EXCLUDE_FORMAT);
    }
    const fmt = cachedExcludeFormatId;
    if (fmt) {
      hMark = allocGlobal(w, Buffer.from([0]));
      if (hMark !== null) {
        const markRes = w.SetClipboardData(fmt, hMark);
        if (!isNullHandle(markRes)) hMark = null; // OS owns the marker too
      }
    }
    return true;
  } catch (err) {
    debug('DICTATION', `excluded clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (hText !== null && !isNullHandle(hText)) {
      try {
        w.GlobalFree(hText);
      } catch {
        /* ignore */
      }
    }
    if (hMark !== null && !isNullHandle(hMark)) {
      try {
        w.GlobalFree(hMark);
      } catch {
        /* ignore */
      }
    }
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

/** Test-only handles for verifying HIGH-3 ownership semantics. Not part
 *  of the public surface; consumers should call writeClipboardText. */
export const __test = {
  writeExcludedWin32,
  isNullHandle,
  resetState(): void {
    win32 = null;
    koffiRef = null;
    loadAttempted = false;
    cachedExcludeFormatId = null;
  },
  injectWin32(w: Win32 | null, koffi: KoffiModule | null = null): void {
    win32 = w;
    koffiRef = koffi;
    loadAttempted = true;
  }
};
