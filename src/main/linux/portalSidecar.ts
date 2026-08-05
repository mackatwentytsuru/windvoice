// Client for the Wayland portal sidecar (resources/native/portal-remote.py).
//
// The sidecar owns the XDG RemoteDesktop session with the Clipboard
// capability and performs the entire Wayland paste sequence (claim
// selection → inject the paste chord → verify receipt → restore selection).
// It exists because:
//   1. On Wayland a background app cannot claim the clipboard for
//      Wayland-native windows through Electron's clipboard API — selection
//      ownership requires keyboard focus, and GNOME only bridges an
//      XWayland client's selection while that client is focused. The
//      portal Clipboard interface is the sanctioned way around this.
//   2. The portal Clipboard APIs pass data as UNIX file descriptors, which
//      dbus-next cannot receive without an extra native module; PyGObject
//      (python3-gi, preinstalled on GNOME/KDE systems) handles fds natively.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { debug } from '@main/debug';

const TOKEN_FILE = '.portal-remotedesktop.json';
const RESPAWN_DELAY_MS = 3000;
const MAX_RESPAWNS = 5;

export type PasteStage = 'snapshot' | 'claim' | 'inject' | 'verify' | 'restore';

export const WAYLAND_PASTE_SHORTCUT = 'ctrl-shift-v' as const;
export const WAYLAND_PASTE_VERIFICATION_MS = 750;
export const WAYLAND_KEY_EVENT_DELAY_MS = 20;
export const WAYLAND_RETRY_KEY_EVENT_DELAY_MS = 60;

export type PortalInjectionMethod = 'keycode' | 'keysym';
export interface PortalPasteAttempt {
  stage?: 'initial' | 'slow-retry' | 'keysym';
  shortcut: typeof WAYLAND_PASTE_SHORTCUT | 'ctrl-v';
  method: PortalInjectionMethod;
  interEventMs: number;
  injected?: boolean | null;
  selectionRead?: boolean;
}

export interface PortalPasteResult {
  ok: boolean;
  claimed: boolean;
  /** null means the request timed out/exited after dispatch, so injection is unknown. */
  injected: boolean | null;
  /**
   * Whether a SelectionTransfer completed after the paste chord was sent.
   * This is the strongest receipt signal exposed by the portal, but it cannot
   * identify the requesting process (a clipboard manager may also read it).
   */
  selectionRead: boolean | null;
  restored: boolean;
  targetApp: string;
  attemptCount: number;
  attempts: PortalPasteAttempt[];
  shortcut: PortalPasteAttempt['shortcut'];
  injectionMethod: PortalInjectionMethod | null;
  /** True when the tainted RemoteDesktop session was discarded. */
  sessionReset?: boolean;
  /** True when the current selection is kept for manual paste, then the
   * virtual keyboard/session will be rebuilt before the next dictation. */
  sessionRecyclePending?: boolean;
  stage?: PasteStage;
  error?: string;
}

export type PortalSnapshotResult =
  | { ok: true; kind: 'text'; text: string }
  | { ok: true; kind: 'empty' }
  | { ok: true; kind: 'non-text' }
  | { ok: false; error: string };

export interface PortalMutationResult {
  ok: boolean;
  /** True when the operation may have reached the child before failure. */
  uncertain: boolean;
  error?: string;
}

interface SidecarReply {
  id?: number;
  ok?: boolean;
  error?: string;
  text?: string;
  kind?: 'text' | 'empty' | 'non-text';
  event?: string;
  clipboard?: boolean;
  code?: number;
  denied?: boolean;
  message?: string;
  claimed?: boolean;
  injected?: boolean | null;
  selectionRead?: boolean;
  restored?: boolean;
  tainted?: boolean;
  shortcut?: typeof WAYLAND_PASTE_SHORTCUT | 'ctrl-v';
  injectionMethod?: PortalInjectionMethod;
  targetApp?: string;
  attemptCount?: number;
  attempts?: PortalPasteAttempt[];
  stage?: PasteStage;
  /** Local-only marker added when a mutating request loses its child. */
  uncertain?: boolean;
}

export type SidecarUnavailableListener = (denied: boolean) => void;
export type SidecarReadyListener = () => void;

type SpawnSidecar = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams;

export interface PortalSidecarOptions {
  spawnChild?: SpawnSidecar;
  resolveScript?: () => string | null;
}

const MUTATING_OPS = new Set(['paste', 'set_selection', 'key_paste']);

export class PortalSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private clipboard = false;
  private denied = false;
  private respawns = 0;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (r: SidecarReply) => void;
      timer: NodeJS.Timeout;
      mutating: boolean;
    }
  >();
  private stdoutBuf = '';
  private stderrBuf = '';
  private onUnavailable: SidecarUnavailableListener | null = null;
  private onReady: SidecarReadyListener | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private recycleBeforeNextDictation = false;
  /** Set by stop(), cleared by start() — makes "stopped means stopped" hold. */
  private stopped = false;
  private readonly spawnChild: SpawnSidecar;
  private readonly resolveScript: () => string | null;

  constructor(options: PortalSidecarOptions = {}) {
    this.spawnChild =
      options.spawnChild ??
      ((command, args, spawnOptions) =>
        spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams);
    this.resolveScript = options.resolveScript ?? resolveSidecarScript;
  }

  /** True once the session is up with the clipboard capability granted. */
  isReady(): boolean {
    return this.ready && this.clipboard && this.child !== null;
  }

  wasDenied(): boolean {
    return this.denied;
  }

  setUnavailableListener(cb: SidecarUnavailableListener | null): void {
    this.onUnavailable = cb;
  }

  setReadyListener(cb: SidecarReadyListener | null): void {
    this.onReady = cb;
  }

  /**
   * Force a fresh attempt, clearing the respawn budget and any prior
   * denial. Called when the environment changes in a way that can undo a
   * failure — screen unlock in particular: while the session is locked
   * mutter refuses every RemoteDesktop CreateSession with "Session
   * creation inhibited", so a machine that was locked at launch would
   * otherwise burn its respawn budget and stay dead until restarted.
   */
  restart(): void {
    this.recycleBeforeNextDictation = false;
    this.respawns = 0;
    this.denied = false;
    this.stopped = false;
    this.cancelRestart();
    this.teardownChild(this.child, 'sidecar restarting');
    this.start();
  }

  /**
   * Re-arm transient failures for a new user action. A bounded supervision
   * budget prevents background respawn loops, but reaching that budget must
   * not make paste unavailable for the remainder of the app process.
   */
  retryForDictation(): void {
    if (this.recycleBeforeNextDictation) {
      debug(
        'DICTATION',
        'recycling portal session before dictation after an unverified paste'
      );
      this.restart();
      return;
    }
    if (this.isReady() || this.denied || this.stopped) return;
    this.respawns = 0;
    if (!this.child && !this.restartTimer) this.start();
  }

  start(): void {
    this.stopped = false;
    if (this.child) return;
    const script = this.resolveScript();
    if (!script) {
      debug('DICTATION', 'portal sidecar script not found in resources/native/');
      this.onUnavailable?.(false);
      return;
    }
    let tokenPath = '';
    try {
      tokenPath = path.join(app.getPath('userData'), TOKEN_FILE);
    } catch {
      /* userData not available (tests) — sidecar runs without persistence */
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnChild('python3', [script, tokenPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      debug('DICTATION', `portal sidecar spawn failed: ${err}`);
      this.requestRespawn();
      return;
    }
    this.child = child;
    this.ready = false;
    this.clipboard = false;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    // A write to a dead child's pipe surfaces as an ASYNC 'error' event, not
    // a synchronous throw from write() — without this listener an EPIPE
    // (sidecar exited between our paste call and Node noticing) becomes an
    // uncaughtException and takes the whole main process down.
    child.stdin.on('error', (err) => {
      debug('DICTATION', `portal sidecar stdin error: ${err.message}`);
      this.onExit(child);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(child, chunk));
    child.on('error', (err) => {
      debug('DICTATION', `portal sidecar error: ${err.message}`);
      this.onExit(child);
    });
    child.on('exit', (code) => {
      debug('DICTATION', `portal sidecar exited (${code})`);
      this.onExit(child);
    });
  }

  /** Permanently stop until the next explicit start()/restart(). */
  stop(): void {
    this.stopped = true;
    this.cancelRestart();
    this.teardownChild(this.child, 'sidecar stopped');
  }

  /**
   * Tear down only the current child. Unlike stop(), this does not set the
   * permanent-stop flag and is therefore safe on bounded restart paths.
   */
  private teardownChild(
    child: ChildProcessWithoutNullStreams | null,
    reason: string
  ): void {
    if (!child || this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.clipboard = false;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.recycleBeforeNextDictation = false;
    this.rejectAllPending(reason);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    // restart() can replace A with B before A's delayed exit/error arrives.
    // Never let an obsolete event detach or respawn over the current child.
    if (this.child !== child) return;
    this.teardownChild(child, 'sidecar exited');
    if (this.stopped || this.denied) return;
    this.requestRespawn();
  }

  private requestRespawn(): void {
    if (this.stopped || this.denied) return;
    if (this.respawns >= MAX_RESPAWNS) {
      debug('DICTATION', 'portal sidecar gave up after repeated exits');
      this.onUnavailable?.(false);
      return;
    }
    this.respawns += 1;
    this.scheduleRestart();
  }

  /**
   * Schedule a respawn, tracking the timer so stop() can cancel it —
   * otherwise a restart queued just before app quit (or before a
   * deliberate stop) spawns a stray python during teardown.
   */
  private scheduleRestart(): void {
    if (this.restartTimer || this.stopped) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.start();
    }, RESPAWN_DELAY_MS);
    this.restartTimer.unref();
  }

  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason, uncertain: p.mutating });
    }
    this.pending.clear();
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: SidecarReply;
      try {
        msg = JSON.parse(line) as SidecarReply;
      } catch {
        debug('DICTATION', `portal sidecar bad line: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.event) {
        this.onEvent(child, msg);
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    }
  }

  private onStderr(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stderrBuf += chunk;
    let idx: number;
    while ((idx = this.stderrBuf.indexOf('\n')) !== -1) {
      const line = this.stderrBuf.slice(0, idx).trim();
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (!line) continue;
      // Python emits one structured trace for every executed chain stage.
      // Mirror it without a prefix so windvoice-debug.log contains the exact
      // searchable `[dictation] fallback stage=...` shape.
      if (line.startsWith('fallback ')) {
        debug('DICTATION', line.slice(0, 500));
      } else {
        debug('DICTATION', `portal sidecar stderr: ${line.slice(0, 300)}`);
      }
    }
  }

  private onEvent(child: ChildProcessWithoutNullStreams, msg: SidecarReply): void {
    if (this.child !== child) return;
    switch (msg.event) {
      case 'ready':
        this.ready = true;
        this.clipboard = msg.clipboard === true;
        this.respawns = 0;
        debug('DICTATION', `portal sidecar ready (clipboard=${this.clipboard})`);
        if (this.clipboard) this.onReady?.();
        else this.onUnavailable?.(false);
        break;
      case 'failed':
        this.denied = msg.denied === true;
        debug('DICTATION', `portal sidecar session failed (code=${msg.code} denied=${this.denied})`);
        this.teardownChild(child, 'sidecar session failed');
        // Transient failures happen (portal restarting after a crash, a
        // concurrent session teardown racing our restore_token). Retry with
        // the shared respawn budget before declaring the backend gone —
        // only a user denial is final.
        if (!this.denied) this.requestRespawn();
        else this.onUnavailable?.(true);
        break;
      case 'closed':
        // Compositor revoked the session (settings change, portal restart).
        // Rebuild from the restore token — but through the SAME bounded
        // budget as other restarts. An unbounded loop here would spin every
        // few seconds forever, and on backends without persist_mode support
        // each cycle raises a fresh consent dialog (dialog storm).
        this.teardownChild(child, 'sidecar session closed');
        debug('DICTATION', 'portal sidecar session closed by compositor — restarting');
        this.requestRespawn();
        break;
      case 'transfer_error':
      case 'protocol_error':
        debug('DICTATION', `portal sidecar ${msg.event}: ${msg.message ?? ''}`);
        break;
      default:
        break;
    }
  }

  private send(op: string, fields: Record<string, unknown>, timeoutMs: number): Promise<SidecarReply> {
    const child = this.child;
    const mutating = MUTATING_OPS.has(op);
    if (!child || !this.ready) {
      return Promise.resolve({ ok: false, error: 'sidecar not ready', uncertain: false });
    }
    const id = this.nextId++;
    return new Promise<SidecarReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: `${op} timed out after ${timeoutMs}ms`,
          uncertain: mutating
        });
        // A timed-out mutating request may still execute later. Killing its
        // owning child is the only available cancellation boundary.
        if (mutating && this.child === child) {
          this.teardownChild(child, `${op} timed out`);
          this.requestRespawn();
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, mutating });
      try {
        child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: String(err), uncertain: mutating });
        if (mutating && this.child === child) {
          this.teardownChild(child, `${op} write failed`);
          this.requestRespawn();
        }
      }
    });
  }

  /**
   * Full Wayland paste sequence with stage-aware delivery state.
   */
  async pasteText(
    text: string,
    restore: boolean,
    settleMs: number,
    restoreMs: number,
    keyEventDelayMs = WAYLAND_KEY_EVENT_DELAY_MS,
    retryKeyEventDelayMs = WAYLAND_RETRY_KEY_EVENT_DELAY_MS
  ): Promise<PortalPasteResult> {
    // The Python side owns the invariant stage order. Sending only timing
    // knobs prevents a caller-side array (or a stale bundle omitting it) from
    // accidentally disabling the verified fallback chain.
    const requestAttemptCount = 3;
    const budget =
      settleMs +
      restoreMs +
      WAYLAND_PASTE_VERIFICATION_MS * requestAttemptCount +
      15_000;
    const r = await this.send(
      'paste',
      {
        text,
        restore,
        settleMs,
        restoreMs,
        verifyMs: WAYLAND_PASTE_VERIFICATION_MS,
        shortcut: WAYLAND_PASTE_SHORTCUT,
        keyEventDelayMs,
        retryKeyEventDelayMs
      },
      budget
    );
    if (!r.ok) debug('DICTATION', `portal sidecar paste failed: ${r.error}`);
    if (r.uncertain) {
      return {
        ok: false,
        claimed: r.claimed === true,
        injected: null,
        selectionRead: null,
        restored: false,
        targetApp: 'unknown',
        attemptCount: 0,
        attempts: [],
        shortcut: WAYLAND_PASTE_SHORTCUT,
        injectionMethod: null,
        sessionReset: true,
        stage: r.stage ?? 'inject',
        error: r.error
      };
    }
    const injected = r.injected === null ? null : r.injected === true;
    const selectionRead = r.selectionRead === true;
    const sessionReset = r.tainted === true;
    const sessionRecyclePending =
      injected === true && !selectionRead && !sessionReset;
    const resultAttempts = Array.isArray(r.attempts) ? r.attempts : [];
    const shortcut = r.shortcut === 'ctrl-v' ? 'ctrl-v' : WAYLAND_PASTE_SHORTCUT;
    const injectionMethod =
      r.injectionMethod === 'keycode' || r.injectionMethod === 'keysym'
        ? r.injectionMethod
        : null;
    const targetApp = typeof r.targetApp === 'string' && r.targetApp ? r.targetApp : 'unknown';
    const attemptCount =
      typeof r.attemptCount === 'number' ? r.attemptCount : resultAttempts.length;
    debug(
      'DICTATION',
      `portal paste result targetApp=${targetApp} attempts=${attemptCount} ` +
        `shortcut=${shortcut} method=${injectionMethod ?? 'none'} ` +
        `injected=${String(injected)} selectionRead=${selectionRead}`
    );
    if (sessionReset) {
      debug('DICTATION', 'portal sidecar session was tainted — rebuilding session');
      this.restart();
    } else if (sessionRecyclePending) {
      // Keep the transcript on the live portal selection for the user's
      // manual paste. Rebuild at the next dictation boundary, before another
      // chord can inherit any silently latched modifier state.
      this.recycleBeforeNextDictation = true;
    }
    return {
      // A successful D-Bus key dispatch is not a delivery receipt. Require a
      // completed SelectionTransfer before reporting success.
      ok: injected === true && selectionRead,
      claimed: r.claimed === true,
      injected,
      selectionRead,
      restored: r.restored === true,
      targetApp,
      attemptCount,
      attempts: resultAttempts,
      shortcut,
      injectionMethod,
      ...(sessionReset ? { sessionReset: true } : {}),
      ...(sessionRecyclePending ? { sessionRecyclePending: true } : {}),
      ...(r.stage ? { stage: r.stage } : {}),
      ...(r.error ? { error: r.error } : {})
    };
  }

  /** Current clipboard state, preserving empty vs non-text distinction. */
  async snapshot(): Promise<PortalSnapshotResult> {
    const r = await this.send('snapshot', {}, 5000);
    if (!r.ok) return { ok: false, error: r.error ?? 'snapshot failed' };
    if (r.kind === 'text' && typeof r.text === 'string') {
      return { ok: true, kind: 'text', text: r.text };
    }
    if (r.kind === 'empty' || r.kind === 'non-text') {
      return { ok: true, kind: r.kind };
    }
    return { ok: false, error: 'invalid snapshot response' };
  }

  /** Claim the selection with `text` without injecting anything. */
  async setSelection(text: string): Promise<PortalMutationResult> {
    // The Python side waits for SelectionOwnerChanged after SetSelection;
    // allow its D-Bus + ownership deadlines to expire before supervising it.
    const r = await this.send('set_selection', { text }, 7000);
    if (r.tainted === true) this.restart();
    return {
      ok: r.ok === true,
      uncertain: r.uncertain === true || r.tainted === true,
      ...(r.error ? { error: r.error } : {})
    };
  }

  /** Inject the Wayland paste chord only (legacy-path fallback injection). */
  async keyPaste(): Promise<PortalMutationResult> {
    const r = await this.send(
      'key_paste',
      { shortcut: WAYLAND_PASTE_SHORTCUT },
      10_000
    );
    if (r.tainted === true) this.restart();
    return {
      ok: r.ok === true,
      uncertain: r.uncertain === true || r.injected === null,
      ...(r.error ? { error: r.error } : {})
    };
  }
}

/**
 * Locate the sidecar script across the three layouts (mirrors fnwatcher):
 * packaged asar-unpacked, extraResources, and dev checkout.
 */
function resolveSidecarScript(): string | null {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'native', 'portal-remote.py'),
      path.join(process.resourcesPath, 'native', 'portal-remote.py')
    );
  }
  try {
    const appPath = app.getAppPath();
    candidates.push(
      path.join(appPath, 'resources', 'native', 'portal-remote.py'),
      path.join(appPath, '..', 'resources', 'native', 'portal-remote.py')
    );
  } catch {
    /* app not ready */
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export const portalSidecar = new PortalSidecar();
