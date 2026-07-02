// Automatic error reporting to GitHub Issues.
//
// Every user-visible error (SYSTEM_ERROR / FORMATTER_ERROR broadcasts,
// formatter failures, updater failures) is funneled here. Errors are
// deduplicated by a stable signature (source + digit-normalized message)
// and filed as issues on the project repo via the locally-installed and
// locally-authenticated `gh` CLI — no token is ever stored or shipped in
// the app. When `gh` is unavailable the report is queued on disk and
// retried on the next error / next app start.
//
// Privacy: transcripts never reach debug() or this module; message + log
// tail are passed through scrubSecrets() (same policy as the debug log)
// before leaving the machine. Reporting can be disabled with the
// ui.errorReporting setting or WINDVOICE_REPORT=0.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug, scrubSecrets } from '@main/debug';

const REPO = 'mackatwentytsuru/windvoice';
const LABEL = 'auto-report';
const STATE_FILE = 'error-reports.json';
const LOG_FILE = 'windvoice-debug.log';
const LOG_TAIL_LINES = 40;
const GH_TIMEOUT_MS = 20_000;
// Spam guards: at most this many NEW issues per rolling hour, and a
// recurrence comment on an existing issue at most once per day.
const MAX_CREATES_PER_HOUR = 5;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const RECUR_COMMENT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ReportRecord {
  title: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Last time anything was posted to GitHub for this signature. */
  lastPostedAt?: string;
  /** Issue number once created. */
  issue?: number;
  /** Body waiting to be filed (gh unavailable / rate-capped at the time). */
  pendingBody?: string;
}

type StateMap = Record<string, ReportRecord>;

/** Wired from main/index.ts to the ui.errorReporting setting. Defaults to
 * enabled so wiring order can't silently drop early-startup errors. */
let isEnabled: () => boolean = () => true;

let createTimestamps: number[] = [];
// Serialize flushes so two rapid-fire errors can't double-create an issue.
let flushChain: Promise<void> = Promise.resolve();

export function initErrorReporter(enabledCheck: () => boolean): void {
  isEnabled = enabledCheck;
  // Retry anything queued from a previous run, off the startup path.
  const timer = setTimeout(() => enqueueFlush(), 30_000);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Digit-normalize + collapse whitespace so "timed out after 5000ms" and
 * "timed out after 5012ms" share one signature. Exported for tests. */
export function normalizeMessage(message: string): string {
  return message.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Stable 10-hex-char dedup signature. Exported for tests. */
export function signatureOf(source: string, message: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}\n${normalizeMessage(message)}`)
    .digest('hex')
    .slice(0, 10);
}

/**
 * Report an error. Fire-and-forget and exception-free: reporting must never
 * take down the path that surfaced the error in the first place.
 */
export function reportError(source: string, message: string): void {
  try {
    if (!reportingActive()) return;
    const scrubbed = scrubSecrets(message);
    const sig = signatureOf(source, scrubbed);
    const now = new Date().toISOString();
    const state = readState();
    const existing = state[sig];
    if (existing) {
      state[sig] = { ...existing, count: existing.count + 1, lastSeenAt: now };
    } else {
      state[sig] = {
        title: `[auto ${sig}] ${source}: ${normalizeMessage(scrubbed)}`,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        pendingBody: buildIssueBody(source, scrubbed, now)
      };
    }
    writeState(state);
    enqueueFlush();
  } catch (err) {
    debug('DICTATION', `error-report queue failed: ${errMsg(err)}`);
  }
}

function reportingActive(): boolean {
  if (process.env['WINDVOICE_REPORT'] === '0') return false;
  // Dev runs (vitest, electron-vite dev) must not file issues unless
  // explicitly forced with WINDVOICE_REPORT=1.
  if (!isPackaged() && process.env['WINDVOICE_REPORT'] !== '1') return false;
  try {
    return isEnabled();
  } catch {
    return true;
  }
}

function isPackaged(): boolean {
  if (!process.versions.electron) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged;
  } catch {
    return false;
  }
}

function userDataDir(): string | null {
  if (!process.versions.electron) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getPath('userData');
  } catch {
    return null;
  }
}

function readState(): StateMap {
  const dir = userDataDir();
  if (!dir) return {};
  try {
    const raw = readFileSync(join(dir, STATE_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as StateMap;
  } catch {
    return {};
  }
}

function writeState(state: StateMap): void {
  const dir = userDataDir();
  if (!dir) return;
  try {
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
  } catch (err) {
    debug('DICTATION', `error-report state write failed: ${errMsg(err)}`);
  }
}

function logTail(): string {
  const dir = userDataDir();
  if (!dir) return '(no log)';
  try {
    const raw = readFileSync(join(dir, LOG_FILE), 'utf8');
    const lines = raw.split('\n');
    return scrubSecrets(lines.slice(-LOG_TAIL_LINES).join('\n').trim());
  } catch {
    return '(no log)';
  }
}

function buildIssueBody(source: string, message: string, seenAt: string): string {
  return [
    '## 自動エラーレポート (auto-generated)',
    '',
    `- version: ${appVersion()}`,
    `- platform: ${process.platform} ${process.getSystemVersion?.() ?? ''}`,
    `- source: \`${source}\``,
    `- first seen: ${seenAt}`,
    '',
    '### message',
    '```',
    message,
    '```',
    '',
    '<details><summary>直近のデバッグログ (secrets scrubbed)</summary>',
    '',
    '```',
    logTail(),
    '```',
    '',
    '</details>'
  ].join('\n');
}

function appVersion(): string {
  if (!process.versions.electron) return 'dev';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

function enqueueFlush(): void {
  flushChain = flushChain.then(() => flushOnce()).catch(() => undefined);
}

async function flushOnce(): Promise<void> {
  if (!reportingActive()) return;
  const state = readState();
  let dirty = false;
  for (const [sig, rec] of Object.entries(state)) {
    if (rec.pendingBody && rec.issue === undefined) {
      if (!allowCreate()) break;
      const issue = await ghCreateIssue(rec.title, rec.pendingBody);
      if (issue === null) break; // gh unavailable — retry later, keep pending
      const next: ReportRecord = { ...rec, issue, lastPostedAt: new Date().toISOString() };
      delete next.pendingBody;
      state[sig] = next;
      dirty = true;
      debug('DICTATION', `error-report filed as issue #${issue} (${sig})`);
    } else if (rec.issue !== undefined && shouldPostRecurrence(rec)) {
      const ok = await ghComment(
        rec.issue,
        `再発しています: 累計 ${rec.count} 回 (最終 ${rec.lastSeenAt}, version ${appVersion()})`
      );
      if (!ok) break;
      state[sig] = { ...rec, lastPostedAt: new Date().toISOString() };
      dirty = true;
    }
  }
  if (dirty) writeState(state);
}

function shouldPostRecurrence(rec: ReportRecord): boolean {
  if (!rec.lastPostedAt) return false;
  if (rec.lastSeenAt <= rec.lastPostedAt) return false;
  const sincePost = Date.now() - Date.parse(rec.lastPostedAt);
  return Number.isFinite(sincePost) && sincePost >= RECUR_COMMENT_MIN_INTERVAL_MS;
}

function allowCreate(): boolean {
  const now = Date.now();
  createTimestamps = createTimestamps.filter((t) => now - t < CREATE_WINDOW_MS);
  if (createTimestamps.length >= MAX_CREATES_PER_HOUR) return false;
  createTimestamps.push(now);
  return true;
}

async function ghCreateIssue(title: string, body: string): Promise<number | null> {
  const out = await gh([
    'api',
    `repos/${REPO}/issues`,
    '-f',
    `title=${title}`,
    '-f',
    `body=${body}`,
    '-f',
    `labels[]=${LABEL}`
  ]);
  if (out === null) return null;
  try {
    const parsed: unknown = JSON.parse(out);
    const num = (parsed as { number?: unknown }).number;
    return typeof num === 'number' ? num : null;
  } catch {
    return null;
  }
}

async function ghComment(issue: number, body: string): Promise<boolean> {
  const out = await gh(['api', `repos/${REPO}/issues/${issue}/comments`, '-f', `body=${body}`]);
  return out !== null;
}

/** Run `gh` with args; resolve stdout, or null on any failure (missing
 * binary, not authenticated, network down, non-zero exit). */
function gh(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          debug(
            'DICTATION',
            `gh ${args[0]} failed: ${errMsg(err)} ${scrubSecrets(String(stderr)).slice(0, 200)}`
          );
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
