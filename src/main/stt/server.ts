// Lifecycle manager for the bundled local STT server
// (resources/stt/sherpa_server.py, sherpa-onnx + Parakeet Japanese, CPU).
//
// Responsibilities:
//   - probe GET /health and reuse a server that is already running
//   - when autoStart is on, spawn the Python server once and wait (up to
//     READY_TIMEOUT_MS) for /health to answer
//   - kill the whole process tree on app quit (Windows: taskkill /T /F)
//
// The manager never imports electron: `setSttAppRoot()` is called by
// main/index.ts with app.getAppPath() so tests (and unit runs) stay
// electron-free. The Python process is spawned with --parent-pid so it also
// self-terminates if WindVoice dies without a clean quit.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { debug } from '@main/debug';
import type { LocalSttSettings } from '@shared/types';
import { assertLoopback, DEFAULT_LOCAL_STT_URL, localSttPort } from './client';
import { LocalSttError } from './errors';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 3_000;

export type SpawnFn = (
  command: string,
  args: string[],
  options: { windowsHide?: boolean; stdio?: Array<'ignore' | 'pipe'> }
) => ChildProcess;

export interface LocalSttServerManagerOptions {
  spawnImpl?: SpawnFn;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (p: string) => boolean;
  killTree?: (pid: number) => void;
  readyTimeoutMs?: number;
  pollMs?: number;
}

// --- app root resolution ---------------------------------------------------
// Default: the working directory (dev = repo root). main/index.ts overrides
// this with app.getAppPath() so a packaged build finds resources/stt.

let appRoot = process.cwd();

export function setSttAppRoot(root: string): void {
  if (root && root.length > 0) appRoot = root;
}

export function getSttAppRoot(): string {
  return appRoot;
}

// Default install place on Windows: %LOCALAPPDATA%\WindVoice\stt with venv\Scripts\python.exe and
// models\<DEFAULT_STT_MODEL_NAME>. Used when the settings still hold the defaults ('python' / empty
// model folder) so local STT works without typing paths.
export const DEFAULT_STT_MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8';

export function defaultSttRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.LOCALAPPDATA?.trim();
  return base ? path.win32.join(base, 'WindVoice', 'stt') : null;
}

export function resolveLocalSttPaths(
  pythonPath: string,
  modelDir: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (p: string) => boolean = existsSync,
  root: string | null = defaultSttRoot()
): { python: string; modelDir: string } {
  let python = pythonPath.trim();
  let model = modelDir.trim();
  if (platform === 'win32' && root) {
    const defaultPython = path.win32.join(root, 'venv', 'Scripts', 'python.exe');
    const defaultModel = path.win32.join(root, 'models', DEFAULT_STT_MODEL_NAME);
    if ((python === '' || python === 'python') && fileExists(defaultPython)) python = defaultPython;
    if (model === '' && fileExists(defaultModel)) model = defaultModel;
  }
  return { python, modelDir: model };
}

/**
 * Resolve the configured server script:
 *   - relative paths are resolved against the app root
 *   - a path inside `app.asar` is redirected to `app.asar.unpacked` (the
 *     script must be a real file on disk for Python to open it)
 */
export function resolveServerScript(
  configured: string,
  root: string = appRoot,
  fileExists: (p: string) => boolean = existsSync
): string {
  const raw = configured.trim();
  const candidate =
    raw.length === 0
      ? path.join(root, 'resources', 'stt', 'sherpa_server.py')
      : path.isAbsolute(raw)
        ? raw
        : path.resolve(root, raw);
  const packed = 'app.asar' + path.sep;
  const unpackedRoot = 'app.asar.unpacked' + path.sep;
  if (candidate.includes(packed)) {
    const unpacked = candidate.replace(packed, unpackedRoot);
    if (fileExists(unpacked)) return unpacked;
  }
  return candidate;
}

/** `python`, `python3`, `pythonw.exe`, or an absolute path ending in one of them. */
export function isPythonCommand(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? '';
  if (!/^pythonw?[\d.]*(\.exe)?$/i.test(base)) return false;
  return base === command || path.isAbsolute(command) || path.win32.isAbsolute(command);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Kill the child and every process it started. */
function defaultKillTree(pid: number): void {
  if (process.platform === 'win32') {
    // /T walks the tree, /F forces. Python may spawn workers / model loaders.
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (err) {
      process.stderr.write(`[stt] taskkill failed: ${errMsg(err)}\n`);
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

export class LocalSttServerManager {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  /** Last stderr line / spawn error, used in failure messages. */
  private lastError: string | null = null;

  private readonly spawnImpl: SpawnFn;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fileExists: (p: string) => boolean;
  private readonly killTree: (pid: number) => void;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;

  constructor(options: LocalSttServerManagerOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnFn);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.fileExists = options.fileExists ?? existsSync;
    this.killTree = options.killTree ?? defaultKillTree;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? READY_POLL_MS;
  }

  /**
   * Make sure a server answers at `stt.localUrl`.
   *
   * - already healthy -> resolve immediately
   * - autoStart off and not healthy -> LocalSttError('unreachable')
   * - concurrent callers share one spawn attempt
   */
  async ensureRunning(stt: LocalSttSettings): Promise<void> {
    const url = stt.localUrl.trim() || DEFAULT_LOCAL_STT_URL;
    assertLoopback(url);
    if (await this.probe(url)) return;
    if (!stt.autoStart) {
      throw new LocalSttError(
        'unreachable',
        `local STT server is not running at ${url} (auto-start is off)`
      );
    }
    if (!this.starting) {
      const attempt: Promise<void> = this.startServer({ ...stt, localUrl: url }).finally(() => {
        // A stop() may have dropped this attempt and a newer one started since.
        if (this.starting === attempt) this.starting = null;
      });
      this.starting = attempt;
    }
    return this.starting;
  }

  /** Stop the managed server (no-op when nothing was spawned by us). */
  stop(): void {
    this.starting = null;
    this.killChild();
  }

  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await this.fetchImpl(`${url.replace(/\/+$/, '')}/health`, {
        method: 'GET',
        signal: controller.signal
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async startServer(stt: LocalSttSettings): Promise<void> {
    const { python, modelDir } = resolveLocalSttPaths(stt.pythonPath, stt.modelDir, process.platform, this.fileExists);
    if (!python) {
      throw new LocalSttError('not-configured', 'local STT pythonPath is empty');
    }
    if (!modelDir) {
      throw new LocalSttError(
        'not-configured',
        'local STT modelDir is empty (point it at the sherpa-onnx model folder)'
      );
    }
    // Only ever launch a Python interpreter on a .py script: the settings come
    // from the renderer, so they must not be able to start arbitrary programs.
    if (!isPythonCommand(python)) {
      throw new LocalSttError('not-configured', 'local STT pythonPath must point at a Python interpreter');
    }
    if (modelDir.startsWith('-')) {
      throw new LocalSttError('not-configured', 'local STT modelDir is not a folder path');
    }
    const script = resolveServerScript(stt.serverScript, appRoot, this.fileExists);
    if (!/\.py$/i.test(script)) {
      throw new LocalSttError('not-configured', 'local STT server script must be a .py file');
    }
    if (!this.fileExists(script)) {
      throw new LocalSttError('not-configured', `local STT server script not found: ${script}`);
    }
    const port = localSttPort(stt.localUrl);
    const args = [
      script,
      '--model-dir',
      modelDir,
      '--port',
      String(port),
      '--threads',
      String(stt.threads),
      // Let the Python side exit on its own if WindVoice disappears.
      '--parent-pid',
      String(process.pid)
    ];

    this.lastError = null;
    // A server we started earlier (e.g. on another port) must not be orphaned.
    this.killChild();
    debug(
      'STT',
      `starting local server: ${path.basename(python)} ${path.basename(script)} ` +
        `--port ${port} --threads ${stt.threads}`
    );
    const child = this.spawnImpl(python, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    this.child = child;

    let exited = false;
    let spawnError: string | null = null;
    child.stderr?.on('data', (data: unknown) => {
      const line = String(data).trim();
      if (line.length > 0) {
        this.lastError = line;
        debug('STT', line);
      }
    });
    child.on('error', (err: Error) => {
      spawnError = errMsg(err);
      this.lastError = spawnError;
    });
    child.on('exit', (code: number | null) => {
      exited = true;
      if (!spawnError) this.lastError = `server exited (code ${String(code ?? 'null')})`;
      if (this.child === child) this.child = null;
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError || exited) break;
      if (await this.probe(stt.localUrl)) {
        debug('STT', 'local server ready');
        return;
      }
      await this.sleep(this.pollMs);
    }

    this.killChild();
    if (spawnError) {
      throw new LocalSttError('unreachable', `failed to start local STT server: ${spawnError}`);
    }
    throw new LocalSttError(
      'timeout',
      `local STT server did not become ready within ${this.readyTimeoutMs} ms` +
        (this.lastError ? ` (${this.lastError})` : '')
    );
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) this.killTree(pid);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Process-wide singleton (there is one orchestrator at a time). */
export const localSttServer = new LocalSttServerManager();
