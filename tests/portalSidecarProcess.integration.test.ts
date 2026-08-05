import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/windvoice-portal-integration',
    getAppPath: () => process.cwd()
  }
}));

import { PortalSidecar } from '../src/main/linux/portalSidecar';

const source = path.resolve('resources/native/portal-remote.py');

describe('PortalSidecar real Python process integration', () => {
  let sidecar: PortalSidecar | null = null;

  afterEach(() => {
    sidecar?.stop();
    sidecar = null;
  });

  it('executes every verified fallback stage in the real sidecar after injected verify failures', async () => {
    let stderr = '';
    sidecar = new PortalSidecar({
      resolveScript: () => source,
      spawnChild: (command, args, options) => {
        const child = spawn(command, args, {
          ...options,
          env: {
            ...process.env,
            WINDVOICE_PORTAL_INTEGRATION_TEST: 'verify-fail-v1'
          }
        }) as ChildProcessWithoutNullStreams;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        return child;
      }
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('real Python sidecar did not become ready')), 5_000);
      sidecar!.setReadyListener(() => {
        clearTimeout(timer);
        resolve();
      });
      sidecar!.setUnavailableListener(() => {
        clearTimeout(timer);
        reject(new Error('real Python sidecar reported unavailable'));
      });
    });
    sidecar.start();
    await ready;

    const startedAt = Date.now();
    const result = await sidecar.pasteText('integration probe', false, 0, 0, 0, 0);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toMatchObject({
      ok: false,
      claimed: true,
      injected: true,
      selectionRead: false,
      targetApp: 'windvoice.integration.test',
      attemptCount: 3,
      attempts: [
        { stage: 'initial', shortcut: 'ctrl-shift-v', method: 'keycode' },
        { stage: 'slow-retry', shortcut: 'ctrl-shift-v', method: 'keycode' },
        { stage: 'keysym', shortcut: 'ctrl-v', method: 'keysym' }
      ],
      stage: 'verify'
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(2_000);
    expect(stderr).toContain(
      'fallback stage=initial result=verify-failed app_id=windvoice.integration.test'
    );
    expect(stderr).toContain(
      'fallback stage=slow-retry result=verify-failed app_id=windvoice.integration.test'
    );
    expect(stderr).toContain(
      'fallback stage=keysym result=verify-failed app_id=windvoice.integration.test'
    );
    expect(stderr).toContain(
      'fallback stage=manual result=required app_id=windvoice.integration.test'
    );
  }, 10_000);
});
