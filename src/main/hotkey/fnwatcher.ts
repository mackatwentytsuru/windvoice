import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { debug } from '@main/debug';
import { FN_KEYCODE } from '@main/hotkey/keycodes';

export { FN_KEYCODE };

export interface FnWatcherEvents {
  down: () => void;
  up: () => void;
  /** Fired once when the sidecar prints FN_READY (or never, if it dies). */
  ready: () => void;
  /** Fatal: the watcher could not be started or has given up restarting. */
  error: (message: string) => void;
}

export declare interface FnWatcher {
  on<K extends keyof FnWatcherEvents>(event: K, listener: FnWatcherEvents[K]): this;
  emit<K extends keyof FnWatcherEvents>(event: K, ...args: Parameters<FnWatcherEvents[K]>): boolean;
}

/**
 * Spawns the bundled `fnwatcher` macOS sidecar process and surfaces Fn
 * key down/up edges as events.
 *
 * Lifecycle:
 *   - `start()` spawns the child process and begins parsing stdout.
 *   - The child exits cleanly on its own when this process closes its
 *     stdin (handled automatically on parent exit).
 *   - On unexpected exit we retry up to `MAX_RESTARTS` times with
 *     `RESTART_DELAY_MS` between attempts, then emit `error` and stop.
 *
 * Platform: only meaningful on macOS. `start()` is a no-op everywhere else.
 */
export class FnWatcher extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restartCount = 0;
  /** Buffer for partial lines from the child's stdout. */
  private stdoutBuffer = '';

  private static readonly MAX_RESTARTS = 5;
  private static readonly RESTART_DELAY_MS = 2000;

  start(): void {
    if (process.platform !== 'darwin') return;
    if (this.child !== null) return;
    if (this.stopped) return;

    const binary = resolveFnwatcherPath();
    if (binary === null) {
      this.emit('error', 'fnwatcher binary not found in resources/native/');
      return;
    }

    try {
      const child = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      this.child = child;

      // Hooking 'data' instead of pipe-to-readline keeps the dependency
      // footprint tiny — the protocol is a handful of fixed tokens, not
      // arbitrary unicode lines.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        // Surface child diagnostics in the persistent log (and, when the
        // HOTKEY debug gate is on, the parent's stderr) so a sidecar crash
        // is diagnosable after the fact from a packaged build.
        debug('HOTKEY', `fnwatcher stderr: ${chunk.trimEnd()}`);
      });

      child.on('exit', (code, signal) => {
        // Unconditional: a sidecar exit is the primary clue when Fn
        // push-to-talk silently stops working.
        debug('HOTKEY', `fnwatcher exit code=${code} signal=${signal}`);
        this.child = null;
        // H-BUG1: a sidecar crash between FN_DOWN and FN_UP would leave a
        // push-to-talk binding stuck in HotkeyManager.heldDown (Fn sets no
        // modifier flag, so the stuck-key safety net can't recover it).
        // Force-release any in-flight Fn press before restarting. Idempotent:
        // index.ts maps 'up' → injectKey(FN_KEYCODE, false), and onKey only
        // emits 'stop' when the binding is actually held, so emitting 'up'
        // with no press in flight is a harmless no-op.
        this.emit('up');
        if (this.stopped) return;
        this.scheduleRestart();
      });

      child.on('error', (err) => {
        debug('HOTKEY', `fnwatcher spawn error: ${err.message}`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('error', `failed to spawn fnwatcher: ${message}`);
    }
  }

  /**
   * H-BUG2: re-arm the sidecar after it gave up restarting. When the Swift
   * binary exit(1)s because Accessibility was denied (before printing
   * FN_READY), restartCount never resets, so scheduleRestart permanently
   * gives up after MAX_RESTARTS. If the user grants Accessibility later, the
   * uIOhook recovery poller calls this to reset the counter and start fresh.
   * After give-up `stopped` is false and `child` is null, so start() works.
   */
  restart(): void {
    this.restartCount = 0;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      // Closing stdin signals graceful shutdown. Fallback SIGTERM in case
      // the child is wedged in a tight CGEvent callback.
      child.stdin.end();
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx = this.stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (line.length > 0) this.handleLine(line);
      newlineIdx = this.stdoutBuffer.indexOf('\n');
    }
    // Guard against a runaway child that never emits a newline.
    if (this.stdoutBuffer.length > 4096) this.stdoutBuffer = '';
  }

  private handleLine(line: string): void {
    switch (line) {
      case 'FN_DOWN':
        debug('HOTKEY', 'fnwatcher: FN_DOWN');
        this.emit('down');
        return;
      case 'FN_UP':
        debug('HOTKEY', 'fnwatcher: FN_UP');
        this.emit('up');
        return;
      case 'FN_READY':
        // Reset the restart counter — we made it past the tap-install step,
        // so future crashes are independent of "child can't start at all".
        this.restartCount = 0;
        debug('HOTKEY', 'fnwatcher: READY');
        this.emit('ready');
        return;
      default:
        debug('HOTKEY', `fnwatcher unknown line: ${line}`);
    }
  }

  private scheduleRestart(): void {
    if (this.restartCount >= FnWatcher.MAX_RESTARTS) {
      this.emit('error', `fnwatcher exited ${this.restartCount} times — giving up`);
      return;
    }
    this.restartCount += 1;
    setTimeout(() => {
      if (!this.stopped) this.start();
    }, FnWatcher.RESTART_DELAY_MS);
  }
}

/**
 * Locate the bundled fnwatcher binary. Three layouts need to work:
 *   - Packaged: `<App>/Contents/Resources/app.asar.unpacked/resources/native/fnwatcher`
 *     (electron-builder routes anything matched by `asarUnpack` here, which
 *     is necessary because `spawn()` cannot execute a file inside the asar
 *     archive).
 *   - Older electron-builder behavior or `extraResources` config:
 *     `<App>/Contents/Resources/native/fnwatcher`.
 *   - Dev (electron-vite): `<repo>/resources/native/fnwatcher`.
 */
function resolveFnwatcherPath(): string | null {
  const candidates: string[] = [];
  // Packaged (asar-unpacked): files end up in app.asar.unpacked alongside
  // the archive. process.resourcesPath = <App>/Contents/Resources.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'native', 'fnwatcher')
    );
    // Fallback for configs that copy via extraResources instead.
    candidates.push(path.join(process.resourcesPath, 'native', 'fnwatcher'));
  }
  // Dev: try repo-root/resources/native/fnwatcher relative to app path.
  // app.getAppPath() in dev points at the project root.
  try {
    const appPath = app.getAppPath();
    candidates.push(path.join(appPath, 'resources', 'native', 'fnwatcher'));
    // Also try one level up (some electron-vite layouts put __dirname
    // inside out/main).
    candidates.push(path.join(appPath, '..', 'resources', 'native', 'fnwatcher'));
  } catch {
    /* app not ready yet */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
