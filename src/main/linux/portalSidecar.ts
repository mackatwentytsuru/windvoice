// Client for the Wayland portal sidecar (resources/native/portal-remote.py).
//
// The sidecar owns the XDG RemoteDesktop session with the Clipboard
// capability and performs the entire Wayland paste sequence (claim
// selection → inject Ctrl+V → restore selection). It exists because:
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

interface SidecarReply {
  id?: number;
  ok?: boolean;
  error?: string;
  text?: string | null;
  event?: string;
  clipboard?: boolean;
  code?: number;
  denied?: boolean;
  message?: string;
}

export type SidecarUnavailableListener = (denied: boolean) => void;

class PortalSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private clipboard = false;
  private denied = false;
  private respawns = 0;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: SidecarReply) => void; timer: NodeJS.Timeout }>();
  private stdoutBuf = '';
  private onUnavailable: SidecarUnavailableListener | null = null;

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

  start(): void {
    if (this.child) return;
    const script = resolveSidecarScript();
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
      child = spawn('python3', [script, tokenPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      debug('DICTATION', `portal sidecar spawn failed: ${err}`);
      this.onUnavailable?.(false);
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      debug('DICTATION', `portal sidecar stderr: ${chunk.trim().slice(0, 300)}`);
    });
    child.on('error', (err) => {
      debug('DICTATION', `portal sidecar error: ${err.message}`);
      this.onExit();
    });
    child.on('exit', (code) => {
      debug('DICTATION', `portal sidecar exited (${code})`);
      this.onExit();
    });
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    this.ready = false;
    this.rejectAllPending('sidecar stopped');
    if (c) {
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private onExit(): void {
    if (!this.child) return; // already handled by stop()
    this.child = null;
    this.ready = false;
    this.rejectAllPending('sidecar exited');
    if (this.denied) return; // no point relaunching into another denial
    if (this.respawns >= MAX_RESPAWNS) {
      debug('DICTATION', 'portal sidecar gave up after repeated exits');
      this.onUnavailable?.(false);
      return;
    }
    this.respawns += 1;
    setTimeout(() => this.start(), RESPAWN_DELAY_MS).unref();
  }

  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason });
    }
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
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
        this.onEvent(msg);
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

  private onEvent(msg: SidecarReply): void {
    switch (msg.event) {
      case 'ready':
        this.ready = true;
        this.clipboard = msg.clipboard === true;
        this.respawns = 0;
        debug('DICTATION', `portal sidecar ready (clipboard=${this.clipboard})`);
        if (!this.clipboard) this.onUnavailable?.(false);
        break;
      case 'failed':
        this.denied = msg.denied === true;
        debug('DICTATION', `portal sidecar session failed (code=${msg.code} denied=${this.denied})`);
        this.onUnavailable?.(this.denied);
        this.stop();
        break;
      case 'closed':
        // Compositor revoked the session (settings change, portal restart).
        // Restart the sidecar to build a fresh one from the restore token.
        debug('DICTATION', 'portal sidecar session closed by compositor — restarting');
        this.stop();
        setTimeout(() => this.start(), RESPAWN_DELAY_MS).unref();
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
    if (!child || !this.ready) {
      return Promise.resolve({ ok: false, error: 'sidecar not ready' });
    }
    const id = this.nextId++;
    return new Promise<SidecarReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `${op} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  /**
   * Full Wayland paste sequence. Returns true on success; on false the
   * caller should fall back to the legacy clipboard+XTest path (which at
   * least reaches XWayland windows) and surface a paste failure.
   */
  async pasteText(
    text: string,
    restore: boolean,
    settleMs: number,
    restoreMs: number
  ): Promise<boolean> {
    const budget = settleMs + restoreMs + 15_000;
    const r = await this.send('paste', { text, restore, settleMs, restoreMs }, budget);
    if (!r.ok) debug('DICTATION', `portal sidecar paste failed: ${r.error}`);
    return r.ok === true;
  }

  /** Current clipboard text (null when non-text/empty/unreadable). */
  async snapshot(): Promise<string | null> {
    const r = await this.send('snapshot', {}, 5000);
    return r.ok && typeof r.text === 'string' ? r.text : null;
  }

  /** Claim the selection with `text` without injecting anything. */
  async setSelection(text: string): Promise<boolean> {
    const r = await this.send('set_selection', { text }, 5000);
    return r.ok === true;
  }

  /** Inject the Ctrl+V chord only (legacy-path fallback injection). */
  async keyPaste(): Promise<boolean> {
    const r = await this.send('key_paste', {}, 10_000);
    return r.ok === true;
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
