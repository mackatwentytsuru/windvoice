import { app, clipboard, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { debug } from '@main/debug';
import { getActiveHotkeyManager } from '@main/hotkey/manager';
import { sendPasteKeystroke } from '@main/inject/paste';
import { pasteTiming, type PasteCompatibility } from '@main/inject/pasteTiming';
import { writeClipboardText } from '@main/inject/clipboardWrite';
import { sleep } from '@main/util/sleep';

// SETTLE / RESTORE delays are no longer fixed constants — they come from
// the user-selectable timing profile in `pasteTiming.ts`. A previous
// revision hard-coded an aggressive 10/50ms pair to shave latency; that
// raced on slow targets (terminals, RDP/VM, busy apps) and pasted the
// user's previously-copied clipboard instead of the transcript. The
// profile lets the user pick reliability vs. latency per their setup.
const POST_RELEASE_MS = 0;
const RESTORE_FILE = '.clipboard-restore.json';
/** Maximum clipboard payload we will persist for crash recovery. Larger
 * blobs (e.g. an image accidentally on the clipboard) get dropped — the
 * user loses crash-recovery for that single launch, never the dictated
 * paste itself. */
const RESTORE_MAX_BYTES = 1_000_000;
/** Crash-recovery clipboard files older than this are considered stale
 * and discarded without restoring — protects against an attacker who
 * planted a file in `userData/` between sessions (issue #10). */
const RESTORE_MAX_AGE_MS = 5 * 60 * 1000;

const RestoreFileSchema = z.object({
  text: z.string().max(RESTORE_MAX_BYTES),
  savedAt: z.number().int().nonnegative()
});

let onPasteFailedCb: ((message: string) => void) | null = null;
export function setPasteFailureListener(cb: ((message: string) => void) | null): void {
  onPasteFailedCb = cb;
}
export function notifyPasteFailed(message: string): void {
  try {
    onPasteFailedCb?.(message);
  } catch {
    /* listener errors are not allowed to break the paste path */
  }
}

/**
 * Rate-limit the "clipboard restore stored unencrypted" warning to a single
 * surfacing per process. Without this, every dictation on a Linux box
 * without libsecret would re-fire the same notification.
 */
let warnedUnencryptedClipboard = false;

// Note: pasteModifier() and releaseStuckModifiers() existed here as
// historical helpers but were removed (issue #12):
//   - pasteModifier was never called; its behavior is now baked into
//     sendCtrlVAtomic's platform branches.
//   - releaseStuckModifiers fired phantom WM_KEYUP events that corrupted
//     PSReadLine bracketed-paste state on Windows (commit 74fc45f).
// Modifier-release is now handled by HotkeyManager.untilAllModifiersUp()
// plus the modifier-aware SendInput batch in pasteWin32.ts.

function restoreFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), RESTORE_FILE);
  } catch {
    return null;
  }
}

/**
 * Returns true iff the OS clipboard currently has a text-format payload
 * (LOW-1). We use `availableFormats()` rather than `readText().length > 0`
 * because an image/file-list on the clipboard would `readText()` to '' —
 * and we cannot restore that non-text payload through our text-only
 * persistence path. If `availableFormats()` is unavailable for any
 * reason, fall back to the safer behavior (assume text, preserve
 * pre-LOW-1 semantics).
 */
export function clipboardHasText(): boolean {
  try {
    const formats = clipboard.availableFormats();
    if (!Array.isArray(formats) || formats.length === 0) {
      // Empty clipboard — restoring '' is a harmless no-op.
      return true;
    }
    return formats.some((f) => f.startsWith('text/'));
  } catch {
    return true;
  }
}

function persistPreviousClipboard(text: string): void {
  const fp = restoreFilePath();
  if (!fp) return;
  if (text.length > RESTORE_MAX_BYTES) {
    // Don't persist huge clipboards (likely an image / binary
    // representation). Crash recovery is best-effort — we'd rather
    // lose recovery for a single large payload than write hundreds
    // of MB to disk every dictation.
    debug('DICTATION', `clipboard too large for crash-recovery (${text.length}B) — skipping persist`);
    return;
  }
  try {
    const payload = JSON.stringify({ text, savedAt: Date.now() });
    // safeStorage encrypts with the OS-level keychain/credential manager
    // when available. The plaintext clipboard could include password-
    // manager copies, API keys, or PII — leaving it on disk in
    // plaintext (issue #10) is a real exfil risk if another process
    // running as the same user reads `userData/`.
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(payload);
      // Mark the file as binary by writing as a Buffer; recoverClipboard
      // tries both encrypted and plaintext for backward compatibility
      // with old restore files.
      fs.writeFileSync(fp, enc);
    } else {
      // Fall back to plaintext on platforms where safeStorage is not
      // wired up (older Linux without libsecret). Functionality first,
      // hardening when available. Surface a one-shot warning to the UI
      // so the user knows their clipboard backup is on disk in the
      // clear — but skip the notify when text.length === 0 (the empty
      // payload is harmless and just a no-op restore on next launch).
      if (!warnedUnencryptedClipboard && text.length > 0) {
        warnedUnencryptedClipboard = true;
        notifyPasteFailed('Clipboard restore will be stored unencrypted (system keyring unavailable)');
      }
      fs.writeFileSync(fp, payload, 'utf8');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `persist clipboard failed: ${msg}`);
  }
}

function clearPersistedClipboard(): void {
  const fp = restoreFilePath();
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `clear persisted clipboard failed: ${msg}`);
  }
}

/**
 * If a previous WindVoice run crashed mid-paste and left a clipboard-
 * restore file behind, put the saved text back into the user's clipboard.
 * Safe to call multiple times — the file is deleted after restore.
 */
export function recoverClipboardIfPending(): void {
  const fp = restoreFilePath();
  if (!fp) return;
  try {
    if (!fs.existsSync(fp)) return;
    const buf = fs.readFileSync(fp);
    // Try encrypted-first decode (current write path), then fall back
    // to plaintext (legacy / non-safeStorage platforms).
    let raw: string | null = null;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        raw = safeStorage.decryptString(buf);
      } catch {
        raw = null;
      }
    }
    if (raw === null) raw = buf.toString('utf8');
    const parsed = RestoreFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      debug('DICTATION', `recoverClipboard: invalid schema, discarding`);
      // Surface the recovery failure to the UI BEFORE the finally
      // block deletes the restore file. The user's pre-crash
      // clipboard is unrecoverable; without this notify the loss
      // would be completely silent.
      notifyPasteFailed('Clipboard recovery failed: restore file could not be decoded');
      return;
    }
    // Staleness check (issue #10): a restore file older than
    // RESTORE_MAX_AGE_MS likely means the OS killed the process days
    // ago and someone else has filled the clipboard since — restoring
    // would overwrite their unrelated content with stale data. It also
    // bounds the window an attacker who planted a file could exploit.
    if (Date.now() - parsed.data.savedAt > RESTORE_MAX_AGE_MS) {
      debug('DICTATION', `recoverClipboard: stale (>${RESTORE_MAX_AGE_MS}ms), discarding`);
      return;
    }
    clipboard.writeText(parsed.data.text);
    debug('DICTATION', 'recovered clipboard from prior crash');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('DICTATION', `recoverClipboard failed: ${msg}`);
  } finally {
    clearPersistedClipboard();
  }
}

/**
 * Insert text at the focused cursor by:
 *   1. saving current clipboard text (also persists to disk for crash safety)
 *   2. writing the new text into clipboard
 *   3. simulating Ctrl+V (Cmd+V on macOS)
 *   4. restoring the original clipboard
 *
 * Compared to per-character typing, this is faster and IME-safe.
 */
export async function pasteText(
  text: string,
  restoreClipboard = true,
  compatibility: PasteCompatibility = 'balanced',
  excludeFromClipboardHistory = false
): Promise<void> {
  if (!text) return;

  const timing = pasteTiming(compatibility);
  // LOW-1: only persist + restore when the clipboard currently holds plain
  // text. If the user had an image, a file list, or any other non-text
  // format on the clipboard, `readText()` returns '' — and a subsequent
  // restore would silently CLEAR that richer payload because we have no
  // way to round-trip it through our text-only restore file. Detecting
  // this case lets us paste the transcript without touching the original
  // (non-text) clipboard at all.
  const clipboardWasText = restoreClipboard ? clipboardHasText() : false;
  if (restoreClipboard && !clipboardWasText) {
    debug('DICTATION', 'clipboard restore skipped — non-text payload on clipboard');
  }
  const previous = clipboardWasText ? clipboard.readText() : null;
  if (clipboardWasText && previous !== null) {
    persistPreviousClipboard(previous);
  }
  writeClipboardText(text, excludeFromClipboardHistory);

  // Wait for the user to physically release any modifier key. Synthesized
  // keyToggle('up') events alone are NOT enough — Windows re-reads the
  // pressed-by-user state on the next keyboard scan. We have to wait for
  // an actual hardware keyup. uIOhook reports modifier state on every
  // event so this resolves the moment the user lets go.
  const hkm = getActiveHotkeyManager();
  if (hkm) await hkm.untilAllModifiersUp(600);

  await sleep(timing.settleMs);
  // releaseStuckModifiers() / pasteModifier() were removed (see comment
  // block near the top of this file). The remaining ordering is:
  //   1. wait for user to physically release modifiers (untilAllModifiersUp)
  //   2. brief SETTLE_MS for clipboard write to settle on the OS side
  //   3. synth Cmd/Ctrl+V via sendCtrlVAtomic
  if (POST_RELEASE_MS > 0) await sleep(POST_RELEASE_MS);
  // Suppress hotkey detection during the synthesized Cmd+V — uIOhook reports
  // our own emitted Meta-down/Meta-up back through the same listener and
  // would otherwise start a brand-new push-to-talk cycle from the paste.
  // Window kept short (~30ms) because uIOhook delivers our synth events
  // within one event-loop tick (~1-5ms); a longer window risks swallowing
  // a real user release that landed in the same window — manifesting as
  // "录音中" stuck on after the user lets go (mac streaming-paste path).
  // The HotkeyManager safety net also covers any leaked release.
  hkm?.suppressFor(40);
  try {
    await sendPasteKeystroke();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[error] paste keyTap failed: ${msg}\n`);
    notifyPasteFailed(msg);
    if (clipboardWasText) {
      try {
        if (previous !== null) writeClipboardText(previous, excludeFromClipboardHistory);
        else clipboard.clear();
      } catch (restoreErr) {
        const m = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        debug('DICTATION', `clipboard restore (post-paste-fail) failed: ${m}`);
      }
      clearPersistedClipboard();
    }
    return;
  }

  if (clipboardWasText) {
    // Wait long enough for the receiving app to consume the paste before
    // we put the old clipboard back. Too short here and a slow target
    // (terminal, RDP/VM, busy app) reads the restored old clipboard —
    // the user sees their previously-copied content pasted instead.
    await sleep(timing.restoreDelayMs);
    try {
      if (previous !== null) {
        writeClipboardText(previous, excludeFromClipboardHistory);
      } else {
        clipboard.clear();
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // M11: clipboard restore failure was previously completely
      // silent — the user's pre-dictation clipboard would just be
      // gone, replaced by the dictated text. Surface to debug + UI.
      debug('DICTATION', `clipboard restore failed: ${m}`);
      notifyPasteFailed(`clipboard restore failed: ${m}`);
    }
    clearPersistedClipboard();
  }
}
