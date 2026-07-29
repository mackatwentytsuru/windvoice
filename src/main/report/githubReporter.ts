// Consent-based GitHub error reporting.
//
// A classified bug is first stored as a local preview. Nothing invokes `gh`
// until the user reviews that title/body and presses Send in Settings. Setup
// and transient errors never enter this module.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Notification, app, clipboard, ipcMain } from 'electron';
import { debug, scrubSecrets } from '@main/debug';
import { refuseUntrusted } from '@main/ipc/handlers';
import { settingsStore } from '@main/store/settings';
import { openExternalSafe } from '@main/util/openExternal';
import {
  IPC,
  type ErrorKind,
  type ErrorReportPreview,
  type ErrorReportSendResult
} from '@shared/ipc';

const REPO = 'mackatwentytsuru/windvoice';
const LABEL = 'auto-report';
const STATE_FILE = 'error-reports.json';
const LOG_FILE = 'windvoice-debug.log';
const LOG_TAIL_LINES = 40;
const GH_TIMEOUT_MS = 20_000;
const MAX_CREATES_PER_HOUR = 5;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const RECUR_COMMENT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_VERSION = 2;

export interface ReportRecord {
  title: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastPostedAt?: string;
  issue?: number;
  pendingBody?: string;
  previewVersion?: number;
}

export type ReportStateMap = Record<string, ReportRecord>;

interface ReporterBindings {
  openSettings?: () => void;
  broadcastPending?: (preview: ErrorReportPreview | null) => void;
}

let bindings: ReporterBindings = {};
let initialized = false;
let createTimestamps: number[] = [];
let sendChain: Promise<ErrorReportSendResult> = Promise.resolve({ status: 'empty' });

export function initErrorReporter(nextBindings: ReporterBindings = {}): void {
  bindings = nextBindings;
  if (initialized) return;
  initialized = true;

  ipcMain.handle(IPC.ERROR_REPORT_PREVIEW, (event): ErrorReportPreview | null => {
    const refusal = refuseUntrusted(event);
    if (refusal) return null;
    return getPendingPreview();
  });
  ipcMain.handle(IPC.ERROR_REPORT_SEND, (event): Promise<ErrorReportSendResult> => {
    const refusal = refuseUntrusted(event);
    if (refusal?.ok === false) {
      return Promise.resolve({ status: 'failed', message: refusal.error });
    }
    sendChain = sendChain.then(() => sendPendingReport()).catch((err: unknown) => ({
      status: 'failed',
      message: errMsg(err)
    }));
    return sendChain;
  });
  ipcMain.handle(
    IPC.ERROR_REPORT_DISCARD,
    (event, disableReporting: unknown): ErrorReportPreview | null => {
      const refusal = refuseUntrusted(event);
      if (refusal) return null;
      discardPendingReport(disableReporting === true);
      return getPendingPreview();
    }
  );
}

export function normalizeMessage(message: string): string {
  return message.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function signatureOf(source: string, message: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}\n${normalizeMessage(message)}`)
    .digest('hex')
    .slice(0, 10);
}

export function mergeReportOccurrence(
  state: ReportStateMap,
  source: string,
  message: string,
  seenAt: string,
  previewBody: string
): { state: ReportStateMap; signature: string } {
  const signature = signatureOf(source, message);
  const existing = state[signature];
  if (existing) {
    const shouldQueueRecurrence =
      existing.issue === undefined ||
      !existing.lastPostedAt ||
      Date.parse(seenAt) - Date.parse(existing.lastPostedAt) >= RECUR_COMMENT_MIN_INTERVAL_MS;
    state[signature] = {
      ...existing,
      count: existing.count + 1,
      lastSeenAt: seenAt,
      ...(shouldQueueRecurrence && !existing.pendingBody
        ? { pendingBody: previewBody, previewVersion: PREVIEW_VERSION }
        : {})
    };
  } else {
    state[signature] = {
      title: `[report ${signature}] ${source}: ${normalizeMessage(message)}`,
      count: 1,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      pendingBody: previewBody,
      previewVersion: PREVIEW_VERSION
    };
  }
  return { state, signature };
}

export function rateLimitCreates(
  timestamps: readonly number[],
  now = Date.now()
): { allowed: boolean; timestamps: number[] } {
  const active = timestamps.filter((time) => now - time < CREATE_WINDOW_MS);
  if (active.length >= MAX_CREATES_PER_HOUR) {
    return { allowed: false, timestamps: active };
  }
  return { allowed: true, timestamps: [...active, now] };
}

/**
 * A deliberately narrow log allowlist. Free-form failures, hotkeys, portal
 * stderr, transcript-bearing payloads, clipboard operations, paths, and
 * device identifiers are excluded even if they were scrubbed.
 */
const ALLOWED_LOG_LINES: readonly RegExp[] = [
  /^\S+ \[realtime\] audio backpressure drop$/,
  /^\S+ \[realtime\] commit refused: socket not open$/,
  /^\S+ \[realtime\] commit gate: buffered=\d+B \(floor \d+B\) droppedNotOpen=\d+ droppedBackpressure=\d+ wsBuffered=\d+$/,
  /^\S+ \[dictation\] delivered=\d+ chunks maxLevel=\d+(?:\.\d+)?$/,
  /^\S+ \[dictation\] skip commit: delivered=\d+ \(<\d+\)$/,
  /^\S+ \[audio\] renderer reported ready$/,
  /^\S+ \[audio\] hidden window loaded$/,
  /^\S+ \[audio\] recapture requested \(power resume \/ track loss\)$/
];

export function filterAllowedLogLines(raw: string): string {
  const allowed = raw
    .split(/\r?\n/)
    .filter((line) => ALLOWED_LOG_LINES.some((pattern) => pattern.test(line)))
    .slice(-LOG_TAIL_LINES)
    .map(scrubSensitiveText);
  return allowed.length > 0 ? allowed.join('\n') : '(no allowlisted log lines)';
}

/**
 * Queue a local preview. The `kind` argument is required so future call sites
 * cannot accidentally treat an unclassified environment failure as a bug.
 */
export function reportError(source: string, message: string, kind: ErrorKind): void {
  try {
    if (kind !== 'bug' || !captureAllowed()) return;
    const preference = reportingPreference();
    if (preference === 'disabled') return;

    const safeMessage = scrubSensitiveText(message);
    const seenAt = new Date().toISOString();
    const state = readState();
    const alreadyHadPending = Object.values(state).some(
      (record) => record.pendingBody && record.previewVersion === PREVIEW_VERSION
    );
    const merged = mergeReportOccurrence(
      state,
      source,
      safeMessage,
      seenAt,
      buildIssueBody(source, safeMessage, seenAt)
    );
    writeState(merged.state);
    broadcastPending();

    if (preference === 'undecided') requestConsentOnce();
    else if (!alreadyHadPending) notifyPreviewReady();
  } catch (err) {
    debug('DICTATION', `error-report queue failed: ${errMsg(err)}`);
  }
}

function notifyPreviewReady(): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'WindVoice',
    body: '確認待ちのエラーレポートがあります。クリックして送信内容を確認できます。'
  });
  notification.on('click', () => bindings.openSettings?.());
  notification.show();
}

function reportingPreference(): 'enabled' | 'undecided' | 'disabled' {
  try {
    const ui = settingsStore.get().ui;
    return resolveReportingPreference(ui);
  } catch {
    return 'disabled';
  }
}

export function resolveReportingPreference(ui: {
  errorReporting: boolean;
  errorReportingConsent: 'undecided' | 'enabled' | 'disabled';
}): 'enabled' | 'undecided' | 'disabled' {
  // Existing installations that explicitly persisted the former boolean
  // `true` remain enabled even before the new consent enum exists.
  if (ui.errorReporting || ui.errorReportingConsent === 'enabled') return 'enabled';
  if (ui.errorReportingConsent === 'disabled') return 'disabled';
  return 'undecided';
}

function captureAllowed(): boolean {
  if (process.env['WINDVOICE_REPORT'] === '0') return false;
  if (!app.isPackaged && process.env['WINDVOICE_REPORT'] !== '1') return false;
  return true;
}

function requestConsentOnce(): void {
  const settings = settingsStore.get();
  if (settings.ui.errorReportingPrompted) return;
  settingsStore.set({
    ui: {
      ...settings.ui,
      errorReportingPrompted: true
    }
  });

  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'WindVoice',
    body: 'エラーレポートを開発者に送りますか？ クリックして送信内容を確認できます。'
  });
  notification.on('click', () => bindings.openSettings?.());
  notification.show();
}

function getPendingPreview(): ErrorReportPreview | null {
  const state = readState();
  for (const [signature, record] of Object.entries(state)) {
    if (record.pendingBody && record.previewVersion === PREVIEW_VERSION) {
      return { signature, title: record.title, body: record.pendingBody };
    }
  }
  return null;
}

function setReportingPreference(enabled: boolean): void {
  const settings = settingsStore.get();
  settingsStore.set({
    ui: {
      ...settings.ui,
      errorReporting: enabled,
      errorReportingConsent: enabled ? 'enabled' : 'disabled',
      errorReportingPrompted: true
    }
  });
}

async function sendPendingReport(): Promise<ErrorReportSendResult> {
  const preview = getPendingPreview();
  if (!preview) return { status: 'empty' };
  // The Send click is the opt-in decision and is persisted before invoking
  // any external process.
  setReportingPreference(true);

  const state = readState();
  const record = state[preview.signature];
  if (!record?.pendingBody) return { status: 'empty' };

  if (record.issue === undefined) {
    const limit = rateLimitCreates(createTimestamps);
    if (!limit.allowed) return { status: 'rate-limited' };

    const result = await ghCreateIssue(record.title, record.pendingBody);
    if (result.kind === 'missing') {
      await manualIssueFallback(record.title, record.pendingBody);
      createTimestamps = limit.timestamps;
      clearPending(state, preview.signature, new Date().toISOString());
      return { status: 'manual', copied: true };
    }
    if (result.kind === 'failed') return { status: 'failed', message: result.message };

    createTimestamps = limit.timestamps;
    state[preview.signature] = {
      ...record,
      issue: result.issue,
      lastPostedAt: new Date().toISOString()
    };
    delete state[preview.signature]!.pendingBody;
    writeState(state);
    broadcastPending();
    return { status: 'sent', issue: result.issue };
  }

  const comment = recurrenceBody(record);
  const result = await ghComment(record.issue, comment);
  if (result.kind === 'missing') {
    await manualIssueFallback(record.title, record.pendingBody);
    clearPending(state, preview.signature, new Date().toISOString());
    return { status: 'manual', copied: true };
  }
  if (result.kind === 'failed') return { status: 'failed', message: result.message };
  clearPending(state, preview.signature, new Date().toISOString());
  return { status: 'sent', issue: record.issue };
}

function discardPendingReport(disableReporting: boolean): void {
  const preview = getPendingPreview();
  if (preview) {
    const state = readState();
    const record = state[preview.signature];
    if (record) {
      delete record.pendingBody;
      writeState(state);
    }
  }
  if (disableReporting) setReportingPreference(false);
  broadcastPending();
}

function clearPending(state: ReportStateMap, signature: string, postedAt: string): void {
  const record = state[signature];
  if (!record) return;
  state[signature] = { ...record, lastPostedAt: postedAt };
  delete state[signature]!.pendingBody;
  writeState(state);
  broadcastPending();
}

function broadcastPending(): void {
  bindings.broadcastPending?.(getPendingPreview());
}

function readState(): ReportStateMap {
  const dir = userDataDir();
  if (!dir) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const state = parsed as ReportStateMap;
    // Never send a body generated by the old unrestricted-log reporter.
    for (const record of Object.values(state)) {
      if (record.previewVersion !== PREVIEW_VERSION) delete record.pendingBody;
    }
    return state;
  } catch {
    return {};
  }
}

function writeState(state: ReportStateMap): void {
  const dir = userDataDir();
  if (!dir) return;
  try {
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
  } catch (err) {
    debug('DICTATION', `error-report state write failed: ${errMsg(err)}`);
  }
}

function userDataDir(): string | null {
  try {
    return app.getPath('userData');
  } catch {
    return null;
  }
}

function allowlistedLogTail(): string {
  const dir = userDataDir();
  if (!dir) return '(no log)';
  try {
    return filterAllowedLogLines(readFileSync(join(dir, LOG_FILE), 'utf8'));
  } catch {
    return '(no log)';
  }
}

function buildIssueBody(source: string, message: string, seenAt: string): string {
  return scrubSecrets(
    [
      '## WindVoice error report (user reviewed)',
      '',
      `- version: ${appVersion()}`,
      `- OS: ${osDescription()}`,
      `- session: ${sessionType()}`,
      `- desktop: ${desktopEnvironment()}`,
      `- Electron: ${process.versions.electron ?? 'unknown'}`,
      `- Node: ${process.versions.node}`,
      `- source: \`${source}\``,
      `- first seen: ${seenAt}`,
      '',
      '### scrubbed message',
      '```',
      message,
      '```',
      '',
      '### allowlisted operational log lines',
      '```',
      allowlistedLogTail(),
      '```'
    ].join('\n')
  );
}

function appVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

function osDescription(): string {
  if (process.platform !== 'linux') {
    return scrubSensitiveText(`${process.platform} ${os.release()}`);
  }
  try {
    const raw = readFileSync('/etc/os-release', 'utf8');
    const pretty = raw.match(/^PRETTY_NAME=(?:"([^"]+)"|([^\n]+))$/m);
    return scrubSensitiveText(pretty?.[1] ?? pretty?.[2] ?? `linux ${os.release()}`);
  } catch {
    return scrubSensitiveText(`linux ${os.release()}`);
  }
}

function sessionType(): 'wayland' | 'x11' | 'unknown' {
  const value = process.env['XDG_SESSION_TYPE']?.toLowerCase();
  return value === 'wayland' || value === 'x11' ? value : 'unknown';
}

function desktopEnvironment(): string {
  const value = process.env['XDG_CURRENT_DESKTOP'] ?? process.env['DESKTOP_SESSION'] ?? 'unknown';
  return /^[A-Za-z0-9_.:+ -]{1,80}$/.test(value) ? value : 'unknown';
}

function scrubSensitiveText(value: string): string {
  const home = os.homedir();
  let output = scrubSecrets(value);
  if (home && home !== '/') output = output.split(home).join('~');
  return output
    .replace(/\/home\/[^/\s]+/gi, '/home/***')
    .replace(/\/Users\/[^/\s]+/g, '/Users/***')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1***')
    .replace(/((?:transcript|clipboard)(?:Text|Content)?\s*[:=]\s*)[^\n]+/gi, '$1***REDACTED***');
}

function recurrenceBody(record: ReportRecord): string {
  return `再発しています: 累計 ${record.count} 回 (最終 ${record.lastSeenAt}, version ${appVersion()})`;
}

type GhResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string };

async function ghCreateIssue(
  title: string,
  body: string
): Promise<{ kind: 'ok'; issue: number } | Exclude<GhResult, { kind: 'ok' }>> {
  const result = await gh([
    'api',
    `repos/${REPO}/issues`,
    '-f',
    `title=${title}`,
    '-f',
    `body=${body}`,
    '-f',
    `labels[]=${LABEL}`
  ]);
  if (result.kind !== 'ok') return result;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const issue = (parsed as { number?: unknown }).number;
    return typeof issue === 'number'
      ? { kind: 'ok', issue }
      : { kind: 'failed', message: 'gh returned no issue number' };
  } catch {
    return { kind: 'failed', message: 'gh returned invalid JSON' };
  }
}

async function ghComment(
  issue: number,
  body: string
): Promise<{ kind: 'ok' } | Exclude<GhResult, { kind: 'ok' }>> {
  const result = await gh([
    'api',
    `repos/${REPO}/issues/${issue}/comments`,
    '-f',
    `body=${body}`
  ]);
  return result.kind === 'ok' ? { kind: 'ok' } : result;
}

function gh(args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve({ kind: 'missing' });
            return;
          }
          const detail = scrubSensitiveText(`${errMsg(err)} ${String(stderr)}`).slice(0, 200);
          debug('DICTATION', `gh ${args[0]} failed: ${detail}`);
          resolve({ kind: 'failed', message: 'gh command failed' });
          return;
        }
        resolve({ kind: 'ok', stdout });
      }
    );
  });
}

async function manualIssueFallback(title: string, body: string): Promise<void> {
  clipboard.writeText(`${title}\n\n${body}`);
  const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}`;
  await openExternalSafe(url);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
