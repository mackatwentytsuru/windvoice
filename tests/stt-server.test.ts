import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STT_MODEL_NAME,
  defaultSttRoot,
  isPythonCommand,
  LocalSttServerManager,
  resolveLocalSttPaths,
  resolveServerScript,
  type SpawnFn
} from '../src/main/stt/server';
import { LocalSttError } from '../src/main/stt/errors';
import type { LocalSttSettings } from '../src/shared/types';

class FakeChild extends EventEmitter {
  pid = 4321;
  killed = false;
  stderr = new EventEmitter();

  kill(): boolean {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

function baseSettings(overrides: Partial<LocalSttSettings> = {}): LocalSttSettings {
  return {
    engine: 'local',
    localUrl: 'http://127.0.0.1:5312',
    autoStart: true,
    pythonPath: 'C:/stt/venv/Scripts/python.exe',
    serverScript: 'resources/stt/sherpa_server.py',
    modelDir: 'C:/stt/models/parakeet',
    threads: 4,
    ...overrides
  };
}

/**
 * build a manager whose /health probe answers 503 for the first
 * `failures` calls and 200 afterwards.
 */
function makeManager(
  opts: { failures: number; autoStart?: boolean; fileExists?: (p: string) => boolean } = { failures: 0 }
) {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls++;
    return new Response('{}', { status: calls > opts.failures ? 200 : 503 });
  });
  const child = new FakeChild();
  const spawnImpl = vi.fn(() => child) as unknown as SpawnFn;
  const killTree = vi.fn();
  const manager = new LocalSttServerManager({
    spawnImpl,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // Keep the readiness loop fast and deterministic on a real clock.
    sleep: async () => undefined,
    fileExists: opts.fileExists ?? (() => true),
    killTree,
    readyTimeoutMs: 200,
    pollMs: 0
  });
  return { manager, child, spawnImpl, killTree, fetchImpl };
}

describe('LocalSttServerManager', () => {
  it('does not spawn when /health already answers', async () => {
    const { manager, spawnImpl } = makeManager({ failures: 0 });
    await manager.ensureRunning(baseSettings());
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns with the model/port/threads/parent-pid arguments and waits for health', async () => {
    const { manager, spawnImpl, child } = makeManager({ failures: 1 });
    await manager.ensureRunning(baseSettings());

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('C:/stt/venv/Scripts/python.exe');
    expect(path.isAbsolute(args[0] as string)).toBe(true);
    expect(args[0]?.endsWith(path.join('resources', 'stt', 'sherpa_server.py'))).toBe(true);
    expect(args).toContain('--model-dir');
    expect(args[args.indexOf('--model-dir') + 1]).toBe('C:/stt/models/parakeet');
    expect(args[args.indexOf('--port') + 1]).toBe('5312');
    expect(args[args.indexOf('--threads') + 1]).toBe('4');
    expect(args[args.indexOf('--parent-pid') + 1]).toBe(String(process.pid));
    expect(child.killed).toBe(false);
  });

  it('reuses one spawn for concurrent ensureRunning callers', async () => {
    const { manager, spawnImpl } = makeManager({ failures: 1 });
    await Promise.all([manager.ensureRunning(baseSettings()), manager.ensureRunning(baseSettings())]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('throws "unreachable" without spawning when autoStart is off', async () => {
    const { manager, spawnImpl } = makeManager({ failures: 1 });
    await expect(
      manager.ensureRunning(baseSettings({ autoStart: false }))
    ).rejects.toMatchObject({ code: 'unreachable' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('throws "not-configured" when modelDir is empty', async () => {
    // No default model folder on this "machine", so nothing can fill the empty setting.
    const { manager, spawnImpl } = makeManager({
      failures: 1,
      fileExists: (p) => !p.endsWith(DEFAULT_STT_MODEL_NAME)
    });
    await expect(manager.ensureRunning(baseSettings({ modelDir: '  ' }))).rejects.toMatchObject({
      code: 'not-configured'
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('throws "not-configured" when the server script does not exist', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    const manager = new LocalSttServerManager({
      spawnImpl: vi.fn() as unknown as SpawnFn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fileExists: () => false
    });
    await expect(manager.ensureRunning(baseSettings())).rejects.toMatchObject({
      code: 'not-configured'
    });
  });

  it('kills the child and reports "timeout" when health never comes up', async () => {
    // Never healthy: the readiness loop must hit its deadline and give up.
    const { manager, child, killTree } = makeManager({ failures: Number.POSITIVE_INFINITY });
    await expect(manager.ensureRunning(baseSettings())).rejects.toMatchObject({ code: 'timeout' });
    expect(killTree).toHaveBeenCalledWith(4321);
    expect(child.killed).toBe(true);
  });

  it('stop() kills the whole process tree of the spawned server', async () => {
    const { manager, killTree, child } = makeManager({ failures: 1 });
    await manager.ensureRunning(baseSettings());
    manager.stop();
    expect(killTree).toHaveBeenCalledWith(4321);
    expect(child.killed).toBe(true);
  });

  it('stop() before any spawn is a no-op', () => {
    const { manager, killTree } = makeManager({ failures: 0 });
    expect(() => manager.stop()).not.toThrow();
    expect(killTree).not.toHaveBeenCalled();
  });
});

describe('resolveServerScript', () => {
  const root = path.join('C:', 'app');

  it('resolves the bundled default relative to the app root', () => {
    expect(resolveServerScript('', root, () => false)).toBe(
      path.join(root, 'resources', 'stt', 'sherpa_server.py')
    );
  });

  it('resolves a relative configured path against the app root', () => {
    expect(resolveServerScript('resources/stt/sherpa_server.py', root, () => false)).toBe(
      path.join(root, 'resources', 'stt', 'sherpa_server.py')
    );
  });

  it('keeps absolute paths untouched', () => {
    const abs = path.join('D:', 'stt', 'sherpa_server.py');
    expect(resolveServerScript(abs, root, () => false)).toBe(abs);
  });

  it('redirects an asar path to app.asar.unpacked when it exists', () => {
    const packed = path.join(root, 'app.asar', 'resources', 'stt', 'sherpa_server.py');
    const unpacked = path.join(root, 'app.asar.unpacked', 'resources', 'stt', 'sherpa_server.py');
    expect(resolveServerScript(packed, root, (p) => p === unpacked)).toBe(unpacked);
  });
});

// Guard: the typed error must be the class tests match on.
it('LocalSttError carries a code', () => {
  const err = new LocalSttError('timeout', 'x');
  expect(err.code).toBe('timeout');
  expect(err).toBeInstanceOf(Error);
});

describe('resolveLocalSttPaths', () => {
  const all = (): boolean => true;
  const none = (): boolean => false;
  const root = 'C:\\Users\\u\\AppData\\Local\\WindVoice\\stt';

  it('derives the default root from LOCALAPPDATA', () => {
    expect(defaultSttRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(root);
    expect(defaultSttRoot({})).toBeNull();
  });

  it('uses the default venv and model on Windows when the settings hold the defaults', () => {
    expect(resolveLocalSttPaths('python', '', 'win32', all, root)).toEqual({
      python: `${root}\\venv\\Scripts\\python.exe`,
      modelDir: `${root}\\models\\${DEFAULT_STT_MODEL_NAME}`
    });
  });

  it('keeps explicit settings', () => {
    expect(resolveLocalSttPaths('C:/py/python.exe', 'C:/m', 'win32', all, root)).toEqual({
      python: 'C:/py/python.exe',
      modelDir: 'C:/m'
    });
  });

  it('leaves the defaults alone when the folders are missing, the root is unknown or not on Windows', () => {
    expect(resolveLocalSttPaths('python', '', 'win32', none, root)).toEqual({ python: 'python', modelDir: '' });
    expect(resolveLocalSttPaths('python', '', 'win32', all, null)).toEqual({ python: 'python', modelDir: '' });
    expect(resolveLocalSttPaths('python', '', 'darwin', all, root)).toEqual({ python: 'python', modelDir: '' });
  });
});

describe('isPythonCommand', () => {
  it('accepts bare and absolute Python interpreters', () => {
    expect(isPythonCommand('python')).toBe(true);
    expect(isPythonCommand('python3')).toBe(true);
    expect(isPythonCommand('C:\\stt\\venv\\Scripts\\python.exe')).toBe(true);
    expect(isPythonCommand('C:/stt/venv/Scripts/pythonw.exe')).toBe(true);
    expect(isPythonCommand('/usr/bin/python3.12')).toBe(true);
  });

  it('rejects other programs and relative paths', () => {
    expect(isPythonCommand('C:\\Windows\\System32\\cmd.exe')).toBe(false);
    expect(isPythonCommand('powershell')).toBe(false);
    expect(isPythonCommand('venv/Scripts/python.exe')).toBe(false);
    expect(isPythonCommand('')).toBe(false);
  });
});
