// One env var to rule them all. Setting `WINDVOICE_DEBUG=1` enables every
// domain; alternatively domain-specific vars (e.g. `WINDVOICE_DEBUG_AUDIO`)
// are still honored for finer-grained control.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALL = process.env['WINDVOICE_DEBUG'] === '1';

const DOMAINS = ['HOTKEY', 'AUDIO', 'REALTIME', 'DICTATION', 'DUCK', 'OVERLAY'] as const;
type Domain = (typeof DOMAINS)[number];

// ─── persistent log file ────────────────────────────────────────────────────
// The packaged Windows app is a GUI-subsystem process, so stderr goes nowhere.
// Every debug() call is mirrored to <userData>/windvoice-debug.log regardless
// of the env gates, so runtime issues (dictation stalls, realtime drops) can be
// diagnosed after the fact from a user's machine. Bounded: when the active log
// passes LOG_MAX_BYTES it rotates to `.log.1` (one generation kept), so logs
// accumulate across two files without growing unbounded.
const LOG_MAX_BYTES = 2_000_000;
let logPathResolved = false;
let logPath: string | null = null;
// In-memory size of the active log file, so the hot path never calls statSync.
// Seeded once from the file on first resolve, then tracked per append.
let logBytes = 0;

function resolveLogPath(): string | null {
  if (logPathResolved) return logPath;
  logPathResolved = true;
  // Only the packaged/Electron runtime has a userData dir. In plain Node (unit
  // tests) `process.versions.electron` is undefined — skip the electron require
  // entirely so logging is a no-op and adds zero cost/side effects there.
  // `WINDVOICE_LOG=0` lets a user opt out of the persistent log entirely.
  if (!process.versions.electron || process.env['WINDVOICE_LOG'] === '0') {
    logPath = null;
    return null;
  }
  try {
    // Lazily pull electron so non-main importers (tests) never touch the FS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'windvoice-debug.log');
    try {
      logBytes = statSync(logPath).size;
    } catch {
      logBytes = 0; // file doesn't exist yet
    }
  } catch {
    logPath = null;
  }
  return logPath;
}

function fileLog(domain: Domain, message: string): void {
  const p = resolveLogPath();
  if (!p) return;
  const line = `${new Date().toISOString()} [${domain.toLowerCase()}] ${message}\n`;
  try {
    // Rotate off an in-memory counter — no statSync on the hot path (debug() is
    // called per WebSocket message, ~10-20 Hz during dictation).
    if (logBytes > LOG_MAX_BYTES) {
      try {
        renameSync(p, `${p}.1`);
      } catch {
        // Held open by a viewer (EPERM on Windows) — keep appending. We still
        // reset the counter so we don't attempt rename on every line; rotation
        // is retried after another LOG_MAX_BYTES accumulates.
      }
      logBytes = 0;
    }
    appendFileSync(p, line);
    logBytes += Buffer.byteLength(line);
  } catch {
    /* best-effort diagnostics; never throw from logging */
  }
}

function enabledFor(domain: Domain): boolean {
  if (ALL) return true;
  return process.env[`WINDVOICE_DEBUG_${domain}`] === '1';
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-[A-Za-z0-9_-]{4,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g
];

/** Redact API keys / bearer tokens. Exported for the GitHub error reporter,
 * which must apply the same policy before any text leaves the machine. */
export function scrubSecrets(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '***REDACTED***');
  }
  return out;
}

export function debug(domain: Domain, message: string): void {
  const scrubbed = scrubSecrets(message);
  // Always persist to the log file (diagnostics survive across runs); the env
  // gates only control the noisier live stderr stream.
  fileLog(domain, scrubbed);
  if (!enabledFor(domain)) return;
  process.stderr.write(`[${domain.toLowerCase()}] ${scrubbed}\n`);
}

export function isDebug(domain: Domain): boolean {
  return enabledFor(domain);
}
